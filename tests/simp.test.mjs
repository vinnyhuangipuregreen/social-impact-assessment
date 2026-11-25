import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

let child,origin,folder,db;
const participant={};
const staff={};
const sample={};
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const privacy={purpose:'privacy',scope:'*',choice:true,noticeVersion:'demo-v1'};
const tracking=(scope,choice=true)=>({purpose:'tracking',scope,choice,noticeVersion:'demo-v1'});
async function call(path,{body,method,jar,expect=200}={}) {
  const raw=body instanceof Blob;
  const response=await fetch(origin+'/api/v1'+path,{method:method??(body===undefined?'GET':'POST'),
    headers:{...(Object.keys(jar??{}).length?{Cookie:Object.entries(jar).map(([name,value])=>name+'='+value).join('; ')}:{}),
      ...(body===undefined?{}:{'Content-Type':raw?body.type:'application/json'})},body:raw?body:body===undefined?undefined:JSON.stringify(body)});
  if (jar) for(const cookie of response.headers.getSetCookie()) {
    const [name,value]=cookie.split(';')[0].split('=');
    if (value) jar[name]=value; else delete jar[name];
  }
  const result=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();
  assert.equal(response.status,expect,JSON.stringify(result));
  return result;
}
async function otp(phone,jar,purpose='login') {
  const ticket=await call('/auth/otp/request',{jar,body:{phone,purpose}});
  return call('/auth/otp/verify',{jar,body:{challengeId:ticket.challengeId,code:ticket.demoCode}});
}
async function login(account,jar={}) {
  await call('/auth/admin/login',{jar,body:{account}});
  return jar;
}
async function line(subject,jar) {
  const {state}=await call('/auth/line/start',{jar});
  return call('/auth/line/callback',{jar,body:{state,subject}});
}
async function allow(jar,programs=['VGR','EARTH','VEG']) {
  await call('/me/consents',{jar,body:privacy});
  for(const p of programs) await call('/me/consents',{jar,body:tracking(p)});
}
before(async()=>{
  folder=mkdtempSync(join(tmpdir(),'simp-uat-'));
  const database=join(folder,'test.db');
  child=spawn(process.execPath,['src/server.ts'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',SIMP_DEMO:'1',SIMP_DB:database},stdio:['ignore','pipe','pipe']});
  const port=await new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{const m=String(chunk).match(/127\.0\.0\.1:(\d+)/);if(m)resolve(m[1]);});
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.on('exit',code=>reject(Error('Server exited '+code)));
  });
  origin='http://127.0.0.1:'+port;
  db=new DatabaseSync(database);
  await login('operator',staff);
  sample.me=await otp('0900000001',sample);
});
after(async()=>{
  db?.close();
  if(child&&child.exitCode===null) {child.kill();await once(child,'exit');}
  if(folder) rmSync(folder,{recursive:true,force:true});
});

test('UAT-10 and UAT-11: rates, valid zero, and independent program units',async()=>{
  const data=await call('/admin/reports/outcomes?eventId=vegrun-follow',{jar:staff});
  assert.deepEqual(data.recovery,{numerator:4,denominator:10,percent:40});
  assert.deepEqual(data.paired,{numerator:3,denominator:8,percent:37.5});
  assert.equal(data.outcomes[0].unit,'餐');
  assert.equal(data.outcomes[0].mean,null);
  assert.equal(data.lost,5);
});

test('UAT-01 and UAT-03: a stable identity across LINE and three programs, with validated org hierarchy',async()=>{
  const first=await otp('0912000101',participant);
  assert.equal((await line('new-uat-person',participant)).status,'linked');
  await allow(participant);
  for (const event of ['vegrun','earth','veg']) {
    const en=await call('/events/'+event+'/enrollments',{jar:participant,body:{}});
    assert.equal(en.participant_id,first.participant_id);
  }
  const invalid=await call('/me/profile',{jar:participant,method:'PATCH',body:{member:true,districtId:'north3',chapterId:'prajna',card:'UAT1234'},expect:422});
  assert.equal(invalid.error.code,'CHAPTER_INVALID');
  await call('/auth/logout',{jar:participant,body:{}});
  assert.equal((await line('new-uat-person',participant)).status,'signed_in');
  assert.equal((await call('/me',{jar:participant})).participant_id,first.participant_id);
  assert.equal((await call('/me/enrollments',{jar:participant})).items.length,3);
});

