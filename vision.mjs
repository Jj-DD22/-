import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {validatePlan,parseVisionResponse,VISION_PROMPT} from './vision-plan.mjs';
import {assessSupport} from './support-policy.mjs';
import {requestPreparationReview,preparationNextActions} from './preparation-review.mjs';
import {requestCutoutReview,cutoutNextActions} from './cutout-review.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
// Keys stay on the host; this file is deliberately excluded from delivery archives.
const envFile=path.join(root,'.env.vision');
if(fs.existsSync(envFile))process.loadEnvFile(envFile);
const python=process.env.SWAP_PYTHON||path.resolve(root,'../ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe');
const storage=path.resolve(process.env.SWAP_VISION_DATA||path.join(root,'.runtime','vision'));
const presets=process.env.SWAP_VISION_PRESETS||path.join(root,'.runtime','vision-presets');
let busy=false;
function settings(){
  const url=process.env.SWAP_VISION_CHAT_URL||'',model=process.env.SWAP_VISION_MODEL||'',key=process.env.SWAP_VISION_API_KEY||'';
  if(!url||!model)return null;
  const u=new URL(url);if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))throw new Error('视觉接口地址需要 HTTPS 或本机 HTTP 地址。');
  if(u.protocol==='https:'&&!key)return null;
  const thinkingValue=process.env.SWAP_VISION_THINKING;
  if(thinkingValue!==undefined&&!['','true','false'].includes(thinkingValue))throw new Error('SWAP_VISION_THINKING 只能填 true 或 false。');
  return {url,model,key,...(thinkingValue?{thinking:thinkingValue==='true'}:{})};
}
export function visionStatus(){let config=null;try{config=settings();}catch{}
  const configured=!!config;
  return {configured,model:config?.model||null,thinking:typeof config?.thinking==='boolean'?config.thinking:null,busy,localRecipes:fs.existsSync(presets)&&fs.readdirSync(presets).some(f=>f.endsWith('.json')),message:configured?'视觉 API 已配置；分析时将发送这两张图片':'视觉 API 未接通；仅可匹配本机已审核的指定图片对，不代表支持任意新图片识别。'};
}
function run(mode,dir){return new Promise((resolve,reject)=>{
  const child=spawn(python,['-X','utf8',path.join(root,'auto_prepare.py'),mode,dir,presets],{windowsHide:true});let out='',err='';let settled=false;
  const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(data);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('自动处理超时，请缩小图片后重试。'));},90000);
  child.stdout.on('data',b=>{out+=b;if(out.length>2e6){child.kill();finish(new Error('处理结果过大。'));}});child.stderr.on('data',b=>err=(err+b).slice(-4000));
  child.on('error',()=>finish(new Error('无法启动图片处理环境，请检查 Python 路径。')));
  child.on('close',code=>{if(code!==0)return finish(new Error(err.trim().split('\n').at(-1)||'图片处理失败。'));try{finish(null,JSON.parse(out));}catch{finish(new Error('无法读取自动分析结果。'));}});
});}
function input(value){if(typeof value!=='string'||!value.length||value.length>28e6||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('图片数据无效。');const b=Buffer.from(value,'base64');if(b.length>20*1024*1024)throw new Error('图片不能超过 20 MB。');return b;}
function planEvidence(plan){return {confidence:plan.confidence,assessment:plan.assessment,productHoleCount:plan.productHoles.length,rotationDegrees:plan.placement.rotationDegrees,rotationSpecified:plan.placement.rotationSpecified,flipHorizontal:plan.placement.flipHorizontal,flipHorizontalSpecified:plan.placement.flipHorizontalSpecified};}
export async function requestVision(config,dir){
  const image=name=>({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+fs.readFileSync(path.join(dir,name+'-vision.jpg')).toString('base64')}});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
  try{
    const response=await fetch(config.url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',...(config.key?{Authorization:'Bearer '+config.key}:{})},body:JSON.stringify({model:config.model,messages:[{role:'system',content:VISION_PROMPT},{role:'user',content:[{type:'text',text:'Analyze image 1 (scene) and image 2 (product) and return the specified JSON.'},image('source'),image('product')]}],max_tokens:5000,...(typeof config.thinking==='boolean'?{enable_thinking:config.thinking}:{})})});
    if(!response.ok){await response.body?.cancel();throw new Error(`视觉服务请求失败（HTTP ${response.status}），请检查模型、额度和接口配置。`);}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>1000000){controller.abort();throw new Error('视觉响应过大。');}chunks.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('视觉服务返回格式不正确。');}
    const choice=data.choices?.[0];
    if(choice?.finish_reason==='length')throw Object.assign(new Error('视觉服务输出被截断，尚未得到完整定位数据，请重新分析。'),{code:'VISION_OUTPUT_TRUNCATED'});
    return parseVisionResponse(choice?.message?.content);
  }catch(e){if(e.name==='AbortError')throw new Error('视觉 API 响应超时，请重试。');if(e instanceof TypeError)throw new Error('无法连接视觉 API，请检查主机网络和接口地址。');throw e;}finally{clearTimeout(timer);}
}
export async function analyzeImages(body){
  if(busy)throw Object.assign(new Error('主机正在分析另一组图片，请稍后再试。'),{status:429});
  busy=true;let dir;
  try{
    const source=input(body.source),product=input(body.product);fs.mkdirSync(storage,{recursive:true});dir=path.join(storage,randomUUID());fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'source.upload'),source);fs.writeFileSync(path.join(dir,'product.upload'),product);
    const inspection=await run('inspect',dir);let plan,origin;
    const config=settings();
    if(config){
      if(body.allowExternal!==true)throw Object.assign(new Error('请先勾选允许将这两张图片发送给已配置的视觉 API，再开始自动识别。'),{status:409});
      plan=await requestVision(config,dir);origin='vision-api';
    }
    else if(inspection.recipe){plan=validatePlan(inspection.recipe);origin='reviewed-pair';}
    else{
      throw Object.assign(new Error('这组图片尚无已分析方案，视觉 API 还未配置。请配置后重试，或展开手动微调。'),{status:503});
    }
    const sceneReview=plan.sceneReview;
    if(plan.reviewOnly)return {needsReview:true,origin,sceneReview,summary:plan.summary,support:plan.support,warnings:[...plan.support.reasons.map(r=>r.message),...plan.warnings],nextActions:plan.support.reasons.map(r=>r.nextAction)};
    if(body.requireSceneReview===true&&sceneReview.blocked)return {needsReview:true,origin,sceneReview,summary:sceneReview.summary||'整图检查信息不足，请重新分析。',warnings:['本机生成器暂只支持一个摆放区域；镜内外联动不能按单处替换交付。'],nextActions:['请使用仅出现一次发饰的照片，或先完成镜像多处的人工修图。']};
    const support=assessSupport(plan);
    if(support.route==='needsReview')return {needsReview:true,origin,sceneReview,summary:plan.summary,planEvidence:planEvidence(plan),support,nextActions:support.reasons.map(r=>r.nextAction),warnings:[...support.reasons.map(r=>r.message),...plan.warnings]};
    fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify(plan));
    let result;
    try{result=await run('prepare',dir);}catch(error){
      const oldObjectSegmentationCode=error.message.match(/^OLD_OBJECT_SEGMENTATION_([A-Za-z][A-Za-z0-9]*):/)?.[1];
      if(oldObjectSegmentationCode)return {needsReview:true,origin,sceneReview,summary:'人物原图中的旧发饰边界未能可靠确认，本次未进入生成。',support:{...support,route:'needsReview',reasonCodes:['oldObjectSegmentationUncertain']},oldObjectSegmentation:{enabled:true,accepted:false,errorCode:oldObjectSegmentationCode,coordinateFrame:'full-normalized-source'},nextActions:[['runtimeUnavailable','runtimeInvalid'].includes(oldObjectSegmentationCode)?'请联系主机管理员检查旧发饰精细分割运行包，修复后重新分析。':'请补充旧发饰清晰、完整且无遮挡的人物原图，或人工确认原旧发饰清除范围。'],warnings:['旧发饰精细分割已安全停止，没有退回粗轮廓继续生成。']};
      const segmentationCode=error.message.match(/SEGMENTATION_([A-Za-z]+)/)?.[1];
      if(segmentationCode)return {needsReview:true,origin,sceneReview,summary:'精细抠图未能可靠完成，本次未进入生成。',support:{...support,route:'needsReview',reasonCodes:['segmentationUncertain']},segmentation:{enabled:true,accepted:false,errorCode:segmentationCode},nextActions:[['runtimeUnavailable','runtimeInvalid'].includes(segmentationCode)?'请联系主机管理员检查精细抠图运行包，修复后重新分析。':'请补充主体完整、轮廓清晰的商品图，或人工确认商品轮廓。'],warnings:['自动精细抠图已安全停止，没有退回粗轮廓继续生成。']};
      if(/保护区冲突|建议的商品位置超出/.test(error.message))return {needsReview:true,origin,sceneReview,summary:plan.summary,support:{...support,route:'needsReview',reasonCodes:['placementConflict']},nextActions:['请换用佩戴角度接近的参考图，或人工确认商品位置与人物保护区。'],warnings:['自动摆放与人物保护区冲突，已停止生成。']};
      throw error;
    }
    let preparationReview;
    try{
      if(!config)throw Object.assign(new Error('自动准备复核需要已配置的视觉服务。'),{code:'PREPARATION_REVIEW_UNAVAILABLE'});
      preparationReview=await requestPreparationReview(config,dir);
    }catch(error){
      return {needsReview:true,origin,sceneReview,summary:'自动抠图与摆放尚未通过准备复核。',normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:['preparationReviewUnavailable']},preparationReview:{accepted:false,errorCode:error.code||'PREPARATION_REVIEW_UNAVAILABLE'},nextActions:['请重新分析；如仍无法复核，请提供独立商品图或人工确认抠图和位置。'],warnings:[error.message]};
    }
    let outlineRecoveryReview,outlineRecoveryAttempted=false;
    const recoverableCutoutReview=review=>review?.checks?.cutoutClean===false&&review?.checks?.productComplete===true&&Array.isArray(review.reasonCodes)&&review.reasonCodes.length>0&&review.reasonCodes.every(code=>code==='sourceHair'||code==='backgroundLeak');
    if(!preparationReview.accepted&&recoverableCutoutReview(preparationReview)){
      outlineRecoveryAttempted=true;
      try{
        result=await run('prepare-outline-recovery',dir);
        const recoveredPreparation=await requestPreparationReview(config,dir);
        outlineRecoveryReview={policy:'review-triggered-sam-alpha-clipped-to-plan-outline-v1',triggerGate:'preparationReview',originalReview:preparationReview,preparationReview:recoveredPreparation};
        if(recoveredPreparation.accepted)preparationReview=recoveredPreparation;
        else return {needsReview:true,origin,sceneReview,summary:recoveredPreparation.summary,planEvidence:planEvidence(plan),normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:recoveredPreparation.reasonCodes.length?recoveredPreparation.reasonCodes:['preparationUncertain']},preparationReview,outlineRecoveryReview,nextActions:preparationNextActions(preparationReview),warnings:['自动抠图边缘经轮廓约束后仍未通过复核，本次未进入生成。']};
      }catch(error){
        outlineRecoveryReview={policy:'review-triggered-sam-alpha-clipped-to-plan-outline-v1',triggerGate:'preparationReview',originalReview:preparationReview,errorCode:error.code||'OUTLINE_RECOVERY_FAILED'};
        return {needsReview:true,origin,sceneReview,summary:preparationReview.summary,planEvidence:planEvidence(plan),normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:preparationReview.reasonCodes.length?preparationReview.reasonCodes:['preparationUncertain']},preparationReview,outlineRecoveryReview,nextActions:preparationNextActions(preparationReview),warnings:['抠图边缘恢复未能完成，本次未进入生成。']};
      }
    }
    if(!preparationReview.accepted)return {needsReview:true,origin,sceneReview,summary:preparationReview.summary,planEvidence:planEvidence(plan),normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:preparationReview.reasonCodes.length?preparationReview.reasonCodes:['preparationUncertain']},preparationReview,outlineRecoveryReview,nextActions:preparationNextActions(preparationReview),warnings:['自动抠图或摆放未通过准备复核，本次未进入生成。']};
    let cutoutReview;
    try{cutoutReview=await requestCutoutReview(config,dir);}catch(error){
      return {needsReview:true,origin,sceneReview,summary:'商品细节尚未通过复核，本次未进入生成。',normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:['cutoutReviewUnavailable']},preparationReview,cutoutReview:{accepted:false,errorCode:error.code||'CUTOUT_REVIEW_UNAVAILABLE'},nextActions:['请重新分析；如仍无法完成细节复核，请补充轮廓清晰、主体完整的独立商品图或转人工确认。'],warnings:[error.message]};
    }
    if(!outlineRecoveryAttempted&&recoverableCutoutReview(cutoutReview)){
      try{
        result=await run('prepare-outline-recovery',dir);
        const recoveredPreparation=await requestPreparationReview(config,dir);
        if(recoveredPreparation.accepted){
          const recoveredCutout=await requestCutoutReview(config,dir);
          outlineRecoveryAttempted=true;
          outlineRecoveryReview={policy:'review-triggered-sam-alpha-clipped-to-plan-outline-v1',triggerGate:'cutoutReview',originalReview:cutoutReview,preparationReview:recoveredPreparation,cutoutReview:recoveredCutout};
          if(recoveredCutout.accepted){preparationReview=recoveredPreparation;cutoutReview=recoveredCutout;}
          else cutoutReview=recoveredCutout;
        }else outlineRecoveryReview={policy:'review-triggered-sam-alpha-clipped-to-plan-outline-v1',triggerGate:'cutoutReview',originalReview:cutoutReview,preparationReview:recoveredPreparation,cutoutReview:{accepted:false,reasonCodes:['preparationUncertain']}};
      }catch(error){outlineRecoveryReview={policy:'review-triggered-sam-alpha-clipped-to-plan-outline-v1',triggerGate:'cutoutReview',originalReview:cutoutReview,errorCode:error.code||'OUTLINE_RECOVERY_FAILED'};}
    }
    const needsHumanCutoutReview=!cutoutReview.accepted&&cutoutReview.checks.productComplete===true&&cutoutReview.reasonCodes.length===1&&cutoutReview.reasonCodes[0]==='backgroundLeak';
    if(!cutoutReview.accepted&&!needsHumanCutoutReview)return {needsReview:true,origin,sceneReview,summary:cutoutReview.summary,planEvidence:planEvidence(plan),normalization:result.normalization,segmentation:result.segmentation,oldObjectSegmentation:result.oldObjectSegmentation,preparationProofs:result.preparationProofs,support:{...support,route:'needsReview',reasonCodes:cutoutReview.reasonCodes.length?cutoutReview.reasonCodes:['cutoutUncertain']},preparationReview,cutoutReview,outlineRecoveryReview,nextActions:cutoutNextActions(cutoutReview),warnings:['商品细节未通过复核，本次未进入生成。']};
    const asset=name=>'data:image/png;base64,'+fs.readFileSync(path.join(dir,name+'.png')).toString('base64');
    return {...result,origin,sceneReview,summary:plan.summary,support:needsHumanCutoutReview?{...support,route:'autoCandidate',reasonCodes:['backgroundLeak']}:support,preparationReview,cutoutReview,outlineRecoveryReview,generationCandidateRequiresHumanReview:needsHumanCutoutReview,nextActions:needsHumanCutoutReview?['请人工检查生成候选的发饰边缘；如仍有背景残留，选择“背景残留”后再次生成。']:undefined,warnings:needsHumanCutoutReview?['商品轮廓完整，但细节复核仍标记背景残留；本图只作为待人工审核的生成候选，不代表抠图或替换已通过。']:plan.warnings,source:asset('source-normalized'),product:asset('cutout'),mask:asset('permission'),foreground:asset('foreground'),background:asset('background'),backgroundGuard:asset('backgroundGuard'),backgroundMask:asset('backgroundMask')};
  }finally{
    busy=false;
    // Only remove the UUID scratch directory this call created, never user files.
    if(dir&&path.dirname(dir)===path.resolve(storage)&&/^[a-f0-9-]{36}$/.test(path.basename(dir)))fs.rmSync(dir,{recursive:true,force:true});
  }
}
