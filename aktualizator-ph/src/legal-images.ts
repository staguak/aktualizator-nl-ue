import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {load} from 'cheerio';
import type {LegalManifest} from './legal-structure.js';
import {legalHash,extractLegalBody,validateLegalDocument} from './legal-structure.js';
import {decodeEmbeddedImage} from './eu-assets.js';
import type {EuImageLoader} from './eu-assets.js';
import {hash} from './release-store.js';
const root=fileURLToPath(new URL('../',import.meta.url));
export const IMAGE_INDEX='IMAGE_INDEX.json';
export const legalDocuments=(manifest:any):LegalManifest[]=>manifest.acts.flatMap((a:any)=>a.legalDocuments??a.documents?.flatMap((d:any)=>d.legalStructure?[d.legalStructure]:[])??[]);
export const imageIndexRows=(manifest:{imagePackage?:unknown}):string[]=>manifest.imagePackage?['','## Grafiki','',
  (manifest.imagePackage as {assets:unknown[]}).assets.length?'- [Katalog grafik](images/) — oryginalne formaty, bez konwersji.':'Grafiki: brak.',`- [Dokładne powiązania obrazów](${IMAGE_INDEX})`,'']:[];
interface Reference {index:number;offset:number;end:number;kind:'img'|'svg-image'|'inline-svg'|'css';source:string;rawSource?:string}
interface NativeImage {format:string;contentType:string;extension:string;bytes:number;sha256:string;width?:number;height?:number}
export interface ImageOccurrence {
  documentId:string;version:string;language:string;sourceUrl:string;sourceSha256:string;
  markdownFile:string;markdownSha256:string;occurrence:number;offset:number;end:number;kind:Reference['kind'];referenceSha256:string;
  legalUnitId:string;sourceLocator:string;contextIds:string[];target:string;sourceEvidenceKey?:string;
}
interface ImageSourceEvidence {key:string;requestUrl:string;responseUrl:string;sha256:string;bytes:number;contentType:string}
export interface LegalImageIndex {profile:'legal-images-v1';offsetEncoding:'utf16-code-units';assets:({name:string}&NativeImage)[];occurrences:ImageOccurrence[];sources:ImageSourceEvidence[]}
const codecCache=new Map<string,NativeImage>();
export function verifyNativeImage(bytes:Uint8Array):NativeImage{
  const sha256=hash(bytes),known=codecCache.get(sha256);if(known)return known;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'legal-image-'));
  try{
    const source=path.join(temp,'source');fs.writeFileSync(source,bytes);
    const result=spawnSync(process.env.LAW_IMAGE_PYTHON??process.env.LAW_XML_PYTHON??'python3',['scripts/validate_image.py',source],
      {cwd:root,encoding:'utf8',timeout:60_000,maxBuffer:10000,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});
    if(result.error||result.status!==0)throw new Error('Native image decode/validation failed; image runtime or source requires attention.');
    const native=JSON.parse(result.stdout) as NativeImage;
    if(native.sha256!==sha256||native.bytes!==bytes.byteLength||!/^image\/[a-z0-9.+-]+$/.test(native.contentType)||!/^[a-z0-9]+$/.test(native.extension))throw new Error('Invalid native image verification receipt.');
    codecCache.set(sha256,native);return native;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function references(body:string):Reference[]{
  const $=load(body,{sourceCodeLocationInfo:true},false),result:Omit<Reference,'index'>[]=[];
  $('img,image,svg').each((_i,node)=>{
    const loc=(node as any).sourceCodeLocation;if(!loc)throw new Error('Image lacks an exact source location.');
    const kind=node.tagName==='svg'?'inline-svg':node.tagName==='image'?'svg-image':'img';
    const rawSource=kind==='inline-svg'?body.slice(loc.startOffset,loc.endOffset):undefined;
    let svg=rawSource;
    if(svg){
      if(!/^<svg\b[^>]*\sxmlns=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns="http://www.w3.org/2000/svg"');
      if(svg.includes('xlink:')&&!/^<svg\b[^>]*\sxmlns:xlink=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    const source=kind==='inline-svg'?'data:image/svg+xml;base64,'+Buffer.from(svg!).toString('base64'):
      $(node).attr(kind==='img'?'src':'href')??$(node).attr('xlink:href');
    if(!source)throw new Error('Image source missing.');
    result.push({kind,offset:loc.startOffset,end:loc.endOffset,source,...rawSource?{rawSource}:{}});
  });
  $('style,[style]').each((_i,node)=>{
    const loc=(node as any).sourceCodeLocation;if(!loc)return;
    const text=node.tagName==='style'?$(node).text():$(node).attr('style')??'';
    for(const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)){
      const source=match[1]??match[2]??match[3];
      const prefix=text.slice(0,match.index),open=prefix.lastIndexOf('{'),closed=prefix.lastIndexOf('}');
      const scope=open>closed?prefix.slice(closed+1,open):prefix.slice(prefix.lastIndexOf(';')+1);
      if(source.startsWith('#')||/@font-face\b/i.test(scope)||/^\s*@import\b/i.test(scope))continue;
      result.push({kind:'css',offset:loc.startOffset,end:loc.endOffset,source});
    }
  });
  return result.sort((a,b)=>a.offset-b.offset||a.end-b.end||a.source.localeCompare(b.source)).map((ref,index)=>({...ref,index}));
}
function identity(doc:LegalManifest,file:string,markdown:string,ref:Reference):Omit<ImageOccurrence,'target'>{
  const containing=doc.units.filter(u=>u.locations.some(l=>l.file===file&&l.start<=ref.offset&&l.end>=ref.end));
  const unit=containing.at(-1);if(!unit)throw new Error('Image has no indexed legal context.');
  const contextIds:string[]=[];const units=new Map(doc.units.map(u=>[u.id,u]));let current:typeof unit|undefined=unit;
  while(current){contextIds.unshift(current.id);current=current.parentId?units.get(current.parentId):undefined;}
  return {documentId:doc.documentId,version:doc.version,language:doc.language,sourceUrl:doc.sourceUrl,sourceSha256:doc.sourceSha256,
    markdownFile:file,markdownSha256:legalHash(markdown),occurrence:ref.index,offset:ref.offset,end:ref.end,kind:ref.kind,referenceSha256:legalHash(ref.rawSource??ref.source),
    ...!/^data:/i.test(ref.source)?{sourceEvidenceKey:legalHash(new URL(ref.source,doc.sourceUrl).href)}:{},
    legalUnitId:unit.id,sourceLocator:unit.sourceLocator,contextIds};
}
export async function buildLegalImagePackage(documents:LegalManifest[],read:(name:string)=>string,loader?:EuImageLoader):Promise<{index:LegalImageIndex;assets:Map<string,Buffer>}>{
  for(const doc of documents)validateLegalDocument(doc,name=>extractLegalBody(read(name)));
  const assets=new Map<string,Buffer>(),nativeAssets=new Map<string,LegalImageIndex['assets'][number]>(),occurrences:ImageOccurrence[]=[];
  const sources=new Map<string,ImageSourceEvidence>();
  const loaded=new Map<string,ReturnType<EuImageLoader>>();
  const shared:EuImageLoader=async url=>{let value=loaded.get(url);if(!value){if(!loader)throw new Error('Image loader required.');value=loader(url);loaded.set(url,value);}return value;};
  for(const doc of documents)for(const part of doc.parts){
    const markdown=read(part.file),body=extractLegalBody(markdown);
    for(const ref of references(body)){
      const response=decodeEmbeddedImage(ref.source)??await shared(new URL(ref.source,doc.sourceUrl).href),bytes=Buffer.from(response.bytes);
      const native=verifyNativeImage(bytes),target=`images/${native.sha256}.${native.extension}`;
      if(!/^data:/i.test(ref.source)){
        const requestUrl=new URL(ref.source,doc.sourceUrl).href,response=await loaded.get(requestUrl)!;
        const key=legalHash(requestUrl);sources.set(key,{key,requestUrl,responseUrl:response.url??requestUrl,sha256:native.sha256,bytes:bytes.length,contentType:response.contentType});
      }
      assets.set(target,bytes);nativeAssets.set(target,{name:target,...native});occurrences.push({...identity(doc,part.file,markdown,ref),target});
    }
  }
  const index:LegalImageIndex={profile:'legal-images-v1',offsetEncoding:'utf16-code-units',assets:[...nativeAssets.values()].sort((a,b)=>a.name.localeCompare(b.name)),occurrences,sources:[...sources.values()].sort((a,b)=>a.key.localeCompare(b.key))};
  validateLegalImagePackage(documents,read,index,name=>assets.get(name)!);
  return {index,assets};
}
export function validateLegalImagePackage(documents:LegalManifest[],read:(name:string)=>string,index:LegalImageIndex,readAsset:(name:string)=>Uint8Array):void{
  if(index.profile!=='legal-images-v1'||index.offsetEncoding!=='utf16-code-units'||!Array.isArray(index.assets)||!Array.isArray(index.occurrences)||!Array.isArray(index.sources))throw new Error('Invalid image index.');
  const sources=new Map<string,ImageSourceEvidence>();
  for(const source of index.sources){
    if(source.key!==legalHash(source.requestUrl)||sources.has(source.key)||! /^[a-f0-9]{64}$/.test(source.sha256)||!Number.isSafeInteger(source.bytes)||source.bytes<1)throw new Error('Invalid image source evidence.');
    for(const value of [source.requestUrl,source.responseUrl]){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid image source URL.');}
    sources.set(source.key,source);
  }
  const assets=new Map<string,Uint8Array>();
  for(const asset of index.assets){
    if(!/^images\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.name)||assets.has(asset.name))throw new Error('Unsafe or duplicate image.');
    const bytes=readAsset(asset.name),native=verifyNativeImage(bytes);
    if(!isDeepStrictEqual(asset,{name:asset.name,...native})||asset.name!==`images/${native.sha256}.${native.extension}`)throw new Error('Image bytes/format differ from index.');
    assets.set(asset.name,bytes);
  }
  let cursor=0;const used=new Set<string>(),usedSources=new Set<string>();
  for(const doc of documents)for(const part of doc.parts){
    const markdown=read(part.file),body=extractLegalBody(markdown);
    for(const ref of references(body)){
      const occurrence=index.occurrences[cursor++];if(!occurrence)throw new Error('Missing image occurrence.');
      const {target,...record}=occurrence;
      if(!isDeepStrictEqual(identity(doc,part.file,markdown,ref),record)||!assets.has(target))throw new Error('Image context/index mismatch.');
      const embedded=decodeEmbeddedImage(ref.source);
      if(embedded&&!Buffer.from(embedded.bytes).equals(Buffer.from(assets.get(target)!)))throw new Error('Embedded image does not match original bytes.');
      if(!embedded){
        const evidence=record.sourceEvidenceKey?sources.get(record.sourceEvidenceKey):undefined,bytes=assets.get(target)!;
        if(!evidence||evidence.sha256!==hash(bytes)||evidence.bytes!==bytes.byteLength)throw new Error('External image mapping differs from downloaded source evidence.');
        usedSources.add(evidence.key);
      }
      used.add(target);
    }
  }
  if(cursor!==index.occurrences.length||used.size!==assets.size||usedSources.size!==sources.size)throw new Error('Image index is incomplete or contains unreferenced images.');
}
