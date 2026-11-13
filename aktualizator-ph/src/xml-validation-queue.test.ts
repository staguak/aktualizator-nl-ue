import test from 'node:test';
import assert from 'node:assert/strict';
import {XmlValidationQueue,XmlQueueCapacityError} from './xml-validation-queue.js';

test('queued validator tasks start individual service deadlines only when their frame can run',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const queue=new XmlValidationQueue(2),started:number[]=[],finished:number[]=[];
  const request=(id:number)=>queue.run(()=>new Promise<void>(resolve=>{started.push(id);setTimeout(()=>{finished.push(id);resolve();},30_000);}));
  const first=request(1),second=request(2);await Promise.resolve();
  assert.deepEqual(started,[1]);t.mock.timers.tick(29_999);assert.deepEqual(finished,[]);
  t.mock.timers.tick(1);await first;await Promise.resolve();assert.deepEqual(started,[1,2]);
  t.mock.timers.tick(29_999);assert.deepEqual(finished,[1]);t.mock.timers.tick(1);await second;assert.deepEqual(finished,[1,2]);
});
test('validator queue stays bounded, preserves FIFO after rejection and remains usable after draining',async()=>{
  const queue=new XmlValidationQueue(2),order:number[]=[];let release!:()=>void;
  const first=queue.run(()=>new Promise<void>((_resolve,reject)=>{release=()=>{order.push(1);reject(new Error('first failed'));};}));
  const firstRejected=assert.rejects(first,/first failed/);
  const second=queue.run(async()=>{order.push(2);return 'second';});
  await assert.rejects(queue.run(async()=> 'must not start'),XmlQueueCapacityError);
  await Promise.resolve();release();await firstRejected;assert.equal(await second,'second');assert.deepEqual(order,[1,2]);
  assert.equal(await queue.run(async()=> 'third'),'third');assert.throws(()=>new XmlValidationQueue(0),/Invalid/);
});
