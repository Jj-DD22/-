import sys,json,os,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image,ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import auto_prepare as ap
import segmentation as seg

class OldObjectSegmentationTests(unittest.TestCase):
    def fixture(self):
        yy,xx=np.indices((180,200));rgb=np.stack((xx%256,yy%256,(xx+yy)%256),axis=2).astype(np.uint8)
        source=Image.fromarray(rgb);old=Image.new('L',source.size);ImageDraw.Draw(old).rectangle((60,60,100,100),fill=255)
        protected=Image.new('L',source.size);ImageDraw.Draw(protected).rectangle((100,95,110,110),fill=255)
        return source,old,protected

    def test_full_source_and_original_permission_prompt_recover_edges_with_protection_clipped(self):
        source,old,protected=self.fixture();before=np.array(source);expected=ap.edit_permission(old,Image.new('L',source.size),protected,3)
        selected=np.zeros((180,200),dtype=bool);selected[54:106,56:106]=True
        def model(rgb,box,point):
            self.assertTrue(np.array_equal(rgb,before));self.assertEqual(rgb.shape,(180,200,3))
            yy,xx=np.where(np.asarray(expected)>127);self.assertEqual(list(box),[xx.min(),yy.min(),xx.max(),yy.max()])
            self.assertGreater(expected.getpixel(tuple(int(x) for x in point[0])),127)
            return np.stack([np.zeros_like(selected),selected,np.zeros_like(selected)]),np.array([.7,.99,.8]),dict(policy='fixture-backend')
        with patch.object(seg,'_run_model',side_effect=model) as mocked:refined,metadata,coarse=ap.refine_old_object(source,old,protected,3)
        self.assertEqual(mocked.call_count,1);self.assertTrue(np.array_equal(before,np.array(source)));self.assertTrue(np.array_equal(np.array(coarse),np.array(expected)))
        self.assertEqual(coarse.getpixel((56,54)),0);self.assertEqual(refined.getpixel((56,54)),255);self.assertEqual(refined.getpixel((102,98)),0)
        self.assertEqual(metadata['coordinateFrame'],'full-normalized-source');self.assertEqual(metadata['sourceSize'],[200,180]);self.assertEqual(metadata['coordinateOffset'],[0,0]);self.assertFalse(metadata['cropApplied'])
        self.assertTrue(metadata['rgbUnchanged']);self.assertTrue(metadata['alphaDoesNotExceedSource']);self.assertGreater(metadata['protectedClippedPixels'],0)
        self.assertEqual(metadata['refinedAreaPixels'],int((np.array(refined)>127).sum()));self.assertEqual(metadata['coarseAreaPixels'],int((np.array(expected)>127).sum()))
        self.assertAlmostEqual(metadata['areaRatio'],metadata['refinedAreaPixels']/metadata['coarseAreaPixels'])

    def test_abnormal_area_is_a_source_boundary_failure_without_coarse_fallback(self):
        source,old,protected=self.fixture();large=np.ones((180,200),dtype=bool)
        with patch.object(seg,'_run_model',return_value=(np.stack([large]*3),np.array([.9,.8,.7]),{})):
            with self.assertRaises(ap.OldObjectSegmentationError) as caught:ap.refine_old_object(source,old,protected,3)
        self.assertEqual(caught.exception.code,'suspiciousArea');self.assertIn('人物图',str(caught.exception))

    def test_runtime_failure_and_unexpected_failure_stop_with_source_specific_errors(self):
        source,old,protected=self.fixture()
        for code in ('runtimeUnavailable','runtimeInvalid','inferenceFailed'):
            with patch.object(seg,'_run_model',side_effect=seg.SegmentationError(code,'upstream detail')):
                with self.assertRaises(ap.OldObjectSegmentationError) as caught:ap.refine_old_object(source,old,protected,3)
            self.assertEqual(caught.exception.code,code);self.assertNotIn('upstream detail',str(caught.exception))
        with patch.object(ap,'refine_opaque_product',side_effect=RuntimeError('private implementation detail')):
            with self.assertRaises(ap.OldObjectSegmentationError) as caught:ap.refine_old_object(source,old,protected,3)
        self.assertEqual(caught.exception.code,'inferenceFailed');self.assertNotIn('private implementation',str(caught.exception))

    def test_rgb_change_is_rejected_instead_of_becoming_an_edit_permission(self):
        source,old,protected=self.fixture()
        for inplace in (False,True):
            def corrupt(rgba,coarse):
                result=rgba if inplace else rgba.copy();result.putpixel((0,0),(255,255,255,255));result.putalpha(coarse)
                return result,{}
            with patch.object(ap,'refine_opaque_product',side_effect=corrupt):
                with self.assertRaises(ap.OldObjectSegmentationError) as caught:ap.refine_old_object(source,old,protected,3)
            self.assertEqual(caught.exception.code,'invalidOutput')

    def test_prepare_uses_refined_old_object_for_every_permission_and_foreground_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=Image.new('RGB',(200,200),'navy');source.save(root/'source.upload',format='PNG')
            product=Image.new('RGBA',(60,50),'red');product.save(root/'product.upload',format='PNG')
            plan=dict(assessment=dict(material='opaque'),productOutline=[[.2,.2],[.8,.2],[.8,.7],[.2,.7]],placement=dict(centerX=.7,bottomY=.7,height=.2),oldObject=[[[.15,.15],[.3,.15],[.3,.3],[.15,.3]]],protect=[[[.2,.2],[.24,.2],[.24,.24],[.2,.24]]],foreground=[],confidence=.95)
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            def model(rgb,box,point):
                height,width=rgb.shape[:2];mask=np.zeros((height,width),dtype=bool)
                if (width,height)==(60,50):mask[10:31,15:46]=True
                else:self.assertEqual((width,height),(200,200));mask[27:67,24:65]=True
                return np.stack([mask]*3),np.array([.9,.8,.7]),{}
            foreground_old=[]
            def foreground(source,mask,old):foreground_old.append(np.array(old));return mask
            with patch.object(seg,'_run_model',side_effect=model),patch.object(ap,'refine_foreground',side_effect=foreground):result=ap.prepare(root)
            old=np.array(Image.open(root/'old-object.png'));coarse=np.array(Image.open(root/'old-object-coarse.png'))
            self.assertEqual(coarse[28,24],0);self.assertEqual(old[28,24],255);self.assertEqual(old[44,44],0);self.assertTrue(np.array_equal(foreground_old[0],old))
            for name in ('permission','backgroundMask'):
                with Image.open(root/(name+'.png')) as image:self.assertEqual(image.getpixel((24,28))[3],255);self.assertEqual(image.getpixel((44,44))[3],0)
            self.assertEqual(result['oldObjectSegmentation']['coordinateFrame'],'full-normalized-source');self.assertEqual(result['segmentation']['coordinateFrame'],'full-normalized-product')
            expected=product.copy();mask=Image.new('L',product.size);ImageDraw.Draw(mask).rectangle((15,10,45,30),fill=255);expected.putalpha(mask);expected=ap.decontaminate_cutout(expected.crop((14,9,47,32)))
            with Image.open(root/'cutout.png') as actual:
                pixels=np.array(actual);alpha=pixels[:,:,3]
                self.assertGreater(actual.width,expected.width);self.assertGreater(actual.height,expected.height)
                self.assertEqual(tuple(pixels[10,10,:3]),(255,0,0));self.assertEqual(int(alpha.max()),255)
                self.assertTrue(np.any((alpha>0)&(alpha<255)))
            self.assertEqual(result['oldObjectSegmentation']['paddingPixels'],3)

    def test_cli_classifies_old_object_runtime_failure_before_any_output_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);Image.new('RGB',(200,200),'navy').save(root/'source.upload',format='PNG');Image.new('RGBA',(60,50),'red').save(root/'product.upload',format='PNG')
            plan=dict(productOutline=[[.2,.2],[.55,.2],[.55,.55],[.2,.55]],placement=dict(centerX=.7,bottomY=.7,height=.2),oldObject=[[[.15,.15],[.3,.15],[.3,.3],[.15,.3]]],protect=[],foreground=[],confidence=.95)
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            process=subprocess.run([sys.executable,'-X','utf8',str(Path(ap.__file__)),'prepare',str(root)],env={**os.environ,'SWAP_SEGMENTATION_ROOT':str(root/'missing-runtime'),'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True,encoding='utf-8',timeout=20)
            self.assertNotEqual(process.returncode,0);self.assertIn('OLD_OBJECT_SEGMENTATION_runtimeUnavailable:',process.stderr)
            for name in ('cutout.png','permission.png','backgroundMask.png'):self.assertFalse((root/name).exists())

if __name__=='__main__':unittest.main()
