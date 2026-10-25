import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflow} from '../workflow.mjs';
import {buildCorrectionPrompt} from '../dist/result-correction.js';

test('clean plate generation excludes the product reference from all conditioning',()=>{
  const meta={crop:{x:0,y:0,width:128,height:128},generation:{width:448,height:448},product:{width:608,height:288},placement:{x:20,y:30,width:60,height:30},preserveProduct:true,backgroundOnlyGeneration:true};
  const graph=buildWorkflow(meta,{source:'source.png',product:'bow.png',mask:'mask.png',guide:'background-guide.png',id:'plate'},'replace with pink bow',42);
  assert.equal(graph['26'].inputs.image,'background-guide.png');
  assert.deepEqual(graph['15'].inputs.conditioning,['13',0]);
  assert.match(graph['12'].inputs.text,/ONLY fine natural hair strands/);
  assert.doesNotMatch(graph['12'].inputs.text,/replace with pink bow/);
  for(const id of ['5','6','8','10','11','14','29','30'])assert.equal(graph[id],undefined);
  for(const node of Object.values(graph))for(const value of Object.values(node.inputs))if(Array.isArray(value))assert.ok(graph[value[0]]);
});
test('background repair includes a human-selected correction prompt without weakening scene and product locks',()=>{
  const meta={crop:{x:0,y:0,width:128,height:128},generation:{width:448,height:448},product:{width:608,height:288},placement:{x:20,y:30,width:60,height:30},preserveProduct:true,backgroundOnlyGeneration:true};
  const graph=buildWorkflow(meta,{source:'source.png',product:'bow.png',mask:'mask.png',guide:'background-guide.png',id:'plate'},'ignored original task text',42,buildCorrectionPrompt('hair_blend'));
  const prompt=graph['12'].inputs.text;
  assert.match(prompt,/Human review correction priority/);assert.match(prompt,/短而平行的刷痕/);assert.match(prompt,/網狀|网状/);
  assert.doesNotMatch(prompt,/ignored original task text/);assert.match(prompt,/ONLY fine natural hair strands/);
  assert.deepEqual(graph['15'].inputs.conditioning,['13',0]);assert.deepEqual(graph['24'].inputs.destination,['4',0]);
});
test('product preservation exports uncomposited crop for edge fusion',()=>{
  const meta={crop:{x:1,y:2,width:100,height:140},generation:{width:320,height:448},product:{width:160,height:608},placement:{x:20,y:30,width:30,height:90},preserveProduct:true};
  const graph=buildWorkflow(meta,{source:'source.png',product:'product.png',mask:'mask.png',guide:'guide.png',id:'locked'},'',1);
  assert.deepEqual(graph['32'].inputs.images,['22',0]);assert.match(graph['12'].inputs.text,/Do not add outlines, halos, extra folds, clips, fingers or protrusions/);
  assert.deepEqual(graph['25'].inputs.images,['24',0]);
});
test('placed product guide actually conditions generation alongside the original grip',()=>{
  const meta={crop:{x:100,y:200,width:200,height:240},generation:{width:384,height:448},product:{width:192,height:608},placement:{x:190,y:280,width:45,height:140}};
  const graph=buildWorkflow(meta,{source:'original.png',product:'cutout.png',mask:'mask.png',guide:'placed.png',id:'placed'},'keep hands',42);
  assert.equal(graph['26'].inputs.image,'placed.png');assert.deepEqual(graph['7'].inputs.pixels,['28',0]);
  assert.deepEqual(graph['29'].inputs.pixels,['6',0]);assert.deepEqual(graph['15'].inputs.conditioning,['30',0]);
  assert.deepEqual(graph['24'].inputs.destination,['4',0]);assert.match(graph['12'].inputs.text,/left 45%, top 33%/);
  assert.throws(()=>buildWorkflow(meta,{id:'missing'},'',42),/参考图/);
});
test('different uploads and masks produce isolated dynamic workflows',()=>{
  const meta={crop:{x:31,y:57,width:192,height:224},generation:{width:384,height:448},product:{width:192,height:608}};
  const graph=buildWorkflow(meta,{source:'a/source.png',product:'a/product.png',mask:'a/mask.png',id:'a'},'keep fingers',42);
  assert.deepEqual(graph['5'].inputs,{image:['4',0],...meta.crop});
  assert.equal(graph['24'].inputs.x,31);assert.equal(graph['24'].inputs.y,57);
  assert.equal(graph['23'].inputs.image,'a/mask.png');assert.equal(graph['8'].inputs.image,'a/product.png');
  assert.equal(graph['19'].inputs.width,384);assert.equal(graph['16'].inputs.noise_seed,42);
  assert.match(graph['12'].inputs.text,/keep fingers/);
  const second=buildWorkflow({...meta,crop:{x:0,y:0,width:100,height:90}},{source:'b/source.png',product:'b/product.png',mask:'b/mask.png',id:'b'},'b',17);
  assert.equal(second['22'].inputs.width,100);assert.equal(second['24'].inputs.x,0);assert.notEqual(second['25'].inputs.filename_prefix,graph['25'].inputs.filename_prefix);
  for(const node of Object.values(graph))for(const value of Object.values(node.inputs))if(Array.isArray(value))assert.ok(graph[value[0]],'Every connection references an existing node');
});


