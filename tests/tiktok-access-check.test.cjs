const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflow = fs.readFileSync(path.join(__dirname, '../ad-radar-cloud/.github/workflows/tiktok_access_check.yml'), 'utf8');
const embedded = workflow.match(/          node <<'NODE'\r?\n([\s\S]*?)          NODE/)[1].replace(/^          /gm, '');

async function runCheck({ status = 200, cards = 2, text = 'Top Ads', dataStatus, navigationError } = {}) {
  let requests = 0, evaluations = 0, closed = false, summary = '';
  const output = [];
  const fakeProcess = { env: { GITHUB_STEP_SUMMARY: 'summary' }, exitCode: 0 };
  const page = {
    on: (name, listener) => {
      if (dataStatus) listener({ request: () => ({ resourceType: () => 'fetch' }), url: () => 'https://ads.tiktok.com/data?token=DO_NOT_LOG', status: () => dataStatus });
    },
    goto: async (url) => {
      assert.equal(url, 'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?period=180&region=EG');
      requests++;
      if (navigationError) throw navigationError;
      return { status: () => status };
    },
    locator: () => ({ innerText: async () => text }),
    url: () => 'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en',
    evaluate: async () => { evaluations++; return { ads: Array.from({ length: cards }, () => ({})) }; },
    waitForTimeout: async () => assert.fail('These fixtures should stop immediately')
  };
  await vm.runInNewContext(embedded, {
    URL, Date, process: fakeProcess,
    console: { log: (...args) => output.push(args.join(' ')) },
    require: (name) => {
      if (name === 'node:fs') return { appendFileSync: (file, value) => { summary += value; } };
      if (name === './library-page') return { extractTikTok() {} };
      assert.equal(name, 'playwright', 'The check must not import or send to the backend');
      return { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => { closed = true; } }) } };
    }
  });
  const report = JSON.parse(output.find((line) => line.startsWith('[Check] {')).slice(8));
  assert.equal(requests, 1);
  assert.equal(closed, true);
  assert(!output.join('\n').includes('DO_NOT_LOG'));
  return { report, exitCode: fakeProcess.exitCode, evaluations, summary };
}

test('HTTP denials stop without extracting cards or retrying; 200 alone is not success', async () => {
  for (const [status, code] of [[403, 'HTTP_ACCESS_DENIED'], [429, 'RATE_LIMIT'], [500, 'HTTP_ERROR']]) {
    const result = await runCheck({ status });
    assert.equal(result.report.result, code);
    assert.equal(result.evaluations, 0);
    assert.equal(result.exitCode, 1);
  }
  const empty = await runCheck({ cards: 0, text: 'No search results found' });
  assert.equal(empty.report.result, 'NO_RESULTS');
  assert.equal(empty.exitCode, 1);
});

test('readable cards, data denial, login and verification are distinguished without logging URLs', async () => {
  const readable = await runCheck();
  assert.equal(readable.report.result, 'ADS_VISIBLE');
  assert.equal(readable.report.visible_ads, 2);
  assert.equal(readable.exitCode, 0);
  assert(readable.summary.includes('لم يرسل إعلانات'));
  assert.equal((await runCheck({ dataStatus: 403 })).report.result, 'DATA_ACCESS_DENIED');
  assert.equal((await runCheck({ text: 'Please verify you are human' })).report.result, 'VERIFICATION_REQUIRED');
  assert.equal((await runCheck({ cards: 0, text: 'Log in to view' })).report.result, 'LOGIN_REQUIRED');
  assert.equal((await runCheck({ navigationError: Object.assign(new Error('DO_NOT_LOG'), { name: 'TimeoutError' }) })).report.result, 'NAVIGATION_TIMEOUT');
  assert(!workflow.includes('secrets.'));
  assert(!workflow.includes('schedule:'));
});
