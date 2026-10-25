import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cloudEditConfig,inspectEdit,requestImageEdit} from './cloud-edit-provider.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),exec=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');
function decode(value){
  if(typeof value!=='string'||!value.length||value.length>28e6||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('上传图片编码无效。');
  const bytes=Buffer.from(value,'base64');if(bytes.length>20*1024*1024)throw Error('单张图片不能超过 20 MB。');return bytes;
}
async function normalize(mode,dir){
  const python=process.env.SWAP_PYTHON||path.resolve(root,'../ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe');
  try{const {stdout}=await exec(python,['-X','utf8',path.join(root,'cloud-edit-images.py'),mode,dir],{windowsHide:true,timeout:90000,maxBuffer:100000});return JSON.parse(stdout);}catch{throw Error(mode==='prepare'?'图片读取失败，请使用完整 JPG、PNG 或 WebP 图片，单张不超过 6400 万像素。':'云端结果无法读取，已保留任务记录，请联系主机检查。');}
}
export function createCloudEditJobs(directory,{config=cloudEditConfig,prepare=normalize,inspect=inspectEdit,edit=requestImageEdit}={}){
  fs.mkdirSync(directory,{recursive:true});const records=new Map();let active=null;
  const folder=id=>path.join(directory,id);
  function save(job){const dir=folder(job.id);fs.writeFileSync(path.join(dir,'job.tmp'),JSON.stringify(job,null,2));fs.renameSync(path.join(dir,'job.tmp'),path.join(dir,'job.json'));}
  for(const id of fs.readdirSync(directory))if(/^[a-f0-9-]{36}$/.test(id))try{const j=JSON.parse(fs.readFileSync(path.join(folder(id),'job.json')));if(j.id!==id)continue;if(j.status==='running'){j.status='failed';j.stage='服务重启，任务未自动重发';j.error='上次云端请求可能已受理。为避免重复扣费，未自动重试。';j.finishedAt=Date.now();save(j);}records.set(id,j);}catch{}
  const own=(id,owner)=>{const job=records.get(id);if(!job||job.owner!==owner)throw Object.assign(Error('任务不存在。'),{status:404});return job;};
  function publicJob(j){if(!j)return null;return {id:j.id,status:j.status,stage:j.stage,model:j.model,startedAt:j.startedAt,finishedAt:j.finishedAt,error:j.error,sceneReview:j.sceneReview,resultReview:j.resultReview,reviewWarning:j.reviewWarning,dimensions:j.dimensions,providerRequestId:j.providerRequestId,humanReview:j.humanReview,inputHashes:j.inputHashes,normalization:j.normalization,sourceUrl:j.normalization?`/api/image-edits/${j.id}/source.jpg`:null,productUrl:j.normalization?`/api/image-edits/${j.id}/product.jpg`:null,resultUrl:j.status==='succeeded'?`/api/image-edits/${j.id}/result.png`:null};}
  function stage(j,text){j.stage=text;save(j);}
  async function run(j,settings){
    try{
      j.normalization=await prepare('prepare',folder(j.id));stage(j,'整图视觉检查：人物、商品、材质与镜像');
      j.sceneReview=await inspect(settings,folder(j.id));stage(j,'云端图像编辑中：正在实际生成图片');
      const generated=await edit(settings,folder(j.id),{instructions:j.instructions,review:j.sceneReview,size:j.normalization.outputSize});
      j.providerRequestId=generated.providerRequestId;j.usage=generated.usage;fs.writeFileSync(path.join(folder(j.id),'prompt.txt'),generated.prompt);stage(j,'图片已返回：校验并保存结果');
      Object.assign(j,await prepare('result',folder(j.id)));stage(j,'整图复核：商品一致性、遮挡、边缘和色调');
      try{j.resultReview=await inspect(settings,folder(j.id),{result:true});}catch{j.reviewWarning='图片已生成，但自动视觉复核未完成；请人工检查全部细节。';}
      j.status='succeeded';j.stage='真实编辑结果已生成，待人工确认';j.finishedAt=Date.now();save(j);
    }catch(error){j.status='failed';j.stage='本次图像编辑未完成';j.error=error.message;j.finishedAt=Date.now();save(j);}
    finally{active=null;}
  }
  return {
    status(){const c=config();return {configured:!!c,provider:'阿里云百炼',model:c?.model||'qwen-image-2.0-pro',busy:!!active,message:c?'已配置真实图像编辑接口；模型权限以实际调用为准。':'请在主机配置百炼 Key 与图像编辑模型；当前没有可用的编辑通道。'};},
    create(body,owner){
      if(body.allowExternal!==true)throw Object.assign(Error('请勾选允许将两张图片发送至百炼图像编辑服务。'),{status:409});
      if(typeof body.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))throw Error('缺少有效提交标识。');
      const instructions=body.instructions??'';if(typeof instructions!=='string'||instructions.length>1500)throw Error('编辑要求不能超过 1500 字。');
      const source=decode(body.source),product=decode(body.product),fingerprint=hash(Buffer.concat([source,Buffer.from('\0'),product,Buffer.from(instructions)]));
      const prior=[...records.values()].find(j=>j.owner===owner&&j.requestId===body.requestId);
      if(prior){if(prior.fingerprint!==fingerprint)throw Object.assign(Error('提交标识已用于其他素材。'),{status:409});return publicJob(prior);}
      if(active)throw Object.assign(Error('主机已有云端编辑任务，请等待完成后再提交。'),{status:429});
      const settings=config();if(!settings)throw Object.assign(Error('主机尚未配置可用的图像编辑服务。'),{status:503});
      const j={id:randomUUID(),owner,requestId:body.requestId,fingerprint,inputHashes:{source:hash(source),product:hash(product)},instructions,model:settings.model,status:'running',stage:'接收原图并校正图片方向',startedAt:Date.now()};
      fs.mkdirSync(folder(j.id));fs.writeFileSync(path.join(folder(j.id),'source.upload'),source);fs.writeFileSync(path.join(folder(j.id),'product.upload'),product);save(j);records.set(j.id,j);active=j.id;void run(j,settings);return publicJob(j);
    },
    get(id,owner){return publicJob(own(id,owner));},
    latest(owner){return publicJob([...records.values()].filter(j=>j.owner===owner).sort((a,b)=>b.startedAt-a.startedAt)[0]);},
    file(id,name,owner){const j=own(id,owner);if(!['source.jpg','product.jpg','result.png'].includes(name)||(name==='result.png'&&j.status!=='succeeded'))throw Object.assign(Error('结果尚不可用。'),{status:409});return path.join(folder(id),name);},
    review(id,body,owner){const j=own(id,owner);if(j.status!=='succeeded'||!['accepted','rejected'].includes(body.decision))throw Object.assign(Error('请对已生成的结果选择接受或需修改。'),{status:409});if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>500))throw Error('反馈不能超过 500 字。');j.humanReview={decision:body.decision,note:body.note||'',reviewedAt:Date.now()};save(j);return publicJob(j);}
  };
}
