import {DRIVER_VIEW_STATE,ROLES} from './surround.js';
/* Explicit camera-only illustration loop. It does not fabricate a live camera or robot connection. */
export function cameraDemoAt(seconds) {
  const t=((seconds%24)+24)%24;
  const phase=t<5?'left':t<10?'right':t<15?'rear':t<20?'home':'unknown';
  return {phase,zone:phase==='home'?'home':phase==='unknown'?'unknown':phase==='rear'?'opponent':'neutral',
    vx:phase==='rear'?-1:0,vy:phase==='right'?-1:1,
    description:phase==='home'?'Home zone · automatic view suppressed':phase==='unknown'?'Unknown pose · automatic view suppressed':phase==='rear'?'Opponent zone · reversing':`Neutral zone · strafing ${phase}`};
}
export function cameraDemoValues(seconds) {
  const scenario=cameraDemoAt(seconds),values={};
  for(const role of ROLES){const prefix=`/Catalyst/Numbers/Cameras/demo-${role}/`;values[prefix+'Role']={t:'str',v:role};values[prefix+'StreamUrl']={t:'str',v:`demo://${role}`};}
  values[DRIVER_VIEW_STATE]={t:'str',v:JSON.stringify({schemaVersion:1,sequence:Math.max(0,Math.floor(seconds*10)),robotRelativeVxMps:scenario.vx,robotRelativeVyMps:scenario.vy,robotRelativeOmegaRadps:0,commandFresh:true,enabled:true,teleop:true,zone:scenario.zone,poseTrusted:scenario.zone!=='unknown',poseAgeSec:0,alliance:'blue'})};
  return {values,scenario};
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
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.7));
    if(!blob)throw Error('demo image unavailable');return blob.arrayBuffer();
  };
}