test('membership cards require uppercase B followed by exactly fourteen ASCII digits',async()=>{
  const jar={};await otp('0912999998',jar);
  const fields={name:'卡號格式驗收',member:true,districtId:'north6',chapterId:'prajna'};
  const digits='0'.repeat(14);
  for(const card of ['B'+digits.slice(1),'B'+digits+'0','C'+digits,'b'+digits,digits,'B'+digits.slice(1)+'A',
    'B'+digits.slice(0,7)+' '+digits.slice(7),'B-'+digits,'Ｂ'+'０'.repeat(14)]) {
    const invalid=await call('/me/profile',{jar,method:'PATCH',body:{...fields,card},expect:422});
    assert.equal(invalid.error.code,'CARD_INVALID');
    assert.equal(invalid.error.message,'佛光卡號第一碼為 B，後面接 14 碼數字。');
  }
  assert.equal((await call('/me',{jar})).card_mask,null);
  await call('/me/profile',{jar,method:'PATCH',body:{...fields,card:''},expect:422});
  const saved=await call('/me/profile',{jar,method:'PATCH',body:{...fields,card:'B'+digits.slice(1)+'7'}});
  assert.equal(saved.card_mask,'••••0007');
  assert.equal(saved.member_status,'pending');
  assert.equal((await call('/me/profile',{jar,method:'PATCH',body:{...fields,card:''}})).card_mask,saved.card_mask);
  const preview=await call('/admin/dispatch-jobs/preview',{jar:staff,body:{surveyId:'vegrun-follow-T2',audience:'member',cards:'B'+digits.slice(1)}});
  assert.deepEqual(preview.excluded,{'格式錯誤':1});
});

test('UAT-02: cross-account LINE attach creates a review case and retains both accounts',async()=>{
  const other={};
  const before=await otp('0900000002',other);
  const conflict=await line('2',participant);
  assert.equal(conflict.status,'conflict');
  assert.ok(conflict.caseId);
  assert.equal((await call('/me',{jar:other})).participant_id,before.participant_id);
  const reviewer=await login('reviewer');
  const result=await call('/admin/identity-cases',{jar:reviewer});
  assert.ok(result.items.some(item=>item.id===conflict.caseId&&item.other_id===before.participant_id));
});

test('UAT-04 and UAT-05: list by verified card and filter non-members with AND rules',async()=>{
  const member=await call('/admin/dispatch-jobs/preview',{jar:staff,body:{surveyId:'vegrun-follow-T2',audience:'member',cards:[2,3,9999,2].map(n=>'B'+String(n).padStart(14,'0')).join(',')}});
  assert.equal(member.count,1);
  assert.deepEqual(member.excluded,{'待審或未核驗':1,'未找到':1,'重複':1});
  const audience=await call('/admin/dispatch-jobs/preview',{jar:staff,body:{surveyId:'earth-follow-T2',audience:'nonmember',regions:['宜蘭縣'],statuses:['attended']}});
  assert.equal(audience.count,2);
  assert.ok(audience.recipients.every(r=>r.type==='nonmember'&&r.region==='宜蘭縣'));
});

