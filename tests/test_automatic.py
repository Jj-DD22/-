import sys,unittest,json,tempfile,hashlib,struct,zlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image,ImageDraw
import numpy as np
from auto_prepare import polygons,edit_permission,signature,matches,refine_foreground,prepare,inspect,cutout_detail_proofs
from image_pipeline import decontaminate_cutout,restore_product,read_image,resize_rgba,rotate_rgba

def fixed_segmentation(image,coarse):
    result=image.copy();result.putalpha(coarse.point(lambda value:255 if value>127 else 0))
    return result,dict(policy='unit-fixture')

class AutomaticTests(unittest.TestCase):
    def test_transforms_rgba_in_premultiplied_space_without_black_halos(self):
        image=Image.new('RGBA',(24,24),(0,0,0,0));ImageDraw.Draw(image).rectangle((6,6,17,17),fill=(245,35,70,255))
        for transformed in (resize_rgba(image,(120,120)),rotate_rgba(image,23)):
            pixels=np.array(transformed);edge=(pixels[:,:,3]>16)&(pixels[:,:,3]<255)
            self.assertTrue(edge.any())
            self.assertGreater(int(pixels[:,:,0][edge].min()),235)
            self.assertLess(int(pixels[:,:,1][edge].max()),50)
            self.assertLess(int(pixels[:,:,2][edge].max()),85)

    def test_uniform_detail_proofs_cover_all_native_pixels_without_changing_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            rgba=Image.new('RGBA',(327,174),(20,40,60,0));ImageDraw.Draw(rgba).rectangle((30,30,290,140),fill=(230,20,40,255))
            rgba.save(root/'cutout.png');white=Image.new('RGBA',rgba.size,'white');white.alpha_composite(rgba);white=white.convert('RGB')
            white.resize((1600,851),Image.Resampling.LANCZOS).save(root/'review-product.jpg',quality=95)
            hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
            before=np.array(white);metadata=cutout_detail_proofs(root,white)
            self.assertTrue(np.array_equal(before,np.array(white)))
            self.assertEqual(metadata['coordinateFrame'],'cutout-native');self.assertEqual(metadata['overlapPaddingFraction'],.04);self.assertEqual(metadata['sharedOverlapFraction'],.08)
            self.assertFalse(metadata['changesProductAsset']);self.assertEqual(metadata['jpegQuality'],95)
            self.assertEqual([f['box'] for f in metadata['frames']],[[0,0,177,94],[151,0,327,94],[0,80,177,174],[151,80,327,174]])
            covered=np.zeros((174,327),dtype=bool)
            for index,frame in enumerate(metadata['frames']):
                x0,y0,x1,y1=frame['box'];covered[y0:y1,x0:x1]=True
                with Image.open(root/frame['file']) as detail:
                    self.assertEqual(detail.format,'JPEG');self.assertEqual(detail.mode,'RGB');self.assertEqual(max(detail.size),1000);self.assertEqual(list(detail.size),frame['reviewSize'])
                    outer_corner=(detail.width-1 if index%2 else 0,detail.height-1 if index>=2 else 0)
                    self.assertGreater(min(detail.getpixel(outer_corner)),240)
            self.assertTrue(covered.all())
            self.assertEqual(hashes,{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in hashes})
            tiny=cutout_detail_proofs(root,Image.new('RGB',(1,1),'white'))
            self.assertTrue(all(frame['box']==[0,0,1,1] for frame in tiny['frames']))

    def test_large_originals_normalize_once_and_prepare_uses_the_same_working_images(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            image=Image.new('RGB',(6000,4000),(30,50,70));image.save(root/'source.upload',format='JPEG');image.close()
            product=Image.new('RGBA',(200,200));ImageDraw.Draw(product).rectangle((20,20,179,179),fill='red')
            product.save(root/'product.upload',format='PNG')
            original_sha=hashlib.sha256((root/'source.upload').read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError,'1600 万像素'):read_image(root/'source.upload')
            result=inspect(root,root/'no-presets')
            self.assertEqual(result['normalization']['source']['originalSize'],[6000,4000])
            self.assertEqual(result['normalization']['source']['workingSize'],[1600,1067])
            self.assertEqual(result['normalization']['comparisonBasis'],'normalized-source')
            plan=dict(productOutline=[[.05,.05],[.95,.05],[.95,.95],[.05,.95]],placement=dict(centerX=.7,bottomY=.65,height=.1),oldObject=[[[.2,.2],[.3,.2],[.3,.3],[.2,.3]]],protect=[],foreground=[],confidence=.95)
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            with patch('auto_prepare.refine_opaque_product',side_effect=fixed_segmentation):prepared=prepare(root)
            self.assertEqual(prepared['sourceSize'],[1600,1067])
            self.assertEqual(prepared['normalization'],result['normalization'])
            self.assertEqual(len(prepared['preparationProofs']['cutoutDetails']['frames']),4)
            for frame in prepared['preparationProofs']['cutoutDetails']['frames']:
                with Image.open(root/frame['file']) as detail:self.assertEqual(max(detail.size),1000)
            for name in ['source-normalized.png','permission.png','foreground.png','backgroundMask.png','background.png']:
                with Image.open(root/name) as image:self.assertEqual(image.size,(1600,1067))
            self.assertEqual(hashlib.sha256((root/'source.upload').read_bytes()).hexdigest(),original_sha)
            with Image.open(root/'source-vision.jpg') as preview:self.assertLessEqual(max(preview.size),1280)

    def test_normalization_applies_exif_once_and_keeps_product_alpha(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=Image.new('RGB',(120,80),'navy');exif=source.getexif();exif[274]=6
            source.save(root/'source.upload',format='JPEG',exif=exif)
            product=Image.new('RGBA',(40,40));ImageDraw.Draw(product).rectangle((5,5,34,34),fill=(255,0,0,128));product.save(root/'product.upload',format='PNG')
            normalization=inspect(root,root/'no-presets')['normalization']
            self.assertEqual(normalization['source']['orientedSize'],[80,120]);self.assertTrue(normalization['source']['exifTransposed'])
            self.assertFalse(normalization['source']['resized'])
            canonical=read_image(root/'source-normalized.png')
            self.assertEqual(canonical.size,(80,120));self.assertIsNone(canonical.getexif().get(274))
            with Image.open(root/'product-normalized.png') as working:self.assertTrue(np.array_equal(np.array(working)[:,:,3],np.array(product)[:,:,3]))

    def test_automatic_upload_limits_apply_before_pixel_decoding(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);file=root/'image.png';Image.new('RGB',(1,1)).save(file)
            with self.assertRaisesRegex(ValueError,'20 MB'):read_image(file,max_pixels=64_000_000,max_longest=1600,max_bytes=1)
            data=bytearray(file.read_bytes());data[16:24]=struct.pack('>II',8001,8000)
            data[29:33]=struct.pack('>I',zlib.crc32(data[12:29]));file.write_bytes(data)
            with self.assertRaisesRegex(ValueError,'6400 万像素'):read_image(file,max_pixels=64_000_000,max_longest=1600,max_bytes=20*1024*1024)

    def test_background_repair_mask_excludes_new_product_footprint(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            Image.new('RGB',(120,150),'navy').save(root/'source.upload',format='PNG')
            Image.new('RGBA',(40,40),'red').save(root/'product.upload',format='PNG')
            plan=dict(productOutline=[[.05,.05],[.95,.05],[.95,.95],[.05,.95]],
                placement=dict(centerX=.72,bottomY=.65,height=.2),
                oldObject=[[[.2,.2],[.3,.2],[.3,.4],[.2,.4]]],protect=[],foreground=[],confidence=.95)
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            with patch('auto_prepare.refine_opaque_product',side_effect=fixed_segmentation):prepare(root)
            with Image.open(root/'backgroundMask.png') as mask,Image.open(root/'permission.png') as permission:
                self.assertEqual(mask.getpixel((30,45))[3],255)
                self.assertEqual(mask.getpixel((86,84))[3],0)
                self.assertEqual(permission.getpixel((86,84))[3],255)

    def test_color_refinement_removes_old_object_leaks_and_keeps_hand(self):
        image=Image.new('RGB',(120,150),(230,230,220));d=ImageDraw.Draw(image)
        d.rectangle((40,20,95,130),fill=(25,95,220))
        d.rectangle((25,65,72,77),fill=(182,121,89))
        old=Image.new('L',image.size);ImageDraw.Draw(old).rectangle((40,20,95,130),fill=255)
        rough=Image.new('L',image.size);ImageDraw.Draw(rough).rectangle((25,60,78,82),fill=255)
        result=refine_foreground(image,rough,old)
        self.assertEqual(result.getpixel((60,70)),255)
        self.assertEqual(result.getpixel((65,80)),0)
        self.assertEqual(result.getpixel((90,40)),0)
        self.assertEqual(image.getpixel((60,70)),(182,121,89))
    def test_color_refinement_leaves_ambiguous_matching_materials_alone(self):
        image=Image.new('RGB',(120,150),(182,121,89))
        old=Image.new('L',image.size);ImageDraw.Draw(old).rectangle((40,20,95,130),fill=255)
        rough=Image.new('L',image.size);ImageDraw.Draw(rough).rectangle((25,60,78,82),fill=255)
        self.assertTrue(np.array_equal(np.array(rough),np.array(refine_foreground(image,rough,old))))
    def test_erases_old_silhouette_at_full_opacity_not_just_new_product(self):
        old=Image.new('L',(80,90));ImageDraw.Draw(old).rectangle((10,10,55,70),fill=255)
        product=Image.new('L',old.size);ImageDraw.Draw(product).rectangle((24,8,44,72),fill=255)
        protected=Image.new('L',old.size);ImageDraw.Draw(protected).rectangle((60,10,70,30),fill=255)
        out=np.array(edit_permission(old,product,protected,3))
        self.assertTrue((out[np.array(old)>0]==255).all());self.assertEqual(out[20,61],0)
        self.assertTrue(((out>0)&(out<255)).any());self.assertEqual(out[85,1],0)
    def test_contours_antialias_and_preserve_label_interior_during_defringe(self):
        mask=polygons((60,80),[[[.14,.1],[.8,.17],[.84,.9],[.18,.85]]]);a=np.array(mask)
        self.assertTrue(((a>0)&(a<255)).any())
        image=Image.new('RGBA',mask.size,(180,170,150,255));image.putalpha(mask)
        ImageDraw.Draw(image).rectangle((23,25,35,55),fill=(250,0,30,255))
        before=np.array(image);after=np.array(decontaminate_cutout(image))
        self.assertTrue(np.array_equal(before[25:56,23:36],after[25:56,23:36]));self.assertTrue(np.array_equal(before[:,:,3],after[:,:,3]))
    def test_removes_colored_outline_without_changing_logo(self):
        image=Image.new('RGBA',(40,60));draw=ImageDraw.Draw(image)
        draw.rectangle((5,5,34,54),fill=(255,0,160,120));draw.rectangle((6,6,33,53),fill=(230,230,230,255));draw.rectangle((14,20,22,35),fill=(0,0,0,255))
        result=decontaminate_cutout(image)
        self.assertEqual(result.getpixel((5,25)),(230,230,230,120));self.assertEqual(result.getpixel((18,25)),(0,0,0,255))
    def test_reviewed_recipe_matches_only_same_pair_visuals(self):
        image=Image.new('RGB',(54,72),'blue');draw=ImageDraw.Draw(image);draw.rectangle((6,10,30,60),fill='red')
        a=signature(image);self.assertTrue(matches(a,signature(image.resize((108,144)))))
        self.assertFalse(matches(a,signature(Image.new('RGB',image.size,'red'))));self.assertFalse(matches(a,signature(image.transpose(Image.Transpose.FLIP_LEFT_RIGHT))))
if __name__=='__main__':unittest.main()
