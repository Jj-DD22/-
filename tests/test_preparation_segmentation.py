import json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image,ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from auto_prepare import prepare,principal_axis,axis_rotation

class PreparationSegmentationTests(unittest.TestCase):
    def fixture(self,root):
        Image.new('RGB',(200,200),'navy').save(root/'source.upload',format='PNG')
        Image.new('RGBA',(60,50),'red').save(root/'product.upload',format='PNG')
        plan=dict(assessment=dict(material='opaque'),productOutline=[[.2,.2],[.55,.2],[.55,.55],[.2,.55]],
            placement=dict(centerX=.7,bottomY=.7,height=.2),oldObject=[[[.15,.15],[.3,.15],[.3,.3],[.15,.3]]],protect=[],foreground=[],confidence=.95)
        (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')

    def test_refinement_receives_original_alpha_and_records_actual_crop_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            def refine(product,coarse):
                if product.size==(200,200):
                    result=product.copy();result.putalpha(coarse.point(lambda value:255 if value>127 else 0))
                    return result,dict(policy='source-unit-fixture')
                self.assertEqual(product.size,(60,50));self.assertTrue((np.array(product)[:,:,3]==255).all())
                self.assertEqual(coarse.getpixel((44,25)),0)
                result=product.copy();mask=Image.new('L',result.size);ImageDraw.Draw(mask).rectangle((15,10,45,30),fill=255);result.putalpha(mask)
                return result,dict(coordinateFrame='full-normalized-product',coordinateOffset=[0,0],rgbPolicy='input RGB preserved exactly')
            with patch('auto_prepare.refine_opaque_product',side_effect=refine) as mocked:result=prepare(root)
            self.assertEqual(mocked.call_count,2)
            self.assertEqual(result['segmentation']['cutoutBBoxInNormalizedProduct'],[14,9,47,32])
            self.assertEqual(result['segmentation']['cutoutCropOffset'],[14,9])
            with Image.open(root/'cutout.png') as image:self.assertEqual(image.size,(33,23))
            with Image.open(root/'review-product.jpg') as image:self.assertEqual(image.size,(1600,1115))
            self.assertEqual(result['preparationProofs']['cutoutNativeSize'],[33,23])
            self.assertFalse(result['preparationProofs']['changesProductAsset'])
            self.assertAlmostEqual(result['placement']['y']+result['placement']['height'],140)
            self.assertAlmostEqual(result['placement']['x']+result['placement']['width']/2,140)

    def test_cli_preserves_classifiable_segmentation_failure_without_coarse_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            env={**os.environ,'SWAP_SEGMENTATION_ROOT':str(root/'missing-runtime')}
            process=subprocess.run([sys.executable,'-X','utf8',str(Path(__file__).resolve().parents[1]/'auto_prepare.py'),'prepare',str(root)],env=env,capture_output=True,text=True,encoding='utf-8',timeout=20)
            self.assertNotEqual(process.returncode,0)
            self.assertIn('SEGMENTATION_runtimeUnavailable:',process.stderr)
            self.assertFalse((root/'cutout.png').exists())

    def test_rotates_cutout_before_scale_and_keeps_result_aspect_ratio(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            plan=json.loads((root/'plan.json').read_text(encoding='utf-8'))
            plan['placement']['rotationDegrees']=30
            plan['placement']['flipHorizontal']=True
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            def refine(product,coarse):
                if product.size==(200,200):
                    result=product.copy();result.putalpha(coarse.point(lambda value:255 if value>127 else 0))
                    return result,dict(policy='source-unit-fixture')
                result=product.copy();mask=Image.new('L',result.size);ImageDraw.Draw(mask).rectangle((15,10,45,30),fill=255);result.putalpha(mask)
                return result,dict(coordinateFrame='full-normalized-product',coordinateOffset=[0,0],rgbPolicy='input RGB preserved exactly')
            with patch('auto_prepare.refine_opaque_product',side_effect=refine):result=prepare(root)
            with Image.open(root/'cutout.png') as cutout:
                self.assertGreater(cutout.width,33);self.assertGreater(cutout.height,23)
                self.assertAlmostEqual(result['placement']['width']/result['placement']['height'],cutout.width/cutout.height,places=5)
            self.assertEqual(result['orientationAdaptation']['rotationDegrees'],30)
            self.assertTrue(result['orientationAdaptation']['flipHorizontal'])
            self.assertTrue(result['placement']['flipHorizontal'])
            self.assertTrue(result['orientationAdaptation']['keepsAspectRatio'])

    def test_major_axis_alignment_can_apply_a_bounded_quarter_turn(self):
        target=Image.new('L',(120,120));ImageDraw.Draw(target).rectangle((10,52,110,68),fill=255)
        product=Image.new('L',(120,120));ImageDraw.Draw(product).rectangle((52,10,68,110),fill=255)
        target_axis=principal_axis(target);product_axis=principal_axis(product)
        self.assertIsNotNone(target_axis);self.assertIsNotNone(product_axis)
        self.assertAlmostEqual(axis_rotation(product_axis,target_axis),90,places=5)
        self.assertAlmostEqual(axis_rotation({'angleDegrees':83.5},{'angleDegrees':6.5}),-77,places=5)

    def test_clears_visible_hair_or_background_gaps_marked_in_product_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            plan=json.loads((root/'plan.json').read_text(encoding='utf-8'))
            plan['productHoles']=[[[.35,.35],[.45,.35],[.45,.45],[.35,.45]]]
            (root/'plan.json').write_text(json.dumps(plan),encoding='utf-8')
            def refine(product,coarse):
                if product.size==(200,200):
                    result=product.copy();result.putalpha(coarse.point(lambda value:255 if value>127 else 0))
                    return result,dict(policy='source-unit-fixture')
                result=product.copy();mask=Image.new('L',result.size);ImageDraw.Draw(mask).rectangle((15,10,45,30),fill=255);result.putalpha(mask)
                return result,dict(coordinateFrame='full-normalized-product',coordinateOffset=[0,0],rgbPolicy='input RGB preserved exactly')
            with patch('auto_prepare.refine_opaque_product',side_effect=refine):result=prepare(root)
            with Image.open(root/'cutout.png') as cutout:
                alpha=np.asarray(cutout.getchannel('A'))
                self.assertLess(alpha[11,10],8)
            self.assertEqual(result['segmentation']['productHoleCount'],1)
            self.assertGreater(result['segmentation']['excludedProductBackgroundPixels'],0)

    def test_review_triggered_outline_recovery_clips_sam_leaks_and_keeps_antialias(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            def refine(product,coarse):
                if product.size==(200,200):
                    result=product.copy();result.putalpha(coarse.point(lambda value:255 if value>127 else 0))
                    return result,dict(policy='source-unit-fixture')
                result=product.copy();mask=Image.new('L',result.size);ImageDraw.Draw(mask).rectangle((15,10,45,30),fill=255);result.putalpha(mask)
                return result,dict(coordinateFrame='full-normalized-product',coordinateOffset=[0,0],rgbPolicy='input RGB preserved exactly')
            with patch('auto_prepare.refine_opaque_product',side_effect=refine):result=prepare(root,clip_to_outline=True)
            self.assertEqual(result['segmentation']['outlineRecovery']['policy'],'review-triggered-sam-alpha-clipped-to-plan-outline-v1')
            self.assertTrue(result['segmentation']['outlineRecovery']['requiresIndependentRereview'])
            self.assertGreater(result['segmentation']['outlineRecovery']['removedPixels'],0)
            with Image.open(root/'cutout.png') as cutout:
                alpha=np.asarray(cutout.getchannel('A'))
                self.assertEqual(cutout.size,(23,22))
                self.assertTrue(((alpha>0)&(alpha<255)).any())

if __name__=='__main__':unittest.main()
