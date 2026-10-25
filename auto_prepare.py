"""Geometry-based preprocessing of a vision plan; never invents a plan from colors.

The model/locally reviewed recipe supplies contours. Antialiasing, edit-permission
padding and pixel-preserving compositing are deterministic. No image/model API is
called from Python. Missing/uncertain vision results do not fall back to a demo.
"""
import sys
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import numpy as np
from scipy import ndimage
sys.path.insert(0,str(Path(__file__).resolve().parent))
from image_pipeline import read_image, clean_placement_background, foreground_matte, decontaminate_cutout, resize_rgba, rotate_rgba
from segmentation import refine_opaque_product, SegmentationError, MIN_AREA_RATIO, MAX_AREA_RATIO

class OldObjectSegmentationError(SegmentationError):
    """A source-scene old-object boundary failure, distinct from product cutout."""
    pass

def signature(image):
    return dict(ratio=image.width/image.height,pixels=np.array(image.convert('RGB').resize((48,64),Image.Resampling.LANCZOS)).tolist())

def matches(a,b):
    if abs(a['ratio']-b['ratio'])>.003:return False
    delta=np.abs(np.array(a['pixels'],dtype=float)-np.array(b['pixels'],dtype=float))
    return delta.shape==(64,48,3) and delta.mean()<1.7 and np.percentile(delta,99)<14

def inspect(root,presets):
    normalization=dict(policy='auto-working-copy-v1',comparisonBasis='normalized-source',maxInputPixels=64_000_000,maxInputBytes=20*1024*1024,maxLongEdge=1600)
    images={}
    for role in ('source','product'):
        metadata={}
        images[role]=read_image(root/(role+'.upload'),'RGBA' if role=='product' else 'RGB',max_pixels=64_000_000,max_longest=1600,max_bytes=20*1024*1024,metadata=metadata)
        images[role].save(root/(role+'-normalized.png'))
        normalization[role]=metadata
    (root/'normalization.json').write_text(json.dumps(normalization),encoding='utf-8')
    sig={role:signature(im) for role,im in images.items()}
    for role,image in images.items():
        preview=Image.new('RGBA',image.size,'white');preview.alpha_composite(image.convert('RGBA'))
        preview=preview.convert('RGB');preview.thumbnail((1280,1280),Image.Resampling.LANCZOS)
        preview.save(root/(role+'-vision.jpg'),quality=92)
    if presets.exists():
        for file in sorted(presets.glob('*.json'))[:30]:
            recipe=json.loads(file.read_text(encoding='utf-8'))
            if all(matches(sig[k],recipe['signatures'][k]) for k in images):return dict(recipe=recipe['plan'],normalization=normalization)
    return dict(recipe=None,normalization=normalization)

def polygons(size,contours,antialias=True):
    # Rasterize only the bounding crop to keep 16 MP inputs memory bounded.
    w,h=size;out=Image.new('L',size);scale=3 if antialias else 1
    if not contours:return out
    points=[p for polygon in contours for p in polygon]
    x0=max(0,int(min(p[0] for p in points)*w)-2);y0=max(0,int(min(p[1] for p in points)*h)-2)
    x1=min(w,int(max(p[0] for p in points)*w)+3);y1=min(h,int(max(p[1] for p in points)*h)+3)
    local=Image.new('L',((x1-x0)*scale,(y1-y0)*scale));draw=ImageDraw.Draw(local)
    for polygon in contours:draw.polygon([((x*w-x0)*scale,(y*h-y0)*scale) for x,y in polygon],fill=255)
    if scale>1:local=local.resize((x1-x0,y1-y0),Image.Resampling.LANCZOS)
    out.paste(local,(x0,y0));return out

