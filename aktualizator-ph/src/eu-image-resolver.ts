import {officialImage} from './official-image-source.js';
import {fetchEuText} from './eu-provider.js';
import type {EuSource} from './eu-provider.js';
import {EU_LANGUAGE_ORDER} from './eu-language.js';
import type {EuLanguage} from './eu-language.js';
import {decodeEmbeddedImage} from './eu-assets.js';
import type {EuImageLoader} from './eu-assets.js';
import {ImageUnavailableError,imageInfrastructureFailure} from './image-retrieval.js';
import type {ImageAttempt} from './image-retrieval.js';
import {XmlValidationInfrastructureError} from './xml-validation.js';
import {legalImageReferences} from './legal-images.js';
import {indexLegalDocument} from './legal-structure.js';
import type {LegalUnit} from './legal-structure.js';
import {createHash} from 'node:crypto';
import {verifyNativeImage} from './legal-images.js';
import {prepareSvgImage} from './svg-image-source.js';

export function createOfficialImageResolver(options:{load?:EuImageLoader;document?:(id:string,language:EuLanguage)=>Promise<EuSource>;log?:(message:string)=>void}={}):EuImageLoader{
  const raw=options.load??officialImage,documents=new Map<string,Promise<EuSource>>(),downloaded=new Map<string,Promise<import('./eu-assets.js').EuImageResponse>>();
  const load:EuImageLoader=async url=>{
    let pending=downloaded.get(url);
    if(!pending){pending=raw(url);downloaded.set(url,pending);}
    try{return await pending;}
    catch(error){if(downloaded.get(url)===pending)downloaded.delete(url);throw error;}
  };
  const document=options.document??((id,language)=>fetchEuText({celex:id,metadata:{},role:'image-language-fallback',include:'full-document',outputProfile:'legal-structure-v1'},language));
  const reason=(error:unknown)=>error instanceof Error&&(/^(?:Source HTTP \d+|No complete document in [A-Z, ]+\.|Fallback document identity differs\.|No unambiguous corresponding graphic in the official translation\.|Fallback legal context differs\.|Fallback source checksum differs\.)$/.test(error.message))?error.message:'Source not available or not a valid native image.';
  return async(url,context)=>{
    const attempts:ImageAttempt[]=[];
    const initial=context?.document.language??'NL';
    try{const result=decodeEmbeddedImage(url)??await load(url);return await prepareSvgImage(result,url,context?.document.sourceUrl??url,load);}
    catch(error){if(error instanceof XmlValidationInfrastructureError||imageInfrastructureFailure(error))throw error;attempts.push({language:initial,url,outcome:'UNAVAILABLE',reason:reason(error)});}
    if(context?.document.corpus==='EU')for(const language of EU_LANGUAGE_ORDER.filter(l=>l!==initial)){
      let attemptedUrl='https://publications.europa.eu/resource/celex/'+encodeURIComponent(context.document.documentId);
      try{
        const key=JSON.stringify([context.document.documentId,language]);
        let pending=documents.get(key);
        if(!pending){pending=document(context.document.documentId,language);documents.set(key,pending);}
        let source:EuSource;
        try{source=await pending;}
        catch(error){if(documents.get(key)===pending)documents.delete(key);throw error;}
        const draft=source.parsed.legalDraft;
        attemptedUrl=source.sourceUrl;
        if(!draft||draft.documentId!==context.document.documentId||draft.version!==context.document.version||draft.language!==language)
          throw new Error('Fallback document identity differs.');
        const indexed=indexLegalDocument(draft,draft.chunks.map((_,i)=>'candidate-'+i+'.md'),draft.chunks.map(c=>c.body));
        const originalUnit=context.document.units.find(u=>u.sourceLocator===context.sourceLocator);
        if(!originalUnit)throw new Error('Fallback legal context differs.');
        const chain=(units:LegalUnit[],start:LegalUnit)=>{
          const values:string[]=[];let current:LegalUnit|undefined=start;
          while(current){
            if(['article','annex','recital','holding','section','chapter'].includes(current.kind))
              values.unshift(current.kind+':'+(current.reference??current.label.match(/(?:\d+[a-z]?|\b[IVXLCDM]+\b)/gi)?.join(':')??''));
            current=current.parentId?units.find(u=>u.id===current!.parentId):undefined;
          }
          return values.join('/');
        };
        const imageKey=(value:string)=>{if(value.startsWith('data:'))return;const p=new URL(value,source.sourceUrl).pathname;return p.includes('.xhtml.')?p.split('.xhtml.').at(-1):p.split('/').at(-1);};
        const originalKey=imageKey(url),originalContext=chain(context.document.units,originalUnit);
        const matches=draft.chunks.flatMap((chunk,i)=>legalImageReferences(chunk.body).filter(r=>r.kind===context.kind).flatMap(r=>{
          const unit=indexed.units.filter(u=>u.locations.some(l=>l.part===i+1&&l.start<=r.offset&&l.end>=r.end)).at(-1);
          if(!unit||chain(indexed.units,unit)!==originalContext)return [];
          const sameLocator=unit.sourceLocator===context.sourceLocator;
          const sameNamedImage=originalContext&&(originalKey?imageKey(r.source)===originalKey:/^data:image\//i.test(url))&&
            ['alt','width','height'].every(k=>typeof originalUnit.attributes[k]==='string'&&unit.attributes[k]===originalUnit.attributes[k]);
          return sameLocator||sameNamedImage?[{unit,src:r.source}]:[];
        }));
        if(matches.length!==1)throw new Error('No unambiguous corresponding graphic in the official translation.');
        const {unit,src}=matches[0];
        const original=source.nativeSources?.find(n=>n.kind==='CELLAR-XHTML')?.source.bytes??Buffer.from(source.html);
        if(createHash('sha256').update(original).digest('hex')!==draft.sourceSha256)throw new Error('Fallback source checksum differs.');
        const embedded=decodeEmbeddedImage(src),target=embedded?source.sourceUrl:new URL(src,source.sourceUrl).href;
        attemptedUrl=target;
        const response=await prepareSvgImage(embedded??await load(target),target,source.sourceUrl,load);
        verifyNativeImage(response.bytes);
        attempts.push({language,url:target,outcome:'AVAILABLE'});
        return {bytes:response.bytes,contentType:response.contentType,url:response.url,...response.derivation?{derivation:response.derivation}:{},resolution:{language,documentId:draft.documentId,version:draft.version,sourceUrl:source.sourceUrl,sourceSha256:draft.sourceSha256,sourceLocator:unit.sourceLocator,sourceDocumentBase64:Buffer.from(original).toString('base64'),attempts}};
      }catch(error){if(error instanceof XmlValidationInfrastructureError||imageInfrastructureFailure(error))throw error;attempts.push({language,url:attemptedUrl,outcome:'UNAVAILABLE',reason:reason(error)});}
    }
    (options.log??console.warn)(`GRAPHIC_UNAVAILABLE ${context?.document.documentId??'NL'}: ${attempts.map(a=>a.language).join(' -> ')}; processing continues.`);
    throw new ImageUnavailableError(attempts);
  };
}
