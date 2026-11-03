/** Shared metadata-only model catalogue. Never creates an Agent/session or loads extensions. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { availableLevelsFor, enrichThinkingLevels, type ModelLike } from '../agent/reasoning.ts';
import type { ModelChoice } from './panels.ts';

export interface CatalogResult { models:ModelChoice[]; stale:boolean; error?:string }
export interface CatalogOptions {
 agentDir:string;
 timeoutMs?:number;
 ttlMs?:number;
 fingerprint?:()=>Promise<string>;
 load?:(signal:AbortSignal)=>Promise<ModelChoice[]>;
}
const ERROR='暂时无法读取模型目录，请稍后重新打开；未启动 Agent，也未更改模型。';
const STALE='本次读取超时或失败，显示上次可用的模型目录。';

export class ModelCatalog {
 private readonly opts:CatalogOptions;
 private cached:ModelChoice[]|undefined;
 private key:string|undefined;
 private at=0;
 private flight:Promise<CatalogResult>|undefined;
 constructor(opts:CatalogOptions){this.opts=opts;}
 private async fingerprint():Promise<string>{
  if(this.opts.fingerprint)return this.opts.fingerprint();
  // models-store.json is SDK-generated and may be created during the first load;
  // user-editable config/auth invalidate immediately, remote catalog cache follows the TTL.
  const files=['models.json','auth.json'];
  return (await Promise.all(files.map(async name=>{
   try{const s=await stat(join(this.opts.agentDir,name));return `${name}:${s.ino}:${s.size}:${s.mtimeMs}`;}
   catch(e:any){if(e.code==='ENOENT')return `${name}:missing`;throw e;}
  }))).join('|');
 }
 private async load(signal:AbortSignal):Promise<ModelChoice[]>{
  if(this.opts.load)return this.opts.load(signal);
  const {ModelRuntime}=await import('@earendil-works/pi-coding-agent');
  signal.throwIfAborted();
  const runtime=await ModelRuntime.create({
   authPath:join(this.opts.agentDir,'auth.json'),modelsPath:join(this.opts.agentDir,'models.json'),
   allowModelNetwork:false,signal,
  });
  signal.throwIfAborted();
  if(runtime.getError())throw new Error('Model catalogue configuration is not ready');
  // Do not fetch remote catalogs or execute a model request just to show the menu.
  return runtime.getAvailableSnapshot()
   .filter(m=>m.provider!=='openrouter'&&runtime.hasConfiguredAuth(m.provider))
   .map(m=>({spec:`${m.provider}/${m.id}`,levels:availableLevelsFor(enrichThinkingLevels(m as unknown as ModelLike))}));
 }
 private fallback():CatalogResult{
  return {models:this.cached??[],stale:!!this.cached,error:this.cached?STALE:ERROR};
 }
 async get():Promise<CatalogResult>{
  let key:string;
  try{key=await this.fingerprint();}catch{return this.fallback();}
  if(this.cached&&this.key===key&&Date.now()-this.at<(this.opts.ttlMs??300000))return {models:this.cached,stale:false};
  if(this.flight)return this.flight;
  const controller=new AbortController();let timer:NodeJS.Timeout|undefined;
  const timeout=new Promise<CatalogResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(this.fallback());},this.opts.timeoutMs??3000);});
  const work=(async():Promise<CatalogResult>=>{
   try{
    const models=await this.load(controller.signal);
    controller.signal.throwIfAborted();
    // Ignore results for files replaced while loading; a later get() will retry the new revision.
    if(await this.fingerprint()!==key)return this.fallback();
    this.cached=models;this.key=key;this.at=Date.now();
    return {models,stale:false};
   }catch{return this.fallback();}
   finally{if(timer)clearTimeout(timer);}
  })();
  const flight=Promise.race([work,timeout]);this.flight=flight;
  // Keep single-flight ownership until the underlying operation has actually stopped, even after a caller timeout.
  void work.finally(()=>{if(this.flight===flight)this.flight=undefined;});
  return flight;
 }
}