def principal_axis(mask):
    """Estimate a filled silhouette's major axis in image coordinates."""
    binary=np.asarray(mask)>127
    y,x=np.where(binary)
    if len(x)<64:return None
    points=np.column_stack((x,y)).astype(np.float64)
    covariance=np.cov(points,rowvar=False)
    values,vectors=np.linalg.eigh(covariance)
    minor,major=float(values[0]),float(values[-1])
    if minor<=0 or major/minor<1.12:return None
    vector=vectors[:,-1]
    angle=math.degrees(math.atan2(float(vector[1]),float(vector[0])))
    angle=(angle+90)%180-90
    return dict(angleDegrees=angle,elongation=math.sqrt(major/minor),pixels=len(x))

def axis_rotation(product_axis,target_axis):
    if not product_axis or not target_axis:return None
    # Rotate the product axis onto the target axis: target minus product.
    delta=(target_axis['angleDegrees']-product_axis['angleDegrees']+90)%180-90
    # PCA axes are undirected. The sign is immaterial for a perfect 90-degree
    # tie, so choose the positive counter-clockwise turn deterministically.
    if abs(abs(delta)-90)<1e-6:delta=90
    return delta

def edit_permission(old_mask,product_alpha,protected,padding):
    """Fully erase the old silhouette, feather only beyond it, not through it."""
    region=(np.asarray(old_mask)>8)|(np.asarray(product_alpha)>8)
    distance=ndimage.distance_transform_edt(~region)
    # Full opacity through the silhouette and padding; only outer 1.5 px fades.
    a=np.rint(np.clip((padding+1.5-distance)/1.5,0,1)*255).astype(np.uint8)
    a[np.asarray(protected)>8]=0
    return Image.fromarray(a)

def refine_old_object(source, old_outline, protected, padding):
    """Use the existing permission as a prompt, then retain source coordinates."""
    rgba=source.convert('RGBA')
    original=np.array(rgba,copy=True)
    coarse=edit_permission(old_outline,Image.new('L',source.size),protected,padding)
    try:
        refined,metadata=refine_opaque_product(rgba,coarse)
    except SegmentationError as error:
        message='旧发饰精分运行包不可用或校验失败，请检查主机配置后重新分析。' if error.code in ('runtimeUnavailable','runtimeInvalid') else '人物图中的旧发饰边界无法可靠确定，已停止自动继续，请确认旧物清除范围或补充清晰人物图。'
        raise OldObjectSegmentationError(error.code,message) from error
    except Exception as error:
        raise OldObjectSegmentationError('inferenceFailed','人物图中的旧发饰边界精分异常，已停止自动继续，请确认旧物清除范围或补充清晰人物图。') from error
    if not isinstance(refined,Image.Image) or refined.mode!='RGBA' or refined.size!=rgba.size:
        raise OldObjectSegmentationError('invalidOutput','旧发饰精分未保持源图格式和完整坐标，已停止自动继续。')
    result=np.array(refined)
    if not np.array_equal(original[:,:,:3],result[:,:,:3]) or (result[:,:,3]>original[:,:,3]).any():
        raise OldObjectSegmentationError('invalidOutput','旧发饰精分未保持源图像素和坐标，已停止自动继续。')
    raw_alpha=np.array(refined.getchannel('A'))
    # The old-object region is a permission mask, not a visible product edge.
    # Keep it binary so a soft antialias fringe cannot leave old accessory pixels.
    alpha=np.where(raw_alpha>127,255,0).astype(np.uint8)
    alpha[np.asarray(protected)>8]=0
    coarse_area=int((np.asarray(coarse)>127).sum());raw_area=int((raw_alpha>127).sum());area=int((alpha>127).sum())
    if not area or not coarse_area:
        raise OldObjectSegmentationError('emptyMask','旧发饰精分没有保留有效清除范围，请补充清晰人物图或确认旧物范围。')
    ratio=area/coarse_area
    if not MIN_AREA_RATIO<=ratio<=MAX_AREA_RATIO:
        raise OldObjectSegmentationError('suspiciousArea','旧发饰精分与原自动范围差异过大，请确认人物图中的旧物清除范围。')
    details=dict(metadata,enabled=True,adapterPolicy=metadata.get('policy'),policy='old-object-mobile-sam-permission-box-p1-v1',role='source-old-object',coordinateFrame='full-normalized-source',sourceSize=list(source.size),coordinateOffset=[0,0],cropApplied=False,promptMask='original oldObject permission with original padding and protection clipping',paddingPixels=padding,coarseOutlineAreaPixels=int((np.asarray(old_outline)>127).sum()),coarseAreaPixels=coarse_area,coarseNonzeroPixels=int((np.asarray(coarse)>0).sum()),rawRefinedAreaPixels=raw_area,refinedAreaPixels=area,protectedClippedPixels=raw_area-area,areaRatio=ratio,rawAreaRatio=raw_area/coarse_area,areaGuard=dict(minimum=MIN_AREA_RATIO,maximum=MAX_AREA_RATIO,meaning='anomaly stop only; not visual acceptance'),rgbUnchanged=True,alphaDoesNotExceedSource=True,refinedBBox=list(Image.fromarray(alpha).getbbox()),visualAcceptance='pending independent review')
    return Image.fromarray(alpha),details,coarse

