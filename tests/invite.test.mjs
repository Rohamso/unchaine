import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (data) => Buffer.from(data, 'binary').toString('base64');
}
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (data) => Buffer.from(data, 'base64').toString('binary');
}

const inviteModule = await import('../build/invite.js');
const {
  createInvite,
  decodeInviteToken,
  verifyInviteTokenSignature,
  INVITE_TTL_MS
} = inviteModule;

test('createInvite produces signed v2 payloads', async () => {
  const now = Date.now();
  const { token, payload } = await createInvite(' Demo-Room-1 ');

  assert.equal(payload.v, 2);
  assert.equal(payload.room, 'demo-room-1');
  assert.ok(typeof payload.sig === 'string' && payload.sig.length > 0);
  assert.ok(payload.exp > now);
  const ttlDiff = Math.abs((payload.exp - payload.ts) - INVITE_TTL_MS);
  assert.ok(ttlDiff < 2000, 'expiry interval should match configured TTL');

  const decoded = decodeInviteToken(token);
  assert.ok(decoded, 'token should decode back to payload');
  assert.equal(decoded?.sig, payload.sig);
  assert.equal(decoded?.nonce, payload.nonce);
});

test('verifyInviteTokenSignature fails when payload is tampered', async () => {
  const { payload } = await createInvite('room-a');
  const altered = { ...payload, room: 'room-b' };
  const valid = await verifyInviteTokenSignature(payload);
  const tampered = await verifyInviteTokenSignature(altered);
  assert.equal(valid, true);
  assert.equal(tampered, false);
});

test('decodeInviteToken handles bad input', () => {
  assert.equal(decodeInviteToken('not-base64'), null);
  assert.equal(decodeInviteToken(''), null);
});
