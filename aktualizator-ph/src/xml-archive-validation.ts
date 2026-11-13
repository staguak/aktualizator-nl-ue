import {loadSourceArchive,unpackOfficialZip} from './official-sources.js';
import type {SourceArchive} from './official-sources.js';
import type {BinarySource} from './source-cache.js';
import {validateSourceXml,xmlValidationEnabled,preserveRejectedSource,XmlValidationInfrastructureError} from './xml-validation.js';
import type {XmlKind,XmlReceipt} from './xml-validation.js';

export async function validateFormexXml(source:BinarySource):Promise<Record<string,XmlReceipt>|undefined>{
  if(!xmlValidationEnabled())return;
  try{
  const files=unpackOfficialZip(source.bytes),receipts:Record<string,XmlReceipt>={};
  for(const [name,bytes] of Object.entries(files))if(/\.xml$/i.test(name)){
    receipts[name]=(await validateSourceXml({...source,bytes:Buffer.from(bytes)},'CELLAR-Formex4'))!;
  }
  if(!Object.keys(receipts).length)throw new Error('Formex package contains no XML.');
  return receipts;
  }catch(error){preserveRejectedSource(source,'CELLAR-Formex4',error instanceof XmlValidationInfrastructureError?'VALIDATOR_FAILURE':'FORMEX_PACKAGE_REJECTED');throw error;}
}
export async function validateCheckpointArchive(bytes:Buffer,archive:SourceArchive,jurisdiction:'NL'|'EU',identifier:string):Promise<{entry:string;validation:XmlReceipt}[]>{
  if(!xmlValidationEnabled())return [];
  const {index,items}=loadSourceArchive(bytes,archive,jurisdiction,identifier);
  const records:{entry:string;validation:XmlReceipt}[]=[];
  let toestandCount=0;
  const xmlKinds=new Set(['BWB-Toestand','BWB-WTI','BWB-manifest','SRU-2.0','CELLAR-RDF-tree','CELLAR-RDF-object','CELLAR-XML-branch']);
  for(const entry of index.entries){
    const source={bytes:Buffer.from(items[entry.name]),url:entry.url,contentType:entry.contentType};
    if((xmlKinds.has(entry.kind)||entry.kind==='CELLAR-Formex4')&&
      (jurisdiction==='NL'?entry.kind.startsWith('CELLAR-'):!entry.kind.startsWith('CELLAR-')))
      throw new Error('XML source representation belongs to another jurisdiction.');
    if(entry.kind==='BWB-Toestand')toestandCount++;
    if(entry.kind==='CELLAR-Formex4')for(const [name,validation] of Object.entries((await validateFormexXml(source))!))records.push({entry:entry.name+'!'+name,validation});
    else if(xmlKinds.has(entry.kind)||/\.xml$/i.test(entry.name)){
      const matching=index.entries.filter((e:any)=>e.kind==='CELLAR-XHTML'&&
        e.name.replace(/\.xhtml$/,'')===entry.name.replace(/\.(?:rdf|notice)\.xml$/,''));
      // Older archives lack celex on notices. Their original XHTML companion
      // supplies the requested identity; the RDF graph must prove it itself.
      const documentId=entry.metadata?.celex??(matching.length===1?matching[0].metadata?.celex:undefined);
      records.push({entry:entry.name,validation:(await validateSourceXml(source,entry.kind as XmlKind,jurisdiction==='NL'?identifier:documentId))!});
    }
  }
  if(jurisdiction==='NL'&&!toestandCount)throw new Error('NL checkpoint lacks a required Toestand XML source.');
  return records;
}
