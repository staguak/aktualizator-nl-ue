import {validateCheckpointArchive} from './xml-archive-validation.js';
import {xmlValidationEnabled} from './xml-validation.js';
import {safeArchiveName} from './official-sources.js';
import {runPool} from './concurrency.js';
import type {SourceArchive} from './official-sources.js';
import type {PublicationInputs} from './completed-build.js';

// Completed input snapshots retain the existing checkpoint contract: required
// XML/XSD/RDF must be checked again BEFORE replaying derived models. A cache
// hit or a previously serialized PASS never bypasses the pinned runtime.
export async function validateCompletedBuildXml(inputs:PublicationInputs){
  if(!xmlValidationEnabled())throw new Error('Completed build restore requires pinned XML validation.');
  const tasks:{module:'NL'|'EU';identifier:string;archive:SourceArchive;bytes:Buffer}[]=[];
  for(const module of ['NL','EU'] as const){
    const files=inputs.get(module),raw=files?.get('manifest.json');
    if(!raw)throw new Error('Completed XML checkpoint manifest is missing.');
    const manifest=JSON.parse(raw.toString());
    if(manifest.schemaVersion!==2||manifest.jurisdiction!==module||!Array.isArray(manifest.acts)||!manifest.acts.length||manifest.acts.length>10000)
      throw new Error('Invalid completed XML checkpoint manifest.');
    const ids=new Set<string>(),names=new Set<string>();
    for(const act of manifest.acts){
      const identifier=module==='NL'?act.bwbId:act.celex,archive=act.sourceArchive;
      if(typeof identifier!=='string'||!identifier||ids.has(identifier)||!archive||!safeArchiveName(archive.name)||names.has(archive.name))
        throw new Error('Invalid completed XML checkpoint identity.');
      ids.add(identifier);names.add(archive.name);const bytes=files!.get(archive.name);
      if(!bytes)throw new Error('Completed XML checkpoint source is missing.');
      tasks.push({module,identifier,archive,bytes});
    }
  }
  const receipts:{module:'NL'|'EU';identifier:string;archive:string;entry:string;validation:Awaited<ReturnType<typeof validateCheckpointArchive>>[number]['validation']}[]=[];
  await runPool(tasks,4,async task=>{
    for(const record of await validateCheckpointArchive(task.bytes,task.archive,task.module,task.identifier))
      receipts.push({module:task.module,identifier:task.identifier,archive:task.archive.name,...record});
  });
  return receipts.sort((a,b)=>(a.module+'/'+a.identifier+'/'+a.entry).localeCompare(b.module+'/'+b.identifier+'/'+b.entry));
}
