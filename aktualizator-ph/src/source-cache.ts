import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {safeCacheDirectory} from './cache-directory.js';
import {operationMetrics} from './operation-metrics.js';
import {sourceAuditMode} from './source-audit.js';
import {recordSourceDecision} from './incremental-plan.js';

export interface SourceObservation {
  retrievedAt:string|null;checkedAt:string;status:200|304;
  method:'downloaded'|'conditional-not-modified';
  redirects?:{from:string;status:number;location:string;requested:string}[];
}
export interface SourceCacheHint {url:string;headers:Record<string,string>;etag:string|null;lastModified:string|null}
export interface BinarySource {bytes:Buffer;url:string;contentType:string;observation?:SourceObservation;filePath?:string;size?:number;sha256?:string;md5?:string;cacheHint?:SourceCacheHint}
export interface SourceResponse extends BinarySource {text:string}
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface SourceOptions {cacheDir?:string;fetcher?:typeof fetch;timeoutMs?:number;allowedHosts?:string[];maxBytes?:number}
async function cancelUnusedStream(cancel:()=>Promise<void>):Promise<void>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([cancel(),new Promise<void>(resolve=>{timeout=setTimeout(resolve,1000);})]);
  }catch{/* Transport cleanup must not replace the known HTTP/size failure. */}
  finally{if(timeout)clearTimeout(timeout);}
}
async function discardUnusedBody(response:Response):Promise<void>{
  if(response.body)await cancelUnusedStream(()=>response.body!.cancel());
}

// HTTP entity bytes (after transport decompression), not response.text(), are
// canonical. Request variants have different keys; every reuse is revalidated.
export async function fetchBinarySource(url:string,headers:Record<string,string>,options:SourceOptions={}):Promise<BinarySource>{
  if(process.env.LAW_PUBLIC_INCREMENTAL==='1'){
    const xml=/xml|html/i.test(headers.Accept??headers.accept??'');
    return fetchSourceFile(url,headers,{...options,...xml?{maxBytes:undefined}:{}});
  }
  const finish=operationMetrics.beginSourceTransfer();
  try{return await fetchBinarySourceEntity(url,headers,options);}
  finally{finish();}
}

