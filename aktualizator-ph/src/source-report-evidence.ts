import {isDeepStrictEqual} from 'node:util';
import {stableCompactJson} from './output.js';
import {hash} from './release-store.js';

const digest=(value:unknown)=>hash(Buffer.from(stableCompactJson(value)));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export interface SourceReportEvidence {
  profile:'source-report-evidence-v1';
  identityKind:'DERIVED_TECHNICAL_SCOPED_KEY';
  selectionScope:'WHOLE_ARCHIVED_SOURCE_MODEL_NOT_ONLY_MARKDOWN_SELECTION';
  units:[string,string[],string[],number,string][];
  ambiguousIdentities:string[];unresolvedObservations:number;
  unstructuredDocuments:string[];
  documents:string[];corrections:[string,string,number][];corrigenda:[string,string][];
  representations:[string,string,string][];
  scope:'Official work IDs or official IDs within the same source document/member; no inferred legal continuity';
}

// Build a compact comparison index from the already expanded source model.
// Native payloads and full event multiplicity remain in the original catalog.
// Hash sets summarize text/own metadata only, never dates or normative effect.
export function sourceReportEvidence(index:any,payloads?:Record<string,Uint8Array>):SourceReportEvidence{
  const groups=new Map<string,{texts:Set<string>;metadata:Set<string>;count:number;observations:string[]}>(),ambiguous=new Set<string>();
  const documents=new Set<string>(),corrections=new Map<string,number>(),corrigenda=new Map<string,string>();
  const structured=new Set<string>(),unstructured=new Set<string>();
  let unresolvedObservations=0;
  for(const entry of index.entries){
    const m=entry.metadata;
    const snapshots:any[]=[];
    if(['unit-observations-v2','unit-observations-v3'].includes(m?.unitHistoryProfile))
      snapshots.push({profile:m.unitHistoryProfile,source:m.unitHistorySource,units:m.units,corrections:m.unitCorrections??[],root:'toestand',stateKey:m.version?.key});
    for(const s of m?.unitHistory??[])snapshots.push(s);
    for(const snapshot of snapshots){
      const source=snapshot.source;
      if(!['unit-observations-v2','unit-observations-v3','unit-correction-observations-v1'].includes(snapshot.profile)||!source||source.jurisdiction!==index.jurisdiction||typeof source.documentId!=='string'||!/^[a-f0-9]{64}$/.test(source.sha256)||!Array.isArray(snapshot.units))throw new Error('Incomplete or unsupported source report model.');
      if(source.jurisdiction==='NL'&&source.documentId!==index.identifier||source.jurisdiction==='EU'&&typeof m.celex==='string'&&source.documentId!==m.celex)throw new Error('Source report document identity mismatch.');
      structured.add(source.documentId);
      const representation=source.member??source.sha256;
      const doc=stableCompactJson([source.jurisdiction,source.documentId,snapshot.stateKey??representation]).trim();
      documents.add(doc);
      const local=new Map<string,any[]>();
      const byTechnicalId=new Map<string,any>(),identities=new Map<string,string|null>();
      for(const unit of snapshot.units){
        if(typeof unit.technicalId!=='string'||byTechnicalId.has(unit.technicalId))throw new Error('Invalid or duplicate technical unit reference.');
        byTechnicalId.set(unit.technicalId,unit);
        const ids=unit.officialIdentifiers;
        if(!Array.isArray(ids)||ids.some((i:any)=>!i||typeof i.name!=='string'||typeof i.value!=='string'||!['work','source-document'].includes(i.scope)))throw new Error('Source report requires valid expanded official unit identifiers.');
        const usable=ids.filter((i:any)=>typeof i.value==='string'&&i.value.trim().length>0);
        const work=source.jurisdiction==='NL'?usable.filter((i:any)=>i.name==='stam-id'&&i.scope==='work'):[];
        const own=work.length?work:source.jurisdiction==='EU'?usable.filter((i:any)=>i.scope==='source-document'&&['IDENTIFIER','eId','id'].includes(i.name)):[];
        if(!own.length){identities.set(unit.technicalId,null);unresolvedObservations++;continue;}
        const key=stableCompactJson([source.jurisdiction,work.length?'work':'source-document',source.documentId,
          work.length?null:representation,unit.element,own.map((i:any)=>[i.name,i.value]).sort((a:any,b:any)=>compare(stableCompactJson(a),stableCompactJson(b)))]).trim();
        identities.set(unit.technicalId,key);const units=local.get(key)??[];units.push(unit);local.set(key,units);
      }
      for(const [key,units] of local){
        if(units.length!==1){ambiguous.add(key);unresolvedObservations+=units.length;continue;}
        const unit=units[0];
        if(!/^[a-f0-9]{64}$/.test(unit.text?.sha256))throw new Error('Invalid unit text hash in source report.');
        const group=groups.get(key)??{texts:new Set<string>(),metadata:new Set<string>(),count:0,observations:[]};
        let parentReference:unknown=unit.parentId===undefined?{status:'PARENT_METADATA_UNRESOLVED'}:null;
        if(unit.parentId!==null&&unit.parentId!==undefined){
          const parent=byTechnicalId.get(unit.parentId);if(!parent)throw new Error('Missing source report parent observation.');
          const key=identities.get(parent.technicalId);
          parentReference={identityKind:'DERIVED_TECHNICAL_SCOPED_KEY',identity:key&&local.get(key)?.length===1?key:null,locator:parent.locator,element:parent.element};
        }
        const metadata=digest({attributes:unit.attributes,label:unit.label,locator:unit.locator,
          jci:unit.jci,order:unit.order,parentReference});
        group.texts.add(unit.text.sha256);group.metadata.add(metadata);
        group.observations.push(digest([doc,unit.text.sha256,metadata]));
        group.count++;groups.set(key,group);
      }
      for(const correction of snapshot.corrections??[]){
        const fact=digest({element:correction.element,attributes:correction.attributes,fields:correction.fields,textSha256:correction.textSha256});
        const key=JSON.stringify([doc,fact]);corrections.set(key,(corrections.get(key)??0)+1);
      }
      if(snapshot.root==='CORR'){
        const key=JSON.stringify([source.documentId,representation]);
        const old=corrigenda.get(key);if(old&&old!==source.sha256)throw new Error('Conflicting corrigendum source snapshots.');
        corrigenda.set(key,source.sha256);
      }
    }
  }
  for(const entry of index.entries){
    if(entry.kind==='CELLAR-XHTML'&&typeof entry.metadata?.celex==='string'&&!structured.has(entry.metadata.celex))unstructured.add(entry.metadata.celex);
    if(entry.kind==='BWB-Toestand'&&!['unit-observations-v2','unit-observations-v3'].includes(entry.metadata?.unitHistoryProfile))unstructured.add(JSON.stringify([index.identifier,entry.metadata?.version?.key??entry.name]));
  }
  unresolvedObservations+=[...groups].filter(([key])=>ambiguous.has(key)).reduce((n,[,g])=>n+g.count,0);
  return {profile:'source-report-evidence-v1',identityKind:'DERIVED_TECHNICAL_SCOPED_KEY',selectionScope:'WHOLE_ARCHIVED_SOURCE_MODEL_NOT_ONLY_MARKDOWN_SELECTION',
    units:[...groups].filter(([key])=>!ambiguous.has(key)).sort(([a],[b])=>compare(a,b))
      .map(([key,g])=>[key,[...g.texts].sort(),[...g.metadata].sort(),g.count,digest(g.observations.sort())]),
    ambiguousIdentities:[...ambiguous].sort(),unresolvedObservations,unstructuredDocuments:[...unstructured].sort(),documents:[...documents].sort(),
    corrections:[...corrections].sort(([a],[b])=>compare(a,b)).map(([key,count])=>[...JSON.parse(key),count] as [string,string,number]),
    corrigenda:[...corrigenda].sort(([a],[b])=>compare(a,b)),
    representations:index.entries.map((entry:any)=>{
      const sha256=entry.sha256??(payloads?.[entry.name]?hash(payloads[entry.name]):undefined);
      if(!/^[a-f0-9]{64}$/.test(sha256??''))throw new Error('Source report requires verified native SHA256 or original payload bytes.');
      return [JSON.stringify([entry.kind,entry.name]),sha256,digest([entry.requestedUrl,entry.url,entry.contentType])] as [string,string,string];
    }).sort((a:[string,string,string],b:[string,string,string])=>compare(a[0],b[0])),
    scope:'Official work IDs or official IDs within the same source document/member; no inferred legal continuity'};
}

