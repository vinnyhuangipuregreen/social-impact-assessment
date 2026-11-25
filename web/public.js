import {api,items,bind,bindForms,bindResidenceSelects,residenceCityOptions,brand,btn,close,e,empty,errorSlot,fdate,field,icon,input,message,modal,nfmt,o,pill,select,submit,questionFields,questionAnswers,collectionTimeline} from './ui.js';

export async function startPublic(root,config) {
  const programs=config.programs;
  const pName=code=>programs.find(p=>p.code===code)?.title??code;
  let me, events=[], surveys=[], enrollments=[];
  let invite=new URLSearchParams(location.search).get('invite');
  const entry=new URLSearchParams(location.search);
  let programFilter='', surveyProgramFilter='', surveyFilter='all', eventFilter=entry.get('event')||'';
  const openSurvey=entry.get('survey')||'';
  const stateRoute=()=>location.hash.slice(1)||(eventFilter?'activities':'home');
  const signed=()=>Boolean(me?.participant_id);
  const nav=[['home','首頁'],['activities','活動探索'],['surveys','我的問卷'],['history','影響力歷程']];
  const load=async()=>{
    [events,me]=await Promise.all([items('/events'),api('/me').catch(error=>{if(error.status===401)return null;throw error;})]);
    if (signed()) [surveys,enrollments]=await Promise.all([items('/me/surveys'),items('/me/enrollments')]);
    else { surveys=[];enrollments=[]; }
  };
  const refresh=async()=>{ await load();render(); };
  function goto(route) {
    if (stateRoute()===route) render();
    else location.hash=route;
  }
  const currentEvents=(code)=>events.filter(event=>(!code||code===event.program)&&(!eventFilter||event.id===eventFilter));
  const markHeading=(title,desc='')=>'<div class="section-head"><div><h1>'+e(title)+'</h1>'+(desc?'<p>'+e(desc)+'</p>':'')+'</div></div>';
  const publicBtn=(title,route,classes='primary',symbol='arrow')=>'<a href="#'+route+'" class="button '+classes+'">'+e(title)+icon(symbol)+'</a>';
  const loginGate=(title,detail)=>'<div class="card gate">'+icon('shield',32)+'<h2>'+e(title)+'</h2><p>'+e(detail)+'</p>'+btn('手機或 LINE 登入','primary','data-login','arrow')+'</div>';
  function activityCards() {
    return '<div class="program-grid">'+programs.map((p,index)=>'<article class="program-card program-'+p.code+'"><div class="program-image"><img src="/assets/'+p.image+'-sia.webp" alt="'+e(p.theme)+'立體插畫"><span>'+String(index+1).padStart(2,'0')+'</span></div><div class="program-info"><h3>'+e(p.title)+'</h3><p>'+e(p.summary)+'</p><button type="button" class="button primary program-action" data-program="'+p.code+'">查看活動場次 '+icon('arrow',17)+'</button></div></article>').join('')+
      '<article class="program-card program-history"><div class="program-image"><img src="/assets/impact-sia.webp" alt="影響力歷程與成效報表立體插畫"><span>04</span></div><div class="program-info"><h3>我的影響力歷程</h3><p>回顧活動參與與問卷紀錄，看見每一次行動累積的改變。</p>'+publicBtn('查看我的歷程','history','primary program-action')+'</div></article></div>';
  }
  function home() {
    return `<section class="container welcome-grid"><div class="hero"><div class="hero-inner">
      <div class="hero-copy"><p class="eyebrow hero-tag"><span></span> 綠色公益基金會</p>
      <h1>讓每一次行動<br>留下<span>永續影響</span></h1>
      <p class="hero-body">從公益路跑、森林保育到蔬食選擇。<br class="desktop-only">參與你關心的計畫，一起看見日常行動帶來的改變。</p>
      <div class="hero-actions">${publicBtn('探索活動','activities','lime')}</div></div>
      </div></div><aside class="card survey-feature"><img src="/assets/forest-sia.webp" alt="森林與新芽立體插畫"><h2>我的問卷</h2><p>記錄行動，讓改變被看見。</p>${publicBtn('前往填寫問卷','surveys','primary','arrow')}</aside></section>
      <section class="container programs" id="programs"><div class="section-head">
      <div><p class="eyebrow">永續行動</p><h2>探索三大公益方案</h2></div>${publicBtn('查看活動場次','activities','glance','diagonal')}</div>
      ${activityCards()}</section>`;
  }
  function activities() {
    const filters=[{code:'',title:'全部方案'},...programs];
    const rows=currentEvents(programFilter);
    return '<section class="container subpage">'+markHeading('活動探索','選擇感興趣的場次，加入永續行動。')+
      '<div class="chips">'+filters.map(p=>btn(p.title,p.code===programFilter?'chip is-active':'chip','data-filter="'+p.code+'"')).join('')+'</div>'+
      (rows.length?'<div class="event-grid">'+rows.map(event=>{
        const p=programs.find(row=>row.code===event.program);
        const en=enrollments.find(row=>row.event_id===event.id);
        const isOpen=event.status==='published'&&Date.parse(event.registration_opens)<=Date.now()&&Date.parse(event.registration_closes)>Date.now();
        return '<article class="card event-card"><img class="event-image" src="/assets/'+p.image+'-sia.webp" alt="'+e(p.theme)+'立體插畫"><div class="event-detail">'+
          '<div class="row-between"><span class="label">'+e(p.theme)+'</span>'+pill(en?.status??(isOpen?'open':event.status),en?.status?undefined:isOpen?'開放報名':event.status==='published'?'報名已關閉':undefined)+'</div>'+
          '<h2>'+e(event.title)+'</h2><p class="meta">'+icon('calendar')+fdate(event.starts_at,event.timezone,true)+'</p><p class="meta">'+icon('pin')+e(event.venue)+'</p>'+
          '<div class="event-actions">'+(en?.status==='attended'?publicBtn('前往問卷','surveys','secondary'):
            en?.status==='registered'?publicBtn('前往問卷','surveys','secondary')+(isOpen?btn('取消報名','quiet','data-enroll="'+e(event.id)+'" data-cancel'): ''):
            isOpen?btn(event.program==='VEG'?'啟用活動':'我要報名','primary','data-enroll="'+e(event.id)+'"','arrow'):'')+'</div></div></article>';
      }).join('')+'</div>':empty('目前沒有公開場次'))+'</section>';
  }
  function surveyPage() {
    const listed=surveys.filter(s=>(!surveyProgramFilter||s.program===surveyProgramFilter)&&(surveyFilter==='all'||s.status===surveyFilter));
    return '<section class="container subpage narrow">'+markHeading('我的問卷','查看各場次的填答時程、資格與完成紀錄。')+
      (!signed()?loginGate('登入查看我的問卷','登入後即可填寫已報名活動的問卷。'):
        collectionTimeline(config.collectionTimeline)+'<div class="chips" role="group" aria-label="問卷方案篩選">'+[{code:'',title:'全部方案'},...programs].map(p=>btn(p.title,p.code===surveyProgramFilter?'chip is-active':'chip','data-survey-program="'+p.code+'" aria-pressed="'+(p.code===surveyProgramFilter)+'"')).join('')+'</div>'+
        '<div class="chips" role="group" aria-label="問卷狀態篩選">'+[['all','全部'],['open','可填答'],['done','已完成'],['upcoming','待開放'],['closed','已截止'],['blocked','資格未完成']].map(([key,label])=>btn(label,key===surveyFilter?'chip is-active':'chip','data-survey-filter="'+key+'" aria-pressed="'+(key===surveyFilter)+'"')).join('')+'</div>'+
      (listed.length?'<div class="stack">'+listed.map(s=>'<article class="card survey-row"><div class="survey-symbol">'+icon('doc',22)+'</div><div class="surv-main"><div class="row-wrap"><span class="label">'+e(pName(s.program))+'</span>'+pill(s.status)+'</div><h2>'+e(s.stageName)+'</h2><span>'+e(s.title)+'</span><p>'+fdate(s.opens_at,s.timezone,true)+' – '+fdate(s.closes_at,s.timezone,true)+'</p>'+(s.status==='blocked'?'<p class="attention">'+e(s.reason)+'</p>':'')+'</div>'+
      (['open','done'].includes(s.status)?btn(s.status==='open'?'開始填答':'查看答覆',s.status==='open'?'primary':'secondary','data-survey="'+e(s.id)+'"','arrow'):'')+'</article>').join('')+'</div>':
        empty('目前沒有符合的問卷',surveys.length?'請試試其他篩選條件。':'完成活動報名後，問卷會顯示於此。')) )+'</section>';
  }
  function history() {
    return '<section class="container subpage narrow">'+markHeading('影響力歷程','回顧自己參與的活動與已填答紀錄。')+(!signed()?loginGate('登入查看個人歷程','你的活動與問卷會以同一個帳號串接。'):
      (!enrollments.length?empty('尚未開始你的行動紀錄'):'<div class="stack">'+enrollments.map(en=>{
        const related=surveys.filter(s=>s.eventId===en.event_id&&s.response);
        const p=programs.find(row=>row.code===en.program);
        const base=related.find(s=>s.stage==='T0');
        const compares=related.filter(s=>['F30','T2','T3'].includes(s.stage)).flatMap(s=>{
          const bqNew=base?.form.find(q=>q.key==='veg_days_category'),eqNew=s.form.find(q=>q.key==='veg_days_category');
          if(bqNew?.metricVersion&&bqNew.metricVersion===eqNew?.metricVersion&&JSON.stringify(bqNew.options)===JSON.stringify(eqNew.options)) {
            const before=bqNew.options.indexOf(base.response.answers.veg_days_category),after=eqNew.options.indexOf(s.response.answers.veg_days_category);
            return before>=0&&after>=0?['<span class="metric-person">'+e(s.stageName)+' · 全日蔬食 '+e(eqNew.options[after])+'（'+(after-before>0?'+':'')+(after-before)+' 級）</span>']:[];
          }
          const a=base?.response.answers[p.metric],b=s.response.answers[p.metric],
            aq=base?.form.find(q=>q.key===p.metric),bq=s.form.find(q=>q.key===p.metric);
          return Number.isInteger(a)&&Number.isInteger(b)&&aq?.metricVersion===bq?.metricVersion&&aq?.unit===bq?.unit
            ?['<span class="metric-person">'+e(s.stageName)+' '+(b-a>0?'+':'')+(b-a)+' '+e(p.unit)+'</span>']:[];
        });
        return '<article class="card history-card"><div class="row-between"><span class="label">'+e(p.theme)+'</span>'+pill(en.status)+'</div><h2>'+e(en.title)+'</h2><p>'+fdate(en.starts_at,en.timezone)+' · 已完成 '+related.length+' 份問卷</p>'+
          '<div class="row-wrap">'+compares.join('')+'</div><div class="row-wrap">'+related.map(s=>btn(s.stageName,'quiet','data-survey="'+e(s.id)+'"','diagonal')).join('')+'</div></article>';
      }).join('')+'</div>'))+'</section>';
  }
  function profilePage() {
    if (!signed()) return '<section class="container subpage narrow">'+markHeading('個人資料與同意')+loginGate('登入管理帳號','在此編輯身分資料、聯絡管道與追蹤同意。')+'</section>';
    const district=config.organizations.filter(o=>o.kind==='district'), isMember=me.member_status!=='nonmember';
    return '<section class="container subpage narrow">'+markHeading('個人資料與同意','管理個人身分、聯絡方式與資料使用選項。')+
      '<div class="profile-grid"><section class="card panel"><div class="row-between"><h2>基本資料</h2>'+pill(me.member_status,me.member_status==='pending'?'會員待審':undefined)+'</div>'+
      '<form id="profile-form" class="form-stack">'+field('顯示名稱',input('name',me.name,'text','maxlength="80"'))+
      '<div class="form-grid">'+field('居住縣市',select('residenceCityId',residenceCityOptions(config.residenceLocations,me.residence_city_id)))+
      field('居住地區',select('residenceDistrictId',o('','請先選擇居住縣市')))+'</div>'+
      (me.region&&!me.residence_city_id?'<p class="note">原居住資料：'+e(me.region)+'。請重新選擇居住縣市與地區。</p>':'')+
      field('參與身分',select('member',o('no','非佛光會員',isMember?'yes':'no')+o('yes','佛光會員',isMember?'yes':'no')))+
      '<div id="member-fields" '+(!isMember?'hidden':'')+'><div class="form-grid">'+field('督導區',select('district',o('','請選擇')+district.map(x=>o(x.id,x.name,me.district_id)).join('')))+
      field('分會',select('chapter',o('','請選擇')))+
      '</div>'+field('佛光卡號',input('card','','text','minlength="15" maxlength="15" pattern="B[0-9]{14}" title="第一碼為 B，後面接 14 碼數字" autocapitalize="characters" spellcheck="false" placeholder="'+e(me.card_mask??'輸入您的佛光卡號')+'"'),'第一碼為 B，後面接 14 碼數字。'+(me.card_mask?'更換卡號請重新輸入。':'核驗通過後可依卡號接收通知。'))+
      (me.review_reason?'<p class="note">'+e(me.review_reason)+'</p>':'')+'</div>'+errorSlot+submit('儲存基本資料')+'</form></section>'+
      '<section class="card panel"><h2>帳號與照片</h2><div class="photo-row">'+(me.photo_id?'<img class="avatar" src="/api/v1/me/files/'+e(me.photo_id)+'" alt="個人照片">':'<span class="avatar">'+icon('user',26)+'</span>')+
      '<div><strong>'+e(me.name||'參與者')+'</strong><p>'+e(me.identities.find(i=>i.kind==='phone')?.mask??'未連結手機')+'</p></div></div>'+
      '<form id="photo-form" class="form-stack">'+field('個人照片（選填）',input('photo','','file','accept="image/jpeg,image/png,image/webp" required'),'最多 5 MB，支援 JPEG、PNG、WebP。')+errorSlot+submit('上傳照片','secondary')+'</form>'+
      '<div class="separator"></div><div class="row-wrap">'+btn(me.identities.some(i=>i.kind==='line')?'管理 LINE 連結':'連結 LINE','secondary','data-line')+btn('變更門號','quiet','data-change-phone')+'</div>'+
      '<p class="note">LINE OA '+(me.line_reachable?'可接收問卷推播':'目前無法接收問卷推播')+'</p><button type="button" class="copy-id" data-copy-id>複製平台識別碼 '+icon('doc',14)+'</button></section></div>'+
      '<section class="card panel consent-panel"><h2>資料同意</h2><p>'+e(config.noticeText)+'</p>'+
      (config.demo?'<p class="note">示範版個資告知 '+e(config.noticeVersion)+'</p>':'<p class="note">個資告知版本 '+e(config.noticeVersion)+'</p>')+
      [['privacy','*','確認個資告知',me.consents.privacy],...programs.map(p=>['tracking',p.code,p.title+' · 後續追蹤',me.consents.tracking[p.code]]),['marketing','*','行銷聯繫',me.consents.marketing]]
      .map(([purpose,scope,label,on])=>'<label class="toggle-row"><span>'+e(label)+'</span><input type="checkbox" data-consent data-purpose="'+purpose+'" data-scope="'+scope+'" '+(on?'checked':'')+'><span class="switch" aria-hidden="true"></span></label>').join('')+
      '</section><section class="card panel"><div class="row-between"><h2>資料權利請求</h2>'+btn('提出申請','secondary','data-rights','arrow')+'</div><div id="rights-list"></div></section></section>';
  }
  function render() {
    const route=stateRoute();
    const content={home,activities,surveys:surveyPage,history,profile:profilePage}[route]??home;
    root.innerHTML='<header class="site-header"><div class="container nav-inner"><a href="#home" class="brand-link" aria-label="SIA 首頁">'+brand()+'</a>'+
      '<p class="header-purpose">綠色公益基金會<span>參與行動 × 記錄改變 × 看見影響</span></p>'+
      '<div class="nav-side">'+(!signed()?btn('登入／註冊','secondary nav-login','data-login','user'):
       '<a class="button secondary nav-login" href="#profile">'+icon('user',16)+'個人資料</a>'+btn('登出','quiet logout','data-logout'))+
      '</div><button type="button" class="icon-button mobile-toggle" aria-label="開啟選單" aria-expanded="false">'+icon('menu',22)+'</button>'+
      '<nav aria-label="主要導覽">'+nav.map(([key,label],index)=>'<a href="#'+key+'" '+(route===key?'aria-current="page"':'')+'>'+icon(['grid','calendar','doc','chart'][index],18)+e(label)+'</a>').join('')+'<a href="/admin">'+icon('shield',18)+'管理後台</a></nav></div></header>'+
      '<main id="main">'+content()+'</main><footer class="site-footer"><div class="container row-between"><a class="brand-link" href="#home">'+brand()+'</a>'+
      '<p>綠色公益基金會'+(config.demo?' · 示範環境':'')+'</p><a href="#profile">資料同意與權利</a></div></footer>';
    const toggle=root.querySelector('.mobile-toggle');
    toggle.onclick=()=>{ const visible=toggle.getAttribute('aria-expanded')==='true'; toggle.setAttribute('aria-expanded',String(!visible)); root.querySelector('.site-header').classList.toggle('mobile-open',!visible); };
    bind(root,'[data-login]',()=>login());
    bind(root,'[data-logout]',async()=>{await api('/auth/logout',{body:{}});await refresh();goto('home');message('已登出。');});
    bind(root,'[data-program]',el=>{eventFilter='';programFilter=el.dataset.program;goto('activities');});
    bind(root,'[data-filter]',el=>{eventFilter='';programFilter=el.dataset.filter;render();});
    bind(root,'[data-survey-filter]',el=>{surveyFilter=el.dataset.surveyFilter;render();});
    bind(root,'[data-survey-program]',el=>{surveyProgramFilter=el.dataset.surveyProgram;render();});
    bind(root,'[data-enroll]',el=>enroll(el.dataset.enroll,el.hasAttribute('data-cancel')));
    bind(root,'[data-survey]',el=>showSurvey(el.dataset.survey));
    bind(root,'[data-line]',()=>lineLogin());
    bind(root,'[data-change-phone]',()=>login({change:true}));
    bind(root,'[data-rights]',()=>rights());
    bind(root,'[data-copy-id]',async()=>{try {await navigator.clipboard.writeText(me.participant_id);message('平台識別碼已複製。');} catch {message(me.participant_id);}});
    if(route==='profile'&&signed()) bindProfile();
  }
  function bindProfile() {
    const form=root.querySelector('#profile-form');
    bindResidenceSelects(form,config.residenceLocations,me.residence_district_id);
    const district=form.elements.district, chapter=form.elements.chapter, member=form.elements.member;
    function loadBranches(initial='') {
      const branches=config.organizations.filter(x=>x.parent_id===district.value);
      chapter.innerHTML=o('','請選擇')+branches.map(x=>o(x.id,x.name,initial)).join('');
      chapter.disabled=branches.length===0;
    }
    function updateMemberFields() {
      root.querySelector('#member-fields').hidden=member.value!=='yes';
      district.required=member.value==='yes';
      chapter.required=member.value==='yes';
      form.elements.card.disabled=member.value!=='yes';
      form.elements.card.required=member.value==='yes'&&!me.card_mask;
    }
    loadBranches(me.chapter_id??'');
    district.onchange=()=>loadBranches();
    member.onchange=updateMemberFields;
    updateMemberFields();
    bindForms(root,'#profile-form',async data=>{
      const fields=Object.fromEntries(data);
      me=await api('/me/profile',{method:'PATCH',body:{name:fields.name,residenceCityId:fields.residenceCityId,residenceDistrictId:fields.residenceDistrictId||'',member:fields.member==='yes',districtId:fields.district,chapterId:fields.chapter,card:fields.card}});
      render();message('基本資料已儲存。');
    });
    bindForms(root,'#photo-form',async data=>{
      const selected=data.get('photo');
      if (!selected?.size) throw new Error('請先選擇一張照片。');
      await api('/me/files',{body:selected});
      await refresh();message('照片已更新。');
    });
    for (const checkbox of root.querySelectorAll('[data-consent]')) checkbox.onchange=async ()=>{
      checkbox.disabled=true;
      try {
        me=await api('/me/consents',{body:{purpose:checkbox.dataset.purpose,scope:checkbox.dataset.scope,choice:checkbox.checked,noticeVersion:config.noticeVersion}});
        await refresh();message('同意設定已更新。');
      } catch (error) {checkbox.checked=!checkbox.checked;message(error.message,'error');}
      finally {checkbox.disabled=false;}
    };
    const target=root.querySelector('#rights-list');
    items('/me/rights').then(rows=>{ target.innerHTML=rows.length?'<ul class="record-list">'+rows.map(r=>'<li>'+e(rightLabels[r.kind])+' · '+fdate(r.created_at)+pill(r.status)+'</li>').join('')+'</ul>':'<p class="note">目前沒有申請紀錄。</p>';}).catch(error=>{target.textContent=error.message;});
  }
  const rightLabels={access:'查詢或提供複本',correction:'補充或更正',deletion:'刪除資料',phone_recovery:'舊門號無法使用'};
  function rights() {
    const dialog=modal('提出資料權利請求','<form class="form-stack">'+field('申請類型',select('kind',Object.entries(rightLabels).map(([key,label])=>o(key,label)).join('')))+
      field('補充說明','<textarea name="note" rows="4" maxlength="1000"></textarea>')+errorSlot+submit('送出申請')+'</form>');
    bindForms(dialog,'form',async data=>{await api('/me/rights',{body:Object.fromEntries(data)});close();render();message('資料權利請求已收件。');});
  }
  function login({change=false,pending=false,next}={}) {
    const dialog=modal(change?'變更手機門號':'手機驗證登入','<form id="get-code" class="form-stack">'+
      (pending?'<p class="note">請驗證手機以完成 LINE 帳號註冊。</p>':config.demo?'<p class="note">Demo 模式可使用 0900 000 001 查看既有測試紀錄，也可自行輸入測試門號。</p>':'')+
      field(change?'新手機號碼':'手機號碼',input('phone','','tel','autocomplete="tel" required placeholder="例如 0912 345 678"'))+errorSlot+submit('取得驗證碼')+'</form>'+
      (!change&&!pending?'<div class="separator"></div>'+btn('使用 LINE 登入','secondary','data-modal-line','arrow'):''));
    bind(dialog,'[data-modal-line]',()=>lineLogin());
    bindForms(dialog,'#get-code',async data=>{
      const otp=await api('/auth/otp/request',{body:{phone:data.get('phone'),purpose:change?'change':'login'}});
      const box=modal('輸入手機驗證碼','<form class="form-stack"><p class="note">'+(config.demo?'Demo 驗證碼 '+e(otp.demoCode)+' · 5 分鐘內有效。':'驗證碼已發送至你的手機，5 分鐘內有效。')+'</p>'+
        field('6 位數驗證碼',input('code',config.demo?otp.demoCode:'','text','inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required'))+errorSlot+submit(change?'驗證並更新':'驗證並登入')+
        btn('重新取得驗證碼','quiet','data-restart')+'</form>');
      bind(box,'[data-restart]',()=>login({change,pending,next}));
      bindForms(box,'form',async values=>{
        await api('/auth/otp/verify',{body:{challengeId:otp.challengeId,code:values.get('code')}});
        close();await refresh();
        message(change?'手機門號已更新。':'登入成功。');
        if (invite) await openInvite();
        else if (next) next();
        else if (!me.consents.privacy) goto('profile');
      });
    });
  }
  async function lineLogin() {
    try {
      const back=new URLSearchParams();
      if (invite) back.set('invite',invite);
      if (eventFilter) back.set('event',eventFilter);
      if (openSurvey) back.set('survey',openSurvey);
      const flow=await api('/auth/line/start?'+back.toString());
      if (flow.mode==='redirect') { location.href=flow.url;return; }
      const box=modal(signed()?'連結 LINE 帳號':'LINE 帳號登入','<form class="form-stack"><p class="note">Demo 模式。使用 1 至 12 可選擇既有測試帳號，或輸入新的測試識別。</p>'+
        field('LINE 測試識別',input('subject',signed()?'':'1','text','required maxlength="100"'))+errorSlot+submit('確認模擬授權')+'</form>');
      bindForms(box,'form',async data=>{
        const result=await api('/auth/line/callback',{body:{state:flow.state,subject:data.get('subject')}});
        if(result.status==='phone_required') {login({pending:true});return;}
        close();await refresh();
        if (result.status==='conflict') {message('身分綁定衝突，已交由人工核驗。','error');return;}
        message(result.status==='linked'?'LINE 已連結。':'LINE 登入成功。');
        if (invite) await openInvite();
      });
    }catch(error){ message(error.message,'error'); }
  }
  function enroll(id,cancel=false) {
    if(!signed()) {login({next:()=>enroll(id,cancel)});return;}
    if(!me.consents.privacy) {goto('profile');message('請先確認個資告知，再加入場次。','error');return;}
    const event=events.find(x=>x.id===id);
    const box=modal(cancel?'取消報名':'確認活動報名','<form class="form-stack"><strong>'+e(event.title)+'</strong><p class="meta">'+icon('calendar')+fdate(event.starts_at,event.timezone,true)+'</p>'+errorSlot+submit(cancel?'確認取消':'確認參加')+'</form>');
    bindForms(box,'form',async ()=>{
      await api('/events/'+encodeURIComponent(id)+'/enrollments',{body:{action:cancel?'cancel':'enroll'}});
      close();await refresh();message(cancel?'已取消報名。':'報名成功，可到「我的問卷」查看時程。');
      const baseline=!cancel&&surveys.find(s=>s.eventId===id&&s.stage==='T0'&&s.status==='open'&&s.form.some(q=>q.key==='veg_days_category'));
      if(baseline) {goto('surveys');showSurvey(baseline.id);}
    });
  }
  function showSurvey(id) {
    const s=surveys.find(row=>row.id===id);
    if(!s||!['open','done'].includes(s.status)) {message(s?.reason??'問卷目前無法開啟。','error');return;}
    const done=s.status==='done';
    const box=modal(s.stageName,'<form class="form-stack"><p class="note">'+e(s.title)+' · v'+e(s.version)+'</p>'+
      '<section class="survey-identity" aria-label="登入者個人資料"><h3>登入者個人資料</h3><dl><div><dt>姓名</dt><dd>'+e(me.name||'尚未設定')+'</dd></div><div><dt>已驗證手機</dt><dd>'+e(me.identities.find(i=>i.kind==='phone')?.mask??'尚未驗證')+'</dd></div><div><dt>居住地</dt><dd>'+e([me.residence_city,me.residence_district].filter(Boolean).join(' ')||me.region||'尚未設定')+'</dd></div></dl><p class="note">使用已登入的個人資料，不需重複填寫；資料異動請至個人資料頁。手機驗證身分用於串接各階段問卷。</p></section>'+
      questionFields(s.form,s.response?.answers,done)+errorSlot+(done?'<p class="meta">'+icon('check')+' 提交於 '+fdate(s.response.submittedAt,s.timezone,true)+'</p><p class="note word-break">回執識別碼 '+e(s.response.id)+'</p>':submit('提交問卷'))+'</form>');
    if(!done) bindForms(box,'form',async data=>{
      const answers=questionAnswers(s.form,data);
      await api('/event-surveys/'+encodeURIComponent(id)+'/responses',{body:{versionId:s.versionId,answers}});
      close();await refresh();message('問卷已提交，感謝您的參與。');
    });
  }
  async function openInvite() {
    if (!invite) return;
    if (!signed()) {login(); return;}
    try {
      const result=await api('/me/invitations/open',{body:{token:invite}});
      const stripped=new URL(location.href);stripped.searchParams.delete('invite');window.history.replaceState(null,'',stripped);
      invite='';goto('surveys');showSurvey(result.surveyId);
    }catch(error){message(error.message,'error');}
  }

  await refresh();
  window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
  const outcome=new URLSearchParams(location.search).get('line');
  if (outcome==='phone_required') {
    login({pending:true,next:openSurvey?()=>{goto('surveys');showSurvey(openSurvey);}:undefined});
    return;
  }
  if (outcome==='conflict') message('身分綁定衝突，已交由人工核驗。','error');
  if (invite) await openInvite();
  else if (openSurvey) {
    const open=()=>{goto('surveys');showSurvey(openSurvey);};
    if (signed()) open();
    else login({next:open});
  }
}