test('UAT-06 and UAT-09: persisted send-time checks and reminder denominator',async()=>{
  const member=await call('/admin/dispatch-jobs/preview',{jar:staff,body:{surveyId:'vegrun-follow-T2',audience:'member',cards:'B'+String(2).padStart(14,'0')}});
  const due=new Date(Date.now()+1200).toISOString();
  const job=await call('/admin/dispatch-jobs',{jar:staff,body:{previewId:member.id,dueAt:due}});
  const repeated=await call('/admin/dispatch-jobs',{jar:staff,body:{previewId:member.id,dueAt:due}});
  assert.equal(repeated.id,job.id);
  const memberJar={};await otp('0900000002',memberJar);
  await call('/me/consents',{jar:memberJar,body:tracking('VGR',false)});
  await wait(1750);
  const updated=await call('/admin/dispatch-jobs/'+job.id,{jar:staff});
  assert.equal(updated.statistics.acceptance.denominator,1);
  assert.equal(updated.statistics.acceptance.numerator,0);
  assert.equal(updated.attempts.items[0].status,'skipped');
  assert.match(updated.attempts.items[0].reason,/撤回|未同意/);
  assert.equal(updated.status,'completed');
  const seeded=(await call('/admin/dispatch-jobs',{jar:staff})).items.find(j=>j.acceptance.denominator===10);
  await call('/admin/dispatch-jobs/'+seeded.id+'/reminders',{jar:staff,body:{}});
  await wait(800);
  const reminded=await call('/admin/dispatch-jobs/'+seeded.id,{jar:staff});
  assert.equal(reminded.statistics.acceptance.denominator,10);
  assert.equal(reminded.statistics.acceptance.numerator,10);
});

test('UAT-07 and UAT-08: normalized idempotent submissions, conflicting answers, deadline and invitation ownership',async()=>{
  const data={versionId:'VGR-T0-1',answers:{diet_meals_7d:0}};
  const [first,repeat]=await Promise.all([call('/event-surveys/vegrun-T0/responses',{jar:participant,body:data}),call('/event-surveys/vegrun-T0/responses',{jar:participant,body:data})]);
  assert.equal(first.responseId,repeat.responseId);
  assert.equal((await call('/event-surveys/vegrun-T0/responses',{jar:participant,body:{...data,answers:{diet_meals_7d:1}},expect:409})).error.code,'ALREADY_SUBMITTED');
  db.prepare("UPDATE event_surveys SET closes_at=? WHERE id='earth-T0'").run(new Date().toISOString());
  assert.equal((await call('/event-surveys/earth-T0/responses',{jar:participant,body:{versionId:'EARTH-T0-1',answers:{conservation_days_30d:0}},expect:409})).error.code,'SURVEY_CLOSED');
  const rec=db.prepare('SELECT id FROM recipients WHERE participant_id=? LIMIT 1').get(sample.me.participant_id);
  db.prepare("INSERT INTO invitations VALUES (?,?,?,NULL)").run(createHash('sha256').update('uat-invite').digest('hex'),rec.id,new Date(Date.now()+60000).toISOString());
  assert.equal((await call('/me/invitations/open',{jar:participant,body:{token:'uat-invite'},expect:403})).error.code,'INVITATION_OWNER');
  assert.equal((await call('/me/invitations/open',{jar:sample,body:{token:'uat-invite'}})).surveyId,'vegrun-follow-T2');
});

test('UAT-12 and UAT-15: scoped attendance, audits, private photo, and phone rotation',async()=>{
  const scoped=await login('north3-ops');
  await call('/admin/events/vegrun/roster',{jar:scoped,expect:403});
  const scopedAnalyst=await login('north3-analyst');
  const forbidden=await call('/admin/reports/export?eventId=vegrun',{jar:scopedAnalyst,expect:403});
  assert.equal(forbidden.error.code,'ORG_FORBIDDEN');
  const png=new Blob([readFileSync(new URL('../web/assets/food.webp',import.meta.url))],{type:'image/webp'});
  const photo=await call('/me/files',{jar:participant,body:png});
  await call('/me/files/'+photo.id,{jar:sample,expect:404});
  await call('/me/files/'+photo.id,{jar:participant});
  const before=await call('/me',{jar:participant});
  const after=await otp('0912000102',participant,'change');
  assert.equal(after.participant_id,before.participant_id);
  await call('/auth/logout',{jar:participant,body:{}});
  assert.equal((await otp('0912000102',participant)).participant_id,before.participant_id);
  const root=await login('admin');
  const audit=await call('/admin/audit?q=asset.read',{jar:root});
  assert.ok(audit.items.some(item=>item.target===photo.id));
});

