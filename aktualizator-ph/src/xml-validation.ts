import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './release-store.js';
import type {BinarySource} from './source-cache.js';
import {XmlFrameDecoder} from './xml-frame-decoder.js';
import {XmlValidationQueue,XmlQueueCapacityError} from './xml-validation-queue.js';
import {XmlInputDeadline} from './xml-input-deadline.js';

export const XML_PROFILE='official-xml-v2-rdf3:5a3292345fb2c9771ef088a9852bac247c2c63f4514222a897225b13e7b3879d';
export type XmlKind='BWB-Toestand'|'BWB-WTI'|'BWB-manifest'|'SRU-2.0'|'CELLAR-Formex4'|'CELLAR-RDF-tree'|'CELLAR-RDF-object'|'CELLAR-XML-branch';
export interface XmlReceipt {
  profile:string;status:string;sourceSha256:string;sourceBytes:number;kind:XmlKind;
  schema?:string|null;schemaSha256?:string;root?:string;namespace?:string|null;
  schemaBundleSha256?:string;errors?:{line:number;column:number;code:string}[];error?:string;
  infrastructureReason?:XmlInfrastructureReason;
  rdfGraph?:{profile:string;status:string;identity:string;triples:number;facts:unknown[];multipleValues:unknown[];opaqueAssertions:number;scope:string;
    unrelatedCelexSubjects?:string[];opaqueUnrelatedCelexSubjects?:number};
}
export class XmlValidationInfrastructureError extends Error {}
export type XmlInfrastructureReason='UNAVAILABLE'|'STARTUP_TIMEOUT'|'FRAME_TRANSFER_TIMEOUT'|'REQUEST_TIMEOUT'|'QUEUE_CAPACITY'|'OUTPUT_LIMIT'|'INVALID_FRAME'|'HELPER_REJECTED'|'RECEIPT_MISMATCH'|'PROCESS_START'|'PROCESS_EXIT'|'STREAM_IO'|'CLOSED';
export class XmlValidatorUnavailable extends XmlValidationInfrastructureError {
  constructor(readonly reason:XmlInfrastructureReason='UNAVAILABLE'){
    super(`Pinned offline XML validator unavailable (${reason}); source processing stopped.`);this.name='XmlValidatorUnavailable';
  }
}
class XmlEvidenceUnavailable extends XmlValidationInfrastructureError {constructor(){super('Rejected original source evidence could not be stored or verified; processing stopped.');this.name='XmlEvidenceUnavailable';}}
export class SourceXmlRejected extends Error {constructor(readonly receipt:XmlReceipt){super(`Official XML rejected (${receipt.kind}: ${receipt.status}).`);this.name='SourceXmlRejected';}}
const root=fileURLToPath(new URL('../',import.meta.url)),maxBytes=64_000_000;
let client:XmlClient|undefined;
const accepted=new Map<string,XmlReceipt>(),rejected=new Set<string>();
export function xmlValidationEnabled():boolean{return process.env.LAW_XML_VALIDATION==='required'||!!process.env.LAW_RELEASE_CONTEXT;}
export function xmlValidationSummary(){return xmlValidationEnabled()?{profile:XML_PROFILE,
  xsdValidated:[...accepted.values()].filter(r=>r.status==='PASS').length,
  xmlOnly:[...accepted.values()].filter(r=>r.status==='NO_PINNED_SCHEMA').length,rejectedAttempts:rejected.size,
  rdfGraphsValidated:[...accepted.values()].filter(r=>r.rdfGraph?.status==='PASS').length,
  rdfIdentityConfirmed:[...accepted.values()].filter(r=>r.rdfGraph?.identity==='CONFIRMED').length,
  scope:'Pinned XSD and explicit RDF graph checks; ontology closure and complete legal history remain separate'}:undefined;}

