import fs from 'node:fs';
import path from 'node:path';
import {safeCacheDirectory} from './cache-directory.js';

export interface SourceDecision {
  key:string;url:string;size:number;sha256:string;checkedAt:string;lastModified:string|null;
  action:'NEW'|'MISSING'|'CORRUPT'|'CHANGED'|'UNCHANGED'|'AUDIT';receivedBytes:number;
}
const decisions:SourceDecision[]=[];
export function recordSourceDecision(value:SourceDecision){decisions.push(value);}
export function incrementalPlan(){
  return {profile:'public-incremental-plan-v1',sources:[...decisions],
    counts:Object.fromEntries(['NEW','MISSING','CORRUPT','CHANGED','UNCHANGED','AUDIT'].map(action=>[action,decisions.filter(d=>d.action===action).length])),
    receivedBytes:decisions.reduce((n,d)=>n+d.receivedBytes,0)};
}
export function registerIncrementalPlan(root:string,role:'NL'|'EU'){
  if(process.env.LAW_PUBLIC_INCREMENTAL!=='1')return;
  process.once('exit',()=>{
    try{
      const dir=path.join(root,'.public-state');if(!safeCacheDirectory(dir))throw new Error('Unsafe incremental report directory.');
      fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`incremental-${role}.json`),JSON.stringify(incrementalPlan(),null,2)+'\n');
    }catch{console.error('Incremental report could not be preserved.');process.exitCode=1;}
  });
}
