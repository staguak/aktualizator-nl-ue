import test from 'node:test';
import assert from 'node:assert/strict';
import type {drive_v3} from 'googleapis';
import {DriveReleaseStore} from './drive-release-store.js';
import {hash} from './release-store.js';
import {safeDriveFailure} from './drive-retry.js';
import {operationMetrics} from './operation-metrics.js';

test('guarded evidence retirement uses the verified ID and rejects changed ownership, bytes and location',async()=>{
  for(const scenario of ['ok','replacement-id','renamed','moved','foreign-owner','no-trash','changed-bytes','lost-response']){
    const namespace='evidence-manual-tests',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
    const folder='application/vnd.google-apps.folder',bytes=Buffer.from('approved evidence');
    const expected={id:'approved',size:bytes.length,md5:hash(bytes,'md5'),sha256:hash(bytes)};
    const nodes:drive_v3.Schema$File[]=[
      {id:'root',name:'root',mimeType:folder,appProperties:{...properties,role:'root'}},
      {id:'work',name:'work',mimeType:folder,parents:['root'],appProperties:properties},
      {id:'evidence',name:'evidence',mimeType:folder,parents:['work'],appProperties:properties},
      {id:'run',name:'100-1',mimeType:folder,parents:['evidence'],appProperties:properties},
    ];
    const file:drive_v3.Schema$File={id:'approved',name:'payload.bin',mimeType:'application/octet-stream',
      parents:['run'],appProperties:properties,ownedByMe:true,capabilities:{canTrash:true},
      size:String(expected.size),md5Checksum:expected.md5,sha256Checksum:expected.sha256};
    if(scenario==='replacement-id')file.id='replacement';
    if(scenario==='renamed')file.name='different.bin';
    if(scenario==='moved')file.parents=['other-folder'];
    if(scenario==='foreign-owner')file.ownedByMe=false;
    if(scenario==='no-trash')file.capabilities={canTrash:false};
    if(scenario==='changed-bytes')file.sha256Checksum='b'.repeat(64);
    const writes:string[]=[];
    const drive={files:{
      list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?[nodes[0]]:
        nodes.filter(n=>n.parents?.includes(q.match(/'([^']+)' in parents/)?.[1]??''))}}),
      get:async({fileId}:{fileId:string})=>{assert.equal(fileId,'approved');return {data:{...file}};},
      update:async({fileId}:{fileId:string})=>{
        writes.push(fileId);file.trashed=true;file.capabilities={canTrash:false};
        if(scenario==='lost-response')throw {code:'ECONNRESET'};
        return {data:{id:fileId,trashed:true}};
      },
    }} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,namespace);
    const remove=()=>store.removeIfUnchanged('work/evidence/100-1/payload.bin',expected);
    if(['ok','lost-response'].includes(scenario)){await remove();assert.deepEqual(writes,['approved']);}
    else{await assert.rejects(remove,/changed/);assert.deepEqual(writes,[]);}
  }
});

