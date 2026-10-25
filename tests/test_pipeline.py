import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
import json
from PIL import Image,ImageDraw
import numpy as np
from image_pipeline import crop_for_mask,prepare,finalize,placement_guide,seamless_background,restore_product,foreground_matte,clean_placement_background,read_image

class PipelineTests(unittest.TestCase):
    def test_read_image_applies_exif_orientation_once_before_edit_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'rotated.jpg'
            image=Image.new('RGB',(80,40),'white');draw=ImageDraw.Draw(image);draw.rectangle((5,5,24,34),fill='red')
            exif=image.getexif();exif[274]=6;image.save(path,exif=exif)
            metadata={};upright=read_image(path,'RGB',metadata=metadata)
            self.assertEqual(upright.size,(40,80));self.assertTrue(metadata['exifTransposed'])
            self.assertEqual(metadata['originalSize'],[80,40]);self.assertEqual(metadata['orientedSize'],[40,80])
            self.assertNotIn(274,upright.getexif())

    def test_png_mask_alpha_composites_on_black_without_changing_product_rgba(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);mask=Image.new('RGBA',(3,1))
            mask.putdata([(255,255,255,0),(255,255,255,64),(255,255,255,255)])
            mask.save(root/'mask.png')
            self.assertEqual(np.array(read_image(root/'mask.png','L')).ravel().tolist(),[0,64,255])
            self.assertTrue(np.array_equal(np.array(read_image(root/'mask.png','RGBA')),np.array(mask)))
            self.assertEqual(np.array(read_image(root/'mask.png','RGB')).reshape(-1,3).tolist(),[[255,255,255]]*3)
            Image.new('RGB',(3,1),'white').save(root/'opaque.png')
            self.assertEqual(np.array(read_image(root/'opaque.png','L')).ravel().tolist(),[255,255,255])
            Image.new('L',(3,1),128).save(root/'gray.png')
            self.assertEqual(np.array(read_image(root/'gray.png','L')).ravel().tolist(),[128,128,128])
            Image.new('LA',(1,1),(128,64)).save(root/'gray-alpha.png')
            self.assertEqual(read_image(root/'gray-alpha.png','L').getpixel((0,0)),32)

    def test_hair_background_mode_requires_explicit_nonempty_old_object_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            Image.new('RGB',(80,100),'navy').save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(20,40));ImageDraw.Draw(product).rectangle((2,2,17,37),fill='white')
            product.save(root/'product.upload',format='PNG')
            permission=Image.new('L',(80,100));ImageDraw.Draw(permission).rectangle((10,10,65,85),fill=255)
            permission.save(root/'mask.upload',format='PNG')
            job=dict(preserveProduct=True,backgroundOnlyGeneration=True,placement=dict(x=35,y=30,width=20,height=40))
            (root/'job.json').write_text(json.dumps(job),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'明确的旧物修复区'):prepare(root)
            Image.new('L',(80,100)).save(root/'background-mask.upload',format='PNG')
            with self.assertRaisesRegex(ValueError,'旧物修复区为空'):prepare(root)
            outside=Image.new('L',(80,100));ImageDraw.Draw(outside).rectangle((1,1,5,5),fill=255)
            outside.save(root/'background-mask.upload',format='PNG')
            with self.assertRaisesRegex(ValueError,'旧物修复区为空'):prepare(root)
            for invalid in [dict(job,preserveProduct=False),dict(job,placement=None)]:
                (root/'job.json').write_text(json.dumps(invalid),encoding='utf-8')
                with self.assertRaisesRegex(ValueError,'商品保真和已确认位置'):prepare(root)

    def test_hair_background_guard_preserves_texture_outside_old_object(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=Image.new('RGB',(80,100),(140,140,140))
            ImageDraw.Draw(source).rectangle((58,50,62,58),fill='black')
            source.save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(20,40));ImageDraw.Draw(product).rectangle((2,2,17,37),fill='white')
            product.save(root/'product.upload',format='PNG')
            permission=Image.new('L',source.size);ImageDraw.Draw(permission).rectangle((10,10,65,85),fill=255)
            permission.save(root/'mask.upload',format='PNG')
            old=Image.new('L',source.size);ImageDraw.Draw(old).rectangle((15,15,30,30),fill=255)
            old.save(root/'background-mask.upload',format='PNG')
            guard=Image.new('L',source.size);ImageDraw.Draw(guard).rectangle((56,48,64,60),fill=255)
            guard.save(root/'background-guard.upload',format='PNG')
            (root/'job.json').write_text(json.dumps(dict(preserveProduct=True,backgroundOnlyGeneration=True,placement=dict(x=35,y=30,width=20,height=40))),encoding='utf-8')
            meta=prepare(root)
            with Image.open(root/'background-guard.png') as clipped:self.assertIsNone(clipped.getbbox())
            # Previously prepared jobs may contain an unclipped guard; finalize must also enforce permission.
            guard.save(root/'background-guard.png')
            source.save(root/'candidate.png');c=meta['crop']
            source.crop((c['x'],c['y'],c['x']+c['width'],c['y']+c['height'])).save(root/'raw-crop.png')
            metrics=finalize(root)
            background=np.array(Image.open(root/'blended-background.png'))
            self.assertTrue(np.array_equal(background[np.array(old)==0],np.array(source)[np.array(old)==0]))
            self.assertEqual(metrics['maxBackgroundChangeOutsideOldObject'],0)
            with Image.open(root/'result.png') as result:self.assertEqual(result.getpixel((60,54)),(0,0,0))

    def test_background_change_metric_measures_completed_guard_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=Image.new('RGB',(80,100),(140,140,140))
            ImageDraw.Draw(source).rectangle((50,50,58,58),fill='black')
            for name in ['source.png','candidate.png','raw-crop.png']:source.save(root/name)
            permission=Image.new('L',source.size);ImageDraw.Draw(permission).rectangle((10,10,65,75),fill=255)
            permission.save(root/'mask.png')
            old=Image.new('L',source.size);ImageDraw.Draw(old).rectangle((15,15,30,30),fill=255)
            old.save(root/'background-mask.png')
            guard=Image.new('L',source.size);ImageDraw.Draw(guard).rectangle((48,48,60,60),fill=255)
            guard.save(root/'background-guard.png');Image.new('L',source.size).save(root/'foreground.png')
            product=Image.new('RGBA',source.size);ImageDraw.Draw(product).rectangle((20,20,25,25),fill='red')
            product.save(root/'product-layer.png')
            (root/'meta.json').write_text(json.dumps(dict(preserveProduct=True,crop=dict(x=0,y=0,width=80,height=100))),encoding='utf-8')
            metrics=finalize(root)
            delta=np.abs(np.array(Image.open(root/'blended-background.png')).astype(np.int16)-np.array(source).astype(np.int16)).max(axis=2)
            actual=int(delta[np.array(old)==0].max())
            self.assertGreater(actual,0)
            self.assertEqual(metrics['maxBackgroundChangeOutsideOldObject'],actual)

    def test_hand_spill_correction_keeps_luminance_interior_and_red_branding(self):
        source=Image.new('RGB',(40,50),(210,150,115));draw=ImageDraw.Draw(source)
        draw.rectangle((15,15,15,34),fill=(220,140,175))
        hand=Image.new('L',source.size);ImageDraw.Draw(hand).rectangle((15,15,27,34),fill=255)
        corrected,core,changed=foreground_matte(source,hand)
        a,b=np.array(source),np.array(corrected);f=np.array(hand)
        self.assertTrue(changed.any());self.assertTrue(np.array_equal(a[core],b[core]))
        self.assertTrue(np.array_equal(a[f==0],b[f==0]))
        self.assertLess(b[24,15,2].astype(int)-b[24,15,1].astype(int),0)
        self.assertLess(abs(float((a[24,15].astype(float)-b[24,15])@np.array([.2126,.7152,.0722]))),1)
        product=Image.new('RGBA',source.size);ImageDraw.Draw(product).rectangle((4,6,18,40),fill=(230,0,45,255))
        result,metrics=restore_product(source,source,product,hand,Image.new('L',source.size,255),clean_edges=True)
        self.assertEqual(result.getpixel((8,20)),(230,0,45));self.assertEqual(metrics['productMaxPixelDifference'],0)
        self.assertGreater(metrics['foregroundEdgeRepairedPixels'],0);self.assertEqual(metrics['foregroundMaxPixelDifference'],0)

    def test_guide_erases_old_pink_object_without_repainting_hand_core_or_outside(self):
        source=Image.new('RGB',(60,70),(80,90,80));draw=ImageDraw.Draw(source)
        draw.rectangle((20,15,35,45),fill=(230,120,180));draw.rectangle((36,30,42,42),fill=(210,150,115))
        permission=Image.new('L',source.size);ImageDraw.Draw(permission).rectangle((10,10,49,59),fill=255)
        core=np.zeros((70,60),dtype=bool);core[30:43,36:43]=True
        result=clean_placement_background(source,permission,core);a,b,m=np.array(source),np.array(result),np.array(permission)
        self.assertTrue(np.array_equal(a[core],b[core]));self.assertTrue(np.array_equal(a[m==0],b[m==0]))
        self.assertLessEqual(int(b[20,25,2])-int(b[20,25,1]),0)

    def test_preserved_pipeline_restores_product_hand_and_exact_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=Image.new('RGB',(80,100),(100,120,140))
            source.save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(20,40));draw=ImageDraw.Draw(product)
            draw.rectangle((2,2,17,37),fill='white');draw.rectangle((6,10,10,20),fill='black')
            product.save(root/'product.upload',format='PNG')
            mask=Image.new('L',source.size);ImageDraw.Draw(mask).rectangle((18,15,63,80),fill=255)
            mask.save(root/'mask.upload',format='PNG')
            old=Image.new('L',source.size);ImageDraw.Draw(old).rectangle((18,15,28,80),fill=255)
            old.save(root/'background-mask.upload',format='PNG')
            hand=Image.new('L',source.size);ImageDraw.Draw(hand).rectangle((45,40,54,50),fill=255)
            hand.save(root/'foreground.upload',format='PNG')
            (root/'job.json').write_text(json.dumps(dict(preserveProduct=True,backgroundOnlyGeneration=True,placement=dict(x=30,y=30,width=20,height=40))),encoding='utf-8')
            meta=prepare(root);self.assertTrue(meta['preserveProduct'])
            self.assertTrue(meta['backgroundOnlyGeneration'])
            with Image.open(root/'background-guide.png') as clean:
                self.assertEqual(clean.getpixel((37,42)),source.getpixel((37,42)))
            with Image.open(root/'placement-guide.png') as guide:
                self.assertEqual(guide.getpixel((37,42)),(0,0,0))
            with Image.open(root/'placement-guide.png') as guide:self.assertEqual(guide.getpixel((46,45)),source.getpixel((46,45)))
            source.save(root/'candidate.png');c=meta['crop']
            raw=Image.new('RGB',(c['width'],c['height']),(130,150,170))
            ImageDraw.Draw(raw).rectangle((54-c['x'],24-c['y'],58-c['x'],28-c['y']),fill='black')
            raw.save(root/'raw-crop.png')
            metrics=finalize(root);result=np.array(Image.open(root/'result.png'))
            self.assertEqual(metrics['maxBackgroundChangeOutsideOldObject'],0)
            self.assertEqual(tuple(result[25,55]),(100,120,140))
            self.assertEqual(tuple(result[42,37]),(0,0,0));self.assertEqual(tuple(result[45,46]),(100,120,140))
            self.assertTrue(np.array_equal(result[np.array(mask)==0],np.array(source)[np.array(mask)==0]))
            self.assertGreater(metrics['productProtectedPixels'],100);self.assertGreater(metrics['foregroundProtectedPixels'],0)
            self.assertEqual(metrics['productMaxPixelDifference'],0);self.assertEqual(metrics['foregroundMaxPixelDifference'],0)

    def test_preservation_requires_cutout_and_matching_foreground_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);Image.new('RGB',(80,100)).save(root/'source.upload',format='PNG')
            Image.new('RGB',(20,40),'white').save(root/'product.upload',format='PNG')
            Image.new('L',(80,100),255).save(root/'mask.upload',format='PNG')
            (root/'job.json').write_text(json.dumps(dict(preserveProduct=True,placement=dict(x=30,y=30,width=20,height=40))),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'透明商品图'):prepare(root)
            Image.new('L',(20,20)).save(root/'foreground.upload',format='PNG')
            with self.assertRaisesRegex(ValueError,'手指保护区'):prepare(root)

    def test_background_guard_blocks_invented_foreground_but_keeps_product(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=Image.new('RGB',(80,100),(100,120,140));source.save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(20,40));ImageDraw.Draw(product).rectangle((2,2,17,37),fill='white');product.save(root/'product.upload',format='PNG')
            mask=Image.new('L',source.size);ImageDraw.Draw(mask).rectangle((15,15,65,85),fill=255);mask.save(root/'mask.upload',format='PNG')
            guard=Image.new('L',source.size);ImageDraw.Draw(guard).rectangle((16,20,32,75),fill=255);guard.save(root/'background-guard.upload',format='PNG')
            (root/'job.json').write_text(json.dumps(dict(preserveProduct=True,placement=dict(x=35,y=30,width=20,height=40))),encoding='utf-8')
            meta=prepare(root);source.save(root/'candidate.png');c=meta['crop']
            raw=source.crop((c['x'],c['y'],c['x']+c['width'],c['y']+c['height']));ImageDraw.Draw(raw).rectangle((20-c['x'],30-c['y'],29-c['x'],60-c['y']),fill=(210,145,100));raw.save(root/'raw-crop.png')
            metrics=finalize(root);result=Image.open(root/'result.png')
            self.assertEqual(result.getpixel((24,40)),(100,120,140));self.assertEqual(result.getpixel((42,40)),(255,255,255));self.assertEqual(metrics['maxChangeOutsideMask'],0)

    def test_locked_product_text_and_foreground_layer_order(self):
        source=Image.new('RGB',(30,40),(100,120,140));bg=Image.new('RGB',source.size,(20,30,40))
        layer=Image.new('RGBA',source.size,(0,0,0,0));draw=ImageDraw.Draw(layer);draw.rectangle((8,7,22,33),fill='white');draw.rectangle((12,12,16,22),fill='black')
        hand=Image.new('L',source.size);ImageDraw.Draw(hand).rectangle((20,15,25,20),fill=255)
        mask=Image.new('L',source.size);ImageDraw.Draw(mask).rectangle((5,5,25,36),fill=255)
        result,metrics=restore_product(source,bg,layer,hand,mask)
        self.assertEqual(result.getpixel((14,16)),(0,0,0));self.assertEqual(result.getpixel((21,18)),source.getpixel((21,18)))
        self.assertEqual(result.getpixel((1,1)),source.getpixel((1,1)));self.assertEqual(metrics['productMaxPixelDifference'],0);self.assertEqual(metrics['foregroundMaxPixelDifference'],0)

    def test_product_edges_blend_with_contact_shadow_without_changing_core_or_outside(self):
        source=Image.new('RGB',(40,50),(160,150,140));layer=Image.new('RGBA',source.size,(0,0,0,0))
        ImageDraw.Draw(layer).rectangle((10,10,29,39),fill=(20,30,40,255))
        foreground=Image.new('L',source.size);permission=Image.new('L',source.size)
        ImageDraw.Draw(permission).rectangle((7,7,32,42),fill=255)
        result,metrics=restore_product(source,source,layer,foreground,permission)
        self.assertEqual(result.getpixel((18,20)),(20,30,40))
        self.assertEqual(metrics['productMaxPixelDifference'],0)
        self.assertGreater(metrics['productEdgeAdjustedPixels'],0)
        self.assertLess(result.getpixel((30,25))[0],source.getpixel((30,25))[0])
        self.assertEqual(result.getpixel((33,25)),source.getpixel((33,25)))

    def test_generated_scene_only_tunes_a_narrow_product_edge_band(self):
        source=Image.new('RGB',(40,50),(160,150,140));layer=Image.new('RGBA',source.size,(0,0,0,0))
        ImageDraw.Draw(layer).rectangle((10,10,29,39),fill=(20,30,40,255))
        generated=Image.new('RGB',source.size,(220,80,60));foreground=Image.new('L',source.size)
        permission=Image.new('L',source.size);ImageDraw.Draw(permission).rectangle((7,7,32,42),fill=255)
        result,metrics=restore_product(source,source,layer,foreground,permission,generated_edge=generated)
        self.assertEqual(result.getpixel((18,20)),(20,30,40))
        self.assertEqual(metrics['productMaxPixelDifference'],0)
        self.assertGreater(metrics['generatedEdgeIntegratedPixels'],0)
        self.assertNotEqual(result.getpixel((9,20)),source.getpixel((9,20)))
        self.assertEqual(result.getpixel((33,20)),source.getpixel((33,20)))

    def test_background_blend_removes_color_step_without_modifying_outside_mask(self):
        source=Image.new('RGB',(60,70),(110,130,150));generated=Image.new('RGB',source.size,(135,155,175))
        ImageDraw.Draw(generated).rectangle((28,30,32,40),fill=(70,80,90))
        mask=Image.new('L',source.size);ImageDraw.Draw(mask).rectangle((10,12,50,59),fill=255)
        result=seamless_background(source,generated,mask)
        self.assertEqual(result.getpixel((10,20)),source.getpixel((10,20)))
        self.assertLess(result.getpixel((30,35))[0],80)
        a,b,m=np.array(source),np.array(result),np.array(mask)
        self.assertTrue(np.array_equal(a[m==0],b[m==0]))

    def test_placement_guide_respects_position_proportions_and_transparency(self):
        source=Image.new('RGB',(80,100),'navy');product=Image.new('RGBA',(20,40),(0,0,0,0))
        ImageDraw.Draw(product).rectangle((5,5,14,34),fill='red');mask=Image.new('L',source.size,255)
        p=dict(x=30,y=20,width=20,height=40)
        guide,actual=placement_guide(source,product,mask,p)
        self.assertEqual(actual,p);self.assertEqual(guide.getpixel((35,25)),(255,0,0));self.assertEqual(guide.getpixel((30,20)),source.getpixel((30,20)))
        moved,_=placement_guide(source,product,mask,dict(p,x=50))
        self.assertEqual(moved.getpixel((35,25)),source.getpixel((35,25)))
        self.assertEqual(moved.getpixel((55,25)),(255,0,0))

    def test_invalid_placement_and_product_outside_selection_rejected(self):
        source=Image.new('RGB',(80,100));product=Image.new('RGBA',(20,40),'white');mask=Image.new('L',source.size,255);p=dict(x=30,y=20,width=20,height=40)
        for invalid in [dict(p,x=-1),dict(p,width=40),dict(p,y=80),dict(p,height=float('nan'))]:
            with self.assertRaises(ValueError):placement_guide(source,product,mask,invalid)
        with self.assertRaises(ValueError):placement_guide(source,product,Image.new('L',source.size),p)

    def test_prepare_persists_guide_from_job_coordinates_and_keeps_original_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source=Image.new('RGB',(100,120),'navy');source.save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(10,20),(0,0,0,0));ImageDraw.Draw(product).rectangle((2,2,7,17),fill='red');product.save(root/'product.upload',format='PNG')
            Image.new('L',source.size,255).save(root/'mask.upload',format='PNG')
            p=dict(x=40,y=50,width=10,height=20);(root/'job.json').write_text(json.dumps(dict(placement=p)),encoding='utf-8')
            meta=prepare(root)
            self.assertEqual(meta['placement'],p)
            with Image.open(root/'placement-guide.png') as guide:self.assertEqual(guide.getpixel((42,52)),(255,0,0))
            with Image.open(root/'source.png') as original:self.assertEqual(original.getpixel((42,52)),source.getpixel((42,52)))
            with Image.open(root/'product.png') as reference:self.assertEqual(reference.getpixel((0,0)),(255,255,255))
            with Image.open(root/'product-cutout.png') as cutout:self.assertEqual(cutout.getpixel((0,0))[3],0)

    def test_crop_contains_selection_at_all_edges(self):
        for box in [(0,0,14,16),(185,100,199,129),(55,31,80,70)]:
            mask=Image.new('L',(200,130));ImageDraw.Draw(mask).rectangle(box,fill=255)
            c=crop_for_mask(mask)
            self.assertGreaterEqual(c['x'],0);self.assertGreaterEqual(c['y'],0)
            self.assertLessEqual(c['x']+c['width'],200);self.assertLessEqual(c['y']+c['height'],130)
            self.assertLessEqual(c['x'],box[0]);self.assertLessEqual(c['y'],box[1])
            self.assertGreater(c['x']+c['width'],box[2]);self.assertGreater(c['y']+c['height'],box[3])

    def test_empty_and_mismatched_masks_rejected(self):
        with self.assertRaises(ValueError):crop_for_mask(Image.new('L',(32,32)))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            Image.new('RGB',(40,50)).save(root/'source.upload',format='PNG')
            Image.new('RGB',(20,30)).save(root/'product.upload',format='PNG')
            Image.new('L',(30,50),255).save(root/'mask.upload',format='PNG')
            with self.assertRaises(ValueError):prepare(root)

    def test_outside_mask_exact_and_feather_not_applied_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source=np.arange(20*30*3,dtype=np.uint8).reshape(30,20,3)
            candidate=np.full_like(source,137);mask=np.zeros((30,20),dtype=np.uint8);mask[9:21,5:15]=128
            Image.fromarray(source).save(root/'source.png');Image.fromarray(candidate).save(root/'candidate.png');Image.fromarray(mask).save(root/'mask.png')
            result=finalize(root);output=np.array(Image.open(root/'result.png'))
            self.assertTrue(np.array_equal(output[mask==0],source[mask==0]))
            self.assertTrue(np.array_equal(output[mask>0],candidate[mask>0]))
            self.assertEqual(result['maxChangeOutsideMask'],0);self.assertEqual(result['dimensions'],[20,30])

if __name__=='__main__':unittest.main()
