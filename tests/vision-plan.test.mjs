import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,parsePlan,parseVisionResponse,VISION_PROMPT} from '../vision-plan.mjs';
const polygon=[[.1,.1],[.3,.1],[.3,.4],[.1,.4]];
const valid=()=>({schemaVersion:1,confidence:.9,oldObject:[polygon],productOutline:polygon,foreground:[],protect:[],placement:{centerX:.4,bottomY:.8,height:.3},summary:'test',warnings:[]});
test('accepts plain and fenced vision JSON, strips unknown commands',()=>{const p=valid();p.command='delete';assert.equal(validatePlan(p).command,undefined);assert.deepEqual(parsePlan('```json\n'+JSON.stringify(p)+'\n```'),validatePlan(p));});
test('normalizes optional product-axis rotation and rejects unsafe transforms',()=>{
  assert.equal(validatePlan(valid()).placement.rotationDegrees,0);
  assert.equal(validatePlan(valid()).placement.rotationSpecified,false);
  assert.equal(validatePlan(valid()).placement.flipHorizontal,false);
  assert.equal(validatePlan({...valid(),placement:{...valid().placement,flipHorizontal:true}}).placement.flipHorizontal,true);
  assert.throws(()=>validatePlan({...valid(),placement:{...valid().placement,flipHorizontal:'yes'}}));
  assert.equal(validatePlan({...valid(),placement:{...valid().placement,rotationDegrees:-24}}).placement.rotationDegrees,-24);
  assert.equal(validatePlan({...valid(),placement:{...valid().placement,rotationDegrees:-24}}).placement.rotationSpecified,true);
  for(const rotationDegrees of [NaN,46,-46,'15'])assert.throws(()=>validatePlan({...valid(),placement:{...valid().placement,rotationDegrees}}));
});
test('vision instructions separate reflection matching from rotation',()=>{
  assert.match(VISION_PROMPT,/Image 1 is mirrored and Image 2 is a direct camera photo/);
  assert.match(VISION_PROMPT,/placement\.flipHorizontal=true/);
});
test('rejects invalid geometry, giant regions, non-numeric coordinates and missing outlines',()=>{
  for(const bad of [{...valid(),productOutline:[]},{...valid(),oldObject:[[[0,0],[1,0],[1,1],[0,1]]]},{...valid(),placement:{centerX:.5,bottomY:.1,height:.6}},{...valid(),confidence:NaN},{...valid(),productOutline:[[0,0],['.5',.3],[.2,.7]]}])assert.throws(()=>validatePlan(bad));
});
test('rejects prose and broken JSON instead of guessing a demo',()=>{assert.throws(()=>parsePlan('The image is ready'));assert.throws(()=>parsePlan('{}'));});
test('distinguishes malformed responses from invalid geometry',()=>{
  assert.throws(()=>parsePlan('{'),e=>e.code==='VISION_JSON_INVALID');
  assert.throws(()=>parsePlan(JSON.stringify({...valid(),productOutline:[]})),e=>e.code==='VISION_PLAN_INVALID');
});
test('unsupported material survives bad contours only as review, never as a placement',()=>{
  const assessment={material:'translucent',holes:'none',productOcclusion:'minor',angle:'compatible',sourceView:'rear',productView:'rear',target:'single',attachment:'planar'};
  const value={...valid(),assessment,productOutline:[]};
  const result=parseVisionResponse(JSON.stringify(value));
  assert.equal(result.reviewOnly,true);assert.equal(result.support.route,'needsReview');
  assert.ok(result.support.reasonCodes.includes('transparency'));assert.equal(result.placement,undefined);
  assert.throws(()=>parseVisionResponse(JSON.stringify({...value,assessment:{...assessment,material:'opaque'}})));
  assert.throws(()=>validatePlan({...valid(),productHoles:[[[.7,.7],[.71,.7],[.71,.71],[.7,.71]]]}),/商品孔洞位置/);
});

test('view observations survive plan parsing while older assessment schemas receive unknown views',()=>{
  const assessment={material:'opaque',holes:'none',productOcclusion:'none',angle:'compatible',sourceView:'rearOblique',productView:'rear',target:'single',attachment:'planar'};
  assert.deepEqual(parsePlan(JSON.stringify({...valid(),assessment})).assessment,assessment);
  const {sourceView,productView,...legacy}=assessment,parsed=parsePlan(JSON.stringify({...valid(),assessment:legacy}));
  assert.equal(parsed.assessment.sourceView,'unknown');assert.equal(parsed.assessment.productView,'unknown');
  assert.throws(()=>parsePlan(JSON.stringify({...valid(),assessment:{...assessment,sourceView:'back-side'}})));
});
