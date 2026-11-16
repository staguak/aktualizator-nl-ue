import {fetchBinarySource,fetchSourceFile,retrySource} from './source-cache.js';
import {verifyNativeImage} from './legal-images.js';
export async function officialImage(value:string,options:{cacheDir?:string;fetcher?:typeof fetch}={}){
  let url:URL;try{url=new URL(value);}catch{throw new Error('Untrusted official image URL.');}
  if(url.username||url.password||url.port||!/(?:^|\.)(?:europa\.eu|overheid\.nl|officielebekendmakingen\.nl|officiele-overheidspublicaties\.nl)$/i.test(url.hostname))throw new Error('Untrusted official image URL.');
  // CELLAR uses HTTP resource identities in original XHTML. Only these known
  // EU hosts may be upgraded; the original URI remains in IMAGE_INDEX.json.
  if(url.protocol==='http:'&&['publications.europa.eu','eur-lex.europa.eu'].includes(url.hostname))url.protocol='https:';
  if(url.protocol!=='https:')throw new Error('Untrusted official image URL.');
  url.hash='';
  const types:Record<string,string>={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',
    svg:'image/svg+xml',avif:'image/avif',tif:'image/tiff',tiff:'image/tiff',bmp:'image/bmp',ico:'image/x-icon'};
  const extension=/\.([a-z0-9]+)$/i.exec(url.pathname)?.[1].toLowerCase();
  // CELLAR rejects image/* for native items. Extensionless items use ordinary
  // content negotiation; native decoding below rejects HTML/error responses.
  // SVG is an image here, not an unlimited raw RDF/XML source. Use the file
  // cache API explicitly so the image ceiling also applies to image/svg+xml.
  const transfer=process.env.LAW_PUBLIC_INCREMENTAL==='1'?fetchSourceFile:fetchBinarySource;
  const response=await retrySource(()=>transfer(url.href,{Accept:types[extension??'']??'*/*'},
    {cacheDir:options.cacheDir??process.env.LAW_SOURCE_CACHE_DIR,fetcher:options.fetcher,maxBytes:95_000_000,timeoutMs:60000,allowedHosts:[url.hostname]}),3);
  verifyNativeImage(response.bytes);
  return response;
}
