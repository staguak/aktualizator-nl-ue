import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import {parseNlSource} from './parsed-source-cache.js';
import {incrementalNlModel} from './incremental-model.js';
import {resolveEuNavigation} from './eu-navigation.js';
import {indexLegalDocument,validateLegalDocument,extractLegalBody} from './legal-structure.js';
import type {NlActManifest} from './nl-output.js';
import type {VersionSnapshot,ScopeAct} from './types.js';
import {isCalendarDate} from './calendar.js';

/** New format checks include the existing article/state evidence and an exact
 * source-backed reconstruction of all additional legal containers. */
export function verifyNlLegalAct(act:NlActManifest,index:any,items:Record<string,Uint8Array>,readMarkdown:(name:string)=>string,from:string,to:string){
  if(!act.legalDocuments?.length)throw new Error('Missing structured NL documents.');
  const sources=index.entries.filter((e:any)=>e.kind==='BWB-Toestand');
  if(sources.length!==act.legalDocuments.length)throw new Error('Structured NL version coverage differs from originals.');
  const snapshots:VersionSnapshot[]=[],declared=new Set<string>();
  for(const entry of sources){
    const bytes=Buffer.from(items[entry.name]),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
    const version=entry.metadata?.version;
    const documents=act.legalDocuments.filter(d=>d.version===version?.key);
    if(documents.length!==1)throw new Error('Duplicate or missing structured NL version.');
    const document=documents[0];
    if(document.sourceSha256!==sha256||document.corpus!=='NL'||document.documentId!==act.bwbId||document.language!=='NL'||document.sourceUrl!==entry.url)
      throw new Error('Structured NL original/version identity mismatch.');
    const draft=parseNlLegalStructure(text,{corpus:'NL',documentId:act.bwbId,version:version.key,language:'NL',sourceUrl:entry.url,sourceSha256:sha256,metadata:{sourceState:version}});
    const names=document.parts.map(p=>p.file),resolved=resolveEuNavigation(draft.chunks.map(p=>p.body),names,entry.url,true),bodies=resolved.chunks;
    const expected=indexLegalDocument({...draft,sourceFragmentIssues:resolved.navigation.sourceFragmentIssues},names,bodies);
    if(!isDeepStrictEqual(expected,document))throw new Error('Structured NL unit catalog differs from original source.');
    const actual=validateLegalDocument(document,name=>extractLegalBody(readMarkdown(name)));
    if(actual!==bodies.join(''))throw new Error('Structured NL reconstructed legal content differs from original.');
    for(const name of names){if(declared.has(name))throw new Error('Repeated NL physical part across versions.');declared.add(name);}
    snapshots.push({version,sourceSha256:sha256,statute:parseNlSource({bytes,text,url:entry.url,contentType:entry.contentType})});
  }
  if(declared.size!==act.files.length||act.files.some(f=>!declared.has(f.name)))throw new Error('Unindexed NL physical part.');
  const scope:ScopeAct={order:act.order,title:act.title,bwbId:act.bwbId,include:act.selectors,mustIncludeArticles:[],retrievalScope:act.retrievalScope};
  const legacy=incrementalNlModel(fileURLToPath(new URL('../',import.meta.url)),scope,snapshots,from,to);
  const expectedArticles=legacy.articles.map(a=>({articleId:a.articleId,versions:a.versions.map(v=>({validFrom:v.validFrom,validTo:v.validTo,
    sourceStates:v.sourceStates,sourceStateCount:v.sourceStateCount,merged:v.sourceStateCount>1,contentHash:v.contentHash}))}));
  if(!isDeepStrictEqual(legacy.integrity,act.integrity)||!isDeepStrictEqual(expectedArticles,act.articles)||
    !isDeepStrictEqual(legacy.selectedArticles,act.selectedArticles)||!isDeepStrictEqual(legacy.sourceStates,act.sourceStates))throw new Error('Existing NL article/state integrity differs from originals.');
  for(const article of act.articles)article.versions.forEach((v,i)=>{
    if(!isCalendarDate(v.validFrom)||v.validTo!==null&&(!isCalendarDate(v.validTo)||v.validTo<v.validFrom!||v.validTo==='9999-12-31')||
      i>0&&(article.versions[i-1].validTo===null||article.versions[i-1].validTo!>=v.validFrom!))throw new Error('Invalid structured NL historical interval.');
  });
}
