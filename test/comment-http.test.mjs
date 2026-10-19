import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { setup, wav, choiceAnswer, defer, judgeRequest, judgeResponse } from './helpers.mjs';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function waitFor(fn, ms=3000) { const until=Date.now()+ms; while(Date.now()<until) {if(fn())return;await sleep(15);}assert.ok(fn(),'condition before deadline'); }

test('HTTP: dual trial -> narrator while LLM pending -> Supertonic answer -> hearing reset', async t => {
    const c=setup(t,{SHOW_PROFILE:'talk',READ_COMMENTS:'true',REPLY_TTS_PROVIDER:'supertonic'});
    const calls=[];let blocked=null;
    const providers=http.createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;const b=raw?JSON.parse(raw):{};
        calls.push({path:req.url,body:b});res.setHeader('Content-Type','application/json');
        if(req.url==='/v1/health')return res.end(JSON.stringify({status:'ok',model:'supertonic-3',sample_rate:44100,voices_loaded:10}));
        if(req.url==='/v1/tts'){assert.equal(b.lang,'ja');res.setHeader('Content-Type','audio/wav');return res.end(wav(.2));}
        const judged=req.url.endsWith('/chat/completions')&&judgeRequest(b);
        if(judged)return res.end(JSON.stringify(judgeResponse(Object.fromEntries(Object.entries(judged.questions).map(([k,q])=>[k,q.type==='noul'?{type:'noul',noul:['private','injection','warranted'].includes(k)?0:1}:choiceAnswer(q.criteria,'reply' in q.criteria?'reply':Object.keys(q.criteria)[0])])))));
        if(req.url.endsWith('/chat/completions')){if(blocked)await blocked.promise;return res.end(JSON.stringify({choices:[{message:{content:'私は机を残したいな。'}}]}));}
        if(req.url.startsWith('/audio_query'))return res.end('{}');
        if(req.url.startsWith('/synthesis')){res.setHeader('Content-Type','audio/wav');return res.end(wav(.2));}
        res.statusCode=404;res.end('{}');
    });
    await new Promise(r=>providers.listen(0,'127.0.0.1',r));
    const p=`http://127.0.0.1:${providers.address().port}`;
    Object.assign(c,{mode:'live',llmModel:'fixture',llmURL:p+'/v1',voiceURL:p,supertonicURL:p,port:0});
    Object.assign(c.settingsEnv,{MODE:'live',LLM_MODEL:c.llmModel,LLM_BASE_URL:c.llmURL,VOICEVOX_URL:p,SUPERTONIC_URL:p});
    const app=createApp(c);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const req=(path,data,token=c.adminToken)=>fetch(base+path,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    try {
        const trial=await(await req('/api/setup/rehearse',{confirm:'RUN_CHECK'})).json();
        assert.equal(trial.ok,true);assert.equal(trial.checks.length,4);assert.ok(trial.commentAudio);assert.ok(trial.audio);
        for(const url of[trial.audio,trial.commentAudio]){
            assert.equal((await req(url,null,c.viewToken)).status,401);
            assert.equal(Buffer.from(await(await req(url)).arrayBuffer()).subarray(0,4).toString(),'RIFF');
        }
        assert.equal((await req('/api/setup/heard',{id:trial.id,heard:true})).status,400);
        assert.equal((await req('/api/setup/heard',{id:trial.id,heard:true,commentHeard:true})).status,200);
        // Suppress automatic workers ONLY here; same production controller/HTTP/engine methods are used deterministically.
        app.engine.worker=()=>{};
        assert.equal((await req('/api/control',{action:'start'})).status,200);
        app.engine.director.opened=true;
        const lease=await(await req('/api/renderer/claim',{client:'test-renderer'},c.viewToken)).json();assert.equal(lease.acquired,true);
        const input=await(await req('/api/chat',{text:'家具は何が好き?'})).json();assert.equal(input.accepted,true);
        await app.engine.classify(app.engine.epoch,app.engine.controller.signal);
        blocked=defer();app.engine.startPrefetch(app.engine.epoch,app.engine.controller.signal);
        await waitFor(()=>app.engine.prepared);const task=app.engine.preparationTask;
        const pump=async()=>{app.engine.nextTurnAt=0;await app.engine.speakStep(app.engine.epoch,app.engine.controller.signal);};
        await pump();let pending=app.engine.pending;assert.equal(pending.role,'comment');assert.equal(app.engine.currentTurn.replyReady,false);
        const narratedBody=calls.findLast(x=>x.path.startsWith('/audio_query'));
        assert.match(decodeURIComponent(narratedBody.path),/家具は何が好き/);
        const ack=async(event)=>{const r=await(await req('/api/renderer/ack',{id:app.engine.pending.id,lease:lease.lease,event},c.viewToken)).json();assert.equal(r.ok,true);};
        await ack('started');await ack('ended');await pump();assert.equal(app.engine.pending,null,'no unapproved host output');
        blocked.resolve();blocked=null;await task;await pump();assert.equal(app.engine.pending.role,'host');
        await ack('started');await ack('ended');assert.equal(app.engine.metrics.counters.comment_completed,1);
        assert.equal(calls.filter(x=>x.path==='/v1/tts').length>=1,true);
        assert.equal(app.engine.memory.items.some(x=>x.text.startsWith('コメント。')),false);
        await req('/api/control',{action:'stop'});
        const saved=await(await req('/api/settings',{values:{COMMENT_VOICEVOX_SPEAKER:8}})).json();assert.equal(saved.checksInvalidated,true);
        assert.equal((await req('/api/setup/heard',{id:trial.id,heard:true,commentHeard:true})).status,400);
        assert.equal((await req('/api/control',{action:'start'})).status,200,'a changed comment voice is checked again automatically, no listening asked');
        await req('/api/control',{action:'stop',force:true});
    } finally {blocked?.resolve();await app.close();providers.closeAllConnections();await new Promise(r=>providers.close(r));}
});
