import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as jobs from './jobs.mjs';
import {createWebServer} from './web-server.mjs';
const app=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.SWAP_STUDIO_PORT||8766);
const shared=process.env.SWAP_SHARED==='1';
const allowedAddresses=(process.env.SWAP_ALLOWED_ADDRESSES||'').split(',').filter(Boolean);
if(shared&&!allowedAddresses.length)throw new Error('共享模式需要指定主机局域网地址。请使用共享版启动器。');
const server=createWebServer({root:path.join(app,'dist'),port,shared,allowedAddresses,
  instanceId:createHash('sha256').update(app.toLowerCase()).digest('hex'),
  stateDirectory:process.env.SWAP_SHARED_DATA||path.join(app,'.shared-data'),jobs});
server.listen(port,shared?'0.0.0.0':'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}/`));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
