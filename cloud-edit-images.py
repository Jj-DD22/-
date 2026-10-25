"""Only normalize uploads and validate returned pixels; editing happens at the API."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from image_pipeline import read_image

mode, folder = sys.argv[1:]
root = Path(folder)
if mode == 'prepare':
    result = {}
    for name in ('source', 'product'):
        metadata = {}
        im = read_image(root / (name + '.upload'), max_pixels=64_000_000,
                        max_longest=1600, max_bytes=20*1024*1024, metadata=metadata)
        im.save(root / (name + '.jpg'), quality=95)
        result[name] = dict(size=list(im.size), normalization=metadata)
    w, h = result['source']['size']
    ratio = min(1, 1280 / max(w, h))
    result['outputSize'] = [max(384, round(w*ratio/16)*16), max(384, round(h*ratio/16)*16)]
else:
    im = read_image(root / 'result.download', max_pixels=16_000_000, max_bytes=25*1024*1024)
    im.save(root / 'result.png')
    preview = im.copy()
    preview.thumbnail((1600, 1600))
    preview.save(root / 'result-review.jpg', quality=92)
    result = dict(dimensions=list(im.size))
print(json.dumps(result, ensure_ascii=False))
