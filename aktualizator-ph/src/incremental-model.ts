import path from 'node:path';
import {DerivedCache} from './derived-cache.js';
import {buildNlModel} from './nl-model.js';
import type {NlModel} from './nl-model.js';
import type {ScopeAct,VersionSnapshot} from './types.js';
import {hash,encode} from './release-store.js';
import {sourceAuditMode} from './source-audit.js';
import {executionRevision} from './execution-revision.js';
import {fileURLToPath} from 'node:url';
import {normalizeEuBody,normalizeFinalEuBody} from './eu-normalize.js';
import {resolveEuNavigation} from './eu-navigation.js';
const revisions=new Map<string,string>();
const revision=(root:string)=>{let value=revisions.get(root);if(!value){value=executionRevision(root);revisions.set(root,value);}return value;};
function modelCache(){
  return process.env.LAW_PUBLIC_INCREMENTAL==='1'&&sourceAuditMode()!=='unconditional'&&process.env.LAW_SOURCE_CACHE_DIR
    ?new DerivedCache(path.join(process.env.LAW_SOURCE_CACHE_DIR,'models'),128_000_000,'model'):undefined;
}

/** Source discovery/selection has already run. With the same lower boundary
 * and the exact same intersecting source states, changing the upper day cannot
 * add a legal state; a new state changes the dependency key. */
export function incrementalNlModel(root:string,act:ScopeAct,snapshots:VersionSnapshot[],from:string,to:string):NlModel{
  const enabled=process.env.LAW_PUBLIC_INCREMENTAL==='1'&&sourceAuditMode()!=='unconditional'&&!!process.env.LAW_SOURCE_CACHE_DIR;
  if(!enabled||snapshots.some(s=>!s.version.validFrom||s.version.validFrom>to||s.version.validTo&&s.version.validTo<from))return buildNlModel(act,snapshots,from,to);
  const cache=modelCache()!;
  const model=cache.value({profile:'nl-source-model-v1',code:revision(root),runtime:process.versions.node,act,from,
    sources:snapshots.map(s=>({version:s.version,sourceSha256:s.sourceSha256??hash(encode(s.statute))}))},
    ()=>buildNlModel(act,snapshots,from,to),(value:unknown):value is NlModel=>{
      const model=value as NlModel;return !!model&&model.rangeFrom===from&&Array.isArray(model.articles)&&Array.isArray(model.states)&&
        Array.isArray(model.selectedArticles)&&Array.isArray(model.missingArticles)&&Array.isArray(model.missingStructures)&&!!model.integrity;
    });
  return {...model,rangeTo:to};
}
const root=fileURLToPath(new URL('../',import.meta.url));
export function incrementalEuNormalization(body:string):ReturnType<typeof normalizeEuBody>{
  const cache=modelCache();if(!cache)return normalizeEuBody(body);
  return cache.value({profile:'eu-normalization-v1',code:revision(root),runtime:process.versions.node,sourceSha256:hash(Buffer.from(body))},
    ()=>normalizeEuBody(body),(v:unknown):v is ReturnType<typeof normalizeEuBody>=>{
      const value=v as ReturnType<typeof normalizeEuBody>;return !!value&&typeof value.body==='string'&&['unchanged','verified','sensitive-skip','fallback'].includes(value.status);
    });
}
export function incrementalEuNavigation(bodies:string[],names:string[],sourceUrl:string,structural=false):ReturnType<typeof resolveEuNavigation>{
  const compute=()=>{const result=resolveEuNavigation(bodies,names,sourceUrl,structural);return {...result,chunks:result.chunks.map(normalizeFinalEuBody)};};
  const cache=modelCache();if(!cache)return compute();
  return cache.value({profile:'eu-navigation-v1',code:revision(root),runtime:process.versions.node,names,sourceUrl,structural,
    parts:bodies.map(body=>hash(Buffer.from(body)))},compute,(v:unknown):v is ReturnType<typeof resolveEuNavigation>=>{
      const value=v as ReturnType<typeof resolveEuNavigation>;return !!value&&Array.isArray(value.chunks)&&value.chunks.length===names.length&&
        value.chunks.every(c=>typeof c==='string')&&Array.isArray(value.navigation?.sourceFragmentIssues);
    });
}
