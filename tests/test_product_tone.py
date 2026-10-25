
import unittest
import numpy as np
from PIL import Image
from image_pipeline import apply_product_tone
class ProductToneTests(unittest.TestCase):
    def test_soft_tone_preserves_alpha_and_reduces_chroma(self):
        pixels=np.array([[[230,70,20,255],[240,240,240,128],[0,0,0,0]]],dtype=np.uint8)
        result=np.array(apply_product_tone(Image.fromarray(pixels),{'saturation':.85,'contrast':.9}))
        self.assertTrue(np.array_equal(result[:,:,3],pixels[:,:,3]))
        self.assertLess(int(result[0,0,:3].max())-int(result[0,0,:3].min()),210)
        self.assertLess(result[0,1,0],240)
        self.assertTrue(np.array_equal(np.array(apply_product_tone(Image.fromarray(pixels),{'saturation':1,'contrast':1})),pixels))
    def test_invalid_tone_is_rejected(self):
        for value in [float('nan'),True,4,-1]:
            with self.assertRaises(ValueError):
                apply_product_tone(Image.new('RGBA',(2,2)),{'saturation':value,'contrast':1})
