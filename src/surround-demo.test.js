import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraDemoAt,cameraDemoValues,createCameraFrameSource,cameraDemoRoute} from './surround-demo.js';
import {demoMatch} from './demo-match.js';
const context=(extra={})=>({pose:[3,4,0],alliance:'red',velocity:[0,1,0],enabled:true,teleop:true,...extra});
const demoValues=t=>cameraDemoValues(t,context());
import {DRIVER_VIEW_STATE,createSurroundPolicy,parseDriverView,cameraRoster} from './surround.js';
test('camera demonstration has valid atomic states and uniquely synthetic sources',()=>{
 for(let t=0;t<24;t+=.1){const {values}=demoValues(t);assert.ok(parseDriverView(values[DRIVER_VIEW_STATE].v));const roster=cameraRoster(values);assert.deepEqual(Object.keys(roster),['left','rear','right']);assert.ok(Object.values(roster).every(c=>c.url.startsWith('demo://')));}
});
test('demo camera zone follows the exact displayed pose for both alliances',()=>{
 for(const alliance of ['red','blue'])for(const x of [3,8,14]){
  const scenario=cameraDemoAt(context({pose:[x,4,0],alliance}));
  const expected=x===8?'neutral':(alliance==='red'?x===14:x===3)?'home':'opponent';assert.equal(scenario.zone,expected);
  const p=createSurroundPolicy();for(const now of [0,.2]){p.ingest(cameraDemoValues(now,context({pose:[x,4,0],alliance})).values[DRIVER_VIEW_STATE].v,now*1000,true);p.update(now*1000);}assert.equal(p.update(200).view,expected==='opponent'?'left':null);
 }
 assert.equal(cameraDemoAt(null).zone,'unknown');
 assert.equal(cameraDemoAt(context({enabled:false})).commandFresh,false);
});
test('synchronized teleop tour demonstrates opponent left/right/rear and returns to neutral',()=>{
 const start=demoMatch(20).pose,end=demoMatch(56).pose;
 assert.equal(cameraDemoRoute(19.9,start,end),null);assert.equal(cameraDemoRoute(56.1,start,end),null);
 assert.deepEqual(cameraDemoRoute(20,start,end).pose,start);assert.ok(cameraDemoRoute(56,start,end).pose.every((x,i)=>Math.abs(x-end[i])<1e-9));
 for(const [time,expected]of [[29,'left'],[33,'right'],[37,'rear'],[46,null]]){
  const p=createSurroundPolicy();for(const dt of [0,.2]){const leg=cameraDemoRoute(time+dt,start,end),v=leg.fieldVelocity,theta=leg.pose[2],c=Math.cos(theta),s=Math.sin(theta);
   const generated=cameraDemoValues(time+dt,context({pose:leg.pose,velocity:[v.vx*c+v.vy*s,-v.vx*s+v.vy*c,v.omega]}));
   p.ingest(generated.values[DRIVER_VIEW_STATE].v,(time+dt)*1000,true);p.update((time+dt)*1000);
  }assert.equal(p.update((time+.2)*1000).view,expected);
 }
 const t=30,h=.001,a=cameraDemoRoute(t-h,start,end),b=cameraDemoRoute(t+h,start,end),at=cameraDemoRoute(t,start,end);assert.ok(Math.abs((b.pose[1]-a.pose[1])/(2*h)-at.fieldVelocity.vy)<1e-5);
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
 const p=createSurroundPolicy();for(const t of [1,1.2]){p.ingest(demoValues(t).values[DRIVER_VIEW_STATE].v,t*1000,true);p.update(t*1000);}assert.equal(p.update(1200).view,'left');p.reset();assert.equal(p.update(1201).view,null);assert.equal(p.update(1201).zone,'unknown');
 p.choose('panorama');p.reset();assert.equal(p.update(1202).view,'panorama');assert.equal(p.update(1202).manual,true);
 p.choose('auto');for(const t of [0,.2]){p.ingest(demoValues(t).values[DRIVER_VIEW_STATE].v,t*1000,true);p.update(t*1000);}assert.equal(p.update(200).view,'left','new source may start sequence from zero after reset');
});
