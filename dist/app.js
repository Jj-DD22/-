import {clamp,normalizedPoint,pixelCrop,selectionRect,MaskHistory} from './mask-model.js';
import {connectGeneration} from './generation.js';
import {connectPlacement} from './placement.js';
import {connectCutout} from './cutout.js';
import {appConfig} from './app-config.js';
import {connectAutomatic} from './automatic.js';
import {connectCloudEdit} from './cloud-edit.js';
const $=id=>document.getElementById(id);
const state={source:null,product:null,originalProduct:null,originalSourceUpload:null,normalization:null,history:new MaskHistory(),foregroundHistory:new MaskHistory(),layer:'edit',active:null,tool:'brush',view:'overlay',show:true,brush:28,feather:2,zoom:1,scale:1,coverage:0,space:false,hover:false,dirty:false,versions:{source:0,product:0}};
const overlay=$('overlay'),viewport=$('viewport'),surface=$('surface');
const rawMask=document.createElement('canvas'),softMask=document.createElement('canvas');
const raw=rawMask.getContext('2d',{willReadFrequently:true}),soft=softMask.getContext('2d',{willReadFrequently:true}),display=overlay.getContext('2d');
const foregroundMask=document.createElement('canvas'),foregroundContext=foregroundMask.getContext('2d',{willReadFrequently:true});
const foregroundPreview=$('foregroundPreview'),foregroundPreviewContext=foregroundPreview.getContext('2d');
const currentHistory=()=>state.layer==='foreground'?state.foregroundHistory:state.history;
let toastTimer,raf=0,dbPromise,demoEpoch=0,cropStart=null,cropEnd=null,cropDragging=false,generationController,placementController,automaticController,cloudController;
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?6500:3500);}
function renderTone(){ $('toneValues').textContent='饱和度 '+$('toneSaturation').value+'% · 对比度 '+$('toneContrast').value+'%';$('placedProductImage').style.filter='saturate('+$('toneSaturation').value+'%) contrast('+$('toneContrast').value+'%)'; }
for(const id of ['toneSaturation','toneContrast'])$(id).oninput=()=>{renderTone();dirty();};
renderTone();
function dirty(){state.dirty=true;$('draftStatus').textContent='有未保存的修改';}
function labelCount(){$('textCount').textContent=`${$('instructions').value.length} / 1500`;}
function schedulePaint(){if(raf)return;raf=requestAnimationFrame(()=>{raf=0;paint();});}
function release(asset){if(asset?.url?.startsWith('blob:'))URL.revokeObjectURL(asset.url);}
async function decode(blob,name){
  if(blob.size>20*1024*1024)throw new Error('图片超过 20 MB，请先缩小文件。');
  if(!['image/png','image/jpeg','image/webp'].includes(blob.type))throw new Error('请使用 JPG、PNG 或 WebP 图片。');
  const url=URL.createObjectURL(blob),image=new Image();image.src=url;
  try{await image.decode();if(image.naturalWidth*image.naturalHeight>64000000)throw new Error('图片超过 6400 万像素，请先缩小尺寸。');}
  catch(error){URL.revokeObjectURL(url);throw new Error(error.message.includes('像素')?error.message:'图片无法读取，请换一张完整的图片。');}
  return {blob,name,image,url,width:image.naturalWidth,height:image.naturalHeight};
}
function generationInputIssue(){
  const large=[['人物图',state.source],['商品图',state.product]].filter(([,asset])=>asset&&asset.width*asset.height>16000000).map(([label])=>label);
  return large.length?`${large.join('、')}超过 1600 万像素，请先点“自动识别与摆放”生成工作副本，或上传长边不超过 1600 的图片。`:'';
}
function validateAutomaticAssets(assets,source,sourceSize){
  const working=assets.source||source;
  if(!working||working.width*working.height>16000000)throw new Error('大图尚未转换为工作副本，请重新自动识别后生成。');
  if(sourceSize&&(!Array.isArray(sourceSize)||sourceSize[0]!==working.width||sourceSize[1]!==working.height))throw new Error('自动方案与人物工作副本尺寸不一致，请重新分析。');
  for(const key of ['mask','foreground','background','backgroundGuard','backgroundMask'])if(assets[key]&&(assets[key].width!==working.width||assets[key].height!==working.height))throw new Error('自动蒙版与人物工作副本尺寸不一致，请重新分析。');
}
function applyAsset(role,asset,{preserveOriginal=false}={}){
  if(!preserveOriginal){
    for(const asset of Object.values(state.autoAssets||{}))release(asset);
    state.autoAssets=null;automaticController?.invalidate();
    if(state.source)$('sourceImage').src=state.source.url;
  }
  const previous=state[role];state[role]=asset;
  if(role==='source'){
    if(!preserveOriginal){state.originalSourceUpload={blob:asset.blob,name:asset.name};state.normalization=null;}
    $('sourceImage').src=asset.url;state.history=new MaskHistory();state.foregroundHistory=new MaskHistory();state.zoom=1;state.active=null;
    const ratio=Math.min(1,1600/Math.max(asset.width,asset.height));
    for(const canvas of [overlay,rawMask,softMask,foregroundMask,foregroundPreview]){canvas.width=Math.max(1,Math.round(asset.width*ratio));canvas.height=Math.max(1,Math.round(asset.height*ratio));}
    $('canvasMeta').textContent=`${asset.width} × ${asset.height}`;fit();
  }else if(!preserveOriginal){
    if(state.originalProduct&&state.originalProduct!==previous)release(state.originalProduct);
    state.originalProduct=asset;
  }
  $(`${role}Thumb`).src=asset.url;$(`${role}Upload`).classList.add('has-image');
  $(`${role}Ready`).textContent='已载入';$(`${role}Meta`).textContent=`${asset.width} × ${asset.height} · ${(asset.blob.size/1024).toFixed(0)} KB`;
  $(`${role}Meta`).title=asset.name;
  if(previous&&previous!==state.originalProduct&&previous!==asset)release(previous);
  updateControls();paint();measure();placementController?.reset();
}
async function upload(role,file){
  if(!file)return;
  demoEpoch++;const version=++state.versions[role];
  try{const asset=await decode(file,file.name);if(version!==state.versions[role]){release(asset);return;}applyAsset(role,asset);dirty();toast(generationInputIssue()||(role==='source'?'人物图已更换，选区已重置。':'商品图已更换。'));}
  catch(error){toast(error.message,true);}
  finally{$(`${role}File`).value='';}
}
async function loadDemo(){
  const epoch=++demoEpoch;
  const sourceVersion=++state.versions.source,productVersion=++state.versions.product;
  $('loadDemo').disabled=true;
  try{
    const assets=await Promise.all(['scene','product'].map(async name=>{const response=await fetch(`./assets/${name}.png`);if(!response.ok)throw new Error('演示素材暂时无法读取，请直接上传图片。');return decode(await response.blob(),`${name}.png`);}));
    if(epoch!==demoEpoch||sourceVersion!==state.versions.source||productVersion!==state.versions.product){assets.forEach(release);return;}
    applyAsset('source',assets[0]);applyAsset('product',assets[1]);
    const points=[[193,281],[244,281],[249,305],[256,318],[285,329],[289,352],[281,371],[262,379],[259,401],[249,423],[226,430],[204,423],[188,417],[186,405],[193,395],[196,381],[191,321]].map(([x,y])=>({x:x/540,y:y/720}));
    state.history.commit({kind:'polygon',points});
    $('canvasMeta').textContent='演示素材 · 示例选区';dirty();paint();measure();placementController?.reset();
  }catch(error){toast(error.message,true);}finally{$('loadDemo').disabled=false;}
}
function fit(){
  if(!state.source){surface.hidden=true;$('canvasEmpty').hidden=false;return;}
  surface.hidden=false;$('canvasEmpty').hidden=true;
  const padding=innerWidth<=620?40:56;
  const base=Math.min((viewport.clientWidth-padding)/state.source.width,(viewport.clientHeight-padding)/state.source.height);
  state.scale=Math.max(.005,base)*state.zoom;
  surface.style.width=`${state.source.width*state.scale}px`;surface.style.height=`${state.source.height*state.scale}px`;
  $('zoomValue').textContent=`${Math.round(state.scale*100)}%`;
  $('zoomOut').disabled=state.zoom<=.5;$('zoomIn').disabled=state.zoom>=5;
  cursorSize();
}
function zoom(factor){state.zoom=clamp(state.zoom*factor,.5,5);fit();}
function drawOperation(ctx,operation){
  const w=rawMask.width,h=rawMask.height;
  if(operation.kind==='clear'){ctx.clearRect(0,0,w,h);return;}
  if(!operation.points?.length)return;
  ctx.save();ctx.globalCompositeOperation=operation.mode==='erase'?'destination-out':'source-over';ctx.fillStyle='white';ctx.strokeStyle='white';ctx.lineCap='round';ctx.lineJoin='round';
  const points=operation.points;
  if(operation.kind==='polygon'){
    ctx.beginPath();points.forEach((point,index)=>ctx[index?'lineTo':'moveTo'](point.x*w,point.y*h));ctx.closePath();ctx.fill();
  }else if(operation.kind==='rect'){
    const r=selectionRect(points[0],points.at(-1));ctx.fillRect(r.x*w,r.y*h,r.width*w,r.height*h);
  }else{
    const diameter=operation.diameter*w;ctx.lineWidth=diameter;
    ctx.beginPath();ctx.arc(points[0].x*w,points[0].y*h,diameter/2,0,Math.PI*2);ctx.fill();
    if(points.length>1){ctx.beginPath();points.forEach((point,index)=>ctx[index?'lineTo':'moveTo'](point.x*w,point.y*h));ctx.stroke();}
  }
  ctx.restore();
}
function paint(){
  if(!state.source)return;
  const w=rawMask.width,h=rawMask.height;raw.clearRect(0,0,w,h);
  if(state.autoAssets?.mask)raw.drawImage(state.autoAssets.mask.image,0,0,w,h);
  for(const operation of state.history.active)drawOperation(raw,operation);
  if(state.active&&state.active.kind!=='pan'&&state.active.layer==='edit')drawOperation(raw,state.active);
  soft.clearRect(0,0,w,h);soft.filter=state.feather?`blur(${state.feather*w/state.source.width}px)`:'none';soft.drawImage(rawMask,0,0);soft.filter='none';
  foregroundContext.clearRect(0,0,w,h);if(state.autoAssets?.foreground)foregroundContext.drawImage(state.autoAssets.foreground.image,0,0,w,h);for(const operation of state.foregroundHistory.active)drawOperation(foregroundContext,operation);
  if(state.active&&state.active.kind!=='pan'&&state.active.layer==='foreground')drawOperation(foregroundContext,state.active);
  foregroundPreviewContext.clearRect(0,0,w,h);foregroundPreviewContext.drawImage(foregroundMask,0,0);foregroundPreviewContext.globalCompositeOperation='source-in';foregroundPreviewContext.drawImage(state.source.image,0,0,w,h);foregroundPreviewContext.globalCompositeOperation='source-over';
  foregroundPreview.hidden=state.view==='mask'||!$('preserveProduct').checked;
  const selectedMask=state.layer==='foreground'?foregroundMask:softMask;
  display.clearRect(0,0,w,h);display.save();
  if(state.view==='mask'){display.fillStyle='black';display.fillRect(0,0,w,h);display.drawImage(selectedMask,0,0);}
  else if(state.show){display.drawImage(selectedMask,0,0);display.globalCompositeOperation='source-in';display.fillStyle=state.layer==='foreground'?'rgba(255,160,50,.65)':'rgba(59,222,147,.54)';display.fillRect(0,0,w,h);}
  display.restore();surface.classList.toggle('mask-mode',state.view==='mask');surface.classList.toggle('foreground-mode',state.layer==='foreground');updateControls();
}
function measure(){
  if(!state.source){state.coverage=0;return;}
  const pixels=soft.getImageData(0,0,softMask.width,softMask.height).data;let count=0;
  for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)count++;
  state.coverage=count/(softMask.width*softMask.height);placementController?.checkCoverage();
  $('maskCoverage').textContent=count?`已涂选 ${(state.coverage*100).toFixed(1)}%`:'尚未涂选';updateControls();
}
function updateControls(){
  cloudController?.update();
  $('undoBtn').disabled=!currentHistory().canUndo;$('redoBtn').disabled=!currentHistory().canRedo;
  $('downloadMask').disabled=!state.source||state.coverage===0;$('clearMask').disabled=!state.source||!(state.layer==='foreground'?(state.foregroundHistory.active.length||state.autoAssets?.foreground):state.coverage);
  $('clearMask').textContent=state.layer==='foreground'?'清空前景区':'清空选区';
  $('paintHint').textContent=state.layer==='foreground'?($('preserveProduct').checked?'橙色区域会保留原图手指或发丝，并叠在商品前；放大后用细笔只涂需要压边的部分':'开启“保留商品文字与 logo”后，橙色前景区才会生效'):'绿色区域允许修改';
  $('cropBtn').disabled=!state.product;$('stepUpload').classList.toggle('done',!!state.source&&!!state.product);
  $('paintHint').hidden=!state.source||state.view==='mask'||!state.show;
  placementController?.render();generationController?.update();automaticController?.render();
  const inputIssue=generationInputIssue();$('generateBtn').title=inputIssue;
  if(inputIssue&&$('manualMode').checked)$('paintHint').textContent=inputIssue;
}
function setTool(tool){
  if(tool==='place'&&state.layer==='foreground')setLayer('edit');
  if(tool==='place'&&state.view==='mask')setView('overlay');
  state.tool=tool;document.querySelectorAll('[data-tool]').forEach(button=>{const selected=button.dataset.tool===tool;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  surface.classList.toggle('is-pan',tool==='pan'||state.space);$('brushCursor').classList.toggle('erase',tool==='erase');$('brushCursor').style.display='none';cursorSize();placementController?.render();
}
function cursorSize(){const diameter=state.brush*state.scale;$('brushCursor').style.width=`${diameter}px`;$('brushCursor').style.height=`${diameter}px`;}
function cursor(event){
  const rect=overlay.getBoundingClientRect();$('brushCursor').style.left=`${event.clientX-rect.left}px`;$('brushCursor').style.top=`${event.clientY-rect.top}px`;
  const visible=state.hover&&['brush','erase'].includes(state.tool)&&!state.space;
  $('brushCursor').style.display=visible?'block':'none';
}
function point(event){return normalizedPoint(event.clientX,event.clientY,overlay.getBoundingClientRect());}
overlay.addEventListener('pointerdown',event=>{
  if(event.button!==0||!state.source||state.active||state.tool==='place')return;
  event.preventDefault();overlay.focus({preventScroll:true});overlay.setPointerCapture(event.pointerId);
  if(state.tool==='pan'||state.space){state.active={kind:'pan',pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};surface.classList.add('panning');}
  else{state.active={kind:state.tool==='rect'?'rect':'stroke',mode:state.tool==='erase'?'erase':'paint',layer:state.layer,diameter:state.brush/state.source.width,points:[point(event)],pointerId:event.pointerId};schedulePaint();}
});
overlay.addEventListener('pointermove',event=>{
  cursor(event);const active=state.active;if(!active||active.pointerId!==event.pointerId)return;
  event.preventDefault();
  if(active.kind==='pan'){viewport.scrollLeft=active.left-(event.clientX-active.x);viewport.scrollTop=active.top-(event.clientY-active.y);return;}
  if(active.kind==='rect')active.points=[active.points[0],point(event)];
  else{const events=event.getCoalescedEvents?.()||[];for(const sample of events.length?events:[event])active.points.push(point(sample));}
  schedulePaint();
});
function endStroke(event,cancelled=false){
  if(!state.active||state.active.pointerId!==event.pointerId)return;
  const active=state.active;state.active=null;surface.classList.remove('panning');
  if(overlay.hasPointerCapture(event.pointerId))overlay.releasePointerCapture(event.pointerId);
  if(active.kind!=='pan'&&!cancelled){delete active.pointerId;(active.layer==='foreground'?state.foregroundHistory:state.history).commit(active);dirty();}
  paint();measure();
}
overlay.addEventListener('pointerup',event=>endStroke(event));overlay.addEventListener('pointercancel',event=>endStroke(event,true));
overlay.addEventListener('pointerenter',event=>{state.hover=true;cursor(event);});overlay.addEventListener('pointerleave',()=>{state.hover=false;$('brushCursor').style.display='none';});
function undo(){if(state.active)return;currentHistory().undo();dirty();paint();measure();}
function redo(){if(state.active)return;currentHistory().redo();dirty();paint();measure();}
function setLayer(layer){if(state.active)return;state.layer=layer;if(layer==='foreground'&&state.tool==='place')setTool('brush');document.querySelectorAll('[data-layer]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layer===layer)));paint();}
document.querySelectorAll('[data-layer]').forEach(b=>b.onclick=()=>setLayer(b.dataset.layer));
$('preserveProduct').onchange=()=>{dirty();paint();};
$('hairMode').onchange=()=>{dirty();};
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$('undoBtn').onclick=undo;$('redoBtn').onclick=redo;
$('clearMask').onclick=()=>{currentHistory().commit({kind:'clear'});dirty();paint();measure();toast('已清空，可用撤销恢复。');};
$('brushSize').addEventListener('input',event=>{state.brush=Number(event.target.value);$('brushValue').value=`${state.brush} px`;cursorSize();dirty();});
$('feather').addEventListener('input',event=>{state.feather=Number(event.target.value);$('featherValue').value=`${state.feather} px`;dirty();paint();measure();});
$('showMask').onchange=event=>{state.show=event.target.checked;paint();};
function setView(view){state.view=view;if(view==='mask'&&state.tool==='place')setTool('brush');$('viewOverlay').classList.toggle('selected',view==='overlay');$('viewMask').classList.toggle('selected',view==='mask');$('viewOverlay').setAttribute('aria-pressed',String(view==='overlay'));$('viewMask').setAttribute('aria-pressed',String(view==='mask'));$('showMask').disabled=view==='mask';paint();}
$('viewOverlay').onclick=()=>setView('overlay');$('viewMask').onclick=()=>setView('mask');
$('zoomIn').onclick=()=>zoom(1.3);$('zoomOut').onclick=()=>zoom(1/1.3);$('fitZoom').onclick=()=>{state.zoom=1;fit();viewport.scrollTo({top:0,left:0});};
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]')||event.target.closest('input,textarea,select,[contenteditable=true]'))return;
  const key=event.key.toLowerCase();
  if((event.ctrlKey||event.metaKey)&&key==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if((event.ctrlKey||event.metaKey)&&key==='y'){event.preventDefault();redo();return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  const tools={b:'brush',e:'erase',r:'rect',h:'pan',v:'place'};if(tools[key])setTool(tools[key]);
  if(event.code==='Space'&&(event.target===overlay||state.hover)){event.preventDefault();state.space=true;surface.classList.add('is-pan');$('brushCursor').style.display='none';}
});
document.addEventListener('keyup',event=>{if(event.code==='Space'){state.space=false;surface.classList.toggle('is-pan',state.tool==='pan');}});
window.addEventListener('blur',()=>{state.space=false;surface.classList.toggle('is-pan',state.tool==='pan');});
for(const role of ['source','product']){
  $(`${role}Upload`).onclick=()=>$(`${role}File`).click();$(`${role}File`).onchange=event=>upload(role,event.target.files[0]);
  const drop=document.querySelector(`[data-role=${role}]`);
  drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('dragging');});drop.addEventListener('dragleave',event=>{if(!drop.contains(event.relatedTarget))drop.classList.remove('dragging');});
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('dragging');upload(role,event.dataTransfer.files[0]);});
}
$('sourceChange').onclick=()=>$('sourceFile').click();$('loadDemo').onclick=()=>loadDemo();
$('instructions').addEventListener('input',()=>{labelCount();dirty();});
function download(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
function canvasBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法导出图片，请减少图片尺寸后重试。')),'image/png'));}
async function currentMaskBlob(input=softMask){paint();const canvas=document.createElement('canvas');canvas.width=state.source.width;canvas.height=state.source.height;const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(input,0,0,canvas.width,canvas.height);return canvasBlob(canvas);}
$('downloadMask').onclick=async()=>{
  if(!state.source||state.coverage===0)return;
  $('downloadMask').disabled=true;
  try{const canvas=document.createElement('canvas');canvas.width=state.source.width;canvas.height=state.source.height;const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(softMask,0,0,canvas.width,canvas.height);download(await canvasBlob(canvas),`swap-mask-${canvas.width}x${canvas.height}.png`);toast('蒙版已导出：白色可修改，黑色保留。');}
  catch(error){toast(error.message,true);}finally{updateControls();}
};
function database(){return dbPromise??=new Promise((resolve,reject)=>{const request=indexedDB.open(appConfig.draftDatabase,1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('浏览器不允许保存草稿，仍可下载蒙版。'));});}
async function readDraft(){const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction('drafts').objectStore('drafts').get('current');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function assetRecord(asset){return asset?{blob:asset.blob,name:asset.name}:null;}
async function saveDraft(){
  if(!state.source){toast('请先上传人物原图。',true);return;}
  $('saveDraft').disabled=true;
  try{const db=await database(),record={version:1,source:assetRecord(state.source),product:assetRecord(state.product),originalProduct:assetRecord(state.originalProduct),originalSourceUpload:state.originalSourceUpload,normalization:state.normalization,autoReady:!!state.autoReady,autoAssets:state.autoAssets?Object.fromEntries(Object.entries(state.autoAssets).map(([k,a])=>[k,assetRecord(a)])):null,history:state.history.serialize(),foregroundHistory:state.foregroundHistory.serialize(),preserveProduct:$('preserveProduct').checked,hairMode:$('hairMode').checked,productTone:{saturation:$('toneSaturation').value,contrast:$('toneContrast').value},brush:state.brush,feather:state.feather,placement:placementController?.snapshot(),instructions:$('instructions').value,savedAt:Date.now()};
    await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(record,'current');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
    state.dirty=false;$('draftStatus').textContent='草稿已保存在本机';$('restoreDraft').hidden=false;$('deleteDraft').hidden=false;toast('草稿已保存，刷新页面也能继续编辑。');
  }catch{toast('草稿未能保存，可能是浏览器存储空间不足。可先下载蒙版。',true);}finally{$('saveDraft').disabled=false;}
}
async function restoreDraft(record){
  if(!record?.source||record.version!==1)return false;
  demoEpoch++;
  const source=await decode(record.source.blob,record.source.name);applyAsset('source',source);
  if(record.originalSourceUpload)state.originalSourceUpload=record.originalSourceUpload;state.normalization=record.normalization||null;
  if(record.product){const product=await decode(record.product.blob,record.product.name);applyAsset('product',product);if(record.originalProduct)state.originalProduct=await decode(record.originalProduct.blob,record.originalProduct.name);}
  state.history=new MaskHistory(record.history.operations,record.history.index);state.brush=clamp(record.brush,1,100);state.feather=clamp(record.feather,0,16);
  state.foregroundHistory=new MaskHistory(record.foregroundHistory?.operations,record.foregroundHistory?.index);$('preserveProduct').checked=record.preserveProduct!==false;$('hairMode').checked=record.hairMode===true;$('toneSaturation').value=record.productTone?.saturation||90;$('toneContrast').value=record.productTone?.contrast||92;renderTone();
  if(record.autoAssets){state.autoAssets=Object.fromEntries(await Promise.all(Object.entries(record.autoAssets).map(async([k,a])=>[k,await decode(a.blob,a.name)])));state.autoReady=!!record.autoReady;$('placementOpacity').value=100;$('placementOpacity').dispatchEvent(new Event('input'));automaticController?.manual();$('analysisMessage').textContent='已恢复上次的自动方案，可重新分析或确认生成。';}
  $('brushSize').value=state.brush;$('brushValue').value=`${state.brush} px`;$('feather').value=state.feather;$('featherValue').value=`${state.feather} px`;$('instructions').value=record.instructions||'';
  state.dirty=false;$('draftStatus').textContent='已恢复本机草稿';$('restoreDraft').hidden=false;$('deleteDraft').hidden=false;labelCount();paint();measure();placementController?.restore(record.placement);return true;
}
$('saveDraft').onclick=saveDraft;
$('restoreDraft').onclick=async()=>{try{if(await restoreDraft(await readDraft()))toast('已恢复上次保存的草稿。');else toast('没有已保存的草稿。');}catch{toast('草稿读取失败，请重新上传图片。',true);}};
$('deleteDraft').onclick=async()=>{try{const db=await database();await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete('current');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});$('restoreDraft').hidden=true;$('deleteDraft').hidden=true;dirty();toast('已删除存储的草稿，当前画布保持不变。');}catch{toast('删除草稿失败，请稍后重试。',true);}};
$('helpBtn').onclick=()=>$('guideDialog').showModal();$('exampleResult').onclick=()=>$('exampleDialog').showModal();
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
$('compareRange').oninput=event=>{const x=event.target.value;$('comparisonAfter').style.clipPath=`inset(0 ${100-x}% 0 0)`;$('compareLine').style.left=`${x}%`;};
$('cropBtn').onclick=()=>{
  if(!state.product)return;cropStart=null;cropEnd=null;$('cropSelection').style.display='none';$('applyCrop').disabled=true;$('cropInfo').textContent='拖动鼠标框选商品';$('cropImage').src=state.originalProduct.url;$('cropDialog').showModal();
};
function cropPoint(event){return normalizedPoint(event.clientX,event.clientY,$('cropImage').getBoundingClientRect());}
function renderCrop(){
  if(!cropStart||!cropEnd)return;const r=selectionRect(cropStart,cropEnd),selection=$('cropSelection');selection.style.display='block';selection.style.left=`${r.x*100}%`;selection.style.top=`${r.y*100}%`;selection.style.width=`${r.width*100}%`;selection.style.height=`${r.height*100}%`;
  const pixels=pixelCrop(cropStart,cropEnd,state.originalProduct.width,state.originalProduct.height);$('cropInfo').textContent=`裁剪后 ${pixels.width} × ${pixels.height}`;$('applyCrop').disabled=pixels.width<8||pixels.height<8;
}
$('cropStage').addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();$('cropStage').setPointerCapture(event.pointerId);cropDragging=true;cropStart=cropPoint(event);cropEnd=cropStart;renderCrop();});
$('cropStage').addEventListener('pointermove',event=>{if(!cropDragging)return;cropEnd=cropPoint(event);renderCrop();});
$('cropStage').addEventListener('pointerup',event=>{if(!cropDragging)return;cropDragging=false;cropEnd=cropPoint(event);renderCrop();});
$('cropStage').addEventListener('pointercancel',()=>{cropDragging=false;});
$('applyCrop').onclick=async()=>{
  if(!cropStart||!cropEnd)return;
  try{const original=state.originalProduct,r=pixelCrop(cropStart,cropEnd,original.width,original.height);if(r.width<8||r.height<8)return;const canvas=document.createElement('canvas');canvas.width=r.width;canvas.height=r.height;canvas.getContext('2d').drawImage(original.image,r.x,r.y,r.width,r.height,0,0,r.width,r.height);const asset=await decode(await canvasBlob(canvas),'product-cropped.png');applyAsset('product',asset,{preserveOriginal:true});dirty();$('cropDialog').close();toast('商品参考图已裁剪。');}
  catch(error){toast(error.message,true);}
};
$('resetCrop').onclick=()=>{if(!state.originalProduct)return;applyAsset('product',state.originalProduct,{preserveOriginal:true});dirty();$('cropDialog').close();toast('已恢复完整商品图。');};
connectCutout({state,applyAsset,decode,canvasBlob,dirty,toast});
placementController=connectPlacement({state,softMask,dirty,update:updateControls,paint,measure,setTool});
cloudController=connectCloudEdit({state,notify:toast});
automaticController=connectAutomatic({state,notify:toast,update:updateControls,manualChanged(enabled){
  state.show=enabled;$('showMask').checked=enabled;$('sourceImage').src=!enabled&&state.autoAssets?.background?state.autoAssets.background.url:state.source?.url||'';
  setTool(enabled?'brush':'pan');paint();
},apply:async(result,isCurrent)=>{
  const decoded=await Promise.allSettled([...(result.source?['source']:[]),'product','mask','foreground','background',...(result.backgroundGuard?['backgroundGuard']:[]),...(result.backgroundMask?['backgroundMask']:[])].map(async key=>{
    if(!result[key]?.startsWith('data:image/png;base64,'))throw new Error('自动分析素材无效，请重试。');
    const bytes=Uint8Array.from(atob(result[key].slice(22)),char=>char.charCodeAt(0));
    return[key,await decode(new Blob([bytes],{type:'image/png'}),key+'.png')];
  }));
  const items=decoded.filter(item=>item.status==='fulfilled').map(item=>item.value),failed=decoded.find(item=>item.status==='rejected');
  if(failed){items.forEach(([,asset])=>release(asset));throw failed.reason;}
  if(!isCurrent()){items.forEach(([,asset])=>release(asset));return;}
  const assets=Object.fromEntries(items);
  try{validateAutomaticAssets(assets,state.source,result.sourceSize);}catch(error){items.forEach(([,asset])=>release(asset));throw error;}
  for(const asset of Object.values(state.autoAssets||{}))release(asset);state.autoAssets=null;
  if(assets.source){applyAsset('source',assets.source,{preserveOriginal:true});delete assets.source;}
  applyAsset('product',assets.product,{preserveOriginal:true});delete assets.product;state.autoAssets=assets;state.normalization=result.normalization||null;
  state.history=new MaskHistory();state.foregroundHistory=new MaskHistory();state.feather=0;$('feather').value=0;$('featherValue').value='0 px';$('preserveProduct').checked=true;
  $('placementOpacity').value=100;$('placementOpacity').dispatchEvent(new Event('input'));$('manualMode').checked=false;
  automaticController.manual();paint();measure();placementController.restore(result.placement);dirty();
  if(result.normalization?.source?.resized)$('canvasMeta').textContent=`${state.source.width} × ${state.source.height} 工作副本 · 原图已保留`;
}});
automaticController.manual();
new ResizeObserver(()=>requestAnimationFrame(fit)).observe(viewport);
labelCount();updateControls();
if(!appConfig.demo){
  $('loadDemo').hidden=true;$('exampleResult').hidden=true;
  $('canvasMeta').textContent='等待上传人物图';
  for(const role of ['source','product']){$(`${role}Ready`).textContent='待上传';$(`${role}Meta`).textContent='尚未选择图片';}
}
try{const record=await readDraft();if(!await restoreDraft(record)&&appConfig.demo)await loadDemo();}catch{if(appConfig.demo)await loadDemo();}
paint();measure();
generationController=connectGeneration({eligible:()=>!!state.source&&!!state.product&&!generationInputIssue()&&state.coverage>0&&!state.active&&placementController.eligible()&&automaticController.eligible(),notify:toast,snapshot:async()=>{const inputIssue=generationInputIssue();if(inputIssue)throw new Error(inputIssue);const source=state.source.blob,product=state.product.blob,instructions=$('instructions').value,placement=placementController.snapshot(),preserveProduct=$('preserveProduct').checked;const [mask,foreground]=await Promise.all([currentMaskBlob(),currentMaskBlob(foregroundMask)]);const hairMode=$('hairMode').checked;if(hairMode&&!preserveProduct)throw new Error('发饰替换需要开启商品保真。');if(hairMode&&!state.autoAssets?.backgroundMask)throw new Error('请先自动识别旧发饰范围，再使用发饰替换。');const backgroundGuard=state.autoAssets?.backgroundGuard?await currentMaskBlob(state.autoAssets.backgroundGuard.image):null;const backgroundMask=state.autoAssets?.backgroundMask?await currentMaskBlob(state.autoAssets.backgroundMask.image):null;return{source,product,mask,foreground,backgroundGuard,backgroundMask,backgroundOnlyGeneration:false,integrateGeneratedEdges:true,productTone:{saturation:Number($('toneSaturation').value)/100,contrast:Number($('toneContrast').value)/100},instructions,placement,preserveProduct};}});
