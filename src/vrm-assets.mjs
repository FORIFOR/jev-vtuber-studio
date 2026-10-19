import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Only the reviewed avatar and motion files are public, never neighboring files.
const files = [
    'Noa.vrm', 'manifest.json', 'AVATAR-LICENSE.md',
    'motions/manifest.json', 'motions/Microsoft-LICENSE.md', 'motions/UPSTREAM-NOTICE.md',
    'motions/rb-idle.vrma', 'motions/rb-nod.vrma', 'motions/rb-wave.vrma',
    'motions/rb-listen-2.vrma', 'motions/rb-shrug.vrma', 'motions/rb-idle-talking.vrma', 'motions/noa-beckon.vrma',
];
export const VRM_ASSET_PATHS = Object.freeze(files.map(file => `/models/noa3d/${file}`));
const allowed = new Set(VRM_ASSET_PATHS);
export function vrmAssetType(path) {
    if (!allowed.has(path)) return null;
    return path.endsWith('.json') ? 'application/json; charset=utf-8'
        : path.endsWith('.md') ? 'text/plain; charset=utf-8' : 'model/gltf-binary';
}

export async function serveVrmAsset(path, publicDir, res) {
    const type = vrmAssetType(path);
    if (!type) return false;
    const file = resolve(publicDir, path.slice(1));
    let info;
    try { info = await stat(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Avatar asset not found' }));
        return true;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    // Streaming keeps the 53 MB model load off the audio/SSE event loop.
    try { await pipeline(createReadStream(file), res); }
    catch (error) { if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error; }
    return true;
}
