/** Authored premises, not prerecorded scripts. Only the current beat reaches the model. */
export function lobbyCards(cards, scenes, seed = Date.now()) {
    if (!scenes?.length) return cards;
    if (scenes.length > 16 || new Set(scenes.map(s => s.id)).size !== scenes.length || scenes.some(s =>
        !s.id || !s.title || !s.premise || !Array.isArray(s.beats) || s.beats.length < 2 || s.beats.length > 6 ||
        new Set(s.beats.map(b => b.id)).size !== s.beats.length || s.beats.some(b =>
            !b.id || !b.task || !b.action || !b.demo || !Number.isInteger(b.minChars) || !Number.isInteger(b.maxChars) ||
            b.minChars < 5 || b.maxChars < b.minChars || b.maxChars > 100))) throw new Error('Invalid lobby scenes');
    let state = Number(seed) >>> 0;
    // Scenes marked first (an operator's opening, e.g. a look back at the last stream) keep their order at the front;
    // the rest are shuffled after them and fill the lobby time.
    const lead = scenes.filter(s => s.first === true), order = scenes.filter(s => s.first !== true);
    for (let i = order.length - 1; i > 0; i--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = Math.floor(state / 4294967296 * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    order.unshift(...lead);
    const beats = order.flatMap(s => s.beats.map((b, i) => ({
        id: `lobby-${s.id}-${b.id}`, label: b.label, task: b.task, demo: b.demo, lobby: true, invite: false,
        lobbyStory: { sceneId: s.id, title: s.title, premise: s.premise, step: i + 1, total: s.beats.length,
            action: b.action, minChars: b.minChars, maxChars: b.maxChars }
    })));
    return cards.map(c => c.beats?.some(b => b.lobby) ? { ...c, beats: [...beats, ...c.beats.filter(b => !b.lobby)] } : c);
}
