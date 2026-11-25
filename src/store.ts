import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { all, exec, one, run, tx } from './database.ts';
export { all, one, run, tx } from './database.ts';
import { DAY, NOTICE, NOTICE_TEXT, PROGRAMS, STAGES, FOLLOW, iso, plannedWindow, questions, demand } from './domain.ts';

export const demo = process.env.SIMP_DEMO !== '0';
const secret = process.env.SIMP_SECRET || (demo ? 'SIMP local demo key, never use with real data' : '');
if (secret.length < 32) throw new Error('SIMP_SECRET must be at least 32 characters.');
if (!demo&&(!NOTICE||!NOTICE_TEXT)) throw new Error('Production requires SIMP_NOTICE_VERSION and SIMP_NOTICE_TEXT.');
const key = createHash('sha256').update(secret).digest();
export const id = randomUUID;
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const lookup = (value: string) => createHmac('sha256', key).update(value).digest('hex');

export function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const content = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),content].map(part=>part.toString('base64url')).join('.');
}
export function open(value: string) {
  const [iv,tag,content] = value.split('.').map(part=>Buffer.from(part,'base64url'));
  const cipher = createDecipheriv('aes-256-gcm',key,iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(content),cipher.final()]).toString('utf8');
}

await exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);');

const folder=new URL('../migrations/', import.meta.url);
for (const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) {
  await tx(async ()=> {
    if (await one('SELECT name FROM migrations WHERE name=?',file)) return;
    await exec(readFileSync(new URL(file,folder),'utf8'));
    await run('INSERT INTO migrations VALUES (?)',file);
  });
}

export async function audit(actor:string, action:string, target:string, details:any = {}, requestId:string | null=null) {
  await run('INSERT INTO audit(created_at,actor,action,target,details,request_id) VALUES (?,?,?,?,?,?)',iso(),actor,action,target,JSON.stringify(details),requestId);
}
export async function createParticipant() {
  const person=id();
  await run('INSERT INTO participants(id,created_at) VALUES (?,?)',person,iso());
  await run('INSERT INTO profiles(participant_id) VALUES (?)',person);
  return person;
}
export async function bind(person:string, kind:string, issuer:string, value:string, mask:string) {
  await run('INSERT INTO identities(id,participant_id,kind,issuer,lookup,encrypted,mask,verified_at) VALUES (?,?,?,?,?,?,?,?)',
    id(),person,kind,issuer,lookup(value),seal(value),mask,iso());
}
export function phoneMask(phone:string) { return phone.slice(0,4)+' •••• '+phone.slice(-3); }
export async function consent(person:string, purpose:string, scope:string) {
  const last=await one('SELECT choice,notice_version FROM consents WHERE participant_id=? AND purpose=? AND scope=? ORDER BY seq DESC LIMIT 1',person,purpose,scope);
  return last?.choice===1 && (purpose!=='privacy'||last.notice_version===NOTICE);
}
export async function enrollment(eventId:string, person:string) {
  return await one('SELECT * FROM enrollments WHERE event_id=? AND participant_id=?',eventId,person);
}
export async function getEvent(eventId:string) {
  const event=await one('SELECT * FROM events WHERE id=?',eventId);
  demand(event,404,'EVENT_NOT_FOUND','找不到這個場次。');
  return event;
}
export async function getSurvey(surveyId:string) {
  const survey=await one(`SELECT s.*,v.schema_json,v.version,e.program,e.title,e.status AS event_status,e.org_id,e.timezone,e.anchor_type
    FROM event_surveys s JOIN survey_versions v ON v.id=s.version_id JOIN events e ON e.id=s.event_id WHERE s.id=?`,surveyId);
  demand(survey,404,'SURVEY_NOT_FOUND','找不到這份問卷。');
  return survey;
}
import { localDays } from './domain.ts';
export function windowFor(survey:any, registration:any) {
  if (survey.window_rule==='rolling' && registration?.anchor_at && FOLLOW.includes(survey.stage)) {
    const days={F30:30,T2:90,T3:180}[survey.stage];
    const windowDays=Math.round((Date.parse(survey.closes_at)-Date.parse(survey.opens_at))/DAY);
    return { opens_at:localDays(registration.anchor_at,survey.timezone,days), closes_at:localDays(registration.anchor_at,survey.timezone,days+windowDays) };
  }
  return {opens_at:survey.opens_at,closes_at:survey.closes_at};
}

