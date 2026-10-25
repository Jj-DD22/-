import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
test('one running job, FIFO waiting, scoped retries and waiting cancellation',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'swap-queue-test-'));
  const pending=[];let starts=0;
  const engine=http.createServer((req,res)=>{const finish=()=>{res.setHeader('Content-Type','application/json');res.end('{}');};if(req.url==='/system_stats'){starts++;pending.push(finish);}else finish();});
  await new Promise(resolve=>engine.listen(0,'127.0.0.1',resolve));
  process.env.SWAP_SHARED='1';process.env.SWAP_JOB_DIR=directory;process.env.SWAP_COMFY_URL=`http://127.0.0.1:${engine.address().port}`;
  const jobs=await import('../jobs.mjs');
  const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};
  const input=()=>({requestId:randomUUID(),source:'YQ==',product:'YQ==',mask:'YQ==',instructions:''});
  try{
    assert.throws(()=>jobs.createJob({...input(),preserveProduct:true,backgroundOnlyGeneration:true},'validation'),/明确的旧物修复区/);
    for(const seed of [0,-1,NaN,.5,'1',2**32,Number.MAX_SAFE_INTEGER+1,Infinity,null])assert.throws(()=>jobs.createJob({...input(),seed},'validation'),/随机种子必须是/);
    assert.equal(starts,0);assert.equal(jobs.latestJob('validation'),undefined);
    const a={...input(),seed:1},first=jobs.createJob(a,'alice');await wait(()=>starts===1);
    const b={...input(),requestId:a.requestId,seed:2**32-1},second=jobs.createJob(b,'bob'),third=jobs.createJob(input(),'charlie');
    const repeat=jobs.createJob({requestId:a.requestId,seed:2**32-1},'alice');
    assert.equal(repeat.id,first.id);assert.equal(repeat.seed,1);assert.notEqual(first.id,second.id);
    assert.equal(jobs.publicJob(first).seed,1);assert.equal(jobs.publicJob(second).seed,2**32-1);
    for(const job of [first,second])assert.equal(JSON.parse(fs.readFileSync(path.join(jobs.jobDirectory(job.id),'job.json'),'utf8')).seed,job.seed);
    assert.ok(Number.isSafeInteger(third.seed)&&third.seed>=1&&third.seed<=2**32-1);
    assert.equal(first.status,'preparing');assert.equal(second.status,'waiting');assert.equal(third.status,'waiting');
    assert.equal(jobs.publicJob(second).queuePosition,1);assert.equal(jobs.latestJob('alice').id,first.id);
    assert.throws(()=>jobs.createJob(input(),'alice'),/已有任务/);
    await jobs.cancelJob(third);assert.equal(third.status,'cancelled');assert.equal(starts,1);
    pending.shift()();await wait(()=>starts===2);assert.equal(first.status,'failed');assert.equal(second.status,'preparing');
    pending.shift()();await wait(()=>second.status==='failed');assert.equal(starts,2);
  }finally{engine.closeAllConnections();engine.close();fs.rmSync(directory,{recursive:true,force:true});}
});
