import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const plugin = readFileSync(new URL('../plugin/risu-bg-ui-continuity.plugin.js', import.meta.url), 'utf8');
test('UI companion defaults off and does not request DOM or model access at startup', async () => {
  let setting: any, unload: any;
  await vm.runInNewContext(plugin, { Risuai: {
    pluginStorage: { getItem: async () => null },
    registerSetting: async (_: string, cb: any) => { setting = cb; },
    onUnload: async (cb: any) => { unload = cb; },
    getRootDocument: async () => { throw Error('Unexpected mainDom request'); },
  }, console });
  assert.equal(typeof setting, 'function');assert.equal(typeof unload, 'function');
  await unload();
});
test('enabled UI requests mainDom, sets only an opt-in attribute and cleans up', async () => {
  const writes: string[][] = [];
  let unload: any;
  await vm.runInNewContext(plugin, { Risuai: {
    pluginStorage: { getItem: async () => '1' },
    registerSetting: async () => {}, onUnload: async (cb: any) => { unload = cb; },
    getRootDocument: async () => ({ querySelector: async () => ({
      getAttribute: async () => '1', setAttribute: async (...args: string[]) => { writes.push(args); },
    }) }),
  }, console });
  assert.deepEqual(writes, [['x-risu-bg-ui-enabled', 'thgy-v1']]);
  await unload();assert.equal(writes.at(-1)?.[1], 'off');
});
test('missing host support does not enable a fallback or modify the bot', async () => {
  let warnings = 0;
  await vm.runInNewContext(plugin, { Risuai: {
    pluginStorage: { getItem: async () => '1' },registerSetting: async () => {},onUnload: async () => {},
    getRootDocument: async () => ({ querySelector: async () => ({
      getAttribute: async () => null, setAttribute: async () => { throw Error('Must not enable'); },
    }) }),
  }, console: { warn: () => { warnings++; } } });
  assert.equal(warnings, 1);
});
test('host bootstrap installer is version-locked, minimal and idempotent', async () => {
  // @ts-expect-error standalone ESM kit intentionally has no generated declaration
  const { install } = await import('../scripts/install-ui-continuity.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-ui-kit-'));
  try {
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name:'pocketrisu',version:'1.10.0' }));
    const source='<html><head></head><body>untouched</body></html>';
    await fs.writeFile(path.join(dir, 'dist/index.html'), source);
    const check=await install(dir,true);assert.equal(check.changed,true);
    assert.equal(await fs.readFile(path.join(dir,'dist/index.html'),'utf8'),source);
    await install(dir);assert.equal((await install(dir)).changed,false);
    assert.equal(await fs.readFile(path.join(dir,'dist/index.html.before-risu-bg-ui'),'utf8'),source);
    const after=await fs.readFile(path.join(dir,'dist/index.html'),'utf8');
    assert.equal(after.replace('<script defer src="/risu-bg-ui-continuity.js" data-risu-bg-ui="1"></script>\n',''),source);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name:'pocketrisu',version:'wrong' }));
    await assert.rejects(install(dir), /Expected pocketrisu@1.10.0/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
