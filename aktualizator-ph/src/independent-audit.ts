import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// A regular stdin descriptor has an unambiguous EOF, also on restricted
// executors where synchronous pipe input can remain open until timeout.
export function auditUnitFields(payload:unknown){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'law-independent-audit-'));
  let descriptor:number|undefined;
  try{
    const bytes=Buffer.from(JSON.stringify(payload));
    if(bytes.length>256_000_000)throw new Error('Independent audit input limit exceeded');
    const input=path.join(directory,'input.json');fs.writeFileSync(input,bytes,{flag:'wx',mode:0o600});
    descriptor=fs.openSync(input,'r');
    return spawnSync(process.env.LAW_XML_PYTHON??'python3',
      ['-I',fileURLToPath(new URL('../scripts/verify_unit_fields.py',import.meta.url))],
      {stdio:[descriptor,'pipe','pipe'],encoding:'utf8',timeout:30_000,maxBuffer:1_000_000});
  }finally{if(descriptor!==undefined)fs.closeSync(descriptor);fs.rmSync(directory,{recursive:true,force:true});}
}