test('UAT-13 and UAT-16: immutable version assignment and independent snapshot approval',async()=>{
  const forms=await call('/admin/survey-versions?program=VGR&stage=T0',{jar:staff});
  const old=forms.items[0];
  const created=await call('/admin/survey-versions',{jar:staff,body:{program:'VGR',stage:'T0',form:old.form}});
  await call('/admin/survey-versions/'+created.id+'/publish',{jar:staff,body:{}});
  const existing=(await call('/admin/events',{jar:staff})).items.find(ev=>ev.id==='vegrun');
  assert.equal(existing.surveys.find(s=>s.stage==='T0').version_id,old.id);
  const analyst=await login('analyst');
  const reviewer=await login('publisher');
  const evidence=(await call('/admin/evidence?eventId=vegrun-follow',{jar:analyst})).items[0];
  const snap=await call('/admin/metric-snapshots',{jar:analyst,body:{eventId:'vegrun-follow',reason:'驗收快照',stage:'T2',evidenceIds:[evidence.id]}});
  await call('/admin/metric-snapshots/'+snap.id+'/review',{jar:analyst,body:{approve:true,reason:'核對'},expect:403});
  await call('/admin/metric-snapshots/'+snap.id+'/review',{jar:reviewer,body:{approve:true,reason:'核對證據與計算版本'}});
  const saved=(await call('/admin/metric-snapshots',{jar:reviewer})).items.find(r=>r.id===snap.id);
  assert.equal(saved.status,'published');
  assert.equal(saved.report.calculationVersion,'1.0.0');
  assert.equal(saved.evidenceIds[0],evidence.id);
  assert.ok(saved.report.cutoff);
});

test('system administrator has every module and retains independent review',async()=>{
  const root=await login('admin');
  for(const path of ['/admin/events','/admin/survey-versions','/admin/dispatch-jobs','/admin/reports/recovery?eventId=vegrun-follow',
    '/admin/reports/outcomes?eventId=vegrun-follow','/admin/evidence','/admin/metric-snapshots','/admin/response-reviews',
    '/admin/members','/admin/identity-cases','/admin/rights','/admin/residence-locations','/admin/staff','/admin/audit']) {
    await call(path,{jar:root});
  }
  const evidence=(await call('/admin/evidence?eventId=vegrun-follow',{jar:root})).items.find(item=>item.status==='approved');
  const snap=await call('/admin/metric-snapshots',{jar:root,body:{eventId:'vegrun-follow',reason:'管理員驗收快照',stage:'T2',evidenceIds:[evidence.id]}});
  const own=await call('/admin/metric-snapshots/'+snap.id+'/review',{jar:root,body:{approve:true,reason:'不得自行複核'},expect:409});
  assert.equal(own.error.code,'SECOND_REVIEW');
  const analyst=await login('analyst');
  const other=await call('/admin/metric-snapshots',{jar:analyst,body:{eventId:'vegrun-follow',reason:'交由管理員複核',stage:'T2',evidenceIds:[evidence.id]}});
  await call('/admin/metric-snapshots/'+other.id+'/review',{jar:root,body:{approve:true,reason:'核對完畢'}});
  const created=await call('/admin/evidence',{jar:root,body:{eventId:'vegrun-follow',title:'管理員證據',source:'驗收',version:'1',recordedAt:new Date().toISOString()}});
  await call('/admin/evidence/'+created.id+'/review',{jar:root,body:{approve:true,reason:'不得自行審查'},expect:409});
});

