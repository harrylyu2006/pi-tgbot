import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelCatalog } from '../src/fleet/catalog.ts';
const root=mkdtempSync(join(tmpdir(),'fleet-catalog-'));
try{
 let revision='1',loads=0;
 const choices=[{spec:'fixture/first',levels:['off','high']}];
 const catalog=new ModelCatalog({agentDir:root,fingerprint:async()=>revision,load:async()=>{loads++;await new Promise(r=>setTimeout(r,20));return choices;}});
 const all=await Promise.all(Array.from({length:6},()=>catalog.get()));assert.equal(loads,1);assert.ok(all.every(r=>r.models[0]?.spec==='fixture/first'));
 await catalog.get();assert.equal(loads,1,'cached metadata avoids reload');revision='2';await catalog.get();assert.equal(loads,2,'file revision invalidates shared cache');
 let hang=false;
 const slow=new ModelCatalog({agentDir:root,timeoutMs:30,ttlMs:0,fingerprint:async()=>revision,load:async(signal)=>{if(!hang)return choices;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return [];}});
 await slow.get();hang=true;const t=performance.now();const stale=await slow.get();assert.ok(performance.now()-t<250);assert.equal(stale.stale,true);assert.deepEqual(stale.models,choices);assert.ok(stale.error);
 const cold=new ModelCatalog({agentDir:root,timeoutMs:20,load:async(signal)=>{await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return [];}});
 const failed=await cold.get();assert.equal(failed.models.length,0);assert.ok(failed.error);assert.equal(failed.stale,false);
 // Real SDK metadata path: block every network request and verify only whitelisted metadata escapes.
 const agent=join(root,'agent');mkdirSync(agent);let networkCalls=0;
 const original=globalThis.fetch;globalThis.fetch=(async()=>{networkCalls++;throw new Error('Network forbidden in catalogue test');}) as typeof fetch;
 const configuration={providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',apiKey:'fake-fixture-secret',api:'openai-completions',models:[{id:'first',reasoning:true,input:['text'],thinkingLevelMap:{xhigh:'xhigh'}}]}}};
 writeFileSync(join(agent,'models.json'),JSON.stringify(configuration));writeFileSync(join(agent,'auth.json'),'{}');
 try{
  const real=new ModelCatalog({agentDir:agent,timeoutMs:8000});const begin=performance.now();const result=await real.get();
  assert.ok(!result.error,result.error);assert.ok(result.models.some(m=>m.spec==='fixture/first'&&m.levels.includes('xhigh')));
  assert.ok(result.models.every(m=>Object.keys(m).sort().join(',')==='levels,spec'));
  assert.ok(!JSON.stringify(result).includes('fake-fixture-secret'));assert.equal(networkCalls,0);
  configuration.providers.fixture.models.push({id:'second-longer',reasoning:true,input:['text'],thinkingLevelMap:{xhigh:'xhigh'}});
  writeFileSync(join(agent,'models.json'),JSON.stringify(configuration));const updated=await real.get();assert.ok(updated.models.some(m=>m.spec==='fixture/second-longer'));
  const cachedAt=performance.now();await real.get();const cachedMs=performance.now()-cachedAt;
  console.log(JSON.stringify({realCatalogMs:Math.round(performance.now()-begin),cachedMs:Math.round(cachedMs),networkCalls}));
 }finally{globalThis.fetch=original;}
 console.log('CATALOG PASSED: shared single-flight metadata cache, bounded timeout/stale fallback, configuration invalidation, no network/model/session/extensions, no credential output.');
}finally{rmSync(root,{recursive:true,force:true});}