def refine_foreground(source, foreground, old_mask):
    """Refine a model-supplied hand region only when object/hand colors separate.

    The model still supplies the region. No skin-tone constants, new hand pixels
    or product pixels are synthesized. Ambiguous/similar colors keep the mask.
    """
    f=np.array(foreground);old=np.array(old_mask)>128
    if not old.any() or not (f>128).any():return foreground
    radius=max(3,min(18,round(max(source.size)*.012)))
    yy,xx=np.where(old|(f>0))
    box=(max(0,int(xx.min())-radius-2),max(0,int(yy.min())-radius-2),
         min(source.width,int(xx.max())+radius+3),min(source.height,int(yy.max())+radius+3))
    x0,y0,x1,y1=box;local=f[y0:y1,x0:x1];o=old[y0:y1,x0:x1]
    rgb=np.array(source.crop(box),dtype=np.float32)
    chroma=rgb/np.maximum(rgb.sum(axis=2,keepdims=True),1)
    hand_distance=ndimage.distance_transform_edt(local<128)
    object_region=o&(hand_distance>4)&(ndimage.distance_transform_edt(o)>2)
    samples=chroma[object_region]
    if len(samples)<40:return foreground
    object_color=np.median(samples,axis=0)
    # Apply only for a dominant chromatic object, not neutral or patterned labels.
    if np.ptp(object_color)<.12:return foreground
    if np.mean(np.linalg.norm(samples-object_color,axis=1)<.08)<.65:return foreground
    object_distance=np.linalg.norm(chroma-object_color,axis=2)
    hand_samples=chroma[(local>200)&(object_distance>.14)]
    if len(hand_samples)<40:return foreground
    hand_color=np.median(hand_samples,axis=0)
    if np.linalg.norm(hand_color-object_color)<.16:return foreground
    hand_color_distance=np.linalg.norm(chroma-hand_color,axis=2)
    search=(hand_distance<=radius)&(ndimage.distance_transform_edt(~o)<=radius)
    # Core stays opaque; a narrow chromatic transition yields antialiased edges.
    hand_weight=np.clip((object_distance-hand_color_distance-.03)/.045,0,1)
    hand_weight*=np.clip((.11-hand_color_distance)/.035,0,1)
    refined=np.rint(hand_weight*255).astype(np.uint8)
    trusted=(local>200)&(hand_weight>.9)
    components,count=ndimage.label((refined>127)&search)
    keep=np.unique(components[trusted]);keep=keep[keep>0]
    if not len(keep):return foreground
    connected=np.isin(components,keep)
    near=ndimage.distance_transform_edt(~connected)<=1.5
    refined[~near]=0
    area=np.count_nonzero(refined[search]>127);before=np.count_nonzero(local[search]>127)
    if area<before*.25 or area>before*2.5:return foreground
    result=local.copy();result[search]=refined[search]
    f[y0:y1,x0:x1]=result
    return Image.fromarray(f)

