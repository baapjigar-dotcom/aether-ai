/** Parse inline scripts in index.html without executing browser code. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { NovaStorage } from '../modules/storage.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim());
assert.ok(scripts.length > 0, 'index.html should contain inline application scripts');
for (let index = 0; index < scripts.length; index += 1) {
  new vm.Script(scripts[index][2], { filename: `index-inline-${index}.js` });
}
console.log(`✅ PASS: parsed ${scripts.length} inline script block(s) in index.html`);

assert.equal(typeof NovaStorage.init, 'function');
await NovaStorage.set('unit_test', { persisted: true });
assert.deepEqual(NovaStorage.get('unit_test', null), { persisted: true });
assert.ok(NovaStorage.getUsageBytes() > 0);
console.log('✅ PASS: storage module memory fallback and metering');
