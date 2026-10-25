"""Validate inputs, derive a dynamic crop and preserve unmasked pixels."""
import json
import math
import sys
from pathlib import Path
import warnings
from PIL import Image, ImageFilter, ImageOps
import numpy as np
Image.MAX_IMAGE_PIXELS = 64_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def read_image(path, mode='RGB', *, max_pixels=16_000_000, max_longest=None, max_bytes=None, metadata=None):
    """Strict by default; only automatic original uploads opt into normalization."""
    if max_bytes is not None and Path(path).stat().st_size > max_bytes:
        raise ValueError('单张图片不能超过 20 MB。')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in ('PNG', 'JPEG', 'WEBP'):
                    raise ValueError('请使用 PNG、JPG 或 WebP 图片。')
                if image.width * image.height > max_pixels:
                    raise ValueError(f'单张图片不能超过 {max_pixels//10_000} 万像素。')
                original_size=list(image.size);orientation=image.getexif().get(274,1)
                oriented=ImageOps.exif_transpose(image)
                if mode=='L' and ('A' in oriented.getbands() or 'transparency' in oriented.info):
                    # Match a browser mask drawn onto opaque black: white RGB in
                    # a transparent PNG is not permission to edit those pixels.
                    rgba=oriented.convert('RGBA')
                    black=Image.new('RGBA',rgba.size,(0,0,0,255));black.alpha_composite(rgba)
                    working=black.convert('L')
                else:working=oriented.convert(mode)
                oriented_size=list(working.size)
                if max_longest is not None:
                    working.thumbnail((max_longest,max_longest),Image.Resampling.LANCZOS)
                # Canonical PNGs must never carry an orientation to apply a second time.
                working.info.clear()
                if metadata is not None:
                    metadata.update(originalSize=original_size,orientedSize=oriented_size,workingSize=list(working.size),exifTransposed=orientation in (2,3,4,5,6,7,8),resized=list(working.size)!=oriented_size)
                return working
    except (Image.DecompressionBombWarning,Image.DecompressionBombError) as error:
        raise ValueError(f'单张图片不能超过 {max_pixels//10_000} 万像素。') from error

def crop_for_mask(mask):
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError('选区为空，请先涂选要替换的商品。')
    left, top, right, bottom = bbox
    if (right-left)*(bottom-top) < 64:
        raise ValueError('选区太小，请涂出完整商品与需要调整的手指。')
    margin = max(24, round(max(right-left, bottom-top)*.2))
    width = min(mask.width, math.ceil((right-left+2*margin)/16)*16)
    height = min(mask.height, math.ceil((bottom-top+2*margin)/16)*16)
    x = min(max(0, round((left+right-width)/2)), mask.width-width)
    y = min(max(0, round((top+bottom-height)/2)), mask.height-height)
    return dict(x=x, y=y, width=width, height=height)

def reference_size(width, height, longest, minimum=64):
    scale = longest/max(width,height)
    return dict(width=max(minimum, round(width*scale/32)*32), height=max(minimum, round(height*scale/32)*32))

def resize_rgba(image, size, resample=Image.Resampling.LANCZOS):
    """Resample RGBA in premultiplied-alpha space to prevent dark fringes."""
    rgba=image.convert('RGBA')
    if rgba.size==tuple(size):return rgba.copy()
    return rgba.convert('RGBa').resize(tuple(size),resample=resample).convert('RGBA')

def rotate_rgba(image, angle, resample=Image.Resampling.BICUBIC, expand=True):
    """Rotate a transparent layer without interpolating hidden RGB into its edge."""
    return image.convert('RGBA').convert('RGBa').rotate(
        angle,resample=resample,expand=expand,fillcolor=(0,0,0,0)
    ).convert('RGBA')

def decontaminate_cutout(product):
    """Defringe only a narrow silhouette band; opaque label pixels stay exact.

    Reference background RGB often survives in antialiased boundary pixels.
    Borrow nearby interior foreground color, never blur RGB across transparency.
    The alpha silhouette remains unchanged (including transparent cap details).
    """
    from scipy import ndimage
    rgba=np.array(product.convert('RGBA'));alpha=rgba[:,:,3]
    inside=alpha>127
    distance=ndimage.distance_transform_edt(np.pad(inside,1))[1:-1,1:-1]
    core=(alpha==255)&(distance>=2.5)
    if not core.any():return product.copy()
    proximity,nearest=ndimage.distance_transform_edt(~core,return_indices=True)
    band=(alpha>0)&~core&(proximity<=4)
    # Color correction is confined to the outline, not applied by color globally.
    rgb=rgba[:,:,:3];rgb[band]=rgb[tuple(nearest)][band]
    return Image.fromarray(rgba)