export async function eligibility(survey:any, person:string, now=iso(), notification=false, checkTime=true) {
  if (!['published','completed'].includes(survey.event_status)) return '場次已關閉';
  const registration = await enrollment(survey.event_id,person);
  if (!registration || registration.status==='cancelled') return '未報名或已取消';
  if (['T1A','T1B',...FOLLOW].includes(survey.stage) && registration.status!=='attended'
      && !(survey.program==='VEG' && survey.stage!=='T1A')) return '未完成簽到';
  if (!await consent(person,'privacy','*')) return '尚未確認個資告知';
  if (FOLLOW.includes(survey.stage) && !await consent(person,'tracking',survey.program)) return '未同意後續追蹤';
  if (notification && !(await one('SELECT line_reachable FROM profiles WHERE participant_id=?',person))?.line_reachable) return 'LINE OA 無法觸達';
  if (checkTime) {
    const {opens_at,closes_at}=windowFor(survey,registration);
    if (now<opens_at) return '問卷未開放';
    if (now>=closes_at) return '問卷已截止';
  }
  return null;
}

await tx(async ()=>{
  const mode=demo?'demo':'service';
  const current=(await one("SELECT value FROM app_settings WHERE key='mode'"))?.value;
  if (current && current!==mode) throw new Error('The database must match the configured Demo or Service mode.');
  if (!current && !demo && await one("SELECT id FROM staff WHERE id='operator'")) throw new Error('Do not reuse a Demo database for service mode.');
  await run("INSERT OR IGNORE INTO app_settings VALUES ('mode',?)",mode);
  for (const p of PROGRAMS) {
    await run('INSERT OR IGNORE INTO programs VALUES (?,?,?,?,?)',p.code,p.title,p.summary,p.metric,p.unit);
    for (const stage of Object.keys(STAGES)) {
      if (stage==='T1A' && p.code==='VEG') continue;
      await run('INSERT OR IGNORE INTO survey_versions VALUES (?,?,?,?,?,?,?,?)',
        p.code+'-'+stage+'-1',p.code,stage,1,'published',JSON.stringify(questions(p.code,stage)),iso(),iso());
    }
  }
  for (const [key,parent,kind,label] of [
    ['north6',null,'district','北市北第六區'],['north3',null,'district','北市北第三區'],
    ['prajna','north6','chapter','般若分會'],['mind','north6','chapter','慧心分會'],
    ['bright','north3','chapter','光明分會']
  ]) await run('INSERT OR IGNORE INTO org_units VALUES (?,?,?,?)',key,parent,kind,label);
  if (demo && !await one('SELECT id FROM staff LIMIT 1')) await seedDemo();
});

if (process.env.TURSO_DATABASE_URL) console.log('SIA database ready', {
  host:new URL(process.env.TURSO_DATABASE_URL).hostname,
  migrations:(await one('SELECT COUNT(*) AS n FROM migrations')).n,
  tables:(await one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).n
});

