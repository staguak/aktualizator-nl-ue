import {load} from 'cheerio';
import type {Element} from 'domhandler';
import {XMLValidator} from 'fast-xml-parser';
import {hash,encode} from './release-store.js';
import {isCalendarDate} from './calendar.js';

function observationXml(xml:string):string{
  // XML 1.0 normalizes literal attribute whitespace before entity expansion.
  // Cheerio's XML mode preserves it instead. Character references such as
  // &#10; must retain their different value; CDATA/comments/PI are not tags.
  return xml.replace(/\r\n?/g,'\n').replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')*>/g,
    tag=>tag.startsWith('<!')||tag.startsWith('<?')?tag:
      tag.replace(/"[^"]*"|'[^']*'/g,value=>value.replace(/[\t\n]/g,' ')));
}
function sourceAttributes(node:Element):Record<string,string>{
  // Namespace declarations belong to XML namespace context, not the attribute
  // axis. They remain in the original byte object used to resolve each XPath.
  return Object.fromEntries(Object.entries(node.attribs).filter(([name])=>name!=='xmlns'&&!name.startsWith('xmlns:')));
}

export interface UnitSource {
  jurisdiction:'NL'|'EU';documentId:string;url:string|null;member?:string;containerSha256?:string;
}
export interface UnitObservation {
  element:string;attributes:Record<string,string>;jci:unknown;
  technicalId:string;identityKind:'DERIVED_TECHNICAL';locator:string;parentId:string|null;order:number;
  label:{value:string;locator:string;classification:'OFFICIAL_VALUE'}|null;
  officialIdentifiers:{name:string;value:string;locator:string;scope:'work'|'source-document'}[];
  fields:{name:string;value:string;locator:string;classification:'OFFICIAL_VALUE'}[];
  text:{sha256:string;classification:'DERIVED_TECHNICAL';rule:'XML-descendant-text-v1'};
  legalStatus:'UNRESOLVED';legalDates:'UNRESOLVED';
}
export interface UnitSnapshot {
  profile:'unit-observations-v3'|'unit-correction-observations-v1';source:UnitSource&{sha256:string};root:string;
  locatorSemantics:'Fields and labels use XPath relative to their unit/event locator; absolute locators remain absolute';
  units:UnitObservation[];documentaryLayers:{locator:string;attributes:Record<string,string>}[];
  corrections:{element:'redactionele-correctie';locator:string;attributes:Record<string,string>;
    fields:{name:string;value:string;locator:string;classification:'OFFICIAL_VALUE'}[];
    textSha256:string;legalEffect:'UNRESOLVED';labelMatches:{unit:string;locator:string}[];
    revisionMatchIndexes:{old:number[];new:number[]}}[];
}
export function unitTechnicalId(source:UnitSnapshot['source'],locator:string):string{
  return 'technical-unit-'+hash(encode([source.sha256,source.documentId,source.member??null,locator]));
}

