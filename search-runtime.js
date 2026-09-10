const fs = require('node:fs');
const path = require('node:path');

class SearchError extends Error {
  constructor(code, message, { stop = false } = {}) {
    super(message); this.code = code; this.availability = true; this.stop = stop;
  }
}

function safeError(error, secret = '') {
  let text = String(error.message || error);
  if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/https?:\/\/\S+/g, '[url]').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function navigatePublic(page, url, provider) {
  // Retry one transient navigation failure only. Never retry access denials,
  // rate limits, login gates or verification challenges within a run.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch (error) {
      if (!/Timeout|ERR_(CONNECTION|TIMED_OUT|NETWORK)/i.test(error.name + ' ' + error.message)) throw error;
      if (attempt) throw new SearchError('NETWORK_TIMEOUT', provider + ' navigation timed out twice.');
      console.warn('[' + provider + '] Navigation timeout; one retry in 2 seconds.');
      await page.waitForTimeout(2000); continue;
    }
    const status = response ? response.status() : 200;
    if (status === 401 || status === 403) throw new SearchError('HTTP_' + status, provider + ' HTTP ' + status + ': access refused by the site; not a keyword or Web App error.');
    if (status === 429) throw new SearchError('HTTP_429', provider + ' rate limit: remaining searches deferred.', { stop: true });
    if ([502, 503, 504].includes(status)) {
      if (attempt) throw new SearchError('HTTP_' + status, provider + ' temporary server failure after one retry.');
      await page.waitForTimeout(2000); continue;
    }
    if (status >= 400) throw new Error(provider + ' HTTP ' + status);
    return response;
  }
}

function summarizeSearches(provider, results) {
  const completed = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.length - completed - failed;
  return { provider, status: failed || !completed ? 'failed' : skipped ? 'partial' : 'ok', completed, skipped, failed, results };
}

function writeSummary(summary, env = process.env) {
  const directory = path.resolve('diagnostics');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, summary.provider.toLowerCase() + '-summary.json'), JSON.stringify(summary, null, 2));
  if (env.GITHUB_STEP_SUMMARY) {
    const cell = (value) => String(value || '').replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = summary.results.map((r) => '| ' + cell(r.name) + ' | ' + r.status + ' | ' + cell(r.message || '') + ' |');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, '\n## ' + summary.provider + ': ' + summary.status + '\n\nCompleted: ' + summary.completed + '; skipped: ' + summary.skipped + '; failed: ' + summary.failed + '.\n\n| Search | Status | Details |\n| --- | --- | --- |\n' + rows.join('\n') + '\n');
  }
}

async function runSearches(provider, tasks, work, { secret = '', report = writeSummary } = {}) {
  const results = [];
  let stop = false;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (stop) { results.push({ name: task.name, status: 'deferred', message: 'Stopped after site rate limit or verification request.' }); continue; }
    console.log('[' + provider + '] Search ' + (i + 1) + '/' + tasks.length + ': ' + task.name);
    try {
      const stats = await work(task);
      results.push({ name: task.name, status: 'ok', stats });
    } catch (error) {
      const message = safeError(error, secret);
      results.push({ name: task.name, status: error.availability ? 'skipped' : 'failed', code: error.code || 'ERROR', message });
      console.warn('[' + provider + '] ' + task.name + ': ' + message);
      stop = Boolean(error.stop);
    }
  }
  const summary = summarizeSearches(provider, results);
  report(summary);
  console.log('[' + provider + '] Summary:', { status: summary.status, completed: summary.completed, skipped: summary.skipped, failed: summary.failed });
  if (summary.status === 'failed') console.error(provider + ': ' + (summary.failed ? summary.failed + ' extraction/import failures.' : 'No searches completed; check site access.') + ' See the search summary.');
  if (summary.status === 'partial') console.warn('::warning::' + provider + ': partial results; some searches were skipped. See the search summary.');
  return summary;
}

module.exports = { SearchError, safeError, navigatePublic, summarizeSearches, writeSummary, runSearches };
