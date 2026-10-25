import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomInt} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildWorkflow,MODELS} from './workflow.mjs';
import {readRefinement} from './refinement.mjs';
import {assessResultQuality} from './result-quality.mjs';
import {nextComfyProgress} from './job-progress.mjs';
import {buildCorrectionPrompt,getResultIssue} from './dist/result-correction.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const jobRoot=process.env.SWAP_JOB_DIR||path.join(root,'.runtime','jobs');fs.mkdirSync(jobRoot,{recursive:true});
const python=process.env.SWAP_PYTHON||path.resolve(root,'../ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe');
const comfy=process.env.SWAP_COMFY_URL||'http://127.0.0.1:8188';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(comfy))throw new Error('ComfyUI 地址必须是本机端口。');
const terminal=new Set(['succeeded','failed','cancelled']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const jobs=new Map();let active=null,idleTimer;
const shared=process.env.SWAP_SHARED==='1';
const waiting=()=>[...jobs.values()].filter(job=>job.status==='waiting').sort((a,b)=>a.startedAt-b.startedAt);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const jobDirectory=id=>uuid.test(id)?path.join(jobRoot,id):null;
function persist(job){job.updatedAt=Date.now();const target=path.join(jobDirectory(job.id),'job.json');fs.writeFileSync(target+'.tmp',JSON.stringify(job,null,2));fs.renameSync(target+'.tmp',target);}
function change(job,values){Object.assign(job,values);persist(job);}
export function publicJob(job){
  if(!job)return null;
  const {id,status,stage,startedAt,processingStartedAt,finishedAt,updatedAt,promptId,step,steps,error,seed,verification,cancelRequested,placement}=job;
  const queuePosition=status==='waiting'?waiting().findIndex(item=>item.id===id)+1:0;
  const refinement=status==='succeeded'?readRefinement(jobDirectory(id),id):null;
  const baselineQuality=status==='succeeded'?assessResultQuality(verification,job):null;
  const quality=status==='succeeded'?assessResultQuality(refinement?.verification||verification,job):job.quality||null;
  if(quality&&job.humanReview?.decision==='accepted'&&(job.humanReview.revision||null)===(refinement?.revision||null)){
    quality.accepted=true;quality.visualAcceptance='accepted';quality.humanReview={decision:'accepted',revision:job.humanReview.revision||null,reviewedAt:job.humanReview.reviewedAt};
  }
  const deliverable=status==='succeeded'&&quality?.hardChecks?.passed===true;
  const correctionRootId=job.correction?.rootJobId||job.id;
  const correctionsUsed=[...jobs.values()].filter(item=>item.correction?.rootJobId===correctionRootId).length;
  return{id,status,stage:queuePosition?`排队中 · 前面还有 ${queuePosition-1+(active?1:0)} 个任务`:status==='succeeded'?(quality.status==='failed'?'结果保护检查失败':quality.visualAcceptance==='accepted'?'候选结果 · 人工已接受':refinement?'候选结果 · 已修整，需确认':'候选结果 · 需要确认'):stage,queuePosition,startedAt,processingStartedAt,finishedAt,updatedAt,promptId,step,steps,error,seed,verification:refinement?.verification||verification,quality,cancelRequested,placement,
    refinement:refinement?{revision:refinement.revision,description:refinement.description,generatedAgain:false}:null,
    correction:job.correction?{issueCode:job.correction.issueCode,attemptIndex:job.correction.attemptIndex,manualIntervention:true}:null,
    correctionAttemptsUsed:correctionsUsed,correctionAttemptsRemaining:Math.max(0,2-correctionsUsed),humanReview:job.humanReview||null,
    baselineUrl:refinement&&baselineQuality.hardChecks.passed?`/api/jobs/${id}/result.png`:null,
    guideUrl:placement?`/api/jobs/${id}/placement-guide.png`:null,
    resultUrl:deliverable?(refinement?`/api/jobs/${id}/refinements/${refinement.revision}/result.png`:`/api/jobs/${id}/result.png`):null,
    sourceUrl:`/api/jobs/${id}/source.png`,workflowUrl:`/api/jobs/${id}/workflow.json`};
}
export function getJob(id){return jobs.get(id);}
export function acceptReview(job,body,owner='local'){
  if(!job||((job.owner||'local')!==owner))throw Object.assign(new Error('任务不存在。'),{status:404});
  if(job.status!=='succeeded')throw Object.assign(new Error('只有已完成的候选结果可以确认。'),{status:409});
  const current=readRefinement(jobDirectory(job.id),job.id);
  const revision=current?.revision||null;
  if((body.revision||null)!==revision)throw Object.assign(new Error('候选版本已变化，请刷新后重新确认。'),{status:409});
  const quality=assessResultQuality(current?.verification||job.verification,job);
  if(quality.hardChecks.passed!==true)throw Object.assign(new Error('该候选未通过像素保护检查，暂不能确认。'),{status:409});
  change(job,{humanReview:{decision:'accepted',revision,reviewedAt:Date.now()}});
  return publicJob(job);
}
export function latestJob(owner='local'){return [...jobs.values()].filter(job=>(job.owner||'local')===owner).sort((a,b)=>b.startedAt-a.startedAt)[0];}
async function api(route,options={}){const response=await fetch(comfy+route,{...options,signal:AbortSignal.timeout(15000)});let data;try{data=await response.json();}catch{data={};}if(!response.ok)throw Object.assign(new Error(data.error?.message||data.error||`ComfyUI 请求失败 (${response.status})`),{httpStatus:response.status});return data;}
const post=(route,data)=>api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
export async function health(){
  try{const stats=await api('/system_stats'),info=await api('/object_info');
    const missing=['UnetLoaderGGUF','CLIPLoaderGGUF','VAELoader','ReferenceLatent','Flux2Scheduler','SamplerCustomAdvanced','VAEDecodeTiled','ImageCompositeMasked'].filter(name=>!info[name]);
    for(const [type,input,value] of [['UnetLoaderGGUF','unet_name',MODELS.unet],['CLIPLoaderGGUF','clip_name',MODELS.clip],['VAELoader','vae_name',MODELS.vae]])if(!info[type]?.input?.required?.[input]?.[0]?.includes(value))missing.push(value);
    return {ready:missing.length===0,mode:stats.devices?.[0]?.type||'unknown',message:missing.length?'缺少模型或节点：'+missing.join('、'):'ComfyUI 已连接',activeJobId:active,version:stats.system?.comfyui_version};
  }catch{return {ready:false,message:'未连接到本机 ComfyUI，请先启动 ComfyUI，再点重新检查。',activeJobId:active};}
}
function runImages(mode,dir){return new Promise((resolve,reject)=>{
  const child=spawn(python,['-X','utf8',path.join(root,'image_pipeline.py'),mode,dir],{windowsHide:true});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('图片处理超时，请尝试较小的图片。'));},120000);
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr.trim()||'图片处理失败'));else try{resolve(JSON.parse(stdout));}catch{reject(new Error('无法读取图片处理结果'));}});
});}
function decodeInput(value,name){if(typeof value!=='string'||!value.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error(`${name}文件无效`);const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>20*1024*1024)throw new Error(`${name}不能超过 20 MB`);return bytes;}
export function createJob(body,owner='local',correction=null){
  if(!uuid.test(body.requestId||''))throw new Error('缺少有效的任务标识，请刷新页面。');
  const existing=[...jobs.values()].find(job=>job.requestId===body.requestId&&(job.owner||'local')===owner);if(existing)return existing;
  if(body.seed!==undefined&&(!Number.isSafeInteger(body.seed)||body.seed<1||body.seed>2**32-1))throw new Error('随机种子必须是 1 到 4294967295 之间的安全整数。');
  if((!shared&&active)||[...jobs.values()].some(job=>(job.owner||'local')===owner&&!terminal.has(job.status))){const error=new Error('你已有任务正在处理，请完成或取消后再提交。');error.status=409;throw error;}
  if(waiting().length>=10)throw Object.assign(new Error('等待队列已满，请稍后提交。'),{status:429});
  if(body.productTone!==undefined&&(!body.productTone||typeof body.productTone!=='object'||!['saturation','contrast'].every(k=>typeof body.productTone[k]==='number'&&Number.isFinite(body.productTone[k])&&body.productTone[k]>=.7&&body.productTone[k]<=1.05)))throw new Error('商品调色参数须在 70% 至 105% 之间。');
  if(typeof body.instructions!=='string'||body.instructions.length>1500)throw new Error('替换要求不能超过 1500 字。');
  if(body.preserveProduct!==undefined&&typeof body.preserveProduct!=='boolean')throw new Error('商品保真选项无效。');
  if(body.backgroundOnlyGeneration!==undefined&&typeof body.backgroundOnlyGeneration!=='boolean')throw new Error('背景修复选项无效。');
  if(body.integrateGeneratedEdges!==undefined&&typeof body.integrateGeneratedEdges!=='boolean')throw new Error('商品边缘融合选项无效。');
  if(body.backgroundOnlyGeneration===true&&body.preserveProduct!==true)throw new Error('背景修复模式需要开启商品保真。');
  if(body.backgroundOnlyGeneration===true&&!body.backgroundMask)throw new Error('发饰背景修复模式需要明确的旧物修复区，请先自动识别旧发饰。');
  if(body.placement!=null&&(!['x','y','width','height'].every(k=>Number.isFinite(body.placement[k]))||body.placement.width<1||body.placement.height<1))throw new Error('商品位置无效，请重新摆放。');
  const files={source:decodeInput(body.source,'人物图'),product:decodeInput(body.product,'商品图'),mask:decodeInput(body.mask,'蒙版')};
  if(body.foreground)files.foreground=decodeInput(body.foreground,'手指保护区');
  if(body.backgroundGuard)files['background-guard']=decodeInput(body.backgroundGuard,'背景保护区');
  if(body.backgroundMask)files['background-mask']=decodeInput(body.backgroundMask,'旧物背景修复区');
  const id=randomUUID(),dir=jobDirectory(id);fs.mkdirSync(dir);
  for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(dir,name+'.upload'),bytes);
  const job={id,owner,requestId:body.requestId,status:'waiting',stage:'等待主机处理',instructions:body.instructions,placement:body.placement||null,preserveProduct:body.preserveProduct===true,seed:body.seed===undefined?randomInt(1,2**32):body.seed,startedAt:Date.now(),promptId:randomUUID()};
  if(body.productTone)job.productTone={saturation:body.productTone.saturation,contrast:body.productTone.contrast};
  if(body.backgroundOnlyGeneration===true)job.backgroundOnlyGeneration=true;
  if(body.integrateGeneratedEdges===true||(job.preserveProduct&&body.backgroundOnlyGeneration!==true))job.integrateGeneratedEdges=true;
  if(correction)job.correction=correction;
  jobs.set(id,job);persist(job);drain();return job;
}
export function createCorrectionJob(parent,body,owner='local'){
  if(!parent||!uuid.test(parent.id)||((parent.owner||'local')!==owner))throw Object.assign(new Error('任务不存在。'),{status:404});
  if(parent.status!=='succeeded')throw Object.assign(new Error('只有已完成且待确认的候选图可以定向重生成。'),{status:409});
  const quality=publicJob(parent).quality;
  if(quality?.hardChecks?.passed!==true)throw Object.assign(new Error('该结果未通过像素保护检查，不能重生成交付。'),{status:409});
  if(!uuid.test(body.requestId||''))throw new Error('缺少有效的任务标识，请刷新页面。');
  const issue=getResultIssue(body.issueCode);
  const prompt=buildCorrectionPrompt(body.issueCode,body.note||'');
  const rootJobId=parent.correction?.rootJobId||parent.id;
  const correctionsUsed=[...jobs.values()].filter(item=>item.correction?.rootJobId===rootJobId).length;
  if(correctionsUsed>=2)throw Object.assign(new Error('本组素材已用完 2 次定向纠错机会，请调整素材或位置后新建任务。'),{status:409});
  const directory=jobDirectory(parent.id),read=name=>{
    const file=path.join(directory,name+'.upload');
    if(!fs.existsSync(file))throw Object.assign(new Error('原始素材或选区记录不完整，请回到编辑器重新提交。'),{status:409});
    return fs.readFileSync(file).toString('base64');
  };
  const instructions=parent.backgroundOnlyGeneration?prompt:[parent.instructions,prompt].filter(Boolean).join('\n');
  const correction={rootJobId,parentJobId:parent.id,issueCode:issue.code,attemptIndex:correctionsUsed+1,manualIntervention:true};
  return createJob({requestId:body.requestId,source:read('source'),product:read('product'),mask:read('mask'),foreground:fs.existsSync(path.join(directory,'foreground.upload'))?read('foreground'):undefined,
    backgroundGuard:fs.existsSync(path.join(directory,'background-guard.upload'))?read('background-guard'):undefined,
    backgroundMask:fs.existsSync(path.join(directory,'background-mask.upload'))?read('background-mask'):undefined,
    productTone:parent.productTone,integrateGeneratedEdges:parent.integrateGeneratedEdges,backgroundOnlyGeneration:parent.backgroundOnlyGeneration===true,preserveProduct:parent.preserveProduct===true,placement:parent.placement,instructions},owner,correction);
}
function drain(){
  clearTimeout(idleTimer);if(active)return;
  const job=waiting()[0];
  if(job){active=job.id;change(job,{status:'preparing',stage:'检查图片、选区和商品位置',processingStartedAt:Date.now()});void execute(job);}
  else if(shared){idleTimer=setTimeout(async()=>{if(active||waiting().length)return;try{const q=await api('/queue');if(!active&&!q.queue_running?.length&&!q.queue_pending?.length)await post('/free',{unload_models:true,free_memory:true});}catch{}},60000);idleTimer.unref();}
}
async function upload(dir,name,id){const form=new FormData();form.set('image',new Blob([fs.readFileSync(path.join(dir,name+'.png'))],{type:'image/png'}),name+'.png');form.set('subfolder','swap_studio/'+id);form.set('type','input');form.set('overwrite','true');const result=await api('/upload/image',{method:'POST',body:form});return(result.subfolder?result.subfolder+'/':'')+result.name;}
function watch(job,graph){
  if(!graph)try{graph=JSON.parse(fs.readFileSync(path.join(jobDirectory(job.id),'workflow.json'),'utf8'));}catch{graph={};}
  let executingNode=null;
  const ws=new WebSocket(`${comfy.replace('http:','ws:')}/ws?clientId=${job.id}`);ws.addEventListener('error',()=>{});
  ws.addEventListener('message',event=>{if(typeof event.data!=='string')return;try{const {type,data}=JSON.parse(event.data);if(data?.prompt_id!==job.promptId||terminal.has(job.status)||job.cancelRequested)return;
    const update=nextComfyProgress({...job,executingNode},type,data,graph);
    if(update){const {executingNode:node,...values}=update;executingNode=node;change(job,values);}
  }catch{}});return ws;
}
async function stopPrompt(job){await post('/queue',{delete:[job.promptId]});await post('/interrupt',{prompt_id:job.promptId});}
async function waitForResult(job){
  let failures=0;const deadline=(job.processingStartedAt||job.startedAt)+45*60*1000;
  while(Date.now()<deadline){
    try{const history=await api('/history/'+job.promptId);
      if(history[job.promptId]){const result=history[job.promptId];if(job.cancelRequested)throw new Error('任务已取消。');if(result.status?.status_str!=='success'){const detail=result.status?.messages?.find(item=>item[0]==='execution_error')?.[1];throw Object.assign(new Error(detail?.exception_message||'ComfyUI 执行失败，请查看模型日志。'),{execution:true});}return result;}
      const queue=await api('/queue');failures=0;const running=queue.queue_running?.some(item=>item[1]===job.promptId),pending=queue.queue_pending?.some(item=>item[1]===job.promptId);
      if(job.cancelRequested&&!running&&!pending)throw new Error('任务已取消。');
      if(job.cancelRequested&&(running||pending))await stopPrompt(job);
      if(running&&job.status==='queued')change(job,{status:'running',stage:'ComfyUI 正在加载并处理图片'});
      if(!running&&!pending){if(job.missingSince&&Date.now()-job.missingSince>15000)throw Object.assign(new Error('ComfyUI 中未找到该任务，可能服务已重启。请重新生成。'),{execution:true});job.missingSince??=Date.now();}else delete job.missingSince;
    }catch(error){if(error.execution||error.message==='任务已取消。')throw error;if(++failures===3)change(job,{stage:'与 ComfyUI 暂时断开，正在重新连接'});}
    await delay(2000);
  }
  await stopPrompt(job);throw new Error('任务超过 45 分钟，已停止本任务。请缩小选区后重试。');
}
async function execute(job,resume=false){let ws;
  try{
    const dir=jobDirectory(job.id);
    if(!resume){const connection=await health();if(!connection.ready)throw new Error(connection.message);
      const meta=await runImages('prepare',dir);if(job.cancelRequested)throw new Error('任务已取消。');
      change(job,{stage:'向本机 ComfyUI 提交素材'});
      const source=await upload(dir,'source',job.id),product=await upload(dir,'product',job.id),mask=await upload(dir,'mask-crop',job.id);
      const guide=meta.placement?await upload(dir,meta.backgroundOnlyGeneration?'background-guide':'placement-guide',job.id):null;
      const graph=buildWorkflow(meta,{source,product,mask,guide,id:job.id},job.instructions,job.seed,job.correction?job.instructions:'');fs.writeFileSync(path.join(dir,'workflow.json'),JSON.stringify(graph,null,2));
      if(job.cancelRequested)throw new Error('任务已取消。');
      ws=watch(job,graph);change(job,{status:'queued',stage:'已提交，等待 ComfyUI 处理'});
      try{await post('/prompt',{prompt:graph,client_id:job.id,prompt_id:job.promptId});}
      catch(error){if(error.httpStatus&&error.httpStatus<500)throw error;change(job,{stage:'正在确认 ComfyUI 是否收到任务'});}
      if(job.cancelRequested)await stopPrompt(job);
    }else ws=watch(job);
    const history=await waitForResult(job);fs.writeFileSync(path.join(dir,'comfy-history.json'),JSON.stringify(history,null,2));
    const output=history.outputs?.['25']?.images?.[0];if(!output)throw new Error('ComfyUI 没有返回结果图片。');
    change(job,{status:'finalizing',stage:job.preserveProduct?'融合边缘，恢复商品原字与原图手指':'核对选区外像素并保存结果',step:null,steps:null});
    const response=await fetch(comfy+'/view?'+new URLSearchParams(output),{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('结果图片下载失败。');
    fs.writeFileSync(path.join(dir,'candidate.png'),Buffer.from(await response.arrayBuffer()));
    if(job.preserveProduct){const raw=history.outputs?.['32']?.images?.[0];if(!raw)throw new Error('缺少用于边缘融合的局部图片。');const rawResponse=await fetch(comfy+'/view?'+new URLSearchParams(raw),{signal:AbortSignal.timeout(30000)});if(!rawResponse.ok)throw new Error('局部图片读取失败。');fs.writeFileSync(path.join(dir,'raw-crop.png'),Buffer.from(await rawResponse.arrayBuffer()));}
    const verification=await runImages('finalize',dir);if(job.cancelRequested)throw new Error('任务已取消。');
    const quality=assessResultQuality(verification,job);
    change(job,{verification,quality});
    if(!quality.hardChecks.passed)throw new Error(quality.summary);
    change(job,{status:'succeeded',stage:'候选结果 · 需要确认',finishedAt:Date.now()});
  }catch(error){change(job,{status:job.cancelRequested?'cancelled':'failed',stage:job.cancelRequested?'已取消':'生成失败',error:String(error.message).slice(0,700),finishedAt:Date.now()});}
  finally{if(ws)try{ws.close();}catch{}if(active===job.id)active=null;drain();}
}
export async function cancelJob(job){if(terminal.has(job.status))return;if(job.status==='waiting'){change(job,{status:'cancelled',cancelRequested:true,stage:'已取消排队',finishedAt:Date.now()});return;}change(job,{cancelRequested:true,stage:'正在取消本任务'});if(['queued','running'].includes(job.status))await stopPrompt(job);}
for(const name of fs.readdirSync(jobRoot)){if(!uuid.test(name))continue;try{const job=JSON.parse(fs.readFileSync(path.join(jobRoot,name,'job.json'),'utf8'));if(job.id!==name)continue;jobs.set(name,job);if(!terminal.has(job.status)&&job.status!=='waiting'){if(active||job.status==='preparing')change(job,{status:'failed',stage:'服务重启，任务未提交完成',error:'请检查素材后重新生成。',finishedAt:Date.now()});else{active=job.id;void execute(job,true);}}}catch{}}
drain();
