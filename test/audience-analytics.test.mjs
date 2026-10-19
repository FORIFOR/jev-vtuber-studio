import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLive,retentionInsights,duration,rows,csv,number} from '../src/audience-analytics.mjs';
const sample=(sec,viewers,platform='youtube',id='x')=>({at:new Date(sec*1000).toISOString(),platform,id,viewers,phase:'lobby'});
test('missing viewer counts stay unknown, zero stays zero',()=>{assert.equal(number(undefined),null);assert.equal(number(''),null);assert.equal(number('0'),0);assert.equal(number('x'),null);});
test('live averages are time-weighted, missing samples and outages do not imply departures',()=>{const [g]=summarizeLive([sample(0,10),sample(60,4),sample(120,null),sample(180,0),sample(1000,5)]);assert.equal(g.average,7);assert.equal(g.coveredSeconds,60);assert.equal(g.peak,10);assert.equal(g.declines.length,1);assert.equal(g.declines[0].change,-6);});
test('platforms and broadcasts are not combined into unique people',()=>{const g=summarizeLive([sample(0,2),sample(0,3,'twitch'),sample(0,1,'youtube','next')]);assert.equal(g.length,3);assert.equal(g[0].average,null);});
test('retention supports replay above 100%, reports percentage-point drops and exit events separately',()=>{const x=retentionInsights([{elapsedVideoTimeRatio:.1,audienceWatchRatio:1.2,stoppedWatching:1},{elapsedVideoTimeRatio:.2,audienceWatchRatio:.8,stoppedWatching:3}],100,20);assert.equal(x.lowSample,true);assert.ok(Math.abs(x.drops[0].dropPoints-40)<1e-6);assert.equal(x.drops[0].toSec,20);assert.equal(x.exits[0].count,3);});
test('empty retention never fabricates a drop',()=>{assert.deepEqual(retentionInsights([],null,null).drops,[]);});
test('CSV quotes multiline content and neutralizes spreadsheet formula injection',()=>{const out=csv([{title:'=HYPERLINK("evil")',n:0,note:'a\nb'}]);assert.ok(out.includes("'=HYPERLINK"));assert.ok(out.includes('"a\nb"'));assert.ok(out.includes('"0"'));});
test('API columns map by header, durations parse hours and zero',()=>{assert.deepEqual(rows({columnHeaders:[{name:'video'},{name:'views'}],rows:[['v',3]]}),[{video:'v',views:3}]);assert.equal(duration('PT1H2M3S'),3723);assert.equal(duration('PT0S'),0);assert.equal(duration('no'),null);});

import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AudienceAnalytics} from '../src/audience-analytics.mjs';
test('collector isolates channel, preserves hidden YouTube counts, and stores no viewer identifiers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'noa-analytics-'));const auth=join(dir,'auth.json');writeFileSync(auth,JSON.stringify({client_id:'test',access_token:'test'}));
 const replies=url=>url.includes('/api/session')?{status:{phase:'speaking',stats:{spoken:2},vampire:{phase:'playing',run:1}}}:url.includes('liveBroadcasts')?{items:[{id:'abcdefghijk',snippet:{channelId:'mine'}} ,{id:'other',snippet:{channelId:'someone'}}]}:url.includes('/videos?')?{items:[{id:'abcdefghijk',snippet:{title:'test'},liveStreamingDetails:{actualStartTime:'2026-09-30T01:00:00Z'}}]}:{data:[{id:'stream',title:'test',started_at:'2026-09-30T01:00:00Z',viewer_count:0,user_id:'do-not-store'}]};
 try{const a=new AudienceAnalytics({dataDir:dir,port:8787,adminToken:'test',youtubeChannel:'mine',twitchChannel:'noa',twitchAuthFile:auth},{fetchFn:async url=>new Response(JSON.stringify(replies(url)),{status:200}),now:()=>new Date('2026-09-30T01:02:00Z')});a.yt.token=async()=> 'test';await a.sample();const d=a.snapshot();assert.equal(d.live.length,2);assert.equal(d.live.find(s=>s.platform==='youtube').samples[0].viewers,null);assert.equal(d.live.find(s=>s.platform==='twitch').samples[0].viewers,0);assert.ok(!JSON.stringify(d).includes('do-not-store'));assert.ok(!JSON.stringify(d).includes('someone'));}finally{rmSync(dir,{recursive:true,force:true});}
});
