const $=id=>document.getElementById(id);
const base64=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
export function connectAutomatic({state,apply,manualChanged,update,notify}){
  let status=null,busy=false,epoch=0,hasMessage=false;
  const intro=()=>status?.configured?'上传人物原图和商品图后，使用视觉 API 分析轮廓、位置和手指遮挡，再确认预览。':'视觉 API 尚未接通。这里只能匹配本机已审核的指定图片对；新图片需要配置视觉 API 或使用手动微调。';
  function render(){
    $('analyzeBtn').disabled=busy||!status||!state.source||!state.originalProduct;
    $('analyzeBtn').textContent=busy?(status?.configured?'正在分析并整理图片…':'正在匹配已审核方案…'):status?.configured?(state.autoReady?'重新分析这两张图':'自动识别与摆放'):(state.autoReady?'重新应用已审核方案':'匹配已审核方案');
    if($('analysisTitle'))$('analysisTitle').textContent=status?.configured?'上传两张图，分析并确认替换位置':'视觉 API 未接通 · 仅支持已审核图片方案';
    $('externalConsentRow').hidden=!status?.configured;
  }
  function manual(){const enabled=$('manualMode').checked;document.body.classList.toggle('manual-mode',enabled);manualChanged(enabled);update();}
  $('manualMode').onchange=manual;
  async function refresh(){try{const r=await fetch('/api/vision/status');if(!r.ok)throw Error();status=await r.json();$('visionStatus').textContent=status.message;if(!hasMessage&&!state.autoReady)$('analysisMessage').textContent=intro();}catch{$('visionStatus').textContent='无法检查视觉服务状态，请确认主机已更新并启动。';}render();}
  $('analyzeBtn').onclick=async()=>{
    if(busy||!state.source||!state.originalProduct)return;
    const current=++epoch,source=state.source,sourceInput=state.originalSourceUpload||source,product=state.originalProduct;busy=true;hasMessage=true;state.analysisBusy=true;state.analysisStatus='running';state.autoReady=false;state.sceneReview=null;if($('sceneReviewStatus'))$('sceneReviewStatus').textContent='正在重新检查整图与镜像关联…';render();update();
    $('analysisFacts').hidden=true;
    $('analysisMessage').textContent=status?.configured?'正在扫描整图、镜像关联、商品结构与光线，再检查抠图和摆放…':'正在核对这两张图片是否有已审核方案；此步骤不会调用视觉模型。';$('analysisWarnings').textContent='';
    try{
      const [a,b]=await Promise.all([base64(sourceInput.blob),base64(product.blob)]);
      const response=await fetch('/api/vision/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:a,product:b,allowExternal:$('externalConsent').checked,requireSceneReview:true})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'自动分析失败。');
      if(current!==epoch||source!==state.source||product!==state.originalProduct){notify('图片已经更换，已忽略旧图片的分析结果。');return;}
      state.sceneReview=result.sceneReview;
      if($('sceneReviewStatus'))$('sceneReviewStatus').textContent=result.sceneReview?.completed?('整图已检查 · '+result.sceneReview.summary+(result.sceneReview.blocked?' · 多处关联或信息不足，需处理后再生成。':'')):'整图检查未完成，请重新分析。';
      $('analysisWarnings').textContent=[...(result.warnings||[]),...(result.nextActions||[])].join(' ');
      if(result.needsReview){state.analysisStatus='review';$('analysisMessage').textContent='需要确认：'+result.summary;return;}
      await apply(result,()=>current===epoch&&source===state.source&&product===state.originalProduct);
      if(current!==epoch)return;
      state.autoReady=true;state.analysisStatus='ready';
      $('analysisMessage').textContent=(result.origin==='reviewed-pair'?'已应用这组指定图片的人工视觉方案（未调用视觉 API）。':'已完成视觉 API 分析。')+' '+result.summary;
      $('analysisFacts').hidden=false;
      $('analysisFacts').textContent='已准备商品抠图、旧物清除区和手指遮挡；请检查位置预览后生成。';
      notify('已抠出商品并完成摆放，确认预览后即可生成。');
    }catch(error){if(current===epoch){state.analysisStatus='failed';state.sceneReview=null;$('analysisMessage').textContent=error.message;if($('sceneReviewStatus'))$('sceneReviewStatus').textContent='本次分析未完成：'+error.message+' 尚未得到可用抠图与定位，未进入生成。';notify(error.message,true);}}
    finally{busy=false;state.analysisBusy=false;render();update();}
  };
  void refresh();
  return {render,manual,eligible:()=>!busy&&state.analysisStatus!=='review'&&state.analysisStatus!=='failed'&&state.sceneReview?.completed===true&&!state.sceneReview?.blocked&&($('manualMode').checked||state.autoReady),invalidate(){epoch++;state.analysisStatus='idle';state.sceneReview=null;if($('sceneReviewStatus'))$('sceneReviewStatus').textContent='更换素材后，请重新进行整图视觉检查。';hasMessage=false;state.autoReady=false;$('analysisFacts').hidden=true;$('analysisMessage').textContent=intro();$('analysisWarnings').textContent='';render();}};
}
