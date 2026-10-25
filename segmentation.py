"""Refine an opaque product's coarse outline in its original working coordinates.

The caller must first enforce the material/occlusion capability gate. This module
does not establish visual acceptance and never falls back to the coarse polygon.
Runtime code and dependencies live outside the portable Python installation.
"""
import hashlib
import json
import os
import sys
import threading
import time
import warnings
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

UPSTREAM_COMMIT = 'f706ad9c4eb7f219c00d9050e46328518ffb65d2'
WEIGHT_SHA256 = '6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f'
DEFAULT_RUNTIME = 'D:/SwapStudioSharedData/segmentation'
# Broad anomaly guards, not calibrated quality thresholds or acceptance scores.
MIN_AREA_RATIO, MAX_AREA_RATIO = .35, 1.8
_lock = threading.Lock()
_backend = None


class SegmentationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise SegmentationError(code, message)


def _sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _prompt(coarse, original_alpha):
    effective = (coarse > 127) & (original_alpha > 127)
    yy, xx = np.where(effective)
    if len(xx) < 64:
        _fail('emptyMask', '商品轮廓为空或过小，请重新确认商品。')
    box = np.array([xx.min(), yy.min(), xx.max(), yy.max()], dtype=np.float32)
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        _fail('emptyMask', '商品轮廓过窄，无法可靠分割。')
    # Padding ensures distance is measured to background even at image borders.
    distance = ndimage.distance_transform_edt(np.pad(effective, 1))[1:-1, 1:-1]
    y, x = np.unravel_index(np.argmax(distance), distance.shape)
    return effective, box, np.array([[x, y]], dtype=np.float32)


def _verified_runtime(root):
    root = Path(root).resolve()
    manifest_path = root / 'runtime-manifest.json'
    if not manifest_path.is_file():
        _fail('runtimeUnavailable', '精细抠图运行包未安装，请联系管理员。')
    try:
        if manifest_path.stat().st_size > 1024 * 1024:
            raise ValueError('oversized manifest')
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if (manifest.get('schemaVersion') != 1 or
                manifest.get('kind') != 'hair-opaque-mobilesam-runtime' or
                manifest.get('upstream', {}).get('commit') != UPSTREAM_COMMIT or
                manifest.get('model', {}).get('sha256') != WEIGHT_SHA256 or
                manifest.get('model', {}).get('path') != 'weights/mobile_sam.pt'):
            raise ValueError('unexpected runtime')
        records = manifest.get('files')
        if not isinstance(records, dict) or not 1 <= len(records) <= 2000:
            raise ValueError('invalid file records')
        for relative, expected in records.items():
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError('missing or out-of-root file')
            if path.stat().st_size != expected['bytes'] or _sha(path) != expected['sha256']:
                raise ValueError('runtime file hash mismatch')
        weight = root / 'weights/mobile_sam.pt'
        if _sha(weight) != WEIGHT_SHA256:
            raise ValueError('unexpected model weights')
        if not (root / 'source/mobile_sam/__init__.py').is_file() or not (root / 'deps').is_dir():
            raise ValueError('missing source/dependencies')
        return root, weight, _sha(manifest_path)
    except SegmentationError:
        raise
    except Exception as error:
        raise SegmentationError('runtimeInvalid', '精细抠图运行包不完整或校验失败，请重新安装。') from error


def _get_backend():
    global _backend
    requested = Path(os.environ.get('SWAP_SEGMENTATION_ROOT', DEFAULT_RUNTIME)).resolve()
    if _backend is not None:
        if _backend['root'] != requested:
            _fail('runtimeInvalid', '精细抠图运行包路径已变更，请重启处理进程。')
        return _backend
    root, weight, manifest_sha = _verified_runtime(requested)
    try:
        for name, relative in [('mobile_sam', 'source'), ('timm', 'deps'), ('cv2', 'deps')]:
            loaded = sys.modules.get(name)
            if loaded is not None and not Path(loaded.__file__).resolve().is_relative_to(root / relative):
                _fail('runtimeInvalid', '精细抠图依赖来源冲突，请重启处理进程。')
        sys.path[:0] = [str(root / 'deps'), str(root / 'source')]
        import torch
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', FutureWarning)
            warnings.simplefilter('ignore', UserWarning)
            from mobile_sam import sam_model_registry, SamPredictor
        torch.set_num_threads(min(8, torch.get_num_threads()))
        model = sam_model_registry['vit_t'](checkpoint=None)
        state = torch.load(weight, weights_only=True, map_location='cpu')
        model.load_state_dict(state, strict=True)
        model.to(device='cpu')
        model.eval()
        _backend = {'root': root, 'torch': torch, 'predictor': SamPredictor(model),
                    'metadata': {'runtimeRoot': str(root), 'runtimeManifestSha256': manifest_sha,
                                 'upstreamCommit': UPSTREAM_COMMIT, 'weightSha256': WEIGHT_SHA256,
                                 'pythonExecutable': sys.executable, 'torchVersion': torch.__version__,
                                 'device': 'cpu', 'threads': torch.get_num_threads(),
                                 'loadPolicy': 'weights_only=True,map_location=cpu,strict=True'}}
        return _backend
    except SegmentationError:
        raise
    except Exception as error:
        raise SegmentationError('runtimeUnavailable', '无法启动精细抠图运行包，请检查本机依赖。') from error