def placement_guide(source, product, mask, placement):
    if not isinstance(placement, dict) or any(not isinstance(placement.get(k),(int,float)) or isinstance(placement.get(k),bool) or not math.isfinite(placement[k]) for k in ('x','y','width','height')):
        raise ValueError('商品位置无效，请重新摆放商品。')
    x,y,w,h=(placement[k] for k in ('x','y','width','height'))
    if x<0 or y<0 or w<1 or h<1 or x+w>source.width+.001 or y+h>source.height+.001:
        raise ValueError('商品位置超出人物图，请移回画布内。')
    if abs(w/h-product.width/product.height)>.001:
        raise ValueError('商品必须保持原始长宽比，请重新调整大小。')
    x,y,w,h=round(x),round(y),max(1,round(w)),max(1,round(h))
    w,h=min(w,source.width-x),min(h,source.height-y)
    layer=Image.new('RGBA',source.size)
    layer.alpha_composite(resize_rgba(product,(w,h),Image.Resampling.LANCZOS),(x,y))
    alpha=np.array(layer.getchannel('A'))>32
    if not alpha.any():
        raise ValueError('商品内容为空，请重新上传商品图。')
    # Never silently expand permission to edit surrounding pixels.
    if np.count_nonzero(alpha & (np.array(mask)<200))/np.count_nonzero(alpha)>.005:
        raise ValueError('摆放的商品超出绿色选区，请补涂或将商品区域加入选区。')
    return Image.alpha_composite(source.convert('RGBA'),layer).convert('RGB'),dict(x=x,y=y,width=w,height=h)

def foreground_matte(source, foreground):
    """Remove old-background chroma from the narrow hand edge, retaining its shape.

    Only blue/magenta excess relative to nearby opaque hand pixels is corrected.
    Luminance, the alpha silhouette and hand interior are kept. Product pixels are
    not input to this operation, so red branding cannot be mistaken for spill.
    """
    from scipy import ndimage
    rgb=np.asarray(source,dtype=np.float32);f=np.asarray(foreground,dtype=np.float32)/255
    distance=ndimage.distance_transform_edt(np.pad(f>.5,1))[1:-1,1:-1]
    core=(f==1)&(distance>=2)
    if not core.any():return source.copy(),core,np.zeros(f.shape,dtype=bool)
    _,nearest=ndimage.distance_transform_edt(~core,return_indices=True)
    clean=rgb[tuple(nearest)]
    # Pink cup contamination has more blue relative to green than nearby skin.
    excess=(rgb[:,:,2]-rgb[:,:,1])-(clean[:,:,2]-clean[:,:,1])
    nearby=ndimage.distance_transform_edt(~core)<=3
    weight=np.clip((excess-6)/18,0,1)*((f>0)&~core&nearby)
    luma=np.array([.2126,.7152,.0722],dtype=np.float32)
    replacement=clean+((rgb-clean)@luma)[:,:,None]
    corrected=np.rint(np.clip(rgb+(replacement-rgb)*weight[:,:,None],0,255)).astype(np.uint8)
    changed=np.any(corrected!=rgb,axis=2)
    return Image.fromarray(corrected),core,changed

