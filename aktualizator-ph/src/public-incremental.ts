import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeCacheDirectory} from './cache-directory.js';
import {importSourceCache} from './source-cache.js';
import {loadSourceArchive,safeArchiveName} from './official-sources.js';

export function publicIncrementalEnvironment(root:string,env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const cache=path.resolve(root,env.LAW_SOURCE_CACHE_DIR??'.source-cache');
  const work=path.join(root,'.public-state','build');
  if(!safeCacheDirectory(cache)||!safeCacheDirectory(work))throw new Error('Unsafe public incremental work directory.');
  return {...env,LAW_PUBLIC_INCREMENTAL:'1',LAW_CACHE_SHARDS:'8',LAW_SOURCE_CACHE_DIR:cache,LAW_PUBLIC_WORK_ROOT:work,
    LAW_XML_SOURCE_ROOT:cache,LAW_PUBLIC_OPERATION_ID:env.LAW_PUBLIC_OPERATION_ID??randomUUID()};
}
export function warmPublicSources(root:string,cache:string){
  let seeded=0,unusableArchives=0;
  const seen=new Set<string>();
  for(const [name,module] of [['.checkpoint','NL'],['.checkpoint-ue','EU'],['output','NL'],['output-ue','EU']] as const){
    const dir=path.join(root,name);if(!fs.existsSync(dir)||!safeCacheDirectory(dir))continue;
    try{
      const file=path.join(dir,name.startsWith('.')?'state.json':'manifest.json');
      if(!fs.lstatSync(file).isFile())continue;
      const state=JSON.parse(fs.readFileSync(file,'utf8'));
      const acts=module==='NL'&&name==='.checkpoint'?state.completedActs:state.acts;
      if(!Array.isArray(acts))continue;
      for(const act of acts){
        const archive=act.sourceArchive;if(!archive||!safeArchiveName(archive.name))continue;
        const target=path.join(dir,name==='.checkpoint'?'output':'',archive.name);
        if(seen.has(target))continue;seen.add(target);
        try{
          if(!safeCacheDirectory(path.dirname(target))||!fs.lstatSync(target).isFile())throw new Error('Unsafe previous source archive.');
          const native=loadSourceArchive(fs.readFileSync(target),archive,module,act.bwbId??act.celex);
          for(const entry of native.index.entries)if(importSourceCache(cache,entry,native.items[entry.name]))seeded++;
        }catch{unusableArchives++;}
      }
    }catch{/* Missing progress is not evidence of absence in the source. */}
  }
  return {profile:'public-source-warmup-v1',seeded,unusableArchives,scope:'HTTP optimization only; current official discovery and revalidation remain required.'};
}

const names=['output','output-ue'] as const;
function promotionPaths(root:string){
  const state=path.join(root,'.public-state');
  if(!safeCacheDirectory(state))throw new Error('Unsafe output promotion directory.');
  return {state,journal:path.join(state,'output-promotion.json'),backup:path.join(state,'prior-outputs')};
}
export function recoverPublicOutputs(root:string){
  const p=promotionPaths(root);if(!fs.existsSync(p.journal))return;
  if(!fs.lstatSync(p.journal).isFile())throw new Error('Unsafe output recovery journal.');
  const journal=JSON.parse(fs.readFileSync(p.journal,'utf8'));
  if(journal.profile!=='public-output-promotion-v1'||!['PREPARED','COMMITTED'].includes(journal.status)||
    !journal.previous||names.some(n=>typeof journal.previous[n]!=='boolean')||!safeCacheDirectory(p.backup))throw new Error('Invalid output recovery journal.');
  if(journal.status==='PREPARED')for(const name of names){
    const current=path.join(root,name),old=path.join(p.backup,name);
    if(!safeCacheDirectory(current)||!safeCacheDirectory(old))throw new Error('Unsafe output recovery path.');
    if(journal.previous[name]&&fs.existsSync(old)){fs.rmSync(current,{recursive:true,force:true});fs.renameSync(old,current);}
    else if(!journal.previous[name])fs.rmSync(current,{recursive:true,force:true});
  }
  fs.rmSync(p.backup,{recursive:true,force:true});fs.unlinkSync(p.journal);
}
/** All validation happens first. Interrupted local pair installation is
 * rolled back before the next build; it never changes the published pointer. */
export function promotePublicOutputs(root:string,work:string,afterMove:(name:string)=>void=()=>{}){
  recoverPublicOutputs(root);const p=promotionPaths(root);
  for(const name of names)if(!safeCacheDirectory(path.join(root,name))||!safeCacheDirectory(path.join(work,name))||!fs.lstatSync(path.join(work,name)).isDirectory())throw new Error('Unsafe output promotion path.');
  const previous=Object.fromEntries(names.map(name=>[name,fs.existsSync(path.join(root,name))]));
  if(fs.existsSync(p.backup))throw new Error('Unowned prior output directory blocks promotion.');
  fs.mkdirSync(p.backup,{recursive:true});
  const write=(status:string)=>{const temporary=p.journal+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify({profile:'public-output-promotion-v1',status,previous}),{flag:'wx'});fs.renameSync(temporary,p.journal);};
  write('PREPARED');
  try{
    for(const name of names){if(previous[name])fs.renameSync(path.join(root,name),path.join(p.backup,name));fs.renameSync(path.join(work,name),path.join(root,name));afterMove(name);}
    write('COMMITTED');
  }catch(error){recoverPublicOutputs(root);throw error;}
  recoverPublicOutputs(root);
}
