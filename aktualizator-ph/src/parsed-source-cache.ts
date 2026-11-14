import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DerivedCache} from './derived-cache.js';
import {hash} from './release-store.js';
import {XML_PROFILE,xmlValidationEnabled} from './xml-validation.js';
import {parseBwbXml} from './bwb-parser.js';
import type {ParsedStatute} from './types.js';
import {parseEuHtml} from './eu-parser.js';
import type {EuText} from './eu-parser.js';
import type {SourceResponse} from './source-cache.js';
import {sourceAuditMode} from './source-audit.js';
import type {EuLanguage} from './eu-language.js';
import {parseNlLegalStructure} from './nl-legal-structure.js';
import type {LegalContext,LegalDraft} from './legal-structure.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=process.env.LAW_DISABLE_DERIVED_CACHE==='1'?undefined:
  process.env.LAW_DERIVED_CACHE_DIR??(process.env.LAW_SOURCE_CACHE_DIR?path.join(process.env.LAW_SOURCE_CACHE_DIR,'derived'):undefined);
const cache=new DerivedCache(directory),profiles=new Map<string,string>();
const auditCache=new DerivedCache(undefined);
const effectiveCache=()=>sourceAuditMode()==='unconditional'?auditCache:cache;
function profile(kind:'NL'|'EU'):string{
  let digest=profiles.get(kind);if(digest)return digest;
  const files=kind==='NL'?['src/bwb-parser.ts','src/nl-legal-structure.ts','src/nl-cals.ts','src/legal-tree.ts','src/legal-structure.ts']:['src/eu-parser.ts','src/eu-tables.ts','src/content-integrity.ts','src/eu-language.ts','src/eu-legal-structure.ts','src/legal-tree.ts','src/legal-structure.ts'];
  digest=hash(Buffer.concat([...files,'package-lock.json','src/derived-cache.ts','src/parsed-source-cache.ts','src/cache-directory.ts']
    .concat('src/source-audit.ts').map(name=>fs.readFileSync(path.join(root,name)))));profiles.set(kind,digest);return digest;
}
export function parseNlLegalSource(source:SourceResponse,context:LegalContext):LegalDraft{
  return effectiveCache().value({kind:'NL-structured',parser:profile('NL'),runtime:process.versions.node,context,
    validation:xmlValidationEnabled()?XML_PROFILE:'legacy-unvalidated'},()=>parseNlLegalStructure(source.text,context),
    (v:unknown):v is LegalDraft=>{const draft=v as LegalDraft;return !!draft&&draft.profile==='legal-structure-v1'&&Array.isArray(draft.units)&&Array.isArray(draft.chunks);});
}
export function parsedCacheStats(){return {hits:cache.stats.hits+auditCache.stats.hits,computed:cache.stats.computed+auditCache.stats.computed,scope:'Parser reuse only; source discovery/revalidation still execute. Model and XML reuse have separate counters.'};}
export function parseNlSource(source:SourceResponse):ParsedStatute{
  return effectiveCache().value({kind:'NL',parser:profile('NL'),runtime:process.versions.node,sourceSha256:hash(source.bytes),
    validation:xmlValidationEnabled()?XML_PROFILE:'legacy-unvalidated'},()=>parseBwbXml(source.text),
    (v:unknown):v is ParsedStatute=>{
      const s=v as ParsedStatute;return !!s&&typeof s.bwbId==='string'&&typeof s.title==='string'&&Array.isArray(s.provisions)&&
        s.provisions.every(p=>typeof p.article==='string'&&typeof p.provisionRef==='string'&&typeof p.structurePath==='string'&&typeof p.content==='string');
    });
}
export function parseEuSource(source:SourceResponse,include:string,language:EuLanguage,documentId?:string):EuText{
  const context:LegalContext|undefined=documentId?{corpus:'EU',documentId,version:documentId,language,sourceUrl:source.url,sourceSha256:hash(source.bytes)}:undefined;
  return effectiveCache().value({kind:'EU',parser:profile('EU'),runtime:process.versions.node,sourceSha256:hash(source.bytes),
    sourceUrl:source.url,include,language,context,validation:xmlValidationEnabled()?XML_PROFILE:'legacy-unvalidated'},
    ()=>parseEuHtml(source.text,source.url,include,language,context),(v:unknown):v is EuText=>{
      const s=v as EuText;return !!s&&Array.isArray(s.chunks)&&!!s.chunks.length&&s.chunks.every(c=>typeof c==='string')&&
        Number.isSafeInteger(s.articleCount)&&Number.isSafeInteger(s.textLength)&&!!s.integrity&&(!context||s.legalDraft?.profile==='legal-structure-v1');
    });
}
