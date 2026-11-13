import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {retryDrive,transientDriveError,safeDriveFailure,safeFailureMessage} from './drive-retry.js';

test('native source deadlines and cancellations are not misidentified as Drive API failures by DOMException numeric codes',()=>{
  assert.equal(safeFailureMessage(new DOMException('PRIVATE_URL','TimeoutError')),'Request failed [REQUEST_TIMEOUT].');
  assert.equal(safeFailureMessage(new DOMException('PRIVATE_URL','AbortError')),'Request aborted.');
  assert.equal(safeFailureMessage(new DOMException('PRIVATE_URL','SecurityError'),'Source operation failed.'),'Source operation failed.');
});

test('pinned SDK timeouts retry but in-flight caller cancellations remain fatal without logging SDK data',async()=>{
  const require=createRequire(import.meta.url);
  // Exercise both lockfile versions, including the Google Drive transport.
  const modules=[require.resolve('gaxios'),createRequire(require.resolve('googleapis-common')).resolve('gaxios')];
  const server=http.createServer((_request,_response)=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/PRIVATE_DATA_MUST_NOT_APPEAR`;
  try{
    for(const file of modules){
      const {Gaxios}=await import(pathToFileURL(file).href),sdk=new Gaxios();
      let deadline:unknown;
      try{await sdk.request({url,timeout:30,retry:false});}catch(error){deadline=error;}
      assert(deadline);assert.equal(transientDriveError(deadline),true);
      assert.match(safeDriveFailure(deadline),/REQUEST_TIMEOUT/);
      assert.equal(safeFailureMessage(deadline),safeDriveFailure(deadline));
      assert(!safeFailureMessage(deadline).includes('PRIVATE_DATA'));
      let attempts=0;
      assert.equal(await retryDrive(async()=>{if(++attempts===1)throw deadline;return 'verified';},async()=>{}),'verified');
      assert.equal(attempts,2);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15);
      let cancellation:unknown;
      try{await sdk.request({url,timeout:1000,signal:controller.signal,retry:false});}
      catch(error){cancellation=error;}finally{clearTimeout(timer);}
      assert(cancellation);assert.equal(transientDriveError(cancellation),false);
      attempts=0;await assert.rejects(retryDrive(async()=>{attempts++;throw cancellation;},async()=>{}));
      assert.equal(attempts,1);assert(!safeDriveFailure(cancellation).includes('REQUEST_TIMEOUT'));
    }
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('unproven aborts, malformed permanent errors and expired retry budgets do not become success',async()=>{
  for(const error of [new DOMException('cancelled','AbortError'),{code:'ABORT_ERR'},
    {config:{timeout:1,signal:{aborted:false,reason:{name:'TimeoutError'}}}},
    {response:{status:403,data:{error:{errors:'PRIVATE_DATA'}}}},
    {response:{status:403},code:'TimeoutError'}])assert.equal(transientDriveError(error),false);
  assert.equal(transientDriveError({code:'TimeoutError'}),true);
  assert.equal(transientDriveError(new DOMException('deadline','TimeoutError')),true);
  assert.equal(safeDriveFailure(new DOMException('deadline','TimeoutError')),'Drive API failure [REQUEST_TIMEOUT].');
  assert(!safeDriveFailure(new DOMException('cancelled','AbortError')).includes('HTTP'));
  let attempts=0;const failure={code:'TimeoutError'};
  await assert.rejects(retryDrive(async()=>{attempts++;throw failure;},async()=>{}),error=>error===failure);
  assert.equal(attempts,5);
});