test('staff access management enforces scope, immediate revocation, audit and a remaining administrator',async()=>{
  const root=await login('admin');
  await call('/admin/staff',{jar:staff,expect:403});
  const input={id:'access-test',label:'權限驗收',role:'operator',orgId:'north3',active:true,reason:'驗證組織權限'};
  await call('/admin/staff',{jar:staff,body:input,expect:403});
  await call('/admin/staff',{jar:root,body:{...input,role:'unknown'},expect:422});
  await call('/admin/staff',{jar:root,body:{...input,orgId:'unknown'},expect:422});
  await call('/admin/staff',{jar:root,body:{...input,role:'admin'},expect:422});
  await call('/admin/staff',{jar:root,body:input});
  await call('/admin/staff',{jar:root,body:input,expect:409});
  const account=await login(input.id);
  const scoped=(await call('/admin/events',{jar:account})).items;
  assert.ok(scoped.length>0);
  assert.ok(scoped.every(row=>['north3','bright'].includes(row.org_id)));
  await call('/admin/staff',{jar:account,expect:403});
  await call('/admin/metric-snapshots',{jar:account,expect:403});
  await call('/admin/staff/'+input.id,{jar:root,method:'PATCH',body:{...input,role:'analyst',orgId:'',reason:'改為全平台分析'}});
  await call('/admin/me',{jar:account,expect:401});
  await login(input.id,account);
  assert.equal((await call('/admin/me',{jar:account})).role,'analyst');
  await call('/admin/metric-snapshots',{jar:account});
  await call('/admin/staff/'+input.id,{jar:root,method:'PATCH',body:{...input,active:false,reason:'停用驗收帳號'}});
  await call('/admin/me',{jar:account,expect:401});
  await call('/auth/admin/login',{jar:account,body:{account:input.id},expect:401});
  assert.ok(!(await call('/auth/admin/accounts')).items.some(row=>row.id===input.id));
  const audit=await call('/admin/audit?q=access.update',{jar:root});
  assert.ok(audit.items.some(row=>row.target===input.id));
  const last=await call('/admin/staff/admin',{jar:root,method:'PATCH',body:{label:'系統管理員',role:'admin',orgId:'',active:false,reason:'最後管理員保護測試'},expect:409});
  assert.equal(last.error.code,'LAST_ADMIN');
  await call('/admin/staff/admin',{jar:root,method:'PATCH',body:{label:'系統管理員',role:'operator',orgId:'',active:true,reason:'最後管理員降級保護測試'},expect:409});
  assert.equal((await call('/admin/me',{jar:root})).role,'admin');
});

test('Draft event lifecycle and repeated attendance imports',async()=>{
  const time=hours=>new Date(Date.now()+hours*3600000).toISOString();
  const created=await call('/admin/events',{jar:staff,body:{program:'VGR',title:'驗收場次',region:'臺北市',venue:'測試公園',orgId:'prajna',timezone:'Asia/Taipei',
    startsAt:time(2),endsAt:time(4),registrationOpens:time(-2),registrationCloses:time(1)}});
  assert.equal(created.status,'draft');
  const s=await call('/admin/events/'+created.id+'/surveys',{jar:staff,body:{stage:'T0',versionId:'VGR-T0-1'}});
  assert.equal(s.closes_at,created.starts_at);
  await call('/admin/events/'+created.id+'/status',{jar:staff,body:{status:'published'}});
  const en=await call('/events/'+created.id+'/enrollments',{jar:participant,body:{}});
  const roster=await call('/admin/events/'+created.id+'/attendance-imports',{jar:staff,body:{participantIds:[en.participant_id,en.participant_id]}});
  assert.deepEqual(roster.rows.map(r=>r.status),['已登錄','重複']);
  const reused=await call('/admin/events/'+created.id+'/attendance-imports',{jar:staff,body:{participantIds:[en.participant_id]}});
  assert.equal(reused.rows[0].status,'已簽到');
});

