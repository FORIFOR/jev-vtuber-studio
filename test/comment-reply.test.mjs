import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Jev } from '../src/jev.mjs';
import { CommentVoice, SupertonicVoice, ReplyVoice } from '../src/voice-routing.mjs';
import { rehearse, saveSettings, publicSettings } from '../src/settings.mjs';
import { config } from '../src/config.mjs';
import { hostMouthLevel, roleLabel } from '../public/speech-role.mjs';
import { setup, ledger, audit, active, defer, wav, response, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';
const audio = () => ({ kind: 'wav', durationMs: 200, bytes: wav(.2) });
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), 'condition settled'); }
function fixture(t, overrides = {}, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'true', ...env });
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, readAllowed: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => '私は机を残したいな。いろいろな作業ができるから。' },
        voice: { synthesize: async () => audio() }, commentVoice: { synthesize: async () => audio() }, ...overrides }));
    e.director.opened = true; t.after(() => e.stop()); return e;
}
async function select(e, text = 'どの家具が好き?') { const r = e.ingest({ text, author: 'viewer' }); assert.equal(r.accepted, true); await e.classify(e.epoch, e.controller.signal); return e.candidates[0]; }
async function send(e) { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); return e.pending; }
function ack(e, event) { const p=e.pending; return e.acknowledge({ id: p.id, lease: e.renderer.lease, event }); }
async function play(e) { const p=await send(e); assert.ok(p); ack(e,'started'); ack(e,'ended'); return p; }

