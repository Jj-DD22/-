import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual browser functions with image/DOM adapters; importing app.js
// itself would also boot its UI and fetch services in this Node test process.
const source=fs.readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
function browser(){
  const elements=new Map(),revoked=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{classList:{add(){}},dispatchEvent(){}});return elements.get(id);};
  const context=vm.createContext({state:{source:null,product:null,originalProduct:null,autoAssets:null},dimensions:[6000,4000],Image:class{constructor(){this.naturalWidth=context.dimensions[0];this.naturalHeight=context.dimensions[1];}async decode(){}},URL:{createObjectURL:()=>`blob:test-${revoked.length}`,revokeObjectURL:url=>revoked.push(url)},$:element,MaskHistory:class{},overlay:{},rawMask:{},softMask:{},foregroundMask:{},foregroundPreview:{},fit(){},updateControls(){},paint(){},measure(){},automaticController:{invalidate(){throw Error('automatic result must not invalidate itself');}},placementController:{reset(){}}});
  vm.runInContext(source.slice(source.indexOf('async function decode('),source.indexOf('async function upload(')),context);
  vm.runInContext("function release(asset){if(asset?.url?.startsWith('blob:'))URL.revokeObjectURL(asset.url);}",context);
  return {context,revoked};
}

test('large uploads are accepted for analysis while manual generation remains blocked',async()=>{
  const {context,revoked}=browser();
  const upload={size:2000,type:'image/jpeg'},asset=await context.decode(upload,'large.jpg');
  context.state.source=asset;
  assert.equal(asset.width*asset.height,24000000);assert.match(context.generationInputIssue(),/先点“自动识别与摆放”/);
  context.state.source={width:1600,height:1067};assert.equal(context.generationInputIssue(),'');
  context.state.product=asset;assert.match(context.generationInputIssue(),/商品图/);
  context.dimensions=[8001,8000];await assert.rejects(()=>context.decode(upload,'too-large.jpg'),/6400 万像素/);assert.equal(revoked.length,1);
  await assert.rejects(()=>context.decode({size:20*1024*1024+1,type:'image/jpeg'},'too-large-file.jpg'),/20 MB/);
});

test('automatic assets require one shared source and mask coordinate system',()=>{
  const {context}=browser(),working={width:1600,height:1067};
  assert.doesNotThrow(()=>context.validateAutomaticAssets({source:working,mask:working,foreground:working,background:working},null,[1600,1067]));
  assert.throws(()=>context.validateAutomaticAssets({source:working,mask:{width:6000,height:4000}},null,[1600,1067]),/蒙版.*尺寸不一致/);
  assert.throws(()=>context.validateAutomaticAssets({source:working},null,[6000,4000]),/方案.*尺寸不一致/);
  assert.throws(()=>context.validateAutomaticAssets({}, {width:6000,height:4000},[6000,4000]),/大图尚未转换/);
  assert.doesNotThrow(()=>context.validateAutomaticAssets({mask:working},working,[1600,1067]));
});

test('applying normalized source retains the original upload without invalidating the active analysis',()=>{
  const {context,revoked}=browser(),original={blob:{raw:true},name:'camera.jpg'};
  context.state.source={blob:original.blob,name:original.name,width:6000,height:4000,url:'blob:original'};
  context.state.originalSourceUpload=original;
  const working={blob:{normalized:true,size:1000},name:'source.png',width:1600,height:1067,url:'blob:working'};
  context.applyAsset('source',working,{preserveOriginal:true});
  assert.equal(context.state.originalSourceUpload,original);assert.equal(context.state.source,working);assert.deepEqual(revoked,['blob:original']);
  assert.equal(context.overlay.width,1600);assert.equal(context.overlay.height,1067);
});
