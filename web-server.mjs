import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createAccess} from './shared-access.mjs';
import {analyzeImages,visionStatus} from './vision.mjs';
import {assessResultQuality} from './result-quality.mjs';
import {readRefinement} from './refinement.mjs';
import {createCloudEditJobs} from './cloud-edit-jobs.mjs';
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
function json(res,status,data,extra={}){res.writeHead(status,{...headers,'Content-Type':types['.json'],...extra});res.end(JSON.stringify(data));}
async function body(req,limit){
  if(Number(req.headers['content-length'])>limit)throw Object.assign(new Error('上传内容过大。'),{status:413});
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>limit)throw Object.assign(new Error('上传内容过大。'),{status:413});chunks.push(chunk);}
  try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return data;}
  catch{throw Object.assign(new Error('上传内容无效，请重新选择图片。'),{status:400});}
}
function serve(req,res,file,attachment=false){
  fs.stat(file,(error,stat)=>{
    if(error||!stat.isFile())return json(res,404,{error:'文件不存在。'});
    res.writeHead(200,{...headers,'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,...(attachment?{'Content-Disposition':`attachment; filename="${path.basename(file)}"`}:{})});
    if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  });
}
import {release} from './version.mjs';
export function createWebServer({root,instanceId,port,shared=false,allowedAddresses=[],stateDirectory,jobs,imageEdits}){
  const access=shared?createAccess(stateDirectory):null;
  imageEdits??=createCloudEditJobs(path.join(stateDirectory||path.join(root,'..','.runtime'),'image-edits'));
  const hosts=new Set(['127.0.0.1','localhost',...(shared?allowedAddresses:[])].map(address=>`${address}:${port}`));
  let uploads=0;
  function resultAllowed(job,revision){
    const verification=revision?readRefinement(jobs.jobDirectory(job.id),job.id,revision)?.verification:job.verification;
    return assessResultQuality(verification,job).hardChecks.passed===true;
  }
  const server=http.createServer(async(req,res)=>{
    try{
      if(!hosts.has(req.headers.host))return json(res,403,{error:'请使用主机提供的访问地址。'});
      const url=new URL(req.url,'http://'+req.headers.host),route=decodeURIComponent(url.pathname);
      if(!['GET','HEAD','POST'].includes(req.method))return json(res,405,{error:'不支持此请求。'});
      if(req.method==='POST'&&(req.headers.origin!=='http://'+req.headers.host||!req.headers['content-type']?.startsWith('application/json')))return json(res,403,{error:'请从换物工坊页面提交。'});
      if(req.method==='GET'&&route==='/api/instance')return json(res,200,{app:'swap-studio',...release,instanceId,shared});
      if(shared&&route==='/api/session'&&req.method==='POST'){
        const value=await body(req,2048);return json(res,200,{ok:true},{'Set-Cookie':access.login(req,value.code)});
      }
      const session=shared?access.current(req):{owner:'local'};
      if(shared&&req.method==='GET'&&route==='/api/session')return json(res,200,{authenticated:!!session});
      if(shared&&['/access.js','/access.css'].includes(route)&&['GET','HEAD'].includes(req.method))return serve(req,res,path.join(root,route.slice(1)));
      if(shared&&route==='/login'&&['GET','HEAD'].includes(req.method))return serve(req,res,path.join(root,'access.html'));
      if(!session){
        if(route==='/'&&['GET','HEAD'].includes(req.method)){res.writeHead(302,{...headers,Location:'/login'});return res.end();}
        return json(res,401,{error:'请先输入访问码。'});
      }
      const owner=session.owner;
      if(req.method==='GET'&&route==='/api/image-edits/status')return json(res,200,imageEdits.status());
      if(req.method==='GET'&&route==='/api/image-edits/latest')return json(res,200,{job:imageEdits.latest(owner)});
      if(req.method==='POST'&&route==='/api/image-edits')return json(res,202,{job:imageEdits.create(await body(req,56*1024*1024),owner)});
      const imageEdit=route.match(/^\/api\/image-edits\/([a-f0-9-]{36})(?:\/(source\.jpg|product\.jpg|result\.png|review))?$/);
      if(imageEdit){
        const [,id,action]=imageEdit;
        if(req.method==='POST'&&action==='review')return json(res,200,{job:imageEdits.review(id,await body(req,2048),owner)});
        if(!['GET','HEAD'].includes(req.method)||action==='review')return json(res,405,{error:'不支持此请求。'});
        if(action)return serve(req,res,imageEdits.file(id,action,owner),url.searchParams.has('download'));
        return json(res,200,{job:imageEdits.get(id,owner)});
      }
      if(['GET','HEAD'].includes(req.method)&&route==='/api/reference-candidate.png')return serve(req,res,path.join(root,'reference-candidate.png'),url.searchParams.has('download'));
      if(req.method==='GET'&&route==='/api/vision/status')return json(res,200,visionStatus());
      if(req.method==='POST'&&route==='/api/vision/analyze'){
        if(uploads>=2||visionStatus().busy)return json(res,429,{error:'主机正在处理图片，请稍后重试。'});
        uploads++;try{return json(res,200,await analyzeImages(await body(req,56*1024*1024)));}finally{uploads--;}
      }
      if(shared&&req.method==='POST'&&route==='/api/logout')return json(res,200,{ok:true},{'Set-Cookie':access.logout(req)});
      if(req.method==='GET'&&route==='/api/health'){
        const status=await jobs.health();
        if(shared){status.busy=!!status.activeJobId;status.activeJobId=jobs.getJob(status.activeJobId)?.owner===owner?status.activeJobId:null;status.shared=true;}
        return json(res,200,status);
      }
      if(req.method==='GET'&&route==='/api/jobs/latest')return json(res,200,{job:jobs.publicJob(jobs.latestJob(owner))});
      const correctionRoute=route.match(/^\/api\/jobs\/([a-f0-9-]{36})\/corrections$/);
      if(correctionRoute){
        if(req.method!=='POST')return json(res,405,{error:'定向重生成仅支持提交请求。'});
        const parent=jobs.getJob(correctionRoute[1]);
        if(!parent||(parent.owner||'local')!==owner)return json(res,404,{error:'任务不存在。'});
        return json(res,202,{job:jobs.publicJob(jobs.createCorrectionJob(parent,await body(req,8192),owner))});
      }
      const reviewRoute=route.match(/^\/api\/jobs\/([a-f0-9-]{36})\/review$/);
      if(reviewRoute){
        if(req.method!=='POST')return json(res,405,{error:'验收结论仅支持提交。'});
        if(!jobs.acceptReview)return json(res,501,{error:'当前任务服务暂不支持记录验收结论。'});
        const job=jobs.getJob(reviewRoute[1]);
        if(!job||(job.owner||'local')!==owner)return json(res,404,{error:'任务不存在。'});
        const value=await body(req,2048);
        if(value.decision!=='accepted')return json(res,400,{error:'验收结论无效。'});
        return json(res,200,{job:jobs.acceptReview(job,value,owner)});
      }
      if(req.method==='POST'&&route==='/api/jobs'){
        if(uploads>=2)return json(res,429,{error:'主机正在接收其他图片，请稍后重试。'});
        uploads++;try{return json(res,202,{job:jobs.publicJob(jobs.createJob(await body(req,112*1024*1024),owner))});}finally{uploads--;}
      }
      const refined=route.match(/^\/api\/jobs\/([a-f0-9-]{36})\/refinements\/([a-f0-9]{12})\/(result\.png|verification\.json|manifest\.json|permission\.png)$/);
      if(refined){
        const job=jobs.getJob(refined[1]);
        if(!job||(job.owner||'local')!==owner)return json(res,404,{error:'任务不存在。'});
        if(job.status!=='succeeded')return json(res,409,{error:'结果尚未完成。'});
        if(refined[3]==='result.png'&&!resultAllowed(job,refined[2]))return json(res,409,{error:'该版本缺少有效保护记录或未通过像素保护检查，已停止交付。'});
        if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'修整版本仅支持读取。'});
        return serve(req,res,path.join(jobs.jobDirectory(job.id),'refinements',refined[2],refined[3]),url.searchParams.has('download'));
      }
      const match=route.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(result\.png|source\.png|mask\.png|product\.png|placement-guide\.png|workflow\.json|verification\.json|cancel))?$/);
      if(match){
        const job=jobs.getJob(match[1]);if(!job||(job.owner||'local')!==owner)return json(res,404,{error:'任务不存在。'});
        if(req.method==='GET'&&!match[2])return json(res,200,{job:jobs.publicJob(job)});
        if(req.method==='POST'&&match[2]==='cancel'){await jobs.cancelJob(job);return json(res,200,{job:jobs.publicJob(job)});}
        if(['GET','HEAD'].includes(req.method)&&match[2]&&match[2]!=='cancel'){
          if(match[2]==='result.png'&&job.status!=='succeeded')return json(res,409,{error:'结果尚未完成。'});
          if(match[2]==='result.png'&&!resultAllowed(job))return json(res,409,{error:'原始结果缺少有效保护记录或未通过像素保护检查，已停止交付。'});
          return serve(req,res,path.join(jobs.jobDirectory(job.id),match[2]),url.searchParams.has('download'));
        }
      }
      if(route.startsWith('/api/'))return json(res,404,{error:'接口不存在。'});
      if(req.method==='POST')return json(res,405,{error:'不支持此请求。'});
      if(shared&&route==='/app-config.js'){
        res.writeHead(200,{...headers,'Content-Type':types['.js']});
        return res.end('export const appConfig = '+JSON.stringify({demo:false,shared:true,draftDatabase:'swap-shared-'+owner})+';');
      }
      if(shared&&(route==='/'||route==='/index.html')){
        const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/ src="\.\/assets\/[^"]*"/g,'').replace('id="loadDemo"','id="loadDemo" hidden').replace('id="exampleResult"','id="exampleResult" hidden').replace('本地生成','共享工作台').replace('图片留在本机 · 不调用付费 API','主机处理 · 当前浏览器独立任务').replaceAll('本机 ComfyUI','主机 ComfyUI').replace('图片与结果保存在本机','生成素材与结果保存在主机；草稿保存在当前浏览器');
        res.writeHead(200,{...headers,'Content-Type':types['.html']});return res.end(req.method==='HEAD'?'':html);
      }
      if(shared&&!/^\/[\w-]+\.(js|css)$/.test(route))return json(res,404,{error:'文件不存在。'});
      const file=path.resolve(root,'.'+(route==='/'?'/index.html':route));
      if(!file.startsWith(root+path.sep))return json(res,403,{error:'路径无效。'});
      serve(req,res,file);
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:error.message||'请求失败。'});else res.end();}
  });
  server.requestTimeout=240000;server.headersTimeout=15000;
  return server;
}

