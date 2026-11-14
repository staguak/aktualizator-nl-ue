import type {EuDocument} from './eu-provider.js';
import type {SourceResponse} from './source-cache.js';
import {checkCelex} from './eu-identifiers.js';
import {documentDate} from './eu-dates.js';
import {preferredEuLanguages} from './eu-language.js';
import {isDeepStrictEqual} from 'node:util';
import {isCalendarDate} from './calendar.js';

const CDM='http://publications.europa.eu/ontology/cdm#';
export const CASE_ROW_LIMIT=10000;
export interface CaseMembership {seedCelex:string;caseUri:string;caseId?:string}
export interface CaseMember extends CaseMembership {
  work:string;celex?:string;
  status:'INCLUDED'|'AFTER_RANGE'|'NO_SUPPORTED_LANGUAGE'|'NO_CELEX';
}
export interface EuCaseCatalog {profile:'cellar-case-dossiers-v1';seeds:string[];members:CaseMember[];rowCount:number}
export type CaseFetcher=(url:string,headers:Record<string,string>)=>Promise<SourceResponse>;

function resource(value:unknown):string{
  if(typeof value!=='string')throw new Error('Missing official case resource.');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='publications.europa.eu'||url.username||url.password||url.port||url.search||url.hash||
    !/^\/resource\/cellar\/[0-9a-f-]{36}(?:\.\d+)*$/i.test(url.pathname))throw new Error('Invalid official case resource.');
  url.protocol='https:';return url.href;
}
export function euCaseQuery(seeds:string[]):string{
  if(!seeds.length)throw new Error('Missing case discovery seeds.');
  seeds.forEach(checkCelex);
  return `PREFIX cdm: <${CDM}>
SELECT DISTINCT ?seedId ?case ?caseId ?work ?id ?date ?ecli ?language WHERE {
 ?seed cdm:resource_legal_id_celex ?seedId . FILTER(str(?seedId) IN (${seeds.map(s=>JSON.stringify(s)).join(',')}))
 ?seed (cdm:work_part_of_dossier|^cdm:dossier_contains_work) ?initial .
 ?initial a cdm:case_court .
 ?initial ((^cdm:work_part_of_dossier|cdm:dossier_contains_work)/(cdm:work_part_of_dossier|^cdm:dossier_contains_work))* ?case .
 ?case a cdm:case_court . OPTIONAL { ?case cdm:dossier_identifier ?caseId }
 ?case (^cdm:work_part_of_dossier|cdm:dossier_contains_work) ?work .
 OPTIONAL { ?work cdm:resource_legal_id_celex ?id }
 OPTIONAL { ?work cdm:work_date_document ?date }
 OPTIONAL { ?work cdm:case-law_ecli ?ecli }
 OPTIONAL { ?expression cdm:expression_belongs_to_work ?work ; cdm:expression_uses_language ?language }
} ORDER BY ?seedId ?case ?work ?id ?date ?ecli ?language LIMIT ${CASE_ROW_LIMIT}`;
}

/** Formal dossier membership only. Shared works traverse joined cases;
 * work_cites_work and unrelated legal-effect relations are never followed. */
