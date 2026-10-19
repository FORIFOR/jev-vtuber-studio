import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryGuard, readMemory} from '../src/memory-guard.mjs';
test('start requires normal pressure and 25 percent headroom', async()=>{
 let v={pressureLevel:1,freePercent:40};const g=new MemoryGuard({enabled:true,read:async()=>v});
 await g.assertStart();for(const p of [{pressureLevel:1,freePercent:24},{pressureLevel:2,freePercent:39},{pressureLevel:4,freePercent:30}]){v=p;await assert.rejects(()=>g.assertStart(),{code:'MEMORY_UNSAFE'});}g.close();
});
test('sustained warning closes after 30s; recovery resets warning',async()=>{
 let t=0,freePercent=19;const events=[];const g=new MemoryGuard({enabled:true,now:()=>t,read:async()=>({pressureLevel:1,freePercent}),onCritical:s=>events.push(s)});
 await g.sample();t=29000;await g.sample();assert.equal(events.length,0);t=30000;await g.sample();await g.sample();assert.equal(events.length,1);
 freePercent=40;await g.sample();freePercent=19;t=40000;await g.sample();assert.equal(events.length,1);g.close();
});
test('critical pressure requests closing once; emergency escalates immediately',async()=>{
 let freePercent=9;const events=[];const g=new MemoryGuard({enabled:true,read:async()=>({pressureLevel:1,freePercent}),onCritical:s=>events.push(s)});
 await g.sample();assert.equal(events[0].immediate,false);freePercent=4;await g.sample();assert.equal(events[1].immediate,true);await g.sample();assert.equal(events.length,2);g.close();
});
test('failed probe blocks starts and persistent unknown triggers safe closing',async()=>{
 let t=0,n=0;const g=new MemoryGuard({enabled:true,now:()=>t,read:async()=>{throw Error('unavailable')},onCritical:()=>n++});
 await assert.rejects(()=>g.assertStart());t=30000;await g.sample();assert.equal(n,1);g.close();
});
test('sampling is single flight and close suppresses late callbacks',async()=>{
 let done,n=0;const g=new MemoryGuard({enabled:true,read:()=>new Promise(r=>done=r),onChange:()=>n++});const a=g.sample(),b=g.sample();g.close();done({pressureLevel:4,freePercent:1});await Promise.all([a,b]);assert.equal(n,0);
});

test('HTTP start is denied before rehearsal; critical memory stops show and owned output',async(t)=>{
 const {createApp}=await import('../src/server.mjs');const {setup}=await import('./helpers.mjs');
 const c=setup(t,{MEMORY_GUARD:'1'});c.mode='live';let freePercent=19,stops=0,rehearsals=0;
 const app=createApp(c,{remoteOptions:null,memoryRead:async()=>({pressureLevel:1,freePercent}),obs:{owned:false,ready:false,stopOwned:async()=>{stops++},close(){}},conversation:{generate:async()=>{rehearsals++;throw Error('Must not call')}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
 const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/control`,{method:'POST',headers:{Authorization:`Bearer ${c.adminToken}`,'Content-Type':'application/json'},body:JSON.stringify({action:'start'})});
 assert.equal(r.status,409);assert.match((await r.json()).error,/メモリ/);assert.equal(rehearsals,0);assert.equal(app.engine.running,false);
 let closing;app.engine.running=true;app.engine.requestBudgetClose=reason=>{closing=reason};freePercent=9;await app.memory.sample();assert.equal(closing,'memory_pressure');
 freePercent=4;await app.memory.sample();assert.equal(app.engine.running,false);assert.ok(stops>0);
});

test('OS warning with ample indicator is recorded as sustained warning, not OS critical', async () => {
 let t=0;const events=[];const g=new MemoryGuard({enabled:true,now:()=>t,read:async()=>({pressureLevel:2,freePercent:34}),onCritical:s=>events.push(s)});
 await g.sample();t=30000;await g.sample();assert.equal(events.length,1);assert.equal(events[0].reason,'sustained_warning');assert.equal(events[0].pressureLevel,2);assert.equal(events[0].warningMs,30000);g.close();
});

test('memory guard: a macOS level 2 that outlives the pressure (>= 40% free) is normal; with less headroom it still warns', async () => {
    let v = { pressureLevel: 2, freePercent: 48 };
    const g = new MemoryGuard({ enabled: true, read: async () => v, now: () => 0 });
    assert.equal((await g.sample()).level, 'normal');
    await g.assertStart();
    v = { pressureLevel: 2, freePercent: 35 };
    assert.equal((await g.sample()).level, 'warning');
    await assert.rejects(() => g.assertStart(), e => e.code === 'MEMORY_UNSAFE');
    v = { pressureLevel: 4, freePercent: 60 };
    assert.notEqual((await g.sample()).level, 'normal', 'level 4 is never normal');
});