export function sourceCacheShard(key:string):string{return String(parseInt(key[0],16)%8);}
export function publicCacheFile(directory:string,key:string,kind='http'):string{
  return process.env.LAW_CACHE_SHARDS==='8'?path.join(directory,kind,sourceCacheShard(key),key+'.json'):path.join(directory,key+'.json');
}
export function fileDigests(file:string):{sha256:string;md5:string;size:number}{
  if(!fs.lstatSync(file).isFile())throw new Error('Source cache requires a regular file.');
  const sha=createHash('sha256'),md=createHash('md5'),buffer=Buffer.allocUnsafe(1024*1024);let size=0;
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;const chunk=buffer.subarray(0,count);sha.update(chunk);md.update(chunk);size+=count;}}
  finally{fs.closeSync(fd);}
  return {sha256:sha.digest('hex'),md5:md.digest('hex'),size};
}
interface FileRecord {schemaVersion:5;key:string;url:string;contentType:string;sha256:string;md5:string;size:number;etag:string|null;lastModified:string|null;retrievedAt:string}
function sourceKey(url:string,headers:Record<string,string>){return digest(JSON.stringify([url,Object.entries(headers).sort(([a],[b])=>a.localeCompare(b))]));}
function sourceBlob(root:string,sha:string){if(!/^[a-f0-9]{64}$/.test(sha))throw new Error('Invalid source checksum.');return path.join(root,'blobs',sourceCacheShard(sha),sha+'.bin');}
function verifyBlob(file:string,record:Pick<FileRecord,'sha256'|'md5'|'size'>){
  if(!safeCacheDirectory(path.dirname(file)))throw new Error('Unsafe source cache path.');
  const known=fileDigests(file);
  if(known.sha256!==record.sha256||known.md5!==record.md5||known.size!==record.size||!known.size)throw new Error('Source cache checksum changed.');
}
function cacheHint(url:string,headers:Record<string,string>,record:Pick<FileRecord,'etag'|'lastModified'>):SourceCacheHint|undefined{
  if(Object.keys(headers).some(k=>!['accept','accept-language'].includes(k.toLowerCase())))return;
  return {url,headers:{...headers},etag:record.etag,lastModified:record.lastModified};
}
function fileResponse(filePath:string,record:FileRecord,observation:SourceObservation,hint?:SourceCacheHint):SourceResponse{
  const read=()=>{if(!safeCacheDirectory(path.dirname(filePath)))throw new Error('Unsafe source cache path.');
    const fd=fs.openSync(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{if(!fs.fstatSync(fd).isFile())throw new Error('Source cache requires a regular file.');
      const bytes=fs.readFileSync(fd);if(bytes.length!==record.size||digest(bytes)!==record.sha256)throw new Error('Source cache checksum changed.');return bytes;}
    finally{fs.closeSync(fd);}};
  const result:SourceResponse={...record,filePath,observation,...hint?{cacheHint:hint}:{},get bytes(){return read();},get text(){return new TextDecoder('utf-8',{fatal:true}).decode(read());}};
  Object.defineProperties(result,{bytes:{get:read,enumerable:false},text:{get:()=>new TextDecoder('utf-8',{fatal:true}).decode(read()),enumerable:false}});
  return result;
}
/** Seed only optional HTTP state from already checksum-verified originals.
 * An imported body still needs an official conditional request on this run. */
export function importSourceCache(root:string,entry:{requestedUrl:string;url:string;contentType:string;cacheHint?:SourceCacheHint;httpObservation?:SourceObservation},bytes:Uint8Array):boolean{
  const hint=entry.cacheHint;if(!hint)return false;
  const allowed=['publications.europa.eu','eur-lex.europa.eu','repository.officiele-overheidspublicaties.nl','zoekservice.overheid.nl'];
  const check=(value:string)=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!allowed.includes(u.hostname))throw new Error('Unsafe imported source URI.');};
  check(entry.url);check(hint.url);
  if(hint.url!==entry.requestedUrl||!hint.headers||Object.entries(hint.headers).some(([k,v])=>!['accept','accept-language'].includes(k.toLowerCase())||typeof v!=='string'||/[\r\n]/.test(v))||
    [hint.etag,hint.lastModified].some(v=>v!==null&&typeof v!=='string'))throw new Error('Unsafe imported source request.');
  const key=sourceKey(hint.url,hint.headers),metadata=publicCacheFile(root,key);
  if(!safeCacheDirectory(path.dirname(metadata)))throw new Error('Unsafe imported source cache path.');
  try{if(!fs.lstatSync(metadata).isFile())throw new Error('Unsafe source cache metadata.');
    const saved=JSON.parse(fs.readFileSync(metadata,'utf8'));check(saved.url);
    if(saved.schemaVersion===5&&saved.key===key){verifyBlob(sourceBlob(root,saved.sha256),saved);return false;}}
  catch{/* Restore a missing or corrupt optimization from verified originals. */}
  const body=Buffer.from(bytes),sha256=digest(body),file=sourceBlob(root,sha256);
  const record:FileRecord={schemaVersion:5,key,url:entry.url,contentType:entry.contentType,size:body.length,sha256,
    md5:createHash('md5').update(body).digest('hex'),etag:hint.etag,lastModified:hint.lastModified,
    retrievedAt:entry.httpObservation?.retrievedAt??'1970-01-01T00:00:00.000Z'};
  if(!body.length||!safeCacheDirectory(path.dirname(file)))throw new Error('Invalid imported source body/path.');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(metadata),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp',meta=metadata+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,body,{flag:'wx'});fs.renameSync(temporary,file);fs.writeFileSync(meta,JSON.stringify(record),{flag:'wx'});fs.renameSync(meta,metadata);}
  finally{fs.rmSync(temporary,{force:true});fs.rmSync(meta,{force:true});}
  return true;
}

