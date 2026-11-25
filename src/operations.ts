import { filterAsync } from './async.ts';
import { PROGRAMS, FOLLOW, NOTICE, STAGES, DAY, date, demand, iso, mean, median, normalizeCard, rate } from './domain.ts';
import { all, audit, consent, demo, digest, eligibility, enrollment, getEvent, getSurvey, id, lookup, one, open, run, token, tx, windowFor } from './store.ts';

export const gateway = process.env.SIMP_GATEWAY_URL;
export const tlsOrigin = process.env.SIMP_ORIGIN;
if (!demo && (!gateway?.startsWith('https://') || !tlsOrigin?.startsWith('https://') || !process.env.SIMP_GATEWAY_KEY)) {
  throw new Error('Non-demo mode requires HTTPS SIMP_GATEWAY_URL, SIMP_ORIGIN and SIMP_GATEWAY_KEY.');
}
export async function provider(action:string, data:any) {
  if (demo) {
    if (action==='push/status') return await one('SELECT status,reference,accepted_at AS acceptedAt FROM demo_delivery_receipts WHERE key=?',data.key)??{status:'unknown'};
    if (action==='push/line') return await tx(async ()=>{
      const saved=await one('SELECT status,reference,accepted_at AS acceptedAt,tries FROM demo_delivery_receipts WHERE key=?',data.key);
      if (saved && saved.status!=='retry') return saved;
      const simulateRetry=data.subject==='UAT-retry-once' && !saved;
      const result={status:simulateRetry?'retry':'accepted',reference:simulateRetry?null:'demo-'+id(),acceptedAt:simulateRetry?null:iso()};
      await run(`INSERT INTO demo_delivery_receipts VALUES (?,?,?,?,1) ON CONFLICT(key) DO UPDATE
        SET status=excluded.status,reference=excluded.reference,accepted_at=excluded.accepted_at,tries=demo_delivery_receipts.tries+1`,
        data.key,result.status,result.reference,result.acceptedAt);
      return result;
    });
    return {status:'accepted', reference:'demo-'+id()};
  }
  const result=await fetch(new URL(action,gateway!.replace(/\/?$/,'/')),{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.SIMP_GATEWAY_KEY},
    body:JSON.stringify(data),signal:AbortSignal.timeout(6000)
  });
  if (!result.ok) throw new Error('Provider request failed');
  return result.json();
}
export async function inOrg(wanted:string | null, actual:string | null) {
  if (!wanted) return true;
  if (!actual) return false;
  return wanted===actual || (await one('SELECT parent_id FROM org_units WHERE id=?',actual))?.parent_id===wanted;
}
export async function scope(staff:any,event:any) {
  demand(await inOrg(staff.org_id,event.org_id),403,'ORG_FORBIDDEN','此場次不在您的授權範圍。');
}
export async function recordConsent(person:string, purpose:string, code:string, choice:boolean) {
  await run('INSERT INTO consents(participant_id,purpose,scope,notice_version,choice,created_at,source) VALUES (?,?,?,?,?,?,?)',
    person,purpose,code,NOTICE,Number(choice),iso(),'web');
}

