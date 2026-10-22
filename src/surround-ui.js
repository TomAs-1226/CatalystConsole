import {createSurroundPolicy, cameraRoster, DRIVER_VIEW_STATE, ROLES, NOMINAL_MOUNTS, projectionColumn, smallSeams} from './surround.js';
export function createSurroundView({invoke}) {
  const policy = createSurroundPolicy();
  const root = document.createElement('section'); root.className = 'surround'; root.setAttribute('aria-label','Driver cameras');
  root.innerHTML = `<div class="surround-tools"><b>Cameras</b><select aria-label="Driver camera view"><option value="auto">Automatic</option><option value="all">Three views</option><option value="panorama">Panorama</option><option value="left">Left</option><option value="rear">Rear</option><option value="right">Right</option><option value="off">Off</option></select><span class="surround-zone">Zone unknown</span></div><div class="surround-panel" hidden><header><strong>Driver view</strong><button type="button" aria-label="Dismiss driver cameras">Close</button></header><div class="surround-panorama" hidden><div class="surround-directions"><span>Forward</span><span>Right</span><span>Rear</span><span>Left</span><span>Forward</span></div><canvas width="960" height="240" aria-label="Approximate cylindrical panorama with uncovered angles marked"></canvas><p>Approximate panorama · blended seams (estimated pixels) · nominal lens and mounts</p></div><div class="surround-frames"></div><p>Small gaps blended for display · front not covered · check raw views</p><details><summary>Camera orientation</summary><p>Check against the physical robot before driving. Images are uncalibrated.</p><div class="surround-orientation"></div></details></div>`;
  document.querySelector('.views').append(root);
  const dock=document.querySelector('.dock');
  const tools=root.querySelector('.surround-tools');
  if(dock)dock.insertBefore(tools,document.querySelector('#rttChip'));
  const modeSelect=tools.querySelector('select');
  const panel=root.querySelector('.surround-panel'), frames=root.querySelector('.surround-frames'), zone=tools.querySelector('.surround-zone');
  const slots = {}, prefs = {};
  try { Object.assign(prefs,JSON.parse(localStorage.getItem('catalyst.console.cameraOrientation') || '{}')); } catch {}
  for (const role of ROLES) {
    const figure=document.createElement('figure'); figure.innerHTML=`<figcaption>${role === 'rear' ? 'Rear / shooter' : role[0].toUpperCase()+role.slice(1)} <span>Not configured</span></figcaption><div class="surround-image"><img alt="${role} camera" hidden/><div class="surround-empty">No image</div></div>`;
    frames.append(figure);
    slots[role]={figure,img:figure.querySelector('img'),status:figure.querySelector('span'),empty:figure.querySelector('.surround-empty'),busy:false,next:0,url:null,blob:null,last:-Infinity,mount:{...NOMINAL_MOUNTS[role]},rotate:0,mirror:false};
    const label=document.createElement('label'); label.textContent=role+' ';
    const rotate=document.createElement('select'); rotate.setAttribute('aria-label',`${role} camera rotation`);
    for (const deg of [0,90,180,270]) { const o=document.createElement('option');o.value=deg;o.textContent=`${deg}°`;rotate.append(o); }
    rotate.value=[0,90,180,270].includes(prefs[role]?.rotate) ? prefs[role].rotate : 0;
    const mirror=document.createElement('input');mirror.type='checkbox';mirror.checked=prefs[role]?.mirror === true;
    const yaw=document.createElement('input');yaw.type='number';yaw.min='0';yaw.max='359';yaw.step='1';yaw.value=Number.isFinite(prefs[role]?.yaw)?prefs[role].yaw:NOMINAL_MOUNTS[role].yaw;yaw.setAttribute('aria-label',`${role} camera mount yaw degrees`);
    const hfov=document.createElement('input');hfov.type='number';hfov.min='10';hfov.max='170';hfov.value=Number.isFinite(prefs[role]?.hfov)?prefs[role].hfov:82;hfov.setAttribute('aria-label',`${role} camera horizontal field of view degrees`);
    const save=()=>{const mount={yaw:Math.max(0,Math.min(359,Number(yaw.value))),hfov:Math.max(10,Math.min(170,Number(hfov.value)))};slots[role].mount=mount;slots[role].rotate=Number(rotate.value);slots[role].mirror=mirror.checked;prefs[role]={rotate:Number(rotate.value),mirror:mirror.checked,...mount};slots[role].img.style.transform=`rotate(${rotate.value}deg) scaleX(${mirror.checked?-1:1})`;try{localStorage.setItem('catalyst.console.cameraOrientation',JSON.stringify(prefs));}catch{}};
    rotate.onchange=save;mirror.onchange=save;yaw.onchange=save;hfov.onchange=save;save(); label.append(rotate,mirror,document.createTextNode(' Mirror · yaw '),yaw,document.createTextNode('° · HFOV '),hfov,document.createTextNode('°')); root.querySelector('.surround-orientation').append(label);
  }
  modeSelect.onchange=e=>policy.choose(e.target.value);
  panel.querySelector('button').onclick=()=>{policy.dismiss();modeSelect.value='auto';};
  function clear(s,message) { if(s.blob)URL.revokeObjectURL(s.blob);s.blob=null;s.img.removeAttribute('src');s.img.hidden=true;s.empty.hidden=false;s.status.textContent=message; }
  const panorama=root.querySelector('.surround-panorama'), canvas=panorama.querySelector('canvas'),ctx=canvas.getContext('2d');
  const sources={}; for(const role of ROLES)sources[role]=document.createElement('canvas');
  let drawnAt=-Infinity;
  function drawPanorama(now) {
    if(now-drawnAt<150)return;drawnAt=now;
    const w=canvas.width,h=canvas.height,covered=new Uint8Array(w),edges=new Array(w);
    ctx.fillStyle='#080808';ctx.fillRect(0,0,w,h);
    // Stripes persist wherever no recent camera pixels establish coverage.
    ctx.strokeStyle='#29292b';ctx.lineWidth=1;
    for(let x=-h;x<w;x+=14){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+h,h);ctx.stroke();}
    for(const role of ROLES){
      const s=slots[role];if(now-s.last>500||!s.img.complete||!s.img.naturalWidth||s.img.hidden)continue;
      const oriented=sources[role],orientedCtx=oriented.getContext('2d');
      const iw=s.img.naturalWidth,ih=s.img.naturalHeight,quarter=s.rotate%180!==0;
      oriented.width=quarter?ih:iw;oriented.height=quarter?iw:ih;
      orientedCtx.save();orientedCtx.translate(oriented.width/2,oriented.height/2);orientedCtx.rotate(s.rotate*Math.PI/180);orientedCtx.scale(s.mirror?-1:1,1);orientedCtx.drawImage(s.img,-iw/2,-ih/2);orientedCtx.restore();
      for(let x=0;x<w;x++){
        const p=projectionColumn((360-(x+.5)/w*360)%360,s.mount,oriented.width,oriented.height,w);
        if(!p||covered[x])continue;covered[x]=1;edges[x]={role,u:p.u,height:p.height};
        ctx.fillStyle='#000';ctx.fillRect(x,0,1,h);
        ctx.drawImage(oriented,Math.min(oriented.width-1,Math.max(0,p.u*oriented.width)),0,1,oriented.height,x,(h-p.height)/2,1,p.height);
      }
    }
    for(const seam of smallSeams(covered)){
      const a=edges[seam.start-1],b=edges[seam.end];
      if(!a||!b||a.role===b.role)continue;
      for(let x=seam.start;x<seam.end;x++){
        const t=(x-seam.start+.5)/(seam.end-seam.start),dh=a.height*(1-t)+b.height*t;
        ctx.fillStyle='#000';ctx.fillRect(x,0,1,h);
        ctx.globalCompositeOperation='lighter';
        for(const [edge,alpha]of [[a,1-t],[b,t]]){
          const source=sources[edge.role];ctx.globalAlpha=alpha;
          ctx.drawImage(source,Math.max(0,Math.min(source.width-1,edge.u*source.width)),0,1,source.height,x,(h-dh)/2,1,dh);
        }
        ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';covered[x]=2;
      }
      ctx.strokeStyle='#aaa';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo((seam.start+seam.end)/2,h-22);ctx.lineTo((seam.start+seam.end)/2,h);ctx.stroke();ctx.setLineDash([]);
    }
    ctx.fillStyle='#a0a0a5';ctx.font='14px sans-serif';ctx.textAlign='center';
    let start=0;while(start<w){if(covered[start]){start++;continue;}let end=start;while(end<w&&!covered[end])end++;if(end-start>40)ctx.fillText('No coverage',(start+end)/2,h/2);start=end;}
  }
  return {
    ingest(values,connected,now) {if (!connected || Object.hasOwn(values,DRIVER_VIEW_STATE)) policy.ingest(values[DRIVER_VIEW_STATE]?.v,now,connected);},
    paint(values,now) {
      const state=policy.update(now),roster=cameraRoster(values);panel.hidden=!state.view;
      zone.textContent=state.zone === 'unknown' ? 'Zone unknown' : `${state.zone === 'home' ? 'Home' : state.zone[0].toUpperCase()+state.zone.slice(1)} zone`;
      panel.querySelector('strong').textContent=`Driver view · ${state.manual?'manual':state.view || ''} · ${zone.textContent}`;
      frames.dataset.view=state.view || '';
      panorama.hidden=state.view!=='panorama';frames.hidden=state.view==='panorama';
      for(const role of ROLES) {
        const s=slots[role],cam=roster[role],visible=state.view && (state.view==='all'||state.view==='panorama'||state.view===role) && !document.hidden;
        s.figure.hidden=!visible;
        if(!visible){s.url=null;clear(s,'Paused');continue;}
        if(!cam||cam.ambiguous||!cam.url){s.url=null;clear(s,cam?.ambiguous?'Camera role ambiguous':'Not configured');continue;}
        if(s.url!==cam.url){s.url=cam.url;s.last=-Infinity;clear(s,'Connecting');}
        if(now-s.last>500)clear(s,s.last===-Infinity?'No recent image':'Image stale');
        if(!invoke){s.status.textContent='Video requires desktop Console';continue;}
        if(s.busy||now<s.next)continue;
        s.busy=true;s.next=now+(state.view==='all'||state.view==='panorama'?350:150);
        const url=s.url;
        invoke('camera_frame',{url}).then(bytes=>{
          if(s.url!==url)return;
          const blob=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/jpeg'}));
          if(s.blob)URL.revokeObjectURL(s.blob);s.blob=blob;s.img.src=blob;s.img.hidden=false;s.empty.hidden=true;s.last=performance.now();s.status.textContent='Recent image · orientation unverified';
        }).catch(()=>{if(s.url===url){clear(s,'Unavailable');s.next=performance.now()+1500;}}).finally(()=>{s.busy=false;});
      }
      if(state.view==='panorama')drawPanorama(now);
    },
  };
}
