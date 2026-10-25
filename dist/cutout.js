import {normalizedPoint} from './mask-model.js';
const $=id=>document.getElementById(id);
export function connectCutout({state,applyAsset,decode,canvasBlob,dirty,toast}){
  let points=[];
  function render(){
    $('cutoutPolygon').setAttribute('points',points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '));
    $('cutoutPoints').replaceChildren(...points.map(p=>{const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('cx',p.x*1000);circle.setAttribute('cy',p.y*1000);circle.setAttribute('r','5');return circle;}));
    $('cutoutCount').textContent=`已标记 ${points.length} 个点`;$('applyCutout').disabled=points.length<3;$('undoCutout').disabled=!points.length;
  }
  $('cutoutBtn').onclick=()=>{if(!state.product)return;points=[];$('cutoutImage').src=state.originalProduct.url;render();$('cutoutDialog').showModal();};
  $('cutoutStage').addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();points.push(normalizedPoint(e.clientX,e.clientY,$('cutoutImage').getBoundingClientRect()));render();});
  $('undoCutout').onclick=()=>{points.pop();render();};
  $('applyCutout').onclick=async()=>{
    if(points.length<3)return;$('applyCutout').disabled=true;
    try{
      const original=state.originalProduct,w=original.width,h=original.height;
      const x=Math.floor(Math.min(...points.map(p=>p.x*w))),y=Math.floor(Math.min(...points.map(p=>p.y*h)));
      const right=Math.ceil(Math.max(...points.map(p=>p.x*w))),bottom=Math.ceil(Math.max(...points.map(p=>p.y*h)));
      if(right-x<8||bottom-y<8)throw new Error('轮廓太小，请沿商品边缘重新标记。');
      const canvas=document.createElement('canvas');canvas.width=right-x;canvas.height=bottom-y;
      const ctx=canvas.getContext('2d');ctx.beginPath();points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*w-x,p.y*h-y));ctx.closePath();ctx.clip();ctx.drawImage(original.image,-x,-y);
      const asset=await decode(await canvasBlob(canvas),'product-cutout.png');asset.preparedCutout=true;applyAsset('product',asset,{preserveOriginal:true});dirty();$('cutoutDialog').close();toast('商品已抠出，可拖动和等比例缩放。');
    }catch(error){toast(error.message,true);}finally{render();}
  };
}