export async function audience(staff:any, survey:any, input:any) {
  await scope(staff,survey);
  const excluded:Record<string,number>={};
  const members:any[]=[];
  const increment=(reason:string)=>{ excluded[reason]=(excluded[reason]??0)+1; };
  const count=new Set<string>();
  const evaluate=async (profile:any)=>{
    if (count.has(profile.participant_id)) return increment('重複');
    count.add(profile.participant_id);
    if (staff.org_id && !await inOrg(staff.org_id,profile.chapter_id??profile.district_id)) return increment('超出權限');
    if (await one('SELECT id FROM responses WHERE event_survey_id=? AND participant_id=? AND effective=1',survey.id,profile.participant_id)) return increment('已完成');
    const reason=await eligibility(survey,profile.participant_id,iso(),true,false);
    if (reason) return increment(reason);
    members.push({id:profile.participant_id, type:profile.member_status, mask:profile.card_mask??'非會員', region:profile.region||'未設定',residenceCity:profile.residence_city,residenceDistrict:profile.residence_district});
  };
  demand(['member','nonmember'].includes(input.audience),422,'AUDIENCE','請指定會員或非會員。');
  if (input.audience==='member') {
    const cards=String(input.cards??'').split(/[,，\n]+/).map(v=>v.trim()).filter(Boolean);
    demand(cards.length>0 && cards.length<=6000,422,'CARD_LIST','請輸入 1 至 6,000 張佛光卡號。');
    const seen=new Set<string>();
    for (const raw of cards) {
      let card;
      try { card=normalizeCard(raw); } catch { increment('格式錯誤'); continue; }
      if (seen.has(card)) { increment('重複'); continue; }
      seen.add(card);
      const profiles=await all('SELECT * FROM profiles WHERE card_lookup=? ORDER BY member_status=\'verified\' DESC',lookup(card));
      const profile=profiles[0];
      if (!profile) increment('未找到');
      else if (staff.org_id && !await inOrg(staff.org_id,profile.chapter_id??profile.district_id)) increment('超出權限');
      else if (profile.member_status!=='verified') increment('待審或未核驗');
      else await evaluate(profile);
    }
  } else {
    const strings=(values:any)=>Array.isArray(values)?values.filter(v=>typeof v==='string').slice(0,40):[];
    const regions=strings(input.regions), statuses=strings(input.statuses);
    const cityId=input.residenceCityId||'', districtId=input.residenceDistrictId||'';
    demand(!cityId||await one('SELECT id FROM residence_cities WHERE id=?',cityId),422,'RESIDENCE_CITY','居住縣市無效。');
    demand(!districtId||(cityId&&await one('SELECT id FROM residence_districts WHERE id=? AND city_id=?',districtId,cityId)),422,'RESIDENCE_DISTRICT','請選擇該縣市所屬的居住地區。');
    const profiles=await all(`SELECT p.*,en.status,c.name AS residence_city,d.name AS residence_district FROM profiles p JOIN enrollments en ON en.participant_id=p.participant_id
      LEFT JOIN residence_cities c ON c.id=p.residence_city_id LEFT JOIN residence_districts d ON d.id=p.residence_district_id
      WHERE en.event_id=? AND p.member_status='nonmember'`,survey.event_id);
    for (const profile of profiles) {
      if ((!regions.length || regions.includes(profile.region)) && (!statuses.length || statuses.includes(profile.status))&&
        (!cityId||profile.residence_city_id===cityId)&&(!districtId||profile.residence_district_id===districtId)) await evaluate(profile);
    }
  }
  return {members,excluded,input:{audience:input.audience, regions:input.regions??[], statuses:input.statuses??[],residenceCityId:input.residenceCityId||'',residenceDistrictId:input.residenceDistrictId||''}, createdAt:iso()};
}

