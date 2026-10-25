import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizedPoint,pixelCrop,MaskHistory} from '../dist/mask-model.js';
test('the same image point survives zoom and viewport movement',()=>{
  assert.deepEqual(normalizedPoint(150,230,{left:50,top:30,width:400,height:800}),{x:.25,y:.25});
  assert.deepEqual(normalizedPoint(500,500,{left:300,top:100,width:800,height:1600}),{x:.25,y:.25});
});
test('captured pointers outside the image are clamped to the image edge',()=>{
  assert.deepEqual(normalizedPoint(-20,1000,{left:0,top:0,width:540,height:720}),{x:0,y:1});
});
test('a crop dragged backwards keeps native pixel dimensions',()=>{
  assert.deepEqual(pixelCrop({x:.75,y:.8},{x:.25,y:.2},540,720),{x:135,y:144,width:270,height:432});
});
test('undo clear recovers the selection; editing after undo discards redo',()=>{
  const history=new MaskHistory();history.commit({kind:'stroke',points:[{x:.2,y:.4}]});history.commit({kind:'clear'});history.undo();assert.equal(history.active[0].kind,'stroke');assert.equal(history.canRedo,true);history.commit({kind:'rect',points:[]});assert.equal(history.canRedo,false);assert.deepEqual(history.active.map(x=>x.kind),['stroke','rect']);
});
test('eraser is recorded independently and can be undone and redone',()=>{
  const history=new MaskHistory();history.commit({kind:'stroke',mode:'paint'});history.commit({kind:'stroke',mode:'erase'});history.undo();assert.equal(history.active.length,1);history.redo();assert.equal(history.active[1].mode,'erase');
});
test('saving history does not lose its undo position',()=>{
  const history=new MaskHistory();history.commit({kind:'clear'});history.commit({kind:'stroke'});history.undo();const saved=history.serialize(),restored=new MaskHistory(saved.operations,saved.index);assert.equal(restored.active.length,1);assert.equal(restored.canRedo,true);
});
