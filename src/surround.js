/* Read-only driver view policy. All times below use the receiving browser's monotonic clock. */
export const DRIVER_VIEW_STATE = '/Catalyst/Numbers/DriverView/State';
export const ROLES = ['left', 'rear', 'right'];
export function parseDriverView(json) {
  try {
    const s = JSON.parse(json);
    return s?.schemaVersion === 1 && Number.isSafeInteger(s.sequence) && s.sequence >= 0
      && ['home','neutral','opponent','unknown'].includes(s.zone)
      && ['red','blue','unknown'].includes(s.alliance)
      && [s.robotRelativeVxMps,s.robotRelativeVyMps,s.robotRelativeOmegaRadps,s.poseAgeSec].every(Number.isFinite)
      && s.poseAgeSec >= 0 && ['enabled','teleop','poseTrusted','commandFresh'].every(k => typeof s[k] === 'boolean') ? s : null;
  } catch { return null; }
}
export function createSurroundPolicy() {
  let sample = null, sequence = null, received = -Infinity, selected = null, candidate = null;
  let candidateAt = 0, selectedAt = 0, manual = 'auto', suppressed = false;
  return {
    ingest(json, now, connected) {
      if (!connected) { sample = null; sequence = null; received = -Infinity; selected = null; candidate = null; return; }
      const next = parseDriverView(json);
      if (!next) { sample = null; return; }
      if (sequence === null || next.sequence > sequence) { sample = next; sequence = next.sequence; received = now; }
    },
    reset() { sample=null;sequence=null;received=-Infinity;selected=null;candidate=null;candidateAt=0;selectedAt=0;suppressed=false; },
    choose(mode) { if (['auto','off','all','panorama',...ROLES].includes(mode)) { manual = mode; selected = null; candidate = null; suppressed = false; } },
    dismiss() { manual = 'auto'; selected = null; candidate = null; suppressed = true; },
    update(now) {
      const fresh = sample && now >= received && now - received <= 500;
      const trusted = fresh && sample.poseTrusted && sample.poseAgeSec <= .5 && ['red','blue'].includes(sample.alliance) && sample.zone !== 'unknown';
      const allowed = trusted && sample.enabled && sample.teleop && sample.commandFresh && ['neutral','opponent'].includes(sample.zone);
      const zone = trusted ? sample.zone : 'unknown';
      let wanted = null;
      if (allowed) {
        const vx = sample.robotRelativeVxMps, vy = sample.robotRelativeVyMps;
        const threshold = selected ? .18 : .30;
        if (vx < -threshold && -vx >= Math.abs(vy)) wanted = 'rear';
        else if (Math.abs(vy) > threshold) wanted = vy > 0 ? 'left' : 'right';
      }
      if (!wanted) suppressed = false;
      if (manual !== 'auto') return { view: manual === 'off' ? null : manual, manual: true, zone };
      // Loss of authority closes immediately, even inside the minimum hold.
      if (!allowed || suppressed) { selected = null; candidate = null; return {view:null,manual:false,zone}; }
      if (wanted !== candidate) { candidate = wanted; candidateAt = now; }
      if (wanted !== selected && now - candidateAt >= 180 && (!selected || now - selectedAt >= 650)) {
        selected = wanted; selectedAt = now;
      }
      return {view:selected,manual:false,zone};
    },
  };
}
export function cameraRoster(values) {
  const found = {};
  for (const [key, value] of Object.entries(values)) {
    const m = key.match(/^\/Catalyst\/Numbers\/Cameras\/([^/]+)\/Role$/);
    if (!m || value?.t !== 'str' || !ROLES.includes(value.v)) continue;
    const prefix = `/Catalyst/Numbers/Cameras/${m[1]}/`;
    const url = values[prefix+'StreamUrl'];
    // Duplicate roles are ambiguous; never silently select a different physical camera.
    found[value.v] = found[value.v] ? {ambiguous:true} : {name:m[1],url:url?.t === 'str' ? url.v : '',prefix};
  }
  return found;
}

export const NOMINAL_MOUNTS = {left:{yaw:90,hfov:82},rear:{yaw:180,hfov:82},right:{yaw:270,hfov:82}};
// Robot yaw: forward 0, left 90, rear 180, right 270 degrees. Panorama x increases leftward
// around the robot. A raw camera image's right edge has DECREASING robot yaw (camera looks out).
export function projectionColumn(yaw, mount, width, height, panoramaWidth) {
  if (!mount || ![yaw,mount.yaw,mount.hfov,width,height,panoramaWidth].every(Number.isFinite)
      || mount.hfov < 10 || mount.hfov > 170 || width <= 0 || height <= 0 || panoramaWidth <= 0) return null;
  const delta = ((yaw - mount.yaw + 540) % 360) - 180;
  if (Math.abs(delta) > mount.hfov/2) return null;
  const angle=delta*Math.PI/180, tanHalf=Math.tan(mount.hfov*Math.PI/360);
  const u=(1-Math.tan(angle)/tanHalf)/2;
  // Driver display uses level rectangular strips; only horizontal rays are rectified.
  return {u, height:panoramaWidth/4};
}

// Estimated display pixels only: bridge a small angular hole when real pixels bound BOTH edges.
export function smallSeams(coverage, maxDegrees=12) {
  const seams=[];let start=0;
  while(start<coverage.length){if(coverage[start]){start++;continue;}let end=start;while(end<coverage.length&&!coverage[end])end++;
    if(start>0&&end<coverage.length&&(end-start)/coverage.length*360<=maxDegrees)seams.push({start,end});
    start=end;
  }
  return seams;
}
