import {cssUrlMatches} from './css-url-rules.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {load} from 'cheerio';
import type {LegalManifest} from './legal-structure.js';
import {legalHash,extractLegalBody,validateLegalDocument,indexLegalDocument} from './legal-structure.js';
import {parseEuLegalStructure} from './eu-legal-structure.js';
import {decodeEmbeddedImage} from './eu-assets.js';
import type {EuImageLoader} from './eu-assets.js';
import {hash} from './release-store.js';
import {ImageUnavailableError,ImageValidationInfrastructureError,imageInfrastructureFailure} from './image-retrieval.js';
import type {ImageResolution,ImageAttempt,SvgDerivation} from './image-retrieval.js';
import {svgDerivative} from './svg-image-source.js';
import type {ImageRendering} from './inline-legal-images.js';
const root=fileURLToPath(new URL('../',import.meta.url));
export const IMAGE_INDEX='IMAGE_INDEX.json';
export const legalDocuments=(manifest:any):LegalManifest[]=>manifest.acts.flatMap((a:any)=>a.legalDocuments??a.documents?.flatMap((d:any)=>d.legalStructure?[d.legalStructure]:[])??[]);
export const imageIndexRows=(manifest:{imagePackage?:unknown}):string[]=>manifest.imagePackage?['','## Grafiki','',
  (manifest.imagePackage as {assets:unknown[]}).assets.length?'- [Katalog grafik](images/) — oryginalne formaty, bez konwersji.':'Grafiki: brak.',`- [Dokładne powiązania obrazów](${IMAGE_INDEX})`,'']:[];
