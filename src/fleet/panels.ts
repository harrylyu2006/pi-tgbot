/** Lightweight panel rendering/delivery: navigation edits one message, never creates a message per click. */
import { esc } from '../telegram/html.ts';
import { grid, keyboard, type Button } from '../telegram/keyboard.ts';
import type { TelegramApi } from '../telegram/api.ts';

export interface PanelBody { text:string; markup?:unknown; html?:boolean }
export interface ModelChoice { spec:string; levels:string[] }
export type CallbackEncoder=(action:string,arg?:string)=>string;
export function navigation(cb:CallbackEncoder,master=false):Button[]{return [
 {text:'📊 状态',data:cb('view','status')},{text:'🤖 模型',data:cb('view','model')},
 {text:'🧠 思考',data:cb('view','think')},{text:'📈 用量',data:cb('view','tokens')},{text:'🔧 工具',data:cb('view','tools')},
 ...(master?[{text:'🛰 机器人',data:cb('view','bots')}]:[]),
];}
export function navigationRows(cb:CallbackEncoder,master=false):Button[][] {
 return grid(navigation(cb,master),2);
}
export function modelPanel(models:ModelChoice[],current:string|undefined,requestedPage:number,cb:CallbackEncoder,master=false):PanelBody{
 const pages=Math.max(1,Math.ceil(models.length/8));const page=Math.max(0,Math.min(pages-1,Number.isFinite(requestedPage)?Math.floor(requestedPage):0));
 const buttons=models.slice(page*8,page*8+8).map(m=>({text:`${m.spec===current?'✅ ':''}${m.spec}`,data:cb('model',m.spec)}));
 const pager:Button[]=[];
 if(page>0)pager.push({text:'⬅️ 上一页',data:cb('mpage',String(page-1))});
 if(page<pages-1)pager.push({text:'下一页 ➡️',data:cb('mpage',String(page+1))});
 return {html:true,text:`<b>🤖 模型</b>\n\n当前：<code>${esc(current??'默认')}</code>\n\n可选 ${models.length} 个 · 第 ${page+1}/${pages} 页\n<i>选择后仅影响本 bot 的下一任务。</i>`,markup:keyboard([...grid(buttons,2),...(pager.length?[pager]:[]),...navigationRows(cb,master)])};
}
export function thinkingPanel(levels:string[],selected:string|undefined,cb:CallbackEncoder,master=false):PanelBody{
 return {html:true,text:`<b>🧠 思考强度</b>\n\n当前：<code>${esc(selected??'模型默认')}</code>\n\n<i>仅影响本 bot 的下一任务。</i>`,markup:keyboard([...grid(levels.map(level=>({text:`${level===selected?'✅ ':''}${level}`,data:cb('think',level)})),3),...navigationRows(cb,master)])};
}
export function textPanel(text:string,cb:CallbackEncoder,master=false):PanelBody{return {text,markup:keyboard(navigationRows(cb,master))};}

