import { assertEuIntegrity } from './content-integrity.js';
import type { EuIntegrity } from './content-integrity.js';
import { resolveEuNavigation } from './eu-navigation.js';
import type { EuDocument } from './eu-provider.js';
import { normalizeEuBody, hasSensitiveEuBody, languageDictionary, normalizeMetadata, metadataHash, normalizeFinalEuBody, euLayoutBytes, legalBodyHash } from './eu-normalize.js';
import { normalizeOutput } from './output.js';
import type { EuFinalFile } from './final-file.js';
import type { FileMetadata } from './final-file.js';
import type { EuNavigation } from './eu-navigation.js';
import type { NormalizedMetadata } from './eu-normalize.js';
export type EuBuiltDocument = EuDocument & {language?:'NL'|'EN';sourceUrl:string;sourceSha256:string;articleCount:number;textLength:number;
  integrity:EuIntegrity;navigation?:EuNavigation;oversizedParts?:number[]};
export interface EuBuiltAct {
  sourceArchive?:import('./official-sources.js').SourceArchive;
  order:number;title:string;celex:string;
  documents:EuBuiltDocument[];
  files:{name:string;celex:string;part:number;md5:string}[];
  excludedDocuments:{celex:string;reason:string}[];
}
export type EuPublishedFile = FileMetadata & {celex:string;part:number;sourceHash:string} &
  ({kind:'content';canonicalFile?:never} | {kind:'reference';canonicalFile:string});
export type EuFinalDocument = Omit<EuBuiltDocument,'metadata'|'navigation'|'oversizedParts'> & {
  metadata:NormalizedMetadata;metadataHash:string;sourceHash:string;inputBodyHash:string;
  navigation:EuNavigation;oversizedParts:number[];htmlNormalization:ReturnType<typeof normalizeEuBody>['status'][];
};
export interface EuFinalAct extends Omit<EuBuiltAct,'documents'|'files'> {
  documents:EuFinalDocument[];files:EuPublishedFile[];
}
export interface EuPartModel {
  language?:'NL'|'EN'; name:string; order:number; title:string; celex:string; part:number; total:number; sourceUrl:string; body:string;
  details: Pick<EuFinalFile,'jurisdiction'|'kind'> & EuFinalFileDetails;
}
type EuFinalFileDetails =
  | {kind:'content'; metadata:{celex:string;part:number;sourceHash:string}}
  | {kind:'reference'; metadata:{celex:string;part:number;sourceHash:string;canonicalFile:string}};
