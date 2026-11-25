import { filterAsync } from './async.ts';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { extname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DAY, FOLLOW, NOTICE, NOTICE_TEXT, PROGRAMS, STAGES, Problem, date, demand, iso, normalizeCard, normalizePhone, plannedWindow, validAnswers } from './domain.ts';
import { all, audit, bind, consent, createParticipant, demo, digest, eligibility, enrollment, getEvent, getSurvey, id, lookup, one, open, phoneMask, run, seal, token, tx, windowFor, nextSurveyVersion } from './store.ts';
import { audience, cancelJob, enqueue, inOrg, jobStats, processQueue, provider, recordConsent, report, scope, tlsOrigin } from './operations.ts';
import { residenceLocations, resolveResidence, saveResidenceLocation } from './residence.ts';
import { STAFF_ROLES, staffAccessList, saveStaffAccess } from './staff-access.ts';
import { ASSESSMENT_STAGES, assessmentQuestions, COLLECTION_TIMELINE } from './assessment.ts';

const requestContext = new AsyncLocalStorage<string>();
const PARTICIPANT='simp_person', STAFF='simp_staff', LINE='simp_line', LINE_STATE='simp_line_state';
const staffRoles=Object.keys(STAFF_ROLES);
const navRole=(route:string,who:any)=>who.role==='admin'||route.split('|').includes(who.role);
const COOKIE_MAX=12*3600;
function cookies(req:IncomingMessage) {
  return Object.fromEntries((req.headers.cookie??'').split(';').map(s=>s.trim().split(/=(.*)/s,2)).filter(pair=>pair.length===2));
}
function setCookie(res:ServerResponse, name:string, value:string, seconds:number) {
  const previous=res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie',[...(Array.isArray(previous)?previous:[]),name+'='+value+'; Path=/; Max-Age='+seconds+'; HttpOnly; SameSite=Lax'+(tlsOrigin||process.env.VERCEL?'; Secure':'')]);
}
async function session(req:IncomingMessage, key:string) {
  return await one(`SELECT s.*,u.role,u.label,u.org_id,u.active AS staff_active FROM sessions s LEFT JOIN staff u ON u.id=s.staff_id
    LEFT JOIN participants p ON p.id=s.participant_id WHERE token_hash=? AND expires_at>? AND (p.id IS NULL OR p.status='active')`,
    digest(cookies(req)[key]??''),iso());
}
async function attachSession(res:ServerResponse, key:string, who:string) {
  const value=token();
  await run('INSERT INTO sessions VALUES (?,?,?,?,?)',digest(value),key===PARTICIPANT?who:null,key===STAFF?who:null,iso(COOKIE_MAX*1000),iso());
  setCookie(res,key,value,COOKIE_MAX);
}
async function auditReq(actor:string, action:string, target:string, details:any={}) { await audit(actor,action,target,details,requestContext.getStore()); }
async function person(req:IncomingMessage) {
  const auth=await session(req,PARTICIPANT);
  demand(auth?.participant_id,401,'LOGIN_REQUIRED','請先登入。');
  return auth.participant_id as string;
}
async function staff(req:IncomingMessage, roles=staffRoles.join('|')) {
  const auth=await session(req,STAFF);
  demand(auth?.staff_id&&auth.staff_active===1,401,'STAFF_LOGIN_REQUIRED','請先登入管理後台，或洽系統管理員確認帳號狀態。');
  demand(navRole(roles,auth),403,'ROLE_FORBIDDEN','您的角色沒有此操作權限。');
  return auth;
}
async function profile(personId:string) {
  const data=await one(`SELECT p.participant_id,p.name,p.member_status,p.region,p.district_id,p.chapter_id,p.card_mask,p.review_reason,p.photo_id,p.line_reachable,
    p.residence_city_id,p.residence_district_id,c.name AS residence_city,d.name AS residence_district
    FROM profiles p LEFT JOIN residence_cities c ON c.id=p.residence_city_id
    LEFT JOIN residence_districts d ON d.id=p.residence_district_id WHERE participant_id=?`,personId);
  const identities=await all('SELECT kind,mask,verified_at FROM identities WHERE participant_id=? AND revoked_at IS NULL',personId);
  const flags={privacy:await consent(personId,'privacy','*'),marketing:await consent(personId,'marketing','*'),
    tracking:Object.fromEntries(await Promise.all(PROGRAMS.map(async p=>[p.code,await consent(personId,'tracking',p.code)])))};
  return {...data,identities,consents:flags,noticeVersion:NOTICE};
}
async function bytes(req:IncomingMessage, limit:number) {
  const length=Number(req.headers['content-length']??0);
  demand(length<=limit,413,'TOO_LARGE','檔案或輸入內容超出大小限制。');
  let total=0;
  const chunks:Buffer[]=[];
  for await (const chunk of req) {
    total+=chunk.length;
    demand(total<=limit,413,'TOO_LARGE','檔案或輸入內容超出大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req:IncomingMessage) {
  demand((req.headers['content-type']??'').split(';')[0]==='application/json',415,'CONTENT_TYPE','請使用 JSON 請求。');
  try {
    const data=JSON.parse((await bytes(req,768000)).toString());
    demand(data && typeof data==='object' && !Array.isArray(data),422,'INVALID_JSON','請提供 JSON 物件。');
    return data;
  } catch(error) {
    if (error instanceof Problem) throw error;
    throw new Problem(400,'INVALID_JSON','JSON 格式無效。');
  }
}
function page(rows:any[], url:URL, key='id') {
  const cursor=url.searchParams.get('cursor');
  const index=cursor?rows.findIndex(row=>String(row[key])===cursor):-1;
  demand(!cursor || index>=0,400,'CURSOR','分頁游標已失效，請重新搜尋。');
  const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')??50)||50));
  const result=rows.slice(index+1,index+1+limit);
  return {items:result,nextCursor:index+1+limit<rows.length?String(result.at(-1)[key]):null,total:rows.length};
}
function clean(value:any, max=160) { return typeof value==='string'?value.trim().slice(0,max):''; }
async function throttle(bucket:string, maximum:number, duration:number) {
  const current=await one('SELECT * FROM throttles WHERE bucket=? AND expires_at>?',bucket,iso());
  demand(!current||current.times<maximum,429,'RATE_LIMIT','操作過於頻繁，請稍後再試。');
  await run(`INSERT INTO throttles VALUES (?,?,?) ON CONFLICT(bucket) DO UPDATE SET times=excluded.times, expires_at=excluded.expires_at`,
    bucket,(current?.times??0)+1,current?.expires_at??iso(duration));
}
function redirect(res:ServerResponse, target:string) { res.writeHead(303,{Location:target});res.end(); }
function assetResponse(res:ServerResponse, asset:any) {
  res.writeHead(200,{'Content-Type':asset.mime,'Cache-Control':'private, no-store','Content-Length':asset.content.length,
    ...(asset.purpose==='evidence'?{'Content-Disposition':'attachment; filename="evidence"'}:{})});
  res.end(asset.content);
}

async function attemptLink(owner:string, issuer:string, subject:string, reachable=false) {
  const other=await one("SELECT participant_id FROM identities WHERE kind='line' AND issuer=? AND lookup=? AND revoked_at IS NULL",issuer,lookup(subject));
  const mine=await one("SELECT lookup FROM identities WHERE kind='line' AND participant_id=? AND issuer=? AND revoked_at IS NULL",owner,issuer);
  if ((other && other.participant_id!==owner) || (mine && mine.lookup!==lookup(subject))) {
    let caseId=(await one(`SELECT id FROM identity_cases WHERE kind='line_conflict' AND participant_id=? AND COALESCE(other_id,'')=? AND status='pending'`,owner,other?.participant_id??''))?.id;
    if (!caseId) {
      caseId=id();
      await run("INSERT INTO identity_cases(id,kind,participant_id,other_id,reason,created_at) VALUES (?,'line_conflict',?,?,?,?)",
        caseId,owner,other?.participant_id??null,'LINE 身分與現有綁定衝突',iso());
      await auditReq(owner,'identity.conflict',caseId);
    }
    return {status:'conflict',caseId};
  }
  if (!mine) {
    await bind(owner,'line',issuer,subject,'LINE 已連結');
    await auditReq(owner,'identity.line.link',owner);
  }
  if (demo||reachable) await run('UPDATE profiles SET line_reachable=1 WHERE participant_id=?',owner);
  return {status:'linked'};
}

async function auth(req:IncomingMessage,res:ServerResponse,path:string,method:string,url:URL) {
  if (path==='/auth/otp/request' && method==='POST') {
    const input=await json(req), phone=normalizePhone(input.phone), hash=lookup(phone);
    const purpose=input.purpose==='change'?'change':'login';
    const owner=purpose==='change'?await person(req):null;
    if (owner) demand((await session(req,PARTICIPANT)).verified_at>=iso(-10*60000),403,'REAUTH','請先用原手機重新登入，再變更門號。');
    const challenge=id(), code=demo?'246810':String(randomInt(0,1000000)).padStart(6,'0');
    await tx(async ()=>{
      await throttle('sms:ip:'+lookup(req.socket.remoteAddress??''),30,3600000);
      await throttle('sms:phone:'+hash,5,15*60000);
      await run('UPDATE challenges SET used_at=? WHERE lookup=? AND purpose=? AND COALESCE(owner_id,\'\')=? AND used_at IS NULL',iso(),hash,purpose,owner??'');
      await run('INSERT INTO challenges VALUES (?,?,?,?,?,?,?,NULL,0,?,?)',challenge,hash,seal(phone),phoneMask(phone),lookup(challenge+code),iso(),iso(5*60000),purpose,owner);
    });
    if (!demo) {
      try {
        const result=await provider('otp/send',{phone,code,expiresSeconds:300,challenge});
        if (result.status!=='accepted') throw Error('SMS delivery rejected');
      } catch {
        await run('UPDATE challenges SET used_at=? WHERE id=?',iso(),challenge);
        throw new Problem(503,'SMS_UNAVAILABLE','驗證碼暫時無法發送，請稍後再試。');
      }
    }
    return {challengeId:challenge,expiresIn:300,...(demo?{demoCode:code}:{})};
  }
  if (path==='/auth/otp/verify' && method==='POST') {
    const input=await json(req);
    await tx(async ()=>await throttle('verify:ip:'+lookup(req.socket.remoteAddress??''),60,15*60000));
    const result=await tx(async ()=>{
      const challenge=await one('SELECT * FROM challenges WHERE id=?',clean(input.challengeId));
      demand(challenge && !challenge.used_at && challenge.expires_at>iso() && challenge.tries<5,422,'OTP_EXPIRED','驗證碼已失效，請重新取得。');
      await run('UPDATE challenges SET tries=tries+1 WHERE id=?',challenge.id);
      if (challenge.proof!==lookup(challenge.id+clean(input.code,10))) return {error:'OTP_INVALID'};
      await run('UPDATE challenges SET used_at=? WHERE id=?',iso(),challenge.id);
      const existing=await one("SELECT participant_id FROM identities WHERE kind='phone' AND issuer='e164' AND lookup=? AND revoked_at IS NULL",challenge.lookup);
      if (challenge.purpose==='change') {
        const owner=await person(req);
        demand(owner===challenge.owner_id&&(await session(req,PARTICIPANT)).verified_at>=iso(-10*60000),403,'REAUTH','請以原手機重新登入。');
        if (existing?.participant_id && existing.participant_id!==owner) {
          const caseId=id();
          await run("INSERT INTO identity_cases(id,kind,participant_id,other_id,reason,created_at) VALUES (?,'phone_conflict',?,?,?,?)",
            caseId,owner,existing.participant_id,'新手機門號已被使用',iso());
          await auditReq(owner,'identity.conflict',caseId);
          return {error:'LINK_REQUIRED',caseId};
        }
        await run("UPDATE identities SET revoked_at=? WHERE participant_id=? AND kind='phone' AND revoked_at IS NULL",iso(),owner);
        await bind(owner,'phone','e164',open(challenge.encrypted),challenge.mask);
        await run('DELETE FROM sessions WHERE participant_id=?',owner);
        await auditReq(owner,'identity.phone.change',owner);
        return {owner};
      }
      const pending=await one('SELECT * FROM pending_line WHERE token_hash=? AND used_at IS NULL AND expires_at>?',digest(cookies(req)[LINE]??''),iso());
      if (existing && pending && (await session(req,PARTICIPANT))?.participant_id!==existing.participant_id) {
        await run('UPDATE pending_line SET used_at=? WHERE token_hash=?',iso(),pending.token_hash);
        return {error:'LINK_REQUIRED'};
      }
      const owner=existing?.participant_id??await createParticipant();
      if (!existing) await bind(owner,'phone','e164',open(challenge.encrypted),challenge.mask);
      if (pending) {
        await run('UPDATE pending_line SET used_at=? WHERE token_hash=?',iso(),pending.token_hash);
        const link=await attemptLink(owner,pending.issuer,open(pending.subject_encrypted),pending.reachable===1);
        if (link.status==='conflict') return {owner,caseId:link.caseId};
      }
      await auditReq(owner,'auth.otp.login',owner);
      return {owner};
    });
    if (result.error==='OTP_INVALID') throw new Problem(422,'OTP_INVALID','驗證碼不正確，請再試一次。');
    if (result.error==='LINK_REQUIRED') {
      setCookie(res,LINE,'',0);
      throw new Problem(409,'LINK_REQUIRED',result.caseId?'新門號已被使用，已交由人工核驗。':'請先用已驗證手機登入，再從個人資料連結 LINE。');
    }
    if (cookies(req)[PARTICIPANT]) await run('DELETE FROM sessions WHERE token_hash=?',digest(cookies(req)[PARTICIPANT]));
    await attachSession(res,PARTICIPANT,result.owner!);
    setCookie(res,LINE,'',0);
    return {...await profile(result.owner!),caseId:result.caseId};
  }
  if (path==='/auth/line/start' && method==='GET') {
    const state=token(), auth=await session(req,PARTICIPANT), expires=iso(10*60000);
    const back=new URLSearchParams();
    for (const name of ['invite','survey','event']) {
      const value=url.searchParams.get(name);
      if (value&&/^[A-Za-z0-9_-]{1,150}$/.test(value)) back.set(name,value);
    }
    await run('INSERT INTO oauth_states(state_hash,kind,owner_id,expires_at,return_query) VALUES (?,?,?,?,?)',digest(state),'line',auth?.participant_id??null,expires,back.toString());
    setCookie(res,LINE_STATE,state,600);
    if (demo) return {mode:'demo',state};
    const result=await provider('line/start',{state,callback:tlsOrigin+'/api/v1/auth/line/callback'});
    demand(typeof result.url==='string' && result.url.startsWith('https://'),502,'LINE_UNAVAILABLE','LINE 登入暫時無法使用。');
    return {mode:'redirect',url:result.url};
  }
  if (path==='/auth/line/callback' && ['GET','POST'].includes(method)) {
    demand(demo?method==='POST':method==='GET',405,'LINE_METHOD','登入回呼方式不符。');
    const input=demo?await json(req):Object.fromEntries(url.searchParams);
    const state=await one('SELECT * FROM oauth_states WHERE state_hash=? AND used_at IS NULL AND expires_at>?',digest(clean(input.state)),iso());
    demand(state?.kind==='line' && cookies(req)[LINE_STATE]===input.state,422,'LINE_STATE','LINE 登入已逾時或瀏覽器工作階段不符。');
    const result=demo?{issuer:'demo',subject:clean(input.subject,100)}:await provider('line/exchange',{code:clean(input.code,400),state:input.state,callback:tlsOrigin+'/api/v1/auth/line/callback'});
    demand(clean(result.subject,255) && clean(result.issuer,255),422,'LINE_IDENTITY','找不到可驗證的 LINE 身分。');
    const issuer=clean(result.issuer,255), subject=clean(result.subject,255), reachable=result.oaReachable===true;
    const outcome=await tx(async ()=>{
      const update=await run('UPDATE oauth_states SET used_at=? WHERE state_hash=? AND used_at IS NULL',iso(),state.state_hash);
      demand(update.changes===1,409,'LINE_STATE','LINE 驗證已使用。');
      if (state.owner_id) {
        demand(await person(req)===state.owner_id,403,'LINE_OWNER','LINE 綁定工作階段不符。');
        return await attemptLink(state.owner_id,issuer,subject,reachable);
      }
      const current=await one(`SELECT l.participant_id FROM identities l JOIN identities p ON p.participant_id=l.participant_id
        JOIN participants a ON a.id=l.participant_id WHERE l.kind='line' AND l.issuer=? AND l.lookup=?
        AND l.revoked_at IS NULL AND p.kind='phone' AND p.revoked_at IS NULL AND a.status='active'`,issuer,lookup(subject));
      if (current) {
        if (cookies(req)[PARTICIPANT]) await run('DELETE FROM sessions WHERE token_hash=?',digest(cookies(req)[PARTICIPANT]));
        await attachSession(res,PARTICIPANT,current.participant_id);
        if (typeof result.oaReachable==='boolean') await run('UPDATE profiles SET line_reachable=? WHERE participant_id=?',Number(reachable),current.participant_id);
        await auditReq(current.participant_id,'auth.line.login',current.participant_id);
        return {status:'signed_in'};
      }
      const pending=token();
      await run('INSERT INTO pending_line(token_hash,issuer,subject_encrypted,expires_at,reachable) VALUES (?,?,?,?,?)',digest(pending),issuer,seal(subject),iso(10*60000),Number(reachable));
      setCookie(res,LINE,pending,600);
      return {status:'phone_required'};
    });
    setCookie(res,LINE_STATE,'',0);
    if (!demo) {
      const back=new URLSearchParams(state.return_query);
      back.set('line',outcome.status);
      return redirect(res,'/?'+back.toString()+'#profile');
    }
    return outcome;
  }
  if (path==='/auth/admin/accounts'&&method==='GET') {
    demand(demo,404,'NOT_FOUND','找不到介面。');
    return {items:await all('SELECT id,label,role FROM staff WHERE active=1 ORDER BY id')};
  }
  if (path==='/auth/admin/login' && method==='POST') {
    const input=await json(req);
    await tx(async ()=>await throttle('staff:ip:'+lookup(req.socket.remoteAddress??''),40,15*60000));
    let who;
    if (demo) {
      who=await one('SELECT * FROM staff WHERE id=?',clean(input.account));
    } else {
      const verified=await provider('staff/verify',{account:clean(input.account),password:clean(input.password,255),mfa:clean(input.mfa,20)});
      demand(verified.mfa_verified===true && staffRoles.includes(verified.role) && clean(verified.id,100),401,'STAFF_DENIED','帳號或多因子驗證無效。');
      const staffId=clean(verified.id,100);
      const org=clean(verified.org,50)||null;
      demand(!org||await one('SELECT id FROM org_units WHERE id=?',org),403,'ORG_FORBIDDEN','授權組織無效。');
      demand(verified.role!=='admin'||!org,403,'ADMIN_SCOPE','系統管理員須具備全平台管理範圍。');
      await run(`INSERT INTO staff(id,label,role,org_id) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        label=CASE WHEN staff.access_managed=1 THEN staff.label ELSE excluded.label END,
        role=CASE WHEN staff.access_managed=1 THEN staff.role ELSE excluded.role END,
        org_id=CASE WHEN staff.access_managed=1 THEN staff.org_id ELSE excluded.org_id END`,
        staffId,clean(verified.label)||staffId,verified.role,org);
      who=await one('SELECT * FROM staff WHERE id=?',staffId);
    }
    demand(who&&who.active===1,401,'STAFF_DENIED','帳號不存在或已停用，請洽系統管理員。');
    if (cookies(req)[STAFF]) await run('DELETE FROM sessions WHERE token_hash=?',digest(cookies(req)[STAFF]));
    await attachSession(res,STAFF,who.id);
    await auditReq(who.id,'auth.staff.login',who.id);
    return {id:who.id,role:who.role,label:who.label,org:who.org_id};
  }
  if (['/auth/logout','/auth/admin/logout'].includes(path) && method==='POST') {
    const key=path.includes('admin')?STAFF:PARTICIPANT;
    await run('DELETE FROM sessions WHERE token_hash=?',digest(cookies(req)[key]??''));
    setCookie(res,key,'',0);
    if (key===PARTICIPANT) {setCookie(res,LINE,'',0);setCookie(res,LINE_STATE,'',0);}
    return {ok:true};
  }
  throw new Problem(404,'NOT_FOUND','找不到介面。');
}

async function upload(req:IncomingMessage, owner:string, purpose:'photo' | 'evidence') {
  const mime=(req.headers['content-type']??'').split(';')[0];
  const format:Record<string,'jpeg'|'png'|'webp'>={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
  const isPdf=purpose==='evidence'&&mime==='application/pdf';
  demand(format[mime]||isPdf,415,'FILE_FORMAT','請上傳 JPEG、PNG、WebP'+(purpose==='evidence'?' 或 PDF':'')+'。');
  let data=await bytes(req,5*1024*1024);
  if (isPdf) {
    demand(data.subarray(0,5).toString()==='%PDF-'&&data.subarray(-2048).includes(Buffer.from('%%EOF')),422,'FILE_FORMAT','PDF 檔案格式不正確。');
  } else {
    try {
      const image=sharp(data,{limitInputPixels:8000*8000,pages:1});
      const metadata=await image.metadata();
      demand(metadata.format===format[mime]&&metadata.width<=8000&&metadata.height<=8000,422,'FILE_IMAGE','圖片格式不符或尺寸超過限制。');
      const size=purpose==='photo'?1600:2400;
      data=await image.rotate().resize({width:size,height:size,fit:'inside',withoutEnlargement:true})
        .toFormat(format[mime]).timeout({seconds:5}).toBuffer();
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(422,'FILE_IMAGE','無法讀取圖片，請重新選擇有效的 JPEG、PNG 或 WebP 圖片。');
    }
  }
  demand(data.length<=5*1024*1024,413,'TOO_LARGE','檔案處理後仍超出大小限制。');
  const fileId=id();
  await tx(async ()=>{
    await run('INSERT INTO assets VALUES (?,?,?,?,?,?,?)',fileId,owner,purpose,mime,digest(data),data,iso());
    if (purpose==='photo') await run('UPDATE profiles SET photo_id=? WHERE participant_id=?',fileId,owner);
    await auditReq(owner,'asset.upload',fileId,{purpose});
  });
  return {id:fileId,mime,size:data.length};
}
async function integration(req:IncomingMessage,path:string,method:string) {
  demand(!demo&&path==='/integrations/line/reachability'&&method==='POST',404,'NOT_FOUND','找不到介面。');
  const expected=digest('Bearer '+process.env.SIMP_GATEWAY_KEY);
  demand(timingSafeEqual(Buffer.from(expected),Buffer.from(digest(req.headers.authorization??''))),401,'GATEWAY_FORBIDDEN','管道驗證失敗。');
  const input=await json(req), issuer=clean(input.issuer,255), subject=clean(input.subject,255);
  demand(issuer&&subject&&typeof input.reachable==='boolean',422,'REACHABILITY_FORMAT','請提供 LINE 身分與觸達狀態。');
  return await tx(async ()=>{
    const binding=await one("SELECT participant_id FROM identities WHERE kind='line' AND issuer=? AND lookup=? AND revoked_at IS NULL",issuer,lookup(subject));
    if (!binding) return {updated:false};
    await run('UPDATE profiles SET line_reachable=? WHERE participant_id=?',Number(input.reachable),binding.participant_id);
    await auditReq('line-gateway','integration.reachability',binding.participant_id,{reachable:input.reachable});
    return {updated:true};
  });
}
async function participant(req:IncomingMessage,res:ServerResponse,path:string,method:string,url:URL) {
  if (path==='/config' && method==='GET') return {demo,programs:PROGRAMS,stages:STAGES,assessmentTemplates:Object.fromEntries(ASSESSMENT_STAGES.map(stage=>[stage,assessmentQuestions(stage)])),collectionTimeline:COLLECTION_TIMELINE,noticeVersion:NOTICE,noticeText:NOTICE_TEXT,organizations:await all('SELECT * FROM org_units ORDER BY kind DESC,name'),residenceLocations:await residenceLocations()};
  if (path==='/events' && method==='GET') {
    const events=await all("SELECT * FROM events WHERE status IN ('published','completed') ORDER BY starts_at ASC,id");
    return page(events.filter(e=>!url.searchParams.has('program')||e.program===url.searchParams.get('program')),url);
  }
  if (path==='/me' && method==='GET') return await profile(await person(req));
  if (path==='/me/profile' && method==='PATCH') {
    const owner=await person(req), input=await json(req);
    const current=await one('SELECT * FROM profiles WHERE participant_id=?',owner);
    const member=input.member===true, district=clean(input.districtId)||null, chapter=clean(input.chapterId)||null;
    if (member) {
      demand(district&&chapter&&await one("SELECT id FROM org_units WHERE kind='chapter' AND id=? AND parent_id=?",chapter,district),422,'CHAPTER_INVALID','請選擇該督導區所屬的分會。');
    }
    const value=member&&clean(input.card)?normalizeCard(input.card):null;
    const cardLookup=member?(value?lookup(value):current.card_lookup):null;
    if (member) demand(cardLookup,422,'CARD_REQUIRED','請輸入佛光卡號。');
    const changed=member&&(cardLookup!==current.card_lookup||district!==current.district_id||chapter!==current.chapter_id);
    const status=member?(changed?'pending':current.member_status):'nonmember';
    await tx(async ()=>{
      const residence=await resolveResidence(input,current);
      await run('UPDATE profiles SET name=?,region=?,member_status=?,district_id=?,chapter_id=?,card_lookup=?,card_encrypted=?,card_mask=?,review_reason=?,residence_city_id=?,residence_district_id=? WHERE participant_id=?',
        clean(input.name,80),residence.region,status,member?district:null,member?chapter:null,cardLookup,
        member?(value?seal(value):current.card_encrypted):null,member?(value?'••••'+value.slice(-4):current.card_mask):null,
        member&&!changed?current.review_reason:null,residence.cityId,residence.districtId,owner);
      await auditReq(owner,'profile.update',owner,{memberStatus:status,residenceCityId:residence.cityId,residenceDistrictId:residence.districtId});
    });
    return await profile(owner);
  }
  if (path==='/me/consents' && method==='POST') {
    const owner=await person(req), input=await json(req), code=input.scope??'*';
    demand(typeof input.choice==='boolean'&&input.noticeVersion===NOTICE&&
      ((['privacy','marketing'].includes(input.purpose)&&code==='*')||(input.purpose==='tracking'&&PROGRAMS.some(p=>p.code===code))),
      422,'CONSENT_INVALID','同意設定無效，請重新整理。');
    await tx(async ()=>{
      await recordConsent(owner,input.purpose,code,input.choice);
      if (!input.choice && (input.purpose==='tracking'||input.purpose==='privacy')) {
        await run(`UPDATE attempts SET status='skipped',reason=? WHERE status='pending' AND recipient_id IN (
          SELECT r.id FROM recipients r JOIN jobs j ON j.id=r.job_id JOIN event_surveys s ON s.id=j.survey_id
          JOIN events e ON e.id=s.event_id WHERE r.participant_id=? AND (?='*' OR (e.program=? AND s.stage IN ('F30','T2','T3'))))`,
          input.purpose==='privacy'?'撤回個資告知確認':'撤回追蹤同意',owner,code,code);
      }
      await auditReq(owner,'consent.change',owner,{purpose:input.purpose,scope:code,choice:input.choice,version:NOTICE});
    });
    return await profile(owner);
  }
  if (path==='/me/files' && method==='POST') return await upload(req,await person(req),'photo');
  const file=path.match(/^\/me\/files\/([^/]+)$/);
  if (file && method==='GET') {
    const owner=await person(req), asset=await one("SELECT * FROM assets WHERE id=? AND owner_id=? AND purpose='photo'",file[1],owner);
    demand(asset,404,'FILE_NOT_FOUND','找不到這張照片。');
    await auditReq(owner,'asset.read',file[1]);
    return assetResponse(res,asset);
  }
  if (path==='/me/rights' && method==='POST') {
    const owner=await person(req), input=await json(req), key=id();
    demand(['access','correction','deletion','phone_recovery'].includes(input.kind),422,'RIGHT_KIND','請選擇有效的請求類型。');
    await run('INSERT INTO rights_requests(id,participant_id,kind,note,created_at) VALUES (?,?,?,?,?)',key,owner,input.kind,clean(input.note,1000),iso());
    await auditReq(owner,'rights.create',key,{kind:input.kind});
    return {id:key,status:'received'};
  }
  if (path==='/me/rights' && method==='GET') return page(await all('SELECT id,kind,note,status,created_at FROM rights_requests WHERE participant_id=? ORDER BY created_at DESC,id',await person(req)),url);
  const enrollmentPath=path.match(/^\/events\/([^/]+)\/enrollments$/);
  if (enrollmentPath && method==='POST') {
    const owner=await person(req), event=await getEvent(enrollmentPath[1]), input=await json(req);
    demand(await consent(owner,'privacy','*'),403,'NOTICE_REQUIRED','請先在個人資料確認個資告知。');
    return await tx(async ()=>{
      const current=await enrollment(event.id,owner), cancel=input.action==='cancel';
      if (cancel) {
        demand(current?.status==='registered' && event.status==='published' && iso()<event.starts_at,409,'CANCEL_INVALID','僅可取消尚未開始的報名。');
        await run("UPDATE enrollments SET status='cancelled' WHERE event_id=? AND participant_id=?",event.id,owner);
      } else {
        if (current&&current.status!=='cancelled') return current;
        demand(event.status==='published'&&event.registration_opens<=iso()&&event.registration_closes>iso(),409,'REGISTRATION_CLOSED','場次目前未開放報名。');
        await run(`INSERT INTO enrollments VALUES (?,?, 'registered', ?,NULL,?)
          ON CONFLICT(event_id,participant_id) DO UPDATE SET status='registered',registered_at=excluded.registered_at,
          attended_at=NULL,anchor_at=excluded.anchor_at`,event.id,owner,iso(),event.anchor_type==='first_activation'?iso():null);
      }
      await auditReq(owner,cancel?'enrollment.cancel':'enrollment.create',event.id);
      return await enrollment(event.id,owner);
    });
  }
  if (path==='/me/enrollments' && method==='GET') {
    const owner=await person(req);
    const rows=await all(`SELECT en.*,e.program,e.title,e.starts_at,e.timezone FROM enrollments en JOIN events e ON e.id=en.event_id WHERE en.participant_id=?
      UNION ALL SELECT c.event_id,c.participant_id,'cadre',c.assigned_at,NULL,NULL,e.program,e.title,e.starts_at,e.timezone FROM event_cadres c JOIN events e ON e.id=c.event_id
      WHERE c.participant_id=? AND (c.active=1 OR EXISTS(SELECT 1 FROM responses r JOIN event_surveys s ON s.id=r.event_survey_id WHERE s.event_id=c.event_id AND r.participant_id=c.participant_id AND r.effective=1))
      AND NOT EXISTS(SELECT 1 FROM enrollments en WHERE en.event_id=c.event_id AND en.participant_id=c.participant_id) ORDER BY starts_at DESC,event_id`,owner,owner);
    return page(rows,url,'event_id');
  }
  if (path==='/me/surveys' && method==='GET') {
    const owner=await person(req);
    const rows=await all(`SELECT s.id FROM event_surveys s JOIN events e ON e.id=s.event_id WHERE e.status<>'draft' AND
      ((s.stage<>'STAFF' AND EXISTS(SELECT 1 FROM enrollments en WHERE en.event_id=s.event_id AND en.participant_id=? AND en.status<>'cancelled')) OR
       (s.stage='STAFF' AND (EXISTS(SELECT 1 FROM event_cadres c WHERE c.event_id=s.event_id AND c.participant_id=? AND c.active=1) OR
        EXISTS(SELECT 1 FROM responses r WHERE r.event_survey_id=s.id AND r.participant_id=? AND r.effective=1)))) ORDER BY s.opens_at DESC,s.id`,owner,owner,owner);
    return page(await Promise.all(rows.map(async row=>{
      const s=await getSurvey(row.id), en=await enrollment(s.event_id,owner), range=windowFor(s,en);
      const response=await one(`SELECT r.id,r.answers_json,r.submitted_at,r.version_id,v.version,v.schema_json FROM responses r JOIN survey_versions v ON v.id=r.version_id WHERE r.event_survey_id=? AND r.participant_id=? AND r.effective=1`,s.id,owner);
      const reason=await eligibility(s,owner);
      return {id:s.id,eventId:s.event_id,title:s.title,program:s.program,stage:s.stage,stageName:STAGES[s.stage],
        ...range,timezone:s.timezone,versionId:response?.version_id??s.version_id,version:response?.version??s.version,enrollment:en?.status??'cadre',form:JSON.parse(response?.schema_json??s.schema_json),reason,
        status:response?'done':!reason?'open':iso()<range.opens_at?'upcoming':iso()>=range.closes_at?'closed':'blocked',
        response:response?{id:response.id,answers:JSON.parse(response.answers_json),submittedAt:response.submitted_at}:null};
    })),url);
  }
  const respond=path.match(/^\/event-surveys\/([^/]+)\/responses$/);
  if (respond&&method==='POST') {
    const owner=await person(req), input=await json(req), survey=await getSurvey(respond[1]);
    return await tx(async ()=>{
      const response=await one('SELECT * FROM responses WHERE event_survey_id=? AND participant_id=? AND effective=1',survey.id,owner);
      demand(input.versionId===(response?.version_id??survey.version_id),409,'VERSION_MISMATCH','問卷版本已更新，請重新開啟。');
      const schema=JSON.parse(response?(await one('SELECT schema_json FROM survey_versions WHERE id=?',response.version_id)).schema_json:survey.schema_json);
      const answers=validAnswers(schema,input.answers);
      const packed=JSON.stringify(answers);
      if (response) {
        const normalized=JSON.stringify(validAnswers(schema,JSON.parse(response.answers_json)));
        demand(normalized===packed,409,'ALREADY_SUBMITTED','這份問卷已有一份有效回覆。');
        return {responseId:response.id,submittedAt:response.submitted_at};
      }
      const now=iso(), reason=await eligibility(survey,owner,now);
      demand(!reason,reason==='問卷已截止'||reason==='問卷未開放'?409:403,reason==='問卷已截止'?'SURVEY_CLOSED':'SURVEY_INELIGIBLE',reason??'無法提交問卷。');
      const responseId=id();
      await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at) VALUES (?,?,?,?,?,?)',
        responseId,survey.id,owner,survey.version_id,packed,now);
      if(survey.stage==='T0'&&Object.hasOwn(answers,'tracking_consent')) await recordConsent(owner,'tracking',survey.program,answers.tracking_consent==='同意');
      await auditReq(owner,'survey.submit',responseId,{eventSurvey:survey.id,version:survey.version});
      return {responseId,submittedAt:now};
    });
  }
  if (path==='/me/invitations/open'&&method==='POST') {
    const owner=await person(req), input=await json(req);
    return await tx(async ()=>{
      const invite=await one(`SELECT i.*,r.participant_id,j.survey_id FROM invitations i JOIN recipients r ON r.id=i.recipient_id
        JOIN jobs j ON j.id=r.job_id WHERE i.token_hash=?`,digest(clean(input.token,150)));
      demand(invite&&invite.participant_id===owner,403,'INVITATION_OWNER','此邀請連結不屬於目前登入帳號。');
      demand(invite.expires_at>iso(),409,'INVITATION_EXPIRED','此邀請連結已過期。');
      await run('UPDATE invitations SET opened_at=COALESCE(opened_at,?) WHERE token_hash=?',iso(),invite.token_hash);
      return {surveyId:invite.survey_id};
    });
  }
  throw new Problem(404,'NOT_FOUND','找不到介面。');
}

async function eventBody(input:any) {
  const program=PROGRAMS.find(p=>p.code===input.program);
  const title=clean(input.title), region=clean(input.region), venue=clean(input.venue), org=clean(input.orgId);
  demand(program&&title&&region&&venue&&await one('SELECT id FROM org_units WHERE id=?',org),422,'EVENT_FIELDS','請填寫活動方案、名稱、地區、地點及承辦組織。');
  const timezone=clean(input.timezone)||'Asia/Taipei';
  try { new Intl.DateTimeFormat('zh-TW',{timeZone:timezone}); } catch { throw new Problem(422,'TIMEZONE','請輸入有效的 IANA 時區。'); }
  const start=date(input.startsAt), end=date(input.endsAt), opens=date(input.registrationOpens), closes=date(input.registrationCloses);
  demand(start<end&&opens<closes&&closes<=start,422,'EVENT_DATES','場次或報名時間順序不正確。');
  const anchor=program.code==='VEG'&&input.anchorType==='first_activation'?'first_activation':'event_end';
  return [program.code,title,region,venue,org,start,end,timezone,opens,closes,anchor];
}
async function sessionJob(jobId:string,auth:any) {
  const job=await one('SELECT * FROM jobs WHERE id=?',jobId);
  demand(job,404,'JOB_NOT_FOUND','查無派送任務。');
  await scope(auth,await getSurvey(job.survey_id));
  return job;
}
function filtersFrom(url:URL) {
  return Object.fromEntries(['eventId','program','member','district','chapter','stage','until','since']
    .filter(key=>url.searchParams.get(key)).map(key=>[key,url.searchParams.get(key)]));
}
function exportCsv(res:ServerResponse,name:string,rows:any[][]) {
  const cell=(value:any)=>{
    let text=String(value??'');
    if (/^[=+\-@\t\r]/.test(text) && typeof value!=='number') text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+name+'.csv"'});
  res.end('\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n'));
}
async function administration(req:IncomingMessage,res:ServerResponse,path:string,method:string,url:URL) {
  const who=await staff(req);
  const allowed=async (roles:string)=>await staff(req,roles);
  if (path==='/admin/me' && method==='GET') return {id:who.staff_id,label:who.label,role:who.role,org:who.org_id};
  const accessRoute=path.match(/^\/admin\/staff(?:\/([^/]+))?$/);
  if (accessRoute) {
    await allowed('admin');
    demand(!who.org_id,403,'ORG_FORBIDDEN','僅全平台系統管理員可維護後台權限。');
    if (!accessRoute[1]&&method==='GET') return staffAccessList();
    if ((!accessRoute[1]&&method==='POST')||(accessRoute[1]&&method==='PATCH')) {
      return saveStaffAccess(accessRoute[1]?decodeURIComponent(accessRoute[1]):undefined,await json(req),who.staff_id);
    }
    throw new Problem(405,'METHOD','此操作方式不支援。');
  }
  const locationRoute=path.match(/^\/admin\/residence-(cities|districts)(?:\/([^/]+))?$/);
  if (path==='/admin/residence-locations'||locationRoute) {
    await allowed('admin');
    demand(!who.org_id,403,'ORG_FORBIDDEN','僅全平台系統管理員可維護縣市地區。');
    if (path==='/admin/residence-locations'&&method==='GET') return residenceLocations(true);
    if (locationRoute&&((!locationRoute[2]&&method==='POST')||(locationRoute[2]&&method==='PATCH'))) {
      return saveResidenceLocation(locationRoute[1] as 'cities'|'districts',locationRoute[2],await json(req),who.staff_id);
    }
    throw new Problem(405,'METHOD','此操作方式不支援。');
  }
  if (path==='/admin/events' && method==='GET') {
    await allowed('operator|analyst|publisher');
    const term=url.searchParams.get('q')??'';
    return page(await Promise.all((await filterAsync((await all('SELECT * FROM events ORDER BY starts_at DESC,id')), async e=>await inOrg(who.org_id,e.org_id)&&(!term||(e.title+e.venue+e.region).includes(term)))).map(async event=>({
      ...event,surveys:await all(`SELECT s.*,sv.version FROM event_surveys s JOIN survey_versions sv ON sv.id=s.version_id WHERE event_id=? ORDER BY opens_at`,event.id),
      roster:(await one('SELECT COUNT(*) AS n FROM enrollments WHERE event_id=? AND status<>\'cancelled\'',event.id)).n
    }))),url);
  }
  if (path==='/admin/events' && method==='POST') {
    await allowed('operator');
    const input=await json(req), [program,title,region,venue,org,start,end,zone,opens,closes,anchor]=await eventBody(input);
    await scope(who,{org_id:org});
    const newId=id();
    await tx(async ()=>{
      await run('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',newId,program,title,region,venue,org,start,end,zone,opens,closes,'draft',anchor,iso());
      await auditReq(who.staff_id,'event.create',newId);
    });
    return await getEvent(newId);
  }
  const cadreRoute=path.match(/^\/admin\/events\/([^/]+)\/cadres(?:\/([^/]+))?$/);
  if(cadreRoute) {
    await allowed('operator');
    const event=await getEvent(cadreRoute[1]);await scope(who,event);
    if(method==='GET'&&!cadreRoute[2]) {
      await auditReq(who.staff_id,'cadre.read',event.id);
      return {items:await all(`SELECT c.*,p.name,i.mask AS phone_mask FROM event_cadres c
      JOIN profiles p ON p.participant_id=c.participant_id LEFT JOIN identities i ON i.participant_id=c.participant_id AND i.kind='phone' AND i.revoked_at IS NULL
      WHERE c.event_id=? ORDER BY c.active DESC,p.name,c.participant_id`,event.id)};
    }
    const input=await json(req);
    return tx(async()=>{
      if(method==='POST'&&!cadreRoute[2]) {
        const phones=String(input.phones??'').split(/[,，\n]+/).map(v=>v.trim()).filter(Boolean);
        demand(phones.length>0&&phones.length<=6000,422,'CADRE_LIST','請填寫幹部已驗證的手機號碼，每行一筆。');
        const ids=[];
        for(const [index,phone] of phones.entries()) {
          const identity=await one("SELECT i.participant_id FROM identities i JOIN participants p ON p.id=i.participant_id AND p.status='active' WHERE i.kind='phone' AND i.lookup=? AND i.revoked_at IS NULL",lookup(normalizePhone(phone)));
          demand(identity,422,'CADRE_PHONE','第 '+(index+1)+' 筆手機尚無已驗證的登入帳號，請先請本人登入。');
          ids.push(identity.participant_id);
        }
        for(const pid of new Set(ids)) await run(`INSERT INTO event_cadres VALUES (?,?,1,?,?) ON CONFLICT(event_id,participant_id) DO UPDATE SET active=1,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at`,event.id,pid,who.staff_id,iso());
        await auditReq(who.staff_id,'cadre.assign',event.id,{count:new Set(ids).size});return {count:new Set(ids).size};
      }
      demand(method==='PATCH'&&cadreRoute[2]&&typeof input.active==='boolean',422,'CADRE_FIELDS','請指定幹部與啟用狀態。');
      demand(await one('SELECT participant_id FROM event_cadres WHERE event_id=? AND participant_id=?',event.id,cadreRoute[2]),404,'CADRE_NOT_FOUND','找不到此幹部。');
      await run('UPDATE event_cadres SET active=?,assigned_by=?,assigned_at=? WHERE event_id=? AND participant_id=?',Number(input.active),who.staff_id,iso(),event.id,cadreRoute[2]);
      await auditReq(who.staff_id,'cadre.update',event.id,{participantId:cadreRoute[2],active:input.active});return {ok:true};
    });
  }
  const eventRoute=path.match(/^\/admin\/events\/([^/]+)(?:\/(attendance-imports|roster|surveys|status|assessment-setup))?$/);
  if (eventRoute) {
    const [_,eventId,action]=eventRoute;
    const event=await getEvent(eventId);
    await scope(who,event);
    await allowed('operator');
    if(action==='assessment-setup'&&method==='POST') {
      demand(event.status==='draft',409,'EVENT_LOCKED','僅草稿場次可套用標準問卷，已發布場次保留原版本。');
      return tx(async()=>{
        for(const stage of ASSESSMENT_STAGES) {
          const version=await one("SELECT id FROM survey_versions WHERE id=? AND status='published'",event.program+'-'+stage+'-assessment-v2');
          demand(version,409,'VERSION_INVALID','標準問卷尚未發布。');
          const [opens,closes]=plannedWindow(event,stage);
          await run(`INSERT INTO event_surveys VALUES (?,?,?,?,?,?,'fixed') ON CONFLICT(event_id,stage) DO UPDATE SET version_id=excluded.version_id,opens_at=excluded.opens_at,closes_at=excluded.closes_at,window_rule='fixed'`,id(),event.id,stage,version.id,opens,closes);
        }
        await auditReq(who.staff_id,'event.assessment.setup',event.id);return {ok:true};
      });
    }
    if (!action&&method==='PATCH') {
      const input=await json(req), [program,title,region,venue,org,start,end,zone,opens,closes,anchor]=await eventBody(input);
      await scope(who,{org_id:org});
      demand(event.status==='draft',409,'EVENT_LOCKED','場次發布後保留已核定的場次與排程。');
      demand(program===event.program||!await one('SELECT id FROM event_surveys WHERE event_id=?',eventId),409,'SURVEY_CONFLICT','請先調整場次問卷，再變更方案。');
      await run('UPDATE events SET program=?,title=?,region=?,venue=?,org_id=?,starts_at=?,ends_at=?,timezone=?,registration_opens=?,registration_closes=?,anchor_type=? WHERE id=?',
        program,title,region,venue,org,start,end,zone,opens,closes,anchor,eventId);
      await auditReq(who.staff_id,'event.update',eventId);
      return await getEvent(eventId);
    }
    if (action==='status' && method==='POST') {
      const next=(await json(req)).status;
      const transitions:Record<string,string[]>={draft:['published','cancelled'],published:['completed','cancelled'],completed:['archived','cancelled'],archived:[],cancelled:[]};
      demand(transitions[event.status]?.includes(next),409,'EVENT_TRANSITION','無法執行此狀態變更。');
      return await tx(async ()=>{
        if (next==='published') {
          demand(await one('SELECT id FROM event_surveys WHERE event_id=?',eventId),409,'NO_SURVEYS','發布前請先設定至少一個問卷階段。');
        }
        await run('UPDATE events SET status=? WHERE id=?',next,eventId);
        if (['cancelled','archived'].includes(next)) for (const job of await all(`SELECT j.id FROM jobs j JOIN event_surveys s ON s.id=j.survey_id WHERE s.event_id=?`,eventId)) await cancelJob(job.id,'場次已關閉');
        await auditReq(who.staff_id,'event.status',eventId,{from:event.status,to:next});
        return await getEvent(eventId);
      });
    }
    if (action==='surveys' && method==='POST') {
      const input=await json(req);
      demand(event.status==='draft',409,'EVENT_LOCKED','發布場次已鎖定問卷版本。');
      demand(Object.hasOwn(STAGES,input.stage),422,'STAGE_INVALID','請選擇問卷階段。');
      if (input.remove===true) {
        await run('DELETE FROM event_surveys WHERE event_id=? AND stage=?',eventId,input.stage);
        await auditReq(who.staff_id,'event.stage.remove',eventId,{stage:input.stage});
        return {ok:true};
      }
      const version=await one("SELECT * FROM survey_versions WHERE id=? AND program=? AND stage=? AND status='published'",clean(input.versionId),event.program,input.stage);
      demand(version,422,'VERSION_INVALID','請選用此方案及階段已發布的版本。');
      const defaultWindow=plannedWindow(event,input.stage);
      const opens=input.opensAt?date(input.opensAt):defaultWindow[0], closes=input.closesAt?date(input.closesAt):defaultWindow[1];
      const rolling=event.anchor_type==='first_activation'&&FOLLOW.includes(input.stage);
      demand(opens<closes&&(!rolling||Date.parse(closes)-Date.parse(opens)>=DAY),422,'SURVEY_DATES','截止必須晚於開始時間，個人追蹤至少開放一天。');
      await run(`INSERT INTO event_surveys VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id,stage) DO UPDATE
        SET version_id=excluded.version_id,opens_at=excluded.opens_at,closes_at=excluded.closes_at,window_rule=excluded.window_rule`,
        id(),eventId,input.stage,version.id,opens,closes,rolling?'rolling':'fixed');
      await auditReq(who.staff_id,'event.stage.assign',eventId,{stage:input.stage,version:version.version});
      return await one('SELECT * FROM event_surveys WHERE event_id=? AND stage=?',eventId,input.stage);
    }
    if (action==='roster' && method==='GET') {
      const rows=await all(`SELECT en.participant_id AS id,en.status,en.registered_at,en.attended_at,p.card_mask,p.member_status
        FROM enrollments en JOIN profiles p ON p.participant_id=en.participant_id WHERE en.event_id=? ORDER BY en.registered_at DESC,en.participant_id`,eventId);
      await auditReq(who.staff_id,'attendance.read',eventId);
      return page(rows.filter(r=>!url.searchParams.has('q')||(r.id+' '+(r.card_mask??'')).includes(url.searchParams.get('q'))),url);
    }
    if (action==='attendance-imports' && method==='POST') {
      demand(['published','completed'].includes(event.status),409,'EVENT_LOCKED','目前無法登錄此場出席。');
      const input=await json(req), items=input.participantIds;
      demand(Array.isArray(items)&&items.length>0&&items.length<=6000,422,'ATTENDANCE_LIST','請輸入 1 至 6,000 筆平台識別碼。');
      return await tx(async ()=>{
        const seen=new Set<string>();
        const rows=[];
        for (const raw of items) {
          const pid=clean(raw,64), en=await enrollment(eventId,pid);
          let status='eligible';
          if (!en || en.status==='cancelled') status='未報名或已取消';
          else if (seen.has(pid)) status='重複';
          else if (en.status==='attended') status='已簽到';
          seen.add(pid);
          if (status==='eligible' && input.preview!==true) {
            await run("UPDATE enrollments SET attended_at=?,status='attended' WHERE event_id=? AND participant_id=?",iso(),eventId,pid);
            status='已登錄';
          }
          rows.push({id:pid,status});
        }
        await auditReq(who.staff_id,input.preview?'attendance.preview':'attendance.import',eventId,{count:rows.length});
        return {rows};
      });
    }
  }

  if (path==='/admin/survey-versions' && method==='GET') {
    await allowed('operator|analyst|publisher');
    const rows=(await all('SELECT * FROM survey_versions ORDER BY program,stage,version DESC,id'))
      .filter(r=>(!url.searchParams.has('program')||r.program===url.searchParams.get('program'))&&(!url.searchParams.has('stage')||r.stage===url.searchParams.get('stage')));
    return page(rows.map(r=>({...r,form:JSON.parse(r.schema_json),schema_json:undefined})),url);
  }
  if (path==='/admin/survey-versions' && method==='POST') {
    await allowed('operator');
    const input=await json(req);
    demand(PROGRAMS.some(p=>p.code===input.program)&&Object.hasOwn(STAGES,input.stage),422,'VERSION_FIELDS','請選擇有效方案和階段。');
    const form=input.form;
    demand(Array.isArray(form)&&form.length>0&&form.length<=40,422,'FORM_SIZE','問卷需要 1 至 40 個問題。');
    const keys=new Set();
    const schema=form.map(q=>{
      demand(q&&/^[a-z][a-z0-9_]{1,63}$/.test(q.key)&&!keys.has(q.key)&&clean(q.label,300)&&['integer','number','choice','multichoice','text'].includes(q.type),
        422,'QUESTION_FIELDS','題目須包含唯一英文代碼、標題及有效題型。');
      keys.add(q.key);
      const core=PROGRAMS.find(p=>p.code===input.program)!.metric===q.key;
      demand(!core||q.type==='integer',422,'METRIC_TYPE','既有核心指標須使用整數題，避免變更既有計量單位。');
      if (['integer','number'].includes(q.type)) {
        demand(Number.isSafeInteger(q.min)&&Number.isSafeInteger(q.max)&&q.min>=0&&q.min<=q.max&&q.max<=10000000,
          422,'QUESTION_LIMIT','請檢查數字題上下限。');
        if (core) demand(clean(q.unit,20)&&clean(q.metricVersion,30),422,'METRIC_VERSION','核心題須指定單位與指標定義版本。');
      } else if(q.type==='text') {
        demand(!core&&Number.isInteger(q.maxLength)&&q.maxLength>0&&q.maxLength<=4000,422,'QUESTION_LIMIT','文字題字數上限須為 1 至 4,000。');
      } else {
        demand(!core&&Array.isArray(q.options)&&q.options.length>1&&q.options.length<=20&&
          q.options.every(x=>clean(x,80)===x&&x)&&new Set(q.options).size===q.options.length,422,'QUESTION_OPTIONS','請檢查選項或核心題的題型。');
      }
      return {key:q.key,label:clean(q.label,300),type:q.type,required:q.required===true,help:clean(q.help,300),
        unit:clean(q.unit,20),metricVersion:clean(q.metricVersion,30)||null,
        ...(['integer','number'].includes(q.type)?{min:q.min,max:q.max}:q.type==='text'?{maxLength:q.maxLength}:{options:q.options})};
    });
    return await tx(async ()=>{
      const version=await nextSurveyVersion(input.program,input.stage);
      const key=id();
      await run('INSERT INTO survey_versions VALUES (?,?,?,?,?,?,?,NULL)',key,input.program,input.stage,version,'draft',JSON.stringify(schema),iso());
      await auditReq(who.staff_id,'survey.version.create',key,{version});
      return {id:key,version,status:'draft'};
    });
  }
  const versionDelete=path.match(/^\/admin\/survey-versions\/([^/]+)$/);
  if(versionDelete&&method==='DELETE') {
    await allowed('operator|publisher');
    return tx(async()=>{
      const version=await one('SELECT * FROM survey_versions WHERE id=?',versionDelete[1]);
      demand(version,404,'VERSION_NOT_FOUND','找不到此問卷版本，可能已刪除。');
      const events=(await one('SELECT COUNT(*) AS n FROM event_surveys WHERE version_id=?',version.id)).n;
      const responses=(await one('SELECT COUNT(*) AS n FROM responses WHERE version_id=?',version.id)).n;
      const snapshots=(await all('SELECT report_json FROM snapshots')).filter(row=>JSON.parse(row.report_json).eventRows?.some(event=>event.program===version.program&&event.versions?.some(v=>v.stage===version.stage&&v.version===version.version))).length;
      demand(!events&&!responses&&!snapshots,409,'VERSION_IN_USE','無法刪除：此版本仍有 '+events+' 個場次綁定、'+responses+' 份答卷、'+snapshots+' 份成果快照引用。請保留或停用此版本。');
      await run(`INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(app_settings.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)`,
        'survey_version_highwater:'+version.program+':'+version.stage,String(version.version));
      await run('INSERT INTO app_settings VALUES (?,?)','deleted_survey_version:'+version.id,iso());
      await run('DELETE FROM survey_versions WHERE id=?',version.id);
      await auditReq(who.staff_id,'survey.version.delete',version.id,{program:version.program,stage:version.stage,version:version.version,status:version.status});
      return {ok:true};
    });
  }
  const versionAction=path.match(/^\/admin\/survey-versions\/([^/]+)\/(publish|retire)$/);
  if (versionAction && method==='POST') {
    await allowed('operator|publisher');
    const v=await one('SELECT * FROM survey_versions WHERE id=?',versionAction[1]), publish=versionAction[2]==='publish';
    demand(v&&v.status===(publish?'draft':'published'),409,'VERSION_STATUS','該版本無法執行此操作。');
    await run('UPDATE survey_versions SET status=?,published_at=? WHERE id=?',publish?'published':'retired',publish?iso():v.published_at,v.id);
    await auditReq(who.staff_id,publish?'survey.version.publish':'survey.version.retire',v.id);
    return {ok:true};
  }

  if (path==='/admin/dispatch-jobs/preview' && method==='POST') {
    await allowed('operator');
    const input=await json(req), survey=await getSurvey(clean(input.surveyId));
    demand(['published','completed'].includes(survey.event_status),409,'EVENT_LOCKED','場次目前不可派送。');
    const snapshot=await audience(who,survey,input), key=id();
    await run('INSERT INTO previews VALUES (?,?,?,?,?,?)',key,survey.id,who.staff_id,JSON.stringify(snapshot),snapshot.createdAt,iso(30*60000));
    await auditReq(who.staff_id,'dispatch.preview',key,{count:snapshot.members.length});
    return {id:key,count:snapshot.members.length,excluded:snapshot.excluded,createdAt:snapshot.createdAt,
      recipients:snapshot.members.slice(0,15).map(({id,...safe})=>safe)};
  }
  if (path==='/admin/dispatch-jobs' && method==='POST') {
    await allowed('operator');
    const input=await json(req), preview=await one('SELECT * FROM previews WHERE id=? AND staff_id=?',clean(input.previewId),who.staff_id);
    demand(preview,404,'PREVIEW_NOT_FOUND','找不到這份名單預覽。');
    const survey=await getSurvey(preview.survey_id);
    await scope(who,survey);
    return await tx(async ()=>{
      const existing=await one('SELECT * FROM jobs WHERE preview_id=?',preview.id);
      if (existing) return existing;
      demand(preview.expires_at>iso(),409,'PREVIEW_EXPIRED','名單預覽已過期，請重新預覽。');
      const due=input.dueAt?date(input.dueAt):iso();
      const people=JSON.parse(preview.snapshot_json).members;
      demand(people.length,422,'NO_RECIPIENTS','沒有符合條件的對象。');
      demand((await Promise.all(people.map(async p=>{
        const w=windowFor(survey,await enrollment(survey.event_id,p.id)); return due>=w.opens_at&&due<w.closes_at;
      }))).some(Boolean),422,'DISPATCH_TIME','發送時間須在至少一位收件人的問卷開放期間內。');
      const key=id();
      await run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)',key,preview.id,survey.id,who.staff_id,'scheduled',due,iso(),requestContext.getStore()??null);
      for (const member of people) await run('INSERT INTO recipients VALUES (?,?,?)',id(),key,member.id);
      const job=await one('SELECT * FROM jobs WHERE id=?',key);
      await enqueue(job,1);
      await auditReq(who.staff_id,'dispatch.schedule',key,{count:people.length,due});
      return job;
    });
  }
  if (path==='/admin/dispatch-jobs' && method==='GET') {
    await allowed('operator');
    const jobs=await all(`SELECT j.*,s.stage,e.title,e.org_id,e.program FROM jobs j JOIN event_surveys s ON s.id=j.survey_id JOIN events e ON e.id=s.event_id
      ORDER BY j.created_at DESC,j.id`);
    return page(await Promise.all((await filterAsync(jobs, async j=>await inOrg(who.org_id,j.org_id))).map(async j=>({...j,...await jobStats(j)}))),url);
  }
  const jobRoute=path.match(/^\/admin\/dispatch-jobs\/([^/]+)(?:\/(reminders|cancel|reconcile))?$/);
  if (jobRoute) {
    await allowed('operator');
    const job=await sessionJob(jobRoute[1],who), action=jobRoute[2];
    if (!action&&method==='GET') {
      const survey=await getSurvey(job.survey_id);
      const attempts=await all(`SELECT a.id,a.number,a.status,a.reason,a.due_at,a.accepted_at,a.retries,COALESCE(p.card_mask,'非會員') AS mask FROM attempts a
        JOIN recipients r ON r.id=a.recipient_id JOIN profiles p ON p.participant_id=r.participant_id
        WHERE r.job_id=? ORDER BY a.number DESC,a.id`,job.id);
      return {...job,title:survey.title,stage:survey.stage,version:survey.version,deadline:survey.closes_at,statistics:await jobStats(job),attempts:page(attempts,url)};
    }
    if (action==='reminders'&&method==='POST') {
      const survey=await getSurvey(job.survey_id);
      demand(['completed','partial_failed'].includes(job.status),409,'JOB_ACTIVE','請待本次排程完成後再提醒。');
      demand(['published','completed'].includes(survey.event_status)&&await one(`SELECT r.id FROM recipients r JOIN enrollments en ON en.participant_id=r.participant_id AND en.event_id=?
        WHERE r.job_id=? AND NOT EXISTS (SELECT 1 FROM responses a WHERE a.event_survey_id=? AND a.participant_id=r.participant_id AND a.effective=1) LIMIT 1`,survey.event_id,job.id,survey.id),
        409,'REMINDER_INELIGIBLE','這個任務沒有可提醒的未填答對象。');
      return await tx(async ()=>{
        demand(!await one("SELECT a.id FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=? AND a.status='unknown' LIMIT 1",job.id),
          409,'RECONCILIATION_REQUIRED','請先查核管道結果不明的通知，再建立提醒。');
        const last=(await one('SELECT MAX(number) AS last FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=?',job.id)).last;
        demand(last<4,409,'REMINDER_LIMIT','這個任務已達提醒次數上限。');
        await enqueue(job,last+1);
        await run("UPDATE jobs SET status='scheduled' WHERE id=?",job.id);
        await auditReq(who.staff_id,'dispatch.remind',job.id,{number:last+1});
        return {ok:true,attempt:last+1};
      });
    }
    if (action==='cancel'&&method==='POST') {
      await tx(async ()=>{await cancelJob(job.id,'營運取消');await auditReq(who.staff_id,'dispatch.cancel',job.id);});
      return {ok:true};
    }
    if (action==='reconcile'&&method==='POST') {
      const unknown=await all("SELECT a.* FROM attempts a JOIN recipients r ON r.id=a.recipient_id WHERE r.job_id=? AND a.status='unknown' LIMIT 40",job.id);
      for (const attempt of unknown) {
        const result=await provider('push/status',{key:attempt.id});
        if (['accepted','delivered','failed'].includes(result.status)) {
          const acceptedAt=['accepted','delivered'].includes(result.status)?(result.acceptedAt?date(result.acceptedAt):attempt.queued_at):null;
          await run("UPDATE attempts SET status=?,accepted_at=?,reason=? WHERE id=? AND status='unknown'",
            result.status,acceptedAt,acceptedAt?null:'管道查核後確認失敗',attempt.id);
        }
      }
      await auditReq(who.staff_id,'dispatch.reconcile',job.id,{count:unknown.length});
      return {ok:true};
    }
  }

  if (path==='/admin/members'&&method==='GET') {
    await allowed('identity');
    const term=url.searchParams.get('q')??'';
    const rows=await all(`SELECT p.participant_id AS id,p.name,p.member_status,p.district_id,p.chapter_id,p.region,p.card_mask,p.review_reason,
      p.residence_city_id,p.residence_district_id,c.name AS residence_city,d.name AS residence_district,
      a.created_at, i.mask AS phone_mask FROM profiles p JOIN participants a ON a.id=p.participant_id
      LEFT JOIN residence_cities c ON c.id=p.residence_city_id LEFT JOIN residence_districts d ON d.id=p.residence_district_id
      LEFT JOIN identities i ON i.participant_id=p.participant_id AND i.kind='phone' AND i.revoked_at IS NULL WHERE a.status='active'
      ORDER BY (p.member_status='pending') DESC,a.created_at DESC,p.participant_id`);
    await auditReq(who.staff_id,'member.list','members');
    return page((await filterAsync(rows, async r=>await inOrg(who.org_id,r.chapter_id??r.district_id)&&
      (!term||(r.name+' '+(r.card_mask??'')+' '+r.id).includes(term))&&
      (!url.searchParams.has('status')||r.member_status===url.searchParams.get('status')))),url);
  }
  const member=path.match(/^\/admin\/members\/([^/]+)\/review$/);
  if (member&&method==='POST') {
    await allowed('identity');
    const input=await json(req), pid=member[1], record=await one('SELECT * FROM profiles WHERE participant_id=?',pid);
    demand(record,404,'MEMBER_NOT_FOUND','找不到此會員資料。');
    demand(await inOrg(who.org_id,record.chapter_id??record.district_id),403,'ORG_FORBIDDEN','這位會員不在您的授權範圍。');
    const reason=clean(input.reason,400), result=input.approve===true?'verified':'rejected';
    demand(record.member_status==='pending'&&reason&&record.card_lookup,422,'REVIEW_INVALID','需有待審卡號及審核理由。');
    return await tx(async ()=>{
      demand(result!=='verified'||!await one("SELECT participant_id FROM profiles WHERE card_lookup=? AND member_status='verified' AND participant_id<>?",record.card_lookup,pid),
        409,'CARD_CONFLICT','此卡號已核驗給另一個帳號。請先人工核對。');
      await run('UPDATE profiles SET member_status=?,review_reason=? WHERE participant_id=?',result,reason,pid);
      await auditReq(who.staff_id,'member.review',pid,{status:result,reason});
      return {status:result};
    });
  }
  if (path==='/admin/identity-cases'&&method==='GET') {
    await allowed('identity');
    const cases=await all(`SELECT c.*,p.district_id,p.chapter_id,o.district_id AS other_district,o.chapter_id AS other_chapter
      FROM identity_cases c JOIN profiles p ON p.participant_id=c.participant_id LEFT JOIN profiles o ON o.participant_id=c.other_id ORDER BY c.created_at DESC,c.id`);
    await auditReq(who.staff_id,'identity.cases.list','identity');
    return page((await filterAsync(cases, async r=>await inOrg(who.org_id,r.chapter_id??r.district_id)&&(!r.other_id||await inOrg(who.org_id,r.other_chapter??r.other_district)))),url);
  }
  const identityCase=path.match(/^\/admin\/identity-cases\/([^/]+)\/(propose|review)$/);
  if (identityCase&&method==='POST') {
    await allowed('identity');
    const input=await json(req), issue=await one('SELECT * FROM identity_cases WHERE id=?',identityCase[1]);
    demand(issue,404,'CASE_NOT_FOUND','找不到該身分案件。');
    for (const pid of [issue.participant_id,issue.other_id].filter(Boolean)) {
      const p=await one('SELECT * FROM profiles WHERE participant_id=?',pid);
      demand(await inOrg(who.org_id,p.chapter_id??p.district_id),403,'ORG_FORBIDDEN','此案件不在您的授權範圍。');
    }
    const reason=clean(input.reason,1000);
    demand(reason,422,'CASE_REASON','請填寫人工核驗與處理理由。');
    if (identityCase[2]==='propose') {
      demand(issue.status==='pending'&&['close','merge'].includes(input.action)&&
        (input.action==='close'||issue.other_id),409,'CASE_STATUS','只有具備兩方帳號的待處理案件可申請合併。');
      const conflicts=await all(`SELECT a.event_survey_id,a.id AS target_id,b.id AS source_id FROM responses a JOIN responses b ON a.event_survey_id=b.event_survey_id
        WHERE a.participant_id=? AND b.participant_id=? AND a.effective=1 AND b.effective=1`,issue.participant_id,issue.other_id);
      if (input.action==='merge') {
        demand(conflicts.every(r=>[r.target_id,r.source_id].includes(input.keep?.[r.event_survey_id])),422,'MERGE_RESPONSES','請指定每一組重複問卷保留的有效回覆。');
        demand(clean(input.fieldConflicts,1000),422,'MERGE_FIELDS','請記錄雙方基本資料與聯絡欄位差異及取捨。');
      }
      await run("UPDATE identity_cases SET resolution=?,requested_by=?,status='proposed' WHERE id=?",JSON.stringify({action:input.action,reason,keep:input.keep??{},fieldConflicts:clean(input.fieldConflicts,1000)}),who.staff_id,issue.id);
      await auditReq(who.staff_id,'identity.case.propose',issue.id,{action:input.action});
      return {ok:true};
    }
    demand(issue.status==='proposed'&&issue.requested_by!==who.staff_id,409,'SECOND_REVIEW','需由另一個帳號複核。');
    return await tx(async ()=>{
      const proposal=JSON.parse(issue.resolution);
      if (input.approve===true && proposal.action==='merge') {
        const target=issue.participant_id, source=issue.other_id;
        demand((await Promise.all([target,source].map(async pid=>await one("SELECT id FROM participants WHERE id=? AND status='active'",pid)))).every(Boolean),409,'IDENTITY_ACTIVE','其中一個帳號狀態已變更。');
        const duplicates=await all(`SELECT a.event_survey_id,a.id AS target_id,b.id AS source_id FROM responses a JOIN responses b ON a.event_survey_id=b.event_survey_id
          WHERE a.participant_id=? AND b.participant_id=? AND a.effective=1 AND b.effective=1`,target,source);
        for (const row of duplicates) {
          const keep=proposal.keep[row.event_survey_id];
          demand([row.target_id,row.source_id].includes(keep),409,'MERGE_RESPONSES','合併預覽後已有新增回覆，請退回重新申請。');
          await run('UPDATE responses SET effective=0 WHERE id=?',keep===row.target_id?row.source_id:row.target_id);
        }
        for (const entry of await all('SELECT * FROM enrollments WHERE participant_id=?',source)) {
          const current=await enrollment(entry.event_id,target);
          if (!current) {
            await run('INSERT INTO enrollments VALUES (?,?,?,?,?,?)',entry.event_id,target,entry.status,entry.registered_at,entry.attended_at,entry.anchor_at);
          } else if (entry.status==='attended' && current.status!=='attended') {
            await run("UPDATE enrollments SET status='attended',attended_at=? WHERE event_id=? AND participant_id=?",entry.attended_at,entry.event_id,target);
          }
        }
        // Preserve original answers under the historical ID and create canonical effective revisions.
        for(const cadre of await all('SELECT * FROM event_cadres WHERE participant_id=?',source)) {
          await run(`INSERT INTO event_cadres VALUES (?,?,?,?,?) ON CONFLICT(event_id,participant_id) DO UPDATE SET active=MAX(event_cadres.active,excluded.active)`,cadre.event_id,target,cadre.active,cadre.assigned_by,cadre.assigned_at);
        }
        for (const reply of await all('SELECT * FROM responses WHERE participant_id=? AND effective=1',source)) {
          await run('UPDATE responses SET effective=0 WHERE id=?',reply.id);
          await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at,revision,replaces_id) VALUES (?,?,?,?,?,?,?,?)',
            id(),reply.event_survey_id,target,reply.version_id,reply.answers_json,reply.submitted_at,reply.revision+1,reply.id);
        }
        await run("UPDATE participants SET status='merged',merged_into_id=? WHERE id=?",target,source);
        await run('UPDATE identities SET revoked_at=? WHERE participant_id=? AND revoked_at IS NULL',iso(),source);
        await run("UPDATE profiles SET member_status='rejected',review_reason='舊帳號已合併',line_reachable=0 WHERE participant_id=?",source);
        await run('DELETE FROM sessions WHERE participant_id=?',source);
        await run(`UPDATE attempts SET status='skipped',reason='舊帳號已合併' WHERE status='pending' AND recipient_id IN (SELECT id FROM recipients WHERE participant_id=?)`,source);
      }
      const status=input.approve===true?'resolved':'pending';
      await run('UPDATE identity_cases SET reviewed_by=?,status=?,resolution=? WHERE id=?',who.staff_id,status,JSON.stringify({...proposal,reviewReason:reason}),issue.id);
      await auditReq(who.staff_id,'identity.case.review',issue.id,{status,reason});
      return {status};
    });
  }
  const conflictList=path.match(/^\/admin\/identity-cases\/([^/]+)\/conflicts$/);
  if (conflictList&&method==='GET') {
    await allowed('identity');
    const issue=await one('SELECT * FROM identity_cases WHERE id=?',conflictList[1]);
    demand(issue,404,'CASE_NOT_FOUND','找不到該身分案件。');
    for (const pid of [issue.participant_id,issue.other_id].filter(Boolean)) {
      const p=await one('SELECT * FROM profiles WHERE participant_id=?',pid);
      demand(await inOrg(who.org_id,p.chapter_id??p.district_id),403,'ORG_FORBIDDEN','此案件不在您的授權範圍。');
    }
    await auditReq(who.staff_id,'identity.conflicts.read',issue.id);
    return {items:await all(`SELECT a.event_survey_id,a.id AS target_id,b.id AS source_id FROM responses a JOIN responses b ON a.event_survey_id=b.event_survey_id
      WHERE a.participant_id=? AND b.participant_id=? AND a.effective=1 AND b.effective=1`,issue.participant_id,issue.other_id)};
  }
  if (path==='/admin/rights'&&method==='GET') {
    await allowed('identity');
    const rows=await all(`SELECT r.*,p.district_id,p.chapter_id FROM rights_requests r JOIN profiles p ON p.participant_id=r.participant_id ORDER BY r.created_at DESC,r.id`);
    await auditReq(who.staff_id,'rights.list','rights');
    return page((await filterAsync(rows, async r=>await inOrg(who.org_id,r.chapter_id??r.district_id))),url);
  }
  const right=path.match(/^\/admin\/rights\/([^/]+)$/);
  if (right&&method==='PATCH') {
    await allowed('identity');
    const item=await one(`SELECT r.*,p.district_id,p.chapter_id FROM rights_requests r JOIN profiles p ON p.participant_id=r.participant_id WHERE r.id=?`,right[1]);
    demand(item,404,'RIGHT_NOT_FOUND','沒有這筆請求。');
    demand(await inOrg(who.org_id,item.chapter_id??item.district_id),403,'ORG_FORBIDDEN','此申請不在授權範圍。');
    const input=await json(req), reason=clean(input.reason,1000);
    demand(['reviewing','resolved','rejected'].includes(input.status)&&reason,422,'RIGHT_REVIEW','請提供狀態與處理理由。');
    await run('UPDATE rights_requests SET status=?,reviewed_at=? WHERE id=?',input.status,iso(),item.id);
    await auditReq(who.staff_id,'rights.review',item.id,{status:input.status,reason});
    return {ok:true};
  }

  if (path==='/admin/response-reviews'&&method==='GET') {
    await allowed('analyst|publisher');
    const rows=await all(`SELECT c.id,c.response_id,c.reason,c.status,c.by_staff,c.reviewed_by,c.created_at,s.stage,e.title,e.org_id
      FROM response_reviews c JOIN responses r ON r.id=c.response_id JOIN event_surveys s ON s.id=r.event_survey_id
      JOIN events e ON e.id=s.event_id ORDER BY c.created_at DESC,c.id`);
    return page((await filterAsync(rows, async r=>await inOrg(who.org_id,r.org_id))),url);
  }
  const reviewRoute=path.match(/^\/admin\/response-reviews\/([^/]+)$/);
  if (reviewRoute&&['GET','POST'].includes(method)) {
    await allowed('analyst|publisher');
    const revision=await one('SELECT * FROM response_reviews WHERE id=?',reviewRoute[1]);
    demand(revision,404,'REVIEW_NOT_FOUND','找不到更正案件。');
    const original=await one('SELECT * FROM responses WHERE id=?',revision.response_id);
    await scope(who,await getSurvey(original.event_survey_id));
    if (method==='GET') {
      await auditReq(who.staff_id,'response.review.read',revision.id);
      return {id:revision.id,reason:revision.reason,status:revision.status,before:JSON.parse(original.answers_json),after:JSON.parse(revision.answers_json)};
    }
    await allowed('publisher');
    const input=await json(req), reason=clean(input.reason,500);
    demand(reason&&revision.status==='pending'&&revision.by_staff!==who.staff_id,409,'SECOND_REVIEW','需由另一個帳號複核待審更正並填寫理由。');
    return await tx(async ()=>{
      if(input.approve===true) {
        demand((await one('SELECT effective FROM responses WHERE id=?',original.id))?.effective===1,409,'RESPONSE_CHANGED','有效回覆已更正，請重新申請。');
        await run('UPDATE responses SET effective=0 WHERE id=?',original.id);
        await run('INSERT INTO responses(id,event_survey_id,participant_id,version_id,answers_json,submitted_at,revision,replaces_id) VALUES (?,?,?,?,?,?,?,?)',
          id(),original.event_survey_id,original.participant_id,original.version_id,revision.answers_json,original.submitted_at,original.revision+1,original.id);
      }
      const status=input.approve===true?'approved':'rejected';
      await run('UPDATE response_reviews SET status=?,reviewed_by=? WHERE id=?',status,who.staff_id,revision.id);
      await auditReq(who.staff_id,'response.review',revision.id,{status,reason});
      return {status};
    });
  }
  const responseRoute=path.match(/^\/admin\/responses\/([^/]+)(?:\/(corrections))?$/);
  if (responseRoute&&['GET','POST'].includes(method)) {
    await allowed('analyst');
    const original=await one('SELECT * FROM responses WHERE id=? AND effective=1',responseRoute[1]);
    demand(original,404,'RESPONSE_NOT_FOUND','找不到有效回執。');
    const survey=await getSurvey(original.event_survey_id);
    await scope(who,survey);
    const schema=JSON.parse((await one('SELECT schema_json FROM survey_versions WHERE id=?',original.version_id)).schema_json);
    if (method==='GET'&&!responseRoute[2]) {
      await auditReq(who.staff_id,'response.read',original.id);
      return {id:original.id,title:survey.title,stage:survey.stage,form:schema,answers:JSON.parse(original.answers_json)};
    }
    if (method==='POST'&&responseRoute[2]==='corrections') {
      const input=await json(req), reason=clean(input.reason,500), answers=validAnswers(schema,input.answers);
      demand(reason,422,'CORRECTION_REASON','請填寫更正理由。');
      const key=id();
      return await tx(async ()=>{
        demand(!await one("SELECT id FROM response_reviews WHERE response_id=? AND status='pending'",original.id),
          409,'CORRECTION_PENDING','此回執已有待審更正。');
        await run('INSERT INTO response_reviews(id,response_id,answers_json,reason,created_at,by_staff) VALUES (?,?,?,?,?,?)',key,original.id,JSON.stringify(answers),reason,iso(),who.staff_id);
        await auditReq(who.staff_id,'response.correction.propose',key,{responseId:original.id});
        return {id:key,status:'pending'};
      });
    }
  }

  const reportRoutes=['/admin/reports/recovery','/admin/reports/outcomes','/admin/reports/export'];
  if (reportRoutes.includes(path)&&method==='GET') {
    await allowed(path.endsWith('export')?'analyst|publisher':'operator|analyst|publisher');
    const output=await report(who,filtersFrom(url));
    if (path.endsWith('export')) {
      await auditReq(who.staff_id,'reports.export',output.filters.eventId??'all',{filters:output.filters,cutoff:output.cutoff});
      return exportCsv(res,'simp-outcomes',[
        ['資料截止',output.cutoff],['計算版本',output.calculationVersion],['條件',JSON.stringify(output.filters)],
        ['場次','方案','實到','後測分子','後測分母','配對分子','配對分母','版本與截止'],...output.eventRows.map(r=>[
          r.title,r.program,r.attendance,r.after.numerator,r.after.denominator,r.paired.numerator,r.paired.denominator,JSON.stringify(r.versions)]),
        ['新版全日蔬食評估（與舊餐數分開）'],['方案','基線','後測','知識配對數','知識平均提升','回溯配對數','回溯平均提升','連結更緊密人數','3/6月追蹤','重複追蹤配對','衰退比例','幹部回覆','幹部總時數','幹部能力提升人數','能力平均提升','幹部無謂比例','幹部活動歸因比例'],
        ...output.assessment.map(r=>[r.program,r.baseline,r.post,r.knowledgePairs,r.knowledgeGain,r.recalledPairs,r.recalledGain,r.connected,JSON.stringify(r.follow),r.repeatPairs,r.dropOff,r.cadreCount,r.cadreHours,r.cadreImproved,r.cadreAverageGain,r.cadreDeadweight,r.cadreActivityShare])
      ]);
    }
    return output;
  }
  if (path==='/admin/evidence'&&method==='GET') {
    await allowed('operator|analyst|publisher');
    const eventId=url.searchParams.get('eventId');
    if (eventId) await scope(who,await getEvent(eventId));
    const rows=await all(`SELECT d.*,e.title AS event_title,e.org_id,a.digest FROM evidence d JOIN events e ON e.id=d.event_id LEFT JOIN assets a ON a.id=d.asset_id
      ORDER BY d.created_at DESC,d.id`);
    return page((await filterAsync(rows, async r=>await inOrg(who.org_id,r.org_id)&&(!eventId||r.event_id===eventId))),url);
  }
  if (path==='/admin/evidence/files' && method==='POST') {
    await allowed('operator|analyst');
    return await upload(req,who.staff_id,'evidence');
  }
  if (path==='/admin/evidence'&&method==='POST') {
    await allowed('operator|analyst');
    const input=await json(req), event=await getEvent(clean(input.eventId));
    await scope(who,event);
    const title=clean(input.title), source=clean(input.source), version=clean(input.version,30), attachment=clean(input.assetId,70)||null;
    demand(title&&source&&version,422,'EVIDENCE_FIELDS','請填寫標題、來源及證據版本。');
    if (attachment) demand(await one("SELECT id FROM assets WHERE id=? AND owner_id=? AND purpose='evidence'",attachment,who.staff_id),403,'FILE_FORBIDDEN','附件不屬於目前的操作帳號。');
    const evidenceId=id();
    await run(`INSERT INTO evidence(id,event_id,title,source,recorded_at,version,note,asset_id,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      evidenceId,event.id,title,source,date(input.recordedAt),version,clean(input.note,1000),attachment,iso(),who.staff_id);
    await auditReq(who.staff_id,'evidence.add',evidenceId);
    return {id:evidenceId,status:'pending'};
  }
  const eRoute=path.match(/^\/admin\/evidence\/([^/]+)\/(file|review)$/);
  if (eRoute) {
    const item=await one('SELECT * FROM evidence WHERE id=?',eRoute[1]);
    demand(item,404,'EVIDENCE_NOT_FOUND','找不到此證據。');
    await scope(who,await getEvent(item.event_id));
    if (eRoute[2]==='file'&&method==='GET') {
      await allowed('operator|analyst|publisher');
      const asset=await one('SELECT * FROM assets WHERE id=?',item.asset_id);
      demand(asset,404,'FILE_NOT_FOUND','這份證據沒有附件。');
      await auditReq(who.staff_id,'evidence.file.read',item.id);
      return assetResponse(res,asset);
    }
    if (eRoute[2]==='review'&&method==='POST') {
      await allowed('publisher');
      const input=await json(req);
      demand(item.status==='pending'&&item.created_by!==who.staff_id&&clean(input.reason,400),409,'EVIDENCE_REVIEW','須由另一個帳號審查待審證據並填寫理由。');
      const status=input.approve===true?'approved':'rejected';
      await run('UPDATE evidence SET status=? WHERE id=?',status,item.id);
      await auditReq(who.staff_id,'evidence.review',item.id,{status,reason:clean(input.reason,400)});
      return {ok:true};
    }
  }
  if (path==='/admin/metric-snapshots'&&method==='GET') {
    await allowed('analyst|publisher');
    return page((await filterAsync((await all(`SELECT s.*,e.title,e.org_id FROM snapshots s JOIN events e ON e.id=s.event_id ORDER BY s.created_at DESC,s.id`)), async r=>await inOrg(who.org_id,r.org_id))).map(r=>({...r,report:JSON.parse(r.report_json),evidenceIds:JSON.parse(r.evidence_ids),report_json:undefined,evidence_ids:undefined})),url);
  }
  if (path==='/admin/metric-snapshots'&&method==='POST') {
    await allowed('analyst');
    const input=await json(req), event=await getEvent(clean(input.eventId)), reason=clean(input.reason,500);
    await scope(who,event);
    const evidenceIds=Array.isArray(input.evidenceIds)?[...new Set(input.evidenceIds)].slice(0,60):[];
    demand(reason&&evidenceIds.length&&(await Promise.all(evidenceIds.map(async key=>await one("SELECT id FROM evidence WHERE id=? AND event_id=? AND status='approved'",clean(key),event.id)))).every(Boolean),
      422,'SNAPSHOT_EVIDENCE','需填寫製作理由並選取此場次已核准的證據。');
    const data=await report(who,{eventId:event.id,stage:input.stage||'T2'}), key=id();
    await run('INSERT INTO snapshots VALUES (?,?,NULL,?,?,?,NULL,?,?,?)',key,who.staff_id,event.id,'pending',iso(),reason,JSON.stringify(evidenceIds),JSON.stringify(data));
    await auditReq(who.staff_id,'snapshot.create',key,{cutoff:data.cutoff,version:data.calculationVersion});
    return {id:key,status:'pending'};
  }
  const snapshot=path.match(/^\/admin\/metric-snapshots\/([^/]+)\/review$/);
  if (snapshot&&method==='POST') {
    await allowed('publisher');
    const input=await json(req), item=await one('SELECT * FROM snapshots WHERE id=?',snapshot[1]);
    demand(item,404,'SNAPSHOT_NOT_FOUND','找不到成果快照。');
    await scope(who,await getEvent(item.event_id));
    demand(item.status==='pending'&&item.author!==who.staff_id&&clean(input.reason,500),409,'SECOND_REVIEW','需由另一個帳號複核並填寫理由。');
    const status=input.approve===true?'published':'rejected';
    await run('UPDATE snapshots SET status=?,reviewer=?,published_at=? WHERE id=?',status,who.staff_id,status==='published'?iso():null,item.id);
    await auditReq(who.staff_id,'snapshot.review',item.id,{status,reason:clean(input.reason,500)});
    return {ok:true};
  }

  if (path==='/admin/audit'&&method==='GET') {
    await allowed('admin');
    demand(!who.org_id,403,'ORG_FORBIDDEN','僅全平台管理員可查看系統稽核。');
    const term=url.searchParams.get('q')??'';
    return page((await all('SELECT * FROM audit ORDER BY seq DESC')).filter(r=>!term||(r.action+' '+r.target).includes(term)),url,'seq');
  }
  throw new Problem(404,'NOT_FOUND','找不到管理介面。');
}

const mimeTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png'};
const web=new URL('../web/',import.meta.url);
const server=createServer((req,res)=>{
  const requestId=id();
  requestContext.run(requestId,async()=>{
    try {
      res.setHeader('X-Request-ID',requestId);
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('X-Frame-Options','DENY');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url=new URL(req.url??'/',tlsOrigin??'http://localhost');
      const method=req.method??'GET';
      if (url.pathname.startsWith('/api/v1/')) {
        res.setHeader('Cache-Control','no-store');
        if (['POST','PATCH','PUT','DELETE'].includes(method)) {
          const origin=req.headers.origin;
          const expected=tlsOrigin??(process.env.VERCEL?'https://':'http://')+req.headers.host;
          demand(req.headers['sec-fetch-site']!=='cross-site'&&(!origin||origin===expected),403,'ORIGIN_FORBIDDEN','請由本站送出操作。');
        }
        const path=url.pathname.slice(7);
        const output=path.startsWith('/integrations/')?await integration(req,path,method):path.startsWith('/auth/')?await auth(req,res,path,method,url):
          path.startsWith('/admin/')?await administration(req,res,path,method,url):await participant(req,res,path,method,url);
        if (!res.writableEnded) {
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
          res.end(JSON.stringify(output));
        }
        return;
      }
      demand(method==='GET',405,'METHOD','此頁面只接受瀏覽請求。');
      const pathname=url.pathname;
      const file=pathname==='/'||pathname==='/admin'||pathname==='/admin/'?'index.html':pathname.slice(1);
      demand(/^(?:[\w-]+\.(?:js|css)|assets\/[\w-]+\.(?:webp|svg|woff2|jpg|png)|index\.html)$/.test(file),404,'PAGE_NOT_FOUND','找不到頁面。');
      let content;
      try { content=await readFile(new URL(file,web)); } catch { throw new Problem(404,'PAGE_NOT_FOUND','找不到頁面。'); }
      res.writeHead(200,{'Content-Type':mimeTypes[extname(file)],'Cache-Control':file.startsWith('assets/')?'public, max-age=3600':'no-cache'});
      res.end(content);
    } catch(error) {
      if (res.writableEnded || res.destroyed) return;
      const known=error instanceof Problem;
      if (!known) console.error('internal_error',requestId,(error as Error).message);
      res.writeHead(known?error.status:500,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({error:{code:known?error.code:'SERVER_ERROR',message:known?error.message:'系統暫時無法處理這項操作。',requestId}}));
    }
  });
});
const host=process.env.HOST??'127.0.0.1', port=Number(process.env.PORT??3030);
server.listen(port,host,()=>console.log('SIMP '+(demo?'Demo':'Service')+' listening on http://'+host+':'+(server.address() as any).port));
const timer=setInterval(()=>processQueue().catch(error=>console.error('queue_error',error.message)),500);
timer.unref();
