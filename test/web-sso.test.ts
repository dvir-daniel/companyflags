// Settings → Single sign-on's helpers (web/src/pages/ssoKit.ts) and two-factor's (web/src/pages/twoFactorKit.ts): group
// roles as an admin types them, and the setup key an authenticator app takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLines, JOIN_ROLES, readGroupLines } from '../web/src/pages/ssoKit.ts';
import { JOIN_ROLES as SERVER_JOIN_ROLES } from '../server/access.ts';
import { codeOf, isAppCode, setupKey } from '../web/src/pages/twoFactorKit.ts';

test('group roles: one group per line, with a role or its label; a wrong line says which', () => {
  assert.deepEqual(readGroupLines('flag-admins = admin\n\n  Flag Editors = Editor \nOps = On call'),
    { roles: { 'flag-admins': 'admin', 'Flag Editors': 'editor', Ops: 'oncall' }, problem: null });
  assert.deepEqual(readGroupLines('  \n'), { roles: null, problem: null }, 'nothing typed: no group roles');
  assert.match(readGroupLines('flag-admins = admin\nflag-owners = owner').problem ?? '', /^Line 2/);
  assert.match(readGroupLines('just a group').problem ?? '', /^Line 1/);
  assert.equal(groupLines({ claim: 'groups', roles: { a: 'admin', b: 'viewer' } }), 'a = admin\nb = viewer', 'and back');
  assert.deepEqual(JOIN_ROLES, [...SERVER_JOIN_ROLES], 'the join roles the console offers are the server’s');
});

test('two-factor: the setup key in groups of four, and codes as typed', () => {
  assert.equal(setupKey('otpauth://totp/CompanyFlags:ada%40acme.example?secret=JBSWY3DPEHPK3PXPJBSW&issuer=CompanyFlags'), 'JBSW Y3DP EHPK 3PXP JBSW');
  assert.equal(setupKey('not an address'), '');
  assert.equal(codeOf(' 123 456 '), '123456');
  assert.deepEqual([isAppCode('123 456'), isAppCode('12345'), isAppCode('abcdef')], [true, false, false]);
});
