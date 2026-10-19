import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
// Reuse an existing tool installation when provided; the server remains npm-dependency-free.
const toolsRoot = resolve(process.env.JEV_AVATAR_BUILD_ROOT || root);
const requireTool = createRequire(resolve(toolsRoot, 'package.json'));
const versions = { three: '0.186.1', '@pixiv/three-vrm': '3.5.5', '@pixiv/three-vrm-animation': '3.5.5', esbuild: '0.28.2' };
const check = process.argv.includes('--check');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

try {
    for (const [name, version] of Object.entries(versions)) {
        const pkg = JSON.parse(await readFile(resolve(toolsRoot, 'node_modules', name, 'package.json'), 'utf8'));
        if (pkg.version !== version) throw new Error(`Build requires ${name}@${version}, found ${pkg.version}`);
    }
    const { build } = requireTool('esbuild');
    if (process.argv.includes('--evaluate') || process.argv.includes('--evaluate-outfits')) {
        const entry = process.argv.includes('--evaluate-outfits') ? 'verify-vrm-outfits.mjs' : 'verify-vrm-motion.mjs';
        const outfile = resolve(root, 'data', entry);
        await build({ absWorkingDir: root, entryPoints: [`scripts/${entry}`],
            bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile,
            nodePaths: [resolve(toolsRoot, 'node_modules')] });
        process.env.JEV_AVATAR_PROJECT_ROOT = root;
        await import(pathToFileURL(outfile).href);
    } else {
        const result = await build({
            absWorkingDir: root,
            entryPoints: ['browser/avatar-vrm/noa-vrm-avatar.mjs'],
            bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
            minify: true, legalComments: 'inline', write: false, metafile: true,
            outfile: 'public/noa-vrm-avatar.mjs', nodePaths: [resolve(toolsRoot, 'node_modules')],
        });
        const bundle = result.outputFiles[0].contents;
        const sources = {};
        for (const path of Object.keys(result.metafile.inputs).filter(path => !path.includes('node_modules')).sort())
            sources[path] = sha(await readFile(resolve(root, path)));
        const record = Buffer.from(JSON.stringify({ dependencies: versions, bundle: { file: 'public/noa-vrm-avatar.mjs', bytes: bundle.length, sha256: sha(bundle) }, sources }, null, 2) + '\n');
        for (const [path, bytes] of [['public/noa-vrm-avatar.mjs', bundle], ['licenses/noa-vrm-build.json', record]]) {
            const file = resolve(root, path);
            if (check) {
                if (!Buffer.from(await readFile(file)).equals(Buffer.from(bytes))) throw new Error(`Stale generated file: ${path}`);
            } else { await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, bytes); }
        }
        console.log(`${check ? 'Verified' : 'Built'} Noa VRM bundle: ${bundle.length} bytes, SHA-256 ${sha(bundle)}`);
    }
} catch (error) {
    console.error(error.message);
    if (['ENOENT', 'MODULE_NOT_FOUND'].includes(error.code) || error.message.startsWith('Build requires'))
        console.error('Rebuilding only: install the pinned tools with npm run setup:avatar, or set JEV_AVATAR_BUILD_ROOT to an existing installation.');
    process.exitCode = 1;
}