def cutout_detail_proofs(root, white_cutout):
    """Uniform proof-only crops; no defect coordinates or product edits."""
    w,h=white_cutout.size
    # Match the uniform trial: extend each half by 4% of the full axis.
    # Adjacent crops consequently share about 8%, subject to pixel rounding.
    cx,cy=(w+1)//2,(h+1)//2;px,py=round(w*.04),round(h*.04)
    left,right=min(w-1,max(0,cx-px)),min(w,max(1,cx+px))
    top,bottom=min(h-1,max(0,cy-py)),min(h,max(1,cy+py))
    boxes=[(0,0,right,bottom),(left,0,w,bottom),(0,top,right,h),(left,top,w,h)]
    frames=[]
    for index,box in enumerate(boxes,1):
        crop=white_cutout.crop(box);scale=1000/max(crop.size)
        size=tuple(max(1,round(side*scale)) for side in crop.size)
        file=f'cutout-detail-{index}.jpg'
        crop.resize(size,Image.Resampling.LANCZOS).save(root/file,quality=95)
        frames.append(dict(file=file,box=list(box),reviewSize=list(size)))
    return dict(policy='white-visible-cutout-uniform-quadrants-v1',coordinateFrame='cutout-native',nativeSize=[w,h],order=['topLeft','topRight','bottomLeft','bottomRight'],overlapPaddingFraction=.04,sharedOverlapFraction=.08,longEdge=1000,jpegQuality=95,resample='Pillow LANCZOS',changesProductAsset=False,frames=frames)

