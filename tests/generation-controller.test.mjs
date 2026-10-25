import test from 'node:test';
import assert from 'node:assert/strict';
import {connectGeneration} from '../dist/generation.js';

test('review candidate UI clears every stale result link and image when protection evidence is blocked',async()=>{
  const originals=Object.fromEntries(['document','fetch','setInterval','setTimeout','clearTimeout'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{style:{},classes:new Map(),classList:{toggle(name,value){element(id).classes.set(name,value);}},removeAttribute(name){delete this[name];},scrollIntoView(){}});return elements.get(id);};
  const verification={dimensions:[80,100],changedPercent:1,maxChangeOutsideMask:0,productMaxPixelDifference:0};
  const candidate={id:'candidate-id',status:'succeeded',stage:'候选结果 · 需要确认',startedAt:1,finishedAt:2,verification,quality:{status:'needsReview',accepted:false,hardChecks:{passed:true},summary:'像素保护检查通过，图片仍需确认。',nextActions:['放大检查商品轮廓。']},resultUrl:'/candidate.png',sourceUrl:'/source.png',workflowUrl:'/workflow.json',baselineUrl:'/baseline.png',guideUrl:'/guide.png'};
  let latest=candidate;
  try{
    globalThis.document={getElementById:element};globalThis.setInterval=()=>0;globalThis.setTimeout=()=>0;globalThis.clearTimeout=()=>{};
    globalThis.fetch=async url=>({ok:true,json:async()=>url==='/api/health'?{ready:true,message:'主机已连接',mode:'cpu'}:{job:latest}});
    connectGeneration({snapshot:async()=>{throw Error('This test must not submit generation.');},eligible:()=>true,notify(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(element('resultArea').hidden,false);assert.equal(element('resultDownload').href,'/candidate.png?download=1');assert.match(element('resultQuality').textContent,/需要确认/);assert.equal(element('resultAfter').src,'/candidate.png');
    latest={...candidate,baselineUrl:null};await element('checkConnection').onclick();assert.equal(element('baselineDownload').hidden,true);assert.equal(element('baselineDownload').href,undefined);assert.equal(element('resultArea').hidden,false);
    latest={...candidate,quality:{status:'failed',accepted:false,hardChecks:{passed:false},summary:'结果未通过像素保护检查，已停止交付。'}};
    await element('checkConnection').onclick();
    assert.equal(element('resultArea').hidden,true);assert.equal(element('jobIndicator').classes.get('failed'),true);
    for(const id of ['resultDownload','baselineDownload','guideDownload','workflowDownload'])assert.equal(element(id).href,undefined,id);
    for(const id of ['resultBefore','resultAfter'])assert.equal(element(id).src,undefined,id);
    latest={...candidate,quality:undefined};await element('checkConnection').onclick();assert.equal(element('resultArea').hidden,true);
    latest=candidate;await element('checkConnection').onclick();assert.equal(element('resultArea').hidden,false);assert.equal(element('resultAfter').src,'/candidate.png');
  }finally{for(const [name,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
});

test('manual review can submit a categorized hair correction and retains it as a separate intervention',async()=>{
  const originals=Object.fromEntries(['document','fetch','setInterval','setTimeout','clearTimeout'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'',classes:new Map(),classList:{toggle(name,value){element(id).classes.set(name,value);}},removeAttribute(name){delete this[name];},scrollIntoView(){}});return elements.get(id);};
  const verified={dimensions:[80,100],changedPercent:1,maxChangeOutsideMask:0,productMaxPixelDifference:0};
  const parent={id:'parent-id',status:'succeeded',startedAt:1,finishedAt:2,verification:verified,quality:{status:'needsReview',accepted:false,hardChecks:{passed:true},summary:'候选图需要确认。',nextActions:['确认发丝融合。']},resultUrl:'/parent.png',sourceUrl:'/source.png',workflowUrl:'/workflow.json',correctionAttemptsRemaining:2};
  const child={...parent,id:'child-id',status:'waiting',quality:null,correction:{issueCode:'hair_blend',attemptIndex:1,manualIntervention:true}};
  let posted;
  try{
    globalThis.document={getElementById:element};globalThis.setInterval=()=>0;globalThis.setTimeout=()=>0;globalThis.clearTimeout=()=>{};
    globalThis.fetch=async(url,options={})=>{
      if(url==='/api/health')return{ok:true,status:200,json:async()=>({ready:true,message:'主机已连接',mode:'cpu'})};
      if(url==='/api/jobs/latest')return{ok:true,status:200,json:async()=>({job:parent})};
      if(url.endsWith('/corrections')){posted={url,body:JSON.parse(options.body)};return{ok:true,status:202,json:async()=>({job:child})};}
      throw new Error('Unexpected request '+url);
    };
    connectGeneration({snapshot:async()=>{throw Error('No new upload is needed.');},eligible:()=>true,notify(){}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(element('correctionPanel').hidden,false);
    element('reviewIssue').value='hair_blend';element('reviewIssue').onchange();
    assert.match(element('correctionPromptPreview').textContent,/短而平行的刷痕/);
    assert.equal(element('correctionRetry').disabled,false);
    await element('correctionRetry').onclick();
    assert.match(posted.url,/parent-id\/corrections$/);assert.equal(posted.body.issueCode,'hair_blend');
    assert.equal(element('correctionPanel').hidden,true);assert.match(element('correctionStatus').textContent,/第 1 次人工定向纠错/);
  }finally{for(const [name,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
});