def _run_model(rgb, box, point):
    with _lock:
        backend = _get_backend()
        try:
            started = time.perf_counter()
            with backend['torch'].inference_mode():
                backend['predictor'].set_image(rgb)
                encoded = time.perf_counter()
                masks, scores, _ = backend['predictor'].predict(
                    point_coords=point, point_labels=np.array([1], dtype=np.int32),
                    box=box, multimask_output=True)
            metadata = dict(backend['metadata'], encodeSeconds=encoded-started,
                            decodeSeconds=time.perf_counter()-encoded)
            return masks, scores, metadata
        except Exception as error:
            raise SegmentationError('inferenceFailed', '精细抠图失败，请重新确认商品或补充清晰商品图。') from error


def _validate_output(masks, scores, effective, original_alpha, box):
    if (not isinstance(masks, np.ndarray) or masks.dtype != np.bool_ or masks.ndim != 3 or
            masks.shape[0] != 3 or masks.shape[1:] != effective.shape):
        _fail('invalidOutput', '精细抠图返回的轮廓尺寸或格式异常，已停止处理。')
    if (not isinstance(scores, np.ndarray) or scores.shape != (3,) or
            scores.dtype.kind not in 'fiu' or not np.isfinite(scores).all()):
        _fail('invalidOutput', '精细抠图返回的候选评分异常，已停止处理。')
    index = int(np.argmax(scores))
    # Binary SAM edges look jagged after the product is scaled onto the scene.
    # A sub-pixel Gaussian coverage estimate smooths only the mask boundary;
    # original transparent pixels and the opaque interior remain protected.
    hard_mask = masks[index].astype(np.float32)
    smooth_mask = ndimage.gaussian_filter(hard_mask, sigma=0.65, mode='nearest')
    antialiased_mask = np.rint(np.clip(smooth_mask, 0, 1) * 255).astype(np.uint8)
    alpha = np.minimum(original_alpha, antialiased_mask)
    visible = alpha > 127
    count = int(visible.sum())
    if not count:
        _fail('emptyMask', '精细抠图没有保留有效商品，请补充清晰商品图。')
    ratio = count / int(effective.sum())
    if not MIN_AREA_RATIO <= ratio <= MAX_AREA_RATIO:
        _fail('suspiciousArea', '精细抠图与识别轮廓面积差异过大，请确认商品或补图。')
    # Detect distant leaked components; nearby coarse-outline correction is allowed.
    height, width = effective.shape
    margin = max(8, int(round(max(box[2]-box[0], box[3]-box[1]) * .15)))
    x0, y0 = max(0, int(box[0])-margin), max(0, int(box[1])-margin)
    x1, y1 = min(width, int(box[2])+margin+1), min(height, int(box[3])+margin+1)
    if int(visible[y0:y1, x0:x1].sum()) != count:
        _fail('invalidOutput', '精细抠图出现远离目标的区域，请重新确认商品。')
    return alpha, index, [float(x) for x in scores], ratio


def refine_opaque_product(productRGBA, coarseAlpha):
    """Return (full-size RGBA, metadata); retain exact RGB and min(original alpha, SAM).

    coarseAlpha is a same-size PIL L mask used only for bbox and one maximum-
    distance positive point. No cropping, rotation, feathering, or RGB repainting
    occurs here. SegmentationError.code distinguishes safe failure routes.
    """
    if (not isinstance(productRGBA, Image.Image) or productRGBA.mode != 'RGBA' or
            not isinstance(coarseAlpha, Image.Image) or coarseAlpha.mode != 'L' or
            productRGBA.size != coarseAlpha.size or min(productRGBA.size) < 3 or
            productRGBA.width * productRGBA.height > 16_000_000):
        _fail('invalidInput', '精细抠图需要尺寸一致的 RGBA 商品图和灰度轮廓。')
    try:
        rgba = np.array(productRGBA, copy=True)
        coarse = np.asarray(coarseAlpha)
    except Exception as error:
        raise SegmentationError('invalidInput', '无法读取商品图或轮廓，请重新上传。') from error
    effective, box, point = _prompt(coarse, rgba[:, :, 3])
    masks, scores, runtime = _run_model(np.ascontiguousarray(rgba[:, :, :3]), box, point)
    alpha, selected, predicted, ratio = _validate_output(masks, scores, effective, rgba[:, :, 3], box)
    rgba[:, :, 3] = alpha
    metadata = dict(runtime, policy='opaque-mobile-sam-box-p1-v1', coordinateFrame='full-normalized-product',
                    sourceSize=list(productRGBA.size), cropApplied=False, coordinateOffset=[0, 0],
                    box=[int(x) for x in box], positivePoint=[int(x) for x in point[0]],
                    predictedIoUScores=predicted, selectedIndex=selected,
                    scoreMeaning='uncalibrated model prediction for candidate ranking; not visual acceptance',
                    coarseAreaPixels=int(effective.sum()), refinedAreaPixels=int((alpha > 127).sum()),
                    areaRatio=ratio, areaGuard={'minimum': MIN_AREA_RATIO, 'maximum': MAX_AREA_RATIO,
                    'meaning': 'anomaly stop only; not visual acceptance'},
                    rgbPolicy='input RGB preserved exactly', alphaPolicy='minimum(input alpha, subpixel-antialiased SAM mask)',
                    visualAcceptance='pending independent review')
    return Image.fromarray(rgba), metadata
