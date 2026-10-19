import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
let count = 0, failed = false;
function modules(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(dir, entry.name);
        return entry.isDirectory() ? modules(path) : entry.name.endsWith('.mjs') ? [path] : [];
    });
}
for (const dir of ['src', 'public', 'browser', 'scripts', 'test'])
    for (const file of modules(`${root}/${dir}`)) {
        const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        count++;
        if (r.status !== 0) {
            console.error(r.stderr);
            failed = true;
        }
    }
console.log(`${failed ? 'FAIL' : 'PASS'}: ${count} JavaScript modules syntax checked. Streaming chat dependencies are optional and installed by setup:youtube.`);
process.exitCode = failed ? 1 : 0;
