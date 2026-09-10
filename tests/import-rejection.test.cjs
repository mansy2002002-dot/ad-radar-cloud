const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestImport, importRejection, sendBatch } = require('../collector-utils');

const reply = (value) => ({ ok: true, json: async () => value });
const busy = { ok: false, error: 'Another import is running. Retry later.' };
const success = { ok: true, version: '1.4.0', delivery_mode: 'individual_creative_required', accepted: 1, telegram_alerts: 1 };

test('only an explicit pre-processing busy rejection is retried; successful ads count once', async () => {
  let calls = 0;
  const waits = [], bodies = [];
  const totals = await sendBatch([{ library_id: '1' }], 'tiktok_library', 'EG', 'source', { url: 'https://script.google.com/macros/s/test/exec', key: 'dummy' }, async (url, options) => {
    bodies.push(options.body);
    return reply(++calls < 3 ? busy : success);
  }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(totals.alerts, 1);
});

test('busy retries are finite and share a time budget', async () => {
  let calls = 0, clock = 0;
  await assert.rejects(requestImport('endpoint', 'body', async () => { calls++; return reply(busy); }, { sleep: async () => {}, now: () => 0 }), { code: 'INGEST_BUSY' });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(requestImport('endpoint', 'body', async () => { calls++; clock += 179000; return reply(busy); }, { sleep: async () => assert.fail('would exceed the deadline'), now: () => clock }), { code: 'INGEST_BUSY' });
  assert.equal(calls, 1);
});

test('unauthorized imports report a precise code and are never retried', async () => {
  let calls = 0;
  await assert.rejects(requestImport('endpoint', 'body', async () => { calls++; return reply({ ok: false, error: 'Unauthorized browser import.' }); }, { sleep: async () => assert.fail('auth must not retry') }), { code: 'INGEST_UNAUTHORIZED' });
  assert.equal(calls, 1);
});

test('transport, malformed and uncertain responses are not retried', async () => {
  for (const fetcher of [
    async () => { throw new Error('network timeout'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    async () => reply(null),
    async () => reply({ ok: 'true' })
  ]) {
    let calls = 0;
    await assert.rejects(requestImport('endpoint', 'body', async () => { calls++; return fetcher(); }, { sleep: async () => assert.fail('uncertain request must not retry') }));
    assert.equal(calls, 1);
  }
});

test('server exceptions produce static diagnostics without disclosing secrets or URLs', () => {
  const value = importRejection({ ok: false, error: 'Cannot read properties of undefined; token=SECRET https://api.telegram.org/bot123:TOKEN/sendVideo' });
  assert.equal(value.code, 'INGEST_SCRIPT_ERROR');
  assert(!/SECRET|TOKEN|https:/.test(value.message));
  assert.equal(importRejection({ error: 'TELEGRAM_CONFIG_MISSING' }).code, 'TELEGRAM_CONFIG_MISSING');
  assert.equal(importRejection({ error: 'Run setupRadar() from the destination Google Sheet first.' }).code, 'SHEET_NOT_CONFIGURED');
  assert.equal(importRejection({ error: 'Service invoked too many times today: urlfetch.' }).code, 'INGEST_QUOTA');
  assert.equal(importRejection({ error: 'Unknown exception SECRET' }).code, 'INGEST_REJECTED');
  assert(!importRejection({ error: 'Unknown exception SECRET' }).message.includes('SECRET'));
});
