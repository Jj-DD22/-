import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function createAccess(directory,{now=Date.now}={}){
  fs.mkdirSync(directory,{recursive:true});
  const codeFile=path.join(directory,'access-code.txt'),sessionFile=path.join(directory,'sessions.json');
  if(!fs.existsSync(codeFile))fs.writeFileSync(codeFile,randomBytes(8).toString('hex')+'\n',{mode:0o600});
  const code=fs.readFileSync(codeFile,'utf8').trim(),codeHash=digest(code);
  if(code.length<12)throw new Error('访问码至少需要 12 个字符，请修改 access-code.txt。');
  let sessions={};
  try{const saved=JSON.parse(fs.readFileSync(sessionFile,'utf8'));if(saved.codeHash===codeHash)sessions=saved.sessions;}catch{}
  const attempts=new Map();
  const save=()=>{fs.writeFileSync(sessionFile+'.tmp',JSON.stringify({codeHash,sessions}),{mode:0o600});fs.renameSync(sessionFile+'.tmp',sessionFile);};
  function current(req){
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('swap_session='))?.slice(13);
    if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
    const key=digest(token),session=sessions[key];
    if(!session||session.expires<now())return null;
    return {...session,key};
  }
  function login(req,value){
    const ip=req.socket.remoteAddress||'unknown',record=attempts.get(ip);
    if(record&&record.until>now()&&record.count>=8)throw Object.assign(new Error('尝试次数过多，请一分钟后再试。'),{status:429});
    const supplied=digest(typeof value==='string'?value.trim():'');
    if(!timingSafeEqual(Buffer.from(supplied),Buffer.from(codeHash))){
      attempts.set(ip,{count:record?.until>now()?record.count+1:1,until:record?.until>now()?record.until:now()+60000});
      throw Object.assign(new Error('访问码不正确，请向主机管理员确认。'),{status:401});
    }
    attempts.delete(ip);
    for(const [key,session] of Object.entries(sessions))if(session.expires<now())delete sessions[key];
    for(const [key,record] of attempts)if(record.until<now())attempts.delete(key);
    const previous=current(req),token=randomBytes(32).toString('hex');
    if(previous)delete sessions[previous.key];
    sessions[digest(token)]={owner:previous?.owner||randomUUID(),expires:now()+7*86400000};save();
    return `swap_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
  }
  function logout(req){const session=current(req);if(session){delete sessions[session.key];save();}return 'swap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';}
  return {current,login,logout};
}
