import test from 'node:test';
import assert from 'node:assert/strict';
import {RESULT_ISSUES,buildCorrectionPrompt,getResultIssue} from '../dist/result-correction.js';

test('review issue choices separate safely regenerable blend repairs from input or geometry changes',()=>{
  assert.equal(getResultIssue('hair_blend').canRegenerate,true);
  assert.equal(getResultIssue('old_object_residue').canRegenerate,true);
  assert.equal(getResultIssue('edge_shadow').canRegenerate,true);
  for(const code of ['product_detail','placement','occlusion'])assert.equal(getResultIssue(code).canRegenerate,false);
  assert.equal(RESULT_ISSUES.length,7);
});

test('hair correction prompt targets continuous strands and protects unrelated content',()=>{
  const prompt=buildCorrectionPrompt('hair_blend');
  assert.match(prompt,/自然、连续/);assert.match(prompt,/短而平行的刷痕/);assert.match(prompt,/网状或环状/);
  assert.match(prompt,/保持新商品、人物、其他头发和场景不变/);
});

test('custom repair notes are bounded, sanitized, and required for other issues',()=>{
  assert.throws(()=>buildCorrectionPrompt('other'),/补充需要修复/);
  assert.throws(()=>buildCorrectionPrompt('other','x'.repeat(301)),/300 字/);
  assert.equal(buildCorrectionPrompt('other','右下发丝中断\n补成自然长发').includes('右下发丝中断 补成自然长发'),true);
  assert.throws(()=>buildCorrectionPrompt('placement'),/返回编辑器/);
  assert.throws(()=>buildCorrectionPrompt('unknown'),/有效的主要问题/);
});
