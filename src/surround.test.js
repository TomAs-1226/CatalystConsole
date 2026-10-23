import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurroundPolicy,parseDriverView,cameraRoster} from './surround.js';
const sample=(extra={})=>({schemaVersion:1,sequence:1,robotRelativeVxMps:0,robotRelativeVyMps:1,robotRelativeOmegaRadps:0,enabled:true,teleop:true,commandFresh:true,zone:'opponent',poseTrusted:true,poseAgeSec:.01,alliance:'blue',...extra});
const feed=(p,t,extra={})=>p.ingest(JSON.stringify(sample({sequence:t+1,...extra})),t,true);
test('strict schema refuses unknown and malformed telemetry',()=>{
  assert.equal(parseDriverView('{}'),null);
  for(const bad of [{poseAgeSec:-1},{poseTrusted:1},{robotRelativeVyMps:null},{zone:'own'},{sequence:1.5},{alliance:'pink'}])assert.equal(parseDriverView(JSON.stringify(sample(bad))),null);
});
for(const alliance of ['red','blue'])for(const zone of ['neutral','opponent'])test(`${alliance} ${zone}: robot-relative left, right, reverse`,()=>{
  for(const [view,motion] of [['left',{}],['right',{robotRelativeVyMps:-1}],['rear',{robotRelativeVxMps:-1,robotRelativeVyMps:0}]]) {
    const p=createSurroundPolicy();feed(p,0,{alliance,zone,...motion});assert.equal(p.update(0).view,null);
    feed(p,200,{alliance,zone,...motion});assert.equal(p.update(200).view,zone==='opponent'?view:null);
  }
});
test('home, unknown pose/alliance, stale pose, disabled and auto never open automatically',()=>{
  for(const invalid of [{commandFresh:false},{zone:'neutral'},{zone:'home'},{zone:'unknown'},{poseTrusted:false},{poseAgeSec:.6},{alliance:'unknown'},{enabled:false},{teleop:false}]) {
    const p=createSurroundPolicy();feed(p,0,invalid);p.update(0);feed(p,200,invalid);assert.equal(p.update(200).view,null);
  }
});
test('stale receipt and disconnect close immediately inside minimum hold',()=>{
  const p=createSurroundPolicy();feed(p,0);p.update(0);feed(p,200);assert.equal(p.update(200).view,'left');
  assert.equal(p.update(701).view,null);assert.equal(p.update(701).zone,'unknown');
  feed(p,800);p.update(800);feed(p,1000);assert.equal(p.update(1000).view,'left');p.ingest(null,1001,false);assert.equal(p.update(1001).view,null);
});
test('replayed cached state cannot refresh authority',()=>{
  const p=createSurroundPolicy(),json=JSON.stringify(sample());p.ingest(json,0,true);p.update(0);p.ingest(json,200,true);p.update(200);p.ingest(json,600,true);assert.equal(p.update(600).view,null);
});
test('hysteresis and minimum hold prevent camera chatter',()=>{
  const p=createSurroundPolicy();feed(p,0);p.update(0);feed(p,200);p.update(200);
  feed(p,300,{robotRelativeVyMps:.22});assert.equal(p.update(300).view,'left');
  feed(p,400,{robotRelativeVyMps:-1});assert.equal(p.update(400).view,'left');
  feed(p,650,{robotRelativeVyMps:-1});assert.equal(p.update(650).view,'left');
  feed(p,900,{robotRelativeVyMps:-1});assert.equal(p.update(900).view,'right');
  feed(p,901,{zone:'home'});assert.equal(p.update(901).view,null);
});
test('manual everywhere, off, and dismissed auto suppressed until motion ends',()=>{
 const p=createSurroundPolicy();p.choose('all');feed(p,0,{zone:'home'});assert.equal(p.update(0).view,'all');assert.equal(p.update(5000).view,'all');
 p.choose('off');assert.equal(p.update(5001).view,null);p.choose('auto');feed(p,5100);p.update(5100);feed(p,5300);assert.equal(p.update(5300).view,'left');
 p.dismiss();feed(p,5500);assert.equal(p.update(5500).view,null);feed(p,5600,{robotRelativeVyMps:0});p.update(5600);feed(p,5700);p.update(5700);feed(p,5900);assert.equal(p.update(5900).view,'left');
});
test('camera roster refuses duplicate physical roles',()=>{
 const p='/Catalyst/Numbers/Cameras/'; const values={[p+'left/Role']:{t:'str',v:'left'},[p+'left/StreamUrl']:{t:'str',v:'http://10.1.1.12:5800/'}};
 assert.equal(cameraRoster(values).left.url,'http://10.1.1.12:5800/');values[p+'duplicate/Role']={t:'str',v:'left'};assert.equal(cameraRoster(values).left.ambiguous,true);
});

test('older out-of-order state never renews receipt freshness',()=>{
 const p=createSurroundPolicy();feed(p,0,{sequence:100});p.update(0);feed(p,200,{sequence:101});assert.equal(p.update(200).view,'left');
 feed(p,650,{sequence:100});assert.equal(p.update(701).view,null);
 p.ingest(null,800,false);feed(p,900,{sequence:1});p.update(900);feed(p,1100,{sequence:2});assert.equal(p.update(1100).view,'left');
});

for(const alliance of ['red','blue'])test(`${alliance}: entering neutral closes immediately despite motion and minimum hold`,()=>{
 const p=createSurroundPolicy();feed(p,0,{alliance});p.update(0);feed(p,200,{alliance});assert.equal(p.update(200).view,'left');
 feed(p,201,{alliance,zone:'neutral'});assert.equal(p.update(201).view,null);assert.equal(p.update(201).zone,'neutral');
 feed(p,202,{alliance,zone:'home'});assert.equal(p.update(202).view,null);
});
import {CAMERA_ANCHORS,cameraAnchors,nearestCameraAnchor} from './surround-position.js';
test('camera snap placements remain inside the field and below top readouts',()=>{
 for(const [w,h]of [[360,510],[460,690]]){const anchors=cameraAnchors(w,h,320,180);for(const key of CAMERA_ANCHORS){const p=anchors[key];assert.ok(p.left>=12&&p.top>=150);assert.ok(p.left+320<=w-12&&p.top+180<=h-12);assert.equal(nearestCameraAnchor(p.left,p.top,anchors),key);}}
});