class XmlClient {
  private child:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(r:XmlReceipt)=>void;reject:(e:Error)=>void;cancelDeadline:()=>void}>();
  private sequence=0;private failed=false;private decoder=new XmlFrameDecoder();private failure:XmlValidatorUnavailable|undefined;
  private queue=new XmlValidationQueue(8);
  readonly ready:Promise<void>;
  constructor(){
    this.child=spawn(process.env.LAW_XML_PYTHON??'python3',['-I','-u',path.join(root,'scripts/xml_validation.py'),'--serve'],
      {stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
    // Pending request timers keep the parent alive. An idle helper must not
    // prevent a completed updater from exiting; parent exit always kills it.
    this.child.unref();
    for(const stream of [this.child.stdin,this.child.stdout,this.child.stderr])
      (stream as typeof stream&{unref?:()=>void}).unref?.();
    let resolveReady:()=>void,rejectReady:(e:Error)=>void;
    this.ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const startup=setTimeout(()=>this.fail('STARTUP_TIMEOUT'),30_000);
    this.ready.then(()=>clearTimeout(startup),()=>clearTimeout(startup));
    this.failReady=error=>rejectReady(error);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(data:string)=>{
      let frames:string[];
      try{frames=this.decoder.push(data);}catch{this.fail('OUTPUT_LIMIT');return;}
      for(const line of frames){
        try{
          const message=JSON.parse(line);
          if(message.type==='fatal'&&message.code==='XML_VALIDATOR_UNAVAILABLE'){this.fail('HELPER_REJECTED');return;}
          if(message.type==='ready'){
            if(message.profile!==XML_PROFILE||message.lxml!=='6.1.3'||message.rdf!=='7.6.0'||message.schemas!==31)throw new Error();
            resolveReady();continue;
          }
          const wait=this.pending.get(message.id);if(!wait||!message.result)throw new Error();
          wait.cancelDeadline();this.pending.delete(message.id);wait.resolve(message.result);
        }catch{this.fail('INVALID_FRAME');return;}
      }
    });
    this.child.stderr.resume(); // Never echo arbitrary Python/dependency diagnostics.
    this.child.on('error',()=>this.fail('PROCESS_START'));this.child.on('close',()=>this.fail('PROCESS_EXIT'));
    this.child.stdin.on('error',()=>this.fail('STREAM_IO'));
  }
  private failReady:(error:XmlValidatorUnavailable)=>void=()=>{};
  private fail(reason:XmlInfrastructureReason){
    if(this.failed)return;this.failed=true;this.failure=new XmlValidatorUnavailable(reason);this.failReady(this.failure);
    for(const wait of this.pending.values()){wait.cancelDeadline();wait.reject(this.failure);}
    this.pending.clear();this.child.kill();
  }
  async validate(bytes:Buffer,url:string,kind:XmlKind,identifier:string|undefined,sha256:string):Promise<XmlReceipt>{
    await this.ready;if(this.failed)throw this.failure??new XmlValidatorUnavailable();
    try{return await this.queue.run(()=>this.send(bytes,url,kind,identifier,sha256));}
    catch(error){throw error instanceof XmlQueueCapacityError?new XmlValidatorUnavailable('QUEUE_CAPACITY'):error;}
  }
  private send(bytes:Buffer,url:string,kind:XmlKind,identifier:string|undefined,sha256:string):Promise<XmlReceipt>{
    if(this.failed)return Promise.reject(this.failure??new XmlValidatorUnavailable());
    const id=++this.sequence;
    const header=Buffer.from(JSON.stringify({id,size:bytes.length,sha256,url,kind,identifier})+'\n');
    if(header.length>16_384)throw new Error('XML validation request header is too large.');
    return new Promise((resolve,reject)=>{
      let serviceTimer:ReturnType<typeof setTimeout>|undefined;
      const input=new XmlInputDeadline(()=>this.fail('FRAME_TRANSFER_TIMEOUT'));
      this.pending.set(id,{resolve,reject,cancelDeadline:()=>{input.cancel();if(serviceTimer)clearTimeout(serviceTimer);}});
      // Both writes are enqueued synchronously; another request cannot insert
      // its header between this frame's header and original byte payload.
      this.child.stdin.write(header);this.child.stdin.write(bytes,error=>{
        if(error){this.fail('STREAM_IO');return;}
        input.cancel();
        if(!this.failed&&this.pending.has(id))serviceTimer=setTimeout(()=>this.fail('REQUEST_TIMEOUT'),30_000);
      });
    });
  }
  close(){this.fail('CLOSED');}
}
export async function ensureXmlValidation():Promise<void>{
  if(xmlValidationEnabled()){client??=new XmlClient();await client.ready;}
}
export function closeXmlValidation():void{client?.close();client=undefined;}
process.once('exit',closeXmlValidation);