def clean_placement_background(source, permission, foreground_core):
    """Harmonic fill of the old-object area, used only as a model placement guide.

    Supplying a guide with the obsolete handle still visible encourages the model
    to reinterpret it as a raised finger. This removes that misleading geometry.
    """
    from scipy import sparse,ndimage
    from scipy.sparse.linalg import spsolve
    region=(np.asarray(permission)>0)&~foreground_core
    if not region.any():return source.copy()
    ys,xs=np.where(region);box=(max(0,int(xs.min())-1),max(0,int(ys.min())-1),min(source.width,int(xs.max())+2),min(source.height,int(ys.max())+2))
    native=(box[2]-box[0],box[3]-box[1]);scale=min(1,384/max(native));size=tuple(max(1,round(v*scale)) for v in native)
    pixels=np.asarray(source.crop(box).resize(size,Image.Resampling.BILINEAR),dtype=np.float64).copy()
    unknown=np.array(Image.fromarray(region).crop(box).resize(size,Image.Resampling.NEAREST),dtype=bool)
    # Pin the crop border: every component has a known Dirichlet boundary.
    unknown[[0,-1],:]=False;unknown[:,[0,-1]]=False
    yy,xx=np.where(unknown);count=len(yy)
    if not count:return source.copy()
    index=np.full(unknown.shape,-1,dtype=np.int32);index[unknown]=np.arange(count)
    rows=[np.arange(count)];cols=[np.arange(count)];data=[np.full(count,4.)];rhs=np.zeros((count,3))
    for dy,dx in [(0,1),(0,-1),(1,0),(-1,0)]:
        ny,nx=yy+dy,xx+dx;j=index[ny,nx];inside=j>=0
        rows.append(np.arange(count)[inside]);cols.append(j[inside]);data.append(np.full(inside.sum(),-1.))
        rhs[~inside]+=pixels[ny[~inside],nx[~inside]]
    matrix=sparse.coo_matrix((np.concatenate(data),(np.concatenate(rows),np.concatenate(cols))),shape=(count,count)).tocsc()
    pixels[yy,xx]=spsolve(matrix,rhs)
    filled=Image.fromarray(np.rint(np.clip(pixels,0,255)).astype(np.uint8)).resize(native,Image.Resampling.BILINEAR)
    candidate=source.copy();candidate.paste(filled,(box[0],box[1]))
    return Image.composite(candidate,source,Image.fromarray((region*255).astype(np.uint8)))

def apply_product_tone(product, tone):
    if not tone: return product
    saturation=tone.get('saturation',1);contrast=tone.get('contrast',1)
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<.7 or v>1.05 for v in (saturation,contrast)):
        raise ValueError('商品调色参数无效。')
    pixels=np.array(product,dtype=np.float32)
    rgb=pixels[:,:,:3];gray=np.sum(rgb*np.array([.2126,.7152,.0722]),axis=2,keepdims=True)
    pixels[:,:,:3]=np.clip((gray+(rgb-gray)*saturation-128)*contrast+128,0,255)
    return Image.fromarray(np.rint(pixels).astype(np.uint8),'RGBA')