export async function expandEuCaseScope(selected:EuDocument[],to:string,fetcher:CaseFetcher,
  preserve?:(source:SourceResponse,url:string)=>void):Promise<{documents:EuDocument[];catalog:EuCaseCatalog}|undefined>{
  const seeds=[...new Set(selected.filter(d=>d.celex.startsWith('6')).map(d=>d.celex))].sort();
  if(!seeds.length)return;
  const url=new URL('https://publications.europa.eu/webapi/rdf/sparql');
  url.searchParams.set('query',euCaseQuery(seeds));url.searchParams.set('format','application/sparql-results+json');
  const source=await fetcher(url.href,{Accept:'application/sparql-results+json'});
  preserve?.(source,url.href);
  return parseEuCaseResponse(selected,to,source.text);
}
export function parseEuCaseResponse(selected:EuDocument[],to:string,text:string){
  if(!isCalendarDate(to))throw new Error('Invalid EU case range end.');
  const seeds=[...new Set(selected.filter(d=>d.celex.startsWith('6')).map(d=>d.celex))].sort();
  const rows=JSON.parse(text).results?.bindings;
  if(!Array.isArray(rows)||rows.length>=CASE_ROW_LIMIT)throw new Error('Incomplete EU case catalog.');
  const found=new Set<string>(),members=new Map<string,Omit<CaseMember,'status'>>();
  const metadata=new Map<string,Record<string,string[]>>();
  const add=(id:string,key:string,value:string|undefined)=>{
    if(value===undefined)return;
    if(typeof value!=='string'||!value)throw new Error('Malformed EU case metadata.');
    const m=metadata.get(id)??{},values=m[key]??[];
    if(!values.includes(value))values.push(value);m[key]=values;metadata.set(id,m);
  };
  for(const row of rows){
    const seedCelex=row.seedId?.value,celex=row.id?.value;
    if(!seeds.includes(seedCelex))throw new Error('Unexpected EU case seed.');
    const caseUri=resource(row.case?.value),work=resource(row.work?.value),caseId=row.caseId?.value;
    if(caseId!==undefined&&(typeof caseId!=='string'||!caseId))throw new Error('Malformed EU case identifier.');
    if(celex!==undefined){checkCelex(celex);if(!celex.startsWith('6'))throw new Error('Non-case document in a court dossier.');}
    if(celex===seedCelex)found.add(seedCelex);
    const member={seedCelex,caseUri,...caseId?{caseId}:{},work,...celex?{celex}:{}};
    members.set(JSON.stringify(member),member);
    if(celex){
      add(celex,'resource_legal_id_celex',celex);
      add(celex,'work_date_document',row.date?.value);
      add(celex,'case-law_ecli',row.ecli?.value);
      add(celex,'available_language',row.language?.value);
    }
  }
  if(seeds.some(seed=>!found.has(seed)))throw new Error('Missing formal case membership for a selected EU judgment.');
  const documents=new Map(selected.map(d=>[d.celex,{...d,metadata:structuredClone(d.metadata)}]));
  const catalog:EuCaseCatalog={profile:'cellar-case-dossiers-v1',seeds,members:[],rowCount:rows.length};
  for(const member of members.values()){
    let status:CaseMember['status']='NO_CELEX';
    if(member.celex){
      const id=member.celex,doc:EuDocument=documents.get(id)??{celex:id,include:'full-document',role:'same-case-document',metadata:{}};
      for(const [key,values] of Object.entries(metadata.get(id)??{}))doc.metadata[key]=[...new Set([...(doc.metadata[key]??[]),...values])].sort();
      const date=documentDate(doc);
      if(!date)throw new Error('Missing or ambiguous date for EU case document: '+id);
      status=date>to?'AFTER_RANGE':preferredEuLanguages(doc.metadata.available_language).length?'INCLUDED':'NO_SUPPORTED_LANGUAGE';
      if(status==='INCLUDED'){
        doc.include='full-document';
        const membership:CaseMembership={seedCelex:member.seedCelex,caseUri:member.caseUri,...member.caseId?{caseId:member.caseId}:{}};
        const links=doc.caseMemberships??[];
        if(!links.some(link=>JSON.stringify(link)===JSON.stringify(membership)))links.push(membership);
        doc.caseMemberships=links;documents.set(id,doc);
      }else if(documents.has(id))throw new Error('Selected EU case seed is unavailable within the agreed range/languages.');
    }
    catalog.members.push({...member,status});
  }
  catalog.members.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
  return {documents:[...documents.values()].sort((a,b)=>a.celex.localeCompare(b.celex)),catalog};
}

