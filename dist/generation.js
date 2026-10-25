import {requestId as makeRequestId} from './request-id.js';
import {buildCorrectionPrompt,getResultIssue} from './result-correction.js';
const $=id=>document.getElementById(id);
const done=job=>job&&['succeeded','failed','cancelled'].includes(job.status);
const duration=ms=>{const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)} 分 ${s%60} 秒`;};
const base64=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
async function api(url,options){const response=await fetch(url,options);const data=await response.json();if(response.status===401){location.assign('/login');throw new Error('访问已过期，请重新输入访问码。');}if(!response.ok)throw new Error(data.error||'请求失败');return data;}
export function connectGeneration({snapshot,eligible,notify}){
  let connection=null,job=null,submitting=false,pollTimer,lastResult=null,connectionRetry;
  function correctionControls(){
    const issue=getResultIssue($('reviewIssue').value),remaining=job?.correctionAttemptsRemaining??2,note=$('correctionNote').value;
    $('correctionQuota').textContent=remaining?`还可定向生成 ${remaining} 次`:'定向纠错次数已用完，请调整素材或位置后新建任务。';
    $('correctionPromptPreview').textContent=issue?(issue.canRegenerate?(()=>{try{return `将发送给图像生成模型：${buildCorrectionPrompt(issue.code,note)}`}catch(error){return error.message}})():issue.help):'请选择问题，查看将发送给图像生成模型的定向提示。';
    $('correctionRetry').disabled=!!(submitting||!job||job.status!=='succeeded'||!issue?.canRegenerate||remaining<=0||(issue.requiresNote&&!note.trim()));
    $('correctionRetry').hidden=!!(issue&&!issue.canRegenerate);
  }
  function controls(){const busy=submitting||(job&&!done(job));$('generateBtn').disabled=!!busy||!connection?.ready||!eligible();$('generateLabel').textContent=job?.status==='waiting'?'正在排队…':busy?'正在生成…':'生成替换图';}
  function render(){
    controls();if(!job)return;
    $('jobPanel').hidden=false;$('jobStage').textContent=job.stage;$('jobId').textContent='任务 '+job.id.slice(0,8);
    $('jobElapsed').textContent=(job.refinement?'原始生成耗时 ':done(job)?'本次耗时 ':'已用时 ')+duration((job.finishedAt||Date.now())-job.startedAt);
    $('jobError').hidden=!job.error;$('jobError').textContent=job.error||'';
    $('cancelJob').hidden=done(job);$('cancelJob').disabled=!!job.cancelRequested;
    $('jobIndicator').classList.toggle('working',!done(job));$('jobIndicator').classList.toggle('failed',job.status==='failed'||job.quality?.status==='failed');
    $('jobStep').hidden=!job.steps||done(job);$('jobStep').textContent=job.steps?`采样 ${job.step} / ${job.steps} 步（不是整体进度）`:'';
    const resultReady=job.status==='succeeded'&&!!job.resultUrl&&job.quality?.hardChecks?.passed===true;
    $('resultArea').hidden=!resultReady;
    if(resultReady)$('resultQuality').textContent=job.humanReview?.decision==='accepted'&&(job.humanReview.revision||null)===(job.refinement?.revision||null)?'人工已接受 · 确认结论已保存；自动评估状态仍单独保留。':'需要确认 · '+(job.quality?.nextActions?.[0]||'请放大核对商品边缘、旧发饰和佩戴位置。');
    if(!resultReady){
      lastResult=null;
      for(const name of ['resultDownload','baselineDownload','guideDownload','workflowDownload'])$(name).removeAttribute('href');
      for(const name of ['resultBefore','resultAfter'])$(name).removeAttribute('src');
    }
    for(const [name,url] of [['baselineDownload',job.baselineUrl],['guideDownload',job.guideUrl]]){
      $(name).hidden=!resultReady||!url;
      if(resultReady&&url)$(name).href=url+'?download=1';else $(name).removeAttribute('href');
    }
    const reviewed=job.humanReview?.decision==='accepted'&&(job.humanReview.revision||null)===(job.refinement?.revision||null);
    $('jobHelp').textContent=job.status==='succeeded'?(reviewed?'人工已接受该候选；自动评估结论仍单独保留。':job.quality?.summary||'候选图片需要确认商品轮廓、旧物残留和佩戴关系。')+(job.refinement?' 此版已局部修整。':'')+(job.correction?` 本次由人工选择“${getResultIssue(job.correction.issueCode)?.label||'其他问题'}”后定向再生成，计入人工介入。`:''):done(job)?'调整素材后可以重新生成。':job.status==='waiting'?'主机按提交顺序处理，轮到你后自动开始；可以取消本次排队。':'主机正在生成，可能需要数分钟。刷新页面可恢复任务，请保持主机开机。';
    const resultKey=job.id+':'+(job.refinement?.revision||'original');
    if(resultReady&&lastResult!==resultKey){
      const v=job.verification;
      $('resultCaveat').textContent=v.productToneApplied?'商品经过所选饱和度与对比度调整；形状与纹样使用抠图，保护差值相对于调色后的商品计算，不表示原始 RGB 未改变。仍需核对整图、镜像和细节。':v.productMaxPixelDifference===0?'商品未遮挡的不透明区域直接使用缩放后的原图，文字与 logo 未经重绘。前景主体保留原图，半透明边缘与背景重新融合。细小文字清晰度仍受原图与输出尺寸限制。':'请检查前景遮挡与商品细节。模型可能重绘品牌小字，使用前需要人工核对。';
      lastResult=resultKey;
      $('resultBefore').src=job.sourceUrl;$('resultAfter').src=job.resultUrl;
      $('resultAfter').alt=job.refinement?'需要确认的换物候选图局部修整版':'需要确认的换物候选图';
      $('resultDownload').href=job.resultUrl+'?download=1';$('workflowDownload').href=job.workflowUrl+'?download=1';
      $('resultFacts').textContent=`${v.dimensions.join(' × ')} · 改动 ${v.changedPercent}% · ${job.refinement?'合并修整选区外':'选区外'}最大像素差 ${v.maxChangeOutsideMask}`+(job.placement?` · 摆放 ${Math.round(job.placement.width)} × ${Math.round(job.placement.height)} px`:'')+(v.productMaxPixelDifference===0?(v.productToneApplied?' · 调色后商品核心像素差 0':' · 商品保真像素差 0'):'')+(job.refinement?` · 本次修整 ${v.refinementChangedPercent}%`:'');
      $('correctionStatus').textContent='';$('reviewIssue').value='';$('correctionNote').value='';
    }
    $('correctionPanel').hidden=!resultReady;
    $('reviewPanel').hidden=!resultReady;
    const accepted=job.humanReview?.decision==='accepted'&&(job.humanReview.revision||null)===(job.refinement?.revision||null);
    $('humanReviewStatus').textContent=accepted?'已接受这版结果 · 人工验收记录已保存。': '';
    $('acceptResult').textContent=accepted?'已接受这版结果':'接受这版结果';
    $('acceptResult').disabled=!!accepted||submitting;
    $('correctionPanel').hidden=!resultReady||!!accepted;
    $('acceptResult').onclick=async()=>{
      if(!job||job.status!=='succeeded'||accepted||submitting)return;
      submitting=true;$('acceptResult').disabled=true;$('humanReviewStatus').textContent='正在保存人工验收结论…';
      try{
        const response=await api(`/api/jobs/${job.id}/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'accepted',revision:job.refinement?.revision||null})});
        accept(response.job);
      }catch(error){$('humanReviewStatus').textContent=error.message||'验收结论暂未保存，请重试。';$('acceptResult').disabled=false;}
      finally{submitting=false;}
    };
    correctionControls();
  }
  function accept(next){job=next;render();clearTimeout(pollTimer);if(job&&!done(job))pollTimer=setTimeout(poll,2000);}
  async function poll(){if(!job||done(job))return;try{accept((await api('/api/jobs/'+job.id)).job);}catch{$('jobHelp').textContent='与页面服务的连接暂时中断，正在重新连接。不会重复提交任务。';pollTimer=setTimeout(poll,4000);}}
  async function check(){
    clearTimeout(connectionRetry);
    $('checkConnection').disabled=true;
    try{connection=await api('/api/health');$('connectionStatus').textContent=(connection.shared?connection.message.replaceAll('本机','主机'):connection.message)+(connection.ready?' · '+(connection.mode==='cpu'?'主机 CPU 运算':'主机 GPU 运算'):'');$('connectionStatus').classList.toggle('offline',!connection.ready);
      const latest=(await api('/api/jobs/latest')).job;if(latest)accept(latest);
    }catch{connection={ready:false};$('connectionStatus').textContent='主机服务暂未响应，请联系主机管理员。';}
    finally{$('checkConnection').disabled=false;controls();if(!connection?.ready)connectionRetry=setTimeout(check,10000);}
  }
  $('checkConnection').onclick=check;
  $('generateBtn').onclick=async()=>{
    if(submitting||job&&!done(job)||!connection?.ready||!eligible())return;
    submitting=true;controls();let requestId;
    try{
      const input=await snapshot();requestId=makeRequestId();const [source,product,mask,foreground]=await Promise.all([base64(input.source),base64(input.product),base64(input.mask),base64(input.foreground)]);
      const backgroundGuard=input.backgroundGuard?await base64(input.backgroundGuard):undefined;
      const backgroundMask=input.backgroundMask?await base64(input.backgroundMask):undefined;
      const result=await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,source,product,mask,foreground,backgroundGuard,backgroundMask,backgroundOnlyGeneration:input.backgroundOnlyGeneration,integrateGeneratedEdges:input.integrateGeneratedEdges,productTone:input.productTone,preserveProduct:input.preserveProduct,instructions:input.instructions,placement:input.placement})});accept(result.job);$('jobPanel').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){notify(error.message||'提交失败，请稍后重试。',true);try{const latest=(await api('/api/jobs/latest')).job;if(latest)accept(latest);}catch{connection={ready:false};$('connectionStatus').textContent='提交状态暂未确认。请点重新检查，找回任务后再操作。';}}
    finally{submitting=false;controls();}
  };
  $('cancelJob').onclick=async()=>{if(!job||done(job))return;$('cancelJob').disabled=true;try{accept((await api('/api/jobs/'+job.id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).job);}catch(error){notify('取消暂未确认：'+error.message,true);$('cancelJob').disabled=false;}};
  $('reviewIssue').onchange=correctionControls;$('correctionNote').oninput=correctionControls;
  $('correctionRetry').onclick=async()=>{
    if(submitting||!job||job.status!=='succeeded')return;
    const issue=getResultIssue($('reviewIssue').value);if(!issue?.canRegenerate)return;
    submitting=true;correctionControls();$('correctionStatus').textContent='正在提交定向纠错任务…';
    try{
      const response=await api(`/api/jobs/${job.id}/corrections`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:makeRequestId(),issueCode:issue.code,note:$('correctionNote').value})});
      $('correctionStatus').textContent=`已提交第 ${response.job.correction?.attemptIndex||''} 次人工定向纠错；结果仍需重新审核。`;
      accept(response.job);$('jobPanel').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){$('correctionStatus').textContent=error.message||'暂时无法提交，请稍后重试。';}
    finally{submitting=false;correctionControls();controls();}
  };
  $('resultRange').oninput=event=>{$('resultAfter').style.clipPath=`inset(0 ${100-event.target.value}% 0 0)`;$('resultLine').style.left=`${event.target.value}%`;};
  setInterval(()=>{if(job&&!done(job))$('jobElapsed').textContent='已用时 '+duration(Date.now()-job.startedAt);},1000);
  void check();return {update:controls};
}