async function canonicalPeople() {
  return new Map<string,string>((await all(`WITH RECURSIVE roots(id,canonical) AS (
    SELECT id,id FROM participants WHERE merged_into_id IS NULL
    UNION ALL SELECT p.id,roots.canonical FROM participants p JOIN roots ON p.merged_into_id=roots.id
  ) SELECT * FROM roots`)).map(row=>[row.id,row.canonical]));
}
export async function jobStats(job:any, until=iso()) {
  const survey=await getSurvey(job.survey_id);
  const raw=await all(`SELECT r.id,r.participant_id,
    MIN(CASE WHEN a.status IN ('accepted','delivered') THEN a.accepted_at END) AS accepted_at,
    MAX(CASE WHEN a.status='delivered' THEN 1 ELSE 0 END) AS delivered,
    MIN(i.opened_at) AS opened_at
    FROM recipients r LEFT JOIN attempts a ON a.recipient_id=r.id AND (a.accepted_at IS NULL OR a.accepted_at<=?)
    LEFT JOIN invitations i ON i.recipient_id=r.id AND i.opened_at<=? WHERE r.job_id=? GROUP BY r.id`,until,until,job.id);
  const canonical=await canonicalPeople();
  const grouped=new Map<string,any>();
  for (const row of raw) {
    const person=canonical.get(row.participant_id)??row.participant_id, existing=grouped.get(person);
    const earliest=(a:string|null,b:string|null)=>!a?b:!b||a<=b?a:b;
    grouped.set(person,{participant_id:person,accepted_at:earliest(existing?.accepted_at,row.accepted_at),
      opened_at:earliest(existing?.opened_at,row.opened_at),delivered:existing?.delivered||row.delivered});
  }
  const rows=[...grouped.values()];
  let accepted=0, replied=0, opened=0, converted=0, delivered=0;
  for (const row of rows) {
    if (row.delivered) delivered++;
    if (row.opened_at) opened++;
    if (!row.accepted_at) continue;
    accepted++;
    const response=await one('SELECT submitted_at FROM responses WHERE event_survey_id=? AND participant_id=? AND effective=1',survey.id,row.participant_id);
    const deadline=windowFor(survey,await enrollment(survey.event_id,row.participant_id)).closes_at;
    if (response && response.submitted_at>=row.accepted_at && response.submitted_at<deadline && response.submitted_at<=until) {
      replied++;
      if (row.opened_at && row.opened_at<=response.submitted_at) converted++;
    }
  }
  return {acceptance:rate(accepted,rows.length),recovery:rate(replied,accepted),conversion:rate(converted,opened),delivered};
}
export async function enqueue(job:any, number:number) {
  for (const target of await all('SELECT id FROM recipients WHERE job_id=?',job.id)) {
    await run(`INSERT OR IGNORE INTO attempts(id,recipient_id,number,due_at,status,queued_at)
      VALUES (?,?,?,?,'pending',?)`,id(),target.id,number,number===1?job.due_at:iso(),iso());
  }
}
async function finishJob(jobId:string) {
  const remaining=(await one(`SELECT COUNT(*) n FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=? AND a.status IN ('pending','processing')`,jobId)).n;
  if (remaining) return;
  const issues=(await one(`SELECT COUNT(*) n FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=? AND a.status IN ('failed','unknown')`,jobId)).n;
  await run("UPDATE jobs SET status=? WHERE id=? AND status IN ('running','scheduled')",issues?'partial_failed':'completed',jobId);
}
export async function cancelJob(jobId:string, reason:string) {
  await run("UPDATE jobs SET status='cancelled' WHERE id=? AND status IN ('scheduled','running')",jobId);
  await run(`UPDATE attempts SET status='skipped', reason=? WHERE status='pending'
    AND recipient_id IN (SELECT id FROM recipients WHERE job_id=?)`,reason,jobId);
}
let busy=false;
export async function processQueue() {
  if (busy) return;
  busy=true;
  try {
    const stalled=await all(`SELECT DISTINCT r.job_id FROM attempts a JOIN recipients r ON r.id=a.recipient_id
      WHERE a.status='processing' AND a.due_at<=?`,iso());
    await run("UPDATE attempts SET status='unknown',reason='處理中斷，等待管道查核' WHERE status='processing' AND due_at<=?",iso());
    for (const row of stalled) await finishJob(row.job_id);
    for (let i=0;i<40;i++) {
      const row=await tx(async ()=> {
        const next=await one(`SELECT a.*,r.participant_id,r.job_id,j.survey_id FROM attempts a JOIN recipients r ON r.id=a.recipient_id
          JOIN jobs j ON j.id=r.job_id WHERE a.status='pending' AND a.due_at<=? AND j.status IN ('scheduled','running') ORDER BY a.due_at,a.id LIMIT 1`,iso());
        if (!next) return null;
        await run("UPDATE attempts SET status='processing',due_at=? WHERE id=?",iso(60000),next.id);
        await run("UPDATE jobs SET status='running' WHERE id=?",next.job_id);
        return next;
      });
      if (!row) break;
      const survey=await getSurvey(row.survey_id);
      let reason=await eligibility(survey,row.participant_id,iso(),true);
      if (await one('SELECT id FROM responses WHERE event_survey_id=? AND participant_id=? AND effective=1',survey.id,row.participant_id)) reason='已完成';
      if ((await one('SELECT status FROM jobs WHERE id=?',row.job_id))?.status==='cancelled') reason='任務取消';
      if (reason) {
        await run("UPDATE attempts SET status='skipped',reason=? WHERE id=?",reason,row.id);
      } else {
        const identity=await one("SELECT * FROM identities WHERE participant_id=? AND kind='line' AND revoked_at IS NULL",row.participant_id);
        if (!identity) {
          await run("UPDATE attempts SET status='skipped',reason='未綁定 LINE' WHERE id=?",row.id);
          await finishJob(row.job_id);
          continue;
        }
        const invite=token(), expires=windowFor(survey,await enrollment(survey.event_id,row.participant_id)).closes_at;
        await run('INSERT INTO invitations VALUES (?,?,?,NULL)',digest(invite),row.recipient_id,expires);
        try {
          const result=await provider('push/line',{subject:open(identity.encrypted),issuer:identity.issuer, key:row.id,
            url:(tlsOrigin??'')+'/?invite='+invite, message:'您有一份待填問卷，請登入社會影響力評估。'});
          const status=['accepted','delivered','failed','retry','unknown'].includes(result.status)?result.status:'unknown';
          if (status==='retry' && row.retries<3) {
            await run("UPDATE attempts SET status='pending',due_at=?,retries=retries+1,reason='管道暫時忙碌' WHERE id=?",iso(1000*2**(row.retries+1)),row.id);
          } else {
            const sent=['accepted','delivered'].includes(status);
            await run('UPDATE attempts SET status=?,accepted_at=?,provider_ref=?,reason=? WHERE id=?',
              status==='retry'?'failed':status,sent&&result.acceptedAt?date(result.acceptedAt):sent?iso():null,typeof result.reference==='string'?result.reference.slice(0,160):null,sent?null:'管道回傳 '+status,row.id);
          }
        } catch {
          await run("UPDATE attempts SET status='unknown',reason='結果不明，等待管道查核' WHERE id=?",row.id);
        }
      }
      await finishJob(row.job_id);
    }
    for (const job of await all(`SELECT j.id FROM jobs j WHERE j.status IN ('scheduled','running') AND NOT EXISTS (
      SELECT a.id FROM recipients r JOIN attempts a ON a.recipient_id=r.id WHERE r.job_id=j.id AND a.status IN ('pending','processing'))`)) await finishJob(job.id);
  } finally { busy=false; }
}

