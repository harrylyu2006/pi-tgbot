import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, resolve } from 'node:path';
import { noSymlinks } from './memory.ts';
export async function history(dir:string,args:{session?:string;query?:string;limit?:number;before?:string},scrub:(t:string)=>string):Promise<any>{
 noSymlinks(dir);
 const files=readdirSync(dir).filter(n=>n.endsWith('.jsonl')).sort().reverse();
 for(const file of files)noSymlinks(resolve(dir,file));
 if(args.session==='list')return files.slice(0,100).map(n=>({session:n,bytes:statSync(resolve(dir,n)).size}));
 const name=args.session??files[0];if(!name)return {messages:[],note:'No saved sessions'};
 if(name!==basename(name)||!files.includes(name))throw new Error('Invalid session');
 const nodes=new Map<string,any>();let last:string|undefined;
 for await(const line of createInterface({input:createReadStream(resolve(dir,name)),crlfDelay:Infinity})){
  try{const e=JSON.parse(line);if(!e.id||e.type==='session')continue;last=e.id;
   const m=e.message;const content=typeof m?.content==='string'?m.content:Array.isArray(m?.content)?m.content.filter((b:any)=>b.type==='text'||b.type==='toolCall').map((b:any)=>b.type==='text'?b.text:`[tool ${b.name}] ${JSON.stringify(b.arguments)}`).join('\n'):'';
   nodes.set(e.id,{id:e.id,parent:e.parentId,at:e.timestamp,type:e.type,role:m?.role,tool:m?.toolName,text:content.slice(0,12000)});
  }catch{/* partial trailing line ignored */}
 }
 let cursor=last;const branch:any[]=[];const visited=new Set<string>();while(cursor&&!visited.has(cursor)){visited.add(cursor);const n=nodes.get(cursor);if(!n)break;branch.push(n);cursor=n.parent;}
 let rows=branch.filter(n=>n.text&&(!args.query||n.text.toLowerCase().includes(args.query.toLowerCase())));
 if(args.before){const idx=rows.findIndex(n=>n.id===args.before);if(idx<0)throw new Error('Unknown cursor');rows=rows.slice(idx+1);}
 const take=rows.slice(0,Math.max(1,Math.min(80,args.limit??20)));let size=0;const bounded=[];
 for(const row of take){const text=scrub(row.text);size+=text.length;if(size>50000)break;bounded.push({...row,text});}
 return {session:name,activeBranch:true,messages:bounded.reverse(),nextBefore:bounded.at(-1)?.id,partialLiveMessagesExcluded:true};
}