export function buildEuModel(acts: EuBuiltAct[], readBody:(name:string)=>string) {
  const ordered=[...acts].sort((a,b)=>a.order-b.order);
  const rules=languageDictionary(ordered.flatMap(a=>a.documents.map(d=>d.metadata)));
  const entries=ordered.flatMap(act=>[...act.documents].sort((a,b)=>a.celex.localeCompare(b.celex)).map(doc=>{
    const files=act.files.filter(f=>f.celex===doc.celex).sort((a,b)=>a.part-b.part);
    const original=files.map(f=>readBody(f.name));
    const sensitive=original.some(hasSensitiveEuBody);
    const normalized=sensitive?original.map(body=>({body,status:'sensitive-skip' as const})):original.map(normalizeEuBody);
    const sourceHash=legalBodyHash(normalized.map(n=>normalizeOutput(n.body).trimEnd()).join('\n\n'));
    assertEuIntegrity(doc.integrity,normalized.map(n=>n.body).join('\n'));
    return {act,doc,files,original,normalized,sourceHash};
  }));
  const groups=new Map<string,typeof entries>();
  for(const e of entries){const group=groups.get(e.sourceHash)??[];group.push(e);groups.set(e.sourceHash,group);}
  const priority=(e:typeof entries[number])=>[e.act.celex===e.doc.celex?0:1,e.doc.celex.startsWith('0')?1:0,e.act.order,e.doc.celex] as const;
  const compare=(a:typeof entries[number],b:typeof entries[number])=>{const x=priority(a),y=priority(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]||x[3].localeCompare(y[3]);};
  const parts: EuPartModel[] = [], results=new Map<number,EuFinalAct>();
  for(const act of ordered)results.set(act.order,{order:act.order,title:act.title,celex:act.celex,documents:[],files:[],excludedDocuments:act.excludedDocuments,...act.sourceArchive?{sourceArchive:act.sourceArchive}:{}});
  let beforeBytes=0,referenceCount=0,groupCount=0;
  for(const group of [...groups.values()].sort((a,b)=>a[0].sourceHash.localeCompare(b[0].sourceHash))){
    group.sort(compare);const canonical=group[0];if(group.length>1)groupCount++;
    const resolved=resolveEuNavigation(canonical.normalized.map(n=>n.body),canonical.files.map(f=>f.name),canonical.doc.sourceUrl);
    const bodies=resolved.chunks.map(normalizeFinalEuBody);
    const partHashes=bodies.map(legalBodyHash),documentHash=legalBodyHash(bodies.join('\n\n'));
    for(const entry of group){
      if(entry.files.length!==canonical.files.length)throw new Error('Identical EU documents have inconsistent part boundaries.');
      const result=results.get(entry.act.order)!;assertEuIntegrity(entry.doc.integrity,bodies.join('\n'));
      result.documents.push({...entry.doc,metadata:normalizeMetadata(entry.doc.metadata,entry.doc.celex,rules),metadataHash:metadataHash(entry.doc.metadata),
        sourceHash:documentHash,inputBodyHash:entry.sourceHash,textLength:bodies.reduce((n,b)=>n+b.length,0),navigation:resolved.navigation,
        htmlNormalization:entry.normalized.map(n=>n.status),oversizedParts:bodies.flatMap((b,i)=>Buffer.byteLength(b)>80000?[i+1]:[])});
      entry.files.forEach((file,i)=>{
        const canonicalFile=canonical.files[i].name,kind=entry===canonical?'content':'reference';
        beforeBytes+=euLayoutBytes(entry.act.title,entry.doc.celex,i+1,entry.files.length,entry.doc.sourceUrl,entry.doc.language)+Buffer.byteLength(entry.original[i]);
        if(kind==='reference')referenceCount++;
        parts.push({language:entry.doc.language,name:file.name,order:entry.act.order,title:entry.act.title,celex:file.celex,part:file.part,total:entry.files.length,
          sourceUrl:entry.doc.sourceUrl,body:bodies[i],details:kind==='content'
            ? {jurisdiction:'EU',kind,metadata:{celex:file.celex,part:file.part,sourceHash:partHashes[i]}}
            : {jurisdiction:'EU',kind,metadata:{celex:file.celex,part:file.part,sourceHash:partHashes[i],canonicalFile}}});
      });
    }
  }
  const finalized=[...results.values()].sort((a,b)=>a.order-b.order);
  finalized.forEach(a=>a.documents.sort((x,y)=>x.celex.localeCompare(y.celex)));
  return {acts:finalized,parts,normalization:{...rules,
    metadataRules:{aliases:'Presence mask _aliases: x=CELEX, l=creation legacy, d=consolidated date',defaults:{c:'resource_legal_codified_version=[0]',e:'resource_legal_date_end-of-validity=[9999-12-31]',i:'resource_legal_in-force=[1]'}},
    htmlWhitespace:'Leading indentation before table/thead/tbody/tfoot/tr/td/th/colgroup/col/p/div/figure/figcaption only; sensitive documents skipped; invariant failure preserves original.',
    canonicalPriority:['standalone document','basic CELEX before consolidated alternative','act order','CELEX'],
    sizeBasis:'Same short headers plus unnormalized bodies before normalization/dedup, versus final content/reference files; manifest/index/report excluded.',beforeBytes,referenceCount,deduplicationGroups:groupCount}};
}