// Structural observations with exact source locators, not a legal-event
// interpreter. Parent dates/status and documentary-layer dates never propagate.
export function observeUnits(bytes:Uint8Array,source:UnitSource):UnitSnapshot{
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Unsafe or invalid unit-observation XML.');
  const $=load(observationXml(xml),{xmlMode:true}),root=$.root().children().first(),rootName=root[0]?.name;
  if(source.jurisdiction==='NL'&&(rootName!=='toestand'||root.attr('bwb-id')!==source.documentId))
    throw new Error('NL unit-observation source identity mismatch.');
  if(source.jurisdiction==='EU'&&!['ACT','CONS.ACT','CONS.OTH','JUDGMENT','GENERAL','CORR'].includes(rootName))
    throw new Error('Unsupported Formex unit-observation root.');
  const correction=source.jurisdiction==='EU'&&rootName==='CORR';
  const snapshot:UnitSnapshot={profile:correction?'unit-correction-observations-v1':'unit-observations-v3',source:{...source,sha256:hash(bytes)},root:rootName,
    locatorSemantics:'Fields and labels use XPath relative to their unit/event locator; absolute locators remain absolute',units:[],documentaryLayers:[],corrections:[]};
  const tags=new Set(source.jurisdiction==='NL'?['artikel','lid','li','bijlage','onderdeel','boek','deel','hoofdstuk','titeldeel','afdeling','paragraaf','sub-paragraaf','subparagraaf','wetgeving','intitule','citeertitel','aanhef','wetsluiting','regeling-sluiting','officiele-inhoudsopgave']:
    ['ARTICLE','PARAG','ALINEA','ITEM','ANNEX','POINT',...correction?
      ['CORR','CONTENTS.CORR','CORRECTION','DESCRIPTION','OLD.CORR','NEW.CORR','P','DLIST','DLIST.ITEM','TERM','DEFINITION','QUOT.S']:[]]);
  const corrections:{node:Element;locator:string}[]=[];
  function visit(node:Element,locator:string,parentId:string|null){
    const attributes=sourceAttributes(node);let parent=parentId;
    if(node.name==='INFO.CONSLEG')snapshot.documentaryLayers.push({locator,attributes});
    if(source.jurisdiction==='NL'&&node.name==='redactionele-correctie')corrections.push({node,locator});
    if(tags.has(node.name)){
      const technicalId=unitTechnicalId(snapshot.source,locator);
      const labelNode=$(node).children(source.jurisdiction==='NL'?'kop':'TI.ART,TI.ANNEX,NO.PARAG,NO.P').first();
      const label=labelNode.length?{value:labelNode.text(),locator:labelNode[0].name+'[1]',classification:'OFFICIAL_VALUE' as const}:null;
      const jcis=$(node).children('meta-data').children('jcis').children('jci').toArray().map(j=>{
        const values=Object.fromEntries(Object.entries(j.attribs).map(([k,v])=>['@_'+k,v]));
        return Object.keys(values).length?values:$(j).text();
      });
      snapshot.units.push({element:node.name,attributes,jci:jcis.length===1?jcis[0]:jcis.length?jcis:null,
        technicalId,identityKind:'DERIVED_TECHNICAL',locator,parentId,order:snapshot.units.length+1,label,
        officialIdentifiers:Object.entries(attributes).sort(([a],[b])=>a.localeCompare(b,'en')).filter(([name])=>['stam-id','versie-id','revisie-id','id','label-id','IDENTIFIER','eId'].includes(name))
          .map(([name,value])=>({name,value,locator:'@'+name,scope:source.jurisdiction==='NL'&&name==='stam-id'?'work':'source-document'})),
        fields:Object.entries(attributes).sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,value])=>({name,value,locator:'@'+name,classification:'OFFICIAL_VALUE'})),
        text:{sha256:hash(Buffer.from($(node).text())),classification:'DERIVED_TECHNICAL',rule:'XML-descendant-text-v1'},
        legalStatus:'UNRESOLVED',legalDates:'UNRESOLVED'});
      parent=technicalId;
    }
    const counts=new Map<string,number>();
    for(const child of $(node).children().toArray()){
      const i=(counts.get(child.name)??0)+1;counts.set(child.name,i);visit(child,`${locator}/${child.name}[${i}]`,parent);
    }
  }
  visit(root[0],'/'+rootName+'[1]',null);
  for(const {node,locator} of corrections){
    const attributes=sourceAttributes(node),label=attributes['label-id'];
    const matched=label?snapshot.units.filter(unit=>unit.attributes['label-id']===label):[];
    snapshot.corrections.push({element:'redactionele-correctie',locator,attributes,
      fields:Object.entries(attributes).sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,value])=>({name,value,locator:'@'+name,classification:'OFFICIAL_VALUE'})),
      textSha256:hash(Buffer.from($(node).text())),legalEffect:'UNRESOLVED',
      labelMatches:matched.map(unit=>({unit:unit.technicalId,locator:unit.locator+'/@label-id'})),
      revisionMatchIndexes:{old:matched.flatMap((unit,index)=>attributes['oud-revisie-id']&&unit.attributes['revisie-id']===attributes['oud-revisie-id']?[index]:[]),
        new:matched.flatMap((unit,index)=>attributes['nieuw-revisie-id']&&unit.attributes['revisie-id']===attributes['nieuw-revisie-id']?[index]:[])}});
  }
  return snapshot;
}