test('dual voice defaults enabled in product config, old fixtures explicitly opt out', t => {
    const c = config({ DATA_DIR: setup(t).dataDir }, []);
    assert.equal(c.readComments,true); assert.equal(c.replyTtsProvider,'voicevox'); assert.equal(c.supertonicVoice,'F1');
});
test('comment readout begins while response model is still blocked, no sound loopback', async t => {
    const d=defer(), inputs=[]; let readInput;
    const e=fixture(t,{conversation:{generate:ctx=>{inputs.push(ctx);return d.promise;}},commentVoice:{synthesize:async text=>{readInput=text;return audio();}}});
    await select(e); e.startPrefetch(e.epoch,e.controller.signal); await until(()=>e.prepared);
    const task=e.preparationTask; const p=await send(e);
    assert.equal(p.role,'comment'); assert.equal(p.text,'コメント。どの家具が好き?'); assert.equal(inputs[0].comment,'どの家具が好き?');
    assert.equal(inputs[0].commentReadByNarrator,true); assert.equal(typeof readInput,'string'); assert.equal(e.currentTurn.replyReady,false);
    ack(e,'started'); ack(e,'ended'); assert.equal(e.memory.items.length,0); assert.equal(e.pending,null);
    await send(e); assert.equal(e.pending,null,'host cannot start before generated and approved');
    d.resolve('私は机が好き。'); await task;
    const reply=await play(e); assert.equal(reply.role,'host'); assert.equal(reply.text,'私は机が好き。');
    assert.deepEqual(e.memory.items.map(x=>x.text),['私は机が好き。']); assert.equal(e.stats.commentsRead,1);
    assert.equal(e.metrics.snapshot().latency.comment_to_answer_ms.samples,1); assert.equal(e.metrics.snapshot().latency.comment_to_read_ms.samples,1);
    assert.equal(e.metrics.snapshot().latency.read_to_reply_gap_ms.samples,1);
});
test('fast reply is queued behind narrator, never played over it',async t=>{
    const e=fixture(t);await select(e);await e.prepare(e.epoch,e.controller.signal);await until(()=>e.prepared?.parts[2]?.audio);
    assert.equal((await send(e)).role,'comment'); const id=e.pending.id;
    ack(e,'started');await send(e);assert.equal(e.pending.id,id);
    ack(e,'ended');assert.equal((await play(e)).role,'host');assert.equal((await play(e)).role,'host');
    assert.equal(e.metrics.counters.comment_completed,1);assert.equal(e.director.dialogue.length,1);
    assert.equal(e.director.dialogue[0].comment,'どの家具が好き?');
});
test('quote-unsafe but discussable comments use answer-only flow',async t=>{
    let reads=0; const e=fixture(t,{jev:{chat:async()=>({accept:true,readAllowed:false,action:'reply'}),speech:async()=>({accept:true,effect:'none',mood:'warm'})},commentVoice:{synthesize:async()=>{reads++;return audio();}}});
    await select(e);await e.prepare(e.epoch,e.controller.signal);const p=await send(e);
    assert.equal(reads,0);assert.equal(p.role,'host');assert.equal(p.comment,null);
});
test('no read permission is fail-closed, not default true',async t=>{
    const e=fixture(t,{jev:{chat:async()=>({accept:true,action:'reply'}),speech:async()=>({accept:true})}});
    const c=await select(e);assert.equal(c.readAllowed,false);assert.equal(e.canReadCandidate(c),false);
});
test('overlength, URL and unsafe local comments are not narrated',t=>{
    const e=fixture(t); for (const text of ['a'.repeat(121),'https://example.com','<laugh>']) assert.equal(e.canReadCandidate({readAllowed:true,text}),false);
});
test('turned-off readout never invokes narrator',async t=>{
    let n=0;const e=fixture(t,{commentVoice:{synthesize:async()=>{n++;return audio();}}},{READ_COMMENTS:'false'});
    await select(e);await e.prepare(e.epoch,e.controller.signal);assert.equal((await send(e)).role,'host');assert.equal(n,0);
});
test('raw rejected comment never reaches LLM or either TTS',async t=>{
    let calls=0;const e=fixture(t,{jev:{chat:async()=>({accept:false,readAllowed:false,reason:'unsafe'})},commentVoice:{synthesize:async()=>{calls++;}},conversation:{generate:async()=>{calls++;}}});
    await select(e);assert.equal(e.candidates.length,0);assert.equal(calls,0);
});
test('host output rejection after narration does not synthesize rejected text or reread comment',async t=>{
    const gate=defer();let hostCalls=0;
    const e=fixture(t,{jev:{chat:async()=>({accept:true,readAllowed:true,action:'reply'}),speech:()=>gate.promise},voice:{synthesize:async()=>{hostCalls++;return audio();}}});
    const m=await select(e);e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);await play(e);
    gate.resolve({accept:false});await e.preparationTask;await send(e);
    assert.equal(hostCalls,0);assert.equal(m.replyState,'dropped');assert.equal(e.candidates.length,0);assert.equal(e.pending,null);
});
test('stop during narrator cancels late response without duplicate audio',async t=>{
    const d=defer();let hostCalls=0;const e=fixture(t,{conversation:{generate:()=>d.promise},voice:{synthesize:async()=>{hostCalls++;return audio();}}});
    const m=await select(e);e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);await send(e);ack(e,'started');
    const task=e.preparationTask;e.stop();d.resolve('古い回答です。');await task;
    assert.equal(e.pending,null);assert.equal(e.audio.size,0);assert.equal(hostCalls,0);assert.equal(e.candidates.length,0);assert.equal(m.replyState,'dropped');
});
test('topic changes cannot sever a published read-comment/reply interaction',async t=>{
    const d=defer();const e=fixture(t,{conversation:{generate:()=>d.promise}});const m=await select(e);
    e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);await play(e);e.nextTopic();
    d.resolve('その家具もいいね。');await e.preparationTask;assert.equal((await play(e)).text,'その家具もいいね。');
    assert.equal(m.replyState,'completed');assert.equal(e.candidates.length,0);
});
test('unpublished narrated candidate requeues once on topic cancellation',async t=>{
    const d=defer();const e=fixture(t,{conversation:{generate:()=>d.promise}});const m=await select(e);
    e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);const task=e.preparationTask;
    e.nextTopic();e.nextTopic();assert.equal(e.candidates.filter(x=>x.id===m.id).length,1);
    d.resolve('古い回答です。');await task;assert.equal(e.prepared,null);assert.equal(e.pending,null);
});
test('expired comment is dropped before narrator starts',async t=>{
    const e=fixture(t);const m=await select(e);await e.prepare(e.epoch,e.controller.signal);m.created-=70000;
    await send(e);assert.equal(e.pending,null);assert.equal(m.replyState,'dropped');
});
test('narration does not increment the host answer metric or fill host memory',async t=>{
    const e=fixture(t);await select(e);await e.prepare(e.epoch,e.controller.signal);await play(e);
    assert.equal(e.memory.items.length,0);assert.equal(e.stats.spoken,0);assert.equal(e.turn,0);
    assert.equal(e.metrics.snapshot().latency.comment_to_answer_ms,undefined);
});
test('narration and selected candidates share the bounded reply reservation',async t=>{
    const d=defer();let n=0;const e=fixture(t,{conversation:{generate:()=>d.promise},jev:{chat:async()=>{n++;return{accept:true,readAllowed:true,action:'reply'};}}});
    await select(e);e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);await send(e);ack(e,'started');
    for(let i=0;i<12;i++)e.ingest({text:`家具の話${i}`,author:`v${i}`});
    for(let i=0;i<12;i++)await e.classify(e.epoch,e.controller.signal);
    assert.equal(n,2);assert.equal(e.candidateSlotsUsed(),2);const task=e.preparationTask;e.stop();d.resolve('古い回答。');await task;
});
test('comment voice failure does not emit a half-constructed interaction',async t=>{
    const e=fixture(t,{commentVoice:{synthesize:async()=>{throw new Error('offline');}}});const m=await select(e);
    await e.prepare(e.epoch,e.controller.signal);assert.equal(e.prepared,null);assert.equal(e.pending,null);assert.equal(m.replyState,'selected');assert.ok(e.generationRetryAt>Date.now());
});
test('comment duration is bounded independently of reply duration',async t=>{
    const e=fixture(t,{commentVoice:{synthesize:async()=>({...audio(),durationMs:21000})}});await select(e);await e.prepare(e.epoch,e.controller.signal);
    assert.equal((await send(e)).role,'host');assert.equal(e.generationRetryAt,0);assert.equal(e.metrics.counters.comment_read_skipped_duration,1);
});
test('Jev batches quote permission with adoption but treats them independently',async t=>{
    const c=setup(t,{LLM_MODEL:'fixture'});c.mode='live';let questions;
    const j=new Jev(c,ledger(),audit,async(_u,o)=>{
        questions=judgeRequest(JSON.parse(o.body)).questions;
        const answers=Object.fromEntries(Object.entries(questions).map(([k,q])=>[k,q.type==='noul'?{type:'noul',noul:k==='read_safe'?.1:['private','injection'].includes(k)?.01:.99}:choiceAnswer(q.criteria,'reply')]));
        return response(judgeResponse(answers));
    });
    const r=await j.chat('普通のコメント');assert.equal(r.accept,true);assert.equal(r.readAllowed,false);assert.ok(questions.read_safe);
});
test('CommentVoice uses narrator ID and speed, host settings are unchanged',async t=>{
    const c=setup(t,{COMMENT_VOICEVOX_SPEAKER:'8',COMMENT_VOICEVOX_SPEED:'1.2'});c.mode='live';const calls=[];
    const v=new CommentVoice(c,ledger(),async(u,o)=>{calls.push([u,o]);return u.includes('audio_query')?response({}):new Response(wav());});
    await v.synthesize('コメント。こんにちは。');assert.match(calls[0][0],/speaker=8/);assert.equal(JSON.parse(calls[1][1].body).speedScale,1.2);assert.equal(c.speaker,3);
});
test('Supertonic uses native Japanese v3 endpoint and rejects wrong model',async t=>{
    const c=setup(t,{REPLY_TTS_PROVIDER:'supertonic'});c.mode='live';let model='supertonic-3',body;const l=ledger();
    const v=new SupertonicVoice(c,l,async(u,o)=>u.endsWith('/health')?response({status:'ok',model}):(body=JSON.parse(o.body),new Response(wav())));
    const a=await v.synthesize('こんにちは。');assert.equal(a.kind,'wav');assert.equal(body.lang,'ja');assert.equal(body.voice,'F1');assert.equal(body.response_format,'wav');
    await v.synthesize('こんにちは。');assert.equal(l.calls.tts,1);model='supertonic-2';await assert.rejects(v.synthesize('次の発言。'),/Supertonic 3/);assert.equal(l.calls.tts,1);
});
test('Supertonic errors/invalid WAV never fall back to different voices',async t=>{
    const c=setup(t,{REPLY_TTS_PROVIDER:'supertonic'});c.mode='live';const urls=[];
    const v=new ReplyVoice(c,ledger(),async u=>{urls.push(u);return u.endsWith('/health')?response({status:'ok',model:'supertonic-3'}):new Response('not a WAV');});
    await assert.rejects(v.synthesize('テスト。'),/WAV/);assert.ok(urls.every(u=>u.includes(':7788')));
});
test('Supertonic aborted request cannot cache or return late audio',async t=>{
    const c=setup(t);c.mode='live';const d=defer(),ac=new AbortController();
    const v=new SupertonicVoice(c,ledger(),async u=>u.endsWith('/health')?response({status:'ok',model:'supertonic-3'}):d.promise);
    const p=v.synthesize('発言。',ac.signal);await tick();ac.abort();d.resolve(new Response(wav()));await assert.rejects(p);assert.equal(v.cache.size,0);
});
test('audio roles suppress host mouth motion for both avatar modes',()=>{
    assert.equal(hostMouthLevel('comment',.9),0);assert.equal(hostMouthLevel('host',.9),.9);
    assert.equal(roleLabel('comment','ノア'),'コメント読み上げ');assert.equal(roleLabel('host','ノア'),'ノア');
});
test('new settings persist without exposing keys and reject unsafe destinations',t=>{
    const c=setup(t);saveSettings(c,{values:{READ_COMMENTS:true,REPLY_TTS_PROVIDER:'supertonic',SUPERTONIC_VOICE:'F2',COMMENT_VOICEVOX_SPEAKER:7}});
    assert.equal(c.replyTtsProvider,'supertonic');assert.equal(c.readComments,true);assert.equal(c.commentSpeaker,7);assert.equal(publicSettings(c).values.SUPERTONIC_VOICE,'F2');
    assert.throws(()=>saveSettings(c,{values:{SUPERTONIC_URL:'http://evil.example'}}));assert.throws(()=>saveSettings(c,{values:{SUPERTONIC_VOICE:'../../private'}}));
});
test('dual rehearsal reports narrator failure, not partial success',async t=>{
    const c=setup(t,{READ_COMMENTS:'true'});c.mode='live';const deps={conversation:{generate:async()=> '机が好きです。'},jev:{speech:async()=>({accept:true})},voice:{synthesize:async()=>audio()},commentVoice:{synthesize:async()=>{throw new Error('offline');}}};
    const r=await rehearse(c,ledger(),audit,deps);assert.equal(r.ok,false);assert.equal(r.checks.at(-1).ok,false);assert.match(r.checks.at(-1).name,/コメント/);
    deps.commentVoice.synthesize=async()=>audio();const ok=await rehearse(c,ledger(),audit,deps);assert.ok(ok.commentAudio.bytes);assert.equal(ok.heard,false);
});