test('Version mismatch is excluded while a valid 0 → 3 pair is retained',async()=>{
  const newPerson={};
  const owner=await otp('0912000103',newPerson);
  const s='vegrun-follow';
  const firstVersion=db.prepare("SELECT * FROM survey_versions WHERE id='VGR-T2-1'").get();
  const schema=JSON.parse(firstVersion.schema_json);
  schema[0].metricVersion='uat-2';
  const later=new Date(Date.now()-3600000).toISOString();
  const earlier=new Date(Date.now()-95*86400000).toISOString();
  db.prepare("INSERT INTO survey_versions VALUES (?,'VGR','T2',2,'published',?,?,?)").run('uat-incompatible-t2',JSON.stringify(schema),earlier,earlier);
  db.prepare("INSERT INTO enrollments VALUES (?,?, 'attended',?,?,?)").run(s,owner.participant_id,earlier,earlier,earlier);
  const insert=db.prepare('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at) VALUES (?,?,?,?,?,?)');
  insert.run('uat-mismatch-t0',s+'-T0',owner.participant_id,'VGR-T0-1','{"diet_meals_7d":0}',earlier);
  insert.run('uat-mismatch-t2',s+'-T2',owner.participant_id,'uat-incompatible-t2','{"diet_meals_7d":3}',later);
  const original=await call('/admin/reports/outcomes?eventId=vegrun-follow',{jar:staff});
  assert.equal(original.incomparable,1);
  assert.deepEqual(original.paired,{numerator:3,denominator:9,percent:33.3});
  db.prepare("UPDATE responses SET version_id='VGR-T2-1' WHERE id='uat-mismatch-t2'").run();
  const comparable=await call('/admin/reports/outcomes?eventId=vegrun-follow',{jar:staff});
  assert.equal(comparable.incomparable,0);
  assert.equal(comparable.paired.numerator,4);
  db.prepare("UPDATE responses SET effective=0 WHERE id='uat-mismatch-t2'").run();
});

test('A transient provider failure retries without duplicating an accepted peer',async()=>{
  const first={},second={};
  const p1=await otp('0912000104',first);
  const p2=await otp('0912000105',second);
  await line('UAT-retry-once',first);await line('UAT-direct',second);
  const current=new Date().toISOString();
  for(const [personId,jar] of [[p1.participant_id,first],[p2.participant_id,second]]) {
    await allow(jar,['EARTH']);
    await call('/me/profile',{jar,method:'PATCH',body:{member:false,residenceCityId:'09007',residenceDistrictId:'09007010'}});
    db.prepare("INSERT INTO enrollments VALUES ('earth-follow',?,'attended',?,?,?)").run(personId,current,current,current);
  }
  const preview=await call('/admin/dispatch-jobs/preview',{jar:staff,body:{surveyId:'earth-follow-T2',audience:'nonmember',residenceCityId:'09007',residenceDistrictId:'09007010',statuses:['attended']}});
  assert.equal(preview.count,2);
  const job=await call('/admin/dispatch-jobs',{jar:staff,body:{previewId:preview.id}});
  await wait(3000);
  const final=await call('/admin/dispatch-jobs/'+job.id,{jar:staff});
  assert.equal(final.status,'completed');
  assert.equal(final.statistics.acceptance.numerator,2);
  assert.deepEqual(final.attempts.items.map(a=>a.retries).sort(),[0,1]);
  const receipts=db.prepare("SELECT d.tries FROM demo_delivery_receipts d JOIN attempts a ON a.id=d.key JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=?").all(job.id);
  assert.deepEqual(receipts.map(r=>r.tries).sort(),[1,2]);
});

test('Reviewed correction preserves the original response and its submission time',async()=>{
  const participantMe=await call('/me',{jar:participant});
  const before=db.prepare("SELECT * FROM responses WHERE participant_id=? AND event_survey_id='vegrun-T0' AND effective=1").get(participantMe.participant_id);
  const analyst=await login('analyst');
  const publisher=await login('publisher');
  const form=await call('/admin/responses/'+before.id,{jar:analyst});
  assert.equal(form.answers.diet_meals_7d,0);
  const queued=await call('/admin/responses/'+before.id+'/corrections',{jar:analyst,body:{answers:{diet_meals_7d:3},reason:'依本人請求修訂'}});
  await call('/admin/response-reviews/'+queued.id,{jar:publisher,body:{approve:true,reason:'核對申請內容'}});
  const saved=db.prepare('SELECT * FROM responses WHERE replaces_id=?').get(before.id);
  assert.equal(saved.revision,2);
  assert.equal(saved.effective,1);
  assert.equal(saved.submitted_at,before.submitted_at);
  assert.equal(db.prepare('SELECT effective FROM responses WHERE id=?').get(before.id).effective,0);
  assert.equal(JSON.parse(saved.answers_json).diet_meals_7d,3);
});

