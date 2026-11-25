const shapes={
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>', diagonal:'<path d="M6 18 18 6M8 6h10v10"/>', pin:'<path d="M20 10c0 4.7-8 10-8 10s-8-5.3-8-10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  doc:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
  send:'<path d="M21 3 3 10l7 3 4 8 7-18ZM10 13l6-5"/>',
  chart:'<path d="M3 3v18h18M8 16v-4m5 4V8m5 8V5"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  user:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  people:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m4 9v-2a5 5 0 0 0-4-5"/>',
  shield:'<path d="M12 22s7-3.5 7-10.5V5l-7-3-7 3v6.5C5 18.5 12 22 12 22Z"/><path d="m9 12 2 2 4-4"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>', menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  check:'<path d="m5 12 4 4 10-10"/>', add:'<path d="M12 5v14M5 12h14"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  search:'<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  leaf:'<path d="M4 20c3-5 8-9 12-11M6 16C2 7 12 3 21 4c0 9-5 15-13 14"/>',
  pulse:'<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 3 3 4-4 4 4"/>'
};
export const icon=(key,size=18)=>'<svg aria-hidden="true" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+(shapes[key]??'')+'</svg>';
export const e=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const o=(value,label,selected)=>'<option value="'+e(value)+'" '+(value===selected?'selected':'')+'>'+e(label)+'</option>';
export const fdate=(value,zone='Asia/Taipei',time=false)=>value?new Intl.DateTimeFormat('zh-TW',{timeZone:zone,month:'2-digit',day:'2-digit',year:'numeric',...(time?{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}:{})}).format(new Date(value)).replaceAll('/','.'):'—';
export const percent=r=>r?.percent===null||r?.percent===undefined?'資料不足':r.percent+'%';
export const fraction=r=>r?new Intl.NumberFormat('zh-TW').format(r.numerator)+' / '+new Intl.NumberFormat('zh-TW').format(r.denominator):'—';
export const nfmt=(v,precision=1)=>v===null||v===undefined?'—':new Intl.NumberFormat('zh-TW',{maximumFractionDigits:precision}).format(v);
export const groupNames={operator:'活動營運',identity:'身分審核',analyst:'成果分析',publisher:'審校發布',admin:'系統管理員'};
export const names={draft:'草稿',published:'已發布',completed:'已完成',archived:'已封存',cancelled:'已取消',registered:'已報名',attended:'已簽到',
  pending:'待處理',verified:'已核驗',rejected:'退補／駁回',nonmember:'非佛光會員',retired:'已停用',scheduled:'已排程',
  running:'發送中',partial_failed:'部分失敗',accepted:'已接受',delivered:'確認送達',skipped:'已跳過',unknown:'結果待查核',
  failed:'失敗',processing:'處理中',approved:'已核准',open:'可填答',closed:'已截止',done:'已完成',upcoming:'待開放',blocked:'資格未完成',
  received:'已收件',reviewing:'審查中',resolved:'已結案',proposed:'待複核',eligible:'可登錄'};
export const pill=(status,label)=>'<span class="pill tone-'+e(status)+'">'+e(label??names[status]??status)+'</span>';
export const brand=(dark=false)=>'<span class="brand '+(dark?'brand-inverse':'')+'"><img src="/assets/mark.svg" alt="" width="40" height="40"><span><strong>SIA</strong><small>社會影響力評估</small></span></span>';
export const empty=(title,detail='')=>'<div class="empty">'+icon('leaf',26)+'<strong>'+e(title)+'</strong>'+(detail?'<p>'+e(detail)+'</p>':'')+'</div>';

export async function api(path,options={}) {
  const {body,method,signal}=options;
  const raw=body instanceof Blob;
  const response=await fetch('/api/v1'+path,{method:method??(body!==undefined?'POST':'GET'),credentials:'same-origin',signal,
    headers:body===undefined?{}:{'Content-Type':raw?body.type:'application/json'},body:raw?body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message??'操作暫時無法完成。'),{code:data.error?.code,status:response.status});
  return data;
}
export async function items(path) {
  const all=[];
  let cursor;
  do {
    const result=await api(path+(path.includes('?')?'&':'?')+'limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    all.push(...result.items);
    cursor=result.nextCursor;
  } while(cursor);
  return all;
}
const dialog=document.querySelector('#dialog');
let toastTimer;
export function message(text,kind='good') {
  const toast=document.querySelector('#toast');
  toast.className='toast '+kind;
  toast.textContent=text;
  toast.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.hidden=true,4800);
}
export function close() { if (dialog.open) dialog.close(); }
export function modal(title,content,options={}) {
  dialog.className=options.wide?'wide':'';
  dialog.innerHTML='<div class="dialog-head"><h2 id="dialog-title">'+e(title)+'</h2><button class="icon-button" type="button" data-close aria-label="關閉">'+icon('close')+'</button></div><div class="dialog-content">'+content+'</div>';
  dialog.querySelector('[data-close]').onclick=close;
  if (!dialog.open) dialog.showModal();
  return dialog;
}
export function bind(root,selector,fn) { for (const el of root.querySelectorAll(selector)) el.addEventListener('click',ev=>fn(el,ev)); }
export function bindForms(root,selector,fn) {
  for (const form of root.querySelectorAll(selector)) form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    if (form.dataset.busy==='1') return;
    form.dataset.busy='1';
    form.querySelector('[type="submit"]')?.setAttribute('disabled','');
    const error=form.querySelector('[data-error]');
    if(error) error.textContent='';
    try { await fn(new FormData(form),form,ev.submitter); }
    catch(err) { if (error) error.textContent=err.message; else message(err.message,'error'); }
    finally { form.dataset.busy='0'; for (const button of form.querySelectorAll('[type="submit"]')) button.removeAttribute('disabled'); }
  });
}
export const errorSlot='<p class="form-error" data-error role="alert"></p>';
export const btn=(label,classes='primary',attrs='',symbol='')=>'<button class="button '+classes+'" type="button" '+attrs+'>'+e(label)+(symbol?icon(symbol):'')+'</button>';
export const submit=(label,classes='primary')=>'<button type="submit" class="button '+classes+'">'+e(label)+icon('arrow',16)+'</button>';
export const field=(label,content,help='')=>'<label class="field"><span>'+e(label)+'</span>'+content+(help?'<small>'+e(help)+'</small>':'')+'</label>';
export const input=(name,value='',type='text',attr='')=>'<input type="'+type+'" name="'+e(name)+'" value="'+e(value)+'" '+attr+'>';
export const select=(name,options,attr='')=>'<select name="'+e(name)+'" '+attr+'>'+options+'</select>';
export const zoneDate=v=>v?new Date(v).toISOString():undefined;
export const query=(args)=>new URLSearchParams(Object.fromEntries(Object.entries(args).filter(([,v])=>v))).toString();
