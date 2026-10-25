import test from 'node:test';
import assert from 'node:assert/strict';
import {assessResultQuality} from '../result-quality.mjs';
const verified=()=>({dimensions:[1200,1600],maxChangeOutsideMask:0,productProtectedPixels:100,productMaxPixelDifference:0,foregroundProtectedPixels:20,foregroundMaxPixelDifference:0,maxBackgroundChangeOutsideOldObject:0});
const options={preserveProduct:true,backgroundOnlyGeneration:true};
test('pixel preservation alone cannot mark an image visually accepted',()=>{
  const result=assessResultQuality(verified(),options);
  assert.equal(result.hardChecks.passed,true);assert.equal(result.status,'needsReview');assert.equal(result.accepted,false);assert.equal(result.visualAcceptance,'pending');
  assert.deepEqual(result.reasonCodes,['VISUAL_REVIEW_REQUIRED']);assert.ok(result.nextActions.length);
});
test('any nonzero protected-region difference prevents delivery',()=>{
  for(const name of ['maxChangeOutsideMask','productMaxPixelDifference','foregroundMaxPixelDifference','maxBackgroundChangeOutsideOldObject']){
    const result=assessResultQuality({...verified(),[name]:1},options);
    assert.equal(result.status,'failed',name);assert.equal(result.hardChecks.passed,false,name);assert.ok(result.reasonCodes.includes('PROTECTION_CHANGED'),name);
  }
});
test('missing, malformed and empty expected protection evidence cannot pass',()=>{
  const changes=[{dimensions:[0,1600]},{maxChangeOutsideMask:NaN},{maxChangeOutsideMask:'0'},{productProtectedPixels:0},{productMaxPixelDifference:null},{foregroundProtectedPixels:-1},{maxBackgroundChangeOutsideOldObject:undefined}];
  for(const change of changes){const result=assessResultQuality({...verified(),...change},options);assert.equal(result.status,'failed');assert.ok(result.reasonCodes.includes('VERIFICATION_INCOMPLETE'));}
  assert.equal(assessResultQuality(null,options).status,'failed');
});
test('absent foreground core is explicitly not applicable, never protection evidence',()=>{
  const result=assessResultQuality({...verified(),foregroundProtectedPixels:0,foregroundMaxPixelDifference:null},options);
  assert.equal(result.status,'needsReview');assert.equal(result.hardChecks.checks.foregroundCore,'notApplicable');
  assert.equal(assessResultQuality({...verified(),foregroundProtectedPixels:0},options).status,'failed');
  assert.equal(assessResultQuality({...verified(),foregroundProtectedPixels:0,foregroundMaxPixelDifference:undefined},options).status,'failed');
  assert.equal(assessResultQuality({dimensions:[80,100],maxChangeOutsideMask:0}).status,'needsReview');
});

test('reported protection failures cannot be bypassed by absent legacy flags',()=>{
  for(const name of ['productMaxPixelDifference','foregroundMaxPixelDifference','maxBackgroundChangeOutsideOldObject','maxChangeOutsideRefinement','productChangeFromPrevious','foregroundChangeFromPrevious']){
    const result=assessResultQuality({...verified(),[name]:1},{preserveProduct:false,backgroundOnlyGeneration:false});
    assert.equal(result.status,'failed',name);assert.ok(result.reasonCodes.includes('PROTECTION_CHANGED'),name);
  }
  assert.equal(assessResultQuality({...verified(),productProtectedPixels:undefined}).status,'failed');
});
