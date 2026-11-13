import test from 'node:test';
import assert from 'node:assert/strict';
import {XmlInputDeadline} from './xml-input-deadline.js';

test('XML input handoff excludes busy parent time but still expires after its idle wait budget',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let idle=0,expired=0;
  const deadline=new XmlInputDeadline(()=>{expired++;},30_000,()=>idle);
  t.mock.timers.tick(35_000);assert.equal(expired,0);
  idle=29_000;t.mock.timers.tick(30_000);assert.equal(expired,0);
  idle=30_000;t.mock.timers.tick(1000);assert.equal(expired,1);
  t.mock.timers.tick(100_000);assert.equal(expired,1);deadline.cancel();
});
test('completed or failed XML handoff cancels its watchdog without a late failure',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let idle=0,expired=false;
  const deadline=new XmlInputDeadline(()=>{expired=true;},30_000,()=>idle);deadline.cancel();deadline.cancel();idle=100_000;
  t.mock.timers.tick(100_000);assert.equal(expired,false);assert.throws(()=>new XmlInputDeadline(()=>{},0),/Invalid/);
});
