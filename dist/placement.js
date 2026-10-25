import {fitPlacement,movePlacement,scalePlacement,resizePlacement,validPlacement} from './placement-model.js';
const $=id=>document.getElementById(id);
export function hasPlacementProduct(state){return !state.analysisBusy&&!['failed','review'].includes(state.analysisStatus)&&(state.autoReady===true||state.product?.preparedCutout===true);}
export function connectPlacement({state,softMask,dirty,update,paint,measure,setTool}){
  let placement=null,gesture=null,visible=true,opacity=.8,uncovered=0;
  const box=$('productPlacement');
  function region(){
    const {width:w,height:h}=softMask,data=softMask.getContext('2d').getImageData(0,0,w,h).data;
    let x0=w,y0=h,x1=0,y1=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>200){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}
    return x1>x0?{x:x0/w*state.source.width,y:y0/h*state.source.height,width:(x1-x0)/w*state.source.width,height:(y1-y0)/h*state.source.height}:null;
  }
  function render(){
    const ready=hasPlacementProduct(state);
    box.hidden=!ready||!placement||!visible||state.view==='mask'||(document.getElementById('manualMode')&&!$('manualMode').checked&&!state.autoReady);box.classList.toggle('editable',state.tool==='place');
    $('placeTool').disabled=!ready||!state.source||!state.product;$('showProduct').disabled=!ready||!placement;$('placementHeight').disabled=!ready||!placement;$('fitProduct').disabled=!ready||!state.product||!state.source;$('includeProduct').disabled=!ready||!placement;
    $('placementEmpty').hidden=ready&&!!placement;$('placementDetails').hidden=!ready||!placement;
    if(!ready){$('placementEmpty').textContent=state.analysisBusy?'正在分析商品轮廓，请稍候。':'商品参考照尚未完成抠图与定位，请先自动识别，或手动抠出商品。';$('placementWarning').hidden=true;return;}
    if(!placement)return;
    const p=placement,s=state.source;
    Object.assign(box.style,{left:p.x/s.width*100+'%',top:p.y/s.height*100+'%',width:p.width/s.width*100+'%',height:p.height/s.height*100+'%'});
    $('placedProductImage').style.opacity=opacity;
    $('placementHeight').max=Math.floor(Math.min(s.height,s.width*p.height/p.width));$('placementHeight').value=Math.round(p.height);
    $('placementSize').textContent=`${Math.round(p.width)} × ${Math.round(p.height)} px`;
    $('placementPosition').textContent=`左 ${Math.round(p.x)} · 上 ${Math.round(p.y)} px`;
    $('placementWarning').hidden=uncovered===0;$('placementWarning').textContent=uncovered?`商品有约 ${Math.max(1,Math.round(uncovered*100))}% 超出绿色选区。请补涂，或点“将商品区域加入选区”。`:'';
    $('placementOutlineLabel').textContent=`${state.autoReady?'位置预览':'手动摆放 · 非识别结果'} · ${Math.round(p.width)} × ${Math.round(p.height)}`;
  }
  function checkCoverage(){
    uncovered=0;
    if(placement&&state.product){
      const canvas=document.createElement('canvas');canvas.width=softMask.width;canvas.height=softMask.height;
      const ctx=canvas.getContext('2d'),sx=canvas.width/state.source.width,sy=canvas.height/state.source.height,p=placement;
      ctx.drawImage(state.product.image,p.x*sx,p.y*sy,p.width*sx,p.height*sy);
      const alpha=ctx.getImageData(0,0,canvas.width,canvas.height).data,mask=softMask.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let total=0,outside=0;for(let i=3;i<alpha.length;i+=4)if(alpha[i]>32){total++;if(mask[i]<200)outside++;}
      uncovered=total?outside/total:1;
      if(uncovered<=.005)uncovered=0;
    }
    render();update();
  }
  function reset(){
    gesture=null;placement=state.source&&state.product?fitPlacement(state.source,state.product,region()):null;
    if(state.product)$('placedProductImage').src=state.product.url;
    checkCoverage();
  }
  function changed(){dirty();checkCoverage();}
  $('fitProduct').onclick=()=>{reset();dirty();setTool('place');};
  $('placeTool').onclick=()=>{if(!placement)reset();visible=true;$('showProduct').checked=true;setTool('place');render();};
  $('showProduct').onchange=e=>{visible=e.target.checked;render();};
  $('placementOpacity').oninput=e=>{opacity=Number(e.target.value)/100;$('opacityValue').textContent=e.target.value+'%';render();};
  $('placementHeight').oninput=e=>{if(!placement)return;placement=scalePlacement(placement,Number(e.target.value),state.source);changed();};
  $('includeProduct').onclick=()=>{
    if(!placement)return;const p=placement,s=state.source,m=state.feather*3+3;
    state.history.commit({kind:'rect',points:[{x:Math.max(0,p.x-m)/s.width,y:Math.max(0,p.y-m)/s.height},{x:Math.min(s.width,p.x+p.width+m)/s.width,y:Math.min(s.height,p.y+p.height+m)/s.height}]});
    dirty();paint();measure();
  };
  box.addEventListener('pointerdown',e=>{
    if(state.tool!=='place'||!placement||e.button!==0||gesture)return;e.preventDefault();e.stopPropagation();
    box.focus({preventScroll:true});box.setPointerCapture(e.pointerId);
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY,start:{...placement},corner:e.target.dataset.corner||null,scale:state.scale};update();
  });
  box.addEventListener('pointermove',e=>{
    if(gesture?.id!==e.pointerId)return;e.preventDefault();
    const dx=(e.clientX-gesture.x)/gesture.scale,dy=(e.clientY-gesture.y)/gesture.scale;
    placement=gesture.corner?resizePlacement(gesture.start,gesture.corner,dx,dy,state.source):movePlacement(gesture.start,dx,dy,state.source);render();
  });
  const end=(e,cancel)=>{if(gesture?.id!==e.pointerId)return;if(cancel)placement=gesture.start;gesture=null;if(box.hasPointerCapture(e.pointerId))box.releasePointerCapture(e.pointerId);changed();};
  box.addEventListener('pointerup',e=>end(e,false));box.addEventListener('pointercancel',e=>end(e,true));
  box.addEventListener('keydown',e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta||!placement||state.tool!=='place')return;e.preventDefault();const step=e.shiftKey?10:1;placement=movePlacement(placement,delta[0]*step,delta[1]*step,state.source);changed();});
  return {reset,render,checkCoverage,eligible:()=>hasPlacementProduct(state)&&!!placement&&!gesture&&uncovered===0,
    snapshot:()=>placement?{...placement}:null,
    restore(p){if(validPlacement(p,state.source,state.product))placement={...p};else reset();checkCoverage();}};
}
