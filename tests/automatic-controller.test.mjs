import test from 'node:test';
import assert from 'node:assert/strict';
import {connectAutomatic} from '../dist/automatic.js';

test('reanalysis sends the original upload and review actions never apply an automatic plan',async()=>{
  const originalGlobals=Object.fromEntries(['document','FileReader','fetch'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,checked:false});
    return elements.get(id);
  };
  const originalBlob=new Blob(['original-camera-pixels'],{type:'image/jpeg'});
  const workingBlob=new Blob(['normalized-working-pixels'],{type:'image/png'});
  const productBlob=new Blob(['original-product-pixels'],{type:'image/png'});
  const state={source:{blob:originalBlob},originalSourceUpload:{blob:originalBlob},originalProduct:{blob:productBlob},autoReady:false};
  const requests=[],notices=[];let applies=0;
  const review={needsReview:true,sceneReview:{completed:true,blocked:false,summary:'单处发饰'},summary:'商品材质需要确认',warnings:['检测到内部孔洞。'],nextActions:['请提供孔洞已透明的独立商品 PNG。','确认前后遮挡后再继续。']};
  try{
    globalThis.document={getElementById:element,body:{classList:{toggle(){}}}};
    globalThis.FileReader=class{
      readAsDataURL(blob){
        blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload?.();},error=>this.onerror?.(error));
      }
    };
    globalThis.fetch=async(url,options)=>{
      if(url==='/api/vision/status')return {ok:true,json:async()=>({configured:true,message:'视觉服务就绪'})};
      assert.equal(url,'/api/vision/analyze');assert.equal(options.method,'POST');
      requests.push(JSON.parse(options.body));
      if(requests.length===3)return {ok:false,json:async()=>({error:'视觉定位数据未通过校验'})};
      return {ok:true,json:async()=>requests.length===1?{origin:'vision-api',sceneReview:{completed:true,blocked:false,summary:'单处发饰，暖光'},summary:'已完成初次分析',warnings:[]}:review};
    };
    element('externalConsent').checked=true;
    const controller=connectAutomatic({state,apply:async(result,isCurrent)=>{assert.ok(isCurrent());applies++;state.source={blob:workingBlob};},manualChanged(){},update(){},notify:(...args)=>notices.push(args)});
    // The controller loads its service status asynchronously on connection.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(element('analyzeBtn').disabled,false);
    await element('analyzeBtn').onclick();
    assert.equal(state.source.blob,workingBlob);assert.equal(state.autoReady,true);assert.equal(controller.eligible(),true);assert.equal(applies,1);

    await element('analyzeBtn').onclick();
    assert.equal(requests.length,2);
    for(const request of requests){
      assert.equal(Buffer.from(request.source,'base64').toString(),'original-camera-pixels');
      assert.notEqual(Buffer.from(request.source,'base64').toString(),'normalized-working-pixels');
      assert.equal(Buffer.from(request.product,'base64').toString(),'original-product-pixels');
      assert.equal(request.allowExternal,true);assert.equal(request.requireSceneReview,true);
    }
    assert.equal(applies,1);assert.equal(state.autoReady,false);assert.equal(state.analysisBusy,false);assert.equal(controller.eligible(),false);
    assert.equal(element('analysisFacts').hidden,true);assert.match(element('analysisMessage').textContent,/商品材质需要确认/);
    for(const text of [...review.warnings,...review.nextActions])assert.ok(element('analysisWarnings').textContent.includes(text));
    assert.equal(notices.length,1);
    element('manualMode').checked=true;
    assert.equal(controller.eligible(),false,'manual mode must not bypass a material review');
    await element('analyzeBtn').onclick();
    assert.equal(state.analysisStatus,'failed');assert.equal(state.sceneReview,null);
    assert.equal(state.analysisBusy,false);assert.equal(controller.eligible(),false);
    assert.match(element('sceneReviewStatus').textContent,/本次分析未完成/);
    assert.doesNotMatch(element('sceneReviewStatus').textContent,/正在重新检查/);
    assert.equal(applies,1);
  }finally{
    for(const [name,descriptor] of Object.entries(originalGlobals)){
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  }
});
