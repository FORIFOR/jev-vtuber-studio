/** The Studio's 「配信を始める」 steps after the trial: OBS scene → show → the voice (and game) reach OBS → OBS stream.
 * If any step fails once the show has started, the show is stopped again (operator 2026-10-10: never leave the show
 * running with no stream), and OBS output the Studio started is stopped too. Browser and tests share this module. */
export async function goLive({ api, say, allowUnavailableYouTubeChat = false, hostName = 'ノア', streamTarget = () => '', onSession = () => {},
    waitMs = 120000, gameGraceMs = 60000, pollMs = 2000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    let showStarted = false;
    try {
        say('OBSの専用シーンを準備しています…'); await api('/api/obs/prepare', {});
        say('番組を開始しています…'); await api('/api/control', { action: 'start', allowUnavailableYouTubeChat }); showStarted = true;
        say(`${hostName}の声がOBSに届くのを待っています…`);
        const until = now() + waitMs;
        for (;;) {
            const s = await api('/api/session'); onSession(s);
            if (!s.status.running) throw new Error('番組が停止しました。');
            // During the opening talk there is no game yet: the stream starts once the voice reaches OBS.
            const voice = s.status.hasPlayedLiveAudio && s.status.renderer, game = !s.gameRunner?.enabled || s.gameRunner.state === 'playing' || (s.status.gameShow?.external && s.status[s.status.gameShow.statusKey]?.phase === 'lobby');
            if (voice && (game || now() > until - gameGraceMs)) break;
            if (now() > until) throw new Error(`${hostName}の声がOBSで再生されません。OBSの専用シーンを確認してください。`);
            say(voice ? 'ゲームの起動を待っています…' : `${hostName}の声がOBSに届くのを待っています…`);
            await sleep(pollMs);
        }
        say('OBSの配信を開始しています…'); await api('/api/obs/start', { confirm: 'START', target: streamTarget(), allowUnavailableYouTubeChat });
        return { ok: true };
    } catch (e) {
        if (!showStarted) { say(e.message); return { ok: false, error: e.message, rolledBack: false }; }
        say(`${e.message}\n配信を開始できなかったため、番組を止めています…`);
        try {
            try { await api('/api/obs/stop', {}); } catch { } // only output the Studio started; nothing else to stop otherwise
            await api('/api/control', { action: 'stop', force: true }); // immediate: no goodbye for a show that never went out
            say(`${e.message}\n配信を開始できなかったため、番組を止めました。原因を直してから、もう一度「配信を始める」を押してください。`);
            return { ok: false, error: e.message, rolledBack: true };
        } catch (stop) {
            say(`${e.message}\n番組を自動で止められませんでした（${stop.message}）。「■ 終了」を2回押して止めてください。`);
            return { ok: false, error: e.message, rolledBack: false };
        }
    }
}