async function seedDemo() {
  const staff=[
    ['operator','活動營運','operator',null], ['north6-ops','北市北第六區承辦','operator','north6'],
    ['north3-ops','北市北第三區承辦','operator','north3'], ['reviewer','身分審核','identity',null],
    ['reviewer2','身分複核','identity',null], ['north3-analyst','北市北第三區分析','analyst','north3'],
    ['analyst','影響力分析','analyst',null], ['publisher','審校發布','publisher',null], ['admin','系統管理員','admin',null]
  ];
  for (const row of staff) await run('INSERT INTO staff(id,label,role,org_id) VALUES (?,?,?,?)',...row);
  const sampleEvents = [
    ['vegrun','VGR','VEGRUN 台北場｜成美左岸','臺北市','成美左岸河濱公園','prajna',7,'published'],
    ['earth','EARTH','森林覺醒｜步雲逵踏查','宜蘭縣','佛光大學步雲逵步道','bright',12,'published'],
    ['veg','VEG','綠・蔬食評鑑指南｜臺北探索','臺北市','臺北蔬食門市','prajna',6,'published'],
    ['vegrun-follow','VGR','VEGRUN 北區場｜90 天追蹤','臺北市','大佳河濱公園','prajna',-92,'completed'],
    ['earth-follow','EARTH','森林覺醒｜90 天追蹤','宜蘭縣','佛光大學步雲逵步道','bright',-91,'completed'],
    ['veg-follow','VEG','蔬食指南｜90 天追蹤','臺北市','臺北蔬食門市','prajna',-91,'completed']
  ];
  for (const [slug,program,title,region,venue,org,shift,status] of sampleEvents) {
    const event={starts_at:iso(Number(shift)*DAY-3*3600000),ends_at:iso(Number(shift)*DAY),timezone:'Asia/Taipei'};
    await run('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',slug,program,title,region,venue,org,
      event.starts_at,event.ends_at,event.timezone,iso(Number(shift)*DAY-21*DAY),event.starts_at,status,'event_end',iso());
    for (const stage of Object.keys(STAGES)) {
      if (stage==='T1A' && program==='VEG') continue;
      const [opens,closes]=plannedWindow(event,stage);
      await run('INSERT INTO event_surveys VALUES (?,?,?,?,?,?,?)',slug+'-'+stage,slug,stage,program+'-'+stage+'-1',opens,closes,'fixed');
    }
  }
  const people=[];
  for (let n=1;n<=12;n++) {
    const person=await createParticipant();
    people.push(person);
    const phone='+886900000'+String(n).padStart(3,'0');
    await bind(person,'phone','e164',phone,phoneMask(phone));
    await bind(person,'line','demo',String(n),'LINE 示範帳號');
    const card='DEMO'+String(n).padStart(4,'0');
    await run('UPDATE profiles SET name=?,region=?,district_id=?,chapter_id=?,member_status=?,card_lookup=?,card_encrypted=?,card_mask=?,line_reachable=1 WHERE participant_id=?',
      '示範參與者 '+String(n).padStart(2,'0'),n%2?'臺北市':'宜蘭縣','north6','prajna',n===2?'verified':n===3?'pending':'nonmember',
      n===2||n===3?lookup(card):null,n===2||n===3?seal(card):null,n===2||n===3?'••••'+card.slice(-4):null,person);
    for (const [purpose,scope,value] of [['privacy','*',1],...PROGRAMS.map(x=>['tracking',x.code,1]),['marketing','*',0]]) {
      await run('INSERT INTO consents(participant_id,purpose,scope,notice_version,choice,created_at,source) VALUES (?,?,?,?,?,?,?)',
        person,purpose,scope,NOTICE,value,iso(),'seed');
    }
  }
  for (const [slug,program] of sampleEvents.filter(row=>String(row[0]).endsWith('-follow'))) {
    const metric=PROGRAMS.find(p=>p.code===program)!.metric;
    const count=slug==='vegrun-follow'?12:8;
    for (let n=0;n<count;n++) {
      const person=people[n];
      await run('INSERT INTO enrollments VALUES (?,?,?,?,?,?)',slug,person,'attended',iso(-104*DAY),iso(-93*DAY),iso(-93*DAY));
      if (n<8) await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at) VALUES (?,?,?,?,?,?)',
        id(),slug+'-T0',person,program+'-T0-1',JSON.stringify({[metric]:n===7?21:n}),iso(-96*DAY));
      if (n<7) await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at) VALUES (?,?,?,?,?,?)',
        id(),slug+'-T1B',person,program+'-T1B-1',JSON.stringify({awareness:'略有了解',action_intent:'願意'}),plannedWindow(await getEvent(String(slug)),'T1B')[0]);
      if ([4,5,6,9].includes(n) && n<count) await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at) VALUES (?,?,?,?,?,?)',
        id(),slug+'-T2',person,program+'-T2-1',JSON.stringify({[metric]:n===5?4:n+3}),iso(-3600000));
    }
  }
  const preview=id(), job=id(), sample='vegrun-follow-T2';
  await run('INSERT INTO previews VALUES (?,?,?,?,?,?)',preview,sample,'operator','{}',iso(-DAY),iso());
  await run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)',job,preview,sample,'operator','completed',iso(-DAY),iso(-DAY),null);
  for (const person of people.slice(0,10)) {
    const recipient=id();
    await run('INSERT INTO recipients VALUES (?,?,?)',recipient,job,person);
    await run('INSERT INTO attempts(id,recipient_id,number,due_at,status,queued_at,accepted_at,provider_ref) VALUES (?,?,1,?,?,?,?,?)',
      id(),recipient,iso(-DAY),'accepted',iso(-DAY),iso(-DAY),'demo-seed');
  }
  await run('INSERT INTO evidence(id,event_id,title,source,recorded_at,version,note,status,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id(),'vegrun-follow','北區場簽到彙整','場次簽到',iso(-92*DAY),'1','合成驗收用紀錄。','approved',iso(),'operator');
  await run('UPDATE profiles SET residence_city_id=(SELECT id FROM residence_cities WHERE name=profiles.region) WHERE residence_city_id IS NULL');
}