interface Reference {index:number;offset:number;end:number;kind:'img'|'svg-image'|'inline-svg'|'css';source:string;rawSource?:string;decorativeHeaderFlag?:true}
interface NativeImage {format:string;contentType:string;extension:string;bytes:number;sha256:string;width?:number;height?:number}
export interface ImageOccurrence {
  documentId:string;version:string;language:string;sourceUrl:string;sourceSha256:string;
  markdownFile:string;markdownSha256:string;occurrence:number;offset:number;end:number;kind:Reference['kind'];referenceSha256:string;
  legalUnitId:string;sourceLocator:string;contextIds:string[];target:string;sourceEvidenceKey?:string;
}
interface ImageSourceEvidence {key:string;requestUrl:string;responseUrl:string;sha256:string;bytes:number;contentType:string;baseUrl?:string;resolution?:ImageResolution;derivation?:SvgDerivation}
const evidenceKey=(requestUrl:string,baseUrl?:string)=>legalHash(baseUrl?JSON.stringify([requestUrl,baseUrl]):requestUrl);
interface OmittedDecoration extends Omit<ImageOccurrence,'target'|'sourceEvidenceKey'> {reason:'decorative-european-flag';imageUrl:string}
interface UnavailableImage extends Omit<ImageOccurrence,'target'|'sourceEvidenceKey'> {reason:'source-unavailable';imageUrl:string;attempts:ImageAttempt[]}
export interface LegalImageIndex {profile:'legal-images-v1';offsetEncoding:'utf16-code-units';assets:({name:string}&NativeImage)[];occurrences:ImageOccurrence[];sources:ImageSourceEvidence[];omittedDecorations?:OmittedDecoration[];unavailableImages?:UnavailableImage[];rendering?:ImageRendering}
const codecCache=new Map<string,NativeImage>();
export function verifyNativeImage(bytes:Uint8Array):NativeImage{
  const sha256=hash(bytes),known=codecCache.get(sha256);if(known)return known;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'legal-image-'));
  try{
    const source=path.join(temp,'source');fs.writeFileSync(source,bytes);
    const result=spawnSync(process.env.LAW_IMAGE_PYTHON??process.env.LAW_XML_PYTHON??'python3',['scripts/validate_image.py',source],
      {cwd:root,encoding:'utf8',timeout:60_000,maxBuffer:10000,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});
    if(result.error||result.signal||result.status===null||result.status===2)throw new ImageValidationInfrastructureError('Native image validation infrastructure unavailable.');
    if(result.status!==0)throw new Error('Native image decode/validation failed; image runtime or source requires attention.');
    const native=JSON.parse(result.stdout) as NativeImage;
    if(native.sha256!==sha256||native.bytes!==bytes.byteLength||!/^image\/[a-z0-9.+-]+$/.test(native.contentType)||!/^[a-z0-9]+$/.test(native.extension))throw new Error('Invalid native image verification receipt.');
    codecCache.set(sha256,native);return native;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
export function legalImageReferences(body:string):Reference[]{
  const $=load(body,{sourceCodeLocationInfo:true},false),result:Omit<Reference,'index'>[]=[];
  $('*').filter((_i,node)=>'tagName' in node&&['img','image','feimage','use','svg'].includes(node.tagName.toLowerCase())).each((_i,node)=>{
    if(!('tagName' in node))return;
    const loc=(node as any).sourceCodeLocation;if(!loc)throw new Error('Image lacks an exact source location.');
    const kind=node.tagName==='svg'?'inline-svg':node.tagName==='img'?'img':'svg-image';
    const rawSource=kind==='inline-svg'?body.slice(loc.startOffset,loc.endOffset):undefined;
    let svg=rawSource;
    if(svg){
      if(!/^<svg\b[^>]*\sxmlns=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns="http://www.w3.org/2000/svg"');
      if(svg.includes('xlink:')&&!/^<svg\b[^>]*\sxmlns:xlink=/.test(svg))svg=svg.replace(/^<svg\b/,'<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    const source=kind==='inline-svg'?'data:image/svg+xml;base64,'+Buffer.from(svg!).toString('base64'):
      $(node).attr(kind==='img'?'src':'href')??$(node).attr('xlink:href');
    if(!source)throw new Error('Image source missing.');
    if(kind==='svg-image'&&source.startsWith('#'))return;
    const header=$(node).closest('table');
    const decorativeHeaderFlag=kind==='img'&&/^European flag$/i.test(($(node).attr('alt')??'').trim())&&
      ['Official Journal of the European Union','Dziennik Urzędowy Unii Europejskiej','Publicatieblad van de Europese Unie',
        'Journal officiel de l’Union européenne',"Journal officiel de l'Union européenne"].includes(header.find('.oj-hd-ti').text().replace(/\s+/g,' ').trim());
    result.push({kind,offset:loc.startOffset,end:loc.endOffset,source,...rawSource?{rawSource}:{},...decorativeHeaderFlag?{decorativeHeaderFlag:true as const}:{}});
  });
  $('style,[style]').each((_i,node)=>{
    const loc=(node as any).sourceCodeLocation;if(!loc)return;
    const text=node.tagName==='style'?$(node).text():$(node).attr('style')??'';
    for(const match of cssUrlMatches(text)){
      const source=match.source;
      const prefix=text.slice(0,match.start),open=prefix.lastIndexOf('{'),closed=prefix.lastIndexOf('}');
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
function omittedDecoration(doc:LegalManifest,file:string,markdown:string,ref:Reference):OmittedDecoration|undefined{
  if(doc.corpus!=='EU'||!ref.decorativeHeaderFlag)return;
  const url=new URL(ref.source,doc.sourceUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.search||
    !['publications.europa.eu','eur-lex.europa.eu'].includes(url.hostname)||!url.pathname.endsWith('/europeanflag.gif'))return;
  const {sourceEvidenceKey:_,...record}=identity(doc,file,markdown,ref);
  // An image in an article/annex or another substantive legal unit is never
  // exempted merely because its file name or alt text resembles a header flag.
  if(record.contextIds.some(id=>!['version','table','image','other'].includes(doc.units.find(u=>u.id===id)!.kind)))return;
  return {...record,reason:'decorative-european-flag',imageUrl:url.href};
}
function unavailableIdentity(doc:LegalManifest,file:string,markdown:string,ref:Reference){
  const {sourceEvidenceKey:_,...record}=identity(doc,file,markdown,ref);
  return {...record,reason:'source-unavailable' as const,imageUrl:new URL(ref.source,doc.sourceUrl).href};
}
export async function buildLegalImagePackage(documents:LegalManifest[],read:(name:string)=>string,loader?:EuImageLoader):Promise<{index:LegalImageIndex;assets:Map<string,Buffer>}>{
  for(const doc of documents)validateLegalDocument(doc,name=>extractLegalBody(read(name)));
  const assets=new Map<string,Buffer>(),nativeAssets=new Map<string,LegalImageIndex['assets'][number]>(),occurrences:ImageOccurrence[]=[];
  const sources=new Map<string,ImageSourceEvidence>();
  const omittedDecorations:OmittedDecoration[]=[];
  const unavailableImages:UnavailableImage[]=[];
  const loaded=new Map<string,ReturnType<EuImageLoader>>();
  const shared:EuImageLoader=async(url,context)=>{
    const key=evidenceKey(url,url.startsWith('data:')?context?.document.sourceUrl:undefined);
    let value=loaded.get(key);
    if(!value){if(!loader)throw new Error('Image loader required.');value=Promise.resolve().then(()=>loader(url,context));loaded.set(key,value);}
    try{return await value;}
    catch(error){if(loaded.get(key)===value)loaded.delete(key);throw error;}
  };
  for(const doc of documents)for(const part of doc.parts){
    const markdown=read(part.file),body=extractLegalBody(markdown);
    for(const ref of legalImageReferences(body)){
      const omission=omittedDecoration(doc,part.file,markdown,ref);
      if(omission){omittedDecorations.push(omission);continue;}
      let response;
      try{
        try{response=decodeEmbeddedImage(ref.source);if(response){const native=verifyNativeImage(response.bytes);
          if(ref.kind!=='inline-svg'&&native.format==='SVG'&&legalImageReferences(Buffer.from(response.bytes).toString('utf8')).some(r=>r.kind!=='inline-svg'&&!r.source.startsWith('#')))response=undefined;
        }}
        catch(error){if(imageInfrastructureFailure(error))throw error;response=undefined;}
        response??=await shared(new URL(ref.source,doc.sourceUrl).href,{document:doc,sourceLocator:identity(doc,part.file,markdown,ref).sourceLocator,kind:ref.kind});
      }
      catch(error){if(!(error instanceof ImageUnavailableError))throw error;unavailableImages.push({...unavailableIdentity(doc,part.file,markdown,ref),attempts:error.attempts});continue;}
      const bytes=Buffer.from(response.bytes);
      const native=verifyNativeImage(bytes),target=`images/${native.sha256}.${native.extension}`;
      let sourceEvidenceKey:string|undefined;
      if(!/^data:/i.test(ref.source)||response.resolution||response.derivation){
        const requestUrl=new URL(ref.source,doc.sourceUrl).href,baseUrl=requestUrl.startsWith('data:')?doc.sourceUrl:undefined;
        sourceEvidenceKey=evidenceKey(requestUrl,baseUrl);sources.set(sourceEvidenceKey,{key:sourceEvidenceKey,requestUrl,responseUrl:response.url??doc.sourceUrl,sha256:native.sha256,bytes:bytes.length,contentType:response.contentType,...baseUrl?{baseUrl}:{},...response.resolution?{resolution:response.resolution}:{},...response.derivation?{derivation:response.derivation}:{}});
      }
      assets.set(target,bytes);nativeAssets.set(target,{name:target,...native});occurrences.push({...identity(doc,part.file,markdown,ref),...sourceEvidenceKey?{sourceEvidenceKey}:{},target});
    }
  }
  const index:LegalImageIndex={profile:'legal-images-v1',offsetEncoding:'utf16-code-units',assets:[...nativeAssets.values()].sort((a,b)=>a.name.localeCompare(b.name)),occurrences,sources:[...sources.values()].sort((a,b)=>a.key.localeCompare(b.key)),omittedDecorations,unavailableImages};
  validateLegalImagePackage(documents,read,index,name=>assets.get(name)!);
  return {index,assets};
}
export function validateLegalImagePackage(documents:LegalManifest[],read:(name:string)=>string,index:LegalImageIndex,readAsset:(name:string)=>Uint8Array):void{
  if(index.profile!=='legal-images-v1'||index.offsetEncoding!=='utf16-code-units'||!Array.isArray(index.assets)||!Array.isArray(index.occurrences)||!Array.isArray(index.sources))throw new Error('Invalid image index.');
  if(index.omittedDecorations!==undefined&&!Array.isArray(index.omittedDecorations))throw new Error('Invalid decorative image omissions.');
  if(index.unavailableImages!==undefined&&!Array.isArray(index.unavailableImages))throw new Error('Invalid unavailable images.');
  const sources=new Map<string,ImageSourceEvidence>();
  for(const source of index.sources){
    if(source.key!==evidenceKey(source.requestUrl,source.baseUrl)||sources.has(source.key)||! /^[a-f0-9]{64}$/.test(source.sha256)||!Number.isSafeInteger(source.bytes)||source.bytes<1)throw new Error('Invalid image source evidence.');
    for(const value of [source.requestUrl,source.responseUrl,...source.baseUrl?[source.baseUrl]:[]]){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)&&!(value===source.requestUrl&&url.protocol==='data:'&&(source.resolution||source.derivation))||url.username||url.password)throw new Error('Invalid image source URL.');}
    if(source.derivation){const bytes=svgDerivative(source.derivation);if(hash(bytes)!==source.sha256||bytes.length!==source.bytes||source.contentType!=='image/svg+xml'||source.derivation.responseUrl!==source.responseUrl)throw new Error('SVG derivation differs from source evidence.');}
    if(source.resolution){
      const p=source.resolution,bytes=Buffer.from(p.sourceDocumentBase64,'base64'),url=new URL(p.sourceUrl);
      if(bytes.toString('base64')!==p.sourceDocumentBase64||hash(bytes)!==p.sourceSha256||url.protocol!=='https:'||url.port||url.username||url.password||
        !['publications.europa.eu','eur-lex.europa.eu'].includes(url.hostname)||!['EN','PL','NL','FR'].includes(p.language)||
        !Array.isArray(p.attempts)||p.attempts.at(-1)?.outcome!=='AVAILABLE'||p.attempts.at(-1)?.language!==p.language||
        p.attempts.slice(0,-1).some(a=>a.outcome!=='UNAVAILABLE')||new Set(p.attempts.map(a=>a.language)).size!==p.attempts.length)throw new Error('Invalid image language/source proof.');
    }
    sources.set(source.key,source);
  }
  const assets=new Map<string,Uint8Array>();
  for(const asset of index.assets){
    if(!/^images\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.name)||assets.has(asset.name))throw new Error('Unsafe or duplicate image.');
    const bytes=readAsset(asset.name),native=verifyNativeImage(bytes);
    if(!isDeepStrictEqual(asset,{name:asset.name,...native})||asset.name!==`images/${native.sha256}.${native.extension}`)throw new Error('Image bytes/format differ from index.');
    assets.set(asset.name,bytes);
  }
  let cursor=0,omittedCursor=0,unavailableCursor=0;const used=new Set<string>(),usedSources=new Set<string>();
  for(const doc of documents)for(const part of doc.parts){
    const markdown=read(part.file),body=extractLegalBody(markdown);
    for(const ref of legalImageReferences(body)){
      const omission=index.omittedDecorations===undefined?undefined:omittedDecoration(doc,part.file,markdown,ref);
      if(omission){
        if(!isDeepStrictEqual(omission,index.omittedDecorations![omittedCursor++]))throw new Error('Decorative image omission/context mismatch.');
        continue;
      }
      const gap=index.unavailableImages?.[unavailableCursor];
      if(gap&&gap.markdownFile===part.file&&gap.offset===ref.offset&&gap.occurrence===ref.index&&gap.documentId===doc.documentId&&gap.version===doc.version&&gap.language===doc.language){
        const {attempts,...record}=gap;
        if(!isDeepStrictEqual(record,unavailableIdentity(doc,part.file,markdown,ref))||!Array.isArray(attempts)||!attempts.length||
          attempts.some(a=>a.outcome!=='UNAVAILABLE'||!a.reason)||new Set(attempts.map(a=>a.language)).size!==attempts.length||
          (doc.corpus==='EU'&&['EN','PL','NL','FR'].some(l=>!attempts.some(a=>a.language===l))))throw new Error('Unproven image unavailability.');
        unavailableCursor++;continue;
      }
      const occurrence=index.occurrences[cursor++];if(!occurrence)throw new Error('Missing image occurrence.');
      const {target,...record}=occurrence,proof=record.sourceEvidenceKey?sources.get(record.sourceEvidenceKey):undefined;
      const expected=identity(doc,part.file,markdown,ref);
      if(proof?.resolution||proof?.derivation)expected.sourceEvidenceKey=evidenceKey(new URL(ref.source,doc.sourceUrl).href,proof.baseUrl);
      if(proof?.baseUrl&&proof.baseUrl!==doc.sourceUrl)throw new Error('Embedded SVG source context differs.');
      if(!isDeepStrictEqual(expected,record)||!assets.has(target))throw new Error('Image context/index mismatch.');
      let embedded;try{embedded=decodeEmbeddedImage(ref.source);}catch{if(!proof?.resolution)throw new Error('Invalid embedded image without fallback proof.');}
      if(embedded&&!proof?.resolution&&!Buffer.from(embedded.bytes).equals(proof?.derivation?Buffer.from(proof.derivation.originalBase64,'base64'):Buffer.from(assets.get(target)!)))throw new Error('Embedded image does not match original bytes.');
      if(!embedded||proof?.resolution||proof?.derivation){
        const evidence=record.sourceEvidenceKey?sources.get(record.sourceEvidenceKey):undefined,bytes=assets.get(target)!;
        if(!evidence||evidence.sha256!==hash(bytes)||evidence.bytes!==bytes.byteLength)throw new Error('External image mapping differs from downloaded source evidence.');
        usedSources.add(evidence.key);
      }
      if(proof?.derivation&&proof.derivation.requestUrl!==(proof.resolution?.attempts.at(-1)?.url??proof.requestUrl))throw new Error('SVG original request identity differs.');
      if(proof?.resolution){
        const p=proof.resolution;
        if(doc.corpus!=='EU'||p.documentId!==doc.documentId||p.version!==doc.version)throw new Error('Fallback image document/version mismatch.');
        const draft=parseEuLegalStructure(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(p.sourceDocumentBase64,'base64')),{corpus:'EU',documentId:p.documentId,version:p.version,language:p.language,sourceUrl:p.sourceUrl,sourceSha256:p.sourceSha256});
        const indexed=indexLegalDocument(draft,draft.chunks.map((_,i)=>'proof-'+i+'.md'),draft.chunks.map(c=>c.body));
        const refs=draft.chunks.flatMap((chunk,i)=>legalImageReferences(chunk.body).filter(r=>r.kind===ref.kind).filter(r=>indexed.units.filter(u=>u.locations.some(l=>l.part===i+1&&l.start<=r.offset&&l.end>=r.end)).at(-1)?.sourceLocator===p.sourceLocator));
        if(refs.length!==1)throw new Error('Fallback image location differs from preserved original.');
        const decoded=decodeEmbeddedImage(refs[0].source);
        if(p.attempts.at(-1)!.url!==(decoded?p.sourceUrl:new URL(refs[0].source,p.sourceUrl).href)||decoded&&hash(decoded.bytes)!==(proof.derivation?.originalSha256??proof.sha256))throw new Error('Fallback image differs from preserved representation.');
      }
      used.add(target);
    }
  }
  if(cursor!==index.occurrences.length||omittedCursor!==(index.omittedDecorations?.length??0)||unavailableCursor!==(index.unavailableImages?.length??0)||used.size!==assets.size||usedSources.size!==sources.size)throw new Error('Image index is incomplete or contains unreferenced images.');
}
