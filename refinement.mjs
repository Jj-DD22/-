import fs from 'node:fs';
import path from 'node:path';

// The pointer is written by the local operator tool, never by a browser upload.
// Only a fixed set of files in a validated revision directory can be exposed.
export function readRefinement(directory,jobId,revision){
  try{
    if(revision===undefined)({revision}=JSON.parse(fs.readFileSync(path.join(directory,'refinement.json'),'utf8')));
    if(!/^[a-f0-9]{12}$/.test(revision))return null;
    const folder=path.join(directory,'refinements',revision);
    const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
    const verification=JSON.parse(fs.readFileSync(path.join(folder,'verification.json'),'utf8'));
    if(manifest.schemaVersion!==1||manifest.revision!==revision||manifest.jobId!==jobId||manifest.generatedAgain!==false||!fs.statSync(path.join(folder,'result.png')).isFile())return null;
    for(const key of ['maxChangeOutsideMask','maxChangeOutsideRefinement','productChangeFromPrevious','foregroundChangeFromPrevious'])if(verification[key]!==0)return null;
    return {revision,description:manifest.description,verification};
  }catch{return null;}
}
