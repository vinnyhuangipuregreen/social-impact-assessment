import { all } from './store.ts';
import { mean, rate } from './domain.ts';
import { VEG_DAYS, COUNTERFACTUAL, SHARES, SKILLS } from './assessment.ts';

export async function assessmentReport(events:any[],filters:any,until:string,since:string,minimum:number) {
  const results=[];
  for(const program of [...new Set(events.map(event=>event.program))]) {
    const groups=new Map<string,any>();
    for(const event of events.filter(event=>event.program===program)) {
      const rows=await all(`SELECT r.participant_id,r.answers_json,r.submitted_at,s.stage,v.schema_json,p.member_status,p.district_id,p.chapter_id
        FROM responses r JOIN event_surveys s ON s.id=r.event_survey_id JOIN survey_versions v ON v.id=r.version_id
        JOIN profiles p ON p.participant_id=r.participant_id JOIN participants pa ON pa.id=p.participant_id AND pa.status='active'
        WHERE s.event_id=? AND r.effective=1 AND r.submitted_at<=?`,event.id,until);
      for(const row of rows) {
        if((filters.member&&row.member_status!==filters.member)||(filters.district&&row.district_id!==filters.district)||(filters.chapter&&row.chapter_id!==filters.chapter)) continue;
        const schema=JSON.parse(row.schema_json);
        if(!schema.some(q=>q.key==='veg_days_category'||q.key==='cadre_role'||q.key==='community_connection')) continue;
        const key=event.id+':'+row.participant_id, group=groups.get(key)??{};
        const frequency=schema.find(q=>q.key==='veg_days_category');
        group[row.stage]={answers:JSON.parse(row.answers_json),inPeriod:row.submitted_at>=since,
          definition:frequency?.metricVersion?frequency.metricVersion+':'+frequency.unit+':'+JSON.stringify(frequency.options):null};groups.set(key,group);
      }
    }
    const rows=[...groups.values()];
    const baseline=rows.filter(row=>VEG_DAYS.includes(row.T0?.answers.veg_days_category));
    const posts=rows.filter(row=>row.T1B?.inPeriod),cadres=rows.filter(row=>row.STAFF?.inPeriod);
    const follow=(stage:string)=>{
      const responses=rows.filter(row=>row[stage]?.inPeriod&&VEG_DAYS.includes(row[stage].answers.veg_days_category));
      const paired=responses.filter(row=>VEG_DAYS.includes(row.T0?.answers.veg_days_category)&&row.T0.definition&&row.T0.definition===row[stage].definition);
      const improved=paired.filter(row=>VEG_DAYS.indexOf(row[stage].answers.veg_days_category)>VEG_DAYS.indexOf(row.T0.answers.veg_days_category)).length;
      const weights=responses.map(row=>[1,.5,0][COUNTERFACTUAL.indexOf(row[stage].answers.counterfactual)]).filter(Number.isFinite);
      const shares=responses.map(row=>SHARES.indexOf(row[stage].answers.activity_share)/4).filter(value=>value>=0);
      return {stage,responses:responses.length,paired:paired.length,improved,persistence:rate(improved,paired.length),
        deadweight:weights.length>=minimum?mean(weights):null,activityShare:shares.length>=minimum?mean(shares):null,
        otherAttribution:shares.length>=minimum?1-mean(shares)!:null};
    };
    const knowledge=posts.filter(row=>Number.isInteger(row.T0?.answers.knowledge)).map(row=>row.T1B.answers.knowledge-row.T0.answers.knowledge);
    const recalled=posts.filter(row=>!Number.isInteger(row.T0?.answers.knowledge)).map(row=>row.T1B.answers.knowledge-row.T1B.answers.knowledge_before_recalled).filter(Number.isFinite);
    const gains=cadres.map(row=>mean(SKILLS.map(([key])=>row.STAFF.answers[key+'_after']-row.STAFF.answers[key+'_before']))??0).filter(Number.isFinite);
    const cadreWeights=cadres.map(row=>[1,.5,0][COUNTERFACTUAL.indexOf(row.STAFF.answers.counterfactual)]).filter(Number.isFinite);
    const cadreShares=cadres.map(row=>SHARES.indexOf(row.STAFF.answers.activity_share)/4).filter(value=>value>=0);
    const earlier=follow('T2'),later=follow('T3');
    const both=rows.filter(row=>row.T3?.inPeriod&&VEG_DAYS.includes(row.T0?.answers.veg_days_category)&&VEG_DAYS.includes(row.T2?.answers.veg_days_category)&&VEG_DAYS.includes(row.T3.answers.veg_days_category)&&row.T0.definition&&row.T0.definition===row.T2.definition&&row.T0.definition===row.T3.definition);
    const improvedAt=(stage:string)=>both.filter(row=>VEG_DAYS.indexOf(row[stage].answers.veg_days_category)>VEG_DAYS.indexOf(row.T0.answers.veg_days_category)).length;
    const first=improvedAt('T2'),second=improvedAt('T3');
    results.push({program,metricVersion:'whole-day-frequency-v2',baseline:baseline.length,post:posts.length,
      knowledgePairs:knowledge.length,knowledgeGain:knowledge.length>=minimum?mean(knowledge):null,recalledPairs:recalled.length,recalledGain:recalled.length>=minimum?mean(recalled):null,
      connected:posts.filter(row=>row.T1B.answers.community_connection>=4).length,follow:[earlier,later],
      repeatPairs:both.length,dropOff:both.length>=minimum&&first>0?Math.max(0,1-second/first):null,
      cadreCount:cadres.length,cadreHours:cadres.length>=minimum?cadres.reduce((sum,row)=>sum+row.STAFF.answers.hours,0):null,
      cadreImproved:gains.filter(value=>value>=1).length,cadreAverageGain:gains.length>=minimum?mean(gains):null,
      cadreDeadweight:cadreWeights.length>=minimum?mean(cadreWeights):null,cadreActivityShare:cadreShares.length>=minimum?mean(cadreShares):null});
  }
  return results;
}