/** Canonical entity bytes on disk; the source itself has no default byte limit. */
export async function fetchSourceFile(url:string,headers:Record<string,string>,options:SourceOptions={}):Promise<SourceResponse>{
  const finish=operationMetrics.beginSourceTransfer();
  try{return await fetchFileEntity(url,headers,options);}finally{finish();}
}
async function fetchFileEntity(url:string,headers:Record<string,string>,options:SourceOptions):Promise<SourceResponse>{
  const hosts=options.allowedHosts;
  const destination=(value:string)=>{const p=new URL(value);if(p.protocol!=='https:'||p.username||p.password||p.port&&p.port!=='443'||hosts&&!hosts.includes(p.hostname))throw new Error('Unexpected source host or protocol.');p.hash='';return p.href;};
  destination(url);
  const root=options.cacheDir??process.env.LAW_SOURCE_CACHE_DIR??path.join(process.cwd(),'.source-cache');
  if(!safeCacheDirectory(root))throw new Error('Unsafe source file directory.');
  const key=sourceKey(url,headers),metadata=publicCacheFile(root,key);
  if(!safeCacheDirectory(path.dirname(metadata)))throw new Error('Unsafe source file directory.');
  fs.mkdirSync(path.dirname(metadata),{recursive:true});let cached:FileRecord|undefined;
  let action:'NEW'|'MISSING'|'CORRUPT'='NEW';
  if(sourceAuditMode()!=='unconditional')try{
    const st=fs.lstatSync(metadata);action='CORRUPT';if(!st.isFile()||st.size>65536)throw new Error();
    const record=JSON.parse(fs.readFileSync(metadata,'utf8'));destination(record.url);
    if(record.schemaVersion!==5||record.key!==key||typeof record.contentType!=='string'||typeof record.retrievedAt!=='string'||
      [record.etag,record.lastModified].some(v=>v!==null&&typeof v!=='string'))throw new Error();
    const blob=sourceBlob(root,record.sha256);action=fs.existsSync(blob)?'CORRUPT':'MISSING';verifyBlob(blob,record);
    if(record.size>(options.maxBytes??Infinity))throw new Error('Source cache exceeds the requested limit.');cached=record;
  }catch{/* Missing/corrupt entries require a new body, never a conditional 304. */}
  const signal=AbortSignal.timeout(options.timeoutMs??120_000);let current=url,conditional=false,response:Response;
  let requestHeaders={...headers};const redirects:NonNullable<SourceObservation['redirects']>=[];
  for(;;){
    const sent=Object.fromEntries(Object.entries(requestHeaders).filter(([k])=>!['if-none-match','if-modified-since'].includes(k.toLowerCase())));
    conditional=!!cached&&destination(current)===destination(cached.url)&&!!(cached.etag||cached.lastModified);
    if(conditional&&cached){if(cached.etag)sent['If-None-Match']=cached.etag;if(cached.lastModified)sent['If-Modified-Since']=cached.lastModified;}
    operationMetrics.add('sourceRequests');response=await(options.fetcher??fetch)(current,{headers:sent,signal,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await discardUnusedBody(response);
    if(!location||redirects.length>=5)throw new Error('Invalid or excessive source redirects.');
    const target=new URL(location,current);if(target.protocol==='http:'&&hosts?.includes(target.hostname))target.protocol='https:';
    const next=destination(target.href);redirects.push({from:current,status:response.status,location:new URL(location,current).href,requested:next});
    if(new URL(next).origin!==new URL(current).origin)requestHeaders=Object.fromEntries(Object.entries(requestHeaders).filter(([k])=>!['authorization','proxy-authorization','cookie'].includes(k.toLowerCase())));
    current=next;
  }
  const checkedAt=new Date().toISOString(),returned=destination(response.url||current);
  if(response.status===304){
    await discardUnusedBody(response);if(!cached||!conditional||returned!==destination(cached.url))throw new Error('Unexpected source 304 without a verified cache for the returned resource.');
    const file=sourceBlob(root,cached.sha256);verifyBlob(file,cached);
    operationMetrics.add('sourceNotModified');operationMetrics.add('sourceCacheReusedBytes',cached.size);
    recordSourceDecision({key,url,size:cached.size,sha256:cached.sha256,checkedAt,lastModified:cached.lastModified,action:'UNCHANGED',receivedBytes:0});
    return fileResponse(file,cached,{retrievedAt:cached.retrievedAt,checkedAt,status:304,method:'conditional-not-modified',...redirects.length?{redirects}:{}},cacheHint(url,headers,cached));
  }
  if(response.status!==200){await discardUnusedBody(response);throw new SourceHttpError(response.status);}
  const limit=options.maxBytes??Infinity;
  if(Number(response.headers.get('content-length'))>limit){await discardUnusedBody(response);throw new Error('Invalid source response size.');}
  const temporary=metadata+'.'+randomUUID()+'.part';const fd=fs.openSync(temporary,'wx');let size=0,complete=false;
  const sha=createHash('sha256'),md=createHash('md5');const reader=response.body?.getReader();
  try{
    if(!reader)throw new Error('Empty source response.');
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('Invalid source response size.');sha.update(part.value);md.update(part.value);fs.writeFileSync(fd,part.value);operationMetrics.add('sourceReceivedEntityBytes',part.value.length);}
    if(!size)throw new Error('Empty source response.');complete=true;
  }catch(error){if(reader)await cancelUnusedStream(()=>reader.cancel());throw error;}
  finally{fs.closeSync(fd);if(!complete)fs.rmSync(temporary,{force:true});}
  const record:FileRecord={schemaVersion:5,key,url:returned,contentType:response.headers.get('content-type')??'',size,sha256:sha.digest('hex'),md5:md.digest('hex'),retrievedAt:checkedAt,etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified')};
  const file=sourceBlob(root,record.sha256);if(!safeCacheDirectory(path.dirname(file))){fs.rmSync(temporary,{force:true});throw new Error('Unsafe source cache path.');}
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.renameSync(temporary,file);const tempMeta=metadata+'.'+randomUUID()+'.tmp';fs.writeFileSync(tempMeta,JSON.stringify(record));fs.renameSync(tempMeta,metadata);
  recordSourceDecision({key,url,size,sha256:record.sha256,checkedAt,lastModified:record.lastModified,
    action:sourceAuditMode()==='unconditional'?'AUDIT':cached?(cached.sha256===record.sha256?'UNCHANGED':'CHANGED'):action,receivedBytes:size});
  return fileResponse(file,record,{retrievedAt:checkedAt,checkedAt,status:200,method:'downloaded',...redirects.length?{redirects}:{}},cacheHint(url,headers,record));
}
async function fetchBinarySourceEntity(url:string,headers:Record<string,string>,options:SourceOptions):Promise<BinarySource>{
  const audit=sourceAuditMode();
  const hosts=options.allowedHosts;
  const destination=(value:string)=>{
    const parsed=new URL(value);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port&&parsed.port!=='443'||
      hosts&&!hosts.includes(parsed.hostname))throw new Error('Unexpected source host or protocol.');
    return parsed;
  };
  destination(url);
  const entityUrl=(value:string)=>{const parsed=destination(value);parsed.hash='';return parsed.href;};
  const key=digest(JSON.stringify([url,Object.entries(headers).sort(([a],[b])=>a.localeCompare(b))]));
  let file=options.cacheDir&&safeCacheDirectory(options.cacheDir)?path.join(options.cacheDir,key+'.json'):undefined;
  const limit=options.maxBytes??64_000_000;
  let cached:any,bytes:Buffer|undefined;
  // Keep writing the optional cache after a fresh successful response, but
  // never read its bytes/validators during an unconditional audit.
  if(file&&audit!=='unconditional')try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()){file=undefined;throw new Error('Unsafe cache file.');}
    if(stat.size>limit*2+65_536)throw new Error('Oversized source cache.');
    const candidate=JSON.parse(fs.readFileSync(file,'utf8'));
    destination(candidate.url);
    const data=[2,3].includes(candidate.version)&&typeof candidate.base64==='string'?Buffer.from(candidate.base64,'base64'):undefined;
    if(data?.length&&data.length<=limit&&candidate.key===key&&candidate.sha256===digest(data)&&
      (candidate.version===3||candidate.text===data.toString('utf8'))&&typeof candidate.url==='string'&&
      (!hosts||hosts.includes(new URL(candidate.url).hostname))){cached=candidate;bytes=data;}
  }catch{/* Invalid or old text-only caches cannot supply canonical source bytes. */}
  // Validate every redirect BEFORE making its request. Checking response.url
  // after automatic redirection is too late to enforce the source boundary.
  const signal=AbortSignal.timeout(options.timeoutMs??60_000);
  let current=url,response:Response,redirects=0,requestHeaders={...headers},conditionalUsed=false;
  const redirectEvidence:NonNullable<SourceObservation['redirects']>=[];
  for(;;){
    // Validators belong to the returned entity URL, not to every resource in
    // a redirect chain. Different resources can legitimately share an ETag.
    const sent=Object.fromEntries(Object.entries(requestHeaders).filter(([key])=>
      !['if-none-match','if-modified-since'].includes(key.toLowerCase())));
    conditionalUsed=!!cached&&entityUrl(current)===entityUrl(cached.url)&&!!(cached.etag||cached.lastModified);
    if(conditionalUsed){
      if(cached.etag)sent['If-None-Match']=cached.etag;
      if(cached.lastModified)sent['If-Modified-Since']=cached.lastModified;
    }
    operationMetrics.add('sourceRequests');
    response=await (options.fetcher??fetch)(current,{headers:sent,signal,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await discardUnusedBody(response);
    if(!location||++redirects>5)throw new Error('Invalid or excessive source redirects.');
    const target=new URL(location,current);
    // CELLAR publishes http resource identities even when HTTPS transport is
    // available. Follow that official resource via HTTPS; never downgrade TLS.
    if(target.protocol==='http:'&&hosts?.includes(target.hostname)&&
      ['publications.europa.eu','eur-lex.europa.eu','repository.officiele-overheidspublicaties.nl','zoekservice.overheid.nl'].includes(target.hostname))target.protocol='https:';
    const next=destination(target.href);
    redirectEvidence.push({from:current,status:response.status,location:new URL(location,current).href,requested:next.href});
    if(next.origin!==new URL(current).origin)requestHeaders=Object.fromEntries(Object.entries(requestHeaders)
      .filter(([key])=>!['authorization','proxy-authorization','cookie'].includes(key.toLowerCase())));
    current=next.href;
  }
  const checkedAt=new Date().toISOString();
  const responseUrl=response.url||current;
  destination(responseUrl);
  if(response.status===304){
    if(!bytes||!cached||!conditionalUsed||entityUrl(responseUrl)!==entityUrl(cached.url)){
      await discardUnusedBody(response);
      throw new Error('Unexpected source 304 without a verified cache for the returned resource.');
    }
    operationMetrics.add('sourceNotModified');operationMetrics.add('sourceCacheReusedBytes',bytes.length);
    return {bytes,url:cached.url,contentType:cached.contentType??'',observation:{
      retrievedAt:typeof cached.retrievedAt==='string'?cached.retrievedAt:null,checkedAt,status:304,method:'conditional-not-modified',
      ...redirectEvidence.length?{redirects:redirectEvidence}:{}}};
  }
  if(response.status!==200){await discardUnusedBody(response);throw new SourceHttpError(response.status);}
  if(Number(response.headers.get('content-length'))>limit){await discardUnusedBody(response);throw new Error('Invalid source response size.');}
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Empty source response.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
    operationMetrics.add('sourceReceivedEntityBytes',part.value.length);
    if(size>limit)throw new Error('Invalid source response size.');chunks.push(part.value);}}
  catch(error){await cancelUnusedStream(()=>reader.cancel());throw error;}
  bytes=Buffer.concat(chunks);
  if(!bytes.length)throw new Error('Empty source response.');
  const retrievedAt=new Date().toISOString();
  const contentType=response.headers.get('content-type')??'';
  if(file&&safeCacheDirectory(path.dirname(file))){
    let temp:string|undefined;
    try{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      if(safeCacheDirectory(path.dirname(file))){
        temp=file+'.'+randomUUID()+'.tmp';
        fs.writeFileSync(temp,JSON.stringify({version:3,key,base64:bytes.toString('base64'),url:responseUrl,retrievedAt,
          contentType,sha256:digest(bytes),etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified')}));fs.renameSync(temp,file);
      }
    }catch{/* An optional HTTP cache cannot discard a complete HTTP response. */}
    finally{if(temp)try{fs.rmSync(temp,{force:true});}catch{/* Cache cleanup is not original-source evidence persistence. */}}
  }
  return {bytes,url:responseUrl,contentType,observation:{retrievedAt,checkedAt:retrievedAt,status:200,method:'downloaded',
    ...redirectEvidence.length?{redirects:redirectEvidence}:{}}};
}
export async function fetchSource(url:string,headers:Record<string,string>,options:SourceOptions={}):Promise<SourceResponse>{
  const source=await fetchBinarySource(url,headers,options);
  if(source.filePath)return source as SourceResponse;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);
  if(!text.trim())throw new Error('Empty source text.');
  return {...source,text};
}

export class SourceHttpError extends Error {
  constructor(readonly status:number){super(`Source HTTP ${status}`);this.name='SourceHttpError';}
}
export function transientSourceError(error:unknown):boolean {
  return error instanceof SourceHttpError?[408,429,500,502,503,504].includes(error.status):
    error instanceof TypeError&&/fetch failed|network|terminated/i.test(error.message)||
    error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);
}
export async function retrySource<T>(operation:()=>Promise<T>,attempts=3,
  wait:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms))):Promise<T>{
  if(!Number.isInteger(attempts)||attempts<1||attempts>5)throw new Error('Invalid source retry limit.');
  for(let attempt=1;;attempt++){
    try{return await operation();}
    catch(error){if(attempt>=attempts||!transientSourceError(error))throw error;
      operationMetrics.add('sourceRetries');
      await wait(1000*2**(attempt-1));}
  }
}
