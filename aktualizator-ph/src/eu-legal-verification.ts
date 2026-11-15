import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {parseEuSource} from './parsed-source-cache.js';
import {normalizeEuBody,normalizeFinalEuBody} from './eu-normalize.js';
import {resolveEuNavigation} from './eu-navigation.js';
import {indexLegalDocument,validateLegalDocument,extractLegalBody,legalChunkContext} from './legal-structure.js';
import type {EuBuiltDocument,EuFinalAct} from './eu-model.js';
import {euDocumentHeader,euHeaderMetadata,euLegalMarkdown,euLegalHeaderPrefix} from './eu-document-header.js';
import type {EuText} from './eu-parser.js';

function original(doc:Pick<EuBuiltDocument,'celex'|'language'|'sourceSha256'|'sourceUrl'|'include'>,index:any,items:Record<string,Uint8Array>):EuText{
  const sources=index.entries.filter((e:any)=>e.kind==='CELLAR-XHTML'&&e.metadata?.celex===doc.celex);
  if(sources.length!==1)throw new Error('Missing or duplicate EU original text.');
  const entry=sources[0],bytes=Buffer.from(items[entry.name]),sha256=createHash('sha256').update(bytes).digest('hex');
  if(doc.sourceSha256!==sha256||doc.sourceUrl!==entry.url||doc.language!==entry.metadata.language||doc.include!==entry.metadata.include)
    throw new Error('EU original source identity mismatch.');
  return parseEuSource({bytes,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),url:entry.url,contentType:entry.contentType},doc.include,doc.language!,doc.celex);
}
export function euHeaderFromOriginal(doc:EuBuiltDocument,index:any,items:Record<string,Uint8Array>){
  const parsed=original(doc,index,items);
  if(!parsed.titleEvidence)throw new Error('Original EU title provenance unavailable.');
  return euDocumentHeader(parsed.titleEvidence,doc.celex,euHeaderMetadata(doc.celex,index,items));
}
export function verifyEuLegalCheckpoint(doc:EuBuiltDocument,index:any,items:Record<string,Uint8Array>,names:string[],bodies:string[]){
  const parsed=original(doc,index,items),expected=parsed.legalDraft!;
  const header=euDocumentHeader(parsed.titleEvidence!,doc.celex,euHeaderMetadata(doc.celex,index,items));
  if(!isDeepStrictEqual(doc.header,header)||!isDeepStrictEqual(euDocumentHeader(parsed.titleEvidence!,doc.celex,doc.metadata),header))throw new Error('EU checkpoint title or dates differ from official originals.');
  if(!isDeepStrictEqual(expected,doc.legalDraft)||!isDeepStrictEqual(expected.chunks.map(p=>p.body),bodies))throw new Error('EU structured checkpoint differs from original.');
  indexLegalDocument(expected,names,bodies);
}
export function verifyEuLegalAct(act:EuFinalAct,index:any,items:Record<string,Uint8Array>,readMarkdown:(name:string)=>string){
  for(const doc of act.documents??[]){
    if(!doc.legalStructure)continue;
    const parsed=original(doc,index,items),draft=parsed.legalDraft!,names=doc.legalStructure.parts.map(p=>p.file);
    const header=euDocumentHeader(parsed.titleEvidence!,doc.celex,euHeaderMetadata(doc.celex,index,items));
    if(!isDeepStrictEqual(doc.header,header))throw new Error('EU document title or dates differ from official originals.');
    const resolved=resolveEuNavigation(draft.chunks.map(p=>normalizeEuBody(p.body).body),names,doc.sourceUrl,true),bodies=resolved.chunks.map(normalizeFinalEuBody);
    const expected=indexLegalDocument({...draft,sourceFragmentIssues:resolved.navigation.sourceFragmentIssues},names,bodies);
    if(!isDeepStrictEqual(doc.legalStructure,expected))throw new Error('EU logical unit index differs from original source.');
    const body=validateLegalDocument(doc.legalStructure,name=>extractLegalBody(readMarkdown(name)));
    if(body!==bodies.join(''))throw new Error('EU reconstructed legal content differs from original.');
    for(const [i,name]of names.entries()){
      const prefix=euLegalHeaderPrefix(euLegalMarkdown(header,draft,bodies[i],legalChunkContext(draft,bodies[i])));
      if(euLegalHeaderPrefix(readMarkdown(name))!==prefix)throw new Error('EU generated title or date header differs from official originals.');
    }
  }
}
