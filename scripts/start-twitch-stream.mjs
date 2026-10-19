import http from 'node:http';
import { loadEnv } from '../src/config.mjs';
loadEnv();

const TOKEN = process.env.ADMIN_TOKEN || '';
if (!TOKEN) { console.error('ADMIN_TOKEN is not set (.env).'); process.exit(1); }
const PORT = Number(process.env.PORT) || 8787;

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : null;
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    ...(body ? { 'Content-Type': 'application/json' } : {})
  };

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('1. Checking current session status...');
  let session = await request('/api/session');
  console.log('Status:', {
    running: session.status.running,
    phase: session.status.phase,
    streamTarget: session.streamTarget,
    obsReady: session.obsConnected,
    renderer: session.status.renderer
  });

  if (session.status.running) {
    console.log('Stopping current running session...');
    await request('/api/control', { method: 'POST', body: { action: 'stop', force: true } }); // immediate (a plain stop says the ~2 min goodbye first)
    await sleep(2000);
    session = await request('/api/session');
  }

  console.log('2. Preparing OBS scenes...');
  const prepared = await request('/api/obs/prepare', { method: 'POST', body: {} });
  console.log('OBS Prepared:', prepared);
  await sleep(1000);

  console.log('3. Starting Studio show (/api/control start)...');
  const startResult = await request('/api/control', {
    method: 'POST',
    body: { action: 'start', allowUnavailableYouTubeChat: true }
  });
  console.log('Show started. Phase:', startResult.phase);

  console.log('4. Waiting for first live audio to be rendered to OBS...');
  const timeout = Date.now() + 60000;
  let audioConfirmed = false;

  while (Date.now() < timeout) {
    session = await request('/api/session');
    const hasAudio = session.status.hasPlayedLiveAudio;
    const renderer = session.status.renderer;
    const pending = session.status.pending;

    console.log(`[${new Date().toISOString()}] running=${session.status.running}, phase=${session.status.phase}, hasPlayedLiveAudio=${hasAudio}, renderer=${renderer}, pending=${pending ? pending.text?.slice(0, 20) : 'none'}`);

    if (hasAudio && renderer) {
      audioConfirmed = true;
      break;
    }
    await sleep(1000);
  }

  if (!audioConfirmed) {
    throw new Error('Timeout waiting for live audio playback in OBS');
  }

  console.log('5. Triggering OBS live streaming to Twitch (/api/obs/start)...');
  const obsStartResult = await request('/api/obs/start', {
    method: 'POST',
    body: { confirm: 'START', target: 'twitch', allowUnavailableYouTubeChat: true }
  });
  console.log('OBS stream started:', obsStartResult);

  await sleep(2000);
  session = await request('/api/session');
  console.log('6. Final Status check:');
  console.log({
    running: session.status.running,
    phase: session.status.phase,
    obsOwned: session.obsOwned,
    streamTarget: session.streamTarget,
    gameRunner: session.gameRunner?.state,
    turn: session.status.turn
  });

  console.log('SUCCESS! Show and Twitch live stream are running.');
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
