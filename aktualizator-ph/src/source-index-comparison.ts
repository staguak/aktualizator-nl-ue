import {nlIndex} from './nl-output.js';
import {euIndex} from './eu-output.js';
import {safeArchiveName} from './official-sources.js';

// INDEX keeps the checksum of its own exact generated archive. A later source
// observation changes that container checksum without changing official bytes.
// Validate the COMPLETE actual index against its own manifest first; only the
// explicitly technical archive checksum is neutralized for material comparison.
export function comparableSourceIndex(manifest:any,bytes:Buffer):string{
  if(!manifest||!['NL','EU'].includes(manifest.jurisdiction)||!Array.isArray(manifest.acts))throw new Error('Invalid source INDEX manifest.');
  for(const act of manifest.acts)if(act.sourceArchive){
    const archive=act.sourceArchive;
    if(!safeArchiveName(archive.name)||!/^[a-f0-9]{32}$/.test(archive.md5)||!Number.isSafeInteger(archive.entryCount)||archive.entryCount<1)throw new Error('Invalid source INDEX archive.');
  }
  const render=manifest.jurisdiction==='NL'?nlIndex:euIndex;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(text!==render(manifest))throw new Error('Source INDEX differs from its manifest.');
  const material={...manifest,acts:manifest.acts.map((act:any)=>act.sourceArchive?
    {...act,sourceArchive:{...act.sourceArchive,md5:'0'.repeat(32)}}:act)};
  return render(material);
}
