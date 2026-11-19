import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fetchSourceFile,sourceBlob} from './source-cache.js';
import {verifyUnchangedSources} from './public-preflight.js';

test('preflight requires a verified prior blob and handles 304, changed response and remote failure',async()=>{
  const cache=fs.mkdtempSync(path.join(os.tmpdir(),'public-preflight-'));
  const url='https://publications.europa.eu/webapi/rdf/sparql?query=fixture';
  const headers={Accept:'application/sparql-results+json'};
  try{
    const body=await fetchSourceFile(url,headers,{cacheDir:cache,fetcher:async()=>new Response('official fixture',{
      headers:{ETag:'"verified"', 'Content-Type':'application/sparql-results+json'}
    })});
    const request={requestedUrl:url,kind:'CELLAR-SPARQL',sha256:body.sha256!,verificationRequest:{headers}};
    const unchanged=await verifyUnchangedSources([request,request],cache,async(_url,options)=>{
      assert.equal(new Headers(options?.headers).get('if-none-match'),'"verified"');
      return new Response(null,{status:304});
    });
    assert.deepEqual(unchanged,{status:'NO_CHANGE',checked:1});
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response('new content'))).status,'CHANGED');
    assert.equal((await verifyUnchangedSources([request],cache,async()=>new Response(null,{status:503}))).status,'UNKNOWN');
    fs.writeFileSync(sourceBlob(cache,body.sha256!),Buffer.from('changed'));
    let contacted=false;
    assert.equal((await verifyUnchangedSources([request],cache,async()=>{contacted=true;return new Response(null,{status:304});})).status,'UNKNOWN');
    assert.equal(contacted,false);
  }finally{fs.rmSync(cache,{recursive:true,force:true});}
});
