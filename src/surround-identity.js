// Status comes from the actual stream host, not its configured IP/name in robot telemetry.
export function createCameraIdentityGate(read,clock=()=>performance.now()) {
  const entries=new Map();
  return {
    check(url,expected) {
      const key=JSON.stringify([url,expected]),now=clock();
      let entry=entries.get(key);
      if(!entry){entry={allowed:false,message:'Checking camera identity',checked:-Infinity,pending:false};entries.set(key,entry);}
      if(now-entry.checked>6000){entry.allowed=false;entry.message='Camera identity unverified';}
      if(!entry.pending&&now-entry.checked>=5000){
        entry.pending=true;entry.checked=now;
        Promise.resolve().then(()=>read(url)).then(name=>{
          entry.allowed=name===expected;
          entry.message=entry.allowed?'Identity verified':`Wrong camera: ${String(name).slice(0,128)} (expected ${expected})`;
        }).catch(()=>{entry.allowed=false;entry.message='Camera identity unavailable';}).finally(()=>{entry.pending=false;});
      }
      return entry;
    },
    clear(){entries.clear();},
  };
}
