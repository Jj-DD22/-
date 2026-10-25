import {requestId} from './request-id.js';
const $=id=>document.getElementById(id);
const base64=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
async function api(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;}
export function connectCloudEdit({state,notify}){
  let connection=null,job=null,submitting=false,timer,recoveryId=null,lastResult=null,submissionError='';
  const running=()=>submitting||job?.status==='running';
  function render(){
    $('cloudGenerate').disabled=running()||!connection?.configured||!state.source||!state.originalProduct||!$('cloudConsent').checked;
    $('cloudGenerate').textContent=running()?'正在编辑，请稍候…':'整图编辑并生成候选';
    $('cloudError').textContent=submissionError||job?.error||'';$('cloudError').hidden=!$('cloudError').textContent;
    if(!job)return;
    $('cloudJob').hidden=false;$('cloudStage').textContent=job.stage;$('cloudJobMeta').textContent=`任务 ${job.id.slice(0,8)} · ${job.model}`;
    $('cloudSceneReview').textContent=job.sceneReview||'';
    const ready=job.status==='succeeded'&&!!job.resultUrl;$('cloudResult').hidden=!ready;
    if(ready){
      if(lastResult!==job.id){$('cloudBefore').src=job.sourceUrl;$('cloudProduct').src=job.productUrl;$('cloudAfter').src=job.resultUrl;$('cloudDownload').href=job.resultUrl+'?download=1';lastResult=job.id;}
      $('cloudReviewText').textContent=job.resultReview||job.reviewWarning||'请人工核对商品、边缘和整体构图。';
      $('cloudResultMeta').textContent=`${job.dimensions?.join(' × ')} · 来自本次云端编辑请求 · ${job.providerRequestId||'服务商已返回图片'}`;
      $('cloudHumanStatus').textContent=job.humanReview?.decision==='accepted'?'你已接受这版结果。':job.humanReview?.decision==='rejected'?'已记录需要修改；可调整要求后重新生成。':'待你人工确认；生成完成不代表商品细节已通过。';
      $('cloudAccept').disabled=submitting||job.humanReview?.decision==='accepted';$('cloudReject').disabled=submitting;
    }else{for(const id of ['cloudBefore','cloudProduct','cloudAfter'])$(id).removeAttribute('src');$('cloudDownload').removeAttribute('href');lastResult=null;}
  }
  function accept(next){job=next;render();clearTimeout(timer);if(job?.status==='running')timer=setTimeout(poll,2000);}
  async function poll(){try{accept((await api('/api/image-edits/'+job.id)).job);}catch{$('cloudStage').textContent='连接暂时中断，正在查询原任务；不会自动重发生成请求。';timer=setTimeout(poll,4000);}}
  async function check(){try{connection=await api('/api/image-edits/status');$('cloudConnection').textContent=`${connection.provider} · ${connection.model} · ${connection.message}`;const latest=await api('/api/image-edits/latest');if(latest.job)accept(latest.job);}catch(error){$('cloudConnection').textContent=error.message;}render();}
  $('cloudCheck').onclick=check;$('cloudConsent').onchange=render;
  $('editingMode').onchange=()=>{const cloud=$('editingMode').value==='cloud';document.body.classList.toggle('cloud-edit-mode',cloud);$('cloudPanel').hidden=!cloud;render();};
  $('editingMode').onchange();
  $('cloudGenerate').onclick=async()=>{
    if($('cloudGenerate').disabled)return;
    submissionError='';submitting=true;render();
    // Retain the same request ID on an ambiguous transport failure. A changed
    // upload/requirement gets a new identity; the server checks its content hash.
    const source=state.originalSourceUpload?.blob||state.source.blob,product=state.originalProduct.blob,instructions=$('cloudInstructions').value;
    if(!recoveryId||recoveryId.source!==source||recoveryId.product!==product||recoveryId.instructions!==instructions)recoveryId={id:requestId(),source,product,instructions};
    try{
      const [a,b]=await Promise.all([base64(source),base64(product)]);
      const data=await api('/api/image-edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:recoveryId.id,source:a,product:b,instructions,allowExternal:$('cloudConsent').checked})});
      accept(data.job);recoveryId=null;$('cloudJob').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){submissionError=error.message;notify(error.message,true);$('cloudJob').hidden=false;}
    finally{submitting=false;render();}
  };
  for(const [id,decision] of [['cloudAccept','accepted'],['cloudReject','rejected']])$(id).onclick=async()=>{
    if(!job||job.status!=='succeeded')return;submitting=true;render();
    try{accept((await api(`/api/image-edits/${job.id}/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})})).job);}catch(error){notify(error.message,true);}finally{submitting=false;render();}
  };
  void check();return {update:render};
}
