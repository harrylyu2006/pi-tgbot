#!/usr/bin/env node
/** Offline, fail-closed release checks. Never prints matched secret values. */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const maxBytes=4*1024*1024;
const git=(args)=>execFileSync('git',args,{maxBuffer:64*1024*1024,stdio:['ignore','pipe','ignore']});
const argv=process.argv.slice(2);
const staged=argv[0]==='--staged',tree=argv[0]==='--tree',history=argv[0]==='--history';
if(argv.length&&!(staged&&argv.length===1)&&!((tree||history)&&argv.length===2&&!argv[1].startsWith('-'))){
 console.error('Usage: publication-check.mjs [--staged | --tree <commit> | --history <commit>]');process.exit(2);
}
const denyNames=[
 /(^|\/)config\.(?!example\.json$).*json$/i,
 /(^|\/)(?:auth|models|web-search|vault|managed-bots|state|status|control|adopt-managed|resume-master)\.json(?:\.|$)/i,
 /(^|\/)(?:agents(?:\.[^/]*)?|claude|system|append_system)\.md(?:\.|$)/i,
 /(^|\/)(?:\.pi|\.agents|\.pi-subagents|sessions?|inbox|outbox|memory|memory-history|vault|keepass)(?:\/|$)/i,
 /(^|\/)\.env(?:\.|$)/i,/(^|\/)credentials/i,/(^|\/)secrets?\./i,
 /(^|\/)rclone\.conf(?:\.|$)/i,/\.jsonl$/i,/\.deliveries\.json(?:\.tmp)?$/i,
 /\.(?:sqlite3?|db)(?:[-.]|$)/i,/\.(?:pem|key|p12|pfx|jks|keystore)$/i,
 /\.(?:bak|backup|old|orig)(?:\.|$)/i,/\.kdbx?(?:\.|$)/i,
];
const forbiddenExtensions=/\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|zip|tgz|gz|tar|7z)$/i;
// Exact, reviewed synthetic databases only. A real password database renamed as a fixture must fail.
const fixtureHashes=new Map([
 ['scripts/fixtures/keepassxc-real.kdbx','765501d14dd22c31dff6c92c3dd65cd9fce5fced97af64b19a75cd875ac80376'],
 ['scripts/fixtures/pykeepass-real.kdbx','6e804cb8cecaccff32dbf458fa486a558b26a6ca62a5540fbcb6de5d8bedbaa1'],
]);
// Historical source blobs containing literal control-character regexes, reviewed byte-for-byte.
// Only history scans may accept them; current source must use escaped characters.
const legacyTextHashes=new Set([
 'a1be2cce49640dcf61e7c773fd5b8fa4a96a58fe796699313439ecd7d31c7986',
 '6de66b00d8a542e760d6425cc4680a301bb66c986b6b25fbbf12f58575983aad',
 'a4f9207fe2cdd41a1a53592fa62e196906d1cc605781cfbf8e5b441ab6065525',
]);
const legacyApprovalHash='b22c8034b59e05b525d5767530507193b04cafaefc9f53d8aa96d995843e6153';
const patterns=[
 ['Telegram bot token',/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
 ['OpenAI-style API key',/\bsk-[A-Za-z0-9_-]{20,}\b/g],
 ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
 ['GitLab token',/\bglpat-[A-Za-z0-9_-]{20,}\b/g],
 ['Slack token',/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
 ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
 ['Google API key',/\bAIza[A-Za-z0-9_-]{30,}\b/g],
 ['private key block',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['credentialed URL',/\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@]+:[^\s@]+@/gi],
];
// These exact lines exist in older published redaction tests. Not a whole-file exemption.
const allowedFixtureLines=new Set([
 'must("bot token", "token 是 '+['1234567890','AAFAKEfaketokenfortestingonly1234567'].join(':')+'", true);',
 'must("中转 key", "用 '+['sk','FAKEKEYFORTESTINGONLY123456'].join('-')+' 连上去的", true);',
 'must("github token", "'+['ghp','abcdefghijklmnopqrstuvwxyz0123456789'].join('_')+'", true);',
 'must("私钥块", "-----BEGIN '+ 'OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----", true);',
 'must("数据库 URL", "'+['postgres://user','hunter2@db.example.com/x'].join(':')+'", true);',
]);
function walk(dir='.'){
 const out=[];
 for(const e of readdirSync(dir,{withFileTypes:true})){
  if(e.name==='.git'||/^node_modules/.test(e.name)||['dist','coverage'].includes(e.name))continue;
  const path=join(dir,e.name);if(e.isDirectory())out.push(...walk(path));else out.push(path);
 }
 return out;
}
let entries=[];
try{
 if(tree||history){
  const commit=git(['rev-parse','--verify',`${argv[1]}^{commit}`]).toString().trim();
  const commits=history?git(['rev-list',commit]).toString().trim().split('\n'):[commit];
  const seen=new Set();
  for(const ref of commits)for(const item of git(['ls-tree','-r','-z',ref]).toString().split('\0').filter(Boolean)){
   const tab=item.indexOf('\t');const [mode,type,oid]=item.slice(0,tab).split(' '),file=item.slice(tab+1);
   const key=`${file}:${oid}:${mode}`;if(seen.has(key))continue;seen.add(key);
   entries.push({file,mode,oid,ref});
  }
 }else{
  const indexed=git(['ls-files','--stage','-z']).toString().split('\0').filter(Boolean);
  if(staged)entries=indexed.map(item=>{const tab=item.indexOf('\t');const [mode,oid,stage]=item.slice(0,tab).split(' ');if(stage!=='0')throw new Error('Unmerged index');return {file:item.slice(tab+1),mode,oid};});
  else entries=[...new Set(git(['ls-files','-co','--exclude-standard','-z']).toString().split('\0').filter(Boolean))].map(file=>({file}));
 }
}catch(err){
 // An extracted source archive can be scanned too. Other errors must not silently shrink coverage.
 if(!argv.length&&err.status===128)entries=walk().map(file=>({file}));
 else{console.error('Cannot enumerate publication files; scan aborted.');process.exit(2);}
}
const findings=[];
for(const {file,mode,oid,ref} of entries){
 const where=`${ref?ref.slice(0,12)+':':''}${JSON.stringify(file)}`;
 const report=(rule)=>findings.push(`${where}: ${rule}`);
 if(mode&&mode!=='100644'&&mode!=='100755'){report('symlink, submodule or unsupported Git mode');continue;}
 let data;
 try{
  if(oid){if(Number(git(['cat-file','-s',oid]).toString())>maxBytes)throw new Error('Oversized');data=git(['cat-file','blob',oid]);}
  else{const s=lstatSync(file);if(!s.isFile()){report('symlink or unsupported file type');continue;}if(s.size>maxBytes)throw new Error('Oversized');data=readFileSync(file);}
 }catch(err){if(!oid&&err.code==='ENOENT')continue;report('unreadable or oversized content; manual review required');continue;}
 const digest=createHash('sha256').update(data).digest('hex');
 const fixture=fixtureHashes.get(file)===digest;
 if(denyNames.some(rule=>rule.test(file))&&!fixture)report('forbidden publication filename');
 if(forbiddenExtensions.test(file))report('binary assets require explicit privacy review and are forbidden by default');
 if(fixture)continue;
 if(data.includes(0)&&!(history&&legacyTextHashes.has(digest))){report('unreviewed binary content');continue;}
 const lines=data.toString('utf8').split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(file==='scripts/redact-check.ts'&&allowedFixtureLines.has(line.trim()))continue;
  // Old scanner versions embed the exact same redaction test literals; no other line is exempt.
  if(file==='scripts/publication-check.mjs'&&[...allowedFixtureLines].some(value=>line.trim()===`'${value.replaceAll('\\','\\\\')}',`))continue;
  for(const [name,pattern]of patterns){
   // One historical URL parser test used a deliberately fake user:pw pair.
   if(history&&digest===legacyApprovalHash&&i===25&&name==='credentialed URL')continue;
   pattern.lastIndex=0;if(pattern.test(line))report(`line ${i+1}: ${name}`);
  }
 }
}
if(findings.length){console.error('Publication check failed:\n'+findings.map(x=>'  - '+x).join('\n'));process.exit(1);}
console.log(`Publication check passed (${entries.length} ${history?'historical file versions':'files'} inspected).`);
