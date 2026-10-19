// Explicit local integration check: real Jev and configured local voice, synthetic observations,
// no game launch, no OBS, no platform connection. CLI --run is required for metered gate calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, config } from '../src/config.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { Jev } from '../src/jev.mjs';
import { Ledger, Audit } from '../src/store.mjs';
import { DirectedVoice } from '../src/voice-router.mjs';
if (!process.argv.includes('--run')) { console.log('Use --run for a bounded real-Jev/local-voice verification (no broadcast).'); process.exit(0); }
loadEnv(); const c = config();
assert.equal(c.replyTtsProvider, 'aivisspeech', 'This local probe only permits the configured AivisSpeech voice');
c.dataDir = join(c.dataDir, 'verification', `round-${Date.now()}`); mkdirSync(c.dataDir, {recursive:true, mode:0o700});
c.jevSessionMaxUsd = .02; c.limits = {...c.limits, jev:20, tts:30, llm:1};
const ledger = new Ledger(c.dataDir,c.limits), audit = new Audit(c.dataDir), jev = new Jev(c,ledger,audit), voice = new DirectedVoice(c,ledger);
voice.streamingAllowed=false;
let now=1000; const completed=[], heard=[], gate=[];
const judged={speech:async (...args)=>{const v=await jev.speech(...args);gate.push({text:args[0],event:args[3]?.observation?.eventId,accept:v.accept,reason:v.reason,scores:v.scores});return v;}};
const e=new TalkEngine(c,{ledger,audit,jev:judged,voice,conversation:{generate:async()=>{throw Error('Unexpected generation in review-only test');}},research:{search:async()=>{throw Error('Unexpected search');}}});
e.blocks=new VampireShow({lobbyMinutes:0},{now:()=>now,emit:(type,data)=>{if(type==='round_review_completed')completed.push(data);}});
e.running=true;e.epoch++;e.controller=new AbortController();e.endAt=Date.now()+180000;e.claimRenderer('verification');e.director.opened=true;
const useBrowser = process.argv.includes('--browser-playback');
const token = randomUUID(); let pendingBrowser = null, resolveBrowser = null, browserServer = null;
let browserLabel = '音声準備中';
if (useBrowser) {
 browserServer = http.createServer(async(req,res)=>{
  if(req.headers.host !== '127.0.0.1:8791'){res.writeHead(403).end();return;}
  res.setHeader('Cache-Control','no-store');
  if(req.url === '/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>ノア 再開処理のローカル検証</title><style>body{background:#101729;color:#fff;font:22px system-ui;margin:48px}button{font:inherit;padding:16px}pre{white-space:pre-wrap}audio{width:90%}</style><h1>再開処理のローカル検証</h1><p>外部配信なし・合成ゲーム状態。実音声の再生終了を確認します。</p><button id="go">音声検証を開始</button><p id="status"></p><audio id="voice" controls></audio><pre id="log"></pre><script>const token=${JSON.stringify(token)};let last='';let busy=false;const a=document.querySelector('audio');const log=document.querySelector('#log');async function ack(event){await fetch('/ack?token='+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:last,event})});}a.onplaying=()=>ack('started');a.onended=async()=>{await ack('ended');log.textContent+='再生完了 '+last+'\\n';busy=false;};a.onerror=()=>{ack('error');busy=false;};document.querySelector('#go').onclick=()=>{document.querySelector('#go').disabled=true;setInterval(async()=>{const d=await(await fetch('/state?token='+token)).json();document.querySelector('#status').textContent=d.label;if(d.id&&d.id!==last&&!busy){last=d.id;busy=true;a.src='/audio?token='+token;a.play().catch(()=>{busy=false;document.querySelector('#status').textContent='再生ボタンで音声を開始してください';});}},250);};</script>`);return;}
  const u=new URL(req.url,'http://127.0.0.1:8791');if(u.searchParams.get('token')!==token){res.writeHead(403).end();return;}
  if(u.pathname==='/state'){e.claimRenderer('verification');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({label:browserLabel,id:pendingBrowser?.id}));return;}
  if(u.pathname==='/audio'&&pendingBrowser){res.setHeader('Content-Type','audio/wav');res.end(pendingBrowser.bytes);return;}
  if(u.pathname==='/ack'&&req.method==='POST'){let body='';for await(const x of req){body+=x;if(body.length>1000){res.writeHead(413).end();return;}}try{const d=JSON.parse(body);if(pendingBrowser?.id===d.id){const ok=e.acknowledge({id:d.id,event:d.event,lease:e.renderer.lease});if(ok&&d.event==='ended'){const done=resolveBrowser;pendingBrowser=null;resolveBrowser=null;done();}}res.end('ok');}catch{res.writeHead(400).end();}return;}
  res.writeHead(404).end();
 });
 await new Promise(r=>browserServer.listen(8791,'127.0.0.1',r));console.log('Local renderer ready: http://127.0.0.1:8791/');
}
const observe=(hp,phase)=>({phase,elapsed:150,enemy_count_total:100,player:{hp,max_hp:120,level:2,character:'ANTONIO'},inventory:[{name:'WHIP'}],menu:{options:[]}});
const advance=ms=>{now+=ms;e.blocks.tick();};
async function nextAndHear(){
 for(let tries=0;tries<3;tries++){
  e.generationRetryAt=0;await e.prepare(e.epoch,e.controller.signal);
  if(!e.prepared){assert.equal(e.blocks.review.failed,false,'All gated variants failed');advance(500);continue;}
  const turn=e.prepared;await turn.audioTask;
  for(let i=0;i<turn.parts.length;i++){
   const p=turn.parts[i];assert.ok(p.audio?.bytes?.length>44,'Real voice produced WAV');
   writeFileSync(join(c.dataDir,`voice-${heard.length}-${i}.wav`),p.audio.bytes,{mode:0o600});
   e.nextTurnAt=0;e.claimRenderer('verification');await e.speakStep(e.epoch,e.controller.signal);
   assert.ok(e.pending);const d={id:e.pending.id,lease:e.renderer.lease};
   if(useBrowser){
    browserLabel = `音声を再生中：${p.text}`;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Browser playback timeout')),90000);resolveBrowser=()=>{clearTimeout(timer);resolve();};pendingBrowser={id:d.id,bytes:p.audio.bytes};});
   }else {assert.ok(e.acknowledge({...d,event:'started'}));assert.ok(e.acknowledge({...d,event:'ended'}));}
  }
  heard.push({eventId:turn.eventId,text:turn.text});return turn.eventId;
 }
 throw Error('Transition did not produce playable speech');
}
try{
 for(let round=1;round<=2;round++){
  const runId=`vampire-verification-r${round}`;
  e.blocks.ingest({runId,state:observe(20,'combat')});e.blocks.announcements=[];
  e.blocks.ingest({runId,state:observe(0,'gameover')});advance(1500);
  // Results are separately covered by offline tests; focus paid checks on required transition lines.
  e.blocks.announcements=e.blocks.announcements.filter(a=>a.id.startsWith('recap-'));
  await nextAndHear();assert.ok(e.blocks.intermissionChat);
  if(useBrowser){browserLabel='60秒休憩のタイマーを検証中（この検証では雑談音声を省略）';for(let i=0;i<6;i++){await new Promise(r=>setTimeout(r,10000));e.claimRenderer('verification');}}
  advance(59999);assert.ok(e.blocks.intermissionChat);advance(1);
  await nextAndHear();assert.equal(completed.length,round);
 }
 console.log(JSON.stringify({ok:true,rounds:completed.length,gateCalls:gate.length,estimatedGateUsd:jev.sessionUsd,voice:e.c.replyTtsProvider,ackMode:useBrowser?'actual browser playing/ended events; real60s pauses; synthetic gameplay':'simulated renderer acknowledgements; real WAV synthesis',directory:c.dataDir}));
}finally{
 writeFileSync(join(c.dataDir,'result.json'),JSON.stringify({completed,heard,gate,estimatedGateUsd:jev.sessionUsd},null,2),{mode:0o600});e.stop('verification_complete');browserServer?.close();
}
