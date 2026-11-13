import {isCalendarDate} from './calendar.js';
import {selectBwbVersions} from './sru.js';
import type {VersionRecord,ScopeConfig,ScopeAct,ParsedStatute} from './types.js';
import type {EuAct,EuDocument} from './eu-provider.js';

import {documentDate} from './eu-dates.js';
export {documentDate} from './eu-dates.js';
export function baselineNlUnits(act:ScopeAct,statutes:ParsedStatute[]){
  if(!statutes.length||statutes.some(s=>s.bwbId!==act.bwbId||!s.provisions.length))throw new Error('Unconfirmed BWB unit snapshot.');
  const units=statutes.flatMap(s=>s.provisions),present=new Set(units.map(p=>p.article));
  const articles=act.include.articles?.filter(a=>present.has(a));
  const structures=act.include.structures?.filter(s=>units.some(p=>p.structurePath===s||p.structurePath.startsWith(s+'/')));
  const missing=[...new Set([...(act.include.articles??[]),...act.mustIncludeArticles].filter(a=>!present.has(a)))];
  const missingStructures=(act.include.structures??[]).filter(s=>!structures?.includes(s));
  const updated={...act,include:{...act.include,...(articles?{articles}:{}),...(structures?{structures}:{})},
    mustIncludeArticles:act.mustIncludeArticles.filter(a=>present.has(a))};
  return {act:updated,evidence:{bwbId:act.bwbId,missing,missingStructures,
    meaning:'Requested unit absent from parsed official baseline snapshot; no repeal or application date inferred.'}};
}
export function baselineEuAct(act:EuAct,documents:EuDocument[],on:string):{act:EuAct|null;excluded:string[];evidence:unknown}{
  if(!isCalendarDate(on))throw new Error('Invalid base date.');
  const original=documents.find(d=>d.celex===act.celex),originalDate=original?documentDate(original):null;
  const priorConsolidation=documents.some(d=>d.celex.startsWith('0')&&documentDate(d)!&&documentDate(d)!<=on);
  if(originalDate&&originalDate>on)return {act:null,excluded:[act.celex],evidence:{celex:act.celex,
    reason:'Original documentary date is later than baseline; no normative status inferred.',documentaryDate:originalDate}};
  if(!originalDate&&!priorConsolidation)throw new Error(`No dated baseline evidence for ${act.celex}.`);
  const excluded:string[]=[];
  const eligible=(celex:string)=>{
    const doc=documents.find(d=>d.celex===celex),date=doc?documentDate(doc):null;
    if(!date)throw new Error(`Unknown baseline documentary date: ${celex}.`);
    if(date>on){excluded.push(celex);return false;}return true;
  };
  return {act:{...act,requiredVersions:act.requiredVersions.filter(eligible),
    attachedDocuments:act.attachedDocuments.filter(d=>eligible(d.celex))},excluded,
    evidence:{celex:act.celex,originalDate,priorConsolidation,excluded,meaning:'Documentary baseline selection; legal applicability remains source-specific.'}};
}
export function baselineNlScope(config:ScopeConfig,catalog:Map<string,VersionRecord[]>,on:string,observedOn:string){
  const evidence:unknown[]=[];
  const acts=config.acts.filter(act=>{
    const versions=catalog.get(act.bwbId);if(!versions?.length)throw new Error('Missing BWB base catalog.');
    // Do not turn malformed/ambiguous intervals into an exclusion.
    if(versions.some(v=>!v.validFrom||!isCalendarDate(v.validFrom)||
      [v.validTo,v.visibleFrom,v.visibleTo].some(d=>d&&!isCalendarDate(d))))throw new Error('Undated BWB baseline state.');
    const inRange=versions.some(v=>v.validFrom!<=on&&(!v.validTo||v.validTo>=on)&&
      (!v.visibleFrom||v.visibleFrom<=observedOn)&&(!v.visibleTo||v.visibleTo>=observedOn));
    if(!inRange)throw new Error(`No confirmed BWB baseline state for ${act.bwbId}; source absence cannot narrow the configured act scope.`);
    evidence.push({bwbId:act.bwbId,states:selectBwbVersions(versions,on,on,observedOn)});return true;
  }).map((act,i)=>({...act,order:i+1}));
  if(!acts.length)throw new Error('No confirmed BWB baseline acts.');return {config:{...config,acts},evidence};
}
