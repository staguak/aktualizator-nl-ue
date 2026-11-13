import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Workflow revisions are explicit immutable SHAs. Local runs also need to
// invalidate completed-act checkpoints when executable files change, rather
// than calling every working tree "local" throughout the day.
export function executionRevision(root:string,env:NodeJS.ProcessEnv=process.env):string{
  if(env.LAW_UPDATER_REVISION)return env.LAW_UPDATER_REVISION;
  const files=fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.ts')&&
    !name.endsWith('.test.ts')&&!name.endsWith('.integration.ts')&&name!=='parser-selftest.ts').map(name=>'src/'+name);
  files.push('package-lock.json','scripts/xml_validation.py','scripts/xml-requirements.txt','scripts/rdf-requirements.txt');
  const digest=createHash('sha256').update('local-execution-v1\0'+process.versions.node+'\0');
  for(const file of files.sort()){
    const target=path.join(root,file);if(!fs.lstatSync(target).isFile())throw new Error('Executable revision requires regular source files.');
    const bytes=fs.readFileSync(target);digest.update(file+'\0'+bytes.length+'\0').update(bytes);
  }
  return 'local-'+digest.digest('hex');
}
