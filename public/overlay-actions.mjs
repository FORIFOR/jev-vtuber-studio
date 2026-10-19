// Noa's commands beside the chat: the newest applied game actions (server /overlay/action-events, from game_actions).
const hash = new URLSearchParams(location.hash.slice(1)), token = hash.get('token') || '';
// STAGE_THEME=room (obs.mjs adds #theme=room): one slim strip along the bottom of the game frame, the newest on the right.
const room = hash.get('theme') === 'room';
if (room) document.body.classList.add('theme-room');
const list = document.getElementById('list');
new EventSource(`/overlay/action-events?token=${encodeURIComponent(token)}`).onmessage = e => {
    const items = JSON.parse(e.data);
    list.replaceChildren(...items.slice(room ? -3 : -5).map(a => {
        const row = document.createElement('div'); row.className = `m ${a.kind || ''}`;
        for (const [c, v] of [['c', `${Math.floor(a.t / 60)}:${String(a.t % 60).padStart(2, '0')}`], ['a', a.arrow || ''], ['x', a.text]]) {
            const s = document.createElement('span'); s.className = c; s.textContent = v; row.append(s);
        }
        return row;
    }));
};
