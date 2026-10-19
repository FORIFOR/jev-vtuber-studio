// Roles are supplied by the trusted server, never by viewer text.
export function roleLabel(role, hostName) { return role === 'comment' ? 'コメント読み上げ' : hostName; }
export function hostMouthLevel(role, level) { return role === 'comment' ? 0 : Math.max(0, Math.min(1, level)); }