export interface UsageSnapshot {
 stats?: { tokens?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number;total?:number};
  cost?:number;userMessages?:number;assistantMessages?:number;toolCalls?:number;
  contextUsage?:{tokens?:number|null;contextWindow?:number;percent?:number|null} };
 context?:{tokens?:number|null;contextWindow?:number;percent?:number|null};
 sessionId?:string;at?:number;model?:string;thinking?:string;
}
function validCount(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=0;}
function count(value:unknown):string{return validCount(value)?Math.floor(value).toLocaleString('en-US'):'—';}
/** Pi normalizes input to uncached input; cacheWrite is intentionally not added to the existing hit-rate denominator. */
export function cacheHitRate(tokens:NonNullable<UsageSnapshot['stats']>['tokens']):number|null {
 if(!validCount(tokens?.input)||!validCount(tokens?.cacheRead))return null;
 const denominator=tokens.input+tokens.cacheRead;
 return denominator>0?tokens.cacheRead/denominator*100:null;
}
export function usagePanel(snapshot:UsageSnapshot|null|undefined,cb:CallbackEncoder,master=false,live=false):PanelBody {
 const stats=snapshot?.stats,t=stats?.tokens;
 const hit=cacheHitRate(t);const context=snapshot?.context??stats?.contextUsage;
 const lines=['<b>📈 Token 用量</b>',''];
 if(!stats)lines.push('本 bot 暂无会话统计。','发送任务后会在这里显示用量。');
 else {
  lines.push('<b>本会话累计</b>',`输入：<b>${count(t?.input)}</b>`,`输出：<b>${count(t?.output)}</b>`,
   `缓存读取：<b>${count(t?.cacheRead)}</b>`,`合计：<b>${count(t?.total)}</b>`,'',
   '<b>🎯 缓存命中</b>',`缓存命中率：<b>${hit===null?'暂无可计算数据':hit.toFixed(1)+'%'}</b>`,
   '<i>口径：缓存读取 ÷（输入 + 缓存读取）</i>');
  if(validCount(stats.cost)&&stats.cost>0)lines.push('',`费用：<b>$${stats.cost.toFixed(4)}</b>`);
  const percent=validCount(context?.tokens)&&validCount(context?.contextWindow)&&context.contextWindow>0
   ?context.tokens/context.contextWindow*100:null;
  lines.push('','<b>📚 当前上下文</b>',`${count(context?.tokens)} / ${count(context?.contextWindow)} tokens`,
   `占用：${percent===null?'—':percent.toFixed(2)+'%'}`,'','<b>会话活动</b>',
   `用户消息：${count(stats.userMessages)} · 助手回复：${count(stats.assistantMessages)}`,
   `工具调用：${count(stats.toolCalls)}`);
 }
 if(snapshot?.sessionId)lines.push('',`会话：<code>${esc(snapshot.sessionId.slice(0,8))}</code>`);
 if(validCount(snapshot?.at)&&Number.isFinite(new Date(snapshot.at).getTime())){
  const at=new Date(snapshot.at).toISOString().replace('T',' ').slice(0,19)+' UTC';
  lines.push(`<i>${live?'实时快照':'统计快照'}：${at}</i>`);
 }
 lines.push('',`<i>${live?'本轮进行中；仅统计模型已返回的用量。':'累计用量不等于当前上下文长度。'}</i>`);
 return {html:true,text:lines.join('\n'),markup:keyboard([
  [{text:'🔄 刷新',data:cb('view','tokens')},{text:'⬅️ 返回面板',data:cb('view','status')}],
  ...navigationRows(cb,master),
 ])};
}

export function statusPanel(bot:FleetBotView,snapshot:UsageSnapshot|null|undefined,active:number,limit:number,cb:CallbackEncoder,totalBots:number):PanelBody {
 const master=bot.master??bot.id==='master';const url=botLink(bot.username);
 const label=esc(botDisplayName(bot));
 const name=url?`<a href="${url}">${label}</a>`:label;
 const lines=[`<b>${master?'👑 总控':'🤖 子助手'} · ${name}</b>`,'',
  `${botState(bot)}${bot.queued>0?` · 待办 ${natural(bot.queued)} 个`:''}`,`全局执行：${natural(active)}/${natural(limit)}`,'',
  '<b>模型与思考</b>',`模型：<code>${esc(brief(bot.model??snapshot?.model??'尚未设置',100))}</code>`,
  `思考：<code>${esc(brief(bot.thinking??(snapshot?.model===bot.model?snapshot?.thinking:undefined)??'模型默认',24))}</code>`];
 const context=snapshot?.context??snapshot?.stats?.contextUsage;
 if(snapshot?.stats){
  lines.push('','<b>会话概览</b>',`累计 Token：${count(snapshot.stats.tokens?.total)}`,`上下文：${count(context?.tokens)} / ${count(context?.contextWindow)}`);
  const hit=cacheHitRate(snapshot.stats.tokens);lines.push(`缓存命中率：${hit===null?'暂无可计算数据':hit.toFixed(1)+'%'}`);
 }
 lines.push('','<b>职责</b>',esc(brief(bot.role||'暂未设置',180)),'',
  `<i>${master?'总控可查看机器人总览并执行全局重启。':'/stop 暂停 · /start 恢复；休眠不驻留 Agent。'}</i>`);
 return {html:true,text:lines.join('\n'),markup:keyboard([
  [{text:'🤖 模型',data:cb('view','model')},{text:'🧠 思考',data:cb('view','think')}],
  [{text:'📈 用量',data:cb('view','tokens')},{text:'🔧 工具',data:cb('view','tools')}],
  [{text:'📊 刷新状态',data:cb('view','status')},{text:'🆕 新会话',data:cb('view','confirm_new')}],
  [{text:'⏹ 停止',data:cb('stop')},{text:'▶️ 启用',data:cb('enable')}],
  ...(master?[[{text:`🛰 机器人总览 · ${totalBots} 个`,data:cb('view','bots')}],[{text:'♻️ 全局重启',data:cb('restart-confirm')}]]:[]),
 ])};
}
export function toolsPanel(names:string[]|undefined,cb:CallbackEncoder,master=false):PanelBody {
 const groups=[['文件与执行',/^(read|write|edit|bash|grep|find|ls|secret_run)$/],['搜索与媒体',/^(brave_|muse_)/],['邮件',/^email_/],['凭据与密码库',/^(secret_|keepass_)/],['机器人与协作',/^(telegram_|fleet_)/],['其他工具',/.*/]] as const;
 const remaining=new Set(names??[]);const lines=['<b>🔧 可用工具</b>','',names?`共 ${names.length} 个 · 与其他 bot 共享工具配置`:'首次任务时按共享配置加载。'];
 for(const [label,pattern]of groups){const matches=[...remaining].filter(n=>pattern.test(n));if(!matches.length)continue;lines.push('',`<b>${label}</b>`);for(const n of matches){remaining.delete(n);lines.push(`• ${esc(brief(n,70))}`);}}
 return {html:true,text:lines.join('\n'),markup:keyboard(navigationRows(cb,master))};
}

