import {DRIVER_VIEW_STATE,ROLES,NOMINAL_MOUNTS} from './surround.js';
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
    // All three images observe the SAME illustrative world through their own pinhole mounts.
    // This makes pitch rectification and the shared horizon inspectable without real camera IPC.
    const mount=NOMINAL_MOUNTS[role],yaw=mount.yaw*Math.PI/180,pitch=mount.pitch*Math.PI/180;
    const fx=w/(2*Math.tan(mount.hfov*Math.PI/360)),fy=h/(2*Math.tan(mount.vfov*Math.PI/360));
    const ox=Math.sin(t*.3)*.6,oy=Math.cos(t*.3)*.6;
    const project=([x,y,z])=>{
      x-=ox;y-=oy;z-=.45;
      const forward=x*Math.cos(yaw)+y*Math.sin(yaw),right=x*Math.sin(yaw)-y*Math.cos(yaw);
      const depth=forward*Math.cos(pitch)+z*Math.sin(pitch),up=z*Math.cos(pitch)-forward*Math.sin(pitch);
      return depth>.2?[w/2+fx*right/depth,h/2-fy*up/depth]:null;
    };
    const line=(a,b)=>{const p=project(a),q=project(b);if(!p||!q)return;ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(...q);ctx.stroke();};
    ctx.fillStyle='#303035';ctx.fillRect(0,0,w,h);
    const horizon=h/2+fy*Math.tan(pitch);
    ctx.fillStyle='#505054';ctx.fillRect(0,horizon,w,h-horizon);
    ctx.strokeStyle='#939398';ctx.lineWidth=1;
    for(let a=-24;a<=24;a+=2)for(let b=-24;b<24;b+=.5){line([a,b,0],[a,b+.5,0]);line([b,a,0],[b+.5,a,0]);}
    for(let i=0;i<12;i++){
      const angle=(i*30+10)*Math.PI/180,cx=Math.cos(angle)*12,cy=Math.sin(angle)*12,dx=-Math.sin(angle)*.8,dy=Math.cos(angle)*.8;
      const corners=[[cx-dx,cy-dy,0],[cx+dx,cy+dy,0],[cx+dx,cy+dy,2],[cx-dx,cy-dy,2]].map(project);
      if(corners.some(p=>!p))continue;
      ctx.beginPath();ctx.moveTo(...corners[0]);for(const p of corners.slice(1))ctx.lineTo(...p);ctx.closePath();ctx.fillStyle='#19191b';ctx.fill();ctx.strokeStyle='#ddd';ctx.lineWidth=2;ctx.stroke();
      const label=project([cx,cy,1.25]);ctx.fillStyle='#eee';ctx.font='18px sans-serif';ctx.textAlign='center';ctx.fillText(`TEST ${i+1}`,...label);ctx.textAlign='start';
    }
    // This small DEMO illustration is encoded in the paint turn. Chromium may defer toBlob's
    // idle callback behind the 3D scene long enough to miss a short automatic intent window.
    const encoded=canvas.toDataURL('image/jpeg',.7).split(',')[1];
    if(!encoded)throw Error('demo image unavailable');
    return Uint8Array.from(atob(encoded),byte=>byte.charCodeAt(0)).buffer;
  };
}
