import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAssessment,assessSupport} from '../support-policy.mjs';
const safe=()=>({material:'opaque',holes:'none',productOcclusion:'none',angle:'compatible',sourceView:'rear',productView:'rear',target:'single',attachment:'planar'});
test('high confidence cannot bypass material and geometry limits',()=>{
  for(const [field,value,code] of [['material','translucent','transparency'],['holes','present','holes'],['productOcclusion','essential','occlusion'],['angle','incompatible','angle'],['target','multiple','target'],['attachment','wraparound','attachment']]){
    const r=assessSupport({confidence:.99,assessment:{...safe(),[field]:value}});assert.equal(r.route,'needsReview');assert.ok(r.reasonCodes.includes(code));assert.ok(r.reasons.every(x=>x.nextAction));
  }
});
test('unknown and legacy plans require review, safe planar candidates can proceed',()=>{
  assert.equal(assessSupport({confidence:1}).route,'needsReview');
  assert.equal(assessSupport({confidence:1,assessment:{...safe(),holes:'unknown'}}).route,'needsReview');
  assert.equal(assessSupport({confidence:.9,assessment:safe()}).route,'autoCandidate');
  assert.equal(assessSupport({confidence:.6,assessment:safe()}).route,'needsReview');
});
test('assessment discards unknown keys and rejects invalid enum contracts',()=>{
  assert.deepEqual(validateAssessment({...safe(),command:'delete'}),safe());assert.equal(validateAssessment(undefined),null);
  for(const bad of [{},[],{...safe(),holes:true},{...safe(),angle:'looks good'},{...safe(),sourceView:'side-ish'},{...safe(),productView:null}])assert.throws(()=>validateAssessment(bad));
});

test('different camera-to-wearing views cannot pass even with compatible angle and maximum confidence',()=>{
  const views=['rear','rearOblique','profile','front'];
  for(const sourceView of views)for(const productView of views){
    const r=assessSupport({confidence:1,assessment:{...safe(),sourceView,productView}});
    assert.equal(r.route,sourceView===productView?'autoCandidate':'needsReview');
    if(sourceView!==productView){assert.ok(r.reasonCodes.includes('viewMismatch'));assert.match(r.reasons.find(reason=>reason.code==='viewMismatch').nextAction,/相同视角/);}
  }
});

test('a verified mild rear/rear-oblique planar mismatch can use an explicit bounded rotation',()=>{
  const plan={confidence:.85,assessment:{...safe(),angle:'moderate',sourceView:'rear',productView:'rearOblique'},placement:{rotationDegrees:18,rotationSpecified:true}};
  const result=assessSupport(plan);
  assert.equal(result.route,'autoCandidate');assert.deepEqual(result.adaptations,['planarRotation']);
  for(const overrides of [
    {rotationDegrees:31},
    {confidence:.69},
    {assessment:{...plan.assessment,productView:'profile'}},
    {assessment:{...plan.assessment,attachment:'curved'}},
    {assessment:{...plan.assessment,holes:'present'}},
    {assessment:{...plan.assessment,angle:'incompatible'}}
  ]){
    const unsafe={...plan,...overrides,placement:{rotationDegrees:overrides.rotationDegrees??18,rotationSpecified:true}};
    assert.equal(assessSupport(unsafe).route,'needsReview');
  }
});

test('missing legacy views remain readable but unknown or absent views require a same-view reference',()=>{
  const {sourceView,productView,...legacy}=safe(),parsed=validateAssessment(legacy);
  assert.equal(parsed.sourceView,'unknown');assert.equal(parsed.productView,'unknown');
  for(const assessment of [legacy,parsed,{...safe(),sourceView:'unknown'},{...safe(),productView:'unknown'}]){
    const r=assessSupport({confidence:1,assessment});assert.equal(r.route,'needsReview');assert.ok(r.reasonCodes.includes('viewUnknown'));assert.match(r.reasons.find(reason=>reason.code==='viewUnknown').nextAction,/相同视角/);
  }
});
