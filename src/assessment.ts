export const ASSESSMENT_STAGES=['T0','T1B','T2','T3','STAFF'];
export const VEG_DAYS=['0 天','1 天','2 至 3 天','4 天以上'];
export const COUNTERFACTUAL=['跟現在一樣','大概只有現在的一半','不會有改變'];
export const SHARES=['0%','25%','50%','75%','100%'];
export const SKILLS=[['planning','規劃'],['leadership','帶領團隊'],['communication','協調溝通'],['response','臨場應變']];
const choice=(key:string,label:string,options:string[])=>({key,label,type:'choice',options,required:true});
const rating=(key:string,label:string)=>({key,label,type:'integer',min:1,max:5,required:true});
const frequency=()=>({...choice('veg_days_category','過去一個月，您平均每週有幾天是全日蔬食（三餐皆蔬食）？',VEG_DAYS),metricVersion:'whole-day-frequency-v2',unit:'級'});
export function assessmentQuestions(stage:string):any[] {
  if(stage==='T0') return [choice('tracking_consent','您是否同意在活動後 3 到 6 個月內，填寫一次簡短的追蹤問卷？',['同意','不同意']),frequency(),rating('knowledge','您對蔬食與減碳關係的了解程度')];
  if(stage==='T1B') return [rating('knowledge_before_recalled','回想參加活動之前，您對蔬食與減碳關係的了解程度'),rating('knowledge','您對蔬食與減碳關係的了解程度'),
    {key:'action_commitments',label:'活動後，您願意採取哪些蔬食行動？（可複選）',type:'multichoice',required:true,options:['每週增加一天蔬食','外食優先選蔬食餐廳','登錄蔬食 A 計劃','邀家人一起吃蔬食','參加下一場 VEGRUN','其他']},
    rating('community_connection','參加這次活動後，我和分會或社區夥伴的連結更緊密')];
  if(['T2','T3'].includes(stage)) return [frequency(),choice('counterfactual','如果沒有參加這次活動，您覺得自己現在的蔬食習慣會是？',COUNTERFACTUAL),
    choice('activity_share','您目前的改變，大約有多少比例是因為這次活動？（其他可能來自政策、媒體、家人等）',SHARES)];
  if(stage==='STAFF') return [choice('cadre_role','這次您擔任的角色',['總籌','路線與交管','補給站','報到檢錄','醫護','其他']),
    {key:'hours',label:'您投入的時數（籌備＋當天）',type:'number',min:0,max:10000,required:true,unit:'小時'},
    ...SKILLS.flatMap(([key,label])=>[rating(key+'_before',label+'：參加前'),rating(key+'_after',label+'：參加後')]),
    choice('counterfactual','如果沒有擔任這次幹部，您覺得這些能力現在會是？',COUNTERFACTUAL),
    choice('activity_share','這些成長大約有多少比例來自這次活動？（其他可能來自工作、其他培訓）',SHARES),
    {key:'improvement',label:'下次辦活動，您最想改進的一件事',type:'text',maxLength:1000,required:true}];
  return [];
}
export const COLLECTION_TIMELINE=[
  {title:'活動前',time:'約 14 至 30 天前',detail:'報名時填寫基線問卷；活動開始後不補填基線。'},
  {title:'活動當天',time:'第 0 天',detail:'記錄簽到、物資及捐秤重；賽後領餐盒時掃 QR Code 填後測。'},
  {title:'活動後',time:'約 2 週內',detail:'經費決算；幹部回饋問卷於活動後第 7 至 14 天填寫。'},
  {title:'第一次追蹤',time:'約 3 個月後',detail:'使用相同蔬食天數題目，記錄行為、無謂及歸因。'},
  {title:'第二次追蹤',time:'約 6 個月後',detail:'再次填寫相同追蹤問卷，比較行為持續情形。'},
  {title:'試算與驗證',time:'之後約 1 個月',detail:'彙整回填資料、試算與敏感度分析，安排利害關係人座談。'}
];
