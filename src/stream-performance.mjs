import {readFileSync, readdirSync, statSync, openSync, readSync, closeSync} from 'node:fs';
import {join} from 'node:path';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const pct=(a,b)=>finite(a)&&finite(b)&&b>0?100*a/b:null;
const delta=(a,b)=>finite(a)&&finite(b)&&a>=b?a-b:null;
export function diagnose(current,previous){
    const dt=previous?(current.at-previous.at)/1000:0, s=current.stats||{}, p=previous?.stats||{}, out=current.stream||{}, old=previous?.stream||{};
    const same=dt>0&&dt<15&&out.outputActive===old.outputActive&&(!out.outputActive||out.outputDuration>=old.outputDuration);
    const result={fps:finite(s.activeFps)?s.activeFps:null,targetFps:current.targetFps||30,renderMs:s.averageFrameRenderTime??null,
        renderDropPct:same?pct(delta(s.renderSkippedFrames,p.renderSkippedFrames),delta(s.renderTotalFrames,p.renderTotalFrames)):null,
        encodeDropPct:same?pct(delta(s.outputSkippedFrames,p.outputSkippedFrames),delta(s.outputTotalFrames,p.outputTotalFrames)):null,
        networkDropPct:same?pct(delta(out.outputSkippedFrames,old.outputSkippedFrames),delta(out.outputTotalFrames,old.outputTotalFrames)):null,
        bitrateKbps:same&&out.outputActive&&delta(out.outputBytes,old.outputBytes)!==null?delta(out.outputBytes,old.outputBytes)*8/dt/1000:null,
        reconnecting:!!out.outputReconnecting,congestion:out.outputCongestion??null,streaming:!!out.outputActive,issues:[]};
    const add=(code,text,action=null)=>result.issues.push({code,text,action});
    if(!current.stats) add('obs_unavailable','OBSの計測ができません。接続を確認してください。');
    if(finite(result.fps)&&result.fps<result.targetFps*.9) add('obs_fps','OBSの描画FPSが設定値を下回っています。プレビューを休止し、負荷を確認してください。');
    if(result.renderDropPct>1) add('render','OBSの描画でコマ落ち。重いプレビューや画面効果を減らしてください。');
    if(result.encodeDropPct>1) add('encode','エンコードでコマ落ち。次回開始前に解像度・エンコーダ設定を見直してください。');
    if(result.networkDropPct>1||result.reconnecting||result.congestion>.2) add('network','送信に遅延・欠落。回線を確認してください。');
    const g=current.game, fresh=g?.state==='measuring'&&current.at-g.at>=-2000&&current.at-g.at<8000;
    result.game=fresh?g:{state:g?.state==='measuring'?'stale':g?.state||'unavailable'};
    // Menus, level-up selections, treasure and breaks intentionally stop gameplay.
    if(fresh&&current.phase==='combat'){
        if(g.changedFps<24||g.changedP95Ms>85||g.unchangedMs>250) add('game_cadence','ゲーム映像の更新が不安定です。ゲーム側と取り込み側を確認してください。','refresh-capture');
    }
    if(current.phase==='unknown') add('phase_unknown','ゲーム状態が確認できず、静止とカクつきを区別できません。');
    if(!fresh) add('game_unmeasured','ゲーム映像の更新は未計測です。OBSのFPSだけでは滑らかさを判断できません。');
    if(current.control?.leaseGaps>0) add('control_gap','直近の操作間隔が500msを超えました。映像FPSとは別に、AIの操作待ちで移動が途切れた可能性があります。');
    result.status=result.issues.some(x=>!['game_unmeasured','phase_unknown'].includes(x.code))?'attention':fresh&&current.phase!=='unknown'?'ok':'partial';
    return result;
}
export function readControl(logDir,now=Date.now()){
    if(!logDir)return {phase:'unknown'};
    try{
        const files=readdirSync(logDir).map(n=>join(logDir,n,'decisions.jsonl')).map(path=>{try{return {path,time:statSync(path).mtimeMs}}catch{return null}}).filter(Boolean).sort((a,b)=>b.time-a.time);
        const latest=files[0];if(!latest||now-latest.time>10000)return {phase:'unknown',stale:true};
        const fd=openSync(latest.path,'r');let text;try{const size=statSync(latest.path).size, start=Math.max(0,size-2*1024*1024), b=Buffer.alloc(Math.min(size,2*1024*1024));readSync(fd,b,0,b.length,start);text=b.toString('utf8');if(start)text=text.slice(text.indexOf('\n')+1);}finally{closeSync(fd);}
        const rows=text.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}),last=rows.at(-1);
        const recent=rows.filter(r=>r.phase==='combat'&&finite(r.elapsed_ms)&&r.elapsed_ms>=(last?.elapsed_ms||0)-30000);
        const lat=recent.map(r=>r.judgment?.latency_ms).filter(finite).sort((a,b)=>a-b);let leaseGaps=0;let prev;
        for(const r of recent){if(prev&&r.applied&&prev.applied&&prev.choice!=='stay'&&r.elapsed_ms-prev.elapsed_ms>500)leaseGaps++;prev=r;}
        return {phase:last?.state?.phase||last?.phase||'unknown',run:latest.path.split('/').at(-2),ageMs:now-latest.time,decisions:recent.length,jevP95Ms:lat.length?lat[Math.min(lat.length-1,Math.floor(lat.length*.95))]:null,leaseGaps,basis:'直近ログ最大2MB・最大30秒の観測。入力停止の確定ではありません。'};
    }catch{return {phase:'unknown'};}
}
export function readGame(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {state:'unavailable'};}}