def prepare(root):
    source = read_image(root/'source.upload')
    product = read_image(root/'product.upload','RGBA')
    mask = read_image(root/'mask.upload', 'L')
    if mask.size != source.size:
        raise ValueError('蒙版尺寸与人物图不一致，请重新涂选。')
    crop = crop_for_mask(mask)
    source.save(root/'source.png')
    product.save(root/'product-cutout.png')
    # White behind transparent cutouts makes the separate appearance reference unambiguous.
    reference=Image.new('RGBA',product.size,'white');reference.alpha_composite(product)
    reference.convert('RGB').save(root/'product.png')
    mask.save(root/'mask.png')
    mask.crop((crop['x'],crop['y'],crop['x']+crop['width'],crop['y']+crop['height'])).save(root/'mask-crop.png')
    meta = dict(sourceSize=list(source.size), crop=crop, generation=reference_size(crop['width'],crop['height'],448,128),product=reference_size(product.width,product.height,608))
    job_path=root/'job.json'
    job=json.loads(job_path.read_text(encoding='utf-8')) if job_path.exists() else {}
    product=apply_product_tone(product,job.get('productTone'))
    meta['productTone']=job.get('productTone')
    placement=job.get('placement')
    background_only=job.get('backgroundOnlyGeneration') is True
    if background_only and (job.get('preserveProduct') is not True or placement is None):
        raise ValueError('发饰背景修复模式需要商品保真和已确认位置。')
    if background_only and not (root/'background-mask.upload').exists():
        raise ValueError('发饰背景修复模式需要明确的旧物修复区，请先自动识别旧发饰。')
    foreground=read_image(root/'foreground.upload','L') if (root/'foreground.upload').exists() else Image.new('L',source.size)
    if foreground.size!=source.size:
        raise ValueError('手指保护区与人物图尺寸不一致。')
    foreground.save(root/'foreground.png')
    background_mask=mask
    if (root/'background-mask.upload').exists():
        background_mask=read_image(root/'background-mask.upload','L')
        if background_mask.size!=source.size:raise ValueError('背景修复区与原图尺寸不一致。')
        background_mask=Image.fromarray(np.minimum(np.array(background_mask),np.array(mask)))
        if background_only and background_mask.getbbox() is None:
            raise ValueError('旧物修复区为空或位于允许范围之外，请重新识别旧发饰。')
        background_mask.save(root/'background-mask.png')
    if (root/'background-guard.upload').exists():
        guard=read_image(root/'background-guard.upload','L')
        if guard.size!=source.size:raise ValueError('背景保护区与原图尺寸不一致。')
        guard_permission=background_mask if background_only else mask
        Image.fromarray(np.minimum(np.array(guard),np.array(guard_permission))).save(root/'background-guard.png')
    preserve=job.get('preserveProduct',False)
    if preserve and (placement is None or product.getchannel('A').getextrema()[0]==255):
        raise ValueError('保留文字与 logo 需要透明商品图，请先沿轮廓抠图，或关闭此选项。')
    if placement is not None:
        guide,actual=placement_guide(source,product,mask,placement)
        if preserve:
            layer=Image.new('RGBA',source.size)
            layer.alpha_composite(resize_rgba(product,(actual['width'],actual['height']),Image.Resampling.LANCZOS),(actual['x'],actual['y']))
            layer.save(root/'product-layer.png')
            hand,hand_core,_=foreground_matte(source,foreground)
            clean=clean_placement_background(source,background_mask if job.get('backgroundOnlyGeneration') is True else mask,hand_core)
            if job.get('backgroundOnlyGeneration') is True:
                clean.save(root/'background-guide.png')
                meta['backgroundOnlyGeneration']=True
                meta['generation']=reference_size(crop['width'],crop['height'],640,128)
            guide=Image.alpha_composite(clean.convert('RGBA'),layer).convert('RGB')
            guide=Image.composite(hand,guide,foreground)
            meta['preserveProduct']=True
            meta['gripEdgeCleanup']=True
            meta['generatedEdgeIntegration']=job.get('integrateGeneratedEdges') is True and job.get('backgroundOnlyGeneration') is not True
        guide.save(root/'placement-guide.png')
        meta['placement']=actual
    (root/'meta.json').write_text(json.dumps(meta),encoding='utf-8')
    return meta

def seamless_background(source, generated, permission):
    """Remove low-frequency boundary mismatch, leaving source pixels outside permission exact.

    A harmonic RGB correction uses only the selected crop. It cannot hallucinate
    detail and does not touch the locked product, which is restored afterwards.
    """
    from scipy import ndimage, sparse
    from scipy.sparse.linalg import spsolve
    selected=np.asarray(permission)>0
    if not selected.any():return source.copy()
    ys,xs=np.where(selected);x0,x1=max(0,xs.min()-1),min(source.width,xs.max()+2);y0,y1=max(0,ys.min()-1),min(source.height,ys.max()+2)
    box=(x0,y0,x1,y1);native=(x1-x0,y1-y0)
    scale=min(1,384/max(native));size=tuple(max(1,round(v*scale)) for v in native)
    s=np.array(source.crop(box).resize(size,Image.Resampling.BILINEAR),dtype=np.float64)
    g=np.array(generated.crop(box).resize(size,Image.Resampling.BILINEAR),dtype=np.float64)
    m=np.array(permission.crop(box).resize(size,Image.Resampling.NEAREST))>0
    inner=ndimage.binary_erosion(m,structure=ndimage.generate_binary_structure(2,1),border_value=0)
    boundary=m & ~inner;delta=g-s;correction=np.zeros_like(delta);correction[boundary]=delta[boundary]
    yy,xx=np.where(inner);count=len(yy)
    if count:
        index=np.full(m.shape,-1,dtype=np.int32);index[inner]=np.arange(count)
        rows=[np.arange(count)];cols=[np.arange(count)];data=[np.full(count,4.)];rhs=np.zeros((count,3))
        for dy,dx in [(0,1),(0,-1),(1,0),(-1,0)]:
            ny,nx=yy+dy,xx+dx;j=index[ny,nx];inside=j>=0
            rows.append(np.arange(count)[inside]);cols.append(j[inside]);data.append(np.full(inside.sum(),-1.))
            rhs[~inside]+=correction[ny[~inside],nx[~inside]]
        matrix=sparse.coo_matrix((np.concatenate(data),(np.concatenate(rows),np.concatenate(cols))),shape=(count,count)).tocsc()
        correction[yy,xx]=spsolve(matrix,rhs)
    full_correction=np.stack([np.array(Image.fromarray(correction[:,:,c].astype(np.float32)).resize(native,Image.Resampling.BILINEAR)) for c in range(3)],axis=2)
    original=np.array(source.crop(box),dtype=np.float32);candidate=np.array(generated.crop(box),dtype=np.float32)
    alpha=np.array(permission.crop(box),dtype=np.float32)/255
    # A short inward transition removes the last raster step without expanding the mask.
    binary=alpha>0;distance=ndimage.distance_transform_edt(np.pad(binary,1))[1:-1,1:-1]
    alpha*=np.minimum(1,distance/2)
    blended=np.rint(np.clip(original+(candidate-full_correction-original)*alpha[:,:,None],0,255)).astype(np.uint8)
    result=source.copy();result.paste(Image.fromarray(blended),(x0,y0));return result