test('disposable evidence cleanup requires actual account ownership, including every child',async()=>{
  const namespace='evidence-manual-tests',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
  const folder='application/vnd.google-apps.folder';
  const nodes:drive_v3.Schema$File[]=[
    {id:'root',name:'root',mimeType:folder,appProperties:{...properties,role:'root'}},
    {id:'work',name:'work',mimeType:folder,parents:['root'],appProperties:properties},
    {id:'evidence',name:'evidence',mimeType:folder,parents:['work'],appProperties:properties},
    {id:'run',name:'100-1',mimeType:folder,parents:['evidence'],appProperties:properties},
    {id:'payload',name:'payload',mimeType:'application/octet-stream',parents:['run'],appProperties:properties},
  ].map(n=>({...n,ownedByMe:true,capabilities:{canTrash:true}}));
  const drive={files:{
    list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?[nodes[0]]:
      nodes.filter(n=>n.parents?.includes(q.match(/'([^']+)' in parents/)?.[1]??''))}}),
    get:async({fileId}:{fileId:string})=>({data:nodes.find(n=>n.id===fileId)}),
    update:async()=>{throw new Error('Ownership inspection must never mutate');},
  }} as unknown as drive_v3.Drive;
  const store=await DriveReleaseStore.open(drive,namespace);
  await store.assertEvidenceRetirementOwnership(['work/evidence/100-1/']);
  for(const node of [nodes[0],nodes[3],nodes[4]]){
    node.ownedByMe=false;
    await assert.rejects(store.assertEvidenceRetirementOwnership(['work/evidence/100-1/']),/ownership/);
    node.ownedByMe=true;
  }
  nodes[4].capabilities={canTrash:false};
  await assert.rejects(store.assertEvidenceRetirementOwnership(['work/evidence/100-1/']),/ownership/);
  await assert.rejects(store.assertEvidenceRetirementOwnership(['releases/old/']),/outside disposable/);
});

test('Drive diagnostics retain status/reason but never SDK credentials or arbitrary error text',()=>{
  const secret='PRIVATE_TOKEN_MUST_NOT_APPEAR';
  const error={message:secret,request:{Authorization:secret},response:{status:403,
    data:{error:{message:secret,errors:[{reason:'rateLimitExceeded'},{reason:secret}]}}}};
  assert.equal(safeDriveFailure(error),'Drive API failure (HTTP 403) [rateLimitExceeded].');
  assert(!safeDriveFailure(error).includes(secret));
  assert.equal(safeDriveFailure({code:'ETIMEDOUT'}),'Drive API failure [ETIMEDOUT].');
});

test('Drive metrics distinguish same-named files across roots and do not count revalidated reuse as uploads',async()=>{
  const before=operationMetrics.snapshot().counters,bytes=Buffer.from('retained');
  for(const root of ['metric-root-a','metric-root-b']){
    const namespace='release-test-999-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
    const metadata={id:root+'-file',name:'state.bin',mimeType:'application/octet-stream',size:String(bytes.length),
      md5Checksum:hash(bytes,'md5'),sha256Checksum:hash(bytes),parents:[root],appProperties:properties};
    const drive={files:{list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?
      [{id:root,mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]:[metadata]}})}} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,namespace);
    await store.write('state.bin',bytes,true);await store.write('state.bin',bytes,true);
  }
  const after=operationMetrics.snapshot().counters;
  assert.equal(after.driveUploadAttempts-before.driveUploadAttempts,0);
  assert.equal(after.driveReusedFiles-before.driveReusedFiles,2);assert.equal(after.driveReusedBytes-before.driveReusedBytes,bytes.length*2);
});
test('root inventory uses managed recursive listing and rejects foreign children without backend writes',async()=>{
  const namespace='release-test-corpus-999-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace},folder='application/vnd.google-apps.folder';
  let foreign=false;
  const drive={files:{list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?
    [{id:'root',mimeType:folder,appProperties:{...properties,role:'root'}}]:q.includes("'root' in parents")?
      [{id:'nl',name:'NL',mimeType:folder,appProperties:properties},{id:'active',name:'active.json',appProperties:properties}]:
      [{id:'law',name:'law.md',appProperties:foreign?{...properties,namespace:'another'}:properties}]}}),
    update:async()=>{throw new Error('Forbidden backend mutation');},create:async()=>{throw new Error('Forbidden backend mutation');}}} as unknown as drive_v3.Drive;
  const store=await DriveReleaseStore.open(drive,namespace);
  assert.deepEqual(await store.list(''),['NL/law.md','active.json']);
  foreign=true;await assert.rejects(store.list(''),/Unmanaged/);
});

