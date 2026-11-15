import type {LegalManifest} from './legal-structure.js';
import type {EuLanguage} from './eu-language.js';
import {sourceInfrastructureFailure} from './source-cache.js';
export interface ImageContext {document:LegalManifest;sourceLocator:string;kind:string}
export interface ImageAttempt {language:string;url:string;outcome:'UNAVAILABLE'|'AVAILABLE';reason?:string}
export interface ImageResolution {language:EuLanguage;documentId:string;version:string;sourceUrl:string;sourceSha256:string;sourceLocator:string;sourceDocumentBase64:string;attempts:ImageAttempt[]}
export interface SvgResource {index:number;source:string;requestUrl:string;responseUrl:string;contentType:string;sha256:string;base64:string;derivation?:SvgDerivation}
export interface SvgDerivation {profile:'self-contained-svg-v1';requestUrl:string;responseUrl:string;originalBase64:string;originalSha256:string;resources:SvgResource[]}
export class ImageValidationInfrastructureError extends Error {}
export function imageInfrastructureFailure(error:unknown):boolean{
  return error instanceof ImageValidationInfrastructureError||sourceInfrastructureFailure(error);
}
export class ImageUnavailableError extends Error {
  constructor(readonly attempts:ImageAttempt[]){super('Graphic unavailable after all configured source/language attempts.');}
}
