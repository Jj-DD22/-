import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requestPreparationReview} from '../preparation-review.mjs';

const config={url:'https://review.example.invalid/v1/chat/completions',model:'review-fixture',key:'header-only-unit-secret'};
const passing=()=>({checks:{cutoutClean:true,productComplete:true,placementPlausible:true},confidence:.95,reasonCodes:[],summary:'抠图完整，未见来源头发，位置合理。'});
const reply=value=>new Response(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));
async function fixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swap-preparation-review-')),original=globalThis.fetch;
  try{
    for(const [name,content] of [['product-vision.jpg','original-product'],['review-product.jpg','white-cutout-proof'],['cutout.png','transparent-cutout'],['placement-review.jpg','placement-proof']])fs.writeFileSync(path.join(dir,name),content);
    await run(dir);
  }finally{globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
}

test('review sends exactly three derived proofs and keeps credentials only in headers',async()=>fixture(async dir=>{
  let received;
  globalThis.fetch=async(url,options)=>{received={url,...options};return reply(passing());};
  const result=await requestPreparationReview(config,dir);
  assert.equal(result.accepted,true);assert.deepEqual(result.checks,passing().checks);
  assert.equal(received.url,config.url);assert.equal(received.redirect,'error');assert.equal(received.headers.Authorization,'Bearer '+config.key);assert.equal(received.body.includes(config.key),false);
  const payload=JSON.parse(received.body),images=payload.messages[1].content.filter(item=>item.type==='image_url');
  assert.equal(payload.model,config.model);assert.equal(images.length,3);assert.equal('enable_thinking' in payload,false);
  for(const [index,expected] of ['original-product','white-cutout-proof','placement-proof'].entries())assert.equal(Buffer.from(images[index].image_url.url.split(',')[1],'base64').toString(),expected);
  await requestPreparationReview({...config,thinking:false},dir);assert.equal(JSON.parse(received.body).enable_thinking,false);
}));

test('transparent cutout PNG is the explicit fallback when white proof is absent',async()=>fixture(async dir=>{
  fs.unlinkSync(path.join(dir,'review-product.jpg'));let images;
  globalThis.fetch=async(url,options)=>{images=JSON.parse(options.body).messages[1].content.filter(item=>item.type==='image_url');return reply(passing());};
  assert.equal((await requestPreparationReview(config,dir)).accepted,true);
  assert.ok(images[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(images[1].image_url.url.split(',')[1],'base64').toString(),'transparent-cutout');
}));

test('visible defects, unknown checks, low confidence and reason codes cannot pass',async()=>fixture(async dir=>{
  const cases=[{...passing(),checks:{...passing().checks,cutoutClean:false},reasonCodes:['sourceHair']},{...passing(),checks:{...passing().checks,placementPlausible:null},reasonCodes:['uncertain']},{...passing(),confidence:.849},{...passing(),reasonCodes:['backgroundLeak']},{...passing(),checks:{...passing().checks,productComplete:null},reasonCodes:[]}];
  for(const value of cases){globalThis.fetch=async()=>reply(value);assert.equal((await requestPreparationReview(config,dir)).accepted,false);}
  globalThis.fetch=async()=>reply({...passing(),confidence:.85});assert.equal((await requestPreparationReview(config,dir)).accepted,true);
}));

test('prose, malformed JSON and invalid review contracts fail closed',async()=>fixture(async dir=>{
  const cases=['Here is a review: '+JSON.stringify(passing()),'{broken',{}, {...passing(),checks:{...passing().checks,cutoutClean:'true'}},{...passing(),checks:{cutoutClean:true,productComplete:true}},{...passing(),confidence:1.1},{...passing(),confidence:'0.95'},{...passing(),reasonCodes:['executeCommand']},{...passing(),summary:'English only'},{...passing(),reasonCodes:'sourceHair'}];
  for(const value of cases){globalThis.fetch=async()=>reply(value);await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_INVALID');}
  globalThis.fetch=async()=>reply('```json\n'+JSON.stringify(passing())+'\n```');assert.equal((await requestPreparationReview(config,dir)).accepted,true);
}));

test('HTTP and network errors never leak provider response or credential details',async()=>fixture(async dir=>{
  globalThis.fetch=async()=>new Response('private provider debug '+config.key,{status:401});
  await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_HTTP'&&error.httpStatus===401&&!error.message.includes('private provider')&&!error.message.includes(config.key));
  globalThis.fetch=async()=>{throw new TypeError('private transport detail '+config.key);};
  await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_CONNECTION'&&!error.message.includes('private transport')&&!error.message.includes(config.key));
}));

test('oversized and missing proof responses cannot be accepted',async()=>fixture(async dir=>{
  globalThis.fetch=async()=>new Response('x'.repeat(1000001));
  await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_TOO_LARGE');
  fs.unlinkSync(path.join(dir,'placement-review.jpg'));
  await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_INPUT');
}));

test('review aborts at its timeout and returns a classifiable safe error',async()=>fixture(async dir=>{
  const originalTimer=globalThis.setTimeout;
  try{
    globalThis.setTimeout=(callback,ms,...args)=>originalTimer(callback,ms===120000?1:ms,...args);
    globalThis.fetch=async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('private provider timeout','AbortError')),{once:true}));
    await assert.rejects(()=>requestPreparationReview(config,dir),error=>error.code==='PREPARATION_REVIEW_TIMEOUT'&&!error.message.includes('private provider'));
  }finally{globalThis.setTimeout=originalTimer;}
}));
