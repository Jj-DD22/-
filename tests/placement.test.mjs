import test from 'node:test';
import assert from 'node:assert/strict';
import {fitPlacement,movePlacement,scalePlacement,resizePlacement,validPlacement} from '../dist/placement-model.js';
const source={width:540,height:720},product={width:200,height:660};
test('placement fits selected region with product proportions and bottom alignment',()=>{
  const region={x:190,y:280,width:100,height:150},p=fitPlacement(source,product,region);
  assert.equal(p.y+p.height,430);assert.ok(validPlacement(p,source,product));assert.ok(p.width<100);
});
test('drag and every resize handle keep aspect ratio, opposite anchor and image bounds',()=>{
  const p={x:200,y:280,width:40,height:132};
  for(const c of ['nw','ne','sw','se'])for(const [dx,dy] of [[23,45],[-999,-999],[999,999],[999,-999]]){
    const r=resizePlacement(p,c,dx,dy,source);
    assert.ok(validPlacement(r,source,product));
    assert.ok(Math.abs((c.includes('e')?r.x:r.x+r.width)-(c.includes('e')?p.x:p.x+p.width))<1e-8);
    assert.ok(Math.abs((c.includes('s')?r.y:r.y+r.height)-(c.includes('s')?p.y:p.y+p.height))<1e-8);
  }
  assert.deepEqual(movePlacement(p,999,-999,source),{...p,x:500,y:0});
});
test('height slider preserves bottom center, and invalid restored placements are rejected',()=>{
  const p={x:200,y:280,width:40,height:132},r=scalePlacement(p,198,source);
  assert.ok(validPlacement(r,source,product));assert.equal(r.y+r.height,412);assert.equal(r.x+r.width/2,220);
  assert.equal(validPlacement({...r,x:-1},source,product),false);
  assert.equal(validPlacement({...r,width:80},source,product),false);
});
