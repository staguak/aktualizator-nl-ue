import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,encode} from './release-store.js';
import {safeCacheDirectory} from './cache-directory.js';
import {operationMetrics} from './operation-metrics.js';

// Only deterministic parser results are cached. Discovery, HTTP validation,
// source identity, legal selection, models and publication are never skipped.
export class DerivedCache {
  readonly stats={hits:0,computed:0};
  constructor(private dir:string|undefined,private maxBytes=128_000_000){}
  value<T>(dependencies:Record<string,unknown>,compute:()=>T,validate:(value:unknown)=>value is T):T{
    const key=hash(encode(dependencies)),file=this.dir&&safeCacheDirectory(this.dir)?path.join(this.dir,key+'.json'):undefined;
    if(file)try{
      const stat=fs.lstatSync(file);
      if(stat.isFile()&&stat.size<=this.maxBytes){
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));
        if(saved.schemaVersion===1&&saved.key===key&&hash(encode(saved.dependencies))===key&&
          saved.valueSha256===hash(encode(saved.value))&&validate(saved.value)){
          this.stats.hits++;operationMetrics.add('parserCacheHits');return saved.value;
        }
      }
    }catch{/* An absent/corrupt optimization cache must recompute, never certify freshness. */}
    this.stats.computed++;operationMetrics.add('parserComputed');const value=compute();
    if(!validate(value))throw new Error('Invalid derived parser output.');
    if(file&&safeCacheDirectory(path.dirname(file))){
      const bytes=encode({schemaVersion:1,key,dependencies,value,valueSha256:hash(encode(value))});
      if(bytes.length<=this.maxBytes){
        let temp:string|undefined;
        try{fs.mkdirSync(path.dirname(file),{recursive:true});
          if(safeCacheDirectory(path.dirname(file))){temp=file+'.'+randomUUID()+'.tmp';
            fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,file);}
        }catch{/* Optional cache storage failure does not replace the verified computed value. */}
        finally{if(temp)try{fs.rmSync(temp,{force:true});}catch{/* A cleanup denial cannot invalidate the computed source value. */}}
      }
    }
    return value;
  }
}
