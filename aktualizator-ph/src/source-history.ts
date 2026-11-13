import {gzipSync,gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {zipInventory} from './zip-integrity.js';
import {loadSourceArchive,safeArchiveName} from './official-sources.js';
import {validateManifest,validatePointer} from './release-engine.js';
import type {ActivePointer,ReleaseManifest,ReleaseFile} from './release-engine.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

interface Chunk {sha256:string;size:number}
interface PreservedFile {key:string;sha256:string;md5:string;size:number;encoding:'gzip'|'zip-byte-chunks';chunks:Chunk[]}
export interface SourceHistoryRecord {profile:'retired-source-history-v1';pointer:ActivePointer;files:PreservedFile[]}
const LIMIT=256_000_000,MAX_CHUNKS=20_000;
const objectKey=(sha:string)=>`source-history/objects/${sha}.bin`;
const recordKey=(id:string)=>`source-history/generations/${id}.json`;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourceFiles=(manifest:ReleaseManifest,module:any,jurisdiction:'NL'|'EU')=>{
  if(module.jurisdiction!==jurisdiction||!Array.isArray(module.acts??[]))throw new Error('Invalid historical module manifest.');
  const result:ReleaseFile[]=[];
  for(const act of module.acts??[]){
    if(!act.sourceArchive)continue;
    const file=manifest.files.find(f=>f.jurisdiction===jurisdiction&&f.name===act.sourceArchive.name);
    if(!file||result.some(f=>f.key===file.key))throw new Error('Missing or duplicate historical source archive.');result.push(file);
  }
  if(manifest.files.some(f=>f.jurisdiction===jurisdiction&&safeArchiveName(f.name)&&!result.some(s=>s.key===f.key)))
    throw new Error('Unreferenced historical native source archive.');
  return result;
};
async function putChunk(store:ReleaseStore,bytes:Buffer):Promise<Chunk>{
  const chunk={sha256:hash(bytes),size:bytes.length},key=objectKey(chunk.sha256);
  const before=await store.read(key);
  if(before){if(!before.equals(bytes))throw new Error('Historical chunk corruption.');return chunk;}
  await store.write(key,bytes,true);
  const after=await store.read(key);if(!after||!after.equals(bytes))throw new Error('Historical chunk write verification failed.');return chunk;
}
async function preserveFile(store:ReleaseStore,key:string,bytes:Buffer,zip:boolean):Promise<PreservedFile>{
  if(!bytes.length||bytes.length>LIMIT)throw new Error('Historical file exceeds bounded storage profile.');
  const parts:Buffer[]=[];
  if(zip){
    const points=new Set([0,bytes.length]);
    // Chunk exact physical ZIP bytes at compressed-stream boundaries. The
    // stream deduplicates even when its filename or sibling/catalog changes.
    for(const entry of zipInventory(bytes).values()){points.add(entry.dataOffset);points.add(entry.dataOffset+entry.compressed);}
    const offsets=[...points].sort((a,b)=>a-b);
    for(let i=1;i<offsets.length;i++)parts.push(bytes.subarray(offsets[i-1],offsets[i]));
  }else parts.push(gzipSync(bytes,{level:6}));
  if(parts.length>MAX_CHUNKS)throw new Error('Historical file has too many chunks.');
  const chunks:Chunk[]=[];for(const part of parts)chunks.push(await putChunk(store,part));
  return {key,sha256:hash(bytes),md5:hash(bytes,'md5'),size:bytes.length,encoding:zip?'zip-byte-chunks':'gzip',chunks};
}
async function restoreFile(store:ReleaseStore,file:PreservedFile):Promise<Buffer>{
  if(!file||typeof file.key!=='string'||!sha(file.sha256)||!/^[a-f0-9]{32}$/.test(file.md5)||
    !Number.isSafeInteger(file.size)||file.size<1||file.size>LIMIT||!['gzip','zip-byte-chunks'].includes(file.encoding)||
    !Array.isArray(file.chunks)||!file.chunks.length||file.chunks.length>MAX_CHUNKS||file.encoding==='gzip'&&file.chunks.length!==1)
    throw new Error('Invalid historical file reference.');
  const parts:Buffer[]=[];let total=0;
  for(const chunk of file.chunks){
    if(!chunk||!sha(chunk.sha256)||!Number.isSafeInteger(chunk.size)||chunk.size<1||(total+=chunk.size)>LIMIT+1_000_000)throw new Error('Invalid historical chunk reference.');
    const bytes=await store.read(objectKey(chunk.sha256));
    if(!bytes||bytes.length!==chunk.size||hash(bytes)!==chunk.sha256)throw new Error('Historical chunk missing or corrupted.');parts.push(bytes);
  }
  const stored=Buffer.concat(parts),raw=file.encoding==='gzip'?gunzipSync(stored,{maxOutputLength:file.size}):stored;
  if(raw.length!==file.size||hash(raw)!==file.sha256||hash(raw,'md5')!==file.md5)throw new Error('Historical file checksum mismatch.');return raw;
}
function bind(file:PreservedFile,expected:ReleaseFile){
  if(file.sha256!==expected.sha256||file.md5!==expected.md5||file.size!==expected.size)throw new Error('Historical file differs from committed manifest.');
}

// Verify the saved original root/module manifests and every exact native ZIP.
// Returned references are technical storage facts, never new legal assertions.
export async function readSourceHistory(store:ReleaseStore,releaseId:string):Promise<SourceHistoryRecord|null>{
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(releaseId))throw new Error('Invalid historical release identity.');
  const bytes=await store.read(recordKey(releaseId));if(!bytes)return null;
  const record=JSON.parse(bytes.toString()) as SourceHistoryRecord;validatePointer(record.pointer);
  if(record.profile!=='retired-source-history-v1'||record.pointer.releaseId!==releaseId||!Array.isArray(record.files)||record.files.length>1000)throw new Error('Invalid historical generation record.');
  const files=new Map(record.files.map(f=>[f.key,f]));if(files.size!==record.files.length)throw new Error('Duplicate historical file.');
  const root=files.get(record.pointer.manifestKey);if(!root||root.encoding!=='gzip'||root.sha256!==record.pointer.manifestSha256)throw new Error('Historical root anchor mismatch.');
  const manifest=JSON.parse((await restoreFile(store,root)).toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==releaseId||manifest.context.baseId!==record.pointer.baseId)throw new Error('Historical root identity mismatch.');
  const expectedKeys=new Set([root.key]);
  for(const [key,jurisdiction] of [[manifest.nlManifest,'NL'],[manifest.euManifest,'EU']] as const){
    const file=files.get(key),expected=manifest.files.find(f=>f.key===key)!;
    if(!file||file.encoding!=='gzip')throw new Error('Missing historical module manifest.');bind(file,expected);expectedKeys.add(key);
    const module=JSON.parse((await restoreFile(store,file)).toString());
    if(module.rangeFrom!==manifest.context.rangeFrom||module.rangeTo!==manifest.context.rangeTo)throw new Error('Historical module range mismatch.');
    for(const source of sourceFiles(manifest,module,jurisdiction)){
      const archive=files.get(source.key);if(!archive||archive.encoding!=='zip-byte-chunks')throw new Error('Missing historical native source.');bind(archive,source);
      const act=module.acts.find((a:any)=>a.sourceArchive?.name===source.name);
      loadSourceArchive(await restoreFile(store,archive),act.sourceArchive,jurisdiction,act.bwbId??act.celex);expectedKeys.add(source.key);
    }
  }
  if(expectedKeys.size!==files.size)throw new Error('Unexpected historical file.');return record;
}

