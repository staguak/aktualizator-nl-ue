import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {safeCacheDirectory} from './cache-directory.js';
import {operationMetrics} from './operation-metrics.js';
import {sourceAuditMode} from './source-audit.js';

export interface SourceObservation {
  retrievedAt:string|null;checkedAt:string;status:200|304;
  method:'downloaded'|'conditional-not-modified';
  redirects?:{from:string;status:number;location:string;requested:string}[];
}
export interface BinarySource {bytes:Buffer;url:string;contentType:string;observation?:SourceObservation}
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
  const finish=operationMetrics.beginSourceTransfer();
  try{return await fetchBinarySourceEntity(url,headers,options);}
  finally{finish();}
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
