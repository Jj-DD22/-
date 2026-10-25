// Non-generating integration checks against the currently running local task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const origin='http://127.0.0.1:8766';
const current=(await (await fetch(origin+'/api/jobs/latest')).json()).job;
assert.ok(current&&!['succeeded','failed','cancelled'].includes(current.status),'Run while the real UI generation is active');
const saved=JSON.parse(fs.readFileSync(new URL(`../.runtime/jobs/${current.id}/job.json`,import.meta.url)));
const post=(body,requestOrigin=origin)=>fetch(origin+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','Origin':requestOrigin},body:JSON.stringify(body)});
const forbidden=await post({requestId:randomUUID()},'https://example.com');assert.equal(forbidden.status,403);
const repeat=await post({requestId:saved.requestId});assert.equal(repeat.status,202);assert.equal((await repeat.json()).job.id,current.id);
const busy=await post({requestId:randomUUID()});assert.equal(busy.status,409);
const missing=await fetch(origin+'/api/jobs/'+randomUUID());assert.equal(missing.status,404);
assert.equal((await (await fetch(origin+'/api/jobs/latest')).json()).job.id,current.id);
console.log('PASS: cross-origin rejection, idempotent retry, single active job, unknown job 404; no new generation submitted.');