export function compareSourceReportEvidence(current:SourceReportEvidence,previous:SourceReportEvidence){
  validateSourceReportEvidence(current);validateSourceReportEvidence(previous);
  const old=new Map(previous.units.map(row=>[row[0],row])),now=new Map(current.units.map(row=>[row[0],row]));
  const blocked=new Set([...current.ambiguousIdentities,...previous.ambiguousIdentities]);
  const counts={newlyObservedScopedIdentities:0,absentScopedIdentities:0,changedTextVariants:0,metadataOnly:0,observationMultiplicityOnly:0,changedObservationAssociations:0,unchanged:0};
  for(const [key,row] of now){
    if(blocked.has(key))continue;
    const before=old.get(key);
    if(!before)counts.newlyObservedScopedIdentities++;
    else if(!isDeepStrictEqual(row[1],before[1]))counts.changedTextVariants++;
    else if(!isDeepStrictEqual(row[2],before[2]))counts.metadataOnly++;
    else if(row[3]!==before[3])counts.observationMultiplicityOnly++;
    else if(row[4]!==before[4])counts.changedObservationAssociations++;
    else counts.unchanged++;
  }
  for(const key of old.keys())if(!now.has(key)&&!blocked.has(key))counts.absentScopedIdentities++;
  const priorCorrections=new Map(previous.corrections.map(([doc,fact,count])=>[JSON.stringify([doc,fact]),count]));
  const priorDocuments=new Set(previous.documents);
  let newSourceCorrectionObservations=0,newCorrectionsInPreviouslyObservedDocuments=0;
  for(const [doc,fact,count] of current.corrections){
    const extra=Math.max(0,count-(priorCorrections.get(JSON.stringify([doc,fact]))??0));
    newSourceCorrectionObservations+=extra;if(priorDocuments.has(doc))newCorrectionsInPreviouslyObservedDocuments+=extra;
  }
  const beforeCorrigenda=new Map(previous.corrigenda);
  const oldRepresentations=new Map(previous.representations.map(row=>[row[0],row]));
  return {...counts,ambiguousIdentities:blocked.size,unresolvedObservations:current.unresolvedObservations,unstructuredDocuments:current.unstructuredDocuments,
    newSourceCorrectionObservations,newCorrectionsInPreviouslyObservedDocuments,
    newCorrigendumSnapshots:current.corrigenda.filter(([key])=>!beforeCorrigenda.has(key)).length,
    changedCorrigendumSnapshots:current.corrigenda.filter(([key,sha])=>beforeCorrigenda.has(key)&&beforeCorrigenda.get(key)!==sha).length,
    archivedRepresentations:{new:current.representations.filter(([key])=>!oldRepresentations.has(key)).length,
      changedBytes:current.representations.filter(([key,sha256])=>oldRepresentations.has(key)&&oldRepresentations.get(key)![1]!==sha256).length,
      descriptorOnly:current.representations.filter(([key,sha256,descriptor])=>oldRepresentations.has(key)&&oldRepresentations.get(key)![1]===sha256&&oldRepresentations.get(key)![2]!==descriptor).length},
    identityKind:current.identityKind,selectionScope:current.selectionScope,scope:current.scope,legalEffect:'UNRESOLVED',absenceMeaning:'Not observed in this input; not repeal'};
}

