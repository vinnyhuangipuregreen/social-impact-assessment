import {api, empty, e} from './ui.js';

const root=document.querySelector('#app');
try {
  const config=await api('/config');
  if (location.pathname.startsWith('/admin')) {
    const {startAdmin}=await import('./admin.js');
    await startAdmin(root,config);
  } else {
    const {startPublic}=await import('./public.js');
    await startPublic(root,config);
  }
} catch (error) {
  root.innerHTML='<main id="main" class="loading">'+empty('平台暫時無法載入',e(error.message))+'</main>';
}
