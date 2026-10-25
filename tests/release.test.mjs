import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {release} from '../version.mjs';
const root=new URL('../',import.meta.url);
test('release includes all runtime imports and excludes host secrets and images',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('release-files.json',root),'utf8').replace(/^\uFEFF/,''));
  const files=new Set(manifest.appFiles);
  for(const name of fs.readdirSync(new URL('dist/',root)))if(/\.(js|html|css)$/.test(name))files.add('dist/'+name);
  for(const name of files){
    assert.ok(fs.existsSync(new URL(name,root)),name);
    assert.doesNotMatch(name,/(?:\.local\.json|\.(?:png|jpg|pt|gguf)$)/,name);
    if(name.startsWith('.env'))assert.ok(name.endsWith('.example'),name);
    if(!/\.(mjs|js)$/.test(name))continue;
    const source=fs.readFileSync(new URL(name,root),'utf8');
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)){
      if(match[1].startsWith('.'))assert.ok(files.has(path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1]))),`${name} imports missing ${match[1]}`);
    }
  }
  assert.equal(release.version,'1.0.0');assert.equal(release.productName,'换物1.0');
  assert.match(fs.readFileSync(new URL('dist/index.html',root),'utf8'),/<title>换物1.0/);
});
