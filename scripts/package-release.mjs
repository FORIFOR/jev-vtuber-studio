// Local-only source packaging. Requires npm + Git, never pushes or publishes.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync, lstatSync, realpathSync, rmSync, renameSync } from 'node:fs';
import { resolve, basename, dirname, relative, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function assertSafeFiles(entries) {
    const names = entries.map(x => typeof x === 'string' ? x : x.path);
    for (const path of names) {
        if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\u0000-\u001f:]/.test(path) || path.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Invalid package path');
        const leaf = path.split('/').at(-1);
        if (/(^|\/)(node_modules|data|dist|coverage|__pycache__|\.git|\.local)(\/|$)/.test(path)
            || (leaf.startsWith('.env') && path !== '.env.example')
            || leaf === '.npmrc' || /\.(pem|key|log|pyc|pyo)$/i.test(leaf)
            || /(?:token|oauth|settings)\.json(?:\.tmp)?$/.test(leaf)) throw new Error('Private file selected for distribution; refusing to package.');
    }
    if (new Set(names).size !== names.length) throw new Error('Duplicate package paths');
    for (const required of ['.gitignore', '.env.example', 'package.json', 'README.md']) {
        if (!names.includes(required)) throw new Error(`Required source file missing: ${required}`);
    }
    return names.sort();
}
function command(executable, args, cwd, env) {
    const r = spawnSync(executable, args, { cwd, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`${basename(executable)} failed. Install Node.js/npm and Git, then retry local packaging.`);
    return r.stdout;
}
function sha(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function checksum(file) { const hash = sha(file); writeFileSync(file + '.sha256', `${hash}  ${basename(file)}\n`); return hash; }

export function packageRelease({ root = resolve(import.meta.dirname, '..'), out = resolve(root, 'dist'), npm = process.env.npm_execpath } = {}) {
    if (!npm) throw new Error('Run npm run pack:release.');
    root = realpathSync(root); out = resolve(out);
    const env = { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' };
    // Validate the selected manifest BEFORE an archive can contain private files.
    const dry = JSON.parse(command(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--dry-run'], root, env))[0];
    const names = assertSafeFiles(dry.files);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(dry.name)) throw new Error('Unsupported source archive name');
    for (const path of names) {
        const src = resolve(root, path), real = realpathSync(src), rel = relative(root, real);
        if (!lstatSync(src).isFile() || rel.startsWith('..') || isAbsolute(rel) || real !== src) throw new Error('Only regular in-tree source files may be distributed');
    }
    mkdirSync(out, { recursive: true });
    const staging = mkdtempSync(join(tmpdir(), 'jev-source-release-'));
    const tempZip = join(staging, '.source.zip');
    let archive;
    try {
        for (const path of names) {
            const dest = resolve(staging, path);
            mkdirSync(dirname(dest), { recursive: true }); copyFileSync(resolve(root, path), dest);
            chmodSync(dest, dry.files.find(x => x.path === path).mode & 0o777);
        }
        // Git is a development-time ZIP writer here. All commands act on a new
        // disposable repository; there is no remote, commit, or user-repo mutation.
        command('git', ['init', '--quiet'], staging, env);
        command('git', ['-c', 'core.autocrlf=false', 'add', '--force', '--', ...names], staging, env);
        const tree = command('git', ['write-tree'], staging, env).trim();
        const archivedNames = command('git', ['ls-tree', '-r', '--name-only', tree], staging, env).trim().split('\n').sort();
        if (JSON.stringify(archivedNames) !== JSON.stringify(names)) throw new Error('Source tree manifest mismatch');
        command('git', ['archive', '--format=zip', `--prefix=${dry.name}/`, `--output=${tempZip}`, tree], staging, env);
        const pack = JSON.parse(command(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', out], staging, env))[0];
        archive = resolve(out, basename(pack.filename));
        if (JSON.stringify(assertSafeFiles(pack.files)) !== JSON.stringify(names)) throw new Error('Package changed during release; retry from a clean source tree');
        const zip = resolve(out, `${dry.name}-v${dry.version}.zip`);
        copyFileSync(tempZip, zip + '.tmp'); renameSync(zip + '.tmp', zip);
        const result = { version: dry.version, archive, zip, sha256: checksum(archive), zipSha256: checksum(zip), entries: names.length, published: false,
            files: names.map(path => ({ path, sha256: sha(resolve(staging, path)) })) };
        writeFileSync(zip + '.manifest.json', JSON.stringify(result, null, 2) + '\n');
        return result;
    } catch (e) {
        if (archive) rmSync(archive, { force: true });
        throw e;
    } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { const { files, ...result } = packageRelease(); console.log(JSON.stringify(result, null, 2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
}