export function validateSourceReportEvidence(value:unknown):asserts value is SourceReportEvidence{
  const v=value as SourceReportEvidence;
  const hash64=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
  const strings=(a:unknown):a is string[]=>Array.isArray(a)&&a.every(s=>typeof s==='string')&&new Set(a).size===a.length;
  const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
  if(!v||v.profile!=='source-report-evidence-v1'||v.identityKind!=='DERIVED_TECHNICAL_SCOPED_KEY'||
    v.selectionScope!=='WHOLE_ARCHIVED_SOURCE_MODEL_NOT_ONLY_MARKDOWN_SELECTION'||
    !strings(v.ambiguousIdentities)||!strings(v.documents)||!strings(v.unstructuredDocuments)||!count(v.unresolvedObservations)||
    v.scope!=='Official work IDs or official IDs within the same source document/member; no inferred legal continuity'||
    !Array.isArray(v.units)||!Array.isArray(v.corrections)||!Array.isArray(v.corrigenda)||!Array.isArray(v.representations))throw new Error('Invalid source comparison evidence profile/shape.');
  const keys=new Set<string>();
  const ambiguous=new Set(v.ambiguousIdentities),documents=new Set(v.documents);
  for(const row of v.units){
    if(!Array.isArray(row)||row.length!==5||typeof row[0]!=='string'||keys.has(row[0])||ambiguous.has(row[0])||
      !strings(row[1])||!row[1].length||!row[1].every(hash64)||!strings(row[2])||!row[2].length||!row[2].every(hash64)||!count(row[3])||row[3]<1||!hash64(row[4]))
      throw new Error('Invalid source comparison unit.');
    keys.add(row[0]);
  }
  const correctionKeys=new Set<string>();
  for(const row of v.corrections){
    if(!Array.isArray(row))throw new Error('Invalid source comparison correction.');
    const key=JSON.stringify(row.slice(0,2));
    if(row.length!==3||!documents.has(row[0])||!hash64(row[1])||!count(row[2])||row[2]<1||correctionKeys.has(key))throw new Error('Invalid source comparison correction.');
    correctionKeys.add(key);
  }
  const seen=new Set<string>();
  for(const row of v.corrigenda){if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!hash64(row[1])||seen.has(row[0]))throw new Error('Invalid source comparison corrigendum.');seen.add(row[0]);}
  seen.clear();
  for(const row of v.representations){
    if(!Array.isArray(row)||row.length!==3||typeof row[0]!=='string'||!hash64(row[1])||!hash64(row[2])||seen.has(row[0]))throw new Error('Invalid source comparison representation.');seen.add(row[0]);
  }
}
