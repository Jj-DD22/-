import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflow} from '../workflow.mjs';
import {nextComfyProgress} from '../job-progress.mjs';

const graph=buildWorkflow({crop:{x:0,y:0,width:80,height:100},generation:{width:256,height:320},product:{width:64,height:64}},{source:'source.png',product:'product.png',mask:'mask.png',id:'progress-fixture'},'',1);
const initial=()=>({status:'running',promptId:'this-prompt',stage:'等待处理',step:null,steps:null});
function event(job,type,data={},workflow=graph){
  const update=nextComfyProgress(job,type,{prompt_id:job.promptId,...data},workflow);
  if(update)Object.assign(job,update);
  return update;
}

test('four sampler steps followed by thirty-two decode blocks remain different stages',()=>{
  const job=initial();event(job,'executing',{node:'20'});
  assert.equal(graph['18'].inputs.steps,4);assert.equal(graph['20'].class_type,'SamplerCustomAdvanced');assert.equal(graph['21'].class_type,'VAEDecodeTiled');
  for(let value=1;value<=4;value++){event(job,'progress',{node:'20',value,max:4});assert.equal(job.step,value);assert.equal(job.steps,4);assert.equal(job.executingNode,'20');}
  event(job,'executing',{node:'21'});assert.equal(job.step,null);assert.equal(job.steps,null);assert.match(job.stage,/解码图片/);
  for(const value of [1,16,32]){event(job,'progress',{node:'21',value,max:32});assert.equal(job.stage,`解码图片 ${value}/32 块`);assert.equal(job.step,null);assert.equal(job.steps,null);}
  assert.equal(job.status,'running');
});

test('node-less progress uses the last executing node observed on this connection',()=>{
  const sampler={...initial(),executingNode:'20'};
  event(sampler,'progress',{value:3,max:4});assert.equal(sampler.step,3);assert.equal(sampler.steps,4);
  const decoder=initial();event(decoder,'executing',{node:'21'});
  event(decoder,'progress',{value:2,max:32});assert.equal(decoder.stage,'解码图片 2/32 块');assert.equal(decoder.step,null);assert.equal(decoder.steps,null);
  const explicit=initial();event(explicit,'progress',{node:21,value:1,max:32});assert.equal(explicit.executingNode,'21');assert.equal(explicit.stage,'解码图片 1/32 块');
});

test('unknown or absent nodes and absent graphs never infer sampling from totals',()=>{
  const unknown={...initial(),executingNode:'20',step:3,steps:4};
  event(unknown,'progress',{node:'not-in-graph',value:1,max:32});assert.equal(unknown.executingNode,'not-in-graph');assert.equal(unknown.step,null);assert.equal(unknown.steps,null);assert.match(unknown.stage,/当前阶段 1\/32/);assert.doesNotMatch(unknown.stage,/采样|解码/);
  const absent=initial();event(absent,'progress',{value:1,max:4});assert.equal(absent.step,null);assert.equal(absent.steps,null);assert.match(absent.stage,/当前阶段 1\/4/);
  const noGraph={...initial(),executingNode:'20'};event(noGraph,'progress',{value:2,max:4},{});assert.equal(noGraph.step,null);assert.equal(noGraph.steps,null);assert.match(noGraph.stage,/当前阶段 2\/4/);
  const resumedWithoutNode={...initial(),stage:'生成局部换物',step:3,steps:4,executingNode:null};event(resumedWithoutNode,'progress',{value:1,max:32});assert.equal(resumedWithoutNode.step,null);assert.equal(resumedWithoutNode.steps,null);assert.match(resumedWithoutNode.stage,/当前阶段 1\/32/);
});

test('every executing-node switch clears stale sampler counters',()=>{
  const job={...initial(),executingNode:'20',step:4,steps:4};
  for(const node of ['21','24','25','unknown']){
    Object.assign(job,{step:4,steps:4});event(job,'executing',{node});assert.equal(job.executingNode,node);assert.equal(job.step,null);assert.equal(job.steps,null);
  }
  event(job,'executing',{node:'20'});event(job,'progress',{value:1,max:4});assert.equal(job.step,1);assert.equal(job.steps,4);
});

test('prompt boundaries, terminal jobs and cancellation ignore unrelated progress',()=>{
  const job={...initial(),executingNode:'20',step:2,steps:4};const before=structuredClone(job);
  for(const prompt_id of [undefined,null,'another-prompt'])assert.equal(nextComfyProgress(job,'progress',{prompt_id,node:'21',value:1,max:32},graph),null);
  for(const status of ['waiting','preparing','finalizing','succeeded','failed','cancelled'])assert.equal(nextComfyProgress({...job,status},'progress',{prompt_id:job.promptId,node:'21',value:1,max:32},graph),null);
  assert.equal(nextComfyProgress({...job,cancelRequested:true},'executing',{prompt_id:job.promptId,node:'21'},graph),null);
  assert.equal(nextComfyProgress(job,'execution_cached',{prompt_id:job.promptId,node:'21'},graph),null);assert.deepEqual(job,before);
});

test('missing or malformed counters clear stale counts without inventing a ratio',()=>{
  for(const counters of [{value:1},{max:4},{value:-1,max:4},{value:5,max:4},{value:.5,max:4},{value:'1',max:4},{value:1,max:0},{value:NaN,max:4},{value:1,max:Infinity}]){
    const job={...initial(),executingNode:'20',step:3,steps:4};event(job,'progress',counters);assert.equal(job.step,null);assert.equal(job.steps,null);assert.equal(job.stage,'生成局部换物');
  }
  const zero={...initial(),executingNode:'20'};event(zero,'progress',{value:0,max:4});assert.equal(zero.step,0);assert.equal(zero.steps,4);
});

test('execution completion clears counters while result reading remains a running stage',()=>{
  const job={...initial(),executingNode:'21',step:4,steps:4};event(job,'executing',{node:null});assert.equal(job.status,'running');assert.equal(job.stage,'正在读取生成结果');assert.equal(job.executingNode,null);assert.equal(job.step,null);assert.equal(job.steps,null);
  assert.equal(nextComfyProgress(job,'executing',{prompt_id:job.promptId},graph),null);
});
