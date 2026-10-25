import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
import numpy as np
from PIL import Image
from local_refinement import texture_repair


class RefinementTests(unittest.TestCase):
    def scene(self):
        y, x = np.mgrid[:200, :200]
        rgb = np.stack([80+x//4+(x%4)*8, 90+y//4+(x%4)*7, 60+x//5+(x%4)*5], axis=2).astype('uint8')
        product = np.zeros((200, 200, 4), dtype='uint8')
        product[106:120, 90:116] = [240, 150, 190, 255]
        product[105, 90:116] = [240, 150, 190, 96]
        foreground = np.zeros((200, 200), dtype='uint8')
        foreground[101:109, 109:112] = 255
        rgb[99:104, 96:105] = 0
        rgb[106:120, 90:116] = [240, 150, 190]
        return Image.fromarray(rgb), Image.fromarray(product), Image.fromarray(foreground), {
            'imageSize': [200, 200], 'polygon': [[92,94],[114,94],[114,112],[92,112]],
            'seed': [100, 100], 'donorOffset': [0,-30], 'feather': 2,
        }

    def test_repairs_dark_remnant_but_preserves_texture_product_foreground_and_outside(self):
        base, product, foreground, recipe = self.scene()
        result, mask, metrics = texture_repair(base, product, foreground, recipe)
        a, b, m = np.array(base), np.array(result), np.array(mask)>0
        self.assertTrue(np.array_equal(a[~m], b[~m]))
        self.assertTrue(np.array_equal(a[np.array(product)[:,:,3]==255], b[np.array(product)[:,:,3]==255]))
        self.assertTrue(np.array_equal(a[np.array(foreground)>0], b[np.array(foreground)>0]))
        self.assertGreater(int(b[101,100,0]), 60)
        self.assertGreater(int(b[101,103,0])-int(b[101,100,0]), 10)
        self.assertGreater(metrics['refinementChangedPixels'], 0)
        self.assertEqual(metrics['maxChangeOutsideRefinement'], 0)
        self.assertEqual(result.tobytes(), texture_repair(base, product, foreground, recipe)[0].tobytes())

    def test_refuses_wrong_geometry_or_contaminated_donor(self):
        base, product, foreground, recipe = self.scene()
        for changed, message in [({'imageSize':[100,100]},'尺寸'),({'donorOffset':[0,0]},'位移'),
                                 ({'donorOffset':[0,-2]},'来源'),({'donorOffset':[0,-199]},'超出'),
                                 ({'seed':[95,110]},'起点')]:
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError,message):
                texture_repair(base, product, foreground, {**recipe, **changed})

    def test_refuses_large_area_instead_of_silently_blurring_scene(self):
        base, product, foreground, recipe = self.scene()
        recipe['polygon']=[[20,20],[180,20],[180,180],[20,180]]
        with self.assertRaisesRegex(ValueError,'范围过大'):
            texture_repair(base, product, foreground, recipe)


if __name__ == '__main__':
    unittest.main()
