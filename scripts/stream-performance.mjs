import http from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {loadEnv,config,ROOT} from '../src/config.mjs';
import {OBS} from '../src/obs.mjs';
import {equal,exitWithParent} from '../src/util.mjs';
import {diagnose,readControl,readGame} from '../src/stream-performance.mjs';
export function allowed(req,port,token){return [`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)&&(!req.headers.origin||[`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))&&equal(req.headers.authorization||'',`Bearer ${token}`);}
export async function repairCapture(obs){if(!obs.c.game)throw Error('ゲームが未設定です。');return !!(await obs.refreshGameWindow());}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  exitWithParent();
 loadEnv();const c=config(), port=8792, dir=join(c.dataDir,'performance');mkdirSync(dir,{recursive:true,mode:0o700});
 const obs=new OBS(c);let previous, latest, busy=false, helper, timer, repairing=false,lastRepair=0,obsRetryAt=0;
 let history=[];try{history=JSON.parse(readFileSync(join(dir,'history.json'),'utf8')).filter(x=>Date.now()-x.at<86400000).slice(-1800);}catch{}
 async function sample(){if(busy)return;busy=true;try{
   const at=Date.now(),control=readControl(c.gameLogDir,at);let phase=control.phase;
   try {const r=await fetch(`http://127.0.0.1:${c.port}/api/session`,{headers:{Authorization:`Bearer ${c.adminToken}`},signal:AbortSignal.timeout(1200)});if(r.ok){const s=await r.json();if(s.memory && s.memory.level!=='normal'){helper?.kill();helper=null;}if(!s.status.running)phase='stopped';else if(['between','lobby','starting'].includes(s.status.vampire?.phase))phase=s.status.vampire.phase;}}catch{}
   let raw={at,phase,control,game:readGame(join(dir,'game-frame.json'))};
   // After a failure, wait 30 s before connecting again (2026-10-10: reconnecting every 2 s added to the clients hitting an
   // OBS whose WebSocket had stopped answering).
   if(at>=obsRetryAt){try{const [stats,stream,video]=await Promise.all([obs.call('GetStats'),obs.call('GetStreamStatus'),obs.call('GetVideoSettings')]);Object.assign(raw,{stats,stream,targetFps:video.fpsNumerator/video.fpsDenominator});}catch{obs.close();obsRetryAt=at+30000;}}
   latest={at,phase:raw.phase,control,...diagnose(raw,previous)};previous=raw;
   history.push(latest);history=history.filter(x=>at-x.at<3600000).slice(-1800);
   if(history.length%5===0){writeFileSync(join(dir,'history.tmp'),JSON.stringify(history),{mode:0o600});renameSync(join(dir,'history.tmp'),join(dir,'history.json'));}
 }finally{busy=false;}}
 const server=http.createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
   const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
   if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return reply(403,{error:'Invalid host'});
   const path=new URL(req.url,`http://127.0.0.1:${port}`).pathname;
   if(path.startsWith('/api/')){
     if(!allowed(req,port,c.adminToken))return reply(403,{error:'Studioの「映像の状態」から開いてください。'});
     if(req.method==='GET'&&path==='/api/status')return reply(200,{latest,history,repairCooldownMs:Math.max(0,60000-(Date.now()-lastRepair))});
     if(req.method==='POST'&&path==='/api/refresh-capture'){
       if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required'});
       if(repairing||Date.now()-lastRepair<60000)return reply(409,{error:'再接続後は60秒ほど状態を観測してください。'});
       repairing=true;try{const ok=await repairCapture(obs);if(!ok)return reply(409,{error:'ゲームウィンドウが見つかりません。'});lastRepair=Date.now();return reply(200,{ok:true,message:'ゲーム取り込みを再接続しました。配信とゲームは継続中です。改善したか数値をご確認ください。'});}catch{return reply(503,{error:'OBSのゲーム取り込みに接続できませんでした。'});}finally{repairing=false;}
     }return reply(404,{error:'Not found'});
   }
   const file={'/':'index.html','/app.mjs':'app.mjs','/style.css':'style.css'}[path];
   if(req.method!=='GET'||!file){res.writeHead(404);return res.end();}
   res.writeHead(200,{'Content-Type':file.endsWith('html')?'text/html; charset=utf-8':file.endsWith('mjs')?'text/javascript':'text/css'});res.end(readFileSync(resolve(ROOT,'public/performance',file)));
 });
 server.on('error',()=>{console.error('Performance monitor port unavailable.');process.exitCode=1;});
 server.listen(port,'127.0.0.1',()=>{
   const binary=join(dir,'game-frame-monitor');
   if(process.env.GAME_FRAME_PROBE==='1'&&existsSync(binary)){helper=spawn(binary,[join(dir,'game-frame.json')],{stdio:'ignore'});helper.on('error',()=>{});}
   sample();timer=setInterval(()=>sample().catch(()=>{}),2000);console.log(`Stream performance: http://127.0.0.1:${port}/`);
 });
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(timer);helper?.kill();obs.close();server.close();});
}