test('Drive binary write retries with a fresh stream and fixed ID, reconciles lost responses, and stops on permissions',async()=>{
  for(const scenario of ['transient','lost-response','timeout','lost-timeout-response','permission']){
    const namespace='release-test-100-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
    const bytes=Buffer.from([0,255,1,13,10]),streams=new Set(),received:Buffer[]=[];
    let attempts=0,allocated=0,stored=false;
    const metadata={id:'reserved',name:'source.bin',mimeType:'application/octet-stream',size:String(bytes.length),
      md5Checksum:hash(bytes,'md5'),sha256Checksum:hash(bytes),appProperties:properties,parents:['root']};
    const drive={files:{list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?
      [{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]:[]}}),
      generateIds:async()=>{allocated++;return {data:{ids:['reserved']}};},
      get:async()=>{if(!stored)throw {response:{status:404}};return {data:metadata};},
      create:async({requestBody,media}:any)=>{
        attempts++;assert.equal(requestBody.id,'reserved');streams.add(media.body);
        const chunks:Buffer[]=[];for await(const part of media.body)chunks.push(Buffer.from(part));
        received.push(Buffer.concat(chunks));
        if(scenario==='permission')throw {response:{status:403,data:{error:{errors:[{reason:'insufficientFilePermissions'}]}}},message:'PRIVATE_TOKEN_MUST_NOT_APPEAR'};
        if(scenario==='transient'&&attempts===1)throw {response:{status:503}};
        const timeout={config:{timeout:120_000,signal:{aborted:true,reason:{name:'TimeoutError'}}}};
        if(scenario==='timeout'&&attempts===1)throw timeout;
        stored=true;if(scenario==='lost-response')throw {code:'ECONNRESET'};
        if(scenario==='lost-timeout-response')throw timeout;
        return {data:metadata};
      }}} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,namespace);
    if(scenario==='permission'){
      await assert.rejects(store.write('source.bin',bytes,true),/Drive write source.bin: Drive API failure \(HTTP 403\) \[insufficientFilePermissions\]/);
      assert.equal(attempts,1);
    }else{
      assert.equal((await store.write('source.bin',bytes,true)).sha256,hash(bytes));
      assert.equal(attempts,['transient','timeout'].includes(scenario)?2:1);
    }
    assert.equal(allocated,1);assert.equal(streams.size,attempts);
    received.forEach(content=>assert.deepEqual(content,bytes));
  }
});

