import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requestVision} from '../vision.mjs';
const polygon=[[.1,.1],[.3,.1],[.3,.4],[.1,.4]];
const plan={schemaVersion:1,assessment:{material:'opaque',holes:'none',productOcclusion:'none',angle:'compatible',sourceView:'rear',productView:'rear',target:'single',attachment:'planar'},confidence:.9,oldObject:[polygon],productOutline:polygon,foreground:[],protect:[],placement:{centerX:.4,bottomY:.8,height:.3},summary:'test',warnings:[]};
test('vision adapter transmits exactly two prepared images, keeps key in headers, validates reply',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'swap-vision-unit-')),original=globalThis.fetch;
  try{
    for(const role of ['source','product'])fs.writeFileSync(path.join(dir,role+'-vision.jpg'),role+'-fixture');
    let received;
    globalThis.fetch=async(url,options)=>{received={url,...options};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}),{status:200});};
    const result=await requestVision({url:'https://example.invalid/v1/chat/completions',model:'vision-fixture',key:'unit-only-secret'},dir);
    assert.equal(result.confidence,.9);assert.equal(received.headers.Authorization,'Bearer unit-only-secret');
    assert.equal(received.redirect,'error');assert.equal(received.body.includes('unit-only-secret'),false);
    const payload=JSON.parse(received.body),images=payload.messages[1].content.filter(p=>p.type==='image_url');assert.equal(images.length,2);assert.equal(payload.model,'vision-fixture');
    assert.equal('enable_thinking' in payload,false);
    await requestVision({url:'https://example.invalid/v1/chat/completions',model:'vision-fixture',key:'unit-only-secret',thinking:false},dir);
    assert.equal(JSON.parse(received.body).enable_thinking,false);
    globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"schemaVersion":'}}]}),{status:200});
    await assert.rejects(()=>requestVision({url:'https://example.invalid',model:'v',key:'x'},dir),e=>e.code==='VISION_OUTPUT_TRUNCATED');
    globalThis.fetch=async()=>new Response('provider debug containing secret',{status:401});
    await assert.rejects(()=>requestVision({url:'https://example.invalid',model:'v',key:'x'},dir),e=>e.message.includes('401')&&!e.message.includes('secret'));
  }finally{globalThis.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
});
