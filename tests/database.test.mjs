import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl=new URL('../src/database.ts',import.meta.url).href;
async function execute(code,environment={}) {
  const child=spawn(process.execPath,['--input-type=module','-e',code],{
    env:{...process.env,TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:'',VERCEL:'',...environment},
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{output+=chunk;});
  const status=await new Promise(resolve=>child.on('exit',resolve));
  return {status,output};
}

test('an awaited transaction rolls back without absorbing another request',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'sia-transaction-'));
  try {
    const result=await execute(`
      import assert from 'node:assert/strict';
      const {exec,run,all,tx,closeDatabase}=await import(${JSON.stringify(moduleUrl)});
      await exec('CREATE TABLE values_test (id INTEGER PRIMARY KEY)');
      let entered;
      const started=new Promise(resolve=>{entered=resolve;});
      const failed=tx(async()=>{
        await run('INSERT INTO values_test VALUES (1)'); entered();
        await new Promise(resolve=>setTimeout(resolve,30));
        throw new Error('rollback');
      });
      await started;
      const independent=run('INSERT INTO values_test VALUES (2)');
      await assert.rejects(failed,/rollback/); await independent;
      assert.deepEqual((await all('SELECT id FROM values_test')).map(row=>row.id),[2]);
      closeDatabase();
    `,{SIMP_DB:join(folder,'test.sqlite')});
    assert.equal(result.status,0,result.output);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('deleted standard versions are not recreated on startup',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'sia-deleted-version-'));
  const storeUrl=new URL('../src/store.ts',import.meta.url).href;
  const environment={SIMP_DB:join(folder,'test.sqlite'),SIMP_DEMO:'1'};
  try {
    const removed=await execute(`
      const {run}=await import(${JSON.stringify(storeUrl)});
      await run("DELETE FROM event_surveys WHERE version_id='EARTH-T1A-1'");
      await run("DELETE FROM survey_versions WHERE id='EARTH-T1A-1'");
      await run("INSERT INTO app_settings VALUES ('deleted_survey_version:EARTH-T1A-1','test')");
      (await import(${JSON.stringify(moduleUrl)})).closeDatabase();
    `,environment);
    assert.equal(removed.status,0,removed.output);
    const restarted=await execute(`
      import assert from 'node:assert/strict';
      const {one}=await import(${JSON.stringify(storeUrl)});
      assert.equal(await one("SELECT id FROM survey_versions WHERE id='EARTH-T1A-1'"),undefined);
      (await import(${JSON.stringify(moduleUrl)})).closeDatabase();
    `,environment);
    assert.equal(restarted.status,0,restarted.output);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('cloud configuration cannot silently fall back to a local database',async()=>{
  for(const environment of [
    {VERCEL:'1'},
    {TURSO_DATABASE_URL:'libsql://test.turso.io'},
    {TURSO_AUTH_TOKEN:'test-only'}
  ]) {
    const result=await execute(`await import(${JSON.stringify(moduleUrl)});`,environment);
    assert.notEqual(result.status,0);
    assert.match(result.output,/TURSO_DATABASE_URL and TURSO_AUTH_TOKEN/);
  }
});

test('residence migration maps legacy city names without inventing districts or losing unmatched text',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'sia-residence-migration-'));
  const storeUrl=new URL('../src/store.ts',import.meta.url).href;
  const migrationUrl=new URL('../migrations/',import.meta.url).href;
  try {
    const result=await execute(`
      import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {readFileSync,readdirSync} from 'node:fs';
      const db=new DatabaseSync(process.env.SIMP_DB);
      db.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY)');
      const directory=new URL(${JSON.stringify(migrationUrl)});
      for(const file of readdirSync(directory).filter(name=>name.endsWith('.sql')&&name<'006').sort()) {
        db.exec(readFileSync(new URL(file,directory),'utf8'));
        db.prepare('INSERT INTO migrations VALUES (?)').run(file);
      }
      for(const [id,region] of [['legacy-city','台北市'],['legacy-text','原居住文字']]) {
        db.prepare('INSERT INTO participants(id,created_at) VALUES (?,?)').run(id,new Date().toISOString());
        db.prepare('INSERT INTO profiles(participant_id,region) VALUES (?,?)').run(id,region);
      }
      db.close();
      await import(${JSON.stringify(storeUrl)});
      const {one,all,closeDatabase}=await import(${JSON.stringify(moduleUrl)});
      const city=await one("SELECT * FROM profiles WHERE participant_id='legacy-city'");
      assert.equal(city.region,'臺北市');assert.equal(city.residence_city_id,'63000');assert.equal(city.residence_district_id,null);
      const text=await one("SELECT * FROM profiles WHERE participant_id='legacy-text'");
      assert.equal(text.region,'原居住文字');assert.equal(text.residence_city_id,null);
      assert.equal((await all('PRAGMA foreign_key_check')).length,0);
      closeDatabase();
    `,{SIMP_DB:join(folder,'test.sqlite'),SIMP_DEMO:'1'});
    assert.equal(result.status,0,result.output);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