test('test-root cleanup keeps production, protected/recent roots and any tree containing foreign data',async()=>{
  const owner='nl-eu-public-updater-releases-v1',folder='application/vnd.google-apps.folder';
  const root=(id:string,namespace:string,createdTime='2026-09-01T00:00:00Z')=>({id,mimeType:folder,createdTime,
    appProperties:{releaseOwner:owner,namespace,role:'root'}});
  const roots=[root('prod','production'),root('protected','release-test-10-1'),root('old','release-test-9-1'),
    root('recent','release-test-corpus-11-1','2026-10-11T00:00:00Z'),root('foreign','release-test-8-1'),
    root('unapproved','release-test-7-1')];
  const removed:string[]=[];
  const drive={files:{list:async({q}:{q:string})=>({data:{files:q.includes("key='role'")?roots:
    q.includes("'foreign' in parents")?[{id:'user-file',appProperties:{}}]:[]}}),
    update:async({fileId}:{fileId:string})=>{removed.push(fileId);return {data:{id:fileId,trashed:true}};}}} as unknown as drive_v3.Drive;
  assert.deepEqual(await DriveReleaseStore.cleanupOldTestNamespaces(drive,'release-test-10-1',new Date('2026-10-12T00:00:00Z'),
    roots.filter(r=>r.id!=='unapproved').map(r=>r.id)),['release-test-9-1']);
  assert.deepEqual(removed,['old']);
});
test('test cleanup cannot be invoked with a production namespace',async()=>{
  await assert.rejects(DriveReleaseStore.cleanupOldTestNamespaces({} as drive_v3.Drive,'production'),/workflow-specific/);
});
test('Drive retention can trash resume receipts while protecting the marker and base',async()=>{
  const ns='release-test-100-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace:ns};
  const folder=(id:string,name:string,parent:string)=>({id,name,parents:[parent],mimeType:'application/vnd.google-apps.folder',appProperties:properties});
  const removed:string[]=[];
  const drive={files:{list:async({q}:{q:string})=>{
    if(q.includes("key='role'"))return {data:{files:[{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]}};
    if(q.includes("'root' in parents"))return {data:{files:[folder('checks','checks','root')]}};
    if(q.includes("'checks' in parents"))return {data:{files:[folder('resumes','resumes','checks')]}};
    assert(q.includes("'resumes' in parents")&&q.includes("name = 'receipt.json'"));
    return {data:{files:[{id:'receipt',name:'receipt.json',mimeType:'application/octet-stream',appProperties:properties,parents:['resumes']}]}};
  },update:async({fileId}:{fileId:string})=>{removed.push(fileId);return {data:{id:fileId,trashed:true}};}}} as unknown as drive_v3.Drive;
  const store=await DriveReleaseStore.open(drive,ns);
  await store.remove('checks/resumes/receipt.json');
  assert.deepEqual(removed,['receipt']);
  await assert.rejects(store.remove('checks/resumes/.ready.json'),/Deletion outside/);
  await assert.rejects(store.remove('base/initial/NL/law.md'),/Deletion outside/);
  await assert.rejects(store.remove('source-history/objects/original.bin'),/Deletion outside/);
  await assert.rejects(store.removeEmptyDirectory('source-history/'),/Protected directory/);
  assert.deepEqual(removed,['receipt']);
});

test('lookup requests only the exact file name while preserving duplicate and ownership checks',async()=>{
  for(const scenario of ['valid','duplicate','foreign']){
    const ns='release-test-100-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace:ns};
    const bytes=Buffer.from('original bytes');let exactLookups=0;
    const drive={files:{list:async({q}:{q:string})=>{
      if(q.includes("key='role'"))return {data:{files:[{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]}};
      assert(q.includes("'root' in parents"));
      assert(q.includes("name = 'law.bin'"),'File lookup must not retrieve every sibling');exactLookups++;
      const file={id:'law',name:'law.bin',size:String(bytes.length),md5Checksum:hash(bytes,'md5'),sha256Checksum:hash(bytes),
        mimeType:'application/octet-stream',appProperties:scenario==='foreign'?{}:properties,parents:['root']};
      return {data:{files:scenario==='duplicate'?[file,{...file,id:'duplicate'}]:[file]}};
    },get:async()=>({data:bytes})}} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,ns);
    if(scenario==='valid'){
      assert.equal((await store.stat('law.bin'))!.sha256,hash(bytes));
      assert.deepEqual(await store.read('law.bin'),bytes);
    }else await assert.rejects(store.stat('law.bin'),scenario==='duplicate'?/Duplicate/:/Unmanaged/);
    assert(exactLookups>0);
  }
});

test('lookup checks every matching page and rejects a duplicate on a later page',async()=>{
  const properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace:'release-test-100-1'};
  const drive={files:{list:async({q,pageToken}:{q:string;pageToken?:string})=>{
    if(q.includes("key='role'"))return {data:{files:[{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]}};
    return {data:{files:[{id:pageToken?'second':'first',name:'law.bin',appProperties:properties}],
      nextPageToken:pageToken?undefined:'second-page'}};
  }}} as unknown as drive_v3.Drive;
  const store=await DriveReleaseStore.open(drive,'release-test-100-1');
  await assert.rejects(store.stat('law.bin'),/Duplicate/);
});

test('repeated Drive continuation tokens fail instead of querying indefinitely',async()=>{
  let calls=0;
  const drive={files:{list:async()=>{calls++;return {data:{files:[],nextPageToken:'repeated'}};}}} as unknown as drive_v3.Drive;
  await assert.rejects(DriveReleaseStore.open(drive,'release-test-100-1'),/pagination loop/);
  assert.equal(calls,2);
});

test('parallel writes reserve a single ID batch and never reuse an ID',async()=>{
  const namespace='release-test-100-1',properties={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
  let reservations=0;const allocated:string[]=[];
  const drive={files:{list:async({q}:any)=>({data:{files:q.includes("key='role'")?[{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...properties,role:'root'}}]:[]}}),
    generateIds:async({count}:any,options:any)=>{assert.equal(count,100);assert.equal(options.retry,false);reservations++;
      await new Promise(r=>setTimeout(r,5));return {data:{ids:Array.from({length:100},(_,i)=>`batch-${i}`)}};},
    create:async({requestBody,media}:any,options:any)=>{
      assert.equal(options.retry,false);allocated.push(requestBody.id);const chunks:Buffer[]=[];
      for await(const b of media.body)chunks.push(Buffer.from(b));const bytes=Buffer.concat(chunks);
      return {data:{id:requestBody.id,name:requestBody.name,mimeType:'application/octet-stream',parents:['root'],appProperties:properties,
        size:String(bytes.length),sha256Checksum:hash(bytes),md5Checksum:hash(bytes,'md5')}};
    }}} as unknown as drive_v3.Drive;
  const store=await DriveReleaseStore.open(drive,namespace);
  await Promise.all(Array.from({length:12},(_,i)=>store.write(`law-${i}.bin`,Buffer.from('official bytes '+i),true)));
  assert.equal(reservations,1);assert.equal(new Set(allocated).size,12);
});

test('matching checksums cannot reconcile a Drive write to another parent, name or ID',async()=>{
  for(const scenario of ['parent','name','id']){
    const namespace='release-test-100-1',props={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
    const bytes=Buffer.from('technical source fixture');
    const metadata={id:scenario==='id'?'other-id':'reserved',name:scenario==='name'?'other.bin':'source.bin',
      parents:[scenario==='parent'?'another-root':'root'],mimeType:'application/octet-stream',appProperties:props,
      size:String(bytes.length),md5Checksum:hash(bytes,'md5'),sha256Checksum:hash(bytes)};
    const drive={files:{list:async({q}:any,options:any)=>{
      assert.equal(options.timeout,60_000);return {data:{files:q.includes("key='role'")?[{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...props,role:'root'}}]:[]}};
    },generateIds:async()=>({data:{ids:['reserved']}}),get:async()=>({data:metadata}),
    create:async(_args:any,options:any)=>{assert.equal(options.timeout,120_000);throw {code:'ECONNRESET'};}}} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,namespace);
    await assert.rejects(store.write('source.bin',bytes,true),/location\/identity mismatch/);
  }
});

