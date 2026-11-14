import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hash,encode} from './release-store.js';
import {safeCacheDirectory} from './cache-directory.js';
import {sourceCacheShard} from './source-cache.js';
import {sourceAuditMode} from './source-audit.js';
import type {XmlReceipt} from './xml-validation.js';

const root=fileURLToPath(new URL('../',import.meta.url));
let engine:string|undefined;
function engineIdentity(){
  return engine??=hash(Buffer.concat(['src/xml-validation.ts','src/validation-cache.ts','scripts/xml_validation.py',
    'scripts/xml_file_validation.py','scripts/xml-requirements.txt','scripts/rdf-requirements.txt',
    'docs/schema-research/catalog.json','docs/schema-research/official-schemas.zip'].map(name=>fs.readFileSync(path.join(root,name)))));
}
function identity(dependencies:Record<string,unknown>){
  const dir=process.env.LAW_SOURCE_CACHE_DIR;
  if(process.env.LAW_PUBLIC_INCREMENTAL!=='1'||!dir||sourceAuditMode()==='unconditional')return;
  const key=hash(encode({engine:engineIdentity(),runtime:process.versions.node,...dependencies}));
  const file=path.join(dir,'validated',sourceCacheShard(key),key+'.json');
  if(!safeCacheDirectory(path.dirname(file)))return;
  return {file,key};
}
export function cachedXmlReceipt(dependencies:Record<string,unknown>,valid:(value:XmlReceipt)=>boolean):XmlReceipt|undefined{
  const item=identity(dependencies);if(!item)return;
  try{
    const stat=fs.lstatSync(item.file);if(!stat.isFile()||stat.size>16_000_000)return;
    const saved=JSON.parse(fs.readFileSync(item.file,'utf8'));
    if(saved.profile==='xml-receipt-cache-v1'&&saved.key===item.key&&saved.sha256===hash(encode(saved.receipt))&&valid(saved.receipt))return saved.receipt;
  }catch{/* A receipt is an optimization; an invalid one causes real validation. */}
}
export function storeXmlReceipt(dependencies:Record<string,unknown>,receipt:XmlReceipt){
  const item=identity(dependencies);if(!item||!['PASS','NO_PINNED_SCHEMA'].includes(receipt.status))return;
  let temporary:string|undefined;
  try{
    fs.mkdirSync(path.dirname(item.file),{recursive:true});if(!safeCacheDirectory(path.dirname(item.file)))return;
    temporary=item.file+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,encode({profile:'xml-receipt-cache-v1',key:item.key,receipt,sha256:hash(encode(receipt))}),{flag:'wx'});
    fs.renameSync(temporary,item.file);
  }catch{/* Failing to cache must not erase a successful independent validation. */}
  finally{if(temporary)try{fs.rmSync(temporary,{force:true});}catch{/* Optional cache. */}}
}
