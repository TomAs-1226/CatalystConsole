import test from 'node:test';
import assert from 'node:assert/strict';
import {createCameraIdentityGate} from './surround-identity.js';
const settle=()=>new Promise(setImmediate);
test('wrong physical camera never gains identity from its configured address',async()=>{
 let now=0,calls=0,name='limelight-shooter';const gate=createCameraIdentityGate(async()=>{calls++;return name;},()=>now);
 const check=()=>gate.check('http://10.58.5.11:5800/','limelight-right');
 assert.equal(check().allowed,false);await settle();assert.equal(check().allowed,false);assert.match(check().message,/Wrong camera: limelight-shooter/);
 now=4900;check();assert.equal(calls,1);
 name='limelight-right';now=5000;check();await settle();assert.equal(check().allowed,true);assert.equal(calls,2);
 now=12000;assert.equal(check().allowed,false,'expired identity cannot admit a frame while rechecking');
 await settle();assert.equal(check().allowed,true);
});
test('failed identity and address/name changes fail closed, cache reset cannot authorize another source',async()=>{
 let fail=false;const gate=createCameraIdentityGate(async()=>{if(fail)throw Error('timeout');return 'limelight-left';},()=>0);
 const url='http://10.58.5.12:5800/';gate.check(url,'limelight-left');await settle();assert.equal(gate.check(url,'limelight-left').allowed,true);
 assert.equal(gate.check(url,'limelight-right').allowed,false);await settle();assert.equal(gate.check(url,'limelight-right').allowed,false);
 fail=true;assert.equal(gate.check('http://10.58.5.13:5800/','limelight-left').allowed,false);await settle();assert.match(gate.check('http://10.58.5.13:5800/','limelight-left').message,/unavailable/);
 gate.clear();assert.equal(gate.check(url,'limelight-left').allowed,false);
});
