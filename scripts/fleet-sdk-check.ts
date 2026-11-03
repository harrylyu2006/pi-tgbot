/** Cross-process worker + real SDK + fake local model. No production credentials, no paid calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Rpc } from '../src/fleet/ipc.ts';
import { SecretsService } from '../src/secrets/service.ts';
import { createSecretsExtension } from '../src/secrets/extension.ts';
const root=mkdtempSync(join(tmpdir(),'fleet-sdk-test-'));const agent=join(root,'agent');mkdirSync(agent);
const secret='FAKE-fixture-private-value-932875';let requests:string[]=[];let count=0;
const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
 const raw=Buffer.concat(chunks).toString();requests.push(raw);count++;
 const base={id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:'fake'};
 res.writeHead(200,{'content-type':'text/event-stream'});const out=(x:any)=>res.write(`data: ${JSON.stringify(x)}\n\n`);
 if(count===1){out({...base,choices:[{index:0,delta:{role:'assistant',reasoning_content:'fixture provider reasoning summary'},finish_reason:null}]});out({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_test',type:'function',function:{name:'secret_run',arguments:JSON.stringify({command:'printf "%s" "$TOKEN"',env:{TOKEN:'fixture'}})}},{index:1,id:'call_write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'fixture-output.txt',content:'safe fixture'})}}]},finish_reason:null}]});out({...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});}
 else {out({...base,choices:[{index:0,delta:{role:'assistant',content:'fleet verified'},finish_reason:null}]});out({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});}
 res.end('data: [DONE]\n\n');
});});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
writeFileSync(join(agent,'auth.json'),JSON.stringify({fixture:{type:'api_key',key:'unused'}}));
writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'unused',api:'openai-completions',models:[{id:'fake',name:'fake',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
const logs:any={info(){},warn(){},error(){},debug(){},child(){return this;}};
const svc=await SecretsService.create({config:{baseUrl:'https://example.test',host:'127.0.0.1',port:0,dir:join(root,'vault'),keyPath:join(root,'key'),linkTtlSeconds:60,auditPath:join(root,'audit.jsonl'),denyPlaceholderTools:['write','edit']},api:{} as any,ui:{confirm:async()=>false} as any,log:logs,operatorChatId:1,currentChatId:()=>1});
svc.vault.set('fixture',secret,{});
const tools=new Map<string,any>();const hooks=new Map<string,any>();createSecretsExtension(svc)({registerTool:(t:any)=>tools.set(t.name,t),on:(n:string,h:any)=>hooks.set(n,h)} as any);
const descriptors=[...tools.values()].map(({execute,...rest})=>rest);
const cfg:any={cwd:root,agentDir:agent,sessionDir:join(root,'sessions'),statePath:join(root,'state'),logLevel:'error',tools:{deny:[],extraActive:['grep']},turn:{idleTimeoutMs:60000},extensions:[],model:'fixture/fake'};
const streamed:any[]=[];const locks:string[]=[];
writeFileSync(join(agent,'AGENTS.md'),'Private fixture persona: be concise.');
async function run(sessionFile?:string):Promise<any>{
 const child=fork(new URL('../src/fleet/worker.ts',import.meta.url),[],{serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});let result:any;let failed:any;
 const rpc=new Rpc(m=>child.connected&&child.send(m),async(op,a,signal)=>{
  if(op==='secrethook')return {result:await hooks.get(a.event)?.(a.data),...(a.event==='tool_call'?{input:a.data.input}:{})};
  if(op==='secrettool'){
   const live=await rpc.call('snapshot',{},undefined,5000);
   assert.ok(live?.sessionId&&live.stats&&live.context,'active worker serves snapshot without model request');
   return tools.get(a.name).execute(a.id,a.params,signal,()=>{},{cwd:root});
  }
  if(op==='lock'){locks.push(a.key);return 'ticket';}if(op==='unlock')return true;throw new Error('Unknown request');
 });
 child.on('message',(m:any)=>{if(m.rpc)void rpc.receive(m);else {streamed.push(m);if(m.event==='done')result=m;else if(m.event==='failed')failed=m;}});
 child.send({event:'init',config:cfg,bot:{id:'check',username:'check',role:'Test role',master:true,model:'fixture/fake',sessionDir:cfg.sessionDir},job:{id:'job',kind:'prompt',payload:{text:sessionFile?'Continue this same conversation':'Use secret_run with fixture then say verified'}},descriptors,snapshot:sessionFile?{sessionFile}:null,boot:'check'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);await new Promise<void>(r=>child.once('exit',()=>r()));clearTimeout(timer);rpc.close();
 assert.equal(failed,undefined);assert.equal(result?.text,'fleet verified');assert.ok(result?.snapshot.sessionFile);return result.snapshot;
}
try{
 const first=await run();const second=await run(first.sessionFile);assert.equal(first.sessionId,second.sessionId);
 assert.equal(requests.length,3);assert.ok(requests.every(x=>!x.includes(secret)));assert.ok(requests[1]!.includes('[SECRET:fixture]'));
 const transcript=readdirSync(cfg.sessionDir).filter(x=>x.endsWith('.jsonl')).map(x=>readFileSync(join(cfg.sessionDir,x),'utf8')).join('');assert.ok(!transcript.includes(secret));assert.ok(transcript.includes('Continue this same conversation'));
 assert.ok(streamed.some(m=>m.event==='thinking'&&m.text?.includes('fixture provider reasoning summary')),'provider reasoning summary forwarded over IPC');
 assert.ok(streamed.some(m=>m.event==='activity'&&m.text?.includes('secret_run')),'tool activity forwarded over IPC');
 assert.ok(requests[0]!.includes('Test role'));assert.ok(requests[0]!.includes('Private fixture persona'));assert.ok(locks.includes('file:'+join(root,'fixture-output.txt')),'file lock uses agent cwd, not gateway cwd');assert.equal(readFileSync(join(root,'fixture-output.txt'),'utf8'),'safe fixture');console.log('FLEET SDK CHECK PASSED: child process lifecycle, real prompt/tool loop, centralized secret injection/scrubbing, role instructions, persistent session resume, no model-visible credential.');
}finally{server.close();await svc.stop();rmSync(root,{recursive:true,force:true});}
