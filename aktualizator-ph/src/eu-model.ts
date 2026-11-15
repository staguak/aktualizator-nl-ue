import type {EuLanguage} from './eu-language.js';
import { assertEuIntegrity } from './content-integrity.js';
import type { EuIntegrity } from './content-integrity.js';
import { resolveEuNavigation } from './eu-navigation.js';
import type { EuDocument } from './eu-provider.js';
import { normalizeEuBody, languageDictionary, normalizeMetadata, metadataHash, normalizeFinalEuBody, euLayoutBytes, legalBodyHash } from './eu-normalize.js';
import type { EuFinalFile } from './final-file.js';
import type { FileMetadata } from './final-file.js';
import type { EuNavigation } from './eu-navigation.js';
import type { NormalizedMetadata } from './eu-normalize.js';
import type {EuCaseCatalog} from './eu-case-scope.js';
import {incrementalEuNormalization,incrementalEuNavigation} from './incremental-model.js';
import {indexLegalDocument,legalChunkContext,LEGAL_PROFILE} from './legal-structure.js';
import type {LegalDraft,LegalManifest,LegalContext} from './legal-structure.js';
import type {MissingEuDocument} from './eu-unavailable.js';
import type {EuDocumentHeader} from './eu-document-header.js';
export type EuBuiltDocument = EuDocument & {header?:EuDocumentHeader;language?:EuLanguage;sourceUrl:string;sourceSha256:string;articleCount:number;textLength:number;
  integrity:EuIntegrity;navigation?:EuNavigation;oversizedParts?:number[];legalDraft?:LegalDraft};
export interface EuBuiltAct {
  discoveryIncomplete?:boolean;
  missingDocuments?:MissingEuDocument[];
  retrievalScope?:'full-act-and-case';caseCatalog?:EuCaseCatalog;
  sourceArchive?:import('./official-sources.js').SourceArchive;
  order:number;title:string;celex:string;
  documents:EuBuiltDocument[];
  files:{name:string;celex:string;part:number;md5:string}[];
  excludedDocuments:{celex:string;reason:string}[];
}
export type EuPublishedFile = FileMetadata & {celex:string;part:number;sourceHash:string;layoutProfile?:typeof LEGAL_PROFILE} &
  ({kind:'content'|'unavailable';canonicalFile?:never} | {kind:'reference';canonicalFile:string});
export type EuFinalDocument = Omit<EuBuiltDocument,'metadata'|'navigation'|'oversizedParts'|'legalDraft'> & {
  legalStructure?:LegalManifest;
  metadata:NormalizedMetadata;metadataHash:string;sourceHash:string;inputBodyHash:string;
  navigation:EuNavigation;oversizedParts:number[];htmlNormalization:ReturnType<typeof normalizeEuBody>['status'][];
};
export interface EuFinalAct extends Omit<EuBuiltAct,'documents'|'files'> {
  documents:EuFinalDocument[];files:EuPublishedFile[];
}
export interface EuPartModel {
  header?:EuDocumentHeader;
  legalContext?:LegalContext;contextLabels?:string[];
  language?:EuLanguage; name:string; order:number; title:string; celex:string; part:number; total:number; sourceUrl:string; body:string;
  details: Pick<EuFinalFile,'jurisdiction'|'kind'> & EuFinalFileDetails;
}
type EuFinalFileDetails =
  | {kind:'content'; metadata:{celex:string;part:number;sourceHash:string;layoutProfile?:typeof LEGAL_PROFILE}}
  | {kind:'reference'; metadata:{celex:string;part:number;sourceHash:string;canonicalFile:string}};
