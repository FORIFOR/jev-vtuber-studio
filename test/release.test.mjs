import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { packageRelease, assertSafeFiles } from '../scripts/package-release.mjs';
const root = resolve(import.meta.dirname, '..');

// Read file names from our own generated ZIP central directory (no extraction).
function zipNames(b) {
    let end = b.length - 22;
    while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50) end--;
    assert.ok(end >= 0, 'ZIP end record');
    let offset = b.readUInt32LE(end + 16); const count = b.readUInt16LE(end + 10), names = [];
    for (let i = 0; i < count; i++) {
        assert.equal(b.readUInt32LE(offset), 0x02014b50);
        const len = b.readUInt16LE(offset + 28), extra = b.readUInt16LE(offset + 30), comment = b.readUInt16LE(offset + 32);
        names.push(b.toString('utf8', offset + 46, offset + 46 + len)); offset += 46 + len + extra + comment;
    }
    return names;
}
function tarFiles(gzip) {
    const b = gunzipSync(gzip), files = new Map();
    for (let p = 0; p + 512 <= b.length && b[p] !== 0;) {
        const name = b.toString('utf8', p, p + 100).replace(/\0.*$/, '');
        const size = parseInt(b.toString('ascii', p + 124, p + 136).replace(/\0.*$/, '').trim(), 8) || 0;
        files.set(name, b.subarray(p + 512, p + 512 + size)); p += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

test('release rejects private paths and requires gitignore before constructing archives', () => {
    const base = ['.gitignore', '.env.example', 'package.json', 'README.md'];
    assert.deepEqual(assertSafeFiles(base), [...base].sort());
    for (const path of ['.env', '.env.local', 'data/settings.json', 'other/youtube-oauth.json', 'node_modules/x.mjs', '.git/config', '../outside', 'src/../../secret', '/absolute', 'C:\\private', '.npmrc', 'private.key', 'scripts/__pycache__/local.pyc', 'scripts/local.pyc']) {
        assert.throws(() => assertSafeFiles([...base, path]), path);
    }
    assert.throws(() => assertSafeFiles(base.slice(1)));
});

test('source ZIP and npm archive both include ignore rules, never dummy runtime credentials', { timeout: 20000 }, t => {
    const fixture = mkdtempSync(join(tmpdir(), 'jev-release-test-')); t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const npm = [process.env.npm_execpath, resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p));
    assert.ok(npm, 'npm CLI required for release tests');
    const pkg = { name: 'jev-fixture', version: '0.0.0-test', private: true, files: ['.gitignore', '.npmignore', '.env.example', 'src/', 'README.md'] };
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(pkg));
    for (const path of ['.gitignore', '.npmignore', '.env.example']) copyFileSync(join(root, path), join(fixture, path));
    writeFileSync(join(fixture, 'README.md'), 'fixture only\n'); mkdirSync(join(fixture, 'src')); writeFileSync(join(fixture, 'src/main.mjs'), 'export const fixture = true;\n');
    mkdirSync(join(fixture, 'data')); writeFileSync(join(fixture, 'data/settings.json'), '{"key":"dummy-do-not-distribute"}');
    writeFileSync(join(fixture, '.env'), 'DUMMY=do-not-distribute');
    const result = packageRelease({ root: fixture, npm });
    const zip = readFileSync(result.zip), names = zipNames(zip).filter(x => !x.endsWith('/'));
    assert.ok(names.includes('jev-fixture/.gitignore')); assert.ok(names.includes('jev-fixture/.env.example'));
    assert.equal(names.length, result.entries);
    assert.ok(names.every(n => !n.includes('/data/') && !n.endsWith('/.env')));
    const files = tarFiles(readFileSync(result.archive));
    assert.ok(files.has('package/.gitignore')); assert.ok(!files.has('package/data/settings.json')); assert.ok(!files.has('package/.env'));
    assert.equal(files.get('package/.gitignore').toString(), readFileSync(join(root, '.gitignore'), 'utf8'));
    assert.equal(result.zipSha256, createHash('sha256').update(zip).digest('hex')); assert.equal(result.published, false);
});
