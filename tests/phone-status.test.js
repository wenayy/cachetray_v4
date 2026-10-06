const test = require('node:test');

const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(macs, hash = ''){
const elements=new Map(), intervals=new Map(), events=new Map(), state={macs,fail:false};
function element(){const classes=new Set();return{children:[],hidden:true,dataset:{},textContent:'',
classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),toggle(v,on){if(on)classes.add(v);else classes.delete(v);},contains:v=>classes.has(v)},
setAttribute(){},addEventListener(){},querySelectorAll:()=>[],append(...children){this.children.push(...children);},appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}};}
const node=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
const context={console,URL,URLSearchParams,AbortController,
navigator:{userAgent:'Android',platform:'Linux',onLine:true},
localStorage:{getItem:key=>key==='cachetray_phone_device_v1'?JSON.stringify({deviceId:'pixel',deviceToken:'token',name:'Pixel'}):null,setItem(){}},
document:{hidden:false,getElementById:node,createElement:element,addEventListener(){}},location:{hash},
setInterval(callback,period){intervals.set(period,callback);return period;},clearInterval(){},
setTimeout:()=>1,clearTimeout(){},confirm:()=>true,CACHE_TRAY_TRANSFER_API:'https://worker.example',matchMedia:()=>({matches:!hash}),
addEventListener(type,callback){events.set(type,callback);},
async fetch(url,options){if(state.fail)throw new Error('Network failed');
if(options.method==='DELETE'){state.macs=state.macs.filter(mac=>!url.endsWith('/pairings/'+mac.id));return Response.json({disconnected:true});}
if(url.endsWith('/clips'))return Response.json({items:[],pairedMacs:macs});
return Response.json({transfers:[],pairedMacs:state.macs});}
};context.window=context;vm.runInNewContext(fs.readFileSync('cachetraywebsite/received.js','utf8'),context);
return{node,state,context,intervals,events};
}
test('phone UI active status, disconnect, stale responses, offline recovery and selective cleanup', async()=>{
let h=harness(Array.from({length:6},(_,id)=>({id:'mac-'+id,name:'Mac Chrome',online:id===0})));
await new Promise(setImmediate);assert.equal(h.node('pairStatus').textContent,'Connected to Mac Chrome ✓');
const reconnects = harness(Array.from({length:3},(_,id)=>({id:'reconnect-'+id,name:'Mac Chrome',online:true})));
await new Promise(setImmediate);assert.equal(reconnects.node('pairStatus').textContent,'Connected ✓');
assert.doesNotMatch(reconnects.node('pairStatus').textContent,/3 Macs/);
h.state.macs=[];await h.intervals.get(2500)();assert.equal(h.node('pairStatus').textContent,'No Mac connected');
await h.intervals.get(15000)();assert.equal(h.node('pairStatus').textContent,'No Mac connected');
h=harness([{id:'mac',name:'Mac',online:true}]);await new Promise(setImmediate);
h.context.navigator.onLine=false;h.events.get('offline')();assert.match(h.node('pairStatus').textContent,/Phone offline/);
assert.equal(h.node('pairStatus').classList.contains('connected'),false);
h.context.navigator.onLine=true;h.state.fail=true;await h.intervals.get(2500)();assert.match(h.node('pairStatus').textContent,/Connection unavailable/);
h.state.fail=false;await h.intervals.get(2500)();assert.equal(h.node('pairStatus').textContent,'Connected to Mac ✓');
h=harness([{id:'old',name:'Mac Chrome',online:false},{id:'current',name:'Mac Chrome',online:true}]);await new Promise(setImmediate);
await h.node('macConnections').children[0].children[1].onclick();assert.equal(h.state.macs.length,1);assert.equal(h.state.macs[0].id,'current');
console.log('Phone UI checks passed: no inflated count; disconnect; stale-response protection; offline/error recovery; selective cleanup.');
});
test('install QR destination opens Android instructions with a separate pairing step', async () => {
  const h = harness([], '#install');
  await new Promise(setImmediate);
  assert.equal(h.node('installGuide').hidden, false);
  assert.match(h.node('installInstructions').textContent, /Chrome on Android/);
  assert.match(h.node('installInstructions').textContent, /scan step 2/);
});
