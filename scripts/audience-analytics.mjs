import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEnv, config } from '../src/config.mjs';
import { equal, exitWithParent } from '../src/util.mjs';
import { AudienceAnalytics, csv } from '../src/audience-analytics.mjs';
loadEnv();
exitWithParent();
const c = config(), a = new AudienceAnalytics(c), port = Number(process.env.ANALYTICS_PORT) || 8790;
const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const out = (status, data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    try {
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return out(403, {error:'Invalid host'});
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.pathname.startsWith('/api/')) {
            if (!equal(req.headers.authorization || '', `Bearer ${c.adminToken}`)) return out(401, {error:'Studioから分析画面を開いてください。'});
            if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return out(403, {error:'Invalid origin'});
            if (req.method === 'GET' && u.pathname === '/api/data') return out(200, a.snapshot());
            if (req.method === 'POST' && u.pathname === '/api/sync') { a.sync(); return out(202, {ok:true}); }
            if (req.method === 'GET' && u.pathname === '/api/detail') return out(200, await a.detail(u.searchParams.get('id')));
            if (req.method === 'GET' && u.pathname === '/api/experiments') return out(200, a.read('experiments.json', []));
            if (req.method === 'POST' && u.pathname === '/api/experiments/result') {
                let text=''; for await (const chunk of req) { text+=chunk; if(Buffer.byteLength(text)>8192) return out(413,{error:'入力が長すぎます。'}); }
                const d=JSON.parse(text),notes=a.read('experiments.json',[]),note=notes.find(n=>n.id===d.id);
                if(!note || typeof d.result!=='string' || !d.result.trim() || d.result.length>1000) return out(400,{error:'結果を1000文字以内で入力してください。'});
                note.result=d.result.trim(); note.reviewedAt=new Date().toISOString(); a.save('experiments.json',notes); return out(200,{ok:true});
            }
            if (req.method === 'POST' && u.pathname === '/api/experiments') {
                let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) return out(413, {error:'入力が長すぎます。'}); }
                const d = JSON.parse(text), catalog = a.read('catalog.json', {videos:[], reports:[]});
                if (!catalog.videos.some(v => v.id === d.video) || typeof d.hypothesis !== 'string' || !d.hypothesis.trim() || d.hypothesis.length > 500 || typeof d.success !== 'string' || !d.success.trim() || d.success.length > 300) return out(400, {error:'対象動画・変更内容・確認指標を入力してください。'});
                const notes = a.read('experiments.json', []);
                notes.push({id:randomUUID(), at:new Date().toISOString(), video:d.video, hypothesis:d.hypothesis.trim(), success:d.success.trim(), baselinePeriod:catalog.period, baseline:catalog.reports.filter(r=>r.video===d.video)});
                a.save('experiments.json', notes.slice(-500)); return out(201, {ok:true});
            }
            if (req.method === 'GET' && u.pathname === '/api/export') {
                res.writeHead(200, {'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="noa-live-audience.csv"'});
                return res.end('\uFEFF' + csv(a.snapshot().live.flatMap(g=>g.samples)));
            }
            return out(404, {error:'Not found'});
        }
        if (req.method !== 'GET') return out(405, {error:'Method not allowed'});
        const files = {'/':['index.html','text/html'], '/app.mjs':['app.mjs','text/javascript'], '/style.css':['style.css','text/css']}, f=files[u.pathname];
        if (!f) return out(404, {error:'Not found'});
        res.writeHead(200, {'Content-Type':f[1]+'; charset=utf-8'});
        res.end(readFileSync(fileURLToPath(new URL('../public/analytics/'+f[0], import.meta.url))));
    } catch { out(400, {error:'データを取得できませんでした。認証状態と対象動画を確認してください。'}); }
});
let sampleTimer, syncTimer;
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'Analytics already running or port in use.' : 'Analytics listener failed.'); process.exitCode=1; });
server.listen(port, '127.0.0.1', () => {
    console.log(`Audience analytics: http://127.0.0.1:${port}`);
    a.sample().catch(()=>{}); a.sync().catch(()=>{});
    sampleTimer=setInterval(()=>a.sample().catch(()=>{}), 60000);
    syncTimer=setInterval(()=>a.sync().catch(()=>{}), 6*3600000);
});
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, ()=>{ clearInterval(sampleTimer); clearInterval(syncTimer); server.close(); });
