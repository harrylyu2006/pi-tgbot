/** Full gateway, four real SDK workers, fake Telegram/model. Must run in a delegated test cgroup. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {FleetStore} from '../src/fleet/store.ts';
import {Vault} from '../src/secrets/vault.ts';
const root=mkdtempSync(join(tmpdir(),'fleet-gateway-')),agent=join(root,'agent'),data=join(root,'fleet');mkdirSync(agent);mkdirSync(data);
const owner=42,ids=[111111111,222222222,333333333,444444444];
const token=(id:number)=>[String(id),'FAKE_FIXTURE_NOT_REAL_'.repeat(2)].join(':');
const updates=new Map<number,any[]>();const commands=new Map<string,any>();const sent:any[]=[];
let activeModels=0,peak=0,completed=0;const arrivals:string[]=[];const release:Array<()=>void>=[];
const server=createServer((req,res)=>{
 const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
 const raw=Buffer.concat(chunks).toString();const body=raw?JSON.parse(raw):{};const url=req.url??'';
 if(url.startsWith('/bot')){
  const id=Number(url.split(':')[0]!.slice(4)),method=url.split('/').at(-1)!;let result:any=true;
  if(method==='getMe')result={id,is_bot:true,first_name:id===ids[0]?'总控助手':'研究助手 '+ids.indexOf(id),username:'fixture_'+id+'_bot',can_manage_bots:id===ids[0]};
  if(method==='getWebhookInfo')result={url:'',pending_update_count:0};
  const key=id+JSON.stringify([body.scope,body.language_code]);
  if(method==='setMyCommands')commands.set(key,body.commands);
  if(method==='getMyCommands')result=commands.get(key)??[];
  if(['sendMessage','editMessageText'].includes(method)){const mid=method==='editMessageText'?body.message_id:sent.length+1;sent.push({id,method,...body,message_id:mid});result={message_id:mid,date:Math.floor(Date.now()/1000),chat:{id:owner,type:'private'}};}
  if(method==='getUpdates'){
   const queue=(updates.get(id)??[]).filter(u=>body.offset===undefined||u.update_id>=body.offset);updates.set(id,queue);
   setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify({ok:true,result:queue}));},queue.length?10:200);return;
  }
  res.end(JSON.stringify({ok:true,result}));return;
 }
 if(url.startsWith('/v1/')){
  activeModels++;peak=Math.max(peak,activeModels);arrivals.push(raw);
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'reasoning-fixture',object:'chat.completion.chunk',created:1,model:'fake',choices:[{index:0,delta:{role:'assistant',reasoning_content:'fixture visible reasoning summary'},finish_reason:null}]})+'\n\n');
  const reply=()=>{activeModels--;completed++;const base={id:'c'+completed,object:'chat.completion.chunk',created:1,model:'fake'};res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'fixture complete'},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105,prompt_tokens_details:{cached_tokens:80}}})+'\n\n');res.end('data: [DONE]\n\n');};
  if(arrivals.length<=3){release.push(reply);if(release.length===3)setTimeout(()=>release.splice(0).forEach(f=>f()),2500);}else setTimeout(reply,200);
  return;
 }
 res.writeHead(404);res.end();
 });
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
writeFileSync(join(agent,'auth.json'),JSON.stringify({fixture:{type:'api_key',key:'unused'}}));writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'unused',api:'openai-completions',models:[{id:'fake',name:'Fake',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
const secrets={baseUrl:'https://example.test',listenPort:18679,dir:join(root,'vault'),keyPath:join(root,'key')};const vault=new Vault(secrets.dir,secrets.keyPath);
const s=new FleetStore(join(data,'fleet.sqlite'));
for(let i=0;i<ids.length;i++){const id=i?'child'+i:'master',d=join(root,id);mkdirSync(d);mkdirSync(join(d,'sessions'));if(i)vault.set(id,token(ids[i]!),{});s.saveBot({id,telegramId:ids[i]!,username:'fixture_'+ids[i]+'_bot',role:'Fixture '+id,master:i===0,enabled:true,secretName:i?id:undefined,sessionDir:join(d,'sessions'),statePath:join(d,'state.json'),model:'fixture/fake',thinking:'off'});}s.close();
const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify({botToken:token(ids[0]!),allowedUserId:owner,cwd:root,agentDir:agent,sessionDir:join(root,'master/sessions'),statePath:join(root,'master/state.json'),auditPath:join(root,'log'),model:'fixture/fake',secrets,extensions:[],files:{outboxRoots:[root],inboxDir:join(root,'inbox')}}),{mode:0o600});
const gateway=fork(new URL('../src/fleet/main.ts',import.meta.url),[configPath],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PI_FLEET_ROOT:data,FLEET_FIXTURE_API:`http://127.0.0.1:${port}`,NODE_OPTIONS:`--import=${fileURLToPath(new URL('./fixtures/fleet-fetch.mjs',import.meta.url))}`}});
let ready=false;const diagnostic:string[]=[];gateway.stdout?.on('data',c=>{const t=c.toString();if(t.includes('fleet ready'))ready=true;diagnostic.push(t.slice(0,1000));});gateway.stderr?.on('data',c=>diagnostic.push(c.toString().slice(0,1000)));
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));async function until(test:()=>boolean,seconds=90){for(let i=0;i<seconds*10;i++){if(test())return;if(gateway.exitCode!==null)throw new Error('Gateway exited: '+diagnostic.slice(-3).join(''));await sleep(100);}throw new Error('fixture timeout: '+diagnostic.slice(-3).join(''));}
const message=(update:number,text:string)=>({update_id:update,message:{message_id:update,date:Math.floor(Date.now()/1000),chat:{id:owner,type:'private'},from:{id:owner,is_bot:false,first_name:'Operator'},text}});
try{
 await until(()=>ready);
 for(const id of ids)updates.set(id,[message(1,'Say fixture complete without tools.')]);
 await until(()=>activeModels===3);
 updates.get(ids[0]!)!.push(message(2,'/status'));
 await until(()=>sent.some(m=>m.id===ids[0]&&m.text?.includes('全局执行：3/3')));
 updates.get(ids[0]!)!.push(message(3,'/models'));
 await until(()=>sent.some(m=>m.id===ids[0]&&m.text?.includes('可选 1 个')));
 assert.ok(!sent.some(m=>m.text?.includes('正在加载模型目录')),'model controls never create a task-loading placeholder');
 await until(()=>completed===4);
 await until(()=>JSON.parse(readFileSync(join(data,'status.json'),'utf8')).active===0);
 assert.equal(peak,3);assert.equal(arrivals.length,4);assert.ok(ids.every(id=>sent.some(m=>m.id===id&&m.text?.includes('fixture complete'))));
 assert.ok(sent.some(m=>m.text?.includes('fixture visible reasoning summary')&&m.text?.includes('思考过程')),'gateway renders provider-visible reasoning');
 assert.ok(sent.some(m=>m.text?.includes('思考中')),'gateway renders activity state');
 updates.get(ids[1]!)!.push(message(3,'/stop'));await until(()=>JSON.parse(readFileSync(join(data,'status.json'),'utf8')).bots.find((b:any)=>b.id==='child1').state==='paused');
 updates.get(ids[1]!)!.push(message(30,'/models'));await until(()=>sent.some(m=>m.id===ids[1]&&m.text?.includes('可选 1 个')));
 updates.get(ids[1]!)!.push(message(31,'/start'));await until(()=>JSON.parse(readFileSync(join(data,'status.json'),'utf8')).bots.find((b:any)=>b.id==='child1').state==='sleeping');assert.equal(arrivals.length,4);
 // Navigate an actual gateway panel and select a model without any extra sendMessage.
 const botId=ids[1]!;let uid=40;
 const home=[...sent].reverse().find(m=>m.id===botId&&m.text?.includes('子助手'))!;
 let mid=home.message_id;const sendCount=()=>sent.filter(m=>m.id===botId&&m.method==='sendMessage').length;
 let baseline=sendCount();const latest=()=>[...sent].reverse().find(m=>m.id===botId&&m.message_id===mid)!;
 const click=(label:string)=>{const key=latest().reply_markup.inline_keyboard.flat().find((b:any)=>b.text===label);assert.ok(key,`button ${label}`);updates.get(botId)!.push({update_id:uid++,callback_query:{id:'callback'+uid,from:{id:owner,is_bot:false,first_name:'Operator'},data:key.callback_data,message:{message_id:mid,date:Math.floor(Date.now()/1000),chat:{id:owner,type:'private'}}}});};
 click('🤖 模型');await until(()=>latest().text?.includes('可选 1 个'));assert.equal(sendCount(),baseline);
 click('✅ fixture/fake');await sleep(500);assert.equal(sendCount(),baseline);
 click('🧠 思考');await until(()=>latest().text?.includes('思考强度'));
 click('high');await until(()=>JSON.stringify(latest().reply_markup).includes('✅ high'));assert.equal(sendCount(),baseline);
 click('📊 状态');await until(()=>latest().text?.includes('子助手'));assert.equal(sendCount(),baseline);
 click('📈 用量');await until(()=>latest().text?.includes('<b>📈 Token 用量</b>'));
 for(const label of ['本会话累计','缓存命中率：<b>80.0%</b>','缓存读取：<b>80</b>','当前上下文','会话活动'])assert.ok(latest().text.includes(label),label);
 assert.ok(latest().reply_markup.inline_keyboard.every((row:any[])=>row.length<=2));
 click('🔄 刷新');await sleep(300);assert.equal(sendCount(),baseline);
 updates.get(botId)!.push(message(uid++,'/tokens'));await until(()=>sendCount()===baseline+1);
 const tokenPanel=[...sent].reverse().find(m=>m.id===botId&&m.method==='sendMessage')!;assert.notEqual(tokenPanel.message_id,mid);mid=tokenPanel.message_id;baseline++;
 assert.ok(latest().text.includes('<b>📈 Token 用量</b>'));
 click('⬅️ 返回面板');await until(()=>latest().text?.includes('子助手'));
 await until(()=>JSON.parse(readFileSync(join(data,'status.json'),'utf8')).active===0);assert.equal(arrivals.length,4,'panels never call model');
 // /bots is a human-readable panel view, with real bot links, no worker launch and no extra messages.
 const masterId=ids[0]!;let masterUid=100;
 updates.get(masterId)!.push(message(masterUid++,'/panel'));
 await until(()=>[...sent].reverse().find(m=>m.id===masterId)?.text?.includes('总控'));
 const masterHome=[...sent].reverse().find(m=>m.id===masterId&&m.text?.includes('总控'))!;
 let masterMid=masterHome.message_id;
 const masterLatest=()=>[...sent].reverse().find(m=>m.id===masterId&&m.message_id===masterMid)!;
 const masterSends=()=>sent.filter(m=>m.id===masterId&&m.method==='sendMessage').length;
 let beforeBotsSends=masterSends();
 const masterClick=(prefix:string)=>{const key=masterLatest().reply_markup.inline_keyboard.flat().find((b:any)=>b.text.startsWith(prefix));assert.ok(key,`master button ${prefix}`);updates.get(masterId)!.push({update_id:masterUid++,callback_query:{id:'mastercallback'+masterUid,from:{id:owner,is_bot:false,first_name:'Operator'},data:key.callback_data,message:{message_id:masterMid,date:Math.floor(Date.now()/1000),chat:{id:owner,type:'private'}}}});};
 masterClick('🛰 机器人总览');await until(()=>masterLatest().text?.includes('<b>🛰 机器人总览</b>'));
 let dashboard=masterLatest();assert.ok(!dashboard.text.includes('"bots":'));assert.ok(dashboard.text.includes('💤 休眠'));
 assert.ok(ids.every(id=>dashboard.reply_markup.inline_keyboard.flat().some((b:any)=>b.url===`https://t.me/fixture_${id}_bot`)));
 assert.ok(dashboard.text.includes('研究助手 1'),'Telegram first_name is displayed');
 assert.ok(dashboard.reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='💬 打开 研究助手 1'));
 assert.ok(!dashboard.reply_markup.inline_keyboard.flat().some((b:any)=>b.text?.includes('@fixture_')));
 const namedStatus=JSON.parse(readFileSync(join(data,'status.json'),'utf8'));
 assert.equal(namedStatus.bots.find((b:any)=>b.id==='child1').name,'研究助手 1','existing bot records are backfilled from getMe');
 masterClick('🔄 刷新');await sleep(300);assert.equal(masterSends(),beforeBotsSends);
 masterClick('⬅️ 返回面板');await until(()=>masterLatest().text?.includes('全局执行：'));
 updates.get(masterId)!.push(message(masterUid++,'/bots'));await until(()=>masterSends()===beforeBotsSends+1);
 masterMid=[...sent].reverse().find(m=>m.id===masterId&&m.method==='sendMessage')!.message_id;beforeBotsSends++;
 assert.ok(masterLatest().text.includes('<b>🛰 机器人总览</b>'));
 for(const command of ['/panel','/panel','/start']){
  const old=masterMid;updates.get(masterId)!.push(message(masterUid++,command));await until(()=>masterSends()===beforeBotsSends+1);
  masterMid=[...sent].reverse().find(m=>m.id===masterId&&m.method==='sendMessage')!.message_id;beforeBotsSends++;
  assert.notEqual(masterMid,old,`${command} creates a fresh visible message`);
  assert.ok(masterLatest().text.includes('总控'));
 }
 masterClick('📈 用量');await until(()=>masterLatest().text.includes('Token 用量'));assert.equal(masterSends(),beforeBotsSends);
 masterClick('⬅️ 返回面板');await until(()=>masterLatest().text.includes('总控'));assert.equal(masterSends(),beforeBotsSends);
 updates.get(botId)!.push(message(uid++,'/bots'));await until(()=>sendCount()===baseline+1);
 mid=[...sent].reverse().find(m=>m.id===botId&&m.method==='sendMessage')!.message_id;baseline++;
 assert.ok(latest().text.includes('请到总控查看机器人总览'));
 assert.ok(latest().reply_markup.inline_keyboard.flat().some((b:any)=>b.url===`https://t.me/fixture_${masterId}_bot`&&b.text==='👑 打开 总控助手'));
 assert.ok(!latest().text.includes('fixture_333333333_bot'),'child cannot see fleet listing');
 assert.equal(arrivals.length,4,'fleet dashboard never calls a model');
 assert.equal(JSON.parse(readFileSync(join(data,'status.json'),'utf8')).active,0);
 const verifyStore=new FleetStore(join(data,'fleet.sqlite'));assert.equal(verifyStore.jobs().filter(j=>j.kind==='panel').length,0,'no Agent job exists for any model/thinking panel');verifyStore.close();
 assert.equal(arrivals.length,4,'metadata panels never call a model, even while workers are busy or paused');
 console.log('FLEET GATEWAY PASSED (including linked /bots dashboard, master-only access, no agent wake and in-place panel navigation): 4 independent bots, exactly 3 concurrent real SDK model calls, fourth queues, controls responsive at capacity, per-bot delivery, all workers released, child stop/start does not load model.');
}finally{
 gateway.kill('SIGTERM');if(gateway.exitCode===null)await Promise.race([new Promise(r=>gateway.once('exit',r)),sleep(20000)]);if(gateway.exitCode===null)gateway.kill('SIGKILL');server.closeAllConnections();server.close();rmSync(root,{recursive:true,force:true});
}
