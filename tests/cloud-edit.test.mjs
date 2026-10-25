import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCloudEditJobs} from '../cloud-edit-jobs.mjs';
import {requestImageEdit,validateResultUrl,providerError} from '../cloud-edit-provider.mjs';
import http from 'node:http';
import {createWebServer} from '../web-server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/HsAAAAASUVORK5CYII=','base64');
test('cloud adapter submits BOTH current images, never a cached result; download has no API key',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-edit-provider-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'source.jpg'),'source-current');fs.writeFileSync(path.join(dir,'product.jpg'),'product-current');let calls=0;
  const fetchImpl=async(url,options)=>{
    calls++;
    if(calls===1){const body=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer fake-secret');assert.equal(options.redirect,'error');assert.equal(body.model,'qwen-image-2.0-pro');assert.equal(body.parameters.n,1);assert.equal(body.parameters.size,'960*1280');const content=body.input.messages[0].content;assert.equal(content.length,3);assert.equal(Buffer.from(content[0].image.split(',')[1],'base64').toString(),'source-current');assert.equal(Buffer.from(content[1].image.split(',')[1],'base64').toString(),'product-current');assert.match(content[2].text,/薄纱|半透明/);return new Response(JSON.stringify({request_id:'real-request-fixture',output:{choices:[{message:{content:[{image:'https://dashscope-result.oss-cn-beijing.aliyuncs.com/output.png?Expires=123'}]}}]}}));}
    assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(png);
  };
  const result=await requestImageEdit({endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',key:'fake-secret',model:'qwen-image-2.0-pro'},dir,{size:[960,1280],review:'暖光、单处花朵',fetchImpl});
  assert.equal(calls,2);assert.equal(result.providerRequestId,'real-request-fixture');assert.deepEqual(fs.readFileSync(path.join(dir,'result.download')),png);
  for(const url of ['http://127.0.0.1/a','https://evil.example/a','https://u:p@foo.aliyuncs.com/a'])assert.throws(()=>validateResultUrl(url));
  assert.doesNotMatch(providerError(403,'Forbidden').message,/fake-secret/);
});
test('actual HTTP image-edit routes enforce session ownership, consent and persist returned files',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-edit-http-'));
  const store=createCloudEditJobs(path.join(dir,'edits'),{config:()=>({model:'fixture'}),prepare:async(mode,folder)=>{fs.writeFileSync(path.join(folder,mode==='prepare'?'source.jpg':'result.png'),png);return mode==='prepare'?{outputSize:[960,1280]}:{dimensions:[960,1280]};},inspect:async()=> '需人工检查',edit:async()=>({prompt:'submitted',providerRequestId:'provider-http'})});
  const server=createWebServer({root:path.resolve('dist'),instanceId:'test',port:0,shared:true,stateDirectory:dir,jobs:{},imageEdits:store});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const call=(route,{cookie,body,origin='http://127.0.0.1:0'}={})=>new Promise((resolve,reject)=>{
    const req=http.request(`http://127.0.0.1:${server.address().port}${route}`,{method:body?'POST':'GET',headers:{Host:'127.0.0.1:0',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await call('/api/image-edits/status')).status,401);
  const code=fs.readFileSync(path.join(dir,'access-code.txt'),'utf8').trim();
  const login=async()=>{const r=await call('/api/session',{body:{code}});return r.headers['set-cookie'][0].split(';')[0];};
  const alice=await login(),bob=await login();
  const input={requestId:'http-submit-123456',allowExternal:true,source:png.toString('base64'),product:png.toString('base64')};
  assert.equal((await call('/api/image-edits',{cookie:alice,body:input,origin:'https://wrong.example'})).status,403);
  assert.equal((await call('/api/image-edits',{cookie:alice,body:{...input,allowExternal:false}})).status,409);
  const created=await call('/api/image-edits',{cookie:alice,body:input});assert.equal(created.status,202);const {job}=JSON.parse(created.bytes);
  for(let i=0;i<100;i++){const current=JSON.parse((await call('/api/image-edits/'+job.id,{cookie:alice})).bytes).job;if(current.status!=='running')break;await new Promise(r=>setTimeout(r,5));}
  // Use actual cookie owners from the HTTP server, not the display names above.
  for(const suffix of ['', '/source.jpg','/result.png'])assert.equal((await call('/api/image-edits/'+job.id+suffix,{cookie:bob})).status,404);
  const status=JSON.parse((await call('/api/image-edits/'+job.id,{cookie:alice})).bytes).job;
  assert.equal(status.status,'succeeded');assert.equal(status.providerRequestId,'provider-http');
  const result=await call(status.resultUrl,{cookie:alice});assert.equal(result.status,200);assert.equal(result.headers['content-type'],'image/png');assert.deepEqual(result.bytes,png);
  assert.equal((await call('/api/image-edits/'+job.id+'/review',{cookie:bob,body:{decision:'accepted'}})).status,404);
  assert.equal((await call('/api/image-edits/'+job.id+'/review',{cookie:alice,body:{decision:'rejected'}})).status,200);
});
test('cloud jobs persist provenance, deduplicate submission and isolate owner assets/reviews',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-edit-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let release;const pending=new Promise(r=>release=r);let edits=0;
  const dependencies={config:()=>({model:'real-edit-model'}),prepare:async(mode,folder)=>{if(mode==='prepare'){fs.writeFileSync(path.join(folder,'source.jpg'),'prepared');return {outputSize:[960,1280]};}fs.writeFileSync(path.join(folder,'result.png'),png);return {dimensions:[960,1280]};},inspect:async(_c,_d,{result}={})=>result?'需要人工检查花瓣':'整图已扫描',edit:async()=>{edits++;await pending;return {providerRequestId:'provider-123',prompt:'actual prompt'};}};
  const store=createCloudEditJobs(dir,dependencies),input={allowExternal:true,requestId:'request-1234567890',source:Buffer.from('source').toString('base64'),product:Buffer.from('product').toString('base64')};
  assert.throws(()=>store.create({...input,allowExternal:false},'alice'),/勾选/);
  const j=store.create(input,'alice');assert.equal(store.create(input,'alice').id,j.id);
  assert.throws(()=>store.create({...input,instructions:'different'},'alice'),/提交标识/);
  assert.throws(()=>store.get(j.id,'bob'),e=>e.status===404);
  assert.throws(()=>store.file(j.id,'source.jpg','bob'),e=>e.status===404);
  assert.throws(()=>store.review(j.id,{decision:'accepted'},'alice'),e=>e.status===409);
  release();for(let i=0;i<100&&store.get(j.id,'alice').status==='running';i++)await new Promise(r=>setTimeout(r,5));
  const done=store.get(j.id,'alice');assert.equal(edits,1);assert.equal(done.status,'succeeded');assert.equal(done.providerRequestId,'provider-123');assert.equal(done.humanReview,undefined);assert.ok(done.inputHashes.source);assert.match(done.resultUrl,/result.png$/);
  assert.throws(()=>store.review(j.id,{decision:'accepted'},'bob'),e=>e.status===404);
  assert.equal(store.review(j.id,{decision:'rejected'},'alice').humanReview.decision,'rejected');
  const restored=createCloudEditJobs(dir,dependencies);assert.equal(restored.latest('alice').id,j.id);assert.equal(restored.latest('bob'),null);assert.equal(restored.create(input,'alice').id,j.id);assert.equal(edits,1);
});
