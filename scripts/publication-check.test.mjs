import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=mkdtempSync(join(tmpdir(),'pi-tg-publication-test-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
const scan=(...args)=>spawnSync(process.execPath,[join(root,'scripts/publication-check.mjs'),...args],{cwd:root,encoding:'utf8'});
const put=(name,text)=>{mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),text);};
try{
 git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
 mkdirSync(join(root,'scripts'));
 copyFileSync(fileURLToPath(new URL('./publication-check.mjs',import.meta.url)),join(root,'scripts/publication-check.mjs'));
 copyFileSync(fileURLToPath(new URL('../.gitignore',import.meta.url)),join(root,'.gitignore'));
 put('safe.txt','safe source\n');git('add','.gitignore','safe.txt','scripts/publication-check.mjs');git('commit','-qm','safe fixture');
 const fakeKey=['sk','T'.repeat(36)].join('-');
 put('config.json',JSON.stringify({key:fakeKey}));put('node_modules.old-test/private.txt',fakeKey);
 assert.equal(scan().status,0,'ignored runtime/dependency backups are not publication candidates');
 git('add','-f','config.json');let result=scan('--staged');assert.equal(result.status,1);assert(!result.stderr.includes(fakeKey));git('reset','-q','--','config.json');
 put('safe.txt',fakeKey);git('add','safe.txt');put('safe.txt','safe working copy\n');assert.equal(scan('--staged').status,1,'reads the staged blob');
 git('add','safe.txt');put('safe.txt',fakeKey);assert.equal(scan('--staged').status,0);assert.equal(scan().status,1);put('safe.txt','safe source\n');git('add','safe.txt');
 const privateNames=['passwords.kdbx','vault/vault.json','main.kdbx.prev','main.kdbx.meta.json','AGENTS.md','agents.md','nested/AGENTS.override.md','CLAUDE.md','SYSTEM.md','APPEND_SYSTEM.md','memory/persona.md','.pi/agent.md','fleet.sqlite','fleet.sqlite-wal','fleet.sqlite-shm','nested/managed-bots.json','control.json','status.json','rclone.conf'];
 for(const name of privateNames){
  put(name,'PRIVATE_FIXTURE_CONTENT');assert.equal(scan().status,0,`${name} ignored`);
  git('add','-f',name);result=scan('--staged');assert.equal(result.status,1,`${name} force-added must fail`);assert(!result.stderr.includes('PRIVATE_FIXTURE_CONTENT'));git('reset','-q','--',name);
 }
 for(const name of ['keepassxc-real','pykeepass-real']){
  const rel=`scripts/fixtures/${name}.kdbx`;mkdirSync(join(root,'scripts/fixtures'),{recursive:true});copyFileSync(fileURLToPath(new URL(`./fixtures/${name}.kdbx`,import.meta.url)),join(root,rel));git('add',rel);
 }
 assert.equal(scan('--staged').status,0,'only reviewed fixture hashes pass');
 put('scripts/fixtures/keepassxc-real.kdbx','a real database renamed as a fixture');git('add','scripts/fixtures/keepassxc-real.kdbx');assert.equal(scan('--staged').status,1,'known filename with changed bytes fails');git('reset','-q','--','scripts/fixtures');rmSync(join(root,'scripts/fixtures'),{recursive:true});
 symlinkSync('/private/operator/AGENTS.md',join(root,'linked.txt'));git('add','linked.txt');assert.equal(scan('--staged').status,1,'symlinks rejected without following private targets');git('reset','-q','--','linked.txt');rmSync(join(root,'linked.txt'));
 put('blob.bin',Buffer.from([0,1,2,3]));git('add','blob.bin');assert.equal(scan('--staged').status,1,'unreviewed binary rejected');git('reset','-q','--','blob.bin');rmSync(join(root,'blob.bin'));
 assert.equal(scan('--tree','HEAD').status,0);
 // Inspect the whole index, not just the changed files; and inspect ancestors when requested.
 put('leak.txt',fakeKey);git('add','leak.txt');git('commit','-qm','synthetic bad fixture');put('safe.txt','another change');git('add','safe.txt');assert.equal(scan('--staged').status,1,'unchanged tracked secrets still fail');
 git('rm','-q','leak.txt');git('commit','-qm','remove synthetic leak');assert.equal(scan('--tree','HEAD').status,0);result=scan('--history','HEAD');assert.equal(result.status,1,'deleted historical secrets are found');assert(!result.stderr.includes(fakeKey));
 assert.equal(scan('--tree','--all').status,2,'ref cannot inject Git options');
 console.log('PUBLICATION PASSED: private instructions/runtime blocked, exact fixture hashes, no symlink/binary escapes, full index/tree/history scans, redacted diagnostics.');
}finally{rmSync(root,{recursive:true,force:true});}