export function assertEuCaseSource(act:{caseCatalog?:EuCaseCatalog},index:any,items:Record<string,Uint8Array>,to:string):void{
  if(!act.caseCatalog)return;
  const entries=index.entries.filter((entry:any)=>entry.kind==='CELLAR-case-catalog');
  if(entries.length!==1)throw new Error('Missing original EU case discovery response.');
  const entry=entries[0],url=new URL(entry.requestedUrl);
  if(url.origin!=='https://publications.europa.eu'||url.pathname!=='/webapi/rdf/sparql'||
    url.searchParams.get('query')!==euCaseQuery(act.caseCatalog.seeds))throw new Error('EU case catalog is not bound to its original query.');
  const seeds=act.caseCatalog.seeds.map(celex=>({celex,metadata:{},include:'full-document',role:'case-catalog-replay'}));
  const actual=parseEuCaseResponse(seeds,to,new TextDecoder('utf-8',{fatal:true}).decode(items[entry.name])).catalog;
  if(!isDeepStrictEqual(actual,act.caseCatalog))throw new Error('EU case catalog differs from its original response.');
}

/** Check coverage before checkpoint reuse and before publication. A dropped
 * case document cannot be excused by recalculating output-file checksums. */
export function assertEuCaseCoverage(act:{celex:string;retrievalScope?:string;documents:EuDocument[];caseCatalog?:EuCaseCatalog},
  expected?:{retrievalScope?:string;celex?:string;requiredVersions?:string[];attachedDocuments?:{celex:string}[]}):void{
  if(expected?.retrievalScope!=='full-act-and-case')return;
  if(act.retrievalScope!==expected.retrievalScope)throw new Error('EU retrieval scope differs from configuration.');
  if(act.documents.some(d=>!['full-document','corrigendum'].includes(d.include)))throw new Error('A selected EU source was reduced to a fragment.');
  const caseDocuments=act.documents.filter(d=>d.celex.startsWith('6'));
  if(!caseDocuments.length){if(act.caseCatalog)throw new Error('Unexpected case catalog.');return;}
  const catalog=act.caseCatalog;
  if(!catalog||catalog.profile!=='cellar-case-dossiers-v1'||!Array.isArray(catalog.seeds)||!catalog.seeds.length||
    new Set(catalog.seeds).size!==catalog.seeds.length||!Array.isArray(catalog.members)||!catalog.members.length||
    !Number.isSafeInteger(catalog.rowCount)||catalog.rowCount<=0||catalog.rowCount>=CASE_ROW_LIMIT)
    throw new Error('Missing or incomplete EU case catalog.');
  const required=[expected.celex,...expected.requiredVersions??[],...expected.attachedDocuments?.map(d=>d.celex)??[]]
    .filter((id):id is string=>typeof id==='string'&&id.startsWith('6'));
  if(required.some(id=>!catalog.seeds.includes(id))||catalog.seeds.some(id=>!caseDocuments.some(d=>d.celex===id)))
    throw new Error('EU case discovery seed coverage differs from selection.');
  const seen=new Set<string>();
  for(const member of catalog.members){
    if(!catalog.seeds.includes(member.seedCelex)||!['INCLUDED','AFTER_RANGE','NO_SUPPORTED_LANGUAGE'].includes(member.status)||!member.celex)
      throw new Error('Unresolved or malformed EU case member.');
    resource(member.caseUri);resource(member.work);checkCelex(member.celex);
    const key=JSON.stringify(member);if(seen.has(key))throw new Error('Duplicate EU case member.');seen.add(key);
    if(member.status==='INCLUDED'&&!caseDocuments.some(d=>d.celex===member.celex&&d.caseMemberships?.some(link=>
      link.seedCelex===member.seedCelex&&link.caseUri===member.caseUri&&link.caseId===member.caseId)))throw new Error('Missing complete EU case document.');
  }
  for(const doc of caseDocuments){
    if(!doc.caseMemberships?.length)throw new Error('EU case document lacks formal membership.');
    for(const link of doc.caseMemberships)if(!catalog.members.some(m=>m.celex===doc.celex&&m.status==='INCLUDED'&&
      m.seedCelex===link.seedCelex&&m.caseUri===link.caseUri&&m.caseId===link.caseId))throw new Error('EU case membership differs from catalog.');
  }
}
