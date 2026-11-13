import {isDeepStrictEqual} from 'node:util';
import {preflight} from './release-engine.js';
import {hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import {runPool} from './concurrency.js';

// Read-only payload inventory. Drive has no cross-file snapshot: verify the
// active anchor, names and every metadata record again, refusing observations
// that changed while measured. No temporary writes or cleanup are permitted.
export async function measureStoreFootprint(store:ReleaseStore){
  const active=await preflight(store,'update',false),anchor=await store.read('active.json');
  if(!active||!anchor)throw new Error('Footprint requires a healthy committed pair.');
  if(!isDeepStrictEqual(JSON.parse(anchor.toString()),active))throw new Error('Footprint active changed after preflight.');
  const keys=(await store.list('')).sort();
  if(!keys.length||keys.length>250_000||new Set(keys).size!==keys.length)throw new Error('Invalid or oversized footprint inventory.');
  const records=new Map<string,StoredObject>();
  await runPool(keys,4,async key=>{
    const value=await store.stat(key);
    if(!value||!Number.isSafeInteger(value.size)||value.size<0)throw new Error('Footprint object disappeared or has invalid size.');
    records.set(key,value);
  });
  await runPool(keys,4,async key=>{
    if(!isDeepStrictEqual(await store.stat(key),records.get(key)))throw new Error('Footprint metadata changed during measurement.');
  });
  const second=(await store.list('')).sort(),after=await store.read('active.json');
  if(!after||!after.equals(anchor)||!isDeepStrictEqual(keys,second))throw new Error('Footprint anchor or inventory changed during measurement.');
  const byArea:Record<string,{files:number;bytes:number}>={};
  for(const [key,record] of records){
    const area=['base','releases','work','checks','source-history'].includes(key.split('/')[0])?key.split('/')[0]:'other';
    const sum=byArea[area]??{files:0,bytes:0};sum.files++;sum.bytes+=record.size;
    if(!Number.isSafeInteger(sum.bytes))throw new Error('Footprint byte count exceeds safe range.');byArea[area]=sum;
  }
  const totalBytes=Object.values(byArea).reduce((n,a)=>n+a.bytes,0);
  if(!Number.isSafeInteger(totalBytes))throw new Error('Footprint total exceeds safe range.');
  return {schemaVersion:1,profile:'store-payload-footprint-v1',status:'PASS',releaseId:active.releaseId,baseId:active.baseId,
    activeSha256:hash(anchor),files:keys.length,totalBytes,byArea,measuredAt:new Date().toISOString(),
    scope:'Owned non-trashed file payloads, including controls/work/checks; excludes folder overhead, revisions, trash and account quota. Stable double metadata/list/active observation, not a transactional Drive snapshot.'};
}
