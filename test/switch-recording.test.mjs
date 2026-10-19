import test from 'node:test';
import assert from 'node:assert/strict';
import { SwitchRecording } from '../src/switch-recording.mjs';
import { defer } from './helpers.mjs';
function fixture(overrides={}) {
 const calls=[]; let scene='Original', active=false, muted=false, tick, callback, lost;
 const obs={close(){},async assertOutputsStopped(){if(active)throw Error('active')},async call(type,data){calls.push([type,data]);
  if(type==='GetCurrentProgramScene')return {currentProgramSceneName:scene};
  if(type==='SetCurrentProgramScene'){scene=data.sceneName;return {}}
  if(type==='GetSpecialInputs')return {mic1:'Mic'};
  if(type==='GetInputMute')return {inputMuted:muted};
  if(type==='SetInputMute'){muted=data.inputMuted;return {}}
  if(type==='StartRecord'){active=true;return {}}
  if(type==='GetRecordStatus')return {outputActive:active};
  if(type==='StopRecord'){active=false;return {outputPath:'/tmp/switch-test.mkv'}};
  throw Error(type);
 }};
 const rec=new SwitchRecording({obs,validate:async()=>({sceneName:'Switch'}),watch:async(o,cb,lose)=>{callback=cb;lost=lose;return ()=>{}},setTimer:fn=>{tick=fn;return 1},clearTimer:()=>{tick=null},...overrides});
 return {rec,obs,calls,get scene(){return scene},get muted(){return muted},get active(){return active},tick:()=>tick?.(),event:d=>callback(d),lost:()=>lost(),setActive:a=>{active=a},setScene:s=>{scene=s}};
}
test('30 second test mutes global audio, records only Switch and restores original scene/audio',async()=>{
 const f=fixture();const start=await f.rec.start();assert.equal(start.remainingSeconds,30);assert.equal(f.scene,'Switch');assert.equal(f.muted,true);assert.equal(f.active,true);
 f.tick();await new Promise(r=>setImmediate(r));assert.equal(f.active,false);assert.equal(f.scene,'Original');assert.equal(f.muted,false);assert.equal(f.rec.snapshot().path,'/tmp/switch-test.mkv');assert.equal(f.rec.state,'completed');
 assert.equal(f.calls.filter(([t])=>t==='StartRecord').length,1);assert.equal(f.calls.filter(([t])=>t==='StopRecord').length,1);
});
test('reserves start before awaiting validation; duplicate start does not record',async()=>{
 const gate=defer(), f=fixture({validate:()=>gate.promise});const p=f.rec.start();await assert.rejects(()=>f.rec.start());gate.resolve({sceneName:'Switch'});await p;await f.rec.stop();assert.equal(f.calls.filter(([t])=>t==='StartRecord').length,1);
});
test('existing output rejects setup before scene or microphone mutation',async()=>{
 const f=fixture();f.setActive(true);await assert.rejects(()=>f.rec.start());assert.equal(f.calls.length,0);assert.equal(f.scene,'Original');assert.equal(f.muted,false);
});
test('external stop revokes recording ownership; subsequent OBS recording is never stopped',async()=>{
 const f=fixture();await f.rec.start();f.setActive(false);f.event({outputState:'OBS_WEBSOCKET_OUTPUT_STOPPED',outputPath:'/tmp/partial.mkv'});await new Promise(r=>setImmediate(r));f.setActive(true);await f.rec.stop();assert.equal(f.calls.filter(([t])=>t==='StopRecord').length,0);
});
test('connection loss leaves recording unconfirmed and does not stop a later unrelated output',async()=>{
 const f=fixture();await f.rec.start();f.lost();assert.equal(f.rec.state,'unconfirmed');await f.rec.stop();await assert.rejects(()=>f.rec.start());await assert.rejects(()=>f.rec.reconcile());assert.equal(f.calls.filter(([t])=>t==='StopRecord').length,0);
 f.setActive(false);await f.rec.reconcile();assert.equal(f.rec.state,'stopped');assert.equal(f.scene,'Original');assert.equal(f.muted,false);
});
test('unknown recording status is unconfirmed and never sends StopRecord',async()=>{
 const f=fixture();await f.rec.start();const call=f.obs.call;f.obs.call=(t,d)=>t==='GetRecordStatus'?{}:call(t,d);await f.rec.stop();assert.equal(f.rec.state,'unconfirmed');assert.equal(f.calls.filter(([t])=>t==='StopRecord').length,0);
});
test('operator scene change is preserved at test end',async()=>{
 const f=fixture();await f.rec.start();f.setScene('Manual');await f.rec.stop();assert.equal(f.scene,'Manual');assert.equal(f.muted,false);
});
test('failed record start restores scene and audio; paths must be OBS absolute movie output',async()=>{
 const f=fixture(), call=f.obs.call;f.obs.call=(t,d)=>{if(t==='StartRecord')throw Error('encoder');return call(t,d)};await assert.rejects(()=>f.rec.start());assert.equal(f.scene,'Original');assert.equal(f.muted,false);assert.equal(f.rec.state,'failed');
 for(const p of ['../secret.mp4','/tmp/key.json','/tmp/a\n.mp4'])f.rec.acceptFile(p);assert.equal(f.rec.file,null);
});
test('failed restoration retains recovery provenance and blocks another start until restored',async()=>{
 const f=fixture();await f.rec.start();f.lost();f.setActive(false);const call=f.obs.call;f.obs.call=(t,d)=>{if(t==='SetCurrentProgramScene')throw Error('failed');return call(t,d)};
 await f.rec.reconcile();assert.equal(f.rec.state,'unconfirmed');assert.match(f.rec.error,/復元できません/);assert.equal(f.rec.previousScene,'Original');await assert.rejects(()=>f.rec.start());
 f.obs.call=call;await f.rec.reconcile();assert.equal(f.rec.state,'stopped');assert.equal(f.rec.error,'');assert.equal(f.scene,'Original');assert.equal(f.muted,false);
});
test('watch loss after final stop check cannot start an unmonitored recording',async()=>{
 const f=fixture(), checked=f.obs.assertOutputsStopped;let checks=0;f.obs.assertOutputsStopped=async()=>{await checked();if(++checks===4)f.lost()};
 await assert.rejects(()=>f.rec.start());assert.equal(f.calls.filter(([t])=>t==='StartRecord').length,0);assert.equal(f.active,false);
});
test('mute applied but missing acknowledgement remains in restoration ledger',async()=>{
 const f=fixture(),call=f.obs.call;let fail=true;f.obs.call=async(t,d)=>{const result=await call(t,d);if(t==='SetInputMute'&&d.inputMuted&&fail){fail=false;throw Error('lost acknowledgement')}return result};
 await assert.rejects(()=>f.rec.start());assert.equal(f.muted,false);assert.ok(f.calls.some(([t,d])=>t==='SetInputMute'&&!d.inputMuted));
});
