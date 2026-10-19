// On-stream chat box: YouTube and Twitch comments from the Studio's own receivers (server /overlay/chat-events).
const hash = new URLSearchParams(location.hash.slice(1)), token = hash.get('token') || '';
// STAGE_THEME=room (obs.mjs adds #theme=room): transparent rows for the stage's comment panel, which draws the heading.
if (hash.get('theme') === 'room') document.body.classList.add('theme-room');
// ROOM_GAME_LAYOUT=full (obs.mjs adds #fade=1): the rows sit over the game, so older ones fade.
if (hash.get('fade') === '1') document.body.classList.add('fade');
// ROOM_GAME_LAYOUT=frame (#style=card): the LIVE CHAT panel's look, the name over the text, no row boxes.
if (hash.get('style') === 'card') document.body.classList.add('card');
const list = document.getElementById('list');
const MAX = 30;
function add(m) {
    const row = document.createElement('div'); row.className = `m ${m.source}`;
    for (const [c, v] of [['s', m.source === 'youtube' ? 'YouTube' : 'Twitch'], ['n', m.name], ['t', m.text]]) {
        if (!v) continue;
        const s = document.createElement('span'); s.className = c; s.textContent = v; row.append(s);
    }
    list.append(row);
    while (list.children.length > MAX) list.firstChild.remove();
}
const seen = new Set();
new EventSource(`/overlay/chat-events?token=${encodeURIComponent(token)}`).onmessage = e => {
    const m = JSON.parse(e.data);
    if (seen.has(m.id)) return;               // a reconnect replays the recent ones
    seen.add(m.id); add(m);
};
