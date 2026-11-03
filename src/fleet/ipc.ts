/** Private parent/child IPC. Never expose this channel as a model tool. */
import { randomUUID } from 'node:crypto';
export class Rpc {
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 private running=new Map<string,AbortController>();
 private closed=false;
 private send:(value:any)=>void;
 private handler:(op:string,args:any,signal:AbortSignal)=>Promise<any>;
 constructor(send:(value:any)=>void,handler:(op:string,args:any,signal:AbortSignal)=>Promise<any>){this.send=send;this.handler=handler;}
 async receive(m:any):Promise<void>{
  if(this.closed)return;
  if(m?.rpc==='cancel'){this.running.get(m.id)?.abort();return;}
  if(m?.rpc==='reply'){
   const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);
   m.ok?p.resolve(m.value):p.reject(new Error(m.error??'Remote operation failed'));return;
  }
  if(m?.rpc!=='call'||typeof m.id!=='string'||this.running.has(m.id))return;
  const controller=new AbortController();this.running.set(m.id,controller);
  let response;
  try{response={rpc:'reply',id:m.id,ok:true,value:await this.handler(m.op,m.args,controller.signal)};}
  catch{response={rpc:'reply',id:m.id,ok:false,error:'Remote operation failed; sensitive details suppressed'};}
  finally{this.running.delete(m.id);}
  if(!this.closed){try{this.send(response);}catch{/* peer disconnected; never leak handler errors */}}
 }
 call(op:string,args:any,signal?:AbortSignal,timeoutMs=1000000):Promise<any>{
  if(this.closed)return Promise.reject(new Error('IPC closed'));
  if(signal?.aborted)return Promise.reject(new Error('Aborted'));
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
   const cancel=()=>{
    const p=this.pending.get(id);if(!p)return;clearTimeout(p.timer);this.pending.delete(id);
    signal?.removeEventListener('abort',cancel);
    try{this.send({rpc:'cancel',id});}catch{/* a dead transport must still settle the caller */}
    reject(new Error('Aborted'));
   };
   const timer=setTimeout(cancel,timeoutMs);
   const finish=(fn:(v:any)=>void)=>(v:any)=>{signal?.removeEventListener('abort',cancel);fn(v);};
   this.pending.set(id,{resolve:finish(resolve),reject:finish(reject),timer});
   signal?.addEventListener('abort',cancel,{once:true});
   try{this.send({rpc:'call',id,op,args});}catch{cancel();}
  });
 }
 close():void{this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('IPC closed'));}this.pending.clear();for(const c of this.running.values())c.abort();this.running.clear();}
}
