import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraDemoAt,cameraDemoValues,createCameraFrameSource} from './surround-demo.js';
import {DRIVER_VIEW_STATE,createSurroundPolicy,parseDriverView,cameraRoster} from './surround.js';
test('camera demonstration has valid atomic states and uniquely synthetic sources',()=>{
 for(let t=0;t<24;t+=.1){const {values}=cameraDemoValues(t);assert.ok(parseDriverView(values[DRIVER_VIEW_STATE].v));const roster=cameraRoster(values);assert.deepEqual(Object.keys(roster),['left','rear','right']);assert.ok(Object.values(roster).every(c=>c.url.startsWith('demo://')));}
});
test('demo neutral left/right and opponent reverse trigger; home and unknown suppress',()=>{
 const expected=[[1,'left'],[6,'right'],[11,'rear'],[16,null],[21,null]];
 for(const [time,view]of expected){const p=createSurroundPolicy();for(let step=0;step<=3;step++){const now=time+step*.1;p.ingest(cameraDemoValues(now).values[DRIVER_VIEW_STATE].v,now*1000,true);p.update(now*1000);}assert.equal(p.update((time+.3)*1000).view,view);}
 assert.equal(cameraDemoAt(25).phase,'left');
});
test('demo frame routing cannot call live camera transport, including arbitrary roster URLs',async()=>{
 let live=0,demo=0;const source=createCameraFrameSource({live:()=>{live++;throw Error('must not contact cameras');},demo:async(role)=>{demo++;return new Uint8Array([role.length]);}});
 source.setDemo(true);for(const role of ['left','rear','right'])await source.frame({role,url:'http://10.58.5.12:5800/',now:0});assert.equal(live,0);assert.equal(demo,3);
});
test('source changes discard both in-flight live results and in-flight demo illustrations',async()=>{
 let resolveLive,resolveDemo,liveCalls=0;const source=createCameraFrameSource({live:()=>{liveCalls++;return new Promise(resolve=>resolveLive=resolve);},demo:()=>new Promise(resolve=>resolveDemo=resolve)});
 const oldLive=source.frame({role:'left',url:'live',now:0});source.setDemo(true);resolveLive('old robot');assert.equal(await oldLive,null);
 const oldDemo=source.frame({role:'left',url:'demo',now:1});source.setDemo(false);resolveDemo('old illustration');assert.equal(await oldDemo,null);
 const newLive=source.frame({role:'right',url:'new live',now:2});resolveLive('new robot');assert.equal(await newLive,'new robot');assert.equal(liveCalls,2);
});
test('source reset clears sequence/freshness while preserving explicit manual selection',()=>{
 const p=createSurroundPolicy();for(const t of [1,1.2]){p.ingest(cameraDemoValues(t).values[DRIVER_VIEW_STATE].v,t*1000,true);p.update(t*1000);}assert.equal(p.update(1200).view,'left');p.reset();assert.equal(p.update(1201).view,null);assert.equal(p.update(1201).zone,'unknown');
 p.choose('panorama');p.reset();assert.equal(p.update(1202).view,'panorama');assert.equal(p.update(1202).manual,true);
 p.choose('auto');for(const t of [0,.2]){p.ingest(cameraDemoValues(t).values[DRIVER_VIEW_STATE].v,t*1000,true);p.update(t*1000);}assert.equal(p.update(200).view,'left','new source may start sequence from zero after reset');
});
