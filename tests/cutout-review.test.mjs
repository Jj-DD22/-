import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requestCutoutReview,cutoutNextActions} from '../cutout-review.mjs';

const config={url:'https://review.example.invalid/v1/chat/completions',model:'review-fixture',key:'header-only-cutout-secret'};
const passing=()=>({cutoutClean:true,productComplete:true,confidence:.95,reasonCodes:[],summary:'商品完整，细节未见来源头发或背景残留。'});
const reply=value=>new Response(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));
const files=['product-vision.jpg','review-product.jpg',...Array.from({length:4},(_,i)=>`cutout-detail-${i+1}.jpg`)];
async function fixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swap-cutout-review-')),original=globalThis.fetch;
  try{for(const file of files)fs.writeFileSync(path.join(dir,file),file+'-fixture');await run(dir);}
  finally{globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
}

test('detail review sends the original, full white cutout and four ordered quadrant proofs only',async()=>fixture(async dir=>{
  let received;
  globalThis.fetch=async(url,options)=>{received={url,...options};return reply(passing());};
  const result=await requestCutoutReview(config,dir);
  assert.equal(result.accepted,true);assert.deepEqual(result.checks,{cutoutClean:true,productComplete:true});
  assert.equal(received.url,config.url);assert.equal(received.redirect,'error');assert.equal(received.headers.Authorization,'Bearer '+config.key);assert.equal(received.body.includes(config.key),false);
  const payload=JSON.parse(received.body),images=payload.messages[1].content.filter(item=>item.type==='image_url');
  assert.equal(payload.model,config.model);assert.equal(images.length,6);assert.equal('enable_thinking' in payload,false);
  for(const [index,file] of files.entries()){assert.ok(images[index].image_url.url.startsWith('data:image/jpeg;base64,'));assert.equal(Buffer.from(images[index].image_url.url.split(',')[1],'base64').toString(),file+'-fixture');}
  await requestCutoutReview({...config,thinking:false},dir);assert.equal(JSON.parse(received.body).enable_thinking,false);
}));

test('detail defects, uncertainty and low confidence cannot pass and produce specific next steps',async()=>fixture(async dir=>{
  for(const value of [{...passing(),cutoutClean:false,reasonCodes:['sourceHair']},{...passing(),productComplete:false,reasonCodes:['incompleteProduct']},{...passing(),cutoutClean:null},{...passing(),productComplete:null,reasonCodes:['uncertain']},{...passing(),confidence:.849},{...passing(),reasonCodes:['backgroundLeak']}]){
    globalThis.fetch=async()=>reply(value);const review=await requestCutoutReview(config,dir);assert.equal(review.accepted,false);assert.ok(cutoutNextActions(review).length);
  }
  assert.match(cutoutNextActions({checks:{cutoutClean:false},reasonCodes:['sourceHair']})[0],/来源头发/);
  assert.match(cutoutNextActions({checks:{productComplete:false},reasonCodes:['incompleteProduct']})[0],/完整/);
  globalThis.fetch=async()=>reply({...passing(),confidence:.85});assert.equal((await requestCutoutReview(config,dir)).accepted,true);
}));

test('detail review rejects prose, missing checks and invalid contracts instead of guessing',async()=>fixture(async dir=>{
  for(const value of ['Here is the review '+JSON.stringify(passing()),'{broken',{}, {...passing(),cutoutClean:'true'},{...passing(),productComplete:undefined},{...passing(),confidence:1.1},{...passing(),confidence:'0.95'},{...passing(),reasonCodes:['placementMismatch']},{...passing(),summary:'English only'},{...passing(),reasonCodes:'sourceHair'}]){
    globalThis.fetch=async()=>reply(value);await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_INVALID');
  }
  globalThis.fetch=async()=>reply('```json\n'+JSON.stringify(passing())+'\n```');assert.equal((await requestCutoutReview(config,dir)).accepted,true);
}));

test('detail review errors never expose provider payloads or credentials',async()=>fixture(async dir=>{
  globalThis.fetch=async()=>new Response('private provider detail '+config.key,{status:401});
  await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_HTTP'&&e.httpStatus===401&&!e.message.includes('private provider')&&!e.message.includes(config.key));
  globalThis.fetch=async()=>{throw new TypeError('private transport '+config.key);};
  await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_CONNECTION'&&!e.message.includes('private transport')&&!e.message.includes(config.key));
}));

test('detail review requires all six inputs and bounds the full provider response',async()=>fixture(async dir=>{
  globalThis.fetch=async()=>new Response('x'.repeat(1000001));
  await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_TOO_LARGE');
  globalThis.fetch=async()=>new Response(null);
  await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_INVALID');
  fs.unlinkSync(path.join(dir,'cutout-detail-4.jpg'));
  globalThis.fetch=async()=>{throw Error('No external request is allowed with incomplete proofs');};
  await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_INPUT');
}));

test('detail review times out safely after its bounded deadline',async()=>fixture(async dir=>{
  const originalTimer=globalThis.setTimeout;
  try{
    globalThis.setTimeout=(callback,ms,...args)=>originalTimer(callback,ms===120000?1:ms,...args);
    globalThis.fetch=async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('private timeout payload','AbortError')),{once:true}));
    await assert.rejects(()=>requestCutoutReview(config,dir),e=>e.code==='CUTOUT_REVIEW_TIMEOUT'&&!e.message.includes('private timeout'));
  }finally{globalThis.setTimeout=originalTimer;}
}));
