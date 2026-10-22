import assert from 'node:assert/strict';
import test from 'node:test';
import {createSurroundView} from './surround-ui.js';
import {createDemoCameraRenderer} from './surround-demo.js';
test('actual Auto Demo view keeps generated pixels through left/right intent transitions without idle encoding',{timeout:1000},async()=>{
const originalDocument=globalThis.document,originalStorage=globalThis.localStorage,originalPerformance=globalThis.performance;
let clock=0,frames=0;
Object.defineProperty(globalThis,'performance',{value:{now:()=>clock},configurable:true});
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.style={};this.dataset={};this.attributes={};this.hidden=false;this.value='';this.parent=null;}
 setAttribute(k,v){this.attributes[k]=v;if(k==='class')this.className=v;if(k==='value')this.value=v;if(k==='hidden')this.hidden=true;}
 removeAttribute(k){delete this.attributes[k];if(k==='src')this._src='';}
 get src(){return this._src||'';}set src(value){this._src=value;this.complete=true;this.naturalWidth=640;this.naturalHeight=360;}
 append(...nodes){for(const n of nodes){if(n.parent)n.parent.children=n.parent.children.filter(x=>x!==n);n.parent=this;this.children.push(n);}}
 insertBefore(n,b){this.append(n);}
 all(){return this.children.flatMap(n=>[n,...n.all()]);}
 matches(sel){return sel[0]==='.'?(this.className||'').split(' ').includes(sel.slice(1)):sel[0]==='#'?this.attributes.id===sel.slice(1):this.tagName===sel;}
 querySelector(sel){return this.all().find(n=>n.matches(sel))||null;}
 querySelectorAll(sel){return this.all().filter(n=>n.matches(sel));}
 getBoundingClientRect(){return this.className==='fieldcanvas'?{left:12,top:50,width:360,height:510}:{left:0,top:46,width:1100,height:540};}
 set innerHTML(text){this.children=[];const stack=[this];for(const match of text.matchAll(/<\/?([\w-]+)([^>]*)>|([^<]+)/g)){if(match[3])continue;const closing=match[0][1]==='/';if(closing){if(stack.length>1)stack.pop();continue;}const n=new Element(match[1]);for(const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))n.setAttribute(attr[1],attr[2]??'');stack.at(-1).append(n);if(n.tagName==='option'&&stack.at(-1).tagName==='select'&&!stack.at(-1).value)stack.at(-1).value=n.value;if(!['img','input','br','hr','meta','link'].includes(n.tagName)&&!match[0].endsWith('/>'))stack.push(n);}}
 getContext(){return new Proxy({},{get:()=>()=>{}});}
 toBlob(){}
 toDataURL(){frames++;return 'data:image/jpeg;base64,/9j/2Q==';}
 setPointerCapture(){}
}
const body=new Element('body'),views=new Element('div'),field=new Element('canvas');views.className='views';field.className='fieldcanvas';body.append(views);views.append(field);
globalThis.document={hidden:false,createElement:t=>new Element(t),createTextNode:t=>new Element('#text'),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s)};
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
try {
const jpeg=await createDemoCameraRenderer()('left',0);assert.deepEqual([...new Uint8Array(jpeg)],[255,216,255,217]);
const view=createSurroundView({invoke:()=>{throw Error('Live IPC during demo');}});view.setDemo(true,0);
const context={pose:[3,6.2,0],alliance:'red',enabled:true,teleop:true,velocity:[0,1,0]};
for(clock=0;clock<=1600;clock+=100){view.paint({},clock,context);await new Promise(setImmediate);if(clock>=300){const images=body.querySelectorAll('img').filter(i=>!i.hidden);assert.equal(images.length,1,`no visible auto image at ${clock}`);assert.ok(images[0].src);}}
assert.ok(frames>=5);
context.velocity=[0,-1,0];
for(clock=1800;clock<=2800;clock+=100){view.paint({},clock,context);await new Promise(setImmediate);if(clock>=2100){const shown=body.querySelectorAll('img').filter(i=>!i.hidden);assert.equal(shown.length,1);assert.equal(shown[0].attributes.alt,'right camera');assert.ok(shown[0].src);}}
context.pose=[8,6.2,0];clock=2900;view.paint({},clock,context);assert.equal(body.querySelector('.surround-panel').hidden,true,'neutral closes without retaining a camera');
}finally{globalThis.document=originalDocument;globalThis.localStorage=originalStorage;Object.defineProperty(globalThis,'performance',{value:originalPerformance,configurable:true});}
});