// Join only unambiguous, explicitly work-scoped official identities. Formex
// article numbers/IDENTIFIER values are document-scoped and never suffice.
export function linkOfficialUnitObservations(snapshots:UnitSnapshot[]){
  const groups=new Map<string,{snapshot:number;unit:string;locator:string;label:UnitObservation['label']}[]>(),unresolved:string[]=[];
  const matchesBySnapshot=new Map<number,Map<string,UnitObservation[]>>(),snapshotsByWork=new Map<string,number[]>();
  for(const [index,snapshot] of snapshots.entries()){
    const local=new Map<string,UnitObservation[]>();
    const work=JSON.stringify([snapshot.source.jurisdiction,snapshot.source.documentId]);
    const indexes=snapshotsByWork.get(work);if(indexes)indexes.push(index);else snapshotsByWork.set(work,[index]);
    for(const unit of snapshot.units){
      const id=unit.officialIdentifiers.find(i=>i.scope==='work'&&i.name==='stam-id');
      if(!id){unresolved.push(unit.technicalId);continue;}
      const key=JSON.stringify([snapshot.source.jurisdiction,snapshot.source.documentId,unit.element,id.name,id.value]);
      const matching=local.get(key);if(matching)matching.push(unit);else local.set(key,[unit]);
    }
    for(const [key,units] of local){
      if(units.length!==1){unresolved.push(...units.map(u=>u.technicalId));continue;}
      const unit=units[0];groups.set(key,[...groups.get(key)??[],{snapshot:index,unit:unit.technicalId,locator:unit.locator,label:unit.label}]);
    }
  }
  function indexedMatches(index:number,identity:string){
    let matches=matchesBySnapshot.get(index);
    if(!matches){
      matches=new Map();matchesBySnapshot.set(index,matches);
      const snapshot=snapshots[index];
      for(const unit of snapshot.units){
        // A .some() match counted a unit once even if an input repeated an ID.
        const values=new Set(unit.officialIdentifiers.filter(i=>i.scope==='work'&&i.name==='stam-id').map(i=>i.value));
        for(const value of values){
          const key=JSON.stringify([snapshot.source.jurisdiction,snapshot.source.documentId,unit.element,'stam-id',value]);
          const list=matches.get(key);if(list)list.push(unit);else matches.set(key,[unit]);
        }
      }
    }
    return matches.get(identity)??[];
  }
  return {profile:'official-unit-links-v1',groups:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([identity,observations])=>{
    const [jurisdiction,documentId]=JSON.parse(identity);
    const observed=new Set(observations.map(o=>o.snapshot));
    const otherObservations=snapshotsByWork.get(JSON.stringify([jurisdiction,documentId]))!.flatMap(index=>{
      if(observed.has(index))return [];
      const matching=indexedMatches(index,identity);
      return [{snapshot:index,classification:'TEXT_OBSERVATION',status:matching.length?'AMBIGUOUS_IDENTITY':'NOT_OBSERVED',
        locators:matching.map(u=>u.locator),meaning:'No inference of repeal, split, merge, applicability or succession.'}];
    });
    return {identity:JSON.parse(identity),classification:'OFFICIAL_VALUE',observations,otherObservations,
      meaning:'Same unambiguous official work-scoped identifier; no inferred legal event or applicability interval.'};
  }),unresolved};
}

