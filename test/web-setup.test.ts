// The console's first-run checklist (web/src/pages/setupKit.ts), the file for everyone it points to before there are
// entries (web/src/paths.ts), and what the first page says when the console can't start (web/src/text.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Meta } from '../web/src/api.ts';
import { nextStep, setupLeft, setupSteps, stepsLead } from '../web/src/pages/setupKit.ts';
import { everyoneFilePath } from '../web/src/paths.ts';
import { bootProblem } from '../web/src/text.ts';

const blank = { environments: [], services: [], dimensions: [], entities: [], plugins: ['ofrep', 'flagd', 'cdn-files'] } as unknown as Meta;
const dev = { key: 'dev', name: 'Development', minApprovals: 0, revision: 1 };
const at = (meta: Partial<Meta>, flags?: number) => {
  const steps = setupSteps({ ...blank, ...meta } as Meta, flags);
  return { steps, done: steps.filter((s) => s.done).map((s) => s.key), next: nextStep(steps).key, step: (k: string) => steps.find((s) => s.key === k)! };
};

test('the checklist marks each step done from what the server has, and goes on to the next', () => {
  // a new server: environments first, then services, a flag, then connecting an app (four steps: dimensions are optional)
  assert.equal(at({}).steps.length, 4);
  assert.deepEqual(at({}).done, []);
  assert.equal(at({}).next, 'environments');
  assert.deepEqual(at({ environments: [dev] }).done, ['environments']);
  assert.equal(at({ environments: [dev] }).next, 'services');
  const ready = { environments: [dev], services: [{ key: 'web', kind: 'client' as const }] };
  assert.deepEqual(at(ready).done, ['environments', 'services']);
  // no dimension or entry is needed: an app reads with its service's key
  assert.equal(at(ready).next, 'flag');
  // the flag step is done only when the page knows there are flags
  assert.equal(at(ready, 0).next, 'flag');
  assert.equal(at(ready, 3).next, 'app');
  assert.equal(at(ready, 3).step('app').href, '#/keys');
  // connecting an app is done once a key in use has read flags (/meta keyLastUsedAt)
  assert.equal(at(ready, 3).step('app').done, false);
  assert.equal(at({ ...ready, keyLastUsedAt: '2026-11-20T10:00:00Z' }, 3).step('app').done, true);
});

test('the checklist shows only while a step is left, and counts its own steps', () => {
  const ready = { environments: [dev], services: [{ key: 'web', kind: 'client' as const }] };
  assert.equal(setupLeft(at(ready, 3).steps), true);
  // everything done: no dimension or entity needed, so nothing is left (the banner goes away)
  assert.equal(setupLeft(at({ ...ready, keyLastUsedAt: '2026-11-20T10:00:00Z' }, 3).steps), false);
  // the welcome says how many steps there are, from the list itself
  assert.equal(stepsLead(at({}).steps), 'Four steps, and your apps read their first flag.');
  assert.equal(stepsLead(at({}).steps.slice(0, 1)), 'One step, and your apps read their first flag.');
});

test('the steps never say "entry" or "entity", and use the dimension’s word once there is one', () => {
  for (const plugins of [['ofrep', 'flagd', 'cdn-files'], ['cdn-files']]) {
    for (const s of at({ plugins }).steps) assert.doesNotMatch(`${s.title} ${s.text} ${s.action}`, /\bentr(y|ies)\b|\bentit(y|ies)\b/i, s.key);
  }
  const store = { key: 'store', singular: 'store', plural: 'stores', entities: 0, withParent: 0 };
  assert.match(at({ dimensions: [store] }).step('flag').text, /differs per store/);
  assert.match(at({ dimensions: [store], plugins: ['cdn-files'] }).step('app').text, /a store’s app link/);
  assert.match(at({}).step('flag').text, /differs per user or device/);
});

test('each step links where it is done', () => {
  assert.equal(at({}).step('environments').href, '#/settings/environments');
  assert.equal(at({}).step('services').href, '#/services');
  assert.equal(at({}).step('flag').href, '#/flags');
  // connecting an app: the API keys page, where each service's key is made
  assert.equal(at({}).step('app').href, '#/keys');
  assert.equal(at({}).step('app').action, 'API Keys');
});

test('connecting an app says how this server is read', () => {
  // OFREP: the service's key in the provider; CDN files only: the service's file for everyone (no dimension yet)
  assert.match(at({}).step('app').text, /key.*OFREP provider/);
  assert.match(at({ plugins: ['cdn-files'] }).step('app').text, /file for everyone/);
  assert.doesNotMatch(at({ plugins: ['cdn-files'] }).step('app').text, /OFREP/);
});

test('a service’s file for everyone: its address, one segment per key', () => {
  assert.equal(everyoneFilePath('prod', 'web'), '/cdn/v1/flags/prod/web');
  assert.equal(everyoneFilePath('a/b', 'c?d'), '/cdn/v1/flags/a%2Fb/c%3Fd');
});

test('the first page tells a server that answered with an error from one that can’t be reached', () => {
  // nothing answered: the server may not be running
  assert.equal(bootProblem(0, 'can’t reach the server').title, 'Can’t reach the CompanyFlags server.');
  assert.match(bootProblem(0, 'can’t reach the server').text, /running/);
  // it answered: never "can't reach", and the status and the error's words are said
  for (const [status, message] of [[500, 'internal error'], [502, 'HTTP 502'], [404, 'not found']] as const) {
    const p = bootProblem(status, message);
    assert.doesNotMatch(p.title, /reach/, `HTTP ${status}`);
    assert.match(p.title, /answered with an error/);
    assert.match(p.text, new RegExp(`^HTTP ${status}`));
    assert.match(p.text, /server’s log/);
  }
  assert.equal(bootProblem(500, 'internal error').text, 'HTTP 500: internal error. Reload, or check the server’s log.');
  assert.equal(bootProblem(502, 'HTTP 502').text, 'HTTP 502. Reload, or check the server’s log.');
  // no access
  assert.deepEqual(bootProblem(403, 'an admin removed your access'), { title: 'You don’t have access.', text: 'An admin removed your access.' });
});