test('root and folder response reconciliation requires exact reserved identity and location',async()=>{
  for(const target of ['root','child'])for(const wrong of ['id','name','parent','type','trashed']){
    if(target==='root'&&wrong==='parent')continue;
    const ns='release-test-100-1',props={releaseOwner:'nl-eu-public-updater-releases-v1',namespace:ns};
    const returned={id:wrong==='id'?'another-id':'reserved',name:wrong==='name'?'another-name':target==='root'?`Aktualizator-${ns}`:'work',
      mimeType:wrong==='type'?'application/octet-stream':'application/vnd.google-apps.folder',trashed:wrong==='trashed',
      parents:[wrong==='parent'?'another-parent':'root'],appProperties:{...props,...target==='root'?{role:'root'}:{}}};
    let creates=0;
    const drive={files:{list:async({q}:any)=>({data:{files:target==='child'&&q.includes("key='role'")?
      [{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...props,role:'root'}}]:[]}}),
      generateIds:async()=>({data:{ids:['reserved']}}),get:async()=>({data:returned}),
      create:async()=>{creates++;throw {code:'ECONNRESET'};}}} as unknown as drive_v3.Drive;
    if(target==='root')await assert.rejects(DriveReleaseStore.open(drive,ns,true),/Unmanaged release root/);
    else{const store=await DriveReleaseStore.open(drive,ns);await assert.rejects(store.write('work/file.bin',Buffer.from('fixture'),true),/Invalid Drive folder|Unmanaged/);}
    assert.equal(creates,1,'A rejected directory must never receive a file upload');
  }
});

test('root and child folder timeout retries retain reserved IDs and reconcile successful creates first',async()=>{
  for(const target of ['root','child'])for(const lostResponse of [false,true]){
    const namespace='release-test-100-1',props={releaseOwner:'nl-eu-public-updater-releases-v1',namespace};
    const bytes=Buffer.from('official source bytes'),ids:string[]=[];let stored:any,folderCreates=0;
    const drive={files:{
      list:async({q}:any)=>({data:{files:target==='child'&&q.includes("key='role'")?
        [{id:'root',mimeType:'application/vnd.google-apps.folder',appProperties:{...props,role:'root'}}]:[]}}),
      generateIds:async()=>({data:{ids:['file','reserved-directory']}}),
      get:async({fileId}:any)=>{assert.equal(fileId,'reserved-directory');if(!stored)throw {response:{status:404}};return {data:stored};},
      create:async({requestBody}:any)=>{
        if(requestBody.mimeType!=='application/vnd.google-apps.folder')return {data:{...requestBody,mimeType:'application/octet-stream',
          size:String(bytes.length),md5Checksum:hash(bytes,'md5'),sha256Checksum:hash(bytes)}};
        ids.push(requestBody.id);folderCreates++;
        if(folderCreates===1){
          if(lostResponse)stored={...requestBody};
          throw {config:{timeout:60_000,signal:{aborted:true,reason:{name:'TimeoutError'}}}};
        }
        stored={...requestBody};return {data:stored};
      },
    }} as unknown as drive_v3.Drive;
    const store=await DriveReleaseStore.open(drive,namespace,target==='root');
    if(target==='child')await store.write('work/source.bin',bytes,true);
    assert.equal(folderCreates,lostResponse?1:2);
    assert.deepEqual([...new Set(ids)],['reserved-directory']);
  }
});
