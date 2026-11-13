import {isDeepStrictEqual} from 'node:util';
import type {UnitObservation} from './unit-observations.js';
import {wtiStateEvidence,unitTechnicalId} from './unit-observations.js';
import type {UnitSnapshot} from './unit-observations.js';

function expandWtiState(locator:string,attributes:Record<string,string>|null){
  if(attributes===null)return null;
  if(!/\/datum\[\d+\]\/details\[\d+\]$/.test(locator)||typeof attributes!=='object'||Array.isArray(attributes)||
    !Object.values(attributes).every(value=>typeof value==='string'))throw new Error('Invalid WTI state attributes or locator.');
  return wtiStateEvidence(attributes,locator.replace(/\/details\[\d+\]$/,''));
}

// Lossless factoring of fixed classifications and facts already represented by
// direct attributes. No source assertion, locator or unknown field is dropped.
function expandUnit(value:any,jurisdiction:string,profile:string):UnitObservation{
  const entries=Object.entries(value.attributes as Record<string,string>).sort(([a],[b])=>a.localeCompare(b,'en'));
  return {...value,identityKind:'DERIVED_TECHNICAL',legalStatus:'UNRESOLVED',legalDates:'UNRESOLVED',
    fields:entries.map(([name,text])=>({name,value:text,locator:'@'+name,classification:'OFFICIAL_VALUE'})),
    officialIdentifiers:entries.filter(([name])=>['stam-id','versie-id','id','label-id','IDENTIFIER','eId',...profile!=='unit-observations-v2'?['revisie-id']:[]].includes(name))
      .map(([name,text])=>({name,value:text,locator:'@'+name,scope:jurisdiction==='NL'&&name==='stam-id'?'work':'source-document'})),
    text:{...value.text,classification:'DERIVED_TECHNICAL',rule:'XML-descendant-text-v1'}};
}
function packUnit(unit:UnitObservation,jurisdiction:string,profile:string){
  const {fields,officialIdentifiers,identityKind,legalStatus,legalDates,text,...rest}=unit;
  const compact={...rest,text:{sha256:text.sha256}};
  if(!isDeepStrictEqual(expandUnit(compact,jurisdiction,profile),unit))throw new Error('Unit encoding would lose source observations.');
  return compact;
}
function packUnits(units:UnitObservation[],source:UnitSnapshot['source'],jurisdiction:string,profile:string){
  if(!source||!/^[a-f0-9]{64}$/.test(source.sha256)||typeof source.documentId!=='string')throw new Error('Missing unit source identity.');
  const ids=new Map(units.map((unit,index)=>[unit.technicalId,index]));
  if(ids.size!==units.length)throw new Error('Duplicate technical unit identity.');
  const packed=units.map((unit,index)=>{
    if(unit.technicalId!==unitTechnicalId(source,unit.locator))throw new Error('Unit technical identity differs from its source locator.');
    const {technicalId,parentId,...rest}=packUnit(unit,jurisdiction,profile);
    const parentIndex=parentId===null?null:ids.get(parentId);
    if(parentIndex===undefined||parentIndex!==null&&parentIndex>=index)throw new Error('Invalid technical unit hierarchy.');
    return {...rest,parentIndex};
  });
  if(!isDeepStrictEqual(expandUnits(packed,source,jurisdiction,profile),units))throw new Error('Unit locator encoding would lose source observations.');
  return packed;
}
function expandUnits(units:any[],source:UnitSnapshot['source'],jurisdiction:string,profile:string){
  if(!source||!/^[a-f0-9]{64}$/.test(source.sha256)||typeof source.documentId!=='string')throw new Error('Missing unit source identity.');
  const ids=units.map(unit=>unitTechnicalId(source,unit.locator));
  if(new Set(ids).size!==ids.length)throw new Error('Duplicate technical unit identity.');
  return units.map((unit,index)=>{
    if(['technicalId','parentId','fields','officialIdentifiers','identityKind','legalStatus','legalDates'].some(key=>Object.hasOwn(unit,key))||
      Object.keys(unit.text).some(key=>key!=='sha256'))throw new Error('Conflicting fact in encoded unit evidence.');
    const {parentIndex,...rest}=unit;
    if(parentIndex!==null&&(!Number.isInteger(parentIndex)||parentIndex<0||parentIndex>=index))throw new Error('Invalid technical parent index.');
    return expandUnit({...rest,technicalId:ids[index],parentId:parentIndex===null?null:ids[parentIndex]},jurisdiction,profile);
  });
}
export function encodeUnitMetadata(metadata:any,jurisdiction:string):any{
  if(!metadata||typeof metadata!=='object')return metadata;
  const result={...metadata};
  if(['unit-observations-v2','unit-observations-v3'].includes(result.unitHistoryProfile)){
    result.units=packUnits(result.units,result.unitHistorySource,jurisdiction,result.unitHistoryProfile);result.unitEncoding='source-locators-v2';
  }
  if(Array.isArray(result.unitHistory))result.unitHistory=result.unitHistory.map((snapshot:any)=>{
    checkCorrectionProfile(snapshot,jurisdiction);
    return {...snapshot,unitEncoding:'source-locators-v2',units:packUnits(snapshot.units,snapshot.source,snapshot.source.jurisdiction,snapshot.profile)};
  });
  if(result.wtiHistory?.profile==='wti-observations-v2'){
    const history=result.wtiHistory;
    const packStates=history.events.every((event:any)=>Object.hasOwn(event,'state'));
    const events=history.events.map((event:any)=>{
      const {identityKind,legalEffect,fields,...rest}=event;
      let compact:any={...rest,fields:fields.map((field:any)=>{
        const {classification,...value}=field;if(classification!=='OFFICIAL_VALUE')throw new Error('WTI field classification cannot be factored.');return value;
      })};
      if(identityKind!=='DERIVED_TECHNICAL'||legalEffect!=='UNRESOLVED')throw new Error('WTI effect cannot be factored.');
      if(packStates){
        if(Object.hasOwn(event,'stateAttributes'))throw new Error('Conflicting WTI state facts.');
        const {state,...other}=compact,attributes=state?.attributes??null;
        if(!isDeepStrictEqual(state,expandWtiState(event.locator,attributes)))throw new Error('WTI state encoding would lose source observations.');
        compact={...other,stateAttributes:attributes};
      }
      return compact;
    });
    result.wtiHistory={...history,eventEncoding:'direct-fields-v1',...packStates?{stateEncoding:'direct-state-attributes-v1'}:{},events};
  }
  return result;
}
export function decodeUnitMetadata(metadata:any,jurisdiction:string):void{
  if(!metadata||typeof metadata!=='object')return;
  const expandEncoded=(unit:any,scope:string,profile:string)=>{
    if(['fields','officialIdentifiers','identityKind','legalStatus','legalDates'].some(key=>Object.hasOwn(unit,key))||
      Object.keys(unit.text).some(key=>key!=='sha256'))throw new Error('Conflicting fact in encoded unit evidence.');
    return expandUnit(unit,scope,profile);
  };
  if(metadata.unitEncoding!==undefined){
    if(!['direct-attributes-v1','source-locators-v2'].includes(metadata.unitEncoding)||!['unit-observations-v2','unit-observations-v3'].includes(metadata.unitHistoryProfile))throw new Error('Unknown unit evidence encoding.');
    metadata.units=metadata.unitEncoding==='source-locators-v2'?expandUnits(metadata.units,metadata.unitHistorySource,jurisdiction,metadata.unitHistoryProfile):metadata.units.map((unit:any)=>expandEncoded(unit,jurisdiction,metadata.unitHistoryProfile));
  }
  if(Array.isArray(metadata.unitHistory))for(const snapshot of metadata.unitHistory){
    checkCorrectionProfile(snapshot,jurisdiction);
    if(snapshot.unitEncoding!==undefined){
      if(!['direct-attributes-v1','source-locators-v2'].includes(snapshot.unitEncoding)||!['unit-observations-v2','unit-observations-v3','unit-correction-observations-v1'].includes(snapshot.profile))throw new Error('Unknown Formex evidence encoding.');
      snapshot.units=snapshot.unitEncoding==='source-locators-v2'?expandUnits(snapshot.units,snapshot.source,snapshot.source.jurisdiction,snapshot.profile):snapshot.units.map((unit:any)=>expandEncoded(unit,snapshot.source.jurisdiction,snapshot.profile));
    }
  }
  const history=metadata.wtiHistory;
  if(history?.eventEncoding!==undefined){
    if(history.eventEncoding!=='direct-fields-v1'||history.profile!=='wti-observations-v2')throw new Error('Unknown WTI evidence encoding.');
    if(history.stateEncoding!==undefined&&history.stateEncoding!=='direct-state-attributes-v1')throw new Error('Unknown WTI state encoding.');
    history.events=history.events.map((event:any)=>{
      if(Object.hasOwn(event,'identityKind')||Object.hasOwn(event,'legalEffect')||
        event.fields.some((field:any)=>Object.hasOwn(field,'classification')))throw new Error('Conflicting fact in encoded WTI evidence.');
      let expanded={...event,identityKind:'DERIVED_TECHNICAL',legalEffect:'UNRESOLVED',
        fields:event.fields.map((field:any)=>({...field,classification:'OFFICIAL_VALUE'}))};
      if(history.stateEncoding){
        if(Object.hasOwn(event,'state')||!Object.hasOwn(event,'stateAttributes'))throw new Error('Conflicting WTI state facts.');
        const {stateAttributes,...other}=expanded;
        expanded={...other,state:expandWtiState(event.locator,stateAttributes)};
      }
      return expanded;
    });
  }
}

function checkCorrectionProfile(snapshot:any,jurisdiction:string){
  if(snapshot.profile==='unit-correction-observations-v1'&&
    (jurisdiction!=='EU'||snapshot.source?.jurisdiction!=='EU'||snapshot.root!=='CORR'))
    throw new Error('Correction observation profile requires an EU CORR source.');
}
