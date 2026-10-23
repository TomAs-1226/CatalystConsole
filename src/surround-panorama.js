// Compact observed sectors: yaw jumps over omitted angles at the two marked seams.
export const PANORAMA = {start:305, span:210, seamGap:20, verticalSpan:.76, centerElevation:.30, width:1200, height:240};
const radians = Math.PI / 180;
export function panoramaYaw(x) {return PANORAMA.start-x*PANORAMA.span-Math.min(2,Math.floor(x*3))*PANORAMA.seamGap;}
export function panoramaSample(x,y,mount,aspect=PANORAMA.width/PANORAMA.height) {
  const {yaw,hfov,vfov=56.2,pitch=0}=mount||{};
  if(![x,y,yaw,hfov,vfov,pitch,aspect].every(Number.isFinite)||hfov<10||hfov>170||vfov<10||vfov>170||aspect<=0)return null;
  const delta=(panoramaYaw(x)-yaw)*radians;
  const up=(.5-y)*PANORAMA.verticalSpan+PANORAMA.centerElevation;
  const forward=Math.cos(delta),p=pitch*radians;
  const z=forward*Math.cos(p)+up*Math.sin(p);
  const cy=up*Math.cos(p)-forward*Math.sin(p);
  if(z<=0)return null;
  const u=.5-Math.sin(delta)/(2*Math.tan(hfov*radians/2)*z);
  const v=.5-cy/(2*Math.tan(vfov*radians/2)*z);
  return u>=0&&u<=1&&v>=0&&v<=1?{u,v}:null;
}

export function createPanoramaRenderer(canvas) {
  const gl=canvas.getContext('webgl',{alpha:false,depth:false,antialias:false,preserveDrawingBuffer:true});
  if(!gl)return null;
  const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  const vertex=compile(gl.VERTEX_SHADER,'attribute vec2 position; varying vec2 point; void main(){point=vec2((position.x+1.0)*.5,(1.0-position.y)*.5);gl_Position=vec4(position,0,1);}');
  const fragment=compile(gl.FRAGMENT_SHADER,`precision highp float;
varying vec2 point;
uniform float aspect;
${[0,1,2].map(i=>`uniform sampler2D image${i}; uniform vec4 mount${i}; uniform float fresh${i};`).join('\n')}
vec3 ray(vec4 mount){
 float angle=radians(${PANORAMA.start}.0-point.x*${PANORAMA.span}.0-min(2.0,floor(point.x*3.0))*${PANORAMA.seamGap}.0)-mount.x;
 float up=(.5-point.y)*${PANORAMA.verticalSpan}+${PANORAMA.centerElevation};
 float z=cos(angle)*cos(mount.y)+up*sin(mount.y);
 float cy=up*cos(mount.y)-cos(angle)*sin(mount.y);
 vec2 uv=vec2(.5-sin(angle)/(2.0*mount.z*z),.5-cy/(2.0*mount.w*z));
 float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
 return vec3(uv,z>0.0&&edge>=0.0?smoothstep(0.0,.035,edge):0.0);
}
void main(){vec3 color=vec3(0);float weight=0.0;
${[0,1,2].map(i=>`{vec3 p=ray(mount${i});float w=p.z*fresh${i};color+=texture2D(image${i},clamp(p.xy,0.0,1.0)).rgb*w;weight+=w;}`).join('\n')}
 if(abs(point.x-1.0/3.0)<.0005||abs(point.x-2.0/3.0)<.0005)gl_FragColor=vec4(.55,.55,.55,1);
 else if(weight>0.00001)gl_FragColor=vec4(color/weight,1);
 else {float stripe=step(.86,fract((gl_FragCoord.x+gl_FragCoord.y)/18.0));gl_FragColor=vec4(vec3(.035+stripe*.065),1);}
}`);
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
  const entries=[0,1,2].map(i=>{
    gl.activeTexture(gl.TEXTURE0+i);const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
    gl.uniform1i(gl.getUniformLocation(program,`image${i}`),i);
    return {texture,mount:gl.getUniformLocation(program,`mount${i}`),fresh:gl.getUniformLocation(program,`fresh${i}`)};
  });
  return {render(sources){
    if(gl.isContextLost())return false;
    gl.useProgram(program);gl.viewport(0,0,canvas.width,canvas.height);gl.uniform1f(gl.getUniformLocation(program,'aspect'),canvas.width/canvas.height);
    for(let i=0;i<3;i++){
      const source=sources[i],entry=entries[i],m=source?.mount||{yaw:0,pitch:0,hfov:82,vfov:56.2};
      gl.uniform4f(entry.mount,m.yaw*radians,(m.pitch||0)*radians,Math.tan(m.hfov*radians/2),Math.tan((m.vfov||56.2)*radians/2));
      gl.uniform1f(entry.fresh,source?1:0);
      if(source){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,entry.texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source.image);}
    }
    gl.drawArrays(gl.TRIANGLES,0,6);return true;
  }};
}
