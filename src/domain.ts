export const PROGRAMS = [
  { code: 'VGR', title: 'VEGRUN 復蔬公益路跑', summary: '用每一步支持公益，讓蔬食成為生活的一部分。', metric: 'diet_meals_7d', unit: '餐', theme: '公益路跑', image: 'run' },
  { code: 'EARTH', title: '世界地球日 × 森林覺醒', summary: '走進森林，認識原生物種，實踐友善生態的行動。', metric: 'conservation_days_30d', unit: '天', theme: '森林保育', image: 'forest' },
  { code: 'VEG', title: '綠・蔬食評鑑指南', summary: '探索在地蔬食，以每一次用餐支持友善飲食。', metric: 'veg_restaurant_visits_30d', unit: '次', theme: '綠色飲食', image: 'food' },
];
export const STAGES: Record<string, string> = { T0:'活動前問卷', T1A:'活動中微問卷', T1B:'活動後問卷', F30:'30 天追蹤', T2:'90 天追蹤', T3:'180 天追蹤' };
export const FOLLOW = ['F30','T2','T3'];
export const NOTICE = process.env.SIMP_DEMO === '0' ? (process.env.SIMP_NOTICE_VERSION || '') : 'demo-v1';
export const NOTICE_TEXT = process.env.SIMP_DEMO === '0' ? (process.env.SIMP_NOTICE_TEXT || '') : '平台使用已驗證的聯絡方式及活動紀錄，處理報名、問卷、回收統計與去識別成效分析。您可以隨時變更各方案的追蹤同意。';
export const iso = (offset = 0) => new Date(Date.now()+offset).toISOString();
export const DAY = 86400000;

export function questions(program: string, stage: string) {
  const core: Record<string, any> = {
    VGR: { key:'diet_meals_7d', label:'過去 7 天，您的三餐共有幾餐是蔬食？', help:'蔬食可含蛋奶，無肉類、魚類或海鮮。', min:0, max:21, unit:'餐' },
    EARTH: { key:'conservation_days_30d', label:'過去 30 天，您有幾天進行森林保育或生態友善行動？', help:'同一天做了多項行動，合計算一天。', min:0, max:30, unit:'天' },
    VEG: { key:'veg_restaurant_visits_30d', label:'過去 30 天，您實際到蔬食餐廳消費幾次？', help:'瀏覽指南或餐廳資訊的次數可略過。', min:0, max:1000, unit:'次' }
  };
  const scale = { key:'awareness', label:'您對本方案倡議的了解程度為何？', type:'choice', options:['還不熟悉','略有了解','能向他人介紹'], required:false };
  if (stage === 'T1A') return [{...scale, label:'您在現場接觸到本方案的倡議了嗎？'}];
  if (stage === 'T1B') return [scale,{key:'action_intent',label:'接下來一個月，您願意採取友善行動嗎？', type:'choice', options:['願意','尚未決定','目前沒有安排'],required:false}];
  return [{...core[program], type:'integer', required:false, metricVersion:'1'},scale];
}

export class Problem extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status=status;
    this.code=code;
  }
}
export function demand(value: unknown, status: number, code: string, message: string): asserts value {
  if (!value) throw new Problem(status,code,message);
}
export function normalizePhone(value: unknown) {
  let phone = String(value ?? '').trim().replace(/[()\s-]/g,'');
  if (/^09\d{8}$/.test(phone)) phone = '+886'+phone.slice(1);
  demand(/^\+[1-9]\d{7,14}$/.test(phone),422,'PHONE_INVALID','請輸入有效的手機號碼，例如 0912 345 678。');
  return phone;
}
export function normalizeCard(value: unknown) {
  const card=String(value ?? '').normalize('NFKC').toUpperCase().replace(/[\s-]/g,'');
  demand(/^[A-Z0-9]{4,24}$/.test(card),422,'CARD_INVALID','卡號請輸入 4 至 24 位英數字。');
  return card;
}
export function date(value: unknown) {
  demand(typeof value==='string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)),422,'DATE_FORMAT','請輸入包含時區的日期時間。');
  return new Date(value).toISOString();
}
export function localDays(anchor: string, zone: string, days: number) {
  const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function wall(value: number) {
    const parts = Object.fromEntries(formatter.formatToParts(value).map(({type,value})=>[type,Number(value)]));
    return Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
  }
  const target = wall(Date.parse(anchor))+days*DAY;
  let result = target;
  for (let n=0; n<3; n++) result += target-wall(result);
  return new Date(result).toISOString();
}
export function plannedWindow(event: any, stage: string) {
  switch(stage) {
    case 'T0': return [localDays(event.starts_at,event.timezone,-14),event.starts_at];
    case 'T1A': return [event.starts_at,event.ends_at];
    case 'T1B': return [event.ends_at,new Date(Date.parse(event.ends_at)+72*3600000).toISOString()];
    default: {
      const days = {F30:30,T2:90,T3:180}[stage];
      return [localDays(event.ends_at,event.timezone,days),localDays(event.ends_at,event.timezone,days+7)];
    }
  }
}
export function validAnswers(schema: any[], answers: any) {
  demand(answers && typeof answers==='object' && !Array.isArray(answers),422,'ANSWERS','請提供有效的問卷答案。');
  demand(Object.keys(answers).every(k=>schema.some(q=>q.key===k)),422,'QUESTION_UNKNOWN','回答含有問卷版本以外的題目。');
  return Object.fromEntries(schema.map(q=>{
    const answer = answers[q.key] ?? null;
    const valid = answer===null ? !q.required : q.type==='integer' ?
      Number.isInteger(answer) && answer>=q.min && answer<=q.max : q.options.includes(answer);
    demand(valid,422,'ANSWER_INVALID',q.label+' 的答案不符合設定。');
    return [q.key,answer];
  }));
}
export function rate(numerator: number, denominator: number) {
  return {numerator,denominator,percent:denominator ? Math.round(1000*numerator/denominator)/10 : null};
}
export function mean(values: number[]) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
export function median(values: number[]) {
  const sorted=[...values].sort((a,b)=>a-b), length=sorted.length, i=Math.floor(length/2);
  return length ? (length%2 ? sorted[i] : (sorted[i-1]+sorted[i])/2) : null;
}
