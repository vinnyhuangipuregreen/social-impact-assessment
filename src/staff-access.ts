import { all, one, run, tx, audit } from './store.ts';
import { demand } from './domain.ts';

export const STAFF_ROLES={
  operator:'活動營運',identity:'身分審核',analyst:'成果分析',publisher:'審校發布',admin:'系統管理員'
};

export async function staffAccessList() {
  return {
    items:await all(`SELECT s.id,s.label,s.role,s.org_id,s.active,o.name AS org_name
      FROM staff s LEFT JOIN org_units o ON o.id=s.org_id ORDER BY (s.role='admin') DESC,s.id`),
    roles:Object.entries(STAFF_ROLES).map(([id,name])=>({id,name}))
  };
}

export async function saveStaffAccess(key:string|undefined,input:any,actor:string) {
  return tx(async()=>{
    const current=key?await one('SELECT * FROM staff WHERE id=?',key):null;
    demand(!key||current,404,'STAFF_NOT_FOUND','找不到此後台帳號。');
    const id=key??(typeof input.id==='string'?input.id.trim():'');
    const label=typeof input.label==='string'?input.label.trim():'';
    const reason=typeof input.reason==='string'?input.reason.trim():'';
    demand(id.length>0&&id.length<=100&&!/[\s/\\]/.test(id)&&label.length>0&&label.length<=80,422,'STAFF_FIELDS','請填寫有效的帳號識別碼與顯示名稱。');
    demand(Object.hasOwn(STAFF_ROLES,input.role)&&typeof input.active==='boolean',422,'STAFF_ROLE','請選擇有效角色與啟用狀態。');
    demand(reason.length>0&&reason.length<=500,422,'STAFF_REASON','請填寫權限異動理由。');
    const org=typeof input.orgId==='string'?input.orgId.trim()||null:null;
    demand(input.role!=='admin'||!org,422,'ADMIN_SCOPE','系統管理員的管理範圍須為全平台。');
    demand(!org||await one('SELECT id FROM org_units WHERE id=?',org),422,'STAFF_ORG','請選擇有效的管理範圍。');
    if (!current) demand(!await one('SELECT id FROM staff WHERE id=?',id),409,'STAFF_EXISTS','此帳號已存在，請編輯既有帳號。');
    if (current?.role==='admin'&&current.active&&(!input.active||input.role!=='admin')) {
      demand((await one("SELECT COUNT(*) AS n FROM staff WHERE role='admin' AND active=1 AND id<>?",id)).n>0,
        409,'LAST_ADMIN','至少須保留一位啟用中的系統管理員。');
    }
    if (current) await run('UPDATE staff SET label=?,role=?,org_id=?,active=?,access_managed=1 WHERE id=?',label,input.role,org,Number(input.active),id);
    else await run('INSERT INTO staff(id,label,role,org_id,active,access_managed) VALUES (?,?,?,?,?,1)',id,label,input.role,org,Number(input.active));
    const accessChanged=current&&(current.role!==input.role||current.org_id!==org||Boolean(current.active)!==input.active);
    if (accessChanged) await run('DELETE FROM sessions WHERE staff_id=?',id);
    await audit(actor,current?'access.update':'access.create',id,{
      reason,before:current?{role:current.role,orgId:current.org_id,active:Boolean(current.active)}:null,
      after:{role:input.role,orgId:org,active:input.active},sessionsRevoked:Boolean(accessChanged)
    });
    return {id,sessionsRevoked:Boolean(accessChanged)};
  });
}