test('Taiwan residence selections persist and reject mismatched or unknown areas',async()=>{
  const config=await call('/config');
  assert.equal(config.residenceLocations.cities.length,22);
  assert.equal(config.residenceLocations.districts.length,368);
  assert.equal(config.residenceLocations.districts.filter(d=>d.city_id==='63000').length,12);
  const jar={};
  const user=await otp('0912000190',jar);
  const data={name:'縣市地區驗收',member:false,residenceCityId:'63000',residenceDistrictId:'63000030'};
  const saved=await call('/me/profile',{jar,method:'PATCH',body:data});
  assert.equal(saved.residence_city,'臺北市');assert.equal(saved.residence_district,'大安區');
  assert.equal((await call('/me',{jar})).residence_district_id,'63000030');
  await call('/me/profile',{jar,method:'PATCH',body:{...data,residenceCityId:'65000'},expect:422});
  await call('/me/profile',{jar,method:'PATCH',body:{...data,residenceDistrictId:'unknown'},expect:422});
  await call('/me/profile',{jar,method:'PATCH',body:{member:false,region:'海外'},expect:422});
  assert.throws(()=>db.prepare('UPDATE profiles SET residence_city_id=? WHERE participant_id=?').run('65000',user.participant_id),/RESIDENCE_MISMATCH/);
  assert.equal((await call('/me',{jar})).residence_city_id,'63000');
  const cleared=await call('/me/profile',{jar,method:'PATCH',body:{...data,residenceCityId:'',residenceDistrictId:''}});
  assert.equal(cleared.residence_city_id,null);assert.equal(cleared.residence_district_id,null);assert.equal(cleared.region,'');
});

test('only system administrators maintain locations and disabled choices preserve existing references',async()=>{
  await call('/admin/residence-locations',{jar:staff,expect:403});
  await call('/admin/residence-cities',{jar:staff,body:{name:'驗收市',sortOrder:50,active:true},expect:403});
  const admin=await login('admin');
  const city=await call('/admin/residence-cities',{jar:admin,body:{name:'驗收市',sortOrder:50,active:true}});
  const area=await call('/admin/residence-districts',{jar:admin,body:{cityId:city.id,name:'驗收區',sortOrder:0,active:true}});
  await call('/admin/residence-districts',{jar:admin,body:{cityId:city.id,name:'驗收區',sortOrder:1,active:true},expect:409});
  await call('/admin/residence-cities',{jar:admin,body:{name:'外國',sortOrder:0,active:true},expect:422});
  const jar={};await otp('0912000190',jar);
  const location={member:false,residenceCityId:city.id,residenceDistrictId:area.id};
  await call('/me/profile',{jar,method:'PATCH',body:location});
  await call('/admin/residence-cities/'+city.id,{jar:admin,method:'PATCH',body:{name:'驗收新市',sortOrder:51,active:false}});
  await call('/admin/residence-districts/'+area.id,{jar:admin,method:'PATCH',body:{name:'驗收新區',sortOrder:2,active:false}});
  const retained=await call('/me/profile',{jar,method:'PATCH',body:{...location,name:'保留既有地區'}});
  assert.equal(retained.residence_city,'驗收新市');assert.equal(retained.residence_district,'驗收新區');assert.equal(retained.region,'驗收新市');
  const other={};await otp('0912000191',other);
  await call('/me/profile',{jar:other,method:'PATCH',body:location,expect:422});
  const catalog=await call('/admin/residence-locations',{jar:admin});
  assert.equal(catalog.cities.find(c=>c.id===city.id).used,1);
  assert.equal(catalog.districts.find(d=>d.id===area.id).active,0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit WHERE action LIKE 'residence.%' AND actor='admin'").get().n>=4);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Both app entry points and their same-origin assets are served',async()=>{
  for(const path of ['/','/admin']) {
    const response=await fetch(origin+path);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/text\/html/);
    assert.match(await response.text(),/src="\/app.js"/);
  }
  const assets=await Promise.all(['/app.js','/admin.js','/public.js','/style.css','/assets/hero.webp'].map(path=>fetch(origin+path)));
  assert.ok(assets.every(response=>response.ok));
  assert.match(assets.at(-1).headers.get('content-type'),/image\/webp/);
});
