import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readNlCheckpointFiles,installCheckpointFiles} from './nl-checkpoint.js';
import {OfficialSources,sourceArchiveName} from './official-sources.js';
import {renderAct} from './render.js';
import {nlActManifest} from './nl-output.js';
import type {ScopeAct,ScopeConfig,VersionSnapshot} from './types.js';

function fixture(t:{after:(f:()=>void)=>void}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nl-checkpoint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const checkpoint=path.join(root,'checkpoint'),output=path.join(root,'output');fs.mkdirSync(checkpoint);fs.mkdirSync(output);
  const configured:ScopeAct[]=[1,2].map(order=>({order,bwbId:`BWBR000000${order}`,title:`Test ${order}`,include:{articles:['1']},mustIncludeArticles:['1']}));
  const acts=configured.map(act=>{
    const url=`https://repository.officiele-overheidspublicaties.nl/${act.bwbId}.xml`;
    const snapshot:VersionSnapshot={version:{key:'2025-01-01_0',validFrom:'2025-01-01',validTo:null,toestandUrl:url},
      statute:{bwbId:act.bwbId,title:act.title,provisions:[{article:'1',provisionRef:'1',structurePath:'',content:'Officiële Nederlandse tekst.'}]}};
    const rendered=renderAct(act,[snapshot],'2025-01-01','2026-10-17');
    const sources=new OfficialSources('NL',act.bwbId,{from:'2025-01-01',to:'2026-10-17',observedOn:'2026-10-17'});
    sources.add('toestand/2025-01-01_0.xml',{bytes:Buffer.from('<toestand/>'),url,contentType:'application/xml'},url,'BWB-Toestand');
    const native=sources.build(sourceArchiveName(act.order,act.bwbId));fs.writeFileSync(path.join(checkpoint,native.metadata.name),native.bytes);
    for(const c of rendered.chunks)fs.writeFileSync(path.join(checkpoint,c.fileName),c.content);
    return {...nlActManifest(rendered,1),sourceArchive:native.metadata};
  });
  fs.writeFileSync(path.join(output,'stale.md'),'old output');
  return {root,checkpoint,output,acts,config:{acts:configured} as ScopeConfig};
}
test('NL restore validates every act before replacing output and installs only the verified snapshot',t=>{
  const p=fixture(t),bad=path.join(p.checkpoint,p.acts[1].files[0].name),original=fs.readFileSync(bad);
  fs.writeFileSync(bad,'corrupt second act');
  assert.throws(()=>readNlCheckpointFiles(p.checkpoint,p.acts,p.config),/checksum/);
  assert.deepEqual(fs.readdirSync(p.output),['stale.md']);
  fs.writeFileSync(bad,original);
  const files=readNlCheckpointFiles(p.checkpoint,p.acts,p.config);fs.writeFileSync(bad,'changed after verification');
  installCheckpointFiles(p.output,files);
  assert.deepEqual(fs.readdirSync(p.output).sort(),[...files.keys()].sort());
  assert.deepEqual(fs.readFileSync(path.join(p.output,p.acts[1].files[0].name)),original);
  assert(!fs.readdirSync(p.root).some(name=>name.startsWith('.checkpoint-restore-')));
});
test('NL restore refuses unsafe archives, duplicate acts and symlinked content without changing output',t=>{
  const p=fixture(t),archive=p.acts[0].sourceArchive;
  p.acts[0].sourceArchive={...archive,name:'../outside.sources.zip'};
  assert.throws(()=>readNlCheckpointFiles(p.checkpoint,p.acts,p.config),/archive name/);
  p.acts[0].sourceArchive=archive;
  assert.throws(()=>readNlCheckpointFiles(p.checkpoint,[p.acts[0],p.acts[0]],p.config),/scope/);
  const file=path.join(p.checkpoint,p.acts[0].files[0].name),other=path.join(p.root,'original.md');
  fs.renameSync(file,other);fs.symlinkSync(other,file);
  assert.throws(()=>readNlCheckpointFiles(p.checkpoint,p.acts,p.config),/regular files/);
  assert.deepEqual(fs.readdirSync(p.output),['stale.md']);
});
