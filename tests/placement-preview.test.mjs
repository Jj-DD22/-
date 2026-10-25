import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPlacementProduct} from '../dist/placement.js';
test('raw reference photos never qualify as a placed cutout, including manual mode',()=>{
  assert.equal(hasPlacementProduct({product:{},autoReady:false,manualMode:true}),false);
  assert.equal(hasPlacementProduct({product:{preparedCutout:true}}),true);
  assert.equal(hasPlacementProduct({product:{},autoReady:true,analysisStatus:'ready'}),true);
  for(const analysisStatus of ['failed','review'])assert.equal(hasPlacementProduct({product:{preparedCutout:true},autoReady:true,analysisStatus}),false);
  assert.equal(hasPlacementProduct({product:{preparedCutout:true},analysisBusy:true}),false);
});
