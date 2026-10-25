
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSceneReview} from '../scene-review.mjs';
test('whole scene review blocks uninspected and linked mirror views, but permits a single reflected view',()=>{
 assert.equal(validateSceneReview().blocked,true);
 assert.equal(validateSceneReview({completed:true,mirror:'present',linkedViews:'multiple'}).blocked,true);
 assert.equal(validateSceneReview({completed:true,mirror:'present',linkedViews:'single'}).blocked,false);
 assert.equal(validateSceneReview({completed:false,mirror:'absent',linkedViews:'single'}).blocked,true);
 assert.equal(validateSceneReview({completed:true,mirror:'absent',linkedViews:'invented'}).blocked,true);
});
