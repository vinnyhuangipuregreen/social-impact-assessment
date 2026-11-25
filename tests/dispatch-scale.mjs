import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const directory=mkdtempSync(join(tmpdir(),'simp-scale-'));
process.env.SIMP_DEMO='1';
process.env.SIMP_DB=join(directory,'scale.db');
process.env.HOST='127.0.0.1';
process.env.PORT='0';
const {run,db,one,tx,createParticipant,bind}=await import(new URL('../src/store.ts',import.meta.url));
const salt='HTTP_TEST_SCALE_';
const count=5000;
const now=new Date().toISOString();
const statement=db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, ?, ?)');
tx(()=>{
  for(let n=0;n<count;n++) {
    const who=createParticipant();
    bind(who,'line','demo',salt+n,'合成測試');
    run("UPDATE profiles SET region='合成負載區',line_reachable=1 WHERE participant_id=?",who);
    for(const [purpose,code] of [['privacy','*'],['tracking','EARTH']]) {
      run('INSERT INTO consents(participant_id,purpose,scope,notice_version,choice,created_at,source) VALUES (?,?,?,?,?,?,?)',who,purpose,code,'demo-v1',1,now,'scale');
    }
    statement.run('earth-follow',who,'attended',now,now,now);
  }
});
let child,port,session;
const start=async()=>{
  child=spawn(process.execPath,['src/server.ts'],{env:process.env,stdio:['ignore','pipe','inherit']});
  port=await new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{const m=String(chunk).match(/127\.0\.0\.1:(\d+)/);if(m)resolve(m[1]);});
    child.on('exit',code=>reject(Error('Exited '+code)));
  });
};
const stop=async()=>{if(child?.exitCode===null){child.kill();await once(child,'exit');}};
const request=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:'+port+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(session?{Cookie:session}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  assert.ok(response.ok,JSON.stringify(payload));
  if(response.headers.getSetCookie().length) session=response.headers.getSetCookie()[0].split(';')[0];
  return payload;
};
try {
  await start();
  await request('/auth/admin/login',{account:'operator'});
  const before=performance.now();
  const preview=await request('/admin/dispatch-jobs/preview',{surveyId:'earth-follow-T2',audience:'nonmember',regions:['合成負載區'],statuses:['attended']});
  assert.equal(preview.count,count);
  const job=await request('/admin/dispatch-jobs',{previewId:preview.id});
  console.log('Preview and queue',count,Math.round(performance.now()-before)+'ms');
  const accepted=()=>one(`SELECT COUNT(*) AS n FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=? AND a.status='accepted'`,job.id).n;
  const waitUntil=async(check,timeout)=>{
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,200));}
    throw new Error('Timed out at '+accepted()+' accepted');
  };
  await waitUntil(()=>accepted()>=80,15000);
  await stop();
  const previous=accepted();
  assert.ok(previous>=80&&previous<count);
  await start();
  await waitUntil(()=>accepted()===count,100000);
  const state=await request('/admin/dispatch-jobs/'+job.id);
  const receipts=one('SELECT COUNT(*) AS n,MAX(tries) AS retry_max FROM demo_delivery_receipts');
  assert.equal(state.status,'completed');
  assert.equal(state.statistics.acceptance.numerator,count);
  assert.equal(state.statistics.acceptance.denominator,count);
  assert.deepEqual({...receipts},{n:count,retry_max:1});
  console.log('Restart resumed from',previous,'to',count,'accepted. One provider receipt per target.');
  const timers=await Promise.all(Array.from({length:100},async()=>{const t=performance.now();await request('/admin/events?limit=50');return performance.now()-t;}));
  console.log('100 parallel requests to GET /admin/events (6 seed events) p95',Math.round(timers.sort((a,b)=>a-b)[94])+'ms');
}finally{
  await stop();db.close();rmSync(directory,{recursive:true,force:true});
}
