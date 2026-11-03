import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {workerGroup} from '../src/fleet/cgroup.ts';
import assert from 'node:assert/strict';
const child=spawn('/bin/sleep',['60'],{stdio:'ignore'});const group=workerGroup('probe-'+Date.now(),child.pid!);
assert.ok(readFileSync(group.path+'/cgroup.procs','utf8').includes(String(child.pid)));
group.kill();await new Promise<void>(r=>child.once('exit',()=>r()));group.remove();assert.ok(!existsSync(group.path));
console.log('CGROUP CHECK PASSED: worker placement, kernel tree termination, resource cleanup.');
