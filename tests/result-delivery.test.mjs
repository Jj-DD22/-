import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

test('public results remain review candidates and the baseline needs its own passing evidence',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'swap-result-delivery-'));
  process.env.SWAP_SHARED='0';process.env.SWAP_JOB_DIR=directory;
  try{
    const jobs=await import('../jobs.mjs');
    const id=randomUUID(),folder=jobs.jobDirectory(id);fs.mkdirSync(folder);
    const verified=()=>({dimensions:[80,100],maxChangeOutsideMask:0,productProtectedPixels:100,productMaxPixelDifference:0,foregroundProtectedPixels:0,foregroundMaxPixelDifference:null,maxBackgroundChangeOutsideOldObject:0});
    const job={id,status:'succeeded',preserveProduct:true,backgroundOnlyGeneration:true,verification:verified()};
    let result=jobs.publicJob(job);
    assert.equal(result.quality.status,'needsReview');assert.equal(result.quality.accepted,false);assert.equal(result.quality.visualAcceptance,'pending');assert.ok(result.resultUrl);assert.equal(result.baselineUrl,null);
    const revision='1234abcd5678',refined=path.join(folder,'refinements',revision);fs.mkdirSync(refined,{recursive:true});
    fs.writeFileSync(path.join(refined,'result.png'),'verified-revision-fixture');
    fs.writeFileSync(path.join(refined,'manifest.json'),JSON.stringify({schemaVersion:1,revision,jobId:id,generatedAgain:false}));
    fs.writeFileSync(path.join(refined,'verification.json'),JSON.stringify({...verified(),maxChangeOutsideRefinement:0,productChangeFromPrevious:0,foregroundChangeFromPrevious:0}));
    fs.writeFileSync(path.join(folder,'refinement.json'),JSON.stringify({revision}));
    job.verification.maxChangeOutsideMask=1;
    result=jobs.publicJob(job);
    assert.equal(result.resultUrl,`/api/jobs/${id}/refinements/${revision}/result.png`);assert.equal(result.baselineUrl,null);assert.equal(result.quality.accepted,false);
    const reviewed=jobs.acceptReview(job,{decision:'accepted',revision});
    assert.equal(reviewed.humanReview.decision,'accepted');assert.equal(reviewed.humanReview.revision,revision);
    assert.equal(reviewed.quality.accepted,true);assert.equal(reviewed.quality.visualAcceptance,'accepted');assert.equal(reviewed.quality.status,'needsReview');assert.equal(reviewed.stage,'候选结果 · 人工已接受');
    assert.throws(()=>jobs.acceptReview(job,{decision:'accepted',revision:'000011112222'}),/候选版本已变化/);
    job.verification=verified();assert.equal(jobs.publicJob(job).baselineUrl,`/api/jobs/${id}/result.png`);
    fs.writeFileSync(path.join(folder,'refinement.json'),JSON.stringify({revision:'000011112222'}));
    delete job.verification;
    result=jobs.publicJob(job);assert.equal(result.quality.status,'failed');assert.equal(result.resultUrl,null);assert.equal(result.baselineUrl,null);
    const legacy={id,status:'succeeded',verification:{dimensions:[80,100],maxChangeOutsideMask:0}};
    result=jobs.publicJob(legacy);assert.ok(result.resultUrl);assert.equal(result.quality.status,'needsReview');assert.equal(result.quality.accepted,false);
    legacy.verification.productProtectedPixels=100;legacy.verification.productMaxPixelDifference=2;
    assert.equal(jobs.publicJob(legacy).resultUrl,null);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