test('real 200ms audio worker keeps narrator responsive while answer is unresolved',async t=>{
    const d=defer();const e=fixture(t,{conversation:{generate:()=>d.promise}});await select(e);
    e.worker(()=>e.speakStep(e.epoch,e.controller.signal),200,e.epoch,e.controller.signal);
    const start=Date.now();while(!e.pending&&Date.now()-start<1800)await new Promise(r=>setTimeout(r,15));
    assert.equal(e.pending?.role,'comment');ack(e,'started');ack(e,'ended');
    await new Promise(r=>setTimeout(r,450));assert.equal(e.pending,null);assert.equal(e.currentTurn.replyReady,false);
    d.resolve('机がいいと思う。');
    const until=Date.now()+1800;while(!e.pending&&Date.now()<until)await new Promise(r=>setTimeout(r,15));
    assert.equal(e.pending?.role,'host');ack(e,'started');ack(e,'ended');
});
test('failed answer cannot start a speculative unrelated turn during narrator playback',async t=>{
    const gate=defer();let generations=0;const e=fixture(t,{conversation:{generate:()=>{generations++;return gate.promise;}}});
    await select(e);e.startPrefetch(e.epoch,e.controller.signal);await until(()=>e.prepared);await send(e);ack(e,'started');
    gate.reject(new Error('offline'));await e.preparationTask;
    for(let i=0;i<5;i++)await send(e);
    assert.equal(generations,1);assert.equal(e.pending.role,'comment');ack(e,'ended');await send(e);assert.equal(e.pending,null);
});


test('already rejected reply is not announced by reading the comment unnecessarily',async t=>{
    const read=defer();const e=fixture(t,{conversation:{generate:async()=>{throw new Error('offline');}},commentVoice:{synthesize:()=>read.promise}});
    const m=await select(e);e.startPrefetch(e.epoch,e.controller.signal);await tick();read.resolve(audio());await e.preparationTask;
    assert.equal(e.prepared,null);assert.equal(e.pending,null);assert.equal(m.replyState,'selected');assert.ok(e.generationRetryAt>Date.now());
});
test('long narration falls back to host-only without losing second sentence',async t=>{
    const e=fixture(t,{commentVoice:{synthesize:async()=>({...audio(),durationMs:21000})}});const m=await select(e);await e.prepare(e.epoch,e.controller.signal);
    await until(()=>e.prepared.parts[1]?.audio);assert.equal((await play(e)).role,'host');assert.equal((await play(e)).role,'host');
    assert.equal(m.replyState,'completed');assert.equal(e.stats.commentsRead,undefined);assert.equal(e.generationFailures,0);
});
