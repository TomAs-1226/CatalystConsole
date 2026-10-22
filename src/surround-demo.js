import {DRIVER_VIEW_STATE,ROLES} from './surround.js';
/* Main Demo and camera Demo share the SAME pose, alliance, chassis velocity and robot mode. */
export function cameraDemoAt(context) {
 const pose=context?.pose,alliance=context?.alliance;
 const valid=Array.isArray(pose)&&pose.length>=3&&pose.every(Number.isFinite)&&pose[0]>=0&&pose[0]<=16.541&&pose[1]>=0&&pose[1]<=8.069&&['red','blue'].includes(alliance);
 let zone='unknown';
 if(valid){const blue=pose[0]<4.6256321,red=pose[0]>11.9154321;zone=(alliance==='red'?red:blue)?'home':(alliance==='red'?blue:red)?'opponent':'neutral';}
 const velocity=context?.velocity,finiteMotion=Array.isArray(velocity)&&velocity.length>=3&&velocity.every(Number.isFinite);
 return {zone,alliance:valid?alliance:'unknown',trusted:valid,vx:finiteMotion?velocity[0]:0,vy:finiteMotion?velocity[1]:0,omega:finiteMotion?velocity[2]:0,commandFresh:finiteMotion&&context?.enabled===true&&context?.teleop===true,enabled:context?.enabled===true,teleop:context?.teleop===true};
}
export function cameraDemoValues(seconds,context) {
 const scenario=cameraDemoAt(context),values={};
 for(const role of ROLES){const prefix=`/Catalyst/Numbers/Cameras/demo-${role}/`;values[prefix+'Role']={t:'str',v:role};values[prefix+'StreamUrl']={t:'str',v:`demo://${role}`};}
 values[DRIVER_VIEW_STATE]={t:'str',v:JSON.stringify({schemaVersion:1,sequence:Math.max(0,Math.floor(seconds*10)),robotRelativeVxMps:scenario.vx,robotRelativeVyMps:scenario.vy,robotRelativeOmegaRadps:scenario.omega,commandFresh:scenario.commandFresh,enabled:scenario.enabled,teleop:scenario.teleop,zone:scenario.zone,poseTrusted:scenario.trusted,poseAgeSec:0,alliance:scenario.alliance})};
 return {values,scenario};
}
/* A synchronized teleop camera tour; disabled/autonomous phases remain unchanged. Smooth joins
 * enter the red opponent zone, strafe both ways, reverse, then return to the original match route. */
export function cameraDemoRoute(t,start,end){
 if(!Number.isFinite(t)||t<20||t>56)return null;
 const points=[[20,start],[24,[8,6.2,0]],[28,[3.2,6.2,0]],[32,[3.2,7.4,0]],[36,[3.2,5.8,0]],[40,[1.8,5.8,0]],[48,[8,6.2,0]],[56,end]];
 let i=0;while(i<points.length-2&&t>points[i+1][0])i++;
 const [a,p]=points[i],[b,q]=points[i+1],u=Math.max(0,Math.min(1,(t-a)/(b-a))),f=u*u*(3-2*u),rate=6*u*(1-u)/(b-a);
 const turn=((q[2]-p[2]+Math.PI*3)%(Math.PI*2))-Math.PI;
 return {pose:[p[0]+(q[0]-p[0])*f,p[1]+(q[1]-p[1])*f,p[2]+turn*f],fieldVelocity:{vx:(q[0]-p[0])*rate,vy:(q[1]-p[1])*rate,omega:turn*rate}};
}
/* Epoch isolation also protects against an in-flight real JPEG arriving after Demo is selected. */
export function createCameraFrameSource({live,demo}) {
  let showingDemo=false,epoch=0;
  return {
    setDemo(on){showingDemo=on===true;epoch++;},
    async frame({role,url,now}){
      const requestEpoch=epoch;
      const data=showingDemo?await demo(role,now):await live(url);
      return requestEpoch===epoch?data:null;
    },
  };
}
export function createDemoCameraRenderer() {
  const canvases=new Map();
  return async(role,now)=>{
    let canvas=canvases.get(role);if(!canvas){canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvases.set(role,canvas);}
    const ctx=canvas.getContext('2d'),w=640,h=360,t=now/1000;
    ctx.fillStyle='#242426';ctx.fillRect(0,0,w,h);
    ctx.fillStyle='#404044';ctx.fillRect(0,110,w,h-110);
    ctx.strokeStyle='#77777c';ctx.lineWidth=2;
    const shift=Math.sin(t*.65+(role==='left'?0:role==='right'?2:4))*80;
    for(let x=-700;x<1400;x+=125){ctx.beginPath();ctx.moveTo(320+(x-320)*.1+shift*.2,110);ctx.lineTo(x+shift,h);ctx.stroke();}
    for(let y=0;y<7;y++){const p=((y+t*.5)%7)/7,at=110+p*p*250;ctx.beginPath();ctx.moveTo(0,at);ctx.lineTo(w,at);ctx.stroke();}
    for(let i=0;i<4;i++){const x=((i*210+t*22+(role==='right'?100:0))%840)-100;ctx.fillStyle='#19191b';ctx.fillRect(x,65,95,70);ctx.strokeStyle='#ddd';ctx.strokeRect(x+8,73,79,54);ctx.fillStyle='#ddd';ctx.font='20px sans-serif';ctx.fillText('TEST '+(i+1),x+14,107);}
    ctx.fillStyle='#000';ctx.fillRect(0,0,w,42);ctx.fillStyle='#fff';ctx.font='bold 21px sans-serif';ctx.fillText(`DEMO · ${role.toUpperCase()}`,18,29);
    ctx.fillStyle='#000';ctx.fillRect(0,h-31,w,31);ctx.fillStyle='#ddd';ctx.font='15px sans-serif';ctx.fillText('Generated illustration · not a real camera',18,h-10);
    // This small DEMO illustration is encoded in the paint turn. Chromium may defer toBlob's
    // idle callback behind the 3D scene long enough to miss a short automatic intent window.
    const encoded=canvas.toDataURL('image/jpeg',.7).split(',')[1];
    if(!encoded)throw Error('demo image unavailable');
    return Uint8Array.from(atob(encoded),byte=>byte.charCodeAt(0)).buffer;
  };
}