function preserveRejected(source:BinarySource,kind:XmlKind,receipt:XmlReceipt):void{
  try{
  const digest=hash(source.bytes),dir=process.env.LAW_XML_DIAGNOSTICS_DIR??path.join(root,'.source-diagnostics');fs.mkdirSync(dir,{recursive:true});
  const writeEvidence=(file:string,bytes:Buffer)=>{
    try{fs.writeFileSync(file,bytes,{flag:'wx'});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!fs.lstatSync(file).isFile()||!fs.readFileSync(file).equals(bytes))throw new Error('Conflicting rejected-source evidence.');
    }
  };
  writeEvidence(path.join(dir,digest+'.bin'),source.bytes);
  const record=Buffer.from(JSON.stringify({schemaVersion:1,url:source.url,
    contentType:source.contentType,sourceFile:digest+'.bin',...receipt},null,2)+'\n');
  const identity=hash(record);
  writeEvidence(path.join(dir,`${digest}-${identity}.json`),record);
  }catch{throw new XmlEvidenceUnavailable();}
}
export function preserveRejectedSource(source:BinarySource,kind:XmlKind,status:string):void{
  if(!xmlValidationEnabled())return;
  const digest=hash(source.bytes);rejected.add(JSON.stringify([digest,source.url,kind]));
  preserveRejected(source,kind,{profile:XML_PROFILE,status,sourceSha256:digest,sourceBytes:source.bytes.length,kind});
}
export async function validateSourceXml(source:BinarySource,kind:XmlKind,identifier?:string):Promise<XmlReceipt|undefined>{
  if(!xmlValidationEnabled())return;
  if(!source.bytes.length||source.bytes.length>maxBytes)throw new Error('Invalid official XML payload size.');
  const digest=hash(source.bytes),key=JSON.stringify([digest,source.url,kind,identifier]);
  const known=accepted.get(key);if(known)return known;
  let receipt:XmlReceipt;
  try{
    await ensureXmlValidation();receipt=await client!.validate(source.bytes,source.url,kind,identifier,digest);
    if(receipt.profile!==XML_PROFILE||receipt.sourceSha256!==digest||receipt.sourceBytes!==source.bytes.length||receipt.kind!==kind||
      receipt.status==='PASS'&&(!receipt.schema||!receipt.schemaSha256||!/^[a-f0-9]{64}$/.test(receipt.schemaSha256))||
      ['PASS','NO_PINNED_SCHEMA'].includes(receipt.status)&&kind.startsWith('CELLAR-RDF-')&&receipt.rdfGraph?.status!=='PASS')
      throw new XmlValidatorUnavailable('RECEIPT_MISMATCH');
  }catch(error){
    const failure:XmlReceipt={profile:XML_PROFILE,status:'VALIDATOR_FAILURE',sourceSha256:digest,sourceBytes:source.bytes.length,kind,
      infrastructureReason:error instanceof XmlValidatorUnavailable?error.reason:'UNAVAILABLE'};
    preserveRejected(source,kind,failure);
    throw error instanceof XmlValidationInfrastructureError?error:new XmlValidatorUnavailable();
  }
  if(!['PASS','NO_PINNED_SCHEMA'].includes(receipt.status)){
    rejected.add(key);preserveRejected(source,kind,receipt);throw new SourceXmlRejected(receipt);
  }
  accepted.set(key,receipt);return receipt;
}
