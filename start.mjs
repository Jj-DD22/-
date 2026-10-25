import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Resolve relative data paths from the application, regardless of the launcher's cwd.
const root=path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
try {
  process.loadEnvFile(path.join(root,'.env'));
  if(process.env.SWAP_SHARED!=='1')throw new Error('Set SWAP_SHARED=1 in .env.');
  if(!process.env.SWAP_ALLOWED_ADDRESSES?.trim())throw new Error('Set SWAP_ALLOWED_ADDRESSES in .env.');
  const port=Number(process.env.SWAP_STUDIO_PORT);
  if(!Number.isInteger(port)||port<1024||port>65000)throw new Error('Set SWAP_STUDIO_PORT to a port from 1024 to 65000.');
  if(!process.env.SWAP_PYTHON||!fs.statSync(process.env.SWAP_PYTHON).isFile())throw new Error('Set SWAP_PYTHON to an existing Python executable.');
  if(!process.env.SWAP_JOB_DIR||!process.env.SWAP_SHARED_DATA)throw new Error('Set the data directories in .env.');
  const dependencies=spawnSync(process.env.SWAP_PYTHON,['-X','utf8','-c','import PIL, numpy, scipy; from scipy import ndimage, sparse; from scipy.sparse.linalg import spsolve'],{encoding:'utf8',timeout:30000,windowsHide:true});
  if(dependencies.error||dependencies.status!==0)throw new Error('Python image dependencies are missing or unavailable. Use the configured Python to install requirements.txt (Pillow, NumPy, SciPy). '+(dependencies.error?.message||dependencies.stderr?.trim()||''));
  await import('./server.mjs');
} catch(error) {
  console.error('Could not start Swap Studio: '+error.message);
  console.error('Copy .env.example to .env and configure the existing ComfyUI and Python paths. See README.txt.');
  process.exitCode=1;
}