export async function preserveRetiredSources(store:ReleaseStore,pointer:ActivePointer):Promise<void>{
  validatePointer(pointer);
  const saved=await readSourceHistory(store,pointer.releaseId);
  if(saved){
    // Rollback/recovery may produce another commit anchor for the same immutable
    // release. Exact generation/base hashes, not operation IDs, bind its data.
    if(saved.pointer.manifestSha256!==pointer.manifestSha256||saved.pointer.baseManifestSha256!==pointer.baseManifestSha256||saved.pointer.baseId!==pointer.baseId)throw new Error('Historical generation anchor conflict.');return;
  }
  const bytes=await store.read(pointer.manifestKey);
  if(!bytes||hash(bytes)!==pointer.manifestSha256)throw new Error('Cannot preserve missing or corrupt retirement manifest.');
  const manifest=JSON.parse(bytes.toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==pointer.releaseId||manifest.context.baseId!==pointer.baseId)throw new Error('Retirement identity mismatch.');
  const files:PreservedFile[]=[await preserveFile(store,pointer.manifestKey,bytes,false)];
  for(const [key,jurisdiction] of [[manifest.nlManifest,'NL'],[manifest.euManifest,'EU']] as const){
    const raw=await store.read(key),expected=manifest.files.find(f=>f.key===key)!;
    if(!raw||hash(raw)!==expected.sha256)throw new Error('Retirement module manifest changed.');
    const module=JSON.parse(raw.toString());files.push(await preserveFile(store,key,raw,false));
    for(const file of sourceFiles(manifest,module,jurisdiction)){
      const native=await store.read(file.key);if(!native||hash(native)!==file.sha256)throw new Error('Retirement native source changed.');
      const act=module.acts.find((a:any)=>a.sourceArchive?.name===file.name);
      loadSourceArchive(native,act.sourceArchive,jurisdiction,act.bwbId??act.celex);
      files.push(await preserveFile(store,file.key,native,true));
    }
  }
  const record:SourceHistoryRecord={profile:'retired-source-history-v1',pointer,files};
  await store.write(recordKey(pointer.releaseId),encode(record),true);
  const verified=await readSourceHistory(store,pointer.releaseId);
  if(!isDeepStrictEqual(verified,record))throw new Error('Historical generation record write verification failed.');
}

export async function restoreHistoricalFile(store:ReleaseStore,record:SourceHistoryRecord,key:string):Promise<Buffer>{
  // Always authenticate the persisted record rather than accept caller-supplied
  // unverified references. A transient read failure never authorizes deletion.
  const verified=await readSourceHistory(store,record.pointer.releaseId);
  if(!verified||!isDeepStrictEqual(verified,record))throw new Error('Historical record changed.');
  const file=verified.files.find(f=>f.key===key);if(!file)throw new Error('Historical file not recorded.');return restoreFile(store,file);
}
