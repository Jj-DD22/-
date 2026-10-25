import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import segmentation as seg


class SegmentationTests(unittest.TestCase):
    def setUp(self):
        yy, xx = np.indices((80, 100))
        self.rgba = np.stack([xx*2, yy*3, (xx+yy)%256, np.full_like(xx, 255)], axis=-1).astype('uint8')
        self.coarse = np.zeros((80, 100), dtype='uint8')
        self.coarse[20:60, 30:70] = 255
        self.mask = self.coarse > 127

    def call(self, masks=None, scores=None, rgba=None):
        masks = np.stack([self.mask]*3) if masks is None else masks
        scores = np.array([.7, .9, .8]) if scores is None else scores
        with patch.object(seg, '_run_model', return_value=(masks, scores, {'device':'mock'})) as runner:
            result = seg.refine_opaque_product(Image.fromarray(self.rgba if rgba is None else rgba), Image.fromarray(self.coarse))
        return result, runner

    def assertCode(self, code, operation):
        with self.assertRaises(seg.SegmentationError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_prompt_uses_geometric_box_and_maximum_interior_point(self):
        (_, meta), runner = self.call()
        np.testing.assert_array_equal(runner.call_args.args[1], [30, 20, 69, 59])
        # The deterministic first maximum in an even rectangle is its upper-left center.
        np.testing.assert_array_equal(runner.call_args.args[2], [[49, 39]])
        self.assertEqual(meta['positivePoint'], [49, 39])

    def test_prompt_at_image_border_still_selects_real_interior(self):
        self.coarse.fill(255)
        effective, _, point = seg._prompt(self.coarse, self.rgba[:, :, 3])
        self.assertTrue(effective[int(point[0,1]), int(point[0,0])])
        self.assertGreater(point[0,0], 0)
        self.assertGreater(point[0,1], 0)

    def test_keeps_size_coordinates_and_original_rgb_including_hidden_pixels(self):
        before = self.rgba.copy()
        (out, meta), _ = self.call()
        self.assertEqual(out.size, (100, 80))
        np.testing.assert_array_equal(np.asarray(out)[:, :, :3], before[:, :, :3])
        np.testing.assert_array_equal(self.rgba, before)
        self.assertFalse(meta['cropApplied'])
        self.assertEqual(meta['coordinateOffset'], [0, 0])

    def test_preserves_original_alpha_and_does_not_intersect_coarse_polygon(self):
        rgba=self.rgba.copy();rgba[30,40,3]=90;rgba[31,40,3]=0
        larger=self.mask.copy();larger[20:60,29]=True
        (out,meta),_=self.call(masks=np.stack([larger]*3),rgba=rgba)
        a=np.asarray(out)[:,:,3]
        self.assertEqual(a[30,40],90);self.assertEqual(a[31,40],0)
        self.assertGreater(a[30,29],127);self.assertLess(a[30,29],255)
        self.assertEqual(meta['alphaPolicy'],'minimum(input alpha, subpixel-antialiased SAM mask)')

    def test_antialiases_binary_sam_boundary_without_changing_opaque_core_or_rgb(self):
        rgba=self.rgba.copy();before=rgba.copy()
        (out,meta),_=self.call(rgba=rgba)
        alpha=np.asarray(out)[:,:,3]
        self.assertTrue(np.any((alpha[20,30:70]>0)&(alpha[20,30:70]<255)))
        self.assertTrue(np.all(alpha[30:50,40:60]==255))
        np.testing.assert_array_equal(np.asarray(out)[:,:,:3],before[:,:,:3])
        self.assertIn('antialiased',meta['alphaPolicy'])

    def test_selects_highest_predicted_score_without_calling_it_acceptance(self):
        second=self.mask.copy();second[20,:]=False
        (out,meta),_=self.call(masks=np.stack([self.mask,second,self.mask]),scores=np.array([.5,.99,.7]))
        self.assertEqual(meta['selectedIndex'],1)
        self.assertLess(np.asarray(out)[20,35,3],128)
        self.assertIn('uncalibrated',meta['scoreMeaning'])
        self.assertEqual(meta['visualAcceptance'],'pending independent review')

    def test_rejects_bad_input_modes_and_mismatched_dimensions(self):
        self.assertCode('invalidInput',lambda:seg.refine_opaque_product(Image.new('RGB',(100,80)),Image.fromarray(self.coarse)))
        self.assertCode('invalidInput',lambda:seg.refine_opaque_product(Image.fromarray(self.rgba),Image.new('L',(99,80))))

    def test_rejects_empty_coarse_without_loading_a_model(self):
        self.coarse.fill(0)
        with patch.object(seg,'_run_model') as runner:
            self.assertCode('emptyMask',lambda:seg.refine_opaque_product(Image.fromarray(self.rgba),Image.fromarray(self.coarse)))
        runner.assert_not_called()

    def test_rejects_coarse_over_fully_transparent_product(self):
        rgba=self.rgba.copy();rgba[:,:,3]=0
        self.assertCode('emptyMask',lambda:self.call(rgba=rgba))

    def test_rejects_missing_runtime(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertCode('runtimeUnavailable',lambda:seg._verified_runtime(folder))

    def test_rejects_invalid_runtime_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/'runtime-manifest.json').write_text('{}',encoding='utf-8')
            self.assertCode('runtimeInvalid',lambda:seg._verified_runtime(folder))

    def test_rejects_runtime_hash_mismatch_without_loading_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'weights').mkdir();(root/'weights/mobile_sam.pt').write_bytes(b'corrupt')
            manifest={'schemaVersion':1,'kind':'hair-opaque-mobilesam-runtime',
                      'upstream':{'commit':seg.UPSTREAM_COMMIT},
                      'model':{'path':'weights/mobile_sam.pt','sha256':seg.WEIGHT_SHA256},
                      'files':{'weights/mobile_sam.pt':{'bytes':7,'sha256':'0'*64}}}
            (root/'runtime-manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            self.assertCode('runtimeInvalid',lambda:seg._verified_runtime(folder))

    def test_rejects_wrong_shape_or_non_boolean_masks(self):
        self.assertCode('invalidOutput',lambda:self.call(masks=np.zeros((3,10,10),dtype=bool)))
        self.assertCode('invalidOutput',lambda:self.call(masks=np.stack([self.mask]*3).astype('float32')))

    def test_rejects_nonfinite_or_wrong_count_scores(self):
        self.assertCode('invalidOutput',lambda:self.call(scores=np.array([.2,np.nan,.3])))
        self.assertCode('invalidOutput',lambda:self.call(scores=np.array([.2,.3])))

    def test_rejects_nonreal_or_malformed_scores(self):
        self.assertCode('invalidOutput',lambda:self.call(scores=np.array([.2,.3,1j])))
        self.assertCode('invalidOutput',lambda:self.call(scores=[[.2],[.3,.5]]))

    def test_rejects_closed_image_as_classified_input_error(self):
        image=Image.fromarray(self.rgba);image.close()
        self.assertCode('invalidInput',lambda:seg.refine_opaque_product(image,Image.fromarray(self.coarse)))

    def test_rejects_empty_selected_mask_without_falling_back(self):
        self.assertCode('emptyMask',lambda:self.call(masks=np.stack([self.mask,np.zeros_like(self.mask),self.mask])))

    def test_rejects_extreme_area_shrink_or_growth(self):
        tiny=np.zeros_like(self.mask);tiny[30:35,40:45]=True
        self.assertCode('suspiciousArea',lambda:self.call(masks=np.stack([tiny]*3)))
        huge=np.ones_like(self.mask)
        self.assertCode('suspiciousArea',lambda:self.call(masks=np.stack([huge]*3)))

    def test_rejects_distant_component_even_with_plausible_total_area(self):
        leaked=self.mask.copy();leaked[0,0]=True
        self.assertCode('invalidOutput',lambda:self.call(masks=np.stack([leaked]*3)))

    def test_model_failure_is_propagated_without_polygon_fallback(self):
        with patch.object(seg,'_run_model',side_effect=seg.SegmentationError('inferenceFailed','failed')):
            self.assertCode('inferenceFailed',lambda:seg.refine_opaque_product(Image.fromarray(self.rgba),Image.fromarray(self.coarse)))


if __name__ == '__main__':
    unittest.main()
