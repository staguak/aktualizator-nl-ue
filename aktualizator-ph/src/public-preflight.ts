import fs from 'node:fs';
import path from 'node:path';
import {runPool} from './concurrency.js';
import {fetchSourceFile,hasVerifiedSourceValidator,sourceVerificationHeadersAllowed} from './source-cache.js';
import {sourceAuditMode} from './source-audit.js';
import {officialImageRequest} from './official-image-source.js';
import type {LegalImageIndex} from './legal-images.js';

const hosts=['publications.europa.eu','eur-lex.europa.eu','repository.officiele-overheidspublicaties.nl','zoekservice.overheid.nl'];
const sruHost='zoekservice.overheid.nl';
const maxSruCatalogBytes=4_000_000;
type Result={status:'NO_CHANGE'|'CHANGED'|'UNKNOWN';checked:number};
interface ObservedRequest {requestedUrl:string;sha256:string;kind:string;verificationRequest?:{headers:Record<string,string>}|null}
class SourceChanged extends Error {}

function requestIdentity(entry:ObservedRequest):string{
  const url=new URL(entry.requestedUrl),headers=entry.verificationRequest?.headers;
  if(url.protocol!=='https:'||!hosts.includes(url.hostname)||url.username||url.password||url.port||
    !headers||!Object.keys(headers).length||!sourceVerificationHeadersAllowed(url,headers)||
    !/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Unverifiable prior source request.');
  return JSON.stringify([url.href,Object.entries(headers).sort(([a],[b])=>a.localeCompare(b,'en'))]);
}

function isSruCatalog(entry:ObservedRequest):boolean{
  const url=new URL(entry.requestedUrl);
  return entry.kind==='SRU-2.0'&&url.hostname===sruHost&&url.pathname==='/sru/Search'&&
    url.searchParams.get('operation')==='searchRetrieve'&&url.searchParams.get('version')==='2.0'&&
    url.searchParams.get('x-connection')==='BWB';
}

export async function verifyUnchangedSources(requests:ObservedRequest[],cache:string,fetcher:typeof fetch=fetch):Promise<Result>{
  if(!requests.length)return {status:'UNKNOWN',checked:0};
  const unique=new Map<string,ObservedRequest>();
  for(const request of requests){
    const key=requestIdentity(request),previous=unique.get(key);
    if(previous&&(previous.sha256!==request.sha256||previous.kind!==request.kind))return {status:'UNKNOWN',checked:0};
    unique.set(key,request);
  }
  const entries=[...unique.values()].map(entry=>({entry,catalog:isSruCatalog(entry)}));
  if(entries.some(({entry,catalog})=>!catalog&&!hasVerifiedSourceValidator(cache,entry.requestedUrl,entry.verificationRequest!.headers,entry.sha256)))
    return {status:'UNKNOWN',checked:0};
  let checked=0,changed=false,unknown=false;
  await runPool(entries,4,async({entry,catalog})=>{
    if(changed||unknown)return;
    try{
      const allowedHosts=entry.kind==='direct-image'?[new URL(entry.requestedUrl).hostname]:catalog?[sruHost]:hosts;
      const source=await fetchSourceFile(entry.requestedUrl,entry.verificationRequest!.headers,{
        cacheDir:cache,allowedHosts,timeoutMs:15_000,
        ...catalog?{maxBytes:maxSruCatalogBytes}:{},
        fetcher:async(url,options)=>{
          const response=await fetcher(url,options);
          if(response.status===200&&!catalog){
            await response.body?.cancel();
            throw new SourceChanged();
          }
          return response;
        }
      });
      const downloadedCatalog=catalog&&source.observation?.status===200;
      if(downloadedCatalog&&source.sha256!==entry.sha256)changed=true;
      else if(source.sha256!==entry.sha256||!downloadedCatalog&&source.observation?.status!==304)unknown=true;
      else checked++;
    }catch(error){
      if(error instanceof SourceChanged)changed=true;
      else unknown=true;
    }
  });
  return {status:unknown?'UNKNOWN':changed?'CHANGED':'NO_CHANGE',checked};
}

function directImageRequests(index:LegalImageIndex):ObservedRequest[]|undefined{
  if(index.profile!=='legal-images-v2'||!Array.isArray(index.sources)||index.unavailableImages?.length)return;
  const requests:ObservedRequest[]=[];
  for(const source of index.sources){
    if(source.resolution||source.derivation)return;
    try{
      const {url,headers,host}=officialImageRequest(source.requestUrl);
      if(!hosts.includes(host)||!/^[a-f0-9]{64}$/.test(source.sha256))return;
      requests.push({requestedUrl:url,sha256:source.sha256,kind:'direct-image',verificationRequest:{headers}});
    }catch{return;}
  }
  return requests;
}

export async function publicPreflight(state:string,cache:string,range:{rangeFrom:string;rangeTo:string;observedOn:string},fetcher:typeof fetch=fetch){
  if(sourceAuditMode()!=='conditional'||!fs.existsSync(path.join(state,'request.json')))return;
  const read=(name:string)=>JSON.parse(fs.readFileSync(path.join(state,name),'utf8'));
  const request=read('request.json');
  if(request.initialize||request.forceBuild||!request.previousSha||request.priorDirectory!=='prior')return;
  const previous=read('previous-publication.json');
  // Across a calendar boundary, a known legal date may change status even
  // when every network entity remains byte-identical.
  if(previous.profile!=='public-nl-eu-corpus-v2'||previous.rangeTo!==range.rangeTo||range.rangeTo!==range.observedOn||
    previous.rangeFrom!==range.rangeFrom||previous.executionSha256!==request.executionSha256||
    previous.configurationSha256!==request.configSha256)return;
  const entries:ObservedRequest[]=[];
  for(const module of ['NL','UE']){
    const manifest=read(`prior/${module}/manifest.json`);
    if(manifest.imagePackage){
      // The prior publication's inventory verifies the index before preflight.
      // Embedded bytes are covered by the original document's source receipt.
      const images=directImageRequests(read(`prior/${module}/IMAGE_INDEX.json`));
      if(!images)return;
      entries.push(...images);
    }
    for(const act of manifest.acts){
      const name=act.sourceArchive?.name;
      if(typeof name!=='string'||!/^\d+_[A-Za-z0-9_.-]+\.sources\.json$/.test(name))return;
      const catalog=read(`prior/${module}/${name}`);
      const observed:ObservedRequest[]=catalog.entries;
      if(observed.some(entry=>entry.verificationRequest===null)||
        !(module==='NL'?['SRU-2.0','BWB-WTI','BWB-Toestand']:['CELLAR-SPARQL']).every(kind=>
          observed.some(entry=>entry.kind===kind&&entry.verificationRequest)))return;
      entries.push(...observed.filter(entry=>entry.verificationRequest));
    }
  }
  const result=await verifyUnchangedSources(entries,cache,fetcher);
  if(result.status==='NO_CHANGE')fs.writeFileSync(path.join(state,'preflight.json'),JSON.stringify({
    ...result,previousSha:request.previousSha,rangeTo:range.rangeTo,executionSha256:request.executionSha256,
    configurationSha256:request.configSha256
  })+'\n',{flag:'wx'});
  return result;
}
