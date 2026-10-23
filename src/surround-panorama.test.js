import test from 'node:test';
import assert from 'node:assert/strict';
import {panoramaSample,panoramaYaw,PANORAMA} from './surround-panorama.js';
import {NOMINAL_MOUNTS} from './surround.js';
const sector=['right','rear','left'];
const point=(index,yaw,up)=>[(index+(NOMINAL_MOUNTS[sector[index]].yaw+35-yaw)/70)/3,.5-(up-PANORAMA.centerElevation)/PANORAMA.verticalSpan];
test('pitch-correct projection maps each optical axis to source centre and preserves raw orientation',()=>{
 for(let i=0;i<3;i++){
  const m=NOMINAL_MOUNTS[sector[i]],p=panoramaSample(...point(i,m.yaw,Math.tan(m.pitch*Math.PI/180)),m);
  assert.ok(Math.abs(p.u-.5)<1e-10);assert.ok(Math.abs(p.v-.5)<1e-10);
  const left=panoramaSample(...point(i,m.yaw+20,.3),m),right=panoramaSample(...point(i,m.yaw-20,.3),m);assert.ok(left.u<right.u);
 }
});
test('every pixel in compact nominal sectors has an actually observed source ray',()=>{
 for(let i=0;i<3;i++)for(let x=0;x<400;x++)for(let y=0;y<240;y++)assert.ok(panoramaSample((i*400+x+.5)/1200,(y+.5)/240,NOMINAL_MOUNTS[sector[i]]),i+':'+x+','+y);
});
test('two marked seams skip exactly20degrees instead of duplicating unseen scene pixels',()=>{
 for(const seam of [1/3,2/3])assert.ok(Math.abs(panoramaYaw(seam-1e-8)-panoramaYaw(seam+1e-8)-20)<1e-4);
 assert.equal(panoramaYaw(0),305);assert.equal(panoramaYaw(1),55);
 for(const m of [NOMINAL_MOUNTS.left,NOMINAL_MOUNTS.right])assert.equal(panoramaSample(.5,.5,m),null,'missing rear never filled by sides');
});
test('vertical source bounds and camera fields reject unseen rays without edge clamping',()=>{
 const m=NOMINAL_MOUNTS.rear;assert.equal(panoramaSample(.5,-2,m),null);assert.equal(panoramaSample(.5,.5,{...m,hfov:180}),null);
 const a=panoramaSample(.5,.5,m,4/3),b=panoramaSample(.5,.5,m,16/10);assert.deepEqual(a,b,'resizing a stream cannot change physical camera lens coverage');
});