export interface WtiEventObservation {
  technicalId:string;identityKind:'DERIVED_TECHNICAL';locator:string;
  scope:'work'|'source-unit-reference';unitReference:{labelId:string|null;group:string|null;label:string|null;locator:string}|null;
  nativeLabel:{value:string;locator:string}|null;
  date:{value:string;locator:string;semantic:'WTI-datum-waarde'}|null;
  state:ReturnType<typeof wtiStateEvidence>|null;
  windowRelation:'WITHIN_WINDOW'|'BEFORE_WINDOW'|'AFTER_WINDOW'|'UNRESOLVED';legalEffect:'UNRESOLVED';
  fields:{value:string;locator:string;classification:'OFFICIAL_VALUE'}[];
}
export function wtiStateEvidence(attributes:Record<string,string>,locator:string){
  return {locator,attributes,fields:Object.entries(attributes).sort(([a],[b])=>a.localeCompare(b,'en'))
    .map(([name,value])=>({name,value,locator:locator+'/@'+name,classification:'OFFICIAL_VALUE' as const}))};
}
export function observeWti(bytes:Uint8Array,source:UnitSource,range:{from:string;to:string}){
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Unsafe or invalid WTI observation XML.');
  const $=load(observationXml(xml),{xmlMode:true}),root=$.root().children().first();
  if(root[0]?.name!=='wetstechnische-informatie'||root.attr('bwb-id')!==source.documentId)throw new Error('WTI source identity mismatch.');
  const locators=new Map<Element,string>();
  function locate(node:Element,locator:string){locators.set(node,locator);const counts=new Map<string,number>();
    for(const child of $(node).children().toArray()){
      const i=(counts.get(child.name)??0)+1;counts.set(child.name,i);locate(child,`${locator}/${child.name}[${i}]`);
    }}
  locate(root[0],'/wetstechnische-informatie[1]');
  const sha256=hash(bytes),events:WtiEventObservation[]=[];
  for(const node of root.find('details').toArray()){
    const parentDate=$(node).parents('datum').first(),unit=$(node).parents('regelingelement').first();
    const dateValue=parentDate.attr('waarde'),label=$(node).children('betreft').first(),locator=locators.get(node)!;
    const fields:WtiEventObservation['fields']=[];
    for(const element of [node,...$(node).find('*').toArray()]){
      const relative=element===node?'':locators.get(element)!.slice(locator.length+1)+'/';
      for(const [name,value] of Object.entries(sourceAttributes(element)))fields.push({value,locator:relative+'@'+name,classification:'OFFICIAL_VALUE'});
      if(!$(element).children().length){
        const value=$(element).text();
        if(value.trim())fields.push({value,locator:relative+'text()',classification:'OFFICIAL_VALUE'});
      }else{
        // Adjacent text/CDATA form one XPath text node. Never concatenate
        // prefix and tail around child elements into a new official value.
        const runs:string[]=[];let current:string|undefined;
        for(const child of $(element).contents().toArray()){
          if(child.type==='text'||child.type==='cdata')current=(current??'')+$([child]).text();
          else if(current!==undefined){runs.push(current);current=undefined;}
        }
        if(current!==undefined)runs.push(current);
        runs.forEach((value,index)=>{if(value.trim())fields.push({value,locator:relative+`text()[${index+1}]`,classification:'OFFICIAL_VALUE'});});
      }
    }
    events.push({technicalId:'technical-wti-'+hash(encode([sha256,locator])),identityKind:'DERIVED_TECHNICAL',locator,
      scope:unit.length?'source-unit-reference':'work',unitReference:unit.length?{labelId:unit.attr('label-id')??null,
        group:unit.attr('groep')??null,label:unit.attr('label')??null,locator:locators.get(unit[0])!}:null,
      nativeLabel:label.length?{value:label.text(),locator:label.children().length?'string(betreft[1])':'betreft[1]/text()'}:null,
      date:dateValue?{value:dateValue,locator:locators.get(parentDate[0])!+'/@waarde',semantic:'WTI-datum-waarde'}:null,
      state:parentDate.length?wtiStateEvidence(sourceAttributes(parentDate[0]),locators.get(parentDate[0])!):null,
      windowRelation:!isCalendarDate(dateValue)?'UNRESOLVED':dateValue<range.from?'BEFORE_WINDOW':dateValue>range.to?'AFTER_WINDOW':'WITHIN_WINDOW',
      legalEffect:'UNRESOLVED',fields});
  }
  return {profile:'wti-observations-v2',source:{...source,sha256},locatorSemantics:
    'Fields and labels use XPath relative to their unit/event locator; absolute locators remain absolute',events};
}
export function correlateWtiUnits(history:ReturnType<typeof observeWti>,snapshots:UnitSnapshot[]){
  const references=new Map<string,{snapshot:number;unit:string;locator:string}[]>();
  const versions=new Map<string,string|undefined>();
  for(const [index,snapshot] of snapshots.entries()){
    if(snapshot.source.jurisdiction!=='NL'||snapshot.source.documentId!==history.source.documentId)continue;
    for(const unit of snapshot.units){const label=unit.attributes['label-id'];if(!label)continue;
      versions.set(unit.technicalId,unit.attributes['versie-id']);
      for(const group of ['',unit.element]){
        const key=JSON.stringify([label,group]),match={snapshot:index,unit:unit.technicalId,locator:unit.locator+'/@label-id'};
        references.set(key,[...references.get(key)??[],match]);
      }
    }
  }
  return history.events.map(event=>{
    const matches=event.unitReference?.labelId?references.get(JSON.stringify([event.unitReference.labelId,event.unitReference.group??'']))??[]:[];
    const counts=new Map<number,number>();matches.forEach(m=>counts.set(m.snapshot,(counts.get(m.snapshot)??0)+1));
    const version=event.state?.attributes['versie-id'];
    return {event:event.technicalId,status:counts.size?[...counts.values()].some(n=>n>1)?'AMBIGUOUS':'EXACT_SOURCE_LABEL_ID':'UNRESOLVED',matches,
      ...version?{versionMatchIndexes:matches.flatMap((match,index)=>versions.get(match.unit)===version?[index]:[])}:{},
      meaning:'Source reference correlation only; work-level dates are not inherited and no legal effect is inferred.'};
  });
}