export interface FleetBotView {
 id:string; username:string; name?:string; role:string; master?:boolean; enabled:boolean;
 state:string; model?:string; thinking?:string; queued:number;
}
export interface FleetView { limit:number; active:number; bots:FleetBotView[] }
const BOT_PAGE_SIZE=4;
function brief(value:string,max:number):string {
 const chars=Array.from(value.replace(/\s+/g,' ').trim());
 return chars.length>max?chars.slice(0,max-1).join('')+'…':chars.join('');
}
function natural(n:number):number {return Number.isFinite(n)?Math.max(0,Math.floor(n)):0;}
/** Human-facing label; Telegram usernames remain routing targets, never the primary title. */
export function botDisplayName(bot:Pick<FleetBotView,'id'|'master'|'name'>):string {
 const name=bot.name?.trim();
 return name?brief(name,64):(bot.master??bot.id==='master')?'总控':'子助手';
}
/** Only registered Telegram usernames can become outbound links; never interpolate arbitrary URLs. */
export function botLink(username:string):string|undefined {
 return /^[a-zA-Z0-9_]{5,32}$/.test(username)?`https://t.me/${username}`:undefined;
}
export function botState(bot:FleetBotView):string {
 if(bot.state==='running')return bot.enabled?'🟢 工作中':'⏹ 停止中';
 if(!bot.enabled||bot.state==='paused')return '⏸ 已暂停';
 if(bot.state==='queued')return '🟡 排队中';
 if(bot.state==='sleeping')return '💤 休眠';
 return '⚪ 状态待确认';
}
/** Display-only fleet snapshot: does not start a model or change any bot's state. */
export function botsPanel(fleet:FleetView,requestedPage:number,cb:CallbackEncoder):PanelBody {
 const bots=[...fleet.bots].sort((a,b)=>Number(b.master??b.id==='master')-Number(a.master??a.id==='master'));
 const pages=Math.max(1,Math.ceil(bots.length/BOT_PAGE_SIZE));
 const page=Math.max(0,Math.min(pages-1,Number.isFinite(requestedPage)?Math.floor(requestedPage):0));
 const visible=bots.slice(page*BOT_PAGE_SIZE,(page+1)*BOT_PAGE_SIZE);
 const active=natural(fleet.active),limit=natural(fleet.limit),slots=Math.min(limit,12);
 const bar='🟩'.repeat(Math.min(active,slots))+'⬜'.repeat(Math.max(0,slots-active));
 const queued=bots.reduce((sum,b)=>sum+natural(b.queued),0);
 const sleeping=bots.filter(b=>b.enabled&&b.state==='sleeping').length;
 const paused=bots.filter(b=>!b.enabled||b.state==='paused').length;
 const lines=[
  '<b>🛰 机器人总览</b>',
  `${bar}  全局执行 <b>${active} / ${limit}</b>`,
  `共 ${bots.length} 个 · 💤 休眠 ${sleeping} · ⏸ 暂停 ${paused} · 🟡 待办 ${queued}`,
 ];
 const rows:Array<Array<{text:string;url?:string;callback_data?:string}>>=[];
 for(const bot of visible){
  const master=bot.master??bot.id==='master';const url=botLink(bot.username);
  const label=esc(botDisplayName(bot));
  lines.push('',`${master?'👑 总控':'🤖 子助手'} · ${url?`<a href="${url}">${label}</a>`:label}`,
   `${botState(bot)}${bot.queued>0?` · 等待 ${natural(bot.queued)} 个任务`:''}`,
   `模型：<code>${esc(brief(bot.model??'模型默认',90))}</code>`,
   `思考：${esc(brief(bot.thinking??'模型默认',24))}`,
   `分工：${esc(brief(bot.role||'暂未设置',96))}`);
  if(url)rows.push([{text:`${master?'👑':'💬'} 打开 ${botDisplayName(bot)}`,url}]);
 }
 if(!bots.length)lines.push('','尚未登记机器人。');
 lines.push('','<i>休眠不驻留 Agent；点击下方按钮打开对应聊天。</i>');
 if(pages>1){
  lines.push(`第 ${page+1} / ${pages} 页`);
  rows.push([
   ...(page>0?[{text:'⬅️ 上一页',callback_data:cb('view',`bots:${page-1}`)}]:[]),
   ...(page<pages-1?[{text:'下一页 ➡️',callback_data:cb('view',`bots:${page+1}`)}]:[]),
  ]);
 }
 rows.push([{text:'🔄 刷新',callback_data:cb('view',`bots:${page}`)},{text:'⬅️ 返回面板',callback_data:cb('view','status')}]);
 return {html:true,text:lines.join('\n'),markup:{inline_keyboard:rows}};
}

