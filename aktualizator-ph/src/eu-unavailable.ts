import {isDeepStrictEqual} from 'node:util';
import type {EuDocument} from './eu-provider.js';
import {EU_LANGUAGE_ORDER,euLanguageOrder,availableEuLanguages,publicEuModules} from './eu-language.js';
import type {EuLanguage} from './eu-language.js';
import {checkCelex} from './eu-identifiers.js';
export interface MissingEuDocument {profile:'eu-document-unavailable-v1';celex:string;document:EuDocument;attempts:{language:EuLanguage;reason:string}[]}
export function missingEuDocuments(act:{documents?:{celex:string}[];missingDocuments?:MissingEuDocument[]}):MissingEuDocument[]{
  const missing=act.missingDocuments??[];
  if(!Array.isArray(missing))throw new Error('Invalid unavailable document catalog.');
  const seen=new Set<string>();
  for(const item of missing){
    checkCelex(item.celex);
    if(item.profile!=='eu-document-unavailable-v1'||item.document.celex!==item.celex||seen.has(item.celex)||
      act.documents?.some(d=>d.celex===item.celex)||!isDeepStrictEqual(item.attempts.map(a=>a.language),(()=>{
        if(!publicEuModules())return EU_LANGUAGE_ORDER;
        const preferred=euLanguageOrder(), advertised=availableEuLanguages(item.document.metadata.available_language??[],preferred);
        return advertised.length?advertised:preferred;
      })())||
      item.attempts.some(a=>typeof a.reason!=='string'||!a.reason))throw new Error('Unproven unavailable EU document.');
    seen.add(item.celex);
  }
  return missing;
}
export function assertMissingEuEvidence(act:{documents?:{celex:string}[];missingDocuments?:MissingEuDocument[];discoveryIncomplete?:boolean},index:any,items:Record<string,Uint8Array>){
  const discovery=index.entries.filter((e:any)=>['CELLAR-discovery-unavailable','CELLAR-case-discovery-unavailable'].includes(e.kind));
  if(act.discoveryIncomplete){
    if(!discovery.length)throw new Error('Unproven incomplete source discovery.');
    for(const entry of discovery){
      const code=entry.kind==='CELLAR-discovery-unavailable'?'DISCOVERY_UNAVAILABLE':'CASE_DISCOVERY_UNAVAILABLE';
      if(code==='DISCOVERY_UNAVAILABLE'&&index.discovery?.unavailable!==true||!index.sourceIssues?.some((i:any)=>i.code===code&&i.classification==='SOURCE_UNAVAILABLE'))throw new Error('Unproven incomplete source discovery.');
      const evidence=JSON.parse(Buffer.from(items[entry.name]).toString('utf8'));
      if(evidence.profile!=='eu-discovery-unavailable-v1'||evidence.celex!==index.identifier)throw new Error('Discovery failure identity mismatch.');
    }
  }else if(discovery.length)throw new Error('Source discovery gap omitted from manifest.');
  const missing=missingEuDocuments(act),entries=index.entries.filter((e:any)=>e.kind==='CELLAR-document-unavailable');
  if(entries.length!==missing.length)throw new Error('Unavailable document evidence inventory mismatch.');
  for(const item of missing){
    const matches=entries.filter((e:any)=>e.metadata?.celex===item.celex);
    if(matches.length!==1||!isDeepStrictEqual(JSON.parse(Buffer.from(items[matches[0].name]).toString('utf8')),item)||
      !index.sourceIssues?.some((i:any)=>i.code==='DOCUMENT_UNAVAILABLE'&&i.documentId===item.celex&&i.classification==='SOURCE_UNAVAILABLE'))throw new Error('Missing source/language failure evidence.');
  }
}
