import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { setup, defer } from './helpers.mjs';
async function fixture(t){
 const c=setup(t);let owned=null,current='Original',scans=0,prepares=0,recordStarts=0,recordStops=0,rehearsals=0;
 const switchSetup={read:()=>owned,async status(){return {configured:!!owned,sceneName:owned?.sceneName,output:{state:'stopped',streaming:false,reconnecting:false,recording:false,replayBuffer:false}}},async scan(){scans++;return {videoDevices:[],audioDevices:[]}},async configure(){owned={sceneName:'Switch'};return {configured:true}},async validateConfigured(){if(!owned)throw Object.assign(Error('select devices'),{code:'SWITCH_NOT_CONFIGURED'});return owned}};
 const switchRecording={busy:false,snapshot:()=>({state:'idle',owned:false}),async start(){recordStarts++;return {state:'recording',owned:true}},async stop(){recordStops++;return {state:'idle',owned:false}},async close(){}};
 const obs={owned:false,ready:true,async prepare(){prepares++;return {}},async stopOwned(){},close(){}};
 const switchOBS={async call(type){if(type==='GetCurrentProgramScene')return {currentProgramSceneName:current};if(type==='GetSourceScreenshot')return {imageData:'data:image/jpeg;base64,/9j/2Q=='};throw Error(type)},close(){}};
 const app=createApp(c,{remoteOptions:null,obs,switchOBS,switchSetup,switchRecording,conversation:{async generate(){rehearsals++;throw Error('no external calls')}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
 const request=(path,{token=c.adminToken,data,headers={}}={})=>fetch(base+path,{method:data===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 return {app,c,switchSetup,switchRecording,request,setOwned:()=>{owned={sceneName:'Switch'}},setScene:v=>{current=v},stats:()=>({scans,prepares,recordStarts,recordStops,rehearsals})};
}
test('Switch status/scan/preview/start are admin-only; foreign Origin is denied without effects',async t=>{
 const f=await fixture(t);
 for(const [p,data] of [['/api/switch/status'],['/api/switch/preview'],['/api/switch/devices',{}],['/api/switch/recording/start',{}]])for(const token of ['',f.c.viewToken])assert.equal((await f.request(p,{token,data})).status,401);
 assert.equal((await f.request('/api/switch/devices',{data:{},headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal(f.stats().scans,0);assert.equal(f.stats().recordStarts,0);
});
test('read-only status is not a scan; screenshot only targets configured source',async t=>{
 const f=await fixture(t);const r=await f.request('/api/switch/status');assert.equal(r.status,200);const status=await r.json();assert.equal(status.obs.connected,true);assert.equal(status.obs.replaying,false);assert.equal(f.stats().scans,0);
 assert.equal((await f.request('/api/switch/preview')).status,409);f.setOwned();const image=await f.request('/api/switch/preview?source=unrelated');assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal(image.headers.get('cache-control'),'no-store');
});
test('Switch scan reserves busy across awaits and blocks legacy mutations',async t=>{
 const f=await fixture(t),gate=defer();f.switchSetup.scan=()=>gate.promise;const scan=f.request('/api/switch/devices',{data:{}});await new Promise(r=>setTimeout(r,20));
 for(const [p,data] of [['/api/control',{action:'start'}],['/api/obs/prepare',{}],['/api/setup/rehearse',{confirm:'RUN_CHECK'}],['/api/settings',{values:{}}]])assert.equal((await f.request(p,{data})).status,409);
 gate.resolve({videoDevices:[],audioDevices:[]});assert.equal((await scan).status,200);assert.equal(f.stats().prepares,0);assert.equal(f.stats().rehearsals,0);
});
test('configured but inactive Switch allows normal preparation; selected Switch rejects legacy starts before paid work',async t=>{
 const f=await fixture(t);f.setOwned();assert.equal((await f.request('/api/obs/prepare',{data:{}})).status,200);f.setScene('Switch');
 for(const [p,data] of [['/api/control',{action:'start'}],['/api/obs/prepare',{}],['/api/setup/rehearse',{confirm:'RUN_CHECK'}]])assert.equal((await f.request(p,{data})).status,409);
 assert.equal(f.stats().prepares,1);assert.equal(f.stats().rehearsals,0);assert.equal(f.app.engine.running,false);
});
test('active programme blocks Switch device/record operations; existing record busy blocks preparation',async t=>{
 const f=await fixture(t);f.app.engine.running=true;
 for(const p of ['/api/switch/devices','/api/switch/prepare','/api/switch/recording/start'])assert.equal((await f.request(p,{data:{}})).status,409);
 f.app.engine.running=false;f.switchRecording.busy=true;assert.equal((await f.request('/api/obs/prepare',{data:{}})).status,409);assert.equal(f.stats().scans,0);assert.equal(f.stats().recordStarts,0);
});
test('legacy OBS preparation reserves the operation before awaiting and excludes Switch recording',async t=>{
 const f=await fixture(t),gate=defer();f.app.obs.prepare=()=>gate.promise;const prepare=f.request('/api/obs/prepare',{data:{}});await new Promise(r=>setTimeout(r,20));
 for(const p of ['/api/switch/devices','/api/switch/recording/start'])assert.equal((await f.request(p,{data:{}})).status,409);
 gate.resolve({});assert.equal((await prepare).status,200);assert.equal(f.stats().recordStarts,0);assert.equal((await f.request('/api/switch/devices',{data:{}})).status,200);
});
