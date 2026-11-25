import {api,items,bind,bindForms,bindResidenceSelects,residenceCityOptions,brand,btn,close,e,empty,errorSlot,fdate,field,fraction,groupNames,icon,input,message,modal,nfmt,o,percent,pill,query,select,submit,zoneDate} from './ui.js';

export async function startAdmin(root,config) {
  const programMap=new Map(config.programs.map(p=>[p.code,p]));
  const short={VGR:'公益路跑',EARTH:'森林覺醒',VEG:'蔬食指南'};
  const P=code=>programMap.get(code)?.title??code;
  const stages=config.stages;
  const staffOptions={
    operator:'活動營運', 'north6-ops':'北市北第六區承辦', 'north3-ops':'北市北第三區承辦',
    reviewer:'身分審核', reviewer2:'身分複核', 'north3-analyst':'北市北第三區分析', analyst:'成果分析',publisher:'審校發布',admin:'系統管理員'
  };
  const pages=[
    ['dashboard','總覽儀表板','grid','operator|analyst|publisher'],
    ['events','活動與簽到','calendar','operator'],
    ['versions','問卷與版本','doc','operator|publisher'],
    ['dispatch','問卷派送','send','operator'],
    ['reports','成效報表','chart','operator|analyst|publisher'],
    ['evidence','證據與快照','folder','operator|analyst|publisher'],
    ['corrections','回覆更正','doc','analyst|publisher'],
    ['members','會員與權利請求','people','identity'],
    ['locations','縣市地區維護','pin','admin'],
    ['audit','稽核紀錄','shield','admin']
  ];
  let me=await api('/admin/me').catch(error=>{if(error.status===401)return null;throw error;});
  let events=[], versions=[], routeCounter=0;
  let reportFilters={};
  const pageState={};
  const facets=()=>config.organizations.filter(org=>org.kind==='district').map(x=>o(x.id,x.name,reportFilters.district)).join('');
  const can=roles=>roles.split('|').includes(me?.role);
  const pOptions=(selected)=>config.programs.map(p=>o(p.code,p.title,selected)).join('');
  const eventOptions=(selected)=>events.map(ev=>o(ev.id,ev.title,selected)).join('');
  const stageOptions=(selected,list=Object.keys(stages))=>list.map(stage=>o(stage,stage+' · '+stages[stage],selected)).join('');
  const staffTitle=()=>groupNames[me?.role]??'';
  const asLocal=(value,zone='Asia/Taipei')=>{
    if (!value) return '';
    const format=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,dateStyle:'short',timeStyle:'short',hourCycle:'h23'});
    return format.format(new Date(value)).replace(' ','T');
  };
  function zonedISO(value,zone) {
    if (!value) return undefined;
    const wall=Date.parse(value+'Z');
    if (!Number.isFinite(wall)) throw new Error('請輸入正確的日期時間。');
    let instant=wall;
    for(let step=0;step<3;step++) instant+=wall-Date.parse(asLocal(new Date(instant).toISOString(),zone)+'Z');
    if(asLocal(new Date(instant).toISOString(),zone)!==value) throw new Error('該時間在選定時區無效。');
    return new Date(instant).toISOString();
  }
  const title=(label,desc,actions='')=>'<div class="section-head admin-section-head"><div><h1>'+e(label)+'</h1><p>'+e(desc)+'</p></div>'+actions+'</div>';
  const stateTitle=(status)=>pill(status,status==='pending'?'待審核':undefined);
  const backButton='<a href="/" class="button secondary">'+icon('diagonal',17)+'開啟活動前台</a>';
  const numbered=(title)=>'<span class="column-title">'+e(title)+'</span>';
  const table=(headers,rows)=>rows.length?'<div class="table-wrap"><table><thead><tr>'+headers.map(v=>'<th scope="col">'+e(v)+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':empty('目前沒有符合條件的紀錄');
  const cols=(...content)=>'<div class="form-grid">'+content.join('')+'</div>';
  const selEvent=(selected,attr='')=>select('eventId',o('','請選擇場次')+eventOptions(selected),attr);
  const rowActions=(...actions)=>'<div class="row-wrap actions">'+actions.join('')+'</div>';
  const section=(title,body,actions='')=>'<section class="card admin-card"><div class="card-head"><h2>'+e(title)+'</h2>'+actions+'</div>'+body+'</section>';
  const dateField=(label,name,value='',zone='Asia/Taipei',attrs='')=>field(label,input(name,asLocal(value,zone),'datetime-local',attrs));
  const pagination=(result,key)=>'<div class="pagination"><span>共 '+result.total+' 筆</span>'+btn('上一頁','secondary small','data-page-prev="'+key+'" '+((pageState[key]?.back.length??0)?'':'disabled'))+
    btn('下一頁','secondary small','data-page-next="'+key+'" data-cursor="'+e(result.nextCursor??'')+'" '+(result.nextCursor?'':'disabled'))+'</div>';
  async function getPage(path,key) {
    return api(path+(path.includes('?')?'&':'?')+'limit=10'+(pageState[key]?.cursor?'&cursor='+encodeURIComponent(pageState[key].cursor):''));
  }
  function bindPagination(target) {
    bind(target,'[data-page-next]',el=>{const state=pageState[el.dataset.pageNext]??={cursor:'',back:[]};state.back.push(state.cursor);state.cursor=el.dataset.cursor;render();});
    bind(target,'[data-page-prev]',el=>{const state=pageState[el.dataset.pagePrev];state.cursor=state.back.pop();render();});
  }
  function confirmAction(label,description,action) {
    const box=modal(label,'<form class="form-stack"><p>'+e(description)+'</p>'+errorSlot+submit(label)+'</form>');
    bindForms(box,'form',async()=>{await action();close();message('操作已完成。');await render();});
  }
  function reasonAction(label,desc,action) {
    const box=modal(label,'<form class="form-stack"><p>'+e(desc)+'</p>'+field('處理理由','<textarea name="reason" rows="4" required maxlength="500"></textarea>')+errorSlot+submit(label)+'</form>');
    bindForms(box,'form',async data=>{await action(data.get('reason'));close();message('紀錄已更新。');await render();});
  }
  function selectedRoute() {
    const enabled=pages.filter(page=>can(page[3]));
    return enabled.find(page=>page[0]===location.hash.slice(1))?.[0]??enabled[0]?.[0];
  }
  function login() {
    root.innerHTML='<main id="main" class="admin-login"><div class="admin-login-cover"><a href="/" class="brand-link">'+brand(true)+'</a><div><p class="eyebrow">綠色公益基金會</p><h1>記錄行動，<br>衡量影響。</h1></div><a href="/" class="button on-dark">'+icon('arrow',16)+'返回活動前台</a></div>'+
      '<div class="admin-login-main"><section class="card panel login-panel"><h2>管理後台登入</h2><p>使用授權帳號管理活動、問卷與成效資料。</p><form class="form-stack">'+
      (config.demo?field('示範角色',select('account',Object.entries(staffOptions).map(([key,label])=>o(key,label,'operator')).join('')))+'<p class="note">Demo 帳號採用合成資料，選擇角色即可體驗不同權限。</p>':
        field('帳號',input('account','','text','required autocomplete="username"'))+field('密碼',input('password','','password','required autocomplete="current-password"'))+field('多因子驗證碼',input('mfa','','text','required autocomplete="one-time-code"')))+errorSlot+submit('登入後台')+'</form></section></div></main>';
    bindForms(root,'form',async data=>{me=await api('/auth/admin/login',{body:Object.fromEntries(data)});await render();message('已登入管理後台。');});
  }
  async function render() {
    const serial=++routeCounter;
    if (!me) {login();return;}
    const route=selectedRoute();
    const links=pages.filter(page=>can(page[3]));
    if (!root.classList.contains('admin-root')) root.classList.add('admin-root');
    root.innerHTML='<div class="admin-shell"><aside class="admin-sidebar" aria-label="管理選單"><a class="brand-link" href="/admin">'+brand(true)+'</a>'+
      '<span class="sidebar-kicker">管理工作台</span><nav>'+links.map(([key,label,symbol])=>'<a href="#'+key+'" '+(route===key?'class="active" aria-current="page"':'')+'>'+icon(symbol,19)+e(label)+'</a>').join('')+'</nav>'+
      '<div class="sidebar-foot"><span class="profile-square">'+icon('user')+'</span><div><strong>'+e(me.label)+'</strong><small>'+e(staffTitle())+'</small></div></div></aside>'+
      '<div class="admin-frame"><header class="admin-topbar"><div class="row-wrap"><button class="icon-button admin-mobile-toggle" type="button" aria-label="管理選單" aria-expanded="false">'+icon('menu')+'</button><span>管理後台</span><span class="crumb">/</span><strong>'+e(pages.find(p=>p[0]===route)?.[1])+'</strong></div>'+
      '<div class="row-wrap">'+(config.demo?'<span class="mode"><span></span> Demo 模式</span>':'')+'<a href="/" class="back-top">活動前台 '+icon('diagonal',15)+'</a>'+btn('登出','quiet small','data-logout')+'</div></header>'+
      '<main id="main" class="admin-main"><div class="loading" aria-busy="true">正在讀取資料…</div></main></div></div>';
    bind(root,'[data-logout]',async()=>{try{await api('/auth/admin/logout',{body:{}});me=null;await render();}catch(error){message(error.message,'error');}});
    const menu=root.querySelector('.admin-mobile-toggle');
    menu.onclick=()=>{const active=root.querySelector('.admin-shell').classList.toggle('show-sidebar');menu.setAttribute('aria-expanded',String(active));};
    const target=root.querySelector('#main');
    try {
      if (can('operator|analyst|publisher')) events=await items('/admin/events');
      if(serial!==routeCounter) return;
      await ({dashboard,events:eventPage,versions:versionPage,dispatch,reports,evidence:library,corrections,members,locations:locationPage,audit:auditPage}[route])(target);
      bindPagination(target);
    }catch(error) {
      if(serial===routeCounter) target.innerHTML=empty('無法載入資料',error.message);
    }
  }
  function metricCard(title,value,desc,symbol,tint='') {
    return '<article class="card kpi '+tint+'"><div class="row-between"><span>'+e(title)+'</span><span class="kpi-icon">'+icon(symbol,18)+'</span></div><strong>'+e(value)+'</strong><small>'+e(desc)+'</small></article>';
  }
  function progress(label,data,color='green') {
    return '<div class="progress-row"><div class="row-between"><strong>'+e(label)+'</strong><span>'+e(percent(data))+'</span></div><progress class="'+color+'" value="'+(data?.percent??0)+'" max="100">'+e(percent(data))+'</progress><small>'+e(fraction(data))+'</small></div>';
  }
  function eventResultTable(rows) {
    return table(['活動場次','實到人數','後測回收率','基線配對率'],rows.map(r=>[
      '<div class="table-event"><span class="event-dot '+e(r.program)+'"></span><div><strong>'+e(r.title)+'</strong><small>'+e(short[r.program])+'</small></div></div>',
      nfmt(r.attendance),e(percent(r.after))+' <small>('+e(fraction(r.after))+')</small>',e(percent(r.paired))+' <small>('+e(fraction(r.paired))+')</small>'
    ]));
  }
  async function dashboard(target) {
    const data=await api('/admin/reports/recovery');
    const progressByProgram=config.programs.map(p=>{
      const rows=data.eventRows.filter(row=>row.program===p.code);
      const den=rows.reduce((sum,row)=>sum+row.paired.denominator,0),num=rows.reduce((sum,row)=>sum+row.paired.numerator,0);
      return progress(short[p.code],{denominator:den,numerator:num,percent:den?Math.round(num/den*1000)/10:null},p.code==='VEG'?'gold':p.code==='EARTH'?'light':'green');
    }).join('');
    target.innerHTML=title('總覽儀表板','查看公益方案的參與、問卷回收與追蹤成效。',backButton)+
      '<div class="dashboard-banner"><div><span class="eyebrow"><span></span> 永續方案成效</span><h2>社會影響力總覽</h2><p>資料截止 '+fdate(data.cutoff,'Asia/Taipei',true)+' · '+e(data.kind)+'</p></div><a class="button lime" href="#reports">查看成效報表 '+icon('arrow',17)+'</a></div>'+
      '<div class="kpi-grid">'+metricCard('跨方案參與者',nfmt(data.unique,0),'同一平台帳號跨場次去重','people')+
      metricCard('場次實到人次',nfmt(data.attendance,0),'依各場次簽到紀錄','calendar','sage')+
      metricCard('派送回收率',percent(data.recovery),'有效填答 / 接受派送 '+fraction(data.recovery),'send','gold')+
      metricCard('T0–T2 配對率',percent(data.paired),'有效配對 / 有效 T0 '+fraction(data.paired),'pulse','sage')+'</div>'+
      '<div class="dashboard-grid">'+section('各場次問卷表現',eventResultTable(data.eventRows.slice(0,6)))+
       section('各方案 T0–T2 配對率','<div class="progress-list">'+progressByProgram+'</div>')+'</div>';
  }
  let eventSearch='';
  async function eventPage(target) {
    const result=await getPage('/admin/events?'+query({q:eventSearch}),'events');
    target.innerHTML=title('活動與簽到','建立活動場次、綁定問卷版本並登錄實際出席。',btn('新增場次','primary','data-new-event','add'))+
      section('場次清單','<form id="event-search" class="inline-form">'+input('q',eventSearch,'search','aria-label="搜尋場次" placeholder="搜尋活動或地點"')+submit('搜尋','secondary')+'</form>'+
      table(['場次名稱','舉行時間','報名人數','狀態','操作'],result.items.map(ev=>[
        '<strong>'+e(ev.title)+'</strong><small class="cell-detail">'+e(ev.region+' · '+ev.venue)+'</small>',
        fdate(ev.starts_at,ev.timezone,true),nfmt(ev.roster,0),pill(ev.status),
        rowActions(btn('設定','secondary small','data-edit="'+e(ev.id)+'"'),btn('名單與簽到','quiet small','data-roster="'+e(ev.id)+'"'))]))+pagination(result,'events'));
    bindForms(target,'#event-search',async data=>{eventSearch=data.get('q');delete pageState.events;await render();});
    bind(target,'[data-new-event]',()=>eventEditor());
    bind(target,'[data-edit]',el=>eventDetails(events.find(ev=>ev.id===el.dataset.edit)));
    bind(target,'[data-roster]',el=>roster(events.find(ev=>ev.id===el.dataset.roster)));
  }
  function eventEditor(ev=null) {
    const zone=ev?.timezone??'Asia/Taipei';
    const box=modal(ev?'編輯草稿場次':'新增活動場次','<form class="form-stack">'+cols(
      field('方案',select('program',pOptions(ev?.program),'required')),field('場次名稱',input('title',ev?.title??'','text','required maxlength="160"')))+cols(
      field('地區',input('region',ev?.region??'','text','required placeholder="例如：臺北市"')),field('地點',input('venue',ev?.venue??'','text','required')))+cols(
      field('承辦組織',select('orgId',o('','請選擇組織')+config.organizations.map(org=>o(org.id,org.name,ev?.org_id)).join(''),'required')),
      field('時區',input('timezone',zone,'text','required')))+cols(
      dateField('活動開始','startsAt',ev?.starts_at,zone,'required'),dateField('活動結束','endsAt',ev?.ends_at,zone,'required'))+cols(
      dateField('開放報名','registrationOpens',ev?.registration_opens,zone,'required'),dateField('截止報名','registrationCloses',ev?.registration_closes,zone,'required'))+
      field('指南追蹤起算日',select('anchorType',o('event_end','活動結束日',ev?.anchor_type)+o('first_activation','每人首次啟用日',ev?.anchor_type)))+
      errorSlot+submit('儲存場次草稿')+'</form>',{wide:true});
    bindForms(box,'form',async fields=>{
      const data=Object.fromEntries(fields);
      for(const key of ['startsAt','endsAt','registrationOpens','registrationCloses']) data[key]=zonedISO(data[key],data.timezone);
      const result=await api('/admin/events'+(ev?'/'+ev.id:''),{method:ev?'PATCH':'POST',body:data});
      close();message('場次草稿已儲存。');await render();
      eventDetails(events.find(item=>item.id===result.id));
    });
  }
  function eventDetails(ev) {
    const actionMap={draft:[['published','正式發布'],['cancelled','取消場次']],published:[['completed','標記已完成'],['cancelled','取消場次']],completed:[['archived','封存場次'],['cancelled','取消場次']]};
    const actionNames=actionMap[ev.status]??[];
    const box=modal(ev.title,'<div class="form-stack"><div class="row-between"><span>'+e(P(ev.program))+' · '+e(ev.timezone)+'</span>'+pill(ev.status)+'</div>'+
      '<div class="row-wrap">'+(ev.status==='draft'?btn('編輯基本資料','secondary small','data-ev-edit')+btn('設定問卷階段','secondary small','data-stage-edit','add'):'')+
      actionNames.map(([status,label])=>btn(label,status==='published'?'primary small':'quiet small','data-status="'+status+'"')).join('')+
      (['published','completed'].includes(ev.status)?btn('場次連結','secondary small','data-event-link','diagonal'):'')+'</div>'+
      table(['階段','版本','開放時間','截止時間',''],ev.surveys.map(s=>[e(stages[s.stage]),'v'+s.version,fdate(s.opens_at,ev.timezone,true),fdate(s.closes_at,ev.timezone,true),
        ev.status==='draft'?btn('移除','quiet small','data-remove-stage="'+e(s.stage)+'"'):'']))+'</div>',{wide:true});
    bind(box,'[data-ev-edit]',()=>eventEditor(ev));
    bind(box,'[data-event-link]',()=>entryLink('event',ev.id));
    bind(box,'[data-survey-link]',el=>entryLink('survey',el.dataset.surveyLink));
    function entryLink(key,id) {
      const link=new URL('/',location.origin);
      link.searchParams.set(key,id);
      const share=modal('公開入口連結','<div class="form-stack">'+field('連結',input('url',link.href,'url','readonly'))+
        '<p class="note">連結僅含場次或問卷識別碼，可用於活動 QR。問卷仍須登入並符合填答資格。</p>'+
        btn('複製連結','primary','data-copy-link','doc')+'</div>');
      bind(share,'[data-copy-link]',async()=>{try{await navigator.clipboard.writeText(link.href);message('已複製連結。');}catch{share.querySelector('input').select();}});
    }
    bind(box,'[data-stage-edit]',()=>stageEditor(ev));
    bind(box,'[data-status]',el=>confirmAction(el.textContent,'此操作將更新所有前後台的場次狀態。',()=>api('/admin/events/'+ev.id+'/status',{body:{status:el.dataset.status}})));
    bind(box,'[data-remove-stage]',el=>confirmAction('移除階段','此操作將移除草稿場次的問卷設定。',()=>api('/admin/events/'+ev.id+'/surveys',{body:{stage:el.dataset.removeStage,remove:true}})));
  }
  async function stageEditor(ev) {
    try {
      versions=await items('/admin/survey-versions?program='+ev.program);
      const available=versions.filter(v=>v.status==='published');
      const box=modal('設定問卷階段','<form class="form-stack">'+cols(field('問卷階段',select('stage',stageOptions(available[0]?.stage,[...new Set(available.map(v=>v.stage))]),'required')),
        field('已發布版本',select('versionId','','required')))+cols(dateField('開放時間（選填）','opensAt','',ev.timezone),dateField('截止時間（選填）','closesAt','',ev.timezone))+
        '<p class="note">未填時間時會使用規格預設排程。此場次使用 '+e(ev.timezone)+'。</p>'+errorSlot+submit('綁定問卷')+'</form>');
      const form=box.querySelector('form');
      const update=()=>{form.elements.versionId.innerHTML=available.filter(v=>v.stage===form.elements.stage.value).map(v=>o(v.id,'v'+v.version)).join('');};
      form.elements.stage.onchange=update;update();
      bindForms(box,'form',async fields=>{
        const data=Object.fromEntries(fields);
        data.opensAt=zonedISO(data.opensAt,ev.timezone);data.closesAt=zonedISO(data.closesAt,ev.timezone);
        await api('/admin/events/'+ev.id+'/surveys',{body:data});
        await render();message('問卷階段已設定。');eventDetails(events.find(row=>row.id===ev.id));
      });
    }catch(error){message(error.message,'error');}
  }
  async function roster(ev,cursor='') {
    try {
      const data=await api('/admin/events/'+ev.id+'/roster?limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      const box=modal('名單與簽到','<p class="note">'+e(ev.title)+'</p>'+
        table(['平台識別碼','卡號','狀態','簽到時間'],data.items.map(r=>['<code>'+e(r.id)+'</code>',e(r.card_mask??'—'),pill(r.status),fdate(r.attended_at,ev.timezone,true)]))+
        (data.nextCursor?btn('下一頁','quiet small','data-roster-next="'+e(data.nextCursor)+'"'):'')+
        (['published','completed'].includes(ev.status)?'<div class="separator"></div><form class="form-stack">'+field('批次輸入平台識別碼','<textarea name="ids" rows="3" required placeholder="每行一筆識別碼"></textarea>')+errorSlot+submit('預覽簽到')+'<div data-preview></div></form>':''),{wide:true});
      bind(box,'[data-roster-next]',el=>roster(ev,el.dataset.rosterNext));
      bindForms(box,'form',async fields=>{
        const ids=fields.get('ids').split(/[,，\n]+/).map(v=>v.trim()).filter(Boolean);
        const result=await api('/admin/events/'+ev.id+'/attendance-imports',{body:{participantIds:ids,preview:true}});
        const panel=box.querySelector('[data-preview]');
        panel.innerHTML=table(['平台識別碼','驗證結果'],result.rows.map(r=>[e(r.id),pill(r.status)]))+btn('確認匯入','primary small','data-import');
        bind(panel,'[data-import]',async()=>{try{const saved=await api('/admin/events/'+ev.id+'/attendance-imports',{body:{participantIds:ids}});message('已登錄 '+saved.rows.filter(r=>r.status==='已登錄').length+' 筆。');await roster(ev);}catch(error){message(error.message,'error');}});
      });
    }catch(error){message(error.message,'error');}
  }

  let versionProgram='',versionStage='';
  async function versionPage(target) {
    const result=await getPage('/admin/survey-versions?'+query({program:versionProgram,stage:versionStage}),'versions');
    target.innerHTML=title('問卷與版本','管理問卷題目、指標口徑與發布狀態。',can('operator')?btn('建立新版本','primary','data-new-ver','add'):'')+
      section('問卷版本清單','<form class="inline-form">'+select('program',o('','全部方案',versionProgram)+pOptions(versionProgram),'aria-label="依方案篩選"')+
      select('stage',o('','全部階段',versionStage)+stageOptions(versionStage),'aria-label="依階段篩選"')+submit('套用','secondary')+'</form>'+
      table(['方案','階段','版本','題數','狀態','操作'],result.items.map(v=>[e(P(v.program)),e(stages[v.stage]),'v'+v.version,v.form.length,pill(v.status),
        rowActions(btn('查看','secondary small','data-view-ver="'+e(v.id)+'"'),
          can('operator')?btn('複製成草稿','quiet small','data-copy-ver="'+e(v.id)+'"'):'',
          ['draft','published'].includes(v.status)?btn(v.status==='draft'?'發布':'停用','quiet small','data-ver-status="'+e(v.id)+'"'):'')]))+pagination(result,'versions'));
    bindForms(target,'form',async data=>{versionProgram=data.get('program');versionStage=data.get('stage');delete pageState.versions;await render();});
    bind(target,'[data-new-ver]',()=>questionEditor());
    bind(target,'[data-copy-ver]',el=>questionEditor(result.items.find(v=>v.id===el.dataset.copyVer)));
    bind(target,'[data-view-ver]',el=>{
      const v=result.items.find(v=>v.id===el.dataset.viewVer);
      modal(P(v.program)+' · '+stages[v.stage],' <p class="note">v'+v.version+'</p>'+table(['題目','代碼','資料格式','指標版本'],v.form.map(q=>[e(q.label),e(q.key),
        e(q.type==='integer'?q.min+'–'+q.max+' '+(q.unit??''):q.options.join('、')),e(q.metricVersion??'—')])),{wide:true});
    });
    bind(target,'[data-ver-status]',el=>{
      const v=result.items.find(v=>v.id===el.dataset.verStatus);
      confirmAction(el.textContent,v.status==='draft'?'發布後的題目與版本將保留。':'已綁定的場次會沿用目前版本。',
        ()=>api('/admin/survey-versions/'+v.id+'/'+(v.status==='draft'?'publish':'retire'),{body:{}}));
    });
  }
  function questionEditor(version) {
    const box=modal('建立問卷草稿','<form class="form-stack">'+cols(field('方案',select('program',pOptions(version?.program))),field('階段',select('stage',stageOptions(version?.stage))))+
      '<div data-questions></div>'+btn('新增題目','secondary','data-add-question','add')+errorSlot+submit('儲存新草稿')+'</form>',{wide:true});
    const area=box.querySelector('[data-questions]');
    function add(q={}) {
      const element=document.createElement('fieldset');element.className='question-block';
      element.innerHTML='<legend>問卷題目</legend>'+cols(field('題目代碼',input('key',q.key??'','text','pattern="[a-z][a-z0-9_]{1,63}" required')),
        field('題型',select('type',o('integer','整數',q.type)+o('choice','單選',q.type))))+
        field('題目文字',input('label',q.label??'','text','required maxlength="300"'))+field('填答提示',input('help',q.help??'','text','maxlength="300"'))+
        '<div data-number>'+cols(field('下限',input('min',q.min??0,'number','min="0"')),field('上限',input('max',q.max??21,'number','min="0"')),
        field('單位',input('unit',q.unit??'')),field('指標定義版本',input('metricVersion',q.metricVersion??'')))+'</div>'+
        '<div data-options>'+field('選項（每行一項）','<textarea name="options" rows="3">'+e(q.options?.join('\n')??'')+'</textarea>')+'</div>'+
        '<div class="row-between"><label class="checkbox"><input name="required" type="checkbox" '+(q.required?'checked':'')+'>必填</label>'+btn('移除此題','quiet small','data-remove-question')+'</div>';
      area.append(element);
      const type=element.querySelector('[name="type"]'), update=()=>{
        element.querySelector('[data-number]').hidden=type.value!=='integer';
        element.querySelector('[data-options]').hidden=type.value!=='choice';
      };
      type.onchange=update;update();
      bind(element,'[data-remove-question]',()=>element.remove());
    }
    for(const q of version?.form??[{}]) add(q);
    bind(box,'[data-add-question]',()=>add());
    bindForms(box,'form',async data=>{
      const form=[...area.children].map(row=>{
        const read=name=>row.querySelector('[name="'+name+'"]').value;
        return {key:read('key'),label:read('label'),help:read('help'),type:read('type'),required:row.querySelector('[name="required"]').checked,
          min:Number(read('min')),max:Number(read('max')),unit:read('unit'),metricVersion:read('metricVersion'),
          options:read('options').split('\n').map(v=>v.trim()).filter(Boolean)};
      });
      await api('/admin/survey-versions',{body:{program:data.get('program'),stage:data.get('stage'),form}});
      close();delete pageState.versions;await render();message('新版本已儲存為草稿。');
    });
  }

  async function dispatch(target) {
    const result=await getPage('/admin/dispatch-jobs','dispatch');
    target.innerHTML=title('問卷派送','依會員卡號或非會員條件建立推播，追蹤接受與回覆。',btn('建立派送','primary','data-new-job','add'))+
      section('派送任務','<div class="note inline-note">回收率以有效回覆人數除以管道接受的去重人數計算。</div>'+
      table(['場次／階段','發送時間','管道接受率','回收率','狀態','操作'],result.items.map(j=>[
        '<strong>'+e(j.title)+'</strong><small class="cell-detail">'+e(stages[j.stage])+'</small>',fdate(j.due_at,'Asia/Taipei',true),e(percent(j.acceptance))+' <small>('+e(fraction(j.acceptance))+')</small>',
        e(percent(j.recovery))+' <small>('+e(fraction(j.recovery))+')</small>',pill(j.status),btn('查看明細','secondary small','data-job="'+e(j.id)+'"')
      ]))+pagination(result,'dispatch'));
    bind(target,'[data-new-job]',()=>jobEditor());
    bind(target,'[data-job]',el=>jobDetail(el.dataset.job));
  }
  function jobEditor() {
    const allowedEvents=events.filter(ev=>['published','completed'].includes(ev.status)&&ev.surveys.length);
    const box=modal('建立問卷派送','<form class="form-stack" id="job-preview">'+cols(
      field('活動場次',select('eventId',allowedEvents.map(ev=>o(ev.id,ev.title)).join(''),'required')),
      field('問卷階段',select('surveyId','','required')))+field('對象',select('audience',o('nonmember','非佛光會員')+o('member','已核驗佛光會員')))+
      '<div data-card-fields hidden>'+field('指定佛光卡號','<textarea name="cards" rows="4" placeholder="以逗號或換行分隔"></textarea>')+
      (config.demo?'<p class="note">測試卡號可用 DEMO0002、DEMO0003、DEMO9999。請選 VEGRUN 北區場 T2。</p>':'')+'</div>'+
      '<div data-nonmember-fields>'+cols(field('居住縣市（選填）',select('residenceCityId',residenceCityOptions(config.residenceLocations,'',false))),
        field('居住地區（選填）',select('residenceDistrictId',o('','請先選擇居住縣市'))))+
        field('參與狀態',select('status',o('','所有符合資格者')+o('attended','已簽到')+o('registered','已報名')))+
      '<p class="note">系統會排除已填答、未同意追蹤與無法透過 LINE OA 觸達的人員。</p></div>'+errorSlot+submit('預覽派送名單')+'</form>',{wide:true});
    const form=box.querySelector('form');
    bindResidenceSelects(form,config.residenceLocations,'',false);
    const updateStage=()=>{form.elements.surveyId.innerHTML=(allowedEvents.find(ev=>ev.id===form.elements.eventId.value)?.surveys??[]).map(s=>o(s.id,s.stage+' · '+stages[s.stage])).join('');};
    const updateType=()=>{ const member=form.elements.audience.value==='member';box.querySelector('[data-card-fields]').hidden=!member;box.querySelector('[data-nonmember-fields]').hidden=member; };
    form.elements.eventId.onchange=updateStage;form.elements.audience.onchange=updateType;updateStage();updateType();
    bindForms(box,'form',async data=>{
      const ev=allowedEvents.find(ev=>ev.id===data.get('eventId'));
      const preview=await api('/admin/dispatch-jobs/preview',{body:{surveyId:data.get('surveyId'),audience:data.get('audience'),cards:data.get('cards'),
        residenceCityId:data.get('residenceCityId'),residenceDistrictId:data.get('residenceDistrictId')||'',statuses:data.get('status')?[data.get('status')]:[]}});
      jobPreview(preview,ev);
    });
  }
  function jobPreview(preview,ev) {
    const box=modal('確認派送名單','<div class="audience-result"><strong>'+nfmt(preview.count,0)+'</strong><span>位對象符合名單條件</span></div>'+
      '<p class="note">名單確認後將固定。實際發送前會重新檢查資格。</p>'+
      '<div class="row-wrap">'+Object.entries(preview.excluded).map(([key,value])=>pill('pending',key+' '+value)).join('')+'</div>'+
      table(['遮罩卡號','類別','居住縣市','居住地區'],preview.recipients.map(r=>[e(r.mask),pill(r.type),e(r.residenceCity||r.region),e(r.residenceDistrict||'—')]))+
      (preview.count?'<form class="form-stack"><div class="separator"></div>'+dateField('排程發送時間（'+ev.timezone+'，留空為立即發送）','dueAt','',ev.timezone)+errorSlot+submit('確認名單並排程')+'</form>':'')+
      '<div class="row-wrap">'+btn('返回重新設定','quiet','data-back-job')+'</div>',{wide:true});
    bind(box,'[data-back-job]',()=>jobEditor());
    bindForms(box,'form',async data=>{
      const job=await api('/admin/dispatch-jobs',{body:{previewId:preview.id,dueAt:zonedISO(data.get('dueAt'),ev.timezone)}});
      close();delete pageState.dispatch;await render();message('派送任務已建立。');await jobDetail(job.id);
    });
  }
  async function jobDetail(jobId,cursor='') {
    try{
      const job=await api('/admin/dispatch-jobs/'+jobId+'?limit=10'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      const box=modal('派送明細','<div class="form-stack"><div class="row-between"><strong>'+e(job.title)+' · '+e(stages[job.stage])+' v'+job.version+'</strong>'+pill(job.status)+'</div>'+
        '<p class="note">截止 '+fdate(job.deadline,'Asia/Taipei',true)+'</p><div class="mini-stats">'+[['管道接受',job.statistics.acceptance],['回收率',job.statistics.recovery],['邀請連結轉換',job.statistics.conversion]].map(([label,data])=>'<div><span>'+e(label)+'</span><strong>'+e(percent(data))+'</strong><small>'+e(fraction(data))+'</small></div>').join('')+'</div>'+
        table(['對象','嘗試','送出狀態','處理說明'],job.attempts.items.map(a=>[e(a.mask),a.number,pill(a.status),e(a.reason??'—')]))+
        '<div class="row-wrap">'+btn('重新整理','secondary small','data-refresh-job')+(job.attempts.nextCursor?btn('下一頁','quiet small','data-next-job="'+e(job.attempts.nextCursor)+'"'):'')+
        (['completed','partial_failed'].includes(job.status)?btn('提醒未完成者','primary small','data-remind-job'):'')+
        (['scheduled','running'].includes(job.status)?btn('取消待發部分','quiet small','data-cancel-job'):'')+
        (job.status==='partial_failed'?btn('查核不明結果','quiet small','data-reconcile'):'')+'</div></div>',{wide:true});
      bind(box,'[data-refresh-job]',()=>jobDetail(jobId));
      bind(box,'[data-next-job]',el=>jobDetail(jobId,el.dataset.nextJob));
      bind(box,'[data-remind-job]',()=>confirmAction('提醒未完成者','會沿用原名單與回收率分母。',()=>api('/admin/dispatch-jobs/'+jobId+'/reminders',{body:{}})));
      bind(box,'[data-cancel-job]',()=>confirmAction('取消待發部分','已送交管道的通知會保留紀錄。',()=>api('/admin/dispatch-jobs/'+jobId+'/cancel',{body:{}})));
      bind(box,'[data-reconcile]',()=>confirmAction('查核不明結果','查詢推播管道的接受狀態。',()=>api('/admin/dispatch-jobs/'+jobId+'/reconcile',{body:{}})));
    }catch(error){message(error.message,'error');}
  }

  async function reports(target) {
    const data=await api('/admin/reports/outcomes?'+query(reportFilters));
    const link=can('analyst|publisher')?'<a class="button primary" href="/api/v1/admin/reports/export?'+e(query(reportFilters))+'">匯出 CSV '+icon('download',16)+'</a>':'';
    const filterForm='<form class="filter-form">'+cols(
      field('方案',select('program',o('','全部方案',reportFilters.program)+pOptions(reportFilters.program))),
      field('場次',select('eventId',o('','全部場次',reportFilters.eventId)+eventOptions(reportFilters.eventId))),
      field('配對階段',select('stage',stageOptions(data.filters.stage,['F30','T2','T3']))))+
      cols(field('督導區',select('district',o('','全部督導區',reportFilters.district)+facets())),
      field('分會',select('chapter',o('','全部分會',reportFilters.chapter)+config.organizations.filter(x=>x.kind==='chapter').map(x=>o(x.id,x.name,reportFilters.chapter)).join(''))),
      field('身分',select('member',o('','全部身分',reportFilters.member)+o('verified','已核驗會員',reportFilters.member)+o('nonmember','非會員',reportFilters.member)+o('pending','待審會員',reportFilters.member))))+
      cols(dateField('期間起點','since',reportFilters.since),dateField('資料截止','until',reportFilters.until),'<div class="filter-actions">'+submit('套用條件','secondary')+btn('清除','quiet','data-clear-filters')+'</div>')+errorSlot+'</form>';
    target.innerHTML=title('成效報表','依場次、活動方案與參與者分群重算成果。',link)+section('報表篩選',filterForm)+
      '<div class="kpi-grid">'+metricCard('場次後測回收率',percent(data.after),fraction(data.after),'doc')+
      metricCard('T0–'+data.filters.stage+' 配對率',percent(data.paired),fraction(data.paired),'pulse','sage')+
      metricCard('跨任務派送回收率',percent(data.recovery),fraction(data.recovery),'send','gold')+
      metricCard('有效基線未配對',nfmt(data.lost,0),'缺值或指標版本不可比','people','sage')+'</div>'+
      section('場次回收與配對',eventResultTable(data.eventRows)+
      '<p class="note inline-note">資料截止 '+fdate(data.cutoff,'Asia/Taipei',true)+' · 計算版本 '+e(data.calculationVersion)+' · '+e(data.kind)+'</p>')+
      section('行為變化與流失',table(['方案','有效配對','平均變化','中位數','上升／持平／下降','配對／未配對基線均值'],data.outcomes.map(r=>[
        e(short[r.code]),r.sample,r.mean===null?'樣本不足':nfmt(r.mean)+' '+e(r.unit),nfmt(r.median),r.directions?.join(' / ')??'—',
        nfmt(r.pairedBaseline)+' / '+nfmt(r.lostBaseline)]))+
      '<p class="note inline-note">追蹤回覆 '+data.followResponses+' 份 · 缺值或缺測 '+data.missing+' · 版本不可比 '+data.incomparable+
      ' · VEGRUN 21 餐維持率 '+e(percent(data.maintenance))+'（'+e(fraction(data.maintenance))+'）</p>');
    const distribution=data.outcomes.filter(r=>r.distribution);
    if (distribution.length) target.insertAdjacentHTML('beforeend',section('配對差值分布','<div class="distribution-grid">'+distribution.map(r=>
      '<div><h3>'+e(short[r.code])+'</h3>'+table(['個人差值（'+r.unit+'）','人數'],Object.entries(r.distribution).map(([d,count])=>[e(d),count]))+'</div>').join('')+'</div>'));
    bindForms(target,'form',async fields=>{
      const next=Object.fromEntries(fields);next.since=zonedISO(next.since,'Asia/Taipei');next.until=zonedISO(next.until,'Asia/Taipei');
      await api('/admin/reports/outcomes?'+query(next));reportFilters=next;await render();
    });
    bind(target,'[data-clear-filters]',()=>{reportFilters={};render();});
  }

  async function library(target) {
    const evidenceResult=await getPage('/admin/evidence','evidence');
    const snapshotResult=can('analyst|publisher')?await getPage('/admin/metric-snapshots','snapshots'):null;
    target.innerHTML=title('證據與快照','將原始資料與成效數據連結，以獨立帳號完成複核。')+
      section('證據庫',table(['標題','場次','來源／版本','紀錄日期','狀態','操作'],evidenceResult.items.map(r=>[
        '<strong>'+e(r.title)+'</strong>',e(r.event_title),e(r.source)+' · '+e(r.version),fdate(r.recorded_at),stateTitle(r.status),
        rowActions(btn('詳細資料','secondary small','data-evidence="'+e(r.id)+'"'),r.asset_id?'<a class="button quiet small" href="/api/v1/admin/evidence/'+e(r.id)+'/file">附件 '+icon('download',14)+'</a>':'')
      ]))+pagination(evidenceResult,'evidence'),can('operator|analyst')?btn('新增證據','primary small','data-new-evidence','add'):'')+
      (snapshotResult?section('成果快照',table(['場次','製作日','成效指標版本','狀態','操作'],snapshotResult.items.map(r=>[
        e(r.title),fdate(r.created_at),e(r.report.calculationVersion),stateTitle(r.status),btn('查看快照','secondary small','data-snapshot="'+e(r.id)+'"')
      ]))+pagination(snapshotResult,'snapshots'),can('analyst')?btn('建立快照','secondary small','data-new-snapshot','add'):''):'');
    bind(target,'[data-new-evidence]',()=>evidenceCreator());
    bind(target,'[data-new-snapshot]',()=>snapshotCreator());
    bind(target,'[data-evidence]',el=>{
      const r=evidenceResult.items.find(row=>row.id===el.dataset.evidence);
      const box=modal(r.title,'<div class="form-stack"><p>'+e(r.event_title)+' · '+e(r.source)+'</p><p>版本 '+e(r.version)+' · '+fdate(r.recorded_at)+'</p>'+
        '<p>'+e(r.note)+'</p>'+(r.digest?'<p class="note word-break">SHA-256 '+e(r.digest)+'</p>':'')+
        (can('publisher')&&r.status==='pending'?rowActions(btn('核准證據','primary','data-review-evidence="yes"'),btn('退補','secondary','data-review-evidence="no"')):'')+'</div>');
      bind(box,'[data-review-evidence]',b=>reasonAction(b.textContent,r.title,reason=>api('/admin/evidence/'+r.id+'/review',{body:{approve:b.dataset.reviewEvidence==='yes',reason}})));
    });
    bind(target,'[data-snapshot]',el=>{
      const r=snapshotResult.items.find(row=>row.id===el.dataset.snapshot);
      const box=modal('成效快照','<div class="form-stack"><div class="row-between"><strong>'+e(r.title)+'</strong>'+stateTitle(r.status)+'</div><p>'+e(r.reason)+'</p>'+
        '<p class="note">資料截止 '+fdate(r.report.cutoff,'Asia/Taipei',true)+' · 計算版本 '+e(r.report.calculationVersion)+'</p>'+
        eventResultTable(r.report.eventRows)+'<p>引用證據 '+r.evidenceIds.length+' 份</p>'+
        (can('publisher')&&r.status==='pending'?rowActions(btn('核准發布','primary','data-review-snapshot="yes"'),btn('退回','secondary','data-review-snapshot="no"')):'')+'</div>',{wide:true});
      bind(box,'[data-review-snapshot]',b=>reasonAction(b.textContent,r.title,reason=>api('/admin/metric-snapshots/'+r.id+'/review',{body:{approve:b.dataset.reviewSnapshot==='yes',reason}})));
    });
  }
  function evidenceCreator() {
    const box=modal('新增證據','<form class="form-stack">'+field('活動場次',selEvent('','required'))+
      field('證據標題',input('title','','text','required'))+cols(field('資料來源',input('source','','text','required')),field('版本',input('version','1','text','required')))+
      dateField('資料紀錄日期（臺北時間）','recordedAt',new Date().toISOString(),'Asia/Taipei','required')+
      field('附件（選填）',input('attachment','','file','accept="image/jpeg,image/png,image/webp,application/pdf"'),'限 5 MB。')+
      field('補充說明','<textarea name="note" rows="3" maxlength="1000"></textarea>')+errorSlot+submit('提交證據')+'</form>');
    bindForms(box,'form',async fields=>{
      const values=Object.fromEntries(fields), file=values.attachment;
      values.recordedAt=zonedISO(values.recordedAt,'Asia/Taipei');delete values.attachment;
      if (file.size) values.assetId=(await api('/admin/evidence/files',{body:file})).id;
      await api('/admin/evidence',{body:values});close();delete pageState.evidence;await render();message('證據已送交複核。');
    });
  }
  async function snapshotCreator() {
    try {
      const evidence=(await items('/admin/evidence')).filter(r=>r.status==='approved');
      const box=modal('建立成果快照','<form class="form-stack">'+cols(field('活動場次',selEvent('','required')),
        field('配對階段',select('stage',stageOptions('T2',['F30','T2','T3']))))+
        '<fieldset class="question-block"><legend>核准證據</legend><div data-refs></div></fieldset>'+
        field('製作原因','<textarea name="reason" rows="3" maxlength="500" required></textarea>')+errorSlot+submit('建立待審快照')+'</form>');
      const form=box.querySelector('form');
      const setRefs=()=>{box.querySelector('[data-refs]').innerHTML=evidence.filter(x=>x.event_id===form.elements.eventId.value)
        .map(x=>'<label class="checkbox"><input type="checkbox" name="evidenceIds" value="'+e(x.id)+'">'+e(x.title)+'</label>').join('')||'<p class="note">此場次尚無已核准證據。</p>';};
      form.elements.eventId.onchange=setRefs;setRefs();
      bindForms(box,'form',async values=>{
        await api('/admin/metric-snapshots',{body:{eventId:values.get('eventId'),stage:values.get('stage'),reason:values.get('reason'),evidenceIds:values.getAll('evidenceIds')}});
        close();delete pageState.snapshots;await render();message('成果快照已送交複核。');
      });
    }catch(error){message(error.message,'error');}
  }

  let memberSearch='',memberType='';
  async function members(target) {
    const [list,cases,rights]=await Promise.all([getPage('/admin/members?'+query({q:memberSearch,status:memberType}),'members'),
      getPage('/admin/identity-cases','identity'),getPage('/admin/rights','rights')]);
    target.innerHTML=title('會員與權利請求','核驗佛光卡號、處理身分衝突與個資權利案件。')+
      section('會員清單','<form class="inline-form">'+input('q',memberSearch,'search','aria-label="搜尋會員" placeholder="搜尋名稱、遮罩卡號或識別碼"')+
      select('status',o('','全部身分',memberType)+o('pending','待核驗',memberType)+o('verified','已核驗',memberType)+o('nonmember','非佛光會員',memberType),'aria-label="身分狀態"')+submit('搜尋','secondary')+'</form>'+
      table(['顯示名稱','居住縣市','居住地區','卡號','手機','身分狀態','操作'],list.items.map(row=>[
        e(row.name||'未設定'),e(row.residence_city||row.region||'—'),e(row.residence_district||'—'),e(row.card_mask??'—'),e(row.phone_mask??'—'),stateTitle(row.member_status),
        row.member_status==='pending'?btn('核驗會員','secondary small','data-member="'+e(row.id)+'"'):''
      ]))+pagination(list,'members'))+
      section('身分衝突案件',table(['發生時間','案件類型','原因','狀態','操作'],cases.items.map(row=>[
        fdate(row.created_at,'Asia/Taipei',true),e(row.kind==='line_conflict'?'LINE 綁定':'手機門號'),e(row.reason),stateTitle(row.status),
        btn('檢視案件','secondary small','data-case="'+e(row.id)+'"')
      ]))+pagination(cases,'identity'))+
      section('資料權利請求',table(['類型','說明','申請日','狀態','操作'],rights.items.map(row=>[
        e({access:'資料查詢',correction:'資料更正',deletion:'資料刪除',phone_recovery:'帳號復原'}[row.kind]??row.kind),e(row.note),fdate(row.created_at),pill(row.status),
        btn('更新處理狀態','secondary small','data-right="'+e(row.id)+'"')
      ]))+pagination(rights,'rights'));
    bindForms(target,'form',async values=>{memberSearch=values.get('q');memberType=values.get('status');delete pageState.members;await render();});
    bind(target,'[data-member]',el=>{
      const r=list.items.find(row=>row.id===el.dataset.member);
      const box=modal('佛光卡號核驗','<form class="form-stack"><p>'+e(r.name||'未設定名稱')+' · '+e(r.card_mask)+'</p>'+
        field('核驗結果',select('decision',o('yes','核驗通過')+o('no','退補／駁回')))+
        field('依據或退補理由','<textarea name="reason" rows="3" required maxlength="400"></textarea>')+errorSlot+submit('提交核驗')+'</form>');
      bindForms(box,'form',async values=>{
        await api('/admin/members/'+r.id+'/review',{body:{approve:values.get('decision')==='yes',reason:values.get('reason')}});
        close();delete pageState.members;await render();message('會員狀態已更新。');
      });
    });
    bind(target,'[data-case]',el=>identityCase(cases.items.find(row=>row.id===el.dataset.case)));
    bind(target,'[data-right]',el=>{
      const row=rights.items.find(r=>r.id===el.dataset.right);
      const box=modal('更新權利請求','<form class="form-stack">'+field('狀態',select('status',o('reviewing','審查中',row.status)+o('resolved','已結案',row.status)+o('rejected','駁回',row.status)))+
        field('處理理由','<textarea name="reason" rows="3" required maxlength="1000"></textarea>')+errorSlot+submit('更新狀態')+'</form>');
      bindForms(box,'form',async values=>{
        await api('/admin/rights/'+row.id,{method:'PATCH',body:Object.fromEntries(values)});
        close();await render();message('權利請求狀態已更新。');
      });
    });
  }
  async function identityCase(row) {
    try {
      const conflict=(await api('/admin/identity-cases/'+row.id+'/conflicts')).items;
      const box=modal('身分審核案件','<div class="form-stack"><div class="row-between"><strong>'+e(row.reason)+'</strong>'+stateTitle(row.status)+'</div>'+
        '<p class="note word-break">本帳號 '+e(row.participant_id)+'<br>相關帳號 '+e(row.other_id??'—')+'</p>'+
        (row.status==='pending'?'<form class="form-stack">'+field('處理方式',select('action',o('close','結案保留兩方紀錄')+(row.other_id?o('merge','申請合併至本帳號')+'':'')))+
        '<div data-merge hidden>'+field('差異與欄位取捨','<textarea name="fieldConflicts" rows="3" maxlength="1000"></textarea>')+
        conflict.map(r=>field('重複問卷 '+r.event_survey_id,select('keep-'+r.event_survey_id,o(r.target_id,'保留本帳號回覆')+o(r.source_id,'保留相關帳號回覆')))).join('')+'</div>'+
        field('人工核驗理由','<textarea name="reason" rows="3" maxlength="1000" required></textarea>')+errorSlot+submit('提交複核')+'</form>':'')+
        (row.status==='proposed'?'<p class="note word-break">'+e(row.resolution)+'</p>'+
        rowActions(btn('核准處理','primary','data-case-review="yes"'),btn('退回','secondary','data-case-review="no"')):'')+'</div>',{wide:true});
      const form=box.querySelector('form');
      if(form) form.elements.action.onchange=()=>{box.querySelector('[data-merge]').hidden=form.elements.action.value!=='merge';};
      bindForms(box,'form',async fields=>{
        const keep=Object.fromEntries(conflict.map(r=>[r.event_survey_id,fields.get('keep-'+r.event_survey_id)]));
        await api('/admin/identity-cases/'+row.id+'/propose',{body:{action:fields.get('action'),reason:fields.get('reason'),fieldConflicts:fields.get('fieldConflicts'),keep}});
        close();await render();message('案件已送交複核。');
      });
      bind(box,'[data-case-review]',el=>reasonAction(el.textContent,row.reason,reason=>api('/admin/identity-cases/'+row.id+'/review',{body:{approve:el.dataset.caseReview==='yes',reason}})));
    }catch(error){message(error.message,'error');}
  }
  async function corrections(target) {
    const result=await getPage('/admin/response-reviews','corrections');
    target.innerHTML=title('回覆更正','以問卷回執識別碼提出更正，保留原始答案與複核理由。',
      can('analyst')?btn('提出更正','primary','data-new-correction','add'):'')+
      section('更正紀錄',table(['場次','問卷','提出日','狀態','操作'],result.items.map(r=>[
        e(r.title),e(stages[r.stage]),fdate(r.created_at),stateTitle(r.status),btn('檢視差異','secondary small','data-correction="'+e(r.id)+'"')
      ]))+pagination(result,'corrections'));
    bind(target,'[data-new-correction]',()=>{
      const box=modal('查找有效回執','<form class="form-stack">'+field('回執識別碼',input('id','','text','required maxlength="64"'))+errorSlot+submit('查找回執')+'</form>');
      bindForms(box,'form',async fields=>correctionEditor(await api('/admin/responses/'+encodeURIComponent(String(fields.get('id')).trim()))));
    });
    bind(target,'[data-correction]',async el=>{
      try{
        const r=await api('/admin/response-reviews/'+el.dataset.correction);
        const box=modal('回覆更正差異','<div class="form-stack"><p>'+e(r.reason)+'</p>'+table(['題目代碼','更正前','更正後'],
          Object.keys(r.after).filter(key=>r.before[key]!==r.after[key]).map(key=>[e(key),e(r.before[key]??'缺值'),e(r.after[key]??'缺值')]))+
          (can('publisher')&&r.status==='pending'?rowActions(btn('核准更正','primary','data-correction-review="yes"'),btn('退回','secondary','data-correction-review="no"')):'')+'</div>');
        bind(box,'[data-correction-review]',b=>reasonAction(b.textContent,'複核原始答案與更正值。',reason=>api('/admin/response-reviews/'+r.id,{body:{approve:b.dataset.correctionReview==='yes',reason}})));
      }catch(error){message(error.message,'error');}
    });
  }
  function correctionEditor(r) {
    const fields=r.form.map(q=>{
      const answer=r.answers[q.key];
      return field(q.label,q.type==='integer'?input('q-'+q.key,answer??'','number','min="'+q.min+'" max="'+q.max+'" step="1" '+(q.required?'required':'')):
        select('q-'+q.key,o('','未回答')+q.options.map(v=>o(v,v,answer)).join(''),q.required?'required':''));
    }).join('');
    const box=modal('提出回覆更正','<form class="form-stack"><p class="note">'+e(r.title)+' · '+e(stages[r.stage])+'</p>'+fields+
      field('更正理由','<textarea name="reason" rows="3" required maxlength="500"></textarea>')+errorSlot+submit('送交複核')+'</form>');
    bindForms(box,'form',async values=>{
      const answers=Object.fromEntries(r.form.map(q=>{
        const value=values.get('q-'+q.key);
        return [q.key,value===''?null:q.type==='integer'?Number(value):value];
      }));
      await api('/admin/responses/'+r.id+'/corrections',{body:{answers,reason:values.get('reason')}});
      close();delete pageState.corrections;await render();message('更正已送交複核。');
    });
  }

  let residenceCity='';
  async function locationPage(target) {
    const locations=await api('/admin/residence-locations');
    config.residenceLocations=locations;
    if (!locations.cities.some(c=>c.id===residenceCity)) residenceCity=locations.cities[0]?.id??'';
    const current=locations.cities.find(c=>c.id===residenceCity);
    const districts=locations.districts.filter(d=>d.city_id===residenceCity);
    const activeLabel=row=>pill(row.active?'open':'closed',row.active?'啟用':'停用');
    target.innerHTML=title('縣市地區維護','管理台灣居住縣市與鄉鎮市區。停用後保留既有紀錄。')+
      '<div class="profile-grid location-grid">'+
      section('居住縣市（'+locations.cities.length+'）',table(['縣市','狀態','排序','使用人數','操作'],locations.cities.map(c=>[
        '<strong>'+e(c.name)+'</strong>',activeLabel(c),nfmt(c.sort_order,0),nfmt(c.used,0),
        rowActions(btn('地區','secondary small','data-location-city="'+e(c.id)+'"'),btn('編輯','quiet small','data-edit-city="'+e(c.id)+'"'))
      ])),btn('新增縣市','primary small','data-new-city','add'))+
      section((current?.name??'請選擇縣市')+' · 居住地區（'+districts.length+'）',
      '<div class="inline-form">'+field('選擇縣市',select('locationCity',locations.cities.map(c=>o(c.id,c.name+(c.active?'':'（已停用）'),residenceCity)).join('')))+ '</div>'+
      table(['鄉鎮市區','狀態','排序','使用人數','操作'],districts.map(d=>[
        '<strong>'+e(d.name)+'</strong>',activeLabel(d),nfmt(d.sort_order,0),nfmt(d.used,0),btn('編輯','secondary small','data-edit-district="'+e(d.id)+'"')
      ])),btn('新增地區','primary small','data-new-district '+(!current?'disabled':''),'add'))+'</div>';
    target.querySelector('[name=locationCity]').onchange=event=>{residenceCity=event.target.value;render();};
    bind(target,'[data-location-city]',el=>{residenceCity=el.dataset.locationCity;render();});
    function editor(kind,row) {
      const city=kind==='cities', label=city?'縣市':'地區';
      const box=modal((row?'編輯':'新增')+label,'<form class="form-stack">'+
        (!city?'<p class="note">所屬縣市：'+e(current?.name)+'</p>':'')+
        field(label+'名稱',input('name',row?.name??'','text','required maxlength="20" placeholder="'+(city?'例如：臺北市':'例如：中正區')+'"'))+
        field('顯示排序',input('sortOrder',row?.sort_order??0,'number','required min="0" max="9999" step="1"'))+
        '<label class="checkbox"><input type="checkbox" name="active" '+(!row||row.active?'checked':'')+'>啟用，提供前台選擇</label>'+
        '<p class="note">停用不影響既有居住資料；更名後將同步顯示新名稱。</p>'+errorSlot+submit('儲存'+label)+'</form>');
      bindForms(box,'form',async values=>{
        const saved=await api('/admin/residence-'+kind+(row?'/'+encodeURIComponent(row.id):''),{
          method:row?'PATCH':'POST',body:{name:values.get('name'),sortOrder:Number(values.get('sortOrder')),active:values.get('active')==='on',...(!city?{cityId:residenceCity}:{})}
        });
        if (city&&!row) residenceCity=saved.id;
        close();await render();message(label+'資料已儲存。');
      });
    }
    bind(target,'[data-new-city]',()=>editor('cities'));
    bind(target,'[data-new-district]',()=>editor('districts'));
    bind(target,'[data-edit-city]',el=>editor('cities',locations.cities.find(c=>c.id===el.dataset.editCity)));
    bind(target,'[data-edit-district]',el=>editor('districts',districts.find(d=>d.id===el.dataset.editDistrict)));
  }

  let auditSearch='';
  async function auditPage(target) {
    const result=await getPage('/admin/audit?'+query({q:auditSearch}),'audit');
    target.innerHTML=title('稽核紀錄','追溯重要資料讀取、身分變更、派送及審核。')+
      section('操作紀錄','<form class="inline-form">'+input('q',auditSearch,'search','aria-label="搜尋稽核" placeholder="搜尋操作或標的"')+
      submit('搜尋','secondary')+'</form>'+table(['時間','行為人','操作','標的','請求 ID'],result.items.map(row=>[
        fdate(row.created_at,'Asia/Taipei',true),e(row.actor),e(row.action),e(row.target),'<code>'+e(row.request_id??'—')+'</code>'
      ]))+pagination(result,'audit'));
    bindForms(target,'form',async values=>{auditSearch=values.get('q');delete pageState.audit;await render();});
  }

  window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
  await render();
}
