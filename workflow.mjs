export const MODELS={unet:'flux-2-klein-4b-Q4_K_M.gguf',clip:'Qwen3-4B-Q4_K_M.gguf',vae:'flux2-vae.safetensors'};
export const NODE_STAGES={'1':'加载本地模型','2':'加载文字编码器','3':'加载图像编码器','7':'读取人物与握持姿势','11':'读取商品参考','12':'理解替换要求','20':'生成局部换物','21':'解码生成图片','24':'合回原图','25':'保存生成图片'};
export function buildWorkflow(meta,files,instructions,seed,correctionPrompt=''){
  const {crop,generation,product}=meta,g={};const n=(id,class_type,inputs)=>g[id]={class_type,inputs};
  n('1','UnetLoaderGGUF',{unet_name:MODELS.unet});
  n('2','CLIPLoaderGGUF',{clip_name:MODELS.clip,type:'flux2'});
  n('3','VAELoader',{vae_name:MODELS.vae});
  n('4','LoadImage',{image:files.source});
  n('5','ImageCrop',{image:['4',0],...crop});
  n('6','ImageScale',{image:['5',0],upscale_method:'lanczos',...generation,crop:'disabled'});
  n('7','VAEEncode',{pixels:['6',0],vae:['3',0]});
  n('8','LoadImage',{image:files.product});
  n('10','ImageScale',{image:['8',0],upscale_method:'lanczos',width:product.width,height:product.height,crop:'disabled'});
  n('11','VAEEncode',{pixels:['10',0],vae:['3',0]});
  n('12','CLIPTextEncode',{clip:['2',0],text:'Edit image 1. Replace the held object with the product from image 2. Match its shape, cap, label, logo and colors. Do not copy the hand or background of image 2. Remove the old object and its handle completely. Match perspective, indoor light and shadows. Fingers naturally wrap around the new product; keep the supporting hand and natural grip. Preserve the person, face, clothing, pose and surrounding scene. Keep the camera viewpoint. User requirements: '+instructions});
  n('13','ReferenceLatent',{conditioning:['12',0],latent:['7',0]});
  n('14','ReferenceLatent',{conditioning:['13',0],latent:['11',0]});
  n('15','BasicGuider',{model:['1',0],conditioning:['14',0]});
  n('16','RandomNoise',{noise_seed:seed});
  n('17','KSamplerSelect',{sampler_name:'euler'});
  n('18','Flux2Scheduler',{steps:4,...generation});
  n('19','EmptyFlux2LatentImage',{...generation,batch_size:1});
  n('20','SamplerCustomAdvanced',{noise:['16',0],guider:['15',0],sampler:['17',0],sigmas:['18',0],latent_image:['19',0]});
  n('21','VAEDecodeTiled',{samples:['20',0],vae:['3',0],tile_size:256,overlap:64,temporal_size:64,temporal_overlap:8});
  n('22','ImageScale',{image:['21',0],upscale_method:'lanczos',width:crop.width,height:crop.height,crop:'disabled'});
  n('23','LoadImageMask',{image:files.mask,channel:'red'});
  n('24','ImageCompositeMasked',{destination:['4',0],source:['22',0],x:crop.x,y:crop.y,resize_source:false,mask:['23',0]});
  n('25','SaveImage',{images:['24',0],filename_prefix:'swap_studio/'+files.id+'/result'});
  if(meta.placement){
    if(!files.guide)throw new Error('缺少商品摆放参考图。');
    n('26','LoadImage',{image:files.guide});
    n('27','ImageCrop',{image:['26',0],...crop});
    n('28','ImageScale',{image:['27',0],upscale_method:'lanczos',...generation,crop:'disabled'});
    g['7'].inputs.pixels=['28',0];
    n('29','VAEEncode',{pixels:['6',0],vae:['3',0]});
    n('30','ReferenceLatent',{conditioning:['14',0],latent:['29',0]});
    g['15'].inputs.conditioning=['30',0];
    const p=meta.placement,rx=Math.round((p.x-crop.x)/crop.width*100),ry=Math.round((p.y-crop.y)/crop.height*100),rw=Math.round(p.width/crop.width*100),rh=Math.round(p.height/crop.height*100);
    g['12'].inputs.text=`Edit image 1, a placement mockup. The new product is already positioned at the intended size and in-plane angle. Keep its position, long-axis direction and proportional size exactly as shown: left ${rx}%, top ${ry}%, width ${rw}%, height ${rh}% of image 1. Do not enlarge it to fill the edit region. Image 2 shows the upright, orientation-corrected product appearance. Image 3 is the ORIGINAL scene: use it to restore fingers or hair strands in front of the product and preserve the person's head direction. Remove the OLD held object and its handle completely, including fragments around the new product. Blend product edges, local lighting, mild head-plane perspective and contact shadows naturally. Preserve the new product's visible shape, colors, pattern and details; do not invent hidden structure or a new camera view. Preserve all other scene details from image 3. User requirements: ${instructions}`;
  }
  if(meta.preserveProduct){
    if(!meta.placement)throw new Error('商品保真需要先指定商品位置。');
    n('32','SaveImage',{images:['22',0],filename_prefix:'swap_studio/'+files.id+'/raw-edit'});
    g['12'].inputs.text=`Image 1 is the intended product placement. The product's orientation, size and attachment point have already been adapted to the person's pose; preserve its overall silhouette, proportions, pattern, colors and position. Image 2 is the upright product reference. Image 3 is ONLY the original-scene reference for the person's hair, lighting and background. Remove the obsolete object completely. Make a restrained Photoshop-style local harmonization pass: match warm light and contact shadow, and adapt only a very narrow 2-4 pixel contour zone so the product sits naturally against the hair. Where a few real hair strands should cross the product edge, restore them from Image 3; do not invent broad hair patches. Keep the product's main surface and identifying details faithful to Image 2; do not redraw the whole item or change its design. Do not add outlines, halos, extra folds, clips, fingers or protrusions. Preserve the person's identity, hairstyle, pose, camera view, clothes and every scene detail outside the selected edit. The final compositor will restore the exact product interior. User requirements: ${instructions}`;
  }
  if(meta.backgroundOnlyGeneration){
    if(!meta.preserveProduct||!meta.placement)throw new Error('背景修复模式需要商品保真和已确认位置。');
    // The product reference must not condition a clean plate: it can otherwise
    // hallucinate extra folds outside the alpha restored by the final compositor.
    g['15'].inputs.conditioning=['13',0];
    const basePrompt='Complete the softly filled area in this photograph with ONLY fine natural hair strands. Follow the surrounding hair direction, color, density and focus continuously across the filled area. This is entirely unadorned natural hair with uninterrupted strand texture. Keep existing exposed skin and clothing exactly where already visible. Preserve the original person, anatomy, camera viewpoint, lighting and all surrounding scene details. Produce a seamless natural photographic repair of the hair texture. Leave the scene unadorned and add no objects.';
    g['12'].inputs.text=basePrompt+(correctionPrompt?` Human review correction priority: ${correctionPrompt}`:'');
    for(const id of ['5','6','8','10','11','14','29','30'])delete g[id];
  }
  return g;
}


