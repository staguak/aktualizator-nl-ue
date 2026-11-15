import {load} from 'cheerio';
import {decodeEmbeddedImage} from './eu-assets.js';
import type {EuImageResponse,EuImageLoader} from './eu-assets.js';
import {legalImageReferences,verifyNativeImage} from './legal-images.js';
import type {LegalImageIndex} from './legal-images.js';
import {renderBase64Markdown} from './inline-legal-images.js';
import {LEGAL_START,LEGAL_END,extractLegalBody} from './legal-structure.js';
import type {SvgDerivation,SvgResource} from './image-retrieval.js';
import {hash} from './release-store.js';

function resources(bytes:Uint8Array){
  return legalImageReferences(Buffer.from(bytes).toString('utf8')).filter(r=>r.kind!=='inline-svg'&&!r.source.startsWith('#'));
}
/** Preserve the fetched SVG separately while embedding every image dependency
 * into a reversible derivative. No raster/vector format conversion is involved. */
export async function prepareSvgImage(response:EuImageResponse,requestUrl:string,baseUrl:string,load:EuImageLoader,stack:string[]=[]):Promise<EuImageResponse>{
  if(verifyNativeImage(response.bytes).format!=='SVG')return response;
  const key=requestUrl.startsWith('data:')?requestUrl+'@'+baseUrl:new URL(requestUrl).href;
  if(stack.includes(key)||stack.length>=8)throw new Error('Cyclic or excessive SVG dependency graph.');
  const refs=resources(response.bytes);if(!refs.length)return response;
  const base=response.url??baseUrl,children:SvgResource[]=[];
  for(const ref of refs){
    const embedded=decodeEmbeddedImage(ref.source),target=embedded?ref.source:new URL(ref.source,base).href;
    const original=embedded??await load(target),child=await prepareSvgImage(original,target,base,load,[...stack,key]);
    const bytes=Buffer.from(child.bytes),native=verifyNativeImage(bytes);
    children.push({index:ref.index,source:ref.source,requestUrl:target,responseUrl:child.url??base,contentType:native.contentType,sha256:native.sha256,base64:bytes.toString('base64'),...child.derivation?{derivation:child.derivation}:{}});
  }
  const original=Buffer.from(response.bytes),derivation:SvgDerivation={profile:'self-contained-svg-v1',requestUrl,responseUrl:base,originalBase64:original.toString('base64'),originalSha256:hash(original),resources:children};
  const bytes=svgDerivative(derivation);
  return {bytes,contentType:'image/svg+xml',url:response.url??base,derivation};
}
/** Deterministic reconstruction doubles as a verifier; no network is used. */
export function svgDerivative(proof:SvgDerivation,depth=0):Buffer{
  if(proof.profile!=='self-contained-svg-v1'||depth>8||!Array.isArray(proof.resources))throw new Error('Invalid SVG derivation proof.');
  const original=Buffer.from(proof.originalBase64,'base64');
  if(original.toString('base64')!==proof.originalBase64||hash(original)!==proof.originalSha256||verifyNativeImage(original).format!=='SVG')throw new Error('SVG original bytes differ from proof.');
  const body=original.toString('utf8'),refs=legalImageReferences(body),required=resources(original),assetBytes=new Map<string,Buffer>();
  if(required.length!==proof.resources.length)throw new Error('SVG resource proof is incomplete.');
  const index:LegalImageIndex={profile:'legal-images-v1',offsetEncoding:'utf16-code-units',assets:[],occurrences:[],sources:[]};
  for(const ref of refs){
    let bytes:Buffer;
    if(ref.kind==='inline-svg')bytes=Buffer.from(decodeEmbeddedImage(ref.source)!.bytes);
    else if(ref.source.startsWith('#'))continue;
    else{
      const candidates=proof.resources.filter(r=>r.index===ref.index&&r.source===ref.source);
      if(candidates.length!==1)throw new Error('SVG dependency identity differs.');
      const resource=candidates[0];bytes=Buffer.from(resource.base64,'base64');
      if(bytes.toString('base64')!==resource.base64||hash(bytes)!==resource.sha256||verifyNativeImage(bytes).contentType!==resource.contentType)throw new Error('SVG dependency bytes differ.');
      if(resource.derivation&&(resource.derivation.requestUrl!==resource.requestUrl||resource.derivation.responseUrl!==resource.responseUrl||!svgDerivative(resource.derivation,depth+1).equals(bytes)))throw new Error('Nested SVG dependency differs from original.');
      const expected=decodeEmbeddedImage(ref.source)?ref.source:new URL(ref.source,proof.responseUrl).href;
      if(resource.requestUrl!==expected)throw new Error('SVG dependency URL differs from original.');
    }
    const native=verifyNativeImage(bytes),name=`images/${native.sha256}.${native.extension}`;assetBytes.set(name,bytes);
    if(!index.assets.some(a=>a.name===name))index.assets.push({name,...native});
    index.occurrences.push({markdownFile:'svg.md',offset:ref.offset,occurrence:ref.index,kind:ref.kind,target:name} as any);
  }
  const canonical=LEGAL_START+'\n'+body+'\n'+LEGAL_END+'\n';
  const result=renderBase64Markdown('svg.md',canonical,index,n=>assetBytes.get(n)!);
  const $=load(extractLegalBody(result.text),{},false),encoded=$('img').first().attr('src');
  if(!encoded)throw new Error('Missing rendered SVG derivative.');
  return Buffer.from(decodeEmbeddedImage(encoded)!.bytes);
}
