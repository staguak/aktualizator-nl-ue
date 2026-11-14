import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {assertEuAssetIntegrity,htmlIntegrity} from './content-integrity.js';
import type {EuImageOccurrence} from './content-integrity.js';

export interface EuBinaryAsset {name:string;bytes:Buffer;sha256:string;contentType:string;sourceUrl:string}
export interface EuImageResponse {bytes:Uint8Array;contentType:string;url?:string}
export type EuImageLoader=(url:string)=>Promise<EuImageResponse>;
export interface EuAssetExtraction {
  /** Compatibility name: this is the byte-for-byte unchanged input markup. */
  derivedHtml:string;documentSha256:string;assets:EuBinaryAsset[];occurrences:EuImageOccurrence[];
}

const extensions:Record<string,string>={
  'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg',
  'image/avif':'avif','image/tiff':'tif','image/bmp':'bmp','image/x-icon':'ico','image/vnd.microsoft.icon':'ico',
};
function mime(value:string):string{
  const contentType=value.split(';',1)[0].trim().toLowerCase();
  if(!extensions[contentType])throw new Error('Unsupported EU image content type.');
  return contentType;
}
export function decodeEmbeddedImage(source:string):EuImageResponse|undefined {
  if(!/^data:/i.test(source))return;
  const match=/^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),(.*)$/is.exec(source);
  if(!match)throw new Error('Invalid embedded EU image.');
  const contentType=mime(match[1]);let bytes:Buffer;
  if(/(?:^|;)base64(?:;|$)/i.test(match[2])){
    const encoded=match[3].replace(/[\t\r\n ]/g,'');
    if(!encoded||encoded.length%4===1||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.includes('=')&&encoded.length%4!==0)
      throw new Error('Invalid Base64 EU image.');
    bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,''))throw new Error('Invalid Base64 EU image padding.');
  }else{
    const parts:Buffer[]=[];
    for(const token of match[3].matchAll(/%[0-9a-f]{2}|[^%]+|%/gi)){
      if(token[0]==='%')throw new Error('Invalid encoded EU image.');
      parts.push(token[0][0]==='%'?Buffer.from([Number.parseInt(token[0].slice(1),16)]):Buffer.from(token[0],'utf8'));
    }
    bytes=Buffer.concat(parts);
  }
  if(!bytes.length)throw new Error('Empty EU image.');
  return {bytes,contentType};
}

/** Extract sidecars only: neither original sources nor validated Markdown is
 * rewritten. Every image needs resolved bytes; network policy is in the loader. */
export async function extractEuAssets(html:string,sourceUrl:string,loader?:EuImageLoader):Promise<EuAssetExtraction>{
  const $=load(html),images=$('body img').toArray();
  const assets=new Map<string,EuBinaryAsset>(),occurrences:EuImageOccurrence[]=[];
  const loaded=new Map<string,Promise<EuImageResponse>>();
  for(const [index,image] of images.entries()){
    const source=$(image).attr('src');if(!source)throw new Error('EU image source is required.');
    let response=decodeEmbeddedImage(source),resolved=response?sourceUrl:source;
    if(!response){
      let url:URL;try{url=new URL(source,sourceUrl);}catch{throw new Error('Invalid EU image URL.');}
      if(!['https:','http:'].includes(url.protocol))throw new Error('Unsupported EU image URL.');
      if(!loader)throw new Error('An image loader is required for unresolved EU image references.');
      if(url.username||url.password)throw new Error('Credentials are forbidden in EU image URLs.');
      resolved=url.href;let pending=loaded.get(resolved);
      if(!pending){pending=loader(resolved);loaded.set(resolved,pending);}response=await pending;
    }
    const bytes=Buffer.from(response.bytes),contentType=mime(response.contentType);
    if(!bytes.length)throw new Error('Empty EU image.');
    const sha256=createHash('sha256').update(bytes).digest('hex'),name=`images/${sha256}.${extensions[contentType]}`;
    const known=assets.get(name);
    if(known&&!known.bytes.equals(bytes))throw new Error('EU image content-address collision.');
    if(!known)assets.set(name,{name,bytes,sha256,contentType,sourceUrl:response.url??resolved});
    occurrences.push({index,source,target:name,sha256,size:bytes.length,contentType});
  }
  assertEuAssetIntegrity(htmlIntegrity(html),html,occurrences,name=>{
    const asset=assets.get(name);if(!asset)throw new Error('Missing extracted EU image.');return asset.bytes;
  });
  return {derivedHtml:html,documentSha256:createHash('sha256').update(html).digest('hex'),assets:[...assets.values()].sort((a,b)=>a.name.localeCompare(b.name)),occurrences};
}
