export const CAMERA_ANCHORS=['lower-left','upper-left','lower-right'];
export function cameraAnchors(width,height,cardWidth,cardHeight){
 const left=12,right=Math.max(left,width-cardWidth-12),bottom=Math.max(12,height-cardHeight-12);
 // Upper placements stay below the driving speed/pose readouts.
 return {'lower-left':{left,top:bottom},'upper-left':{left,top:Math.min(bottom,150)},'lower-right':{left:right,top:bottom}};
}
export function nearestCameraAnchor(left,top,anchors){return CAMERA_ANCHORS.reduce((best,key)=>Math.hypot(left-anchors[key].left,top-anchors[key].top)<Math.hypot(left-anchors[best].left,top-anchors[best].top)?key:best,CAMERA_ANCHORS[0]);}
