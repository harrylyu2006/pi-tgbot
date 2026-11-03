/** Fleet gateway: sole poller and secret writer; SDK Agents live only in disposable workers. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { createLogger, setLevel } from '../log.ts';
import { TelegramApi } from '../telegram/api.ts';
import { Poller } from '../telegram/poller.ts';
import { LiveMessage } from '../telegram/live.ts';
import { Files } from '../telegram/files.ts';
import { DeliveryStore, retryPendingDelivery } from '../telegram/delivery.ts';
import { State } from '../state.ts';
import { TelegramUI } from '../ui/telegram-ui.ts';
import { makeBootId, decodeCallback, encodeCallback, importCallbackArgs } from '../telegram/keyboard.ts';
import { loadSecretsPlugin } from '../secrets/plugin.ts';
import { createSecretsExtension } from '../secrets/extension.ts';
import { ManagedBots } from '../telegram/managed-bots.ts';
import { savedNotice, unlockedNotice } from '../secrets/service.ts';
import { FleetStore, Admission, type BotRecord, type Job } from './store.ts';
import { Rpc } from './ipc.ts';
import { history } from './history.ts';
import { memory, memoryPaths } from './memory.ts';
import { IdleWatchdog } from '../agent/idle-watchdog.ts';
import { redactOutbound } from '../telegram/redact.ts';
import { workerGroup } from './cgroup.ts';
import { ModelCatalog } from './catalog.ts';
import { PanelMessage, modelPanel, thinkingPanel, textPanel, botsPanel, botLink, botDisplayName, usagePanel, statusPanel, toolsPanel, type ModelChoice } from './panels.ts';

const config=loadConfig(process.argv[2]??'/etc/pi-tg/config.json');setLevel(config.logLevel);
const log=createLogger('fleet');const root=process.env.PI_FLEET_ROOT??'/var/lib/pi-tg/fleet';mkdirSync(root,{recursive:true,mode:0o700});
const memories=memoryPaths(config.agentDir,root);
const store=new FleetStore(`${root}/fleet.sqlite`);const admission=new Admission(3);
const catalog=new ModelCatalog({agentDir:config.agentDir});
const scopes=new AsyncLocalStorage<string>();const boot=makeBootId(Date.now());let closing=false;
interface Endpoint {bot:BotRecord;api:TelegramApi;files:Files;ui:TelegramUI;poller:Poller;delivery:DeliveryStore;generation:number;panelBoot:string;panel:PanelMessage;modelChoices?:ModelChoice[];modelPage:number;identityAt:number;identityRefresh?:Promise<void>;pendingReactions:Map<number,string>}
interface Running {child:ChildProcess;rpc:Rpc;job:Job;live?:LiveMessage;done:boolean;started:boolean;aborted:boolean;generation:number;work:Promise<void>;group?:ReturnType<typeof workerGroup>;finish?:Promise<void>}
const endpoints=new Map<string,Endpoint>();const workers=new Map<string,Running>();
const pendingLocks=new Map<string,{owner:string;ticket:string;queue:Array<{owner:string;resolve:(t:string)=>void;reject:()=>void;signal:AbortSignal}>}>();
const activeRequests=new Map<string,AbortController>();
const credentialTails=new Map<string,Promise<void>>();
const commandTasks=new Set<Promise<unknown>>();
const deliveriesActive=new Set<string>();
const inboundBusy=new Set<string>();
function dispatchUpdate(e:Endpoint,u:any):void{
 const key=`${e.bot.id}:${u.update_id}`;if(inboundBusy.has(key))return;inboundBusy.add(key);
 const safeUpdate=secrets.scrubber.scrubDeep(u);
 try{store.acceptUpdate(e.bot.id,safeUpdate);}catch{process.exit(1);}
 bg(scopes.run(e.bot.id,async()=>{
  try{await onUpdate(e,safeUpdate);store.completeUpdate(e.bot.id,u.update_id);}
  finally{inboundBusy.delete(key);}
 }));
}
function bg(p:Promise<unknown>):void{commandTasks.add(p);void p.catch(()=>log.warn({msg:'background operation failed'})).finally(()=>commandTasks.delete(p));}
function endpoint(id:string):Endpoint{const e=endpoints.get(id);if(!e)throw new Error('Unknown bot');return e;}
function current():Endpoint{return endpoint(scopes.getStore()??'master');}
function send(id:string,text:string,extra:any={}):Promise<any>{return endpoint(id).api.sendMessage({chat_id:config.allowedUserId,text:secrets.scrubText(text),...extra});}
function sourceScope():string{return scopes.getStore()??'master';}
const routedApi=new Proxy({} as TelegramApi,{get(_t,key){return (...args:any[])=>{const api=current().api;return (api as any)[key](...args);};}});
const routedUI=new Proxy({} as TelegramUI,{get(_t,key){return (...args:any[])=>{const e=current();return (e.ui as any)[key](...args);};}});
if(!config.secrets)throw new Error('Fleet requires the secrets plugin');
const plugin=await loadSecretsPlugin({config:config.secrets,api:routedApi,ui:routedUI,log:log.child('secrets'),operatorChatId:config.allowedUserId,currentChatId:()=>config.allowedUserId,
 notifyAgent:(text,_chat,replyTo)=>{const id=sourceScope();enqueue(id,'prompt',{text,replyTo,system:true});}});
const secrets=plugin.service;
const secretTools=new Map<string,any>();const secretHooks=new Map<string,Array<(e:any)=>Promise<any>>>();
createSecretsExtension(secrets)({registerTool:(t:any)=>secretTools.set(t.name,t),on:(n:string,h:any)=>{const list=secretHooks.get(n)??[];list.push(h);secretHooks.set(n,list);}} as any);
const descriptors=[...secretTools.values()].map(({execute,renderCall,renderResult,...data})=>data);
const safe=(t:string)=>secrets.scrubText(redactOutbound(t).text);
function enqueue(id:string,kind:string,payload:any):Job{const j=store.enqueue(id,kind,payload);pump();return j;}
function status():any{return {limit:3,active:workers.size,bots:store.bots().map(b=>({id:b.id,username:b.username,name:b.name,role:b.role,master:b.master,enabled:b.enabled,state:workers.has(b.id)?'running':!b.enabled?'paused':store.jobs('queued').some(j=>j.bot===b.id)?'queued':'sleeping',pid:workers.get(b.id)?.child.pid??null,model:b.model,thinking:b.thinking,session:store.getSnapshot(b.id)?.sessionId,queued:store.jobs('queued').filter(j=>j.bot===b.id).length}))};}
function writeStatus():void{writeFileSync(`${root}/status.json.tmp`,JSON.stringify(status(),null,2),{mode:0o600});renameSync(`${root}/status.json.tmp`,`${root}/status.json`);}
async function lock(owner:string,key:string,signal:AbortSignal):Promise<string>{
 if(key.length>1024)throw new Error('Invalid lock');signal.throwIfAborted();
 const held=pendingLocks.get(key);const ticket=randomUUID();
 if(!held){pendingLocks.set(key,{owner,ticket,queue:[]});return ticket;}
 return new Promise((resolve,reject)=>{const item={owner,resolve,reject:()=>reject(new Error('Lock wait cancelled')),signal};held.queue.push(item);signal.addEventListener('abort',()=>{held.queue=held.queue.filter(q=>q!==item);item.reject();},{once:true});});
}
function unlock(owner:string,key:string,ticket?:string):void{
 const held=pendingLocks.get(key);if(!held||held.owner!==owner||(ticket&&held.ticket!==ticket))return;
 let next;while((next=held.queue.shift())&&next.signal.aborted){};
 if(next){held.owner=next.owner;held.ticket=randomUUID();next.resolve(held.ticket);}else pendingLocks.delete(key);
}
function releaseLocks(owner:string):void{for(const[key,h]of pendingLocks){h.queue=h.queue.filter(q=>{if(q.owner!==owner)return true;q.reject();return false;});if(h.owner===owner)unlock(owner,key);}}
function refreshSnapshot(id:string,s:any):void{if(!s)return;store.snapshot(id,s);const b=store.bot(id)!;b.fresh=false;store.saveBot(b);endpoint(id).bot=b;}
async function rpcHandler(e:Endpoint,r:Running,op:string,args:any,signal:AbortSignal):Promise<any>{
 return scopes.run(e.bot.id,async()=>{
  if(op==='lock')return lock(r.job.id,args.key,signal);
  if(op==='unlock'){unlock(r.job.id,args.key,args.ticket);return true;}
  if(op==='ui'){
   if(r.aborted)throw new Error('Task cancelled');
   if(!['select','confirm','notify'].includes(args.method))throw new Error('Unknown UI method');
   const values=secrets.scrubber.scrubDeep(args.args);
   if(args.method==='notify')return e.ui.notify(...values as [string,any]);
   return (e.ui as any)[args.method](values[0],values[1],{timeout:values[2]?.timeout,signal});
  }
  if(op==='secrettool'){
   if(r.aborted)throw new Error('Task cancelled');
   const tool=secretTools.get(args.name);if(!tool)throw new Error('Unknown secret tool');
   let ticket:string|undefined;
   const lockKey=args.name==='keepass_unlock'?'keepass-unlock':args.name==='secret_run'?'credential-use-budget':undefined;
   if(lockKey)ticket=await lock(r.job.id,lockKey,signal);
   try{signal.throwIfAborted();return await tool.execute(args.id,args.params,signal,()=>{}, {cwd:config.cwd,fleetWorkerCgroup:r.group?.path});}
   finally{if(ticket&&lockKey)unlock(r.job.id,lockKey,ticket);}
  }
  if(op==='secrethook'){
   if(r.aborted&&args.event==='tool_call')return {result:{block:true,reason:'Task cancelled'}};
   if(!['tool_call','tool_result','context'].includes(args.event))throw new Error('Unknown hook');
   let ticket:string|undefined;
   const credentialCall=args.event==='tool_call'&&JSON.stringify(args.data.input??{}).includes('{{secret:');
   if(credentialCall)ticket=await lock(r.job.id,'credential-use-budget',signal);
   try{let result:any;for(const handler of secretHooks.get(args.event)??[])result=await handler(args.data)??result;
    return {result,...(args.event==='tool_call'?{input:args.data.input}:{})};
   }finally{if(ticket)unlock(r.job.id,'credential-use-budget',ticket);}
  }
  if(op!=='tool'||r.aborted)throw new Error('Unknown or cancelled request');
  const a=args.args;const text=(value:any)=>({content:[{type:'text',text:typeof value==='string'?safe(value):safe(JSON.stringify(value))}],details:{}});
  if(args.name==='telegram_ask')return text(`操作员选择了：${await e.ui.select(a.question,a.options,{timeout:600000,signal})??'超时/取消，不要代替用户决定'}`);
  if(args.name==='telegram_send_file')return text((await e.files.send(config.allowedUserId,a.path,a.caption)).detail);
  if(args.name==='fleet_memory'){
   if(a.content!==undefined&&secrets.scrubText(a.content)!==a.content)throw new Error('Refusing to store credential in shared memory');
   return text(memory(a,memories));
  }
  if(!e.bot.master)throw new Error('Master-only control');
  if(args.name==='fleet_status')return text(status());
  const target=store.bot(a.bot)??store.bots().find(b=>b.username===String(a.bot).replace(/^@/,''));if(!target)throw new Error('Unknown bot');
  if(args.name==='fleet_history')return text(await history(target.sessionDir,a,safe));
  if(args.name==='fleet_configure'){
   if(a.role!==undefined)target.role=String(a.role).slice(0,4000);
   if(a.model!==undefined){if(!String(a.model).includes('/'))throw new Error('Model must be provider/id');target.model=a.model;}
   if(a.thinking!==undefined){if(!['off','minimal','low','medium','high','xhigh','max'].includes(a.thinking))throw new Error('Invalid thinking');target.thinking=a.thinking;}
   store.saveBot(target);endpoint(target.id).bot=target;writeStatus();return text({saved:true,nextTask:true,bot:target.id});
  }
  if(args.name==='fleet_control'){if(target.master)throw new Error('Cannot stop master via child control');if(!['start','stop'].includes(a.action))throw new Error('Invalid action');await enable(target.id,a.action==='start');return text(status());}
  throw new Error('Unknown tool');
 });
}
function pump():void{
 if(closing)return;
 let job:Job|undefined;
 while((job=admission.next(store.jobs('queued'),id=>!!store.bot(id)?.enabled&&!deliveriesActive.has(id)))){const selected=job;void launch(selected).catch(()=>{store.setStatus(selected.id,'failed');admission.release(selected.bot);pump();});}
 writeStatus();
}
async function launch(job:Job):Promise<void>{
 const e=endpoint(job.bot);e.bot=store.bot(job.bot)!;store.setStatus(job.id,'starting');
 const child=fork(fileURLToPath(new URL('./worker.ts',import.meta.url)),[],{serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{...process.env,PI_FLEET_BOT_ID:e.bot.id,PI_FLEET_JOB_ID:job.id,PI_SKIP_VERSION_CHECK:'1'},execArgv:['--max-old-space-size=768']});
 child.on('error',()=>log.error({msg:'worker spawn failed'}));
 let group:ReturnType<typeof workerGroup>;
 try{if(!child.pid)throw new Error('Worker has no pid');group=workerGroup(job.id,child.pid);}catch{child.kill('SIGKILL');throw new Error('Could not create worker cgroup; refusing untracked execution');}
 const r:Running={child,rpc:null as any,job,done:false,started:false,aborted:false,generation:1,work:Promise.resolve(),group};
 r.rpc=new Rpc(m=>{if(child.connected)child.send(m);},(op,args,signal)=>rpcHandler(e,r,op,args,signal));workers.set(e.bot.id,r);writeStatus();
 const watchdog=new IdleWatchdog(config.turn.idleTimeoutMs+15000,()=>{void abort(e.bot.id);});watchdog.touch();
 const handle=async(m:any)=>{
  if(m?.rpc){void r.rpc.receive(m);return;}
  if(m?.event==='ready'){refreshSnapshot(e.bot.id,m.snapshot);store.setStatus(job.id,'running');}
  if(m?.event==='started')r.started=true;
  if(m?.event==='answer')r.live?.setAnswer(safe(m.text));
  if(m?.event==='thinking')r.live?.setThinking(safe(m.text));
  if(m?.event==='activity')r.live?.setActivity(safe(m.text));
  if(m?.event==='done'){
   r.done=true;refreshSnapshot(e.bot.id,m.snapshot);
   if(job.kind==='prompt'){const result=await r.live!.finish(r.aborted?'⏹ 任务已中断，部分操作可能已执行。':safe(m.text));store.setStatus(job.id,result.complete?(r.aborted?'cancelled':m.failed?'failed':'completed'):'delivery_pending');}
   else store.setStatus(job.id,'completed');
  }
  if(m?.event==='panel'){
   r.done=true;refreshSnapshot(e.bot.id,m.snapshot);e.modelChoices=m.models??[];
   // A slow catalogue load must not overwrite a newer navigation click.
   if(e.panel.isCurrent(job.payload.revision))await showView(e,job.payload.view??'model',job.payload.messageId,job.payload.revision);
   store.setStatus(job.id,'completed');
  }
  if(m?.event==='failed'){r.done=true;log.warn({msg:'worker failure',phase:m.phase,errorName:m.errorName});if(r.live)await r.live.finish(m.message);else if(job.kind==='panel')await e.panel.update(textPanel(m.message,encoder(e)),job.payload.messageId,job.payload.revision);else await send(e.bot.id,m.message);store.setStatus(job.id,'failed');}
 };
 child.on('message',(m:any)=>{watchdog.touch();if(m?.rpc){void r.rpc.receive(m);return;}r.work=r.work.then(()=>handle(m)).catch(()=>{store.setStatus(job.id,'failed');});});
 child.once('exit',()=>{bg((async()=>{
  watchdog.stop();e.ui.cancelAll();r.rpc.close();await r.work;
  if(!r.done){store.setStatus(job.id,r.aborted?'cancelled':'interrupted');if(r.live)await r.live.finish('⚠️ 工作进程已结束，部分操作可能已执行；不会自动重跑。').catch(()=>{});}
  group.kill();group.remove();
  try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}
  releaseLocks(job.id);workers.delete(e.bot.id);admission.release(e.bot.id);writeStatus();pump();
 })());});
 try{
  if(job.kind==='prompt'){
   r.live=new LiveMessage(e.api,log.child('delivery'),{...config.render,chatId:config.allowedUserId,replyTo:job.payload.replyTo||undefined,deliveryStore:e.delivery});
   r.live.setPrompt(job.payload.text);await r.live.begin();
  }
  const workerConfig={...config,sessionDir:e.bot.sessionDir,statePath:e.bot.statePath,files:{...config.files,inboxDir:`${root}/bots/${e.bot.id}/inbox`}};
  delete (workerConfig as any).botToken;delete (workerConfig as any).secrets;
  child.send({event:'init',config:workerConfig,bot:e.bot,job,descriptors,snapshot:store.getSnapshot(e.bot.id),boot:e.panelBoot});
 }catch{r.aborted=true;child.kill('SIGTERM');}
}
async function enable(id:string,enabled:boolean):Promise<void>{
 const e=endpoint(id);const b=store.bot(id)!;b.enabled=enabled;store.saveBot(b);e.bot=b;
 if(!enabled){for(const j of store.jobs('queued').filter(j=>j.bot===id))store.setStatus(j.id,'cancelled');await abort(id);}
 pump();writeStatus();
}
async function abort(id:string):Promise<void>{const r=workers.get(id);if(!r)return;r.aborted=true;endpoint(id).ui.cancelAll();void r.rpc.call('abort',{},undefined,5000).catch(()=>{});setTimeout(()=>{if(workers.get(id)===r)r.child.kill('SIGTERM');},7000).unref();setTimeout(()=>{if(workers.get(id)===r)r.group?.kill();},13000).unref();}
function encoder(e:Endpoint):(action:string,arg?:string)=>string{return (action,arg='')=>encodeCallback(action,arg,e.panelBoot,e.generation);}
async function panel(e:Endpoint,messageId?:number|null,revision=e.panel.begin()):Promise<void>{
 await refreshIdentity(e);
 const b=store.bot(e.bot.id)!;const fleet=status();const state=fleet.bots.find((bot:any)=>bot.id===b.id)!;
 await e.panel.update(statusPanel({...state,master:b.master},store.getSnapshot(b.id),fleet.active,fleet.limit,encoder(e),fleet.bots.length),messageId,revision);
}
async function showView(e:Endpoint,view:string,messageId?:number|null,revision=e.panel.begin()):Promise<void>{
 if(!e.panel.isCurrent(revision))return;
 const b=store.bot(e.bot.id)!;const s=store.getSnapshot(e.bot.id);const cb=encoder(e);
 const display=(text:string)=>e.panel.update(textPanel(text,cb,b.master),messageId,revision);
 if(view==='bots'||view.startsWith('bots:')){
  if(!b.master){
   const master=store.bots().find(bot=>bot.master);const url=master?botLink(master.username):undefined;
   const body=textPanel('请到总控查看机器人总览。',cb);
   if(url)(body.markup as any).inline_keyboard.unshift([{text:`👑 打开 ${botDisplayName(master!)}`,url}]);
   await e.panel.update(body,messageId,revision);return;
  }
  await Promise.all([...endpoints.values()].map(bot=>refreshIdentity(bot)));
  if(!e.panel.isCurrent(revision))return;
  await e.panel.update(botsPanel(status(),view.startsWith('bots:')?Number(view.slice(5)):0,cb),messageId,revision);return;
 }
 if(view==='status'){await panel(e,messageId,revision);return;}
 if(view==='confirm_new'){
  await e.panel.update({text:'新建本 bot 的会话？\n\n当前上下文不再用于新任务，但历史、共享记忆及模型设置保留。',markup:{inline_keyboard:[[{text:'确认新会话',callback_data:cb('do_new')},{text:'取消',callback_data:cb('view','status')}]]}},messageId,revision);return;
 }
 if(view==='tokens'){
  let snapshot=s;const running=workers.get(e.bot.id);
  // Query only an already-running worker. Sleeping bots stay asleep; no provider request is made.
  if(running&&!running.done&&!running.aborted){
   const fresh=await running.rpc.call('snapshot',{},undefined,1800).catch(()=>null);
   if(fresh&&workers.get(e.bot.id)===running&&!running.done){snapshot=fresh;store.snapshot(e.bot.id,fresh);}
  }
  if(!e.panel.isCurrent(revision))return;
  await e.panel.update(usagePanel(snapshot,cb,b.master,!!running&&!running.done),messageId,revision);return;
 }
 if(view==='tools'){await e.panel.update(toolsPanel(s?.tools,cb,b.master),messageId,revision);return;}
 if(view==='model'||view.startsWith('model:')||view==='think'){
  const result=await catalog.get();
  if(!e.panel.isCurrent(revision))return;
  e.modelChoices=result.models;
  const selected=store.bot(e.bot.id)!;
  if(result.error&&!result.models.length){await display(result.error);return;}
  let body;
  if(view==='think'){
   const choice=result.models.find(m=>m.spec===(selected.model??s?.model));
   const levels=choice?.levels??(s&&(!selected.model||s.model===selected.model)?s.thinkingLevels:undefined);
   if(!levels){await display('当前模型不在可用目录中，请先选择模型。');return;}
   body=thinkingPanel(levels,selected.thinking??(s?.model===selected.model?s.thinking:undefined),cb,b.master);
  }else{
   e.modelPage=view.startsWith('model:')?Number(view.slice(6))||0:0;
   body=modelPanel(result.models,selected.model??s?.model,e.modelPage,cb,b.master);
  }
  if(result.error)body.text+='\n\n<i>⚠️ 本次刷新失败，暂显示上次可用目录。</i>';
  await e.panel.update(body,messageId,revision);return;
 }
 await panel(e,messageId,revision);
}
async function callback(e:Endpoint,u:any):Promise<void>{
 const q=u.callback_query;const d=decodeCallback(q.data);const messageId=q.message?.message_id;
 const answer=(text?:string)=>e.api.answerCallbackQuery(q.id,text).catch(()=>{});
 if(!d||d.boot!==e.panelBoot||d.gen!==e.generation){await answer('旧按钮已失效，请打开 /panel');return;}
 if(d.action==='cf'){await answer(e.ui.resolve(d.arg).ok?'已记录':'该确认已结束');return;}
 if(messageId===undefined){await answer('面板消息不可用');return;}
 if(d.action==='model'||d.action==='think'){
  const b=store.bot(e.bot.id)!;const s=store.getSnapshot(e.bot.id);
  if(d.action==='model'){
   const choice=e.modelChoices?.find(m=>m.spec===d.arg);if(!choice){await answer('模型目录已过期，请重新打开模型页');return;}
   b.model=d.arg;if(b.thinking&&!choice.levels.includes(b.thinking))b.thinking=undefined;
  }else{
   const levels=e.modelChoices?.find(m=>m.spec===b.model)?.levels??(s?.model===b.model?s.thinkingLevels:[]);
   if(!levels.includes(d.arg)){await answer('当前模型不支持该思考档位');return;}b.thinking=d.arg;
  }
  store.saveBot(b);e.bot=b;writeStatus();await answer('已保存，下一任务生效');
  await showView(e,d.action==='model'?`model:${e.modelPage}`:'think',messageId);return;
 }
 await answer();
 if(d.action==='view'||d.action==='mpage'){await showView(e,d.action==='mpage'?`model:${d.arg}`:d.arg,messageId);return;}
 if(d.action==='enable'){await enable(e.bot.id,true);await panel(e,messageId);return;}
 if(d.action==='stop'){if(e.bot.master)await abort(e.bot.id);else await enable(e.bot.id,false);await panel(e,messageId);return;}
 if(d.action==='restart-confirm'||d.action==='do_restart'){
  if(!e.bot.master){await e.panel.update(textPanel('只有总控可以全局重启。',encoder(e)),messageId);return;}
  if(d.action==='restart-confirm'){
   const cb=encoder(e);await e.panel.update({text:`全局重启将中断 ${workers.size} 个工作进程；保留聊天与配置，但不自动重跑已开始的操作。确认？`,markup:{inline_keyboard:[[{text:'确认全局重启',callback_data:cb('do_restart')},{text:'取消',callback_data:cb('view','status')}]]}},messageId);return;
  }
  await e.panel.update({text:'正在全局重启；重启后空闲 bot 保持休眠。'},messageId);await shutdown(true);return;
 }
 if(d.action==='do_new'){await fresh(e,messageId);return;}
}
async function fresh(e:Endpoint,messageId?:number|null):Promise<void>{const report=(text:string)=>e.panel.update(textPanel(text,encoder(e),e.bot.master),messageId);if(workers.has(e.bot.id)){await report('请先停止当前任务，再 /new。');return;}const b=store.bot(e.bot.id)!;b.fresh=true;store.saveBot(b);await report('下次任务将开启新会话；旧记录保留，模型和思考不变。');}
async function onUpdate(e:Endpoint,u:any):Promise<void>{
 if(closing||store.seen(e.bot.id,u.update_id))return;
 if(u.callback_query){store.markSeen(e.bot.id,u.update_id);await callback(e,u);return;}
 if(u.managed_bot||u.message?.managed_bot_created){store.markSeen(e.bot.id,u.update_id);if(e.bot.master){await managed.handle(u);await enrollManaged();}return;}
 if(u.message_reaction){
  store.markSeen(e.bot.id,u.update_id);
  const r=u.message_reaction;
  const emojis=Array.isArray(r.new_reaction)?r.new_reaction.map((x:any)=>x?.emoji??(x?.custom_emoji_id?`[自定义表情:${x.custom_emoji_id}]`:'')).filter(Boolean).join(''):'';
  if(!emojis){e.pendingReactions.delete(r.message_id);return;}
  const running=workers.get(e.bot.id);
  if(running&&running.started&&!running.done){
   const accepted=await running.rpc.call('steer',{text:`[操作员对消息 #${r.message_id} 点了表情回应：${emojis}]`},undefined,3000).catch(()=>false);
   if(accepted)return;
  }
  e.pendingReactions.set(r.message_id,emojis);
  if(e.pendingReactions.size>20)e.pendingReactions.delete(e.pendingReactions.keys().next().value!);
  return;
 }
 const msg=u.message;if(!msg)return;
 const text=(msg.text??msg.caption??'').trim();
 if(msg.date*1000<Date.now()-config.coldStart.staleSeconds*1000){store.markSeen(e.bot.id,u.update_id);await send(e.bot.id,'已跳过过期积压消息，请重新发送需要执行的任务。');return;}
 if(text.startsWith('/')){
  const command=text.split(/\s+/)[0].split('@')[0];
  if(['/start','/help','/panel','/status','/stop','/new','/restart','/bots','/models','/think','/tokens','/usage','/retry','/unlock','/lock','/secret','/secrets','/newbot','/syncbot'].includes(command)){
   store.markSeen(e.bot.id,u.update_id);
   if(command==='/start'){await enable(e.bot.id,true);await panel(e,null);return;}
   if(['/help','/panel','/status'].includes(command)){await panel(e,null);return;}
   if(command==='/stop'){if(e.bot.master)await abort(e.bot.id);else await enable(e.bot.id,false);await send(e.bot.id,e.bot.master?'已请求中断总控当前任务。':'本 bot 已暂停；/start 恢复。历史和配置保留。');return;}
   if(command==='/new'){await fresh(e,null);return;}
   if(command==='/bots'){await showView(e,'bots',null);return;}
   if(command==='/restart'){
    if(!e.bot.master){await send(e.bot.id,'子助手 仅支持自己的 /stop 和 /start；全局重启请到总控。');return;}
    await send(e.bot.id,`全局重启会中断全部当前任务，不自动重跑外部操作。确认？`,{reply_markup:{inline_keyboard:[[{text:'确认全局重启',callback_data:encodeCallback('do_restart','',e.panelBoot,e.generation)},{text:'取消',callback_data:encodeCallback('view','status',e.panelBoot,e.generation)}]]}});return;
   }
   if(['/models','/think','/tokens','/usage'].includes(command)){await showView(e,command==='/models'?'model':command==='/think'?'think':'tokens',null);return;}
   if(command==='/retry'){if(workers.has(e.bot.id)||deliveriesActive.has(e.bot.id)){await send(e.bot.id,'请等当前任务或交付结束后再重发。');return;}deliveriesActive.add(e.bot.id);try{await retryPendingDelivery(e.api,e.delivery,config.allowedUserId);}finally{deliveriesActive.delete(e.bot.id);pump();}return;}
   if(['/secret','/secrets','/unlock','/lock'].includes(command)){await secrets.handleCommand(text,config.allowedUserId,msg.message_id);return;}
   if(['/newbot','/syncbot'].includes(command)){if(!e.bot.master){await send(e.bot.id,'创建和管理 bot 请到总控操作。');return;}if(command==='/newbot')await managed.request('子助手',text.split(/\s+/)[1]);else {await managed.sync(Number(text.split(/\s+/)[1]));await enrollManaged();}return;}
  }
 }
 if(!store.bot(e.bot.id)?.enabled){store.markSeen(e.bot.id,u.update_id);await send(e.bot.id,'本 bot 已暂停，发送 /start 恢复后再发任务。');return;}
 let prompt=text;
 if(msg.photo||msg.document||msg.sticker){
  const received=await e.files.receive(msg);let paths=received.paths;
  if(secrets.keepass)paths=await secrets.handleUploads(paths,config.allowedUserId,msg.message_id);
  if(received.rejected.length)await send(e.bot.id,received.rejected.join('\n'));
  if(!paths.length){store.markSeen(e.bot.id,u.update_id);return;}
  prompt=`${text||'请查看附件。'}\n附件路径：\n${paths.join('\n')}`;
 }
 if(!prompt){store.markSeen(e.bot.id,u.update_id);await send(e.bot.id,'请发送文字、图片或文件。');return;}
 if(e.pendingReactions.size){
  const notes=[...e.pendingReactions.entries()].map(([id,em])=>`[操作员此前对消息 #${id} 点了表情回应：${em}]`).join('\n');
  e.pendingReactions.clear();
  prompt=`${notes}\n${prompt}`;
 }
 const j=store.incoming(e.bot.id,u.update_id,'prompt',{text:secrets.scrubText(prompt),replyTo:msg.message_id});if(!j)return;
 const running=workers.get(e.bot.id);
 if(running&&running.started&&!running.done){
  store.setStatus(j.id,'steering');const accepted=await running.rpc.call('steer',{text:prompt},undefined,5000).catch(()=>false);
  if(accepted){store.setStatus(j.id,'attached');store.event(e.bot.id,j.id,'attached',running.job.id);return;}
  store.setStatus(j.id,'queued');
 }
 if(admission.active.size>=3||workers.has(e.bot.id))await send(e.bot.id,'任务已排队；全局最多 3 个工作进程。');pump();
}
/** Refresh Telegram display names on demand (cached, no Agent/model wake). */
async function refreshIdentity(e:Endpoint):Promise<void>{
 if(e.identityRefresh)return e.identityRefresh;
 if(Date.now()-e.identityAt<60000)return;
 e.identityAt=Date.now();
 e.identityRefresh=(async()=>{
  try{
   const info=await e.api.call<{id:number;first_name:string;username?:string}>('getMe',{}, {timeoutMs:2500});
   if(info.id!==e.bot.telegramId||typeof info.first_name!=='string'||!info.first_name.trim())return;
   const latest=store.bot(e.bot.id);if(!latest)return;
   const updated={...latest,name:info.first_name,...(info.username?{username:info.username}:{})};
   if(updated.name!==latest.name||updated.username!==latest.username){store.saveBot(updated);e.bot=updated;writeStatus();}
  }catch{/* Keep last known display name when Telegram is temporarily unavailable. */}
 })().finally(()=>{e.identityRefresh=undefined;});
 return e.identityRefresh;
}
async function addEndpoint(bot:BotRecord):Promise<void>{
 if(endpoints.has(bot.id))return;
 const token=bot.master?config.botToken:secrets.vault.get(bot.secretName!,{touch:false});
 const api=new TelegramApi(token,log.child('telegram'));
 const info=await api.getMe();if(info.id!==bot.telegramId)throw new Error('Bot identity mismatch');
 bot={...bot,name:info.first_name,...(info.username?{username:info.username}:{})};store.saveBot(bot);
 const delivery=new DeliveryStore(`${bot.statePath}.deliveries.json`);delivery.load();
 const e:Endpoint={bot,api,delivery,generation:1,panelBoot:makeBootId(Date.now())+bot.id.slice(-3),ui:null as any,files:new Files(api,log,{...config.files,inboxDir:`${root}/bots/${bot.id}/inbox`}),poller:null as any,panel:new PanelMessage(api,config.allowedUserId,safe),modelPage:0,identityAt:Date.now(),pendingReactions:new Map()};
 e.ui=new TelegramUI({api,log,bootId:e.panelBoot,currentChatId:()=>config.allowedUserId,generation:()=>e.generation});
 const commands=[{command:'start',description:'启用 / 操作面板'},{command:'panel',description:'模型、思考与状态'},{command:'stop',description:bot.master?'中断当前总控任务':'暂停本 bot'},{command:'models',description:'选择本 bot 的模型'},{command:'think',description:'选择思考强度'},{command:'tokens',description:'会话用量'},{command:'new',description:'新会话（保留历史）'},{command:'retry',description:'重发未送达回答'},...(bot.master?[{command:'bots',description:'机器人总览与聊天入口'},{command:'restart',description:'全局重启（需确认）'},{command:'newbot',description:'创建子助手'}]:[])];
 e.poller=new Poller(api,log,{allowedUserId:config.allowedUserId,commands,onUpdate:u=>dispatchUpdate(e,u),onFatal:()=>{log.error({msg:'bot poller fatal'});}});
 endpoints.set(bot.id,e);await e.poller.preflight();bg(e.poller.run());
}
const managed=new ManagedBots({api:routedApi,secrets,operatorId:config.allowedUserId,path:`${dirname(config.statePath)}/managed-bots.json`,log,notify:(text,replyTo)=>{
 enqueue('master','prompt',{text,replyTo,system:true});
}});
async function enrollManaged():Promise<void>{
 for(const record of managed.list()){
  const id=`child-${record.id}`;if(store.bots().some(b=>b.telegramId===record.id))continue;
  const master=store.bot('master')!;
  const b:BotRecord={id,telegramId:record.id,username:record.username,name:record.name,role:'通用子助手，独立完成本聊天交代的任务；分工可由总控调整。',master:false,enabled:true,secretName:record.secretName,sessionDir:`${root}/bots/${id}/sessions`,statePath:`${root}/bots/${id}/state.json`,model:master.model??config.model,thinking:master.thinking};
  mkdirSync(b.sessionDir,{recursive:true,mode:0o700});store.saveBot(b);await addEndpoint(b);
  await send('master',`子助手「${botDisplayName(b)}」已登记，空闲时无 Agent 进程。请先打开它并点开始。`);
 }
}
async function shutdown(restart=false):Promise<void>{
 if(closing)return;closing=true;
 if(restart)writeFileSync(`${dirname(config.statePath)}/unlock-on-start`,'',{mode:0o600});
 for(const e of endpoints.values())e.poller.stop();
 for(const id of workers.keys())await abort(id);
 await Promise.race([new Promise<void>(r=>{const t=setInterval(()=>{if(!workers.size){clearInterval(t);r();}},100);}),new Promise(r=>setTimeout(r,16000))]);
 for(const r of workers.values()){r.group?.kill();try{if(r.child.pid)process.kill(-r.child.pid,'SIGKILL');}catch{}}
 await secrets.stop();store.close();process.exit(0);
}
async function main():Promise<void>{
 if(!store.bot('master')){
  const me=await new TelegramApi(config.botToken,log).getMe();const state=new State(config.statePath,log);state.load();
  store.saveBot({id:'master',telegramId:me.id,username:me.username!,name:me.first_name,role:'总控：统筹任务、共享记忆、管理子助手，并按需查看子助手 聊天记录。',master:true,enabled:true,sessionDir:config.sessionDir,statePath:config.statePath,model:state.agentPreferences.model??config.model,thinking:state.agentPreferences.thinkingLevel});
 }
 const resumeFlag=`${root}/resume-master.json`;
 if(existsSync(resumeFlag)){const s=JSON.parse(readFileSync(resumeFlag,'utf8'));store.snapshot('master',s);unlinkSync(resumeFlag);}
 const childBootstrap=`${root}/adopt-managed.json`;
 if(existsSync(childBootstrap)){
  const spec=JSON.parse(readFileSync(childBootstrap,'utf8'));const name=`tg-managed-${spec.telegramId}`;
  if(!store.bot(spec.id)&&secrets.vault.has(name)){
   const b:BotRecord={id:spec.id,telegramId:spec.telegramId,username:spec.username,name:spec.name,role:spec.role??'通用子助手，独立处理用户在本 bot 交代的任务。',master:false,enabled:true,secretName:name,sessionDir:`${root}/bots/${spec.id}/sessions`,statePath:`${root}/bots/${spec.id}/state.json`,model:store.bot('master')!.model??config.model,thinking:store.bot('master')!.thinking};
   mkdirSync(b.sessionDir,{recursive:true,mode:0o700});store.saveBot(b);
  }
  unlinkSync(childBootstrap);
 }
 await addEndpoint(store.bot('master')!);
 await secrets.start();
 for(const b of store.bots().filter(b=>!b.master))await addEndpoint(b);
 for(const j of store.recover())bg(send(j.bot,'⚠️ 上次任务在重启时中断，可能已执行部分操作；没有自动重跑。'));
 const unlockFlag=`${dirname(config.statePath)}/unlock-on-start`;
 if(existsSync(unlockFlag))bg(scopes.run('master',()=>secrets.startupUnlock(unlockFlag)));
 process.on('SIGTERM',()=>bg(shutdown()));process.on('SIGINT',()=>bg(shutdown()));
 process.on('uncaughtException',()=>{log.error({msg:'fleet uncaught exception'});process.exit(1);});
 process.on('unhandledRejection',()=>log.error({msg:'fleet rejected asynchronous operation'}));
 // Root-private local command spool for operator scripts and migration probes. Never accepts raw credentials.
 setInterval(()=>{
  const p=`${root}/control.json`;if(!existsSync(p))return;
  try{const c=JSON.parse(readFileSync(p,'utf8'));unlinkSync(p);
   if(c.action==='probe'&&store.bot(c.bot))enqueue(c.bot,'probe',{});
   else if(c.action==='panel'&&store.bot(c.bot))bg(panel(endpoint(c.bot)));
  }catch{log.warn({msg:'invalid fleet control file'});}
 },1000).unref();
 for(const row of store.pendingUpdates()){const e=endpoints.get(row.bot);if(e)dispatchUpdate(e,row.update);}
 // Warm metadata once, shared by all bots. No Agent, extensions, history load, or task slot.
 void catalog.get().catch(()=>undefined);
 writeStatus();pump();log.info({msg:'fleet ready',endpoints:endpoints.size,limit:3,features:['panel-inplace','live-thinking-activity','independent-child-preferences','bots-dashboard','usage-ui-restored','command-new-panel','bot-display-names','metadata-model-catalog']});
 const uiFixNotice=`${root}/ui-fix-notice-on-start`;
 if(existsSync(uiFixNotice)){unlinkSync(uiFixNotice);bg(send('master','✅ 更新已应用：模型面板改为原地切换，实时工具步骤与模型返回的可展示推理摘要已恢复；现有会话和模型设置保留。旧按钮可能失效，重新打开一次 /panel 即可。'));}
 const dashboardNotice=`${root}/bots-dashboard-notice-on-start`;
 if(existsSync(dashboardNotice))bg((async()=>{
  await showView(endpoint('master'),'bots');
  unlinkSync(dashboardNotice);
  log.info({msg:'bots dashboard deployment panel delivered'});
 })());
 const usageNotice=`${root}/usage-ui-notice-on-start`;
 if(existsSync(usageNotice))bg((async()=>{
  await showView(endpoint('master'),'tokens');
  unlinkSync(usageNotice);
  log.info({msg:'usage UI deployment panel delivered'});
 })());
 const commandPanelNotice=`${root}/command-panel-notice-on-start`;
 if(existsSync(commandPanelNotice))bg((async()=>{
  await panel(endpoint('master'),null);
  unlinkSync(commandPanelNotice);
  log.info({msg:'command panel fix applied and new panel delivered'});
 })());
 const namesNotice=`${root}/bot-names-notice-on-start`;
 if(existsSync(namesNotice))bg((async()=>{
  await showView(endpoint('master'),'bots',null);
  unlinkSync(namesNotice);
  log.info({msg:'bot display names applied and dashboard delivered'});
 })());
 const catalogNotice=`${root}/model-catalog-notice-on-start`;
 if(existsSync(catalogNotice))bg((async()=>{
  await showView(endpoint('master'),'model',null);
  unlinkSync(catalogNotice);
  log.info({msg:'metadata model catalogue applied and panel delivered'});
 })());
}
main().catch(()=>{log.error({msg:'fleet startup failed; no credentials logged'});process.exit(1);});
