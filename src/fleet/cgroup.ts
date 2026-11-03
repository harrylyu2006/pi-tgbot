/** Dedicated cgroup per worker: detached shell children cannot outlive a completed job. */
import { readFileSync, mkdirSync, writeFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
export function workerGroup(id:string,pid:number):{kill:()=>void;remove:()=>void;path:string}{
 if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Bad job id');
 const entry=readFileSync('/proc/self/cgroup','utf8').split('\n').find(l=>l.startsWith('0::'));
 if(!entry)throw new Error('Fleet requires cgroup v2');
 const base=join('/sys/fs/cgroup',entry.slice(3),'fleet-workers');
 const path=join(base,id);mkdirSync(path,{recursive:true});
 writeFileSync(join(path,'cgroup.procs'),String(pid));
 return {path,kill:()=>{try{writeFileSync(join(path,'cgroup.kill'),'1');}catch{}},remove:()=>{try{rmdirSync(path);}catch{}}};
}
