#!/usr/bin/env node
// Local configuration only. Does not install Tailscale, open firewall ports, or start a stream.
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadEnv } from '../src/config.mjs';
import { validateRemoteOptions } from '../src/remote-server.mjs';
const args = process.argv.slice(2), value = name => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes('--help')) {
    console.log(`npm run remote:setup
  Interactive: enter the Tailscale HTTPS origin and allowed login.
  Non-interactive: --origin=https://pc.tail.ts.net --user=you@example.com --confirm-private-network
  --disable: stop accepting mobile control after restarting Studio.
No network changes or external broadcasts are performed.`);
} else {
    let rl;
    try {
        loadEnv(); const c = config(); const file = join(c.dataDir, 'remote-control.json');
        if (args.includes('--disable')) {
            mkdirSync(c.dataDir, { recursive: true });
            writeFileSync(file, JSON.stringify({ enabled: false }) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
            console.log('遠隔操作を無効に設定しました。Studioを再起動してください。Tailscale Serve側の停止は別操作です。');
        } else {
            let origin = value('origin'), user = value('user');
            if (!origin || !user) {
                if (!process.stdin.isTTY) throw new Error('Use --origin=... --user=... --confirm-private-network, or run interactively.');
                rl = createInterface({ input: process.stdin, output: process.stdout });
                origin ||= await rl.question('PCのTailscale HTTPS URL (https://名前.tailnet.ts.net): ');
                user ||= await rl.question('スマホでログインするTailscale利用者 (例 you@example.com): ');
            }
            const settings = validateRemoteOptions({ enabled: true, origin: origin.trim(), users: [user.trim()], port: Number(value('port') || 8788) });
            if (settings.port === c.port) throw new Error('Mobile gateway needs a different port from Studio.');
            if (!args.includes('--confirm-private-network')) {
                if (!rl) throw new Error('Add --confirm-private-network after reading docs/REMOTE.md.');
                const answer = await rl.question('Tailscale Serve専用です。Funnel/一般公開/0.0.0.0を使わず、ローカルPCを信頼する構成を確認しましたか？ (yes): ');
                if (answer !== 'yes') throw new Error('設定を保存せず終了しました。');
            }
            mkdirSync(c.dataDir, { recursive: true });
            if (existsSync(file) && !args.includes('--replace')) {
                if (!rl) throw new Error('Existing remote configuration: pass --replace to overwrite.');
                if (await rl.question('既存の遠隔設定を置き換えますか？ (yes): ') !== 'yes') throw new Error('保存を取り消しました。');
            }
            writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
            renameSync(file + '.tmp', file); chmodSync(file, 0o600);
            console.log(`\n設定を保存しました。Studioを再起動してください。\n次にPCでServeの既存設定を確認し、意図した端末だけへ許可してください。\n  tailscale serve status\n  tailscale serve --bg --https=443 http://127.0.0.1:${settings.port}\n\nスマホ: ${settings.origin}/mobile\nPC側の接続ガイド05で、録画確認後に遠隔開始を8時間許可します。\n8787やOBSの4455をプロキシせず、Funnelは使用しないでください。`);
        }
    } catch (e) { console.error(e.message); process.exitCode = 1; }
    finally { rl?.close(); }
}
