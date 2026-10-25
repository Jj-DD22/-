"""Small, explicitly selected texture repairs after a successful swap.

This is an operator tool, not automatic object detection. A recipe specifies a
repair polygon, a component seed and a clean donor offset in the same image.
Product interiors and all foreground pixels are immutable.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import warnings

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve, MatrixRankWarning


def texture_repair(base, product, foreground, recipe):
    if base.size != product.size or base.size != foreground.size:
        raise ValueError('修整图、商品层、前景层尺寸必须一致。')
    w, h = base.size
    if recipe.get('imageSize') != [w, h]:
        raise ValueError('配方坐标尺寸与图片不一致。')
    polygon = recipe.get('polygon')
    if not isinstance(polygon, list) or not 3 <= len(polygon) <= 128:
        raise ValueError('需要明确的局部修整轮廓。')
    def point(value):
        return (isinstance(value, (list, tuple)) and len(value) == 2
                and all(isinstance(v, int) and not isinstance(v, bool) for v in value))
    if any(not point(p) or not (1 <= p[0] < w-1 and 1 <= p[1] < h-1) for p in polygon):
        raise ValueError('修整轮廓必须在图片内部。')
    seed, offset = recipe.get('seed'), recipe.get('donorOffset')
    feather = recipe.get('feather', 4)
    if not point(seed) or not (0 <= seed[0] < w and 0 <= seed[1] < h):
        raise ValueError('修整起点无效。')
    if not point(offset) or not any(offset) or not isinstance(feather, (int, float)) or not 1 <= feather <= 12:
        raise ValueError('纹理来源位移或过渡宽度无效。')
    s = np.asarray(base.convert('RGB'), dtype=np.float64)
    p = np.asarray(product.convert('RGBA'), dtype=np.float64)
    f = np.asarray(foreground.convert('L')) > 0
    locked = (p[:, :, 3] == 255) | f
    mask = Image.new('L', base.size)
    ImageDraw.Draw(mask).polygon([tuple(p) for p in polygon], fill=255)
    requested = np.asarray(mask) > 0
    labels, _ = ndimage.label(requested & ~locked)
    component = labels[seed[1], seed[0]]
    if component == 0:
        raise ValueError('起点必须位于允许修整的背景中，不能位于商品或前景上。')
    region = labels == component
    ys, xs = np.where(region)
    count = len(ys)
    if count > min(100000, w*h*.02):
        raise ValueError('局部修整范围过大，应改用完整的场景修复。')
    dx, dy = offset
    # Include a one-pixel boundary so every donor lookup below is checked.
    lookup = ndimage.binary_dilation(region)
    ly, lx = np.where(lookup)
    if (lx+dx).min() < 0 or (lx+dx).max() >= w or (ly+dy).min() < 0 or (ly+dy).max() >= h:
        raise ValueError('纹理来源超出图片。')
    if np.any(requested[ly+dy, lx+dx] | (p[ly+dy, lx+dx, 3] > 0) | f[ly+dy, lx+dx]):
        raise ValueError('纹理来源必须避开修整区域、商品和前景。')

    # Harmonic colour correction on the translated donor; its high-frequency
    # texture is retained. Locked product edges are Neumann boundaries so pink
    # fabric cannot bleed into the hair. Only actual surrounding hair anchors RGB.
    index = np.full(region.shape, -1, dtype=np.int32)
    index[region] = np.arange(count)
    rows, cols, values = [], [], []
    rhs = np.zeros((count, 3))
    diag = np.zeros(count)
    anchors = 0
    for oy, ox in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
        yy, xx = ys+oy, xs+ox
        valid = ~locked[yy, xx]
        diag += valid
        inside = region[yy, xx] & valid
        rows.extend(np.flatnonzero(inside))
        cols.extend(index[yy[inside], xx[inside]])
        values.extend(np.full(inside.sum(), -1.))
        boundary = ~region[yy, xx] & valid
        anchors += int(boundary.sum())
        rhs[boundary] += s[yy[boundary], xx[boundary]]-s[yy[boundary]+dy, xx[boundary]+dx]
    if not anchors:
        raise ValueError('修整区没有可用的背景边界，不能可靠融合。')
    rows.extend(range(count)); cols.extend(range(count)); values.extend(diag)
    matrix = sparse.coo_matrix((values, (rows, cols)), shape=(count, count)).tocsc()
    with warnings.catch_warnings():
        warnings.simplefilter('error', MatrixRankWarning)
        correction = spsolve(matrix, rhs)
    if not np.isfinite(correction).all():
        raise ValueError('纹理融合计算失败。')
    patch = s.copy()
    patch[ys, xs] = s[ys+dy, xs+dx]+correction
    # Recompose only the fractional alpha edge against the repaired hair.
    # Locking every alpha>0 pixel would freeze the old halo into the new result.
    a = p[ys, xs, 3:4]/255
    patch[ys, xs] = patch[ys, xs]*(1-a)+p[ys, xs, :3]*a
    distance = ndimage.distance_transform_edt(region | locked)
    alpha = np.where(region, np.minimum(1, distance/feather), 0)
    result = np.rint(np.clip(s+(patch-s)*alpha[:, :, None], 0, 255)).astype('uint8')
    changed = np.max(np.abs(result.astype(np.int16)-s.astype(np.int16)), axis=2)
    maximum = lambda values: int(values.max()) if values.size else 0
    record = {
        'refinementChangedPixels': int((changed > 0).sum()),
        'refinementChangedPercent': round(float((changed > 0).mean())*100, 4),
        'maxChangeOutsideRefinement': maximum(changed[~region]),
        'productChangeFromPrevious': maximum(changed[p[:, :, 3] == 255]),
        'foregroundChangeFromPrevious': maximum(changed[f]),
        'repairBounds': [int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1)],
    }
    assert record['maxChangeOutsideRefinement'] == record['productChangeFromPrevious'] == record['foregroundChangeFromPrevious'] == 0
    return Image.fromarray(result), Image.fromarray((region*255).astype('uint8')), record


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def run(job_dir, recipe_path, output_dir, publish=False):
    job_dir, recipe_path, output_dir = map(Path, (job_dir, recipe_path, output_dir))
    if output_dir.exists():
        raise ValueError('输出目录已存在，请使用新目录以保留旧版。')
    job = json.loads((job_dir/'job.json').read_text(encoding='utf-8'))
    if job.get('status') != 'succeeded':
        raise ValueError('只能修整已完成的任务。')
    recipe = json.loads(recipe_path.read_text(encoding='utf-8'))
    if recipe.get('baselineSha256') and recipe['baselineSha256'] != digest(job_dir/'result.png'):
        raise ValueError('配方对应的原结果已变化，拒绝套用旧坐标。')
    if publish and (job_dir/'refinement.json').exists():
        raise ValueError('已有修整版本；请先输出到新目录进行对照，不自动覆盖。')
    baseline = Image.open(job_dir/'result.png').convert('RGB')
    product = Image.open(job_dir/'product-layer.png').convert('RGBA')
    foreground = Image.open(job_dir/'foreground.png').convert('L')
    result, repair_mask, metrics = texture_repair(baseline, product, foreground, recipe)
    source = Image.open(job_dir/'source.png').convert('RGB')
    original_mask = np.asarray(Image.open(job_dir/'mask.png').convert('L'))
    union = np.maximum(original_mask, np.asarray(repair_mask))
    delta = np.max(np.abs(np.asarray(result).astype(np.int16)-np.asarray(source).astype(np.int16)), axis=2)
    previous = json.loads((job_dir/'verification.json').read_text(encoding='utf-8'))
    record = {**previous, **metrics,
              'changedPixels': int((delta > 0).sum()),
              'changedPercent': round(float((delta > 0).mean())*100, 2),
              'maxChangeOutsideMask': int(delta[union == 0].max()) if np.any(union == 0) else 0,
              'additionalPermissionPixels': int(((union > 0) & (original_mask == 0)).sum()),
              'permissionBasis': 'original-mask-union-explicit-refinement'}
    if record['maxChangeOutsideMask'] != 0:
        raise ValueError('选区外像素检查失败，拒绝发布。')
    output_dir.mkdir(parents=True)
    result.save(output_dir/'result.png')
    repair_mask.save(output_dir/'repair-mask.png')
    Image.fromarray(union).save(output_dir/'permission.png')
    (output_dir/'recipe.json').write_text(json.dumps(recipe, ensure_ascii=False, indent=2), encoding='utf-8')
    (output_dir/'verification.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    sha = digest(output_dir/'result.png')
    manifest = {
        'schemaVersion': 1, 'revision': sha[:12], 'jobId': job['id'],
        'method': 'local-texture-repair-v1', 'generatedAgain': False,
        'operatorSelected': True,
        'description': str(recipe.get('description', '局部纹理修整；保留商品与前景主体。'))[:300],
        'baselineSha256': digest(job_dir/'result.png'), 'resultSha256': sha,
        'inputs': {name: digest(job_dir/name) for name in
                   ('result.png', 'product-layer.png', 'foreground.png', 'mask.png', 'source.png')},
        'recipeSha256': digest(output_dir/'recipe.json'),
    }
    (output_dir/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    if publish:
        # Immutable version directory, followed by an atomic active-version pointer.
        # Original ComfyUI output, workflow, timings and verification are retained.
        target = job_dir/'refinements'/manifest['revision']
        target.parent.mkdir(exist_ok=True)
        shutil.copytree(output_dir, target)
        pointer = job_dir/'refinement.json'
        if pointer.exists():
            raise ValueError('已有修整版本；新文件已保留，需明确选择后再切换。')
        temporary = job_dir/'refinement.json.tmp'
        temporary.write_text(json.dumps({'revision': manifest['revision']}), encoding='utf-8')
        temporary.replace(pointer)
    return {'revision': manifest['revision'], 'published': publish, 'verification': record}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job-dir', required=True)
    parser.add_argument('--recipe', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.job_dir, args.recipe, args.output_dir, args.publish), ensure_ascii=False))
