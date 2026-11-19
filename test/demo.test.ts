// The sample data (server/demo.ts): a working installation made through the console's own functions, only into an
// empty one, and only by an admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, startApp } from './helpers.ts';
import { addSampleData, isEmpty } from '../server/demo.ts';
import { buildClientFile, readClientFile } from '../server/clientFile.ts';

test('the sample data is a working installation: brands follow their company, and Production needs approval', async () => {
  const app = await startApp({ setup: addSampleData, signIn: { kind: 'test-header' } });
  try {
    assert.equal(await isEmpty(app.db), false);
    const snap = app.plane.get('prod');
    assert.deepEqual(snap.dimensions, ['company', 'brand']);
    assert.deepEqual(Object.keys(snap.flags).sort(), ['api_base_url', 'max_upload_mb', 'new_checkout', 'payments_enabled', 'theme', 'welcome_message']);
    const file = (entity: string | null) => buildClientFile(snap, 'web', entity ? snap.entities[entity] : null);
    const value = (entity: string | null, key: string, attrs: Record<string, unknown> = {}) => readClientFile(file(entity), key, attrs).value;

    assert.equal(value('bolt', 'api_base_url'), 'https://globex.api.example.com', 'a brand follows its company');
    assert.equal(value('initech', 'api_base_url'), 'https://api.example.com');
    assert.deepEqual(value('lumen', 'theme'), { accent: '#f59e0b', radius: 12 }, 'a brand’s own settings');
    assert.deepEqual(value('bolt', 'theme'), { accent: '#0a0a0a', radius: 0 });
    assert.equal(value('acme-kids', 'max_upload_mb'), 1000, '“Company is Acme” covers its brands');
    assert.equal(value('acme', 'new_checkout', { 'device.id': 'any' }), true, 'Acme gets the new checkout everywhere');
    assert.equal(readClientFile(file('initech'), 'welcome_message', { 'locale.language': 'en' }).codeDefault, true);
    assert.equal(value('initech', 'welcome_message', { 'locale.language': 'he' }), 'ברוכים הבאים!');

    const groups = new Set<string | undefined>();
    for (let i = 0; i < 200; i++) groups.add(readClientFile(file('initech'), 'new_checkout', { 'device.id': `d-${i}`, 'app.version': '6.0.0' }).group);
    assert.deepEqual([...groups].sort(), ['new-checkout', 'old-checkout']);

    const prod = await app.db.query<{ min_approvals: number }>(`select min_approvals from environment where key = 'prod'`);
    assert.equal(Number(prod.rows[0].min_approvals), 1);
    await assert.rejects(addSampleData(app.db), /only into an empty installation/);
  } finally {
    await app.stop();
  }
});

test('only an admin adds sample data, and only to an empty installation', async () => {
  const t = await boot();
  try {
    assert.equal((await t.as('alice').post('/sample-data')).status, 403, 'an editor');
    const r = await t.as('dana').post('/sample-data');
    assert.equal(r.status, 409, 'this one has data');
    assert.match(r.json.error, /empty installation/);
  } finally {
    await t.stop();
  }
});
