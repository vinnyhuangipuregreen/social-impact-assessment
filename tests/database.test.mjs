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
