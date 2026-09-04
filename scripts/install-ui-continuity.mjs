#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Minimal host integration: one static browser asset + one index.html script tag.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export async function install(host, check = false) {
  const pkg = JSON.parse(await fs.readFile(path.join(host, 'package.json'), 'utf8'));
  if (pkg.name !== 'pocketrisu' || pkg.version !== '1.10.0') throw new Error('Expected pocketrisu@1.10.0; refusing an unverified host.');
  const index = path.join(host, 'dist/index.html');
  const original = await fs.readFile(index, 'utf8');
  const tag = '<script defer src="/risu-bg-ui-continuity.js" data-risu-bg-ui="1"></script>';
  if (!original.includes(tag) && original.split('</head>').length !== 2) throw new Error('Ambiguous/missing index.html head anchor.');
  const output = original.includes(tag) ? original : original.replace('</head>', tag + '\n</head>');
  const asset = await fs.readFile(new URL('../adapters/ui/ui-continuity.js', import.meta.url));
  const target = path.join(host, 'dist/risu-bg-ui-continuity.js');
  const existing = await fs.readFile(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing && !existing.equals(asset)) throw new Error('Existing UI asset differs; explicit upgrade/review required.');
  const backup = index + '.before-risu-bg-ui';
  if (!check) {
    if (output !== original) {
      await fs.writeFile(backup, original, { flag: 'wx' });
    }
    await fs.writeFile(target, asset);
    if (output !== original) await fs.writeFile(index, output);
  }
  return { host: `${pkg.name}@${pkg.version}`, check, changed: output !== original,
    files: ['dist/index.html', 'dist/risu-bg-ui-continuity.js'],
    assetSha256: createHash('sha256').update(asset).digest('hex') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.argv.find(a => a.startsWith('--host='))?.slice(7);
  if (!host) throw new Error('Usage: node scripts/install-ui-continuity.mjs --host=/verified/host [--check]');
  console.log(JSON.stringify(await install(path.resolve(host), process.argv.includes('--check')), null, 2));
}
