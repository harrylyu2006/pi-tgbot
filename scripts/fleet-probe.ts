/** Real SDK bootstrap only; no Telegram poller and no model request. */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Rpc } from '../src/fleet/ipc.ts';
import assert from 'node:assert/strict';
const cfg=loadConfig(process.argv[2]??'/etc/pi-tg/config.json');
const dir=mkdtempSync(join(tmpdir(),'fleet-sdk-probe-'));
let failed=false;
try{
 const config:any={...cfg,sessionDir:dir};delete config.botToken;delete config.secrets;
 const child=fork(new URL('../src/fleet/worker.ts',import.meta.url),[],{serialization:'advanced',stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,PI_SKIP_VERSION_CHECK:'1'}});
 child.stderr?.on('data',()=>{});
 const rpc=new Rpc(m=>child.send(m),async(op,args)=>{if(op==='secrethook')return {};if(op==='lock')return 'ticket';if(op==='unlock')return true;return null;});
 let done=false;
 const timeout=setTimeout(()=>{failed=true;child.kill('SIGKILL');},120000);
 child.on('message',(m:any)=>{if(m.rpc){void rpc.receive(m);return;}if(m.event==='failed'){console.log('Worker bootstrap failed',m.phase,m.errorName);failed=true;}
  if(m.event==='done'){
   assert.ok(m.snapshot.tools.includes('fleet_memory'));assert.ok(m.snapshot.tools.includes('fleet_history'));
   assert.ok(m.snapshot.tools.includes('read'));assert.ok(m.snapshot.tools.includes('bash'));
   assert.ok(m.snapshot.tools.includes('email_send'));done=true;
   console.log(JSON.stringify({ok:true,tools:m.snapshot.tools.length,model:m.snapshot.model,thinking:m.snapshot.thinking,sessionSaved:!!m.snapshot.sessionFile}));
  }
 });
 child.send({event:'init',config,bot:{id:'probe',telegramId:1,username:'probe',master:true,enabled:true,role:'Offline probe',sessionDir:dir,statePath:join(dir,'state.json'),model:cfg.model},job:{id:'probe',bot:'probe',kind:'probe',payload:{}},snapshot:null,descriptors:[],boot:'probe'});
 await new Promise<void>(r=>child.once('exit',()=>r()));clearTimeout(timeout);rpc.close();if(!done)failed=true;
}finally{rmSync(dir,{recursive:true,force:true});}
if(failed)process.exitCode=1;
