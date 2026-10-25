import {NODE_STAGES} from './workflow.mjs';

const active=new Set(['queued','running']);
function nodeId(value){return typeof value==='string'&&value.length?value:Number.isSafeInteger(value)&&value>=0?String(value):null;}

// Counters belong to the currently executing graph node, never the whole job.
export function nextComfyProgress(job,type,data,graph={}){
  if(!job||!data||data.prompt_id!==job.promptId||!active.has(job.status)||job.cancelRequested)return null;
  if(type!=='executing'&&type!=='progress')return null;
  if(type==='executing'&&data.node===null)return {status:'running',stage:'正在读取生成结果',executingNode:null,step:null,steps:null};
  const node=data.node==null&&type==='progress'?nodeId(job.executingNode):nodeId(data.node);
  if(type==='executing'&&!node)return null;
  const kind=node?graph?.[node]?.class_type:null;
  const sampling=kind==='SamplerCustomAdvanced',decoding=kind==='VAEDecodeTiled'||kind==='VAEDecode';
  const stage=sampling?'生成局部换物':decoding?'解码图片':node&&NODE_STAGES[node]||'处理换物图片';
  const next={status:'running',stage,executingNode:node,step:null,steps:null};
  if(type!=='progress')return next;
  const valid=Number.isSafeInteger(data.value)&&Number.isSafeInteger(data.max)&&data.value>=0&&data.max>0&&data.value<=data.max;
  if(!valid)return next;
  if(sampling)return {...next,step:data.value,steps:data.max};
  if(kind==='VAEDecodeTiled')return {...next,stage:`解码图片 ${data.value}/${data.max} 块`};
  return {...next,stage:`${stage} · 当前阶段 ${data.value}/${data.max}`};
}