export async function report(staff:any, filters:any) {
  const until=filters.until ? date(filters.until) : iso();
  const since=filters.since ? date(filters.since) : '';
  demand(!since || since<until,422,'REPORT_PERIOD','起日必須早於截止時間。');
  const stage=filters.stage||'T2';
  demand(FOLLOW.includes(stage),422,'REPORT_STAGE','配對階段需為 F30、T2 或 T3。');
  if (filters.eventId) await scope(staff,await getEvent(filters.eventId));
  if (filters.district) demand(await inOrg(staff.org_id,filters.district) || await inOrg(filters.district,staff.org_id),403,'ORG_FORBIDDEN','此督導區不在您的授權範圍。');
  if (filters.chapter) demand(await inOrg(staff.org_id,filters.chapter),403,'ORG_FORBIDDEN','此分會不在您的授權範圍。');
  const events=(await filterAsync((await all(`SELECT * FROM events WHERE status IN ('published','completed','archived') ORDER BY starts_at DESC,id`)), async e=>await inOrg(staff.org_id,e.org_id) && (!filters.eventId||e.id===filters.eventId) && (!filters.program||e.program===filters.program)));
  const people=new Set<string>(), deltaByProgram:any={};
  const canonical=await canonicalPeople();
  const crossRecipients=new Map<string,{accepted:string|null,replied:boolean}>();
  let attendance=0, registered=0, t1=0, t0=0, matched=0, maxCount=0, maintain=0, followResponses=0, incomparable=0, missing=0;
  const included=(r:any)=>r && (!filters.member||r.member_status===filters.member) && (!filters.district||r.district_id===filters.district) && (!filters.chapter||r.chapter_id===filters.chapter);
  const minimum=Math.max(1,Number(process.env.SIMP_MIN_SAMPLE)||5);
  const eventRows=await Promise.all(events.map(async event=>{
    const p=PROGRAMS.find(p=>p.code===event.program)!;
    const roster=(await all(`SELECT en.*,pr.member_status,pr.district_id,pr.chapter_id FROM enrollments en JOIN profiles pr ON pr.participant_id=en.participant_id JOIN participants pa ON pa.id=en.participant_id AND pa.status='active'
      WHERE en.event_id=? AND en.status<>'cancelled' AND en.registered_at<=?`,event.id,until)).filter(included);
    const ids=new Set(roster.map(p=>p.participant_id));
    const responses=(await all(`SELECT r.*,s.stage,v.schema_json,v.version FROM responses r JOIN event_surveys s ON s.id=r.event_survey_id
      JOIN survey_versions v ON v.id=r.version_id WHERE s.event_id=? AND r.effective=1 AND r.submitted_at<=? AND s.stage IN ('T0','T1B',?)`,event.id,until,stage)).filter(r=>ids.has(r.participant_id));
    const byStage=(name:string)=>new Map(responses.filter(r=>r.stage===name&&(name==='T0'||r.submitted_at>=since)).map(r=>[r.participant_id,r]));
    const pre=byStage('T0'), post=byStage(stage), after=byStage('T1B');
    const changes=deltaByProgram[p.code]??={delta:[],kept:[],lost:[]};
    let baselines=0,pairs=0,present=0,answeredAfter=0;
    for (const entry of roster) {
      const person=entry.participant_id;
      people.add(person);
      if (entry.attended_at && entry.attended_at<=until) { present++; if (after.has(person)) answeredAfter++; }
      if (post.has(person)) followResponses++;
      const start=pre.get(person), end=post.get(person);
      const a=start ? JSON.parse(start.answers_json)[p.metric] : null;
      const b=end ? JSON.parse(end.answers_json)[p.metric] : null;
      if (!Number.isInteger(a)) {
        if (end) missing++;
        continue;
      }
      baselines++;
      const definition=(r:any)=>{
        const q=r&&JSON.parse(r.schema_json).find(question=>question.key===p.metric);
        return q?.metricVersion ? q.metricVersion+':'+q.unit : null;
      };
      if (end && (!definition(start)||definition(start)!==definition(end))) { incomparable++; changes.lost.push(a); continue; }
      if (!Number.isInteger(b)) { missing++; changes.lost.push(a); continue; }
      pairs++;
      changes.delta.push(b-a);
      changes.kept.push(a);
      if (p.code==='VGR' && a===21) { maxCount++; if (b===21) maintain++; }
    }
    for (const job of await all('SELECT j.* FROM jobs j JOIN event_surveys s ON s.id=j.survey_id WHERE s.event_id=? AND j.created_at<=?',event.id,until)) {
      for (const target of await all(`SELECT r.participant_id, MIN(a.accepted_at) AS accepted
        FROM recipients r LEFT JOIN attempts a ON a.recipient_id=r.id AND a.status IN ('accepted','delivered') AND a.accepted_at BETWEEN ? AND ?
        WHERE r.job_id=? GROUP BY r.id`,since,until,job.id)) {
        const participant=canonical.get(target.participant_id)??target.participant_id;
        if (!ids.has(participant)) continue;
        const unique=job.survey_id+':'+participant;
        const saved=crossRecipients.get(unique)??{accepted:null,replied:false};
        if (target.accepted && (!saved.accepted||target.accepted<saved.accepted)) saved.accepted=target.accepted;
        if (target.accepted) {
          const survey=await getSurvey(job.survey_id);
          const answer=await one('SELECT submitted_at FROM responses WHERE event_survey_id=? AND participant_id=? AND effective=1',job.survey_id,participant);
          if (answer && answer.submitted_at>=target.accepted && answer.submitted_at<=until && answer.submitted_at<windowFor(survey,await enrollment(event.id,participant)).closes_at) saved.replied=true;
        }
        crossRecipients.set(unique,saved);
      }
    }
    registered+=roster.length; attendance+=present; t1+=answeredAfter; t0+=baselines; matched+=pairs;
    return {id:event.id,title:event.title,program:p.code,registered:roster.length,attendance:present,
      after:rate(answeredAfter,present),paired:rate(pairs,baselines),
      versions:await all(`SELECT s.stage,v.version,s.closes_at FROM event_surveys s JOIN survey_versions v ON v.id=s.version_id WHERE s.event_id=? AND s.stage IN ('T0','T1B',?)`,event.id,stage)};
  }));
  const cross=[...crossRecipients.values()];
  const accepted=cross.filter(r=>r.accepted).length;
  const outcomes=Object.entries(deltaByProgram).map(([code,row]:[string,any])=>{
    const values=row.delta as number[];
    const definition=PROGRAMS.find(p=>p.code===code)!;
    const detail=values.length>=minimum;
    return {code,unit:definition.unit,key:definition.metric,sample:values.length,minimum,
      mean:detail?mean(values):null,median:detail?median(values):null,
      directions:detail?[values.filter(v=>v>0).length,values.filter(v=>v===0).length,values.filter(v=>v<0).length]:null,
      distribution:detail?Object.fromEntries([...new Set(values)].sort((a,b)=>a-b).map(v=>[v,values.filter(a=>a===v).length])):null,
      pairedBaseline:row.kept.length>=minimum?mean(row.kept):null,
      lostBaseline:row.lost.length>=minimum?mean(row.lost):null};
  });
  return {calculationVersion:'1.0.0',kind:'問卷自陳',cutoff:until,filters:{...filters,stage},registered,unique:people.size,
    attendance,followResponses,missing,incomparable,lost:t0-matched,
    recovery:rate(cross.filter(r=>r.replied).length,accepted),acceptance:rate(accepted,cross.length),
    after:rate(t1,attendance),paired:rate(matched,t0),maintenance:rate(maintain,maxCount),eventRows,outcomes};
}
