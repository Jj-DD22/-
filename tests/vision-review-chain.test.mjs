import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {registerHooks} from 'node:module';

const polygon=[[.1,.1],[.3,.1],[.3,.4],[.1,.4]];
const plan={schemaVersion:1,assessment:{material:'opaque',holes:'none',productOcclusion:'none',angle:'compatible',sourceView:'rear',productView:'rear',target:'single',attachment:'planar'},confidence:.95,oldObject:[polygon],productOutline:polygon,foreground:[],protect:[],placement:{centerX:.6,bottomY:.8,height:.2},summary:'轮廓待双重复核。',warnings:[]};
const preparation=()=>({checks:{cutoutClean:true,productComplete:true,placementPlausible:true},confidence:.95,reasonCodes:[],summary:'准备图可继续细节复核。'});
const cutout=()=>({cutoutClean:true,productComplete:true,confidence:.95,reasonCodes:[],summary:'细节未见明确缺陷。'});
const reply=value=>new Response(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));

test('analysis preserves source segmentation metadata and stops before review or delivery when its boundary is uncertain',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'swap-review-chain-')),storage=path.join(temp,'scratch');
  const originalFetch=globalThis.fetch,envNames=['SWAP_VISION_CHAT_URL','SWAP_VISION_MODEL','SWAP_VISION_API_KEY','SWAP_VISION_THINKING','SWAP_VISION_DATA','SWAP_PYTHON'],originalEnv=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
  const symbol=Symbol.for('swap.review-chain.spawn');let modes=[],prepareError;
  const proofs={policy:'white-visible-cutout-long-edge-1600-v1',cutoutDetails:{policy:'white-visible-cutout-uniform-quadrants-v1',overlapPaddingFraction:.04,sharedOverlapFraction:.08}};
  const oldObjectSegmentation={enabled:true,coordinateFrame:'full-normalized-source',refinedBBox:[21,32,61,82],rgbUnchanged:true,visualAcceptance:'pending independent review'};
  globalThis[symbol]=(python,args)=>{
    assert.equal(path.basename(args[2]),'auto_prepare.py');const mode=args[3],dir=args[4];modes.push(mode);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
    queueMicrotask(()=>{
      if(mode==='prepare'&&prepareError){child.stderr.emit('data',Buffer.from('private diagnostic line\n'+prepareError));child.emit('close',1);return;}
      const files=mode==='inspect'?['source-vision.jpg','product-vision.jpg']:['source-normalized.png','cutout.png','permission.png','foreground.png','background.png','backgroundGuard.png','backgroundMask.png','review-product.jpg','placement-review.jpg',...Array.from({length:4},(_,i)=>`cutout-detail-${i+1}.jpg`)];
      for(const file of files)fs.writeFileSync(path.join(dir,file),file+'-fixture');
      const result=mode==='inspect'?{recipe:null}:{placement:{x:1,y:2,width:20,height:10},normalization:{comparisonBasis:'normalized-source'},segmentation:{enabled:true},oldObjectSegmentation,preparationProofs:proofs};
      child.stdout.emit('data',Buffer.from(JSON.stringify(result)));child.emit('close',0);
    });return child;
  };
  const hook=registerHooks({resolve(specifier,context,nextResolve){
    if(specifier==='node:child_process')return {url:'data:text/javascript,'+encodeURIComponent('export const spawn=(...args)=>globalThis[Symbol.for("swap.review-chain.spawn")](...args);'),shortCircuit:true};
    return nextResolve(specifier,context);
  }});
  try{
    // Isolate host credentials and storage while executing the actual orchestration.
    for(const file of ['vision.mjs','vision-plan.mjs','scene-review.mjs','support-policy.mjs','preparation-review.mjs','cutout-review.mjs'])fs.copyFileSync(new URL('../'+file,import.meta.url),path.join(temp,file));
    Object.assign(process.env,{SWAP_VISION_CHAT_URL:'https://fixture.invalid/review',SWAP_VISION_MODEL:'fixture',SWAP_VISION_API_KEY:'fixture-header-only',SWAP_VISION_DATA:storage,SWAP_PYTHON:'fixture-python'});delete process.env.SWAP_VISION_THINKING;
    const {analyzeImages}=await import(pathToFileURL(path.join(temp,'vision.mjs')).href);
    const cases=[
      {name:'both pass',prep:preparation(),detail:cutout(),counts:[2,3,6],review:false},
      {name:'source runtime missing',prepareError:'OLD_OBJECT_SEGMENTATION_runtimeUnavailable: 运行包不存在。',counts:[2],review:true,sourceError:'runtimeUnavailable',admin:true},
      {name:'source runtime invalid',prepareError:'OLD_OBJECT_SEGMENTATION_runtimeInvalid: 运行包校验失败。',counts:[2],review:true,sourceError:'runtimeInvalid',admin:true},
      {name:'source boundary uncertain',prepareError:'OLD_OBJECT_SEGMENTATION_maskUncertain: 旧物轮廓异常。',counts:[2],review:true,sourceError:'maskUncertain'},
      {name:'placement rejected',prep:{...preparation(),checks:{...preparation().checks,placementPlausible:false},reasonCodes:['placementMismatch']},counts:[2,3],review:true,detailAbsent:true},
      {name:'preparation invalid',prep:'prose instead of JSON',counts:[2,3],review:true,prepError:'PREPARATION_REVIEW_INVALID',detailAbsent:true},
      {name:'preparation unavailable',prepHTTP:503,counts:[2,3],review:true,prepError:'PREPARATION_REVIEW_HTTP',detailAbsent:true},
      {name:'preparation background leak gets one outline recovery',prep:{...preparation(),checks:{...preparation().checks,cutoutClean:false},reasonCodes:['backgroundLeak']},recoveredPrep:preparation(),detail:cutout(),counts:[2,3,3,6],review:false,outlineRecovery:true},
      {name:'detail hair',prep:preparation(),detail:{...cutout(),cutoutClean:false,reasonCodes:['sourceHair']},counts:[2,3,6],review:true,reason:'sourceHair'},
      {name:'background leak remains a human-review candidate',prep:preparation(),detail:{...cutout(),cutoutClean:false,reasonCodes:['backgroundLeak']},counts:[2,3,6,3,6],review:false,humanReview:true,reason:'backgroundLeak'},
      {name:'detail uncertain',prep:preparation(),detail:{...cutout(),productComplete:null,reasonCodes:[]},counts:[2,3,6],review:true,reason:'cutoutUncertain'},
      {name:'detail invalid',prep:preparation(),detail:'prose instead of JSON',counts:[2,3,6],review:true,error:'CUTOUT_REVIEW_INVALID'},
      {name:'detail unavailable',prep:preparation(),http:503,counts:[2,3,6],review:true,error:'CUTOUT_REVIEW_HTTP'}
    ];
    for(const item of cases){
      const counts=[];modes=[];prepareError=item.prepareError;let preparationCount=0;
      globalThis.fetch=async(url,options)=>{
        assert.equal(options.headers.Authorization,'Bearer fixture-header-only');assert.equal(options.body.includes('fixture-header-only'),false);
        const payload=JSON.parse(options.body),count=payload.messages[1].content.filter(x=>x.type==='image_url').length;counts.push(count);
        if(count===2)return reply(plan);if(count===3){const review=preparationCount++===0?item.prep:(item.recoveredPrep??item.prep);return item.prepHTTP?new Response('private provider response',{status:item.prepHTTP}):reply(review);}
        assert.equal(count,6);return item.http?new Response('private provider response',{status:item.http}):reply(item.detail);
      };
      const result=await analyzeImages({source:Buffer.from('original-source').toString('base64'),product:Buffer.from('original-product').toString('base64'),allowExternal:true});
      const recovery=item.outlineRecovery||item.name==='detail hair'||item.humanReview;
      assert.deepEqual(counts,item.humanReview?[2,3,6,3,6]:item.name==='detail hair'?[2,3,6,3,6]:item.counts,item.name);assert.deepEqual(modes,recovery?['inspect','prepare','prepare-outline-recovery']:['inspect','prepare']);
      if(item.sourceError){
        assert.deepEqual(result.oldObjectSegmentation,{enabled:true,accepted:false,errorCode:item.sourceError,coordinateFrame:'full-normalized-source'},item.name);
        assert.deepEqual(result.support.reasonCodes,['oldObjectSegmentationUncertain'],item.name);
        assert.equal(result.preparationReview,undefined,item.name);assert.equal(result.cutoutReview,undefined,item.name);assert.equal(result.segmentation,undefined,item.name);
        assert.equal(result.nextActions.some(x=>x.includes('商品图')),false,item.name);
        if(item.admin){assert.match(result.nextActions.join(' '),/管理员/);assert.match(result.nextActions.join(' '),/重新分析/);}
        else{assert.match(result.nextActions.join(' '),/人物原图/);assert.match(result.nextActions.join(' '),/旧发饰清除范围/);}
      }else{assert.deepEqual(result.preparationProofs,proofs,item.name);assert.deepEqual(result.oldObjectSegmentation,oldObjectSegmentation,item.name);}
      assert.equal(result.needsReview===true,item.review,item.name);
      if(item.review){for(const asset of ['source','product','mask','foreground','background','backgroundGuard','backgroundMask'])assert.equal(asset in result,false,`${item.name}: ${asset}`);assert.equal(result.support.route,'needsReview');assert.ok(result.nextActions.length);assert.ok(result.nextActions.every(x=>typeof x==='string'&&x.length>0));}
      else{assert.equal(result.preparationReview.accepted,true);assert.equal(result.cutoutReview.accepted,!item.humanReview);assert.equal(result.generationCandidateRequiresHumanReview===true,!!item.humanReview);assert.ok(result.source.startsWith('data:image/png;base64,'));assert.ok(result.product.startsWith('data:image/png;base64,'));}
      if(item.detailAbsent)assert.equal(result.cutoutReview,undefined);
      if(item.reason)assert.ok(result.support.reasonCodes.includes(item.reason),item.name);
      if(item.outlineRecovery){assert.equal(result.outlineRecoveryReview.triggerGate,'preparationReview');assert.equal(result.outlineRecoveryReview.preparationReview.accepted,true);}
      if(item.error){assert.equal(result.cutoutReview.accepted,false);assert.equal(result.cutoutReview.errorCode,item.error);assert.equal(JSON.stringify(result).includes('private provider response'),false);}
      if(item.prepError){assert.equal(result.preparationReview.accepted,false);assert.equal(result.preparationReview.errorCode,item.prepError);}
      assert.equal(JSON.stringify(result).includes('private diagnostic line'),false,item.name);assert.equal(JSON.stringify(result).includes('private provider response'),false,item.name);
      assert.deepEqual(fs.readdirSync(storage),[],item.name);
    }
  }finally{
    hook.deregister();delete globalThis[symbol];globalThis.fetch=originalFetch;
    for(const name of envNames){if(originalEnv[name]===undefined)delete process.env[name];else process.env[name]=originalEnv[name];}
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