export function buildEuModel(acts: EuBuiltAct[], readBody:(name:string)=>string) {
  const ordered=[...acts].sort((a,b)=>a.order-b.order);
  const rules=languageDictionary(ordered.flatMap(a=>a.documents.map(d=>d.metadata)));
  const entries=ordered.flatMap(act=>[...act.documents].sort((a,b)=>a.celex.localeCompare(b.celex)).map(doc=>{
    const files=act.files.filter(f=>f.celex===doc.celex).sort((a,b)=>a.part-b.part);
    const original=files.map(f=>readBody(f.name));
    const normalized=original.map(incrementalEuNormalization);
    const sourceHash=legalBodyHash(normalized.map(n=>n.body).join(doc.legalDraft?'':'\n\n'));
    assertEuIntegrity(doc.integrity,normalized.map(n=>n.body).join(doc.legalDraft?'':'\n'));
    return {act,doc,files,original,normalized,sourceHash};
  }));
  const groups=new Map<string,typeof entries>();
  for(const e of entries){const key=(e.doc.legalDraft?'structural:':'legacy:')+e.sourceHash;const group=groups.get(key)??[];group.push(e);groups.set(key,group);}
  const priority=(e:typeof entries[number])=>[e.act.celex===e.doc.celex?0:1,e.doc.celex.startsWith('0')?1:0,e.act.order,e.doc.celex] as const;
  const compare=(a:typeof entries[number],b:typeof entries[number])=>{const x=priority(a),y=priority(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]||x[3].localeCompare(y[3]);};
  const parts: EuPartModel[] = [], results=new Map<number,EuFinalAct>();
  for(const act of ordered)results.set(act.order,{order:act.order,title:act.title,celex:act.celex,documents:[],files:[],excludedDocuments:act.excludedDocuments,...act.discoveryIncomplete?{discoveryIncomplete:true}:{},...act.missingDocuments?{missingDocuments:act.missingDocuments}:{},...act.sourceArchive?{sourceArchive:act.sourceArchive}:{},
    ...(act.retrievalScope?{retrievalScope:act.retrievalScope}:{}),...(act.caseCatalog?{caseCatalog:act.caseCatalog}:{})});
  let beforeBytes=0,referenceCount=0,groupCount=0;
  for(const group of [...groups.values()].sort((a,b)=>a[0].sourceHash.localeCompare(b[0].sourceHash))){
    group.sort(compare);const canonical=group[0];if(group.length>1)groupCount++;
    const resolved=incrementalEuNavigation(canonical.normalized.map(n=>n.body),canonical.files.map(f=>f.name),canonical.doc.sourceUrl,!!canonical.doc.legalDraft);
    const bodies=resolved.chunks;
    const partHashes=bodies.map(legalBodyHash),documentHash=legalBodyHash(bodies.join(canonical.doc.legalDraft?'':'\n\n'));
    for(const entry of group){
      if(entry.files.length!==canonical.files.length)throw new Error('Identical EU documents have inconsistent part boundaries.');
      const {legalDraft,...document}=entry.doc;
      if(legalDraft&&!entry.doc.header)throw new Error('EU document header missing; rebuild or upgrade checkpoint from verified originals.');
      const title=entry.doc.header?.title.value??entry.act.title;
      // Public structural files always contain the complete text. Reuse the
      // fetched/parsed source, but resolve each physical copy's own navigation.
      const view=legalDraft?incrementalEuNavigation(entry.normalized.map(n=>n.body),entry.files.map(f=>f.name),entry.doc.sourceUrl,true):resolved;
      const physicalBodies=view.chunks,hashes=physicalBodies.map(legalBodyHash);
      const result=results.get(entry.act.order)!;assertEuIntegrity(entry.doc.integrity,physicalBodies.join(legalDraft?'':'\n'));
      const legalStructure=legalDraft?indexLegalDocument({...legalDraft,sourceFragmentIssues:view.navigation.sourceFragmentIssues},entry.files.map(f=>f.name),physicalBodies):undefined;
      result.documents.push({...document,...legalStructure?{legalStructure}:{},metadata:normalizeMetadata(entry.doc.metadata,entry.doc.celex,rules),metadataHash:metadataHash(entry.doc.metadata),
        sourceHash:legalBodyHash(physicalBodies.join(legalDraft?'':'\n\n')),inputBodyHash:entry.sourceHash,textLength:physicalBodies.reduce((n,b)=>n+b.length,0),navigation:view.navigation,
        htmlNormalization:entry.normalized.map(n=>n.status),oversizedParts:legalDraft?legalDraft.chunks.flatMap((p,i)=>p.technicalSplit?[i+1]:[]):physicalBodies.flatMap((b,i)=>Buffer.byteLength(b)>80000?[i+1]:[])});
      entry.files.forEach((file,i)=>{
        const canonicalFile=canonical.files[i].name,kind=legalDraft||entry===canonical?'content':'reference';
        beforeBytes+=euLayoutBytes(title,entry.doc.celex,i+1,entry.files.length,entry.doc.sourceUrl,entry.doc.language)+Buffer.byteLength(entry.original[i]);
        if(kind==='reference')referenceCount++;
        parts.push({header:entry.doc.header,...(legalDraft?{legalContext:legalDraft,contextLabels:legalChunkContext(legalDraft,physicalBodies[i])}:{}),language:entry.doc.language,name:file.name,order:entry.act.order,title,celex:file.celex,part:file.part,total:entry.files.length,
          sourceUrl:entry.doc.sourceUrl,body:physicalBodies[i],details:kind==='content'
            ? {jurisdiction:'EU',kind,metadata:{celex:file.celex,part:file.part,sourceHash:hashes[i],...legalDraft?{layoutProfile:LEGAL_PROFILE}:{}}}
            : {jurisdiction:'EU',kind,metadata:{celex:file.celex,part:file.part,sourceHash:partHashes[i],canonicalFile}}});
      });
    }
  }
  const finalized=[...results.values()].sort((a,b)=>a.order-b.order);
  finalized.forEach(a=>a.documents.sort((x,y)=>x.celex.localeCompare(y.celex)));
  return {acts:finalized,parts,normalization:{...rules,
    metadataRules:{aliases:'Presence mask _aliases: x=CELEX, l=creation legacy, d=consolidated date',defaults:{c:'resource_legal_codified_version=[0]',e:'resource_legal_date_end-of-validity=[9999-12-31]',i:'resource_legal_in-force=[1]'}},
    htmlWhitespace:'Leading indentation before table/thead/tbody/tfoot/tr/td/th/colgroup/col/p/div/figure/figcaption only; protected regions retained; invariant failure preserves original region.',
    canonicalPriority:['standalone document','basic CELEX before consolidated alternative','act order','CELEX'],
    sizeBasis:'Same short headers plus unnormalized bodies before normalization/dedup, versus final content/reference files; manifest/index/report excluded.',beforeBytes,referenceCount,deduplicationGroups:groupCount}};
}