def prepare(root, clip_to_outline=False):
    plan=json.loads((root/'plan.json').read_text(encoding='utf-8'))
    normalization_path=root/'normalization.json'
    normalization=json.loads(normalization_path.read_text(encoding='utf-8')) if normalization_path.exists() else dict(policy='legacy-strict-upload',comparisonBasis='normalized-source')
    images={}
    for role in ('source','product'):
        canonical=root/(role+'-normalized.png');metadata={}
        # Legacy reviewed recipes may call prepare directly; retain their strict limit.
        images[role]=read_image(canonical if canonical.exists() else root/(role+'.upload'),'RGBA' if role=='product' else 'RGB',metadata=metadata)
        if not canonical.exists():images[role].save(canonical)
        if role not in normalization:normalization[role]=metadata
    if not normalization_path.exists():normalization_path.write_text(json.dumps(normalization),encoding='utf-8')
    source,product=images['source'],images['product']
    alpha=polygons(product.size,[plan['productOutline']])
    segmentation=dict(enabled=False,reason='legacy-plan-without-opaque-assessment')
    if (plan.get('assessment') or {}).get('material')=='opaque':
        # The coarse outline is only a prompt. Never pre-clip original alpha:
        # segmentation may recover a valid product edge outside that outline.
        product,segmentation=refine_opaque_product(product,alpha)
        segmentation['enabled']=True
    else:
        # Legacy reviewed geometry remains usable for deterministic fixtures.
        # Fresh API plans must pass the capability gate before reaching prepare.
        product.putalpha(Image.fromarray(np.minimum(np.asarray(alpha),np.asarray(product.getchannel('A')))))
    product_holes=polygons(product.size,plan.get('productHoles',[]))
    if product_holes.getbbox() is not None:
        original_alpha=np.asarray(product.getchannel('A'))
        hole_pixels=np.asarray(product_holes)
        cleaned_alpha=np.minimum(original_alpha,255-hole_pixels)
        segmentation['excludedProductBackgroundPixels']=int(np.count_nonzero((original_alpha>0)&(hole_pixels>127)))
        segmentation['productHoleCount']=len(plan.get('productHoles',[]))
        product.putalpha(Image.fromarray(cleaned_alpha))
    else:
        segmentation['excludedProductBackgroundPixels']=0
        segmentation['productHoleCount']=0
    if clip_to_outline and (plan.get('assessment') or {}).get('material')=='opaque':
        # A bounded recovery pass for independently confirmed hair/background
        # leaks: keep the SAM matte only inside the model-traced product contour.
        # The normal preparation and cutout reviews must both pass afterwards.
        outline=np.asarray(polygons(product.size,[plan['productOutline']]))
        original_alpha=np.asarray(product.getchannel('A'))
        clipped_alpha=np.minimum(original_alpha,outline)
        segmentation['outlineRecovery']=dict(policy='review-triggered-sam-alpha-clipped-to-plan-outline-v1',
            removedPixels=int(np.count_nonzero((original_alpha>127)&(clipped_alpha<128))),
            antialias='3x polygon rasterization with Lanczos downsample',
            requiresIndependentRereview=True)
        product.putalpha(Image.fromarray(clipped_alpha))
    bbox=product.getbbox()
    if bbox is None:raise ValueError('没有识别到商品轮廓。')
    x0,y0,x1,y1=bbox;bbox=(max(0,x0-1),max(0,y0-1),min(product.width,x1+1),min(product.height,y1+1))
    segmentation['cutoutBBoxInNormalizedProduct']=list(bbox)
    segmentation['cutoutCropOffset']=[bbox[0],bbox[1]]
    segmentation['cutoutSize']=[bbox[2]-bbox[0],bbox[3]-bbox[1]]
    segmentation['downstreamRgbPolicy']='narrow edge decontamination may adjust boundary RGB; opaque interior is retained'
    product=product.crop(bbox)
    product=decontaminate_cutout(product)
    w,h=source.size;p=plan['placement'];plan_rotation=p.get('rotationDegrees',0);rotation=plan_rotation
    flip_horizontal=p.get('flipHorizontal',False)
    if not isinstance(flip_horizontal,bool):raise ValueError('商品镜像方向无效，请重新分析。')
    if flip_horizontal:
        product=ImageOps.mirror(product)
        alpha=ImageOps.mirror(alpha)
    product_axis=principal_axis(alpha)
    target_axis=principal_axis(polygons(source.size,plan.get('oldObject',[])))
    aligned_rotation=axis_rotation(product_axis,target_axis)
    if aligned_rotation is not None and abs(aligned_rotation)>30:
        plan_residual=abs((product_axis['angleDegrees']+plan_rotation-target_axis['angleDegrees']+90)%180-90)
        if plan_residual>max(20,abs(aligned_rotation)*.35):rotation=aligned_rotation
    if isinstance(rotation,bool) or not isinstance(rotation,(int,float)) or not math.isfinite(rotation) or abs(rotation)>90:
        raise ValueError('商品旋转角度超出安全范围，请重新分析或手动微调。')
    if abs(rotation)>.01:
        product=rotate_rgba(product,rotation,resample=Image.Resampling.BICUBIC,expand=True)
        rotated_box=product.getchannel('A').getbbox()
        if rotated_box is None:raise ValueError('旋转后的商品轮廓为空，请重新确认商品。')
        product=decontaminate_cutout(product.crop(rotated_box))
    height=p['height']*h;width=height*product.width/product.height
    x=p['centerX']*w-width/2;y=p['bottomY']*h-height
    if x<0 or y<0 or x+width>w or y+height>h:raise ValueError('建议的商品位置超出画面，需要手动确认。')
    placement=dict(x=x,y=y,width=width,height=height,flipHorizontal=flip_horizontal)
    layer=Image.new('RGBA',source.size);layer.alpha_composite(resize_rgba(product,(max(1,round(width)),max(1,round(height))),Image.Resampling.LANCZOS),(round(x),round(y)))
    old_outline=polygons(source.size,plan['oldObject']);protected=polygons(source.size,plan['protect'])
    if np.count_nonzero((np.array(layer.getchannel('A'))>32)&(np.array(protected)>8))>0:raise ValueError('建议位置与人物保护区冲突，请重新分析或手动调整。')
    padding=max(3,round(max(source.size)*.004))
    old,old_object_segmentation,old_coarse=refine_old_object(source,old_outline,protected,padding)
    foreground=refine_foreground(source,polygons(source.size,plan['foreground']),old)
    permission=edit_permission(old,layer.getchannel('A'),protected,padding)
    if (np.array(permission)>0).mean()>.4:raise ValueError('自动选区过大，请缩小目标范围。')
    _,core,_=foreground_matte(source,foreground)
    background=clean_placement_background(source,permission,core)
    # Canvas masks use white RGB with alpha, rather than an opaque black rectangle.
    guard=polygons(source.size,plan.get('backgroundOnly',[]))
    guard=Image.fromarray(np.minimum(np.array(guard),np.array(permission)))
    background_mask=edit_permission(old,Image.new('L',source.size),protected,padding)
    for name,mask in [('permission',permission),('foreground',foreground),('backgroundGuard',guard),('backgroundMask',background_mask)]:
        rgba=Image.new('RGBA',source.size,'white');rgba.putalpha(mask);rgba.save(root/(name+'.png'))
    product.save(root/'cutout.png');background.save(root/'background.png')
    # Quality review sees only visible cutout pixels, not hidden RGB under alpha.
    review_product=Image.new('RGBA',product.size,'white');review_product.alpha_composite(product)
    white_cutout=review_product.convert('RGB')
    # A small native crop hid visible hair in development review. Give every
    # cutout the same review scale, without altering the actual product layer.
    review_scale=1600/max(product.size)
    review_size=tuple(max(1,round(side*review_scale)) for side in product.size)
    review_product=white_cutout.resize(review_size,Image.Resampling.LANCZOS)
    review_product.save(root/'review-product.jpg',quality=95)
    preparation_proofs=dict(policy='white-visible-cutout-long-edge-1600-v1',cutoutNativeSize=list(product.size),cutoutReviewSize=list(review_size),resample='Pillow LANCZOS',changesProductAsset=False)
    preparation_proofs['cutoutDetails']=cutout_detail_proofs(root,white_cutout)
    review_scene=Image.alpha_composite(background.convert('RGBA'),layer).convert('RGB')
    review_scene=Image.composite(source,review_scene,foreground)
    before=source.copy();before.thumbnail((600,800),Image.Resampling.LANCZOS)
    review_scene.thumbnail((600,800),Image.Resampling.LANCZOS)
    board=Image.new('RGB',(before.width+16+review_scene.width,max(before.height,review_scene.height)+24),'white')
    board.paste(before,(0,24));board.paste(review_scene,(before.width+16,24))
    proof_labels=ImageDraw.Draw(board);proof_labels.text((6,5),'Original scene',fill='black');proof_labels.text((before.width+22,5),'Placement preview',fill='black')
    board.save(root/'placement-review.jpg',quality=93)
    old.save(root/'old-object.png');old_coarse.save(root/'old-object-coarse.png')
    return dict(placement=placement,sourceSize=list(source.size),coverage=round(float((np.array(permission)>0).mean()),4),confidence=plan['confidence'],normalization=normalization,segmentation=segmentation,oldObjectSegmentation=old_object_segmentation,preparationProofs=preparation_proofs,orientationAdaptation=dict(policy='exif-upright-then-mirror-and-signed-axis-alignment-v3',flipHorizontal=flip_horizontal,rotationDegrees=rotation,planRotationDegrees=plan_rotation,axisAlignmentRotationDegrees=aligned_rotation,axisOverride=rotation!=plan_rotation,targetAxis=target_axis,productAxis=product_axis,rotatedProductSize=list(product.size),keepsAspectRatio=True))

if __name__=='__main__':
    try:
        mode=sys.argv[1];root=Path(sys.argv[2]);result=inspect(root,Path(sys.argv[3])) if mode=='inspect' else prepare(root,clip_to_outline=mode=='prepare-outline-recovery')
        print(json.dumps(result,ensure_ascii=True))
    except OldObjectSegmentationError as error:
        print('OLD_OBJECT_SEGMENTATION_'+error.code+': '+str(error),file=sys.stderr);sys.exit(1)
    except SegmentationError as error:
        print('SEGMENTATION_'+error.code+': '+str(error),file=sys.stderr);sys.exit(1)
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
