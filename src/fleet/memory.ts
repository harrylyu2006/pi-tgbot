/** Shared Markdown memory. Paths are deployment configuration, never operator-specific source literals. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface MemoryPaths { root:string; agentsFile:string; backups:string }
export function memoryPaths(agentDir:string, fleetRoot:string, override=process.env.PI_FLEET_MEMORY_ROOT):MemoryPaths {
 return {root:resolve(override??join(agentDir,'memory')),agentsFile:resolve(agentDir,'AGENTS.md'),backups:resolve(fleetRoot,'memory-history')};
}
/** Reject symlinks in *every* existing component, including parents of not-yet-created files. */
export function noSymlinks(path:string):void {
 let p=resolve(path);
 for(;;){
  try{if(lstatSync(p).isSymbolicLink())throw new Error('Symlinks not allowed');}
  catch(e:any){if(e.code!=='ENOENT')throw e;}
  const parent=dirname(p);if(parent===p)return;p=parent;
 }
}
export function isMemoryPath(path:string,paths:MemoryPaths):boolean {
 const p=resolve(path);
 return p===paths.agentsFile||(p.startsWith(paths.root+sep)&&p.endsWith('.md'));
}
function hash(text:string):string{return createHash('sha256').update(text).digest('hex');}
export function memory(args:{path:string;content?:string;revision?:string},paths:MemoryPaths):any {
 const p=resolve(paths.root,args.path);
 if(!isMemoryPath(p,paths))throw new Error('Not an allowed memory path');
 noSymlinks(p);
 let text='';try{text=readFileSync(p,'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;}
 // A revision must describe the complete text returned, not a silently truncated prefix.
 if(text.length>100000)throw new Error('Memory too large; split it into smaller Markdown files');
 if(args.content===undefined)return {path:p,revision:hash(text),content:text,truncated:false};
 if(args.revision!==hash(text))return {conflict:true,path:p,revision:hash(text),message:'Memory changed; reread and merge before updating'};
 if(args.content.length>100000)throw new Error('Memory too large');
 noSymlinks(paths.backups);mkdirSync(paths.backups,{recursive:true,mode:0o700});
 writeFileSync(join(paths.backups,`${Date.now()}-${randomUUID()}.json`),JSON.stringify({path:p,previous:text}),{mode:0o600,flag:'wx'});
 mkdirSync(dirname(p),{recursive:true,mode:0o700});
 const tmp=p+'.'+randomUUID()+'.tmp';writeFileSync(tmp,args.content,{mode:0o600,flag:'wx'});renameSync(tmp,p);
 return {path:p,revision:hash(args.content),saved:true};
}