def restore_product(source, background, product_layer, foreground, permission, clean_edges=False, generated_edge=None):
    """Blend a product into a locally repaired scene while protecting its interior.

    The cutout core stays pixel-locked. A subpixel alpha transition and a faint,
    clipped contact shadow soften only the perimeter, so a hard raster edge does
    not read as a sticker. The original foreground (hair strands or fingers) is
    restored above the product last.
    """
    from scipy import ndimage
    s=np.array(source,dtype=np.float32);b=np.array(background,dtype=np.float32);p=np.array(product_layer,dtype=np.float32)
    alpha=p[:,:,3]/255;f=np.array(foreground,dtype=np.float32)/255;allowed=np.array(permission)>0
    binary=alpha>.5
    distance=ndimage.distance_transform_edt(np.pad(binary,1))[1:-1,1:-1]
    core=(alpha>=.999)&(distance>=2.0)
    # Work on the alpha only; the already decontaminated product RGB and its
    # silhouette remain the source of truth. A fractional-pixel transition
    # removes stair steps without blurring the product's texture or details.
    soft_alpha=np.asarray(Image.fromarray(np.rint(alpha*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(.55)),dtype=np.float32)/255
    soft_alpha=np.minimum(soft_alpha,np.where(allowed,1,0))
    # A low-opacity shadow follows the contact edge and stays inside the user's
    # allowed edit region. It is deliberately subtle to avoid a dark halo.
    shifted=np.zeros_like(alpha);shifted[1:,1:]=alpha[:-1,:-1]
    shadow=np.maximum(ndimage.gaussian_filter(shifted,1.1)-alpha,0)*.12
    shadow=np.minimum(shadow,np.where(allowed,1,0))
    b*=1-shadow[:,:,None]
    b=b*(1-soft_alpha[:,:,None])+p[:,:,:3]*soft_alpha[:,:,None]
    integrated=np.zeros(alpha.shape,dtype=bool)
    if generated_edge is not None:
        g=np.asarray(generated_edge,dtype=np.float32)
        if g.shape!=s.shape:raise ValueError('商品边缘融合图与原图尺寸不匹配。')
        outside_distance=ndimage.distance_transform_edt(~binary)
        inner_weight=np.where(binary,np.clip((4-distance)/4,0,1)*.24,0)
        outer_weight=np.where(~binary,np.clip((3-outside_distance)/3,0,1)*.20,0)
        edge_weight=np.maximum(inner_weight,outer_weight)*allowed*(f<.5)
        b=b*(1-edge_weight[:,:,None])+g*edge_weight[:,:,None]
        integrated=edge_weight>.005
    if clean_edges:
        corrected,hand_core,repaired=foreground_matte(source,foreground)
        hand_pixels=np.asarray(corrected,dtype=np.float32)
    else:hand_pixels=s;hand_core=f==1;repaired=np.zeros(f.shape,dtype=bool)
    b=b*(1-f[:,:,None])+hand_pixels*f[:,:,None]
    locked_core=core&(f==0)&allowed
    b[locked_core]=p[:,:,:3][locked_core]
    b=np.rint(np.clip(b,0,255)).astype(np.uint8);b[~allowed]=s[~allowed].astype(np.uint8)
    core=locked_core
    hand=hand_core&allowed
    edge_adjusted=((alpha>0)&(np.abs(soft_alpha-alpha)>.005))|(shadow>.005)
    metrics=dict(productProtectedPixels=int(core.sum()),productMaxPixelDifference=int(np.abs(b[core].astype(np.int16)-p[:,:,:3][core].astype(np.int16)).max()) if core.any() else None,productEdgeAdjustedPixels=int((edge_adjusted&allowed).sum()),generatedEdgeIntegratedPixels=int(integrated.sum()),foregroundProtectedPixels=int(hand.sum()),foregroundMaxPixelDifference=int(np.abs(b[hand].astype(np.int16)-s[hand].astype(np.int16)).max()) if hand.any() else None)
    if clean_edges:metrics['foregroundEdgeRepairedPixels']=int((repaired&allowed).sum())
    return Image.fromarray(b),metrics

def finalize(root):
    source = read_image(root/'source.png')
    candidate = read_image(root/'candidate.png')
    mask = read_image(root/'mask.png','L')
    if source.size != candidate.size:
        raise ValueError('ComfyUI 返回了不匹配的图片尺寸。')
    meta=json.loads((root/'meta.json').read_text(encoding='utf-8')) if (root/'meta.json').exists() else {}
    metrics={"productToneApplied":bool(meta.get("productTone") and any(meta["productTone"].get(k,1)!=1 for k in ("saturation","contrast"))),"productTone":meta.get("productTone")}
    if meta.get('preserveProduct'):
        raw=read_image(root/'raw-crop.png');c=meta['crop']
        if raw.size!=(c['width'],c['height']):raise ValueError('局部修复图的尺寸不匹配。')
        generated=source.copy();generated.paste(raw,(c['x'],c['y']))
        background_mask=read_image(root/'background-mask.png','L') if (root/'background-mask.png').exists() else mask
        background=seamless_background(source,generated,background_mask)
        if (root/'background-guard.png').exists():
            # Vision explicitly identified these as plain background, not hands.
            # Conservative fill prevents the generator from inventing objects there.
            _,core,_=foreground_matte(source,read_image(root/'foreground.png','L'))
            repair_permission=background_mask if meta.get('backgroundOnlyGeneration') else mask
            clean=clean_placement_background(source,repair_permission,core)
            guard=read_image(root/'background-guard.png','L')
            guard=Image.fromarray(np.minimum(np.array(guard),np.array(repair_permission)))
            background=Image.composite(clean,background,guard)
        if (root/'background-mask.png').exists():
            # Measure the completed background, after every background operation.
            bg_delta=np.max(np.abs(np.array(background).astype(np.int16)-np.array(source).astype(np.int16)),axis=2)
            untouched=np.array(background_mask)==0
            metrics['maxBackgroundChangeOutsideOldObject']=int(bg_delta[untouched].max()) if untouched.any() else 0
        background.save(root/'blended-background.png')
        candidate,product_metrics=restore_product(source,background,read_image(root/'product-layer.png','RGBA'),read_image(root/'foreground.png','L'),mask,clean_edges=meta.get('gripEdgeCleanup',False),generated_edge=candidate if meta.get('generatedEdgeIntegration') else None)
        metrics.update(product_metrics)
    a,b,m = np.array(source),np.array(candidate),np.array(mask)
    # ComfyUI already feather-composited the crop. Do not apply alpha twice.
    b[m==0] = a[m==0]
    Image.fromarray(b).save(root/'result.png')
    difference = np.max(np.abs(a.astype(np.int16)-b.astype(np.int16)),axis=2)
    outside = difference[m==0]
    record = dict(dimensions=list(source.size), changedPixels=int((difference>0).sum()),changedPercent=round(float((difference>0).mean())*100,2),maxChangeOutsideMask=int(outside.max()) if outside.size else 0,**metrics)
    (root/'verification.json').write_text(json.dumps(record),encoding='utf-8')
    return record

if __name__ == '__main__':
    try:
        result = {'prepare':prepare,'finalize':finalize}[sys.argv[1]](Path(sys.argv[2]))
        print(json.dumps(result,ensure_ascii=False),flush=True)
    except Exception as exc:
        print(str(exc),file=sys.stderr,flush=True)
        sys.exit(1)
