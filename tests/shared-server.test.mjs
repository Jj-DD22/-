import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {createWebServer} from '../web-server.mjs';
import {createAccess} from '../shared-access.mjs';
import {requestId} from '../dist/request-id.js';

test('LAN sessions isolate jobs, downloads, cancellation, drafts and private examples',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'swap-shared-test-'));
  const records=new Map();
  const verified=()=>({dimensions:[80,100],maxChangeOutsideMask:0,productProtectedPixels:100,productMaxPixelDifference:0,foregroundProtectedPixels:0,foregroundMaxPixelDifference:null,maxBackgroundChangeOutsideOldObject:0});
  const jobs={
    health:async()=>({ready:true,activeJobId:[...records.keys()][0]}),
    latestJob:owner=>[...records.values()].filter(j=>j.owner===owner).at(-1),
    publicJob:job=>job?{id:job.id,status:job.status,quality:job.quality,correction:job.correction}:null,
    acceptReview:(job,value,owner)=>{if((job.owner||'local')!==owner)throw Object.assign(new Error('任务不存在。'),{status:404});if(job.status!=='succeeded')throw Object.assign(new Error('只有已完成的候选结果可以确认。'),{status:409});job.humanReview={decision:value.decision,revision:value.revision,reviewedAt:Date.now()};return{id:job.id,humanReview:job.humanReview};},
    getJob:id=>records.get(id),jobDirectory:()=>directory,
    createJob:(body,owner)=>{const job={id:randomUUID(),owner,status:'succeeded',preserveProduct:true,backgroundOnlyGeneration:true,verification:verified()};records.set(job.id,job);return job;},
    createCorrectionJob:(parent,body,owner)=>{const job={id:randomUUID(),owner,status:'waiting',correction:{parentJobId:parent.id,issueCode:body.issueCode,attemptIndex:1,manualIntervention:true}};records.set(job.id,job);return job;},
    cancelJob:async job=>{job.status='cancelled';}
  };
  fs.writeFileSync(path.join(directory,'result.png'),'result');
  const revision='1234abcd5678';
  fs.mkdirSync(path.join(directory,'refinements',revision),{recursive:true});
  fs.writeFileSync(path.join(directory,'refinements',revision,'result.png'),'refined');
  const server=createWebServer({root:path.resolve('dist'),instanceId:'test',port:0,shared:true,allowedAddresses:['192.168.50.108'],stateDirectory:directory,jobs});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=(route,{cookie,body,origin='http://127.0.0.1:0',host='127.0.0.1:0',method}={})=>new Promise((resolve,reject)=>{
    const request=http.request(url+route,{method:method||(body?'POST':'GET'),headers:{Host:host,Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:new Headers(Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v]))),json:async()=>JSON.parse(text),text:async()=>text}));});request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await call('/')).status,302);
  assert.equal((await call('/api/jobs/latest')).status,401);
  assert.equal((await call('/app.js')).status,401);
  assert.equal((await call('/login')).status,200);
  assert.equal((await call('/',{host:'attacker.example:0'})).status,403);
  assert.equal((await call('/api/session',{body:{code:'wrong'}})).status,401);
  const code=fs.readFileSync(path.join(directory,'access-code.txt'),'utf8').trim();
  assert.equal((await call('/api/session',{body:{code},origin:'http://evil.example'})).status,403);
  const login=async()=>{const res=await call('/api/session',{body:{code}});assert.equal(res.status,200);const header=res.headers.get('set-cookie');assert.match(header,/HttpOnly; SameSite=Strict/);return header.split(';')[0];};
  const alice=await login(),bob=await login();
  const created=await (await call('/api/jobs',{cookie:alice,body:{requestId:requestId()}})).json();
  const id=created.job.id;
  assert.equal((await call(`/api/jobs/${id}/review`,{cookie:bob,body:{decision:'accepted',revision:null}})).status,404);
  assert.equal((await call(`/api/jobs/${id}/review`,{cookie:alice,body:{decision:'rejected'}})).status,400);
  const reviewed=await call(`/api/jobs/${id}/review`,{cookie:alice,body:{decision:'accepted',revision:null}});
  assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).job.humanReview.decision,'accepted');
  assert.equal((await call(`/api/jobs/${id}/corrections`,{cookie:bob,body:{requestId:requestId(),issueCode:'hair_blend'}})).status,404);
  const correction=await call(`/api/jobs/${id}/corrections`,{cookie:alice,body:{requestId:requestId(),issueCode:'hair_blend'}});
  assert.equal(correction.status,202);assert.equal((await correction.json()).job.correction.issueCode,'hair_blend');
  assert.equal((await call(`/api/jobs/${id}/corrections`,{cookie:alice,method:'GET'})).status,405);
  const refinementVerification=()=>({...verified(),maxChangeOutsideRefinement:0,productChangeFromPrevious:0,foregroundChangeFromPrevious:0});
  const saveRevision=(value,verification=refinementVerification())=>{
    const folder=path.join(directory,'refinements',value);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'result.png'),'refined');
    fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({schemaVersion:1,revision:value,jobId:id,generatedAgain:false}));
    fs.writeFileSync(path.join(folder,'verification.json'),JSON.stringify(verification));
  };
  saveRevision(revision);
  assert.equal((await (await call('/api/jobs/latest',{cookie:bob})).json()).job,null);
  for(const suffix of ['', '/result.png','/source.png','/mask.png','/workflow.json','/verification.json'])assert.equal((await call('/api/jobs/'+id+suffix,{cookie:bob})).status,404);
  assert.equal((await call('/api/jobs/'+id+'/cancel',{cookie:bob,body:{}})).status,404);
  assert.equal((await call('/api/jobs/'+id+'/result.png?download=1',{cookie:alice})).status,200);
  const revised='/api/jobs/'+id+'/refinements/'+revision+'/result.png';
  assert.equal((await call(revised,{cookie:bob})).status,404);
  assert.equal((await call(revised,{cookie:alice})).status,200);
  assert.equal(await (await call(revised,{cookie:alice})).text(),'refined');
  // Each exact image version needs its own valid record; another version cannot authorize it.
  records.get(id).verification.maxChangeOutsideMask=1;
  const baseline='/api/jobs/'+id+'/result.png?download=1';
  for(const method of ['GET','HEAD'])assert.equal((await call(baseline,{cookie:alice,method})).status,409);
  assert.equal((await call(revised,{cookie:alice})).status,200);
  saveRevision(revision,{...refinementVerification(),productMaxPixelDifference:1});
  for(const method of ['GET','HEAD'])assert.equal((await call(revised,{cookie:alice,method})).status,409);
  records.get(id).verification=verified();saveRevision(revision);
  const unknownRevision='000011112222',badRevision='333344445555',historicRevision='aaaabbbbcccc';
  fs.mkdirSync(path.join(directory,'refinements',unknownRevision));fs.writeFileSync(path.join(directory,'refinements',unknownRevision,'result.png'),'unverified');
  saveRevision(badRevision,{...refinementVerification(),maxChangeOutsideRefinement:1});saveRevision(historicRevision);
  for(const value of [unknownRevision,badRevision])for(const method of ['GET','HEAD'])assert.equal((await call(`/api/jobs/${id}/refinements/${value}/result.png`,{cookie:alice,method})).status,409);
  assert.equal((await call(`/api/jobs/${id}/refinements/${historicRevision}/result.png`,{cookie:alice})).status,200);
  delete records.get(id).verification;
  assert.equal((await call(baseline,{cookie:alice})).status,409);
  records.get(id).verification=verified();
  assert.equal((await call(revised,{cookie:alice,body:{}})).status,405);
  assert.equal((await call('/api/jobs/'+id+'/refinements/'+revision+'/recipe.json',{cookie:alice})).status,404);
  assert.equal((await (await call('/api/health',{cookie:bob})).json()).activeJobId,null);
  assert.equal((await call('/assets/scene.png',{cookie:alice})).status,404);
  const html=await (await call('/',{cookie:alice})).text();assert.ok(html.includes('共享工作台'));assert.ok(!html.includes('src="./assets/'));
  assert.notEqual(await (await call('/app-config.js',{cookie:alice})).text(),await (await call('/app-config.js',{cookie:bob})).text());
  assert.equal((await call('/api/jobs/'+id+'/cancel',{cookie:alice,body:{}})).status,200);
  await call('/api/logout',{cookie:alice,body:{}});assert.equal((await call('/api/jobs/latest',{cookie:alice})).status,401);
  for(let n=0;n<8;n++)assert.equal((await call('/api/session',{body:{code:'bad'}})).status,401);
  assert.equal((await call('/api/session',{body:{code:'bad'}})).status,429);
});

test('session survives restart, expires and is revoked when access code changes',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'swap-access-test-'));let clock=1000;
  try{
    const req={headers:{},socket:{remoteAddress:'test'}};
    let access=createAccess(directory,{now:()=>clock});const code=fs.readFileSync(path.join(directory,'access-code.txt'),'utf8');
    req.headers.cookie=access.login(req,code).split(';')[0];const owner=access.current(req).owner;
    access=createAccess(directory,{now:()=>clock});assert.equal(access.current(req).owner,owner);
    clock+=8*86400000;assert.equal(access.current(req),null);clock=1000;
    fs.writeFileSync(path.join(directory,'access-code.txt'),'another-valid-code');access=createAccess(directory,{now:()=>clock});assert.equal(access.current(req),null);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('request IDs work without crypto.randomUUID (LAN HTTP)',()=>{
  const original=globalThis.crypto;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:original.getRandomValues.bind(original)}});
  try{assert.match(requestId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);}finally{Object.defineProperty(globalThis,'crypto',{configurable:true,value:original});}
});