export class PanelMessage {
 messageId:number|undefined;
 private tail:Promise<unknown>=Promise.resolve();
 private revisionValue=0;
 private readonly api:Pick<TelegramApi,'sendMessage'|'editMessageText'>;
 private readonly chatId:number;
 private readonly scrub:(text:string)=>string;
 constructor(api:Pick<TelegramApi,'sendMessage'|'editMessageText'>,chatId:number,scrub:(text:string)=>string){this.api=api;this.chatId=chatId;this.scrub=scrub;}
 begin():number{return ++this.revisionValue;}
 isCurrent(revision:number):boolean{return revision===this.revisionValue;}
 /** null = explicit slash-command request: send a fresh panel; number = clicked message; undefined = reuse latest. */
 update(body:PanelBody,targetId?:number|null,revision=this.begin()):Promise<void>{
  const work=this.tail.catch(()=>undefined).then(async()=>{
   if(!this.isCurrent(revision))return;
   const id=targetId===null?undefined:targetId??this.messageId;
   // All edits use HTML. Plain body is escaped, so switching from HTML cannot leave parse-mode ambiguity.
   const params={chat_id:this.chatId,text:body.html?this.scrub(body.text):esc(this.scrub(body.text)),parse_mode:'HTML' as const,
    link_preview_options:{is_disabled:true},reply_markup:body.markup??{inline_keyboard:[]}};
   if(id!==undefined){
    try{await this.api.editMessageText({...params,message_id:id});this.messageId=id;return;}
    catch(err){
     const message=err instanceof Error?err.message:String(err);
     if(/message is not modified/i.test(message)){this.messageId=id;return;}
     // Only a definitive deleted/non-editable message permits replacement. Timeout/429 must not spam a new panel.
     if(!/message to edit not found|message can't be edited|message cannot be edited/i.test(message))throw err;
     if(!this.isCurrent(revision))return;
    }
   }
   const sent=await this.api.sendMessage(params);this.messageId=sent.message_id;
  });
  this.tail=work;return work;
 }
}
