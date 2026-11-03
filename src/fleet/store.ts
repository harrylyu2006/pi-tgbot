import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface BotRecord {
 id: string; telegramId: number; username: string; name?: string; role: string; master: boolean; enabled: boolean;
 secretName?: string; sessionDir: string; statePath: string; model?: string; thinking?: string; fresh?: boolean;
}
export interface Job { id: string; bot: string; kind: string; payload: any; status: string; created: number }
export class FleetStore {
 readonly db: DatabaseSync;
 constructor(path: string) {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  this.db=new DatabaseSync(path); chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS seen(bot TEXT NOT NULL, update_id INTEGER NOT NULL, PRIMARY KEY(bot,update_id));
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,bot TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created);
   CREATE TABLE IF NOT EXISTS snapshots(bot TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox(bot TEXT,update_id INTEGER,data TEXT,created INTEGER,PRIMARY KEY(bot,update_id));
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,bot TEXT,job TEXT,kind TEXT,detail TEXT,at INTEGER);
  `);
 }
 bots(): BotRecord[] { return (this.db.prepare('SELECT data FROM bots ORDER BY rowid').all() as any[]).map(r=>JSON.parse(r.data)); }
 bot(id:string): BotRecord | undefined { const r=this.db.prepare('SELECT data FROM bots WHERE id=?').get(id) as any; return r?JSON.parse(r.data):undefined; }
 saveBot(bot:BotRecord): void { this.db.prepare('INSERT INTO bots VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(bot.id,JSON.stringify(bot)); }
 seen(bot:string,id:number):boolean { return !!this.db.prepare('SELECT 1 FROM seen WHERE bot=? AND update_id=?').get(bot,id); }
 markSeen(bot:string,id:number):void { this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(bot,id); }
 acceptUpdate(bot:string,update:any):void {this.db.prepare('INSERT OR IGNORE INTO inbox VALUES(?,?,?,?)').run(bot,update.update_id,JSON.stringify(update),Date.now());}
 pendingUpdates():Array<{bot:string;update:any}>{return (this.db.prepare('SELECT bot,data FROM inbox ORDER BY created,rowid').all() as any[]).map(r=>({bot:r.bot,update:JSON.parse(r.data)}));}
 completeUpdate(bot:string,id:number):void{this.db.prepare('DELETE FROM inbox WHERE bot=? AND update_id=?').run(bot,id);}
 enqueue(bot:string,kind:string,payload:any):Job {
  const j={id:randomUUID(),bot,kind,payload,status:'queued',created:Date.now()};
  this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(j.id,bot,kind,JSON.stringify(payload),j.status,j.created,j.created); return j;
 }
 incoming(bot:string,updateId:number,kind:string,payload:any): Job | null {
  this.db.exec('BEGIN IMMEDIATE');
  try { if(this.seen(bot,updateId)){this.db.exec('COMMIT');return null;}
   const j=this.enqueue(bot,kind,payload);this.markSeen(bot,updateId);this.db.exec('COMMIT');return j;
  } catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 jobs(status?:string):Job[] {
  const rows=status?this.db.prepare('SELECT * FROM jobs WHERE status=? ORDER BY created,rowid').all(status):this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 200').all();
  return (rows as any[]).map(r=>({...r,payload:JSON.parse(r.payload)}));
 }
 setStatus(id:string,status:string):void { this.db.prepare('UPDATE jobs SET status=?,updated=? WHERE id=?').run(status,Date.now(),id); }
 snapshot(bot:string,data:any):void { this.db.prepare('INSERT INTO snapshots VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET data=excluded.data').run(bot,JSON.stringify(data)); }
 getSnapshot(bot:string):any { const r=this.db.prepare('SELECT data FROM snapshots WHERE bot=?').get(bot) as any;return r?JSON.parse(r.data):null; }
 event(bot:string,job:string,kind:string,detail:string):void {this.db.prepare('INSERT INTO events(bot,job,kind,detail,at) VALUES(?,?,?,?,?)').run(bot,job,kind,detail.slice(0,1000),Date.now());}
 recover(): Job[] {const jobs=(this.db.prepare("SELECT * FROM jobs WHERE status IN ('running','starting','steering')").all() as any[]).map(r=>({...r,payload:JSON.parse(r.payload)}));for(const j of jobs)this.setStatus(j.id,'interrupted');return jobs;}
 close():void {this.db.close();}
}

/** Global worker budget. A bot can never have two writers of its session. */
export class Admission {
 readonly active=new Set<string>();
 private last='';
 readonly limit:number;
 constructor(limit=3) {this.limit=limit;}
 next(jobs:Job[],enabled:(id:string)=>boolean):Job|undefined {
  if(this.active.size>=this.limit)return;
  const candidates=jobs.filter(j=>!this.active.has(j.bot)&&enabled(j.bot));
  const first=candidates.find(j=>j.bot!==this.last)??candidates[0];
  if(first){this.active.add(first.bot);this.last=first.bot;}return first;
 }
 release(bot:string):void{this.active.delete(bot);}
}
