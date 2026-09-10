const TERMINAL_MESSAGES = /captcha|verify you are human|unusual traffic|temporarily blocked|تأكيد أنك|تحقق من أنك|تم حظرك/i;
const { SearchError } = require('./search-runtime');
const REQUIRED_BACKEND = '1.4.0';

function config(env = process.env) {
  if (!env.WEB_APP_URL || !env.INGEST_KEY) throw new Error('Set WEB_APP_URL and INGEST_KEY in Actions secrets.');
  const url = new URL(env.WEB_APP_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw new Error('WEB_APP_URL must be the deployed Apps Script /exec URL.');
  }
  return { url: url.toString(), key: env.INGEST_KEY };
}

function selectTerms(terms, count, runNumber = process.env.GITHUB_RUN_NUMBER) {
  // A complete vocabulary cycle takes ceil(terms.length / size) runs.
  // A rerun keeps the same batch; no write access is needed.
  if (!terms.length) return [];
  const run = Math.max(1, Math.floor(Number(runNumber) || 1));
  const size = Math.min(terms.length, Math.max(1, Math.floor(Number(count) || 4)));
  const offset = ((run - 1) * size) % terms.length;
  return Array.from({ length: size }, (_, i) => terms[(offset + i) % terms.length]);
}

async function verifyBackend(configuration, fetcher = fetch) {
  const response = await fetcher(configuration.url, { method: 'GET', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
  let data;
  try { data = await response.json(); } catch { throw new Error('OLD WEB APP: deploy a New version with MetaLibrary.gs and Telegram.gs, then check WEB_APP_URL. Expected v' + REQUIRED_BACKEND); }
  if (!response.ok || data.version !== REQUIRED_BACKEND || data.delivery_mode !== 'individual_creative_required') {
    throw new Error('Wrong Web App version. Expected v' + REQUIRED_BACKEND + ' individual creative delivery. Update the existing Apps Script deployment.');
  }
  console.log('[Backend]', data.version, data.delivery_mode);
}

function importRejection(result) {
  const reason = typeof result?.error === 'string' ? result.error.trim() : '';
  // Only report static diagnostics. A backend exception can contain a bot
  // token, a signed media URL, or sheet data; never echo that raw value.
  const known = {
    'Unauthorized browser import.': ['INGEST_UNAUTHORIZED', 'Apps Script rejected the import key. Compare the GitHub INGEST_KEY with META_LIBRARY_INGEST_KEY in this deployment; do not post either value.'],
    'Another import is running. Retry later.': ['INGEST_BUSY', 'Another Apps Script import holds the lock. This request was rejected before processing.'],
    'TELEGRAM_CONFIG_MISSING': ['TELEGRAM_CONFIG_MISSING', 'Apps Script is missing the Telegram token or ALERT_CHAT_IDS.'],
    'Run setupRadar() from the destination Google Sheet first.': ['SHEET_NOT_CONFIGURED', 'The deployed Apps Script has no destination spreadsheet configured.'],
    'Cloud import did not include a request body.': ['INGEST_BAD_PAYLOAD', 'Apps Script received no import body.'],
    'Cloud import payload must contain an ads array.': ['INGEST_BAD_PAYLOAD', 'Apps Script received an invalid ads array.']
  };
  let diagnostic = known[reason];
  if (!diagnostic && /^Missing sheet "/.test(reason)) diagnostic = ['SHEET_MISSING', 'A required radar worksheet is missing. Check the bound spreadsheet setup.'];
  if (!diagnostic && /Service invoked too many times|Quota exceeded|Too many simultaneous invocations/i.test(reason)) diagnostic = ['INGEST_QUOTA', 'Apps Script reported a service or execution quota limit.'];
  if (!diagnostic && /is not defined|is not a function|Cannot read (?:properties|property)/i.test(reason)) diagnostic = ['INGEST_SCRIPT_ERROR', 'Apps Script reported a code/dependency error. Inspect its Executions error details; do not change the ingest key based on this error.'];
  diagnostic = diagnostic || ['INGEST_REJECTED', 'Apps Script rejected the import with an unclassified server error. Inspect Run_Status or Apps Script Executions. No automatic retry was made.'];
  const error = new Error(diagnostic[0] + ': ' + diagnostic[1]);
  error.code = diagnostic[0];
  return error;
}

async function requestImport(endpoint, body, fetcher, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + 180000;
  const busyDelays = [5000, 15000];
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('INGEST_TIMEOUT: Import deadline reached. No automatic retry of an uncertain request.');
    // All busy retries share one three-minute deadline. Network timeouts,
    // non-JSON responses and failures after processing are never retried.
    const response = await fetcher(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(Math.ceil(remaining)),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body
    });
    if (!response.ok) throw new Error('Apps Script HTTP ' + response.status);
    let result;
    try { result = await response.json(); } catch { throw new Error('Apps Script returned a non-JSON response; check the deployment.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error('INGEST_INVALID_RESPONSE: Apps Script returned an invalid import result.');
    if (result.ok) return result;
    const error = importRejection(result);
    if (error.code !== 'INGEST_BUSY' || attempt >= busyDelays.length) throw error;
    const delay = busyDelays[attempt];
    if (now() + delay >= deadline) throw error;
    console.warn('[Import] INGEST_BUSY: waiting ' + delay / 1000 + ' seconds before retry ' + (attempt + 1) + '/' + busyDelays.length + '.');
    await sleep(delay);
  }
}

async function sendBatch(ads, source, query, sourceUrl, configuration, fetcher = fetch, retryOptions = {}) {
  const endpoint = new URL(configuration.url);
  endpoint.searchParams.set('source', source);
  const totals = { accepted: 0, added: 0, alerts: 0 };
  // Three ads per import leave room for paced video uploads and long captions.
  // Send an empty batch too, so a genuine zero-result run is recorded.
  let failed = 0;
  for (let index = 0; index < Math.max(1, ads.length); index += 3) {
    const number = Math.floor(index / 3) + 1;
    const total = Math.max(1, Math.ceil(ads.length / 3));
    console.log('[Import] Batch ' + number + '/' + total + ' starting (' + ads.slice(index, index + 3).length + ' ads): ' + query);
    const heartbeat = setInterval(() => console.log('[Import] Batch ' + number + '/' + total + ': waiting for Apps Script / creative delivery...'), 30000);
    try {
      const body = JSON.stringify({ ads: ads.slice(index, index + 3), ingest_key: configuration.key, search_query: query, source_url: sourceUrl });
      const result = await requestImport(endpoint, body, fetcher, retryOptions);
      if (result.version !== REQUIRED_BACKEND || result.delivery_mode !== 'individual_creative_required') throw new Error('Deployment changed or is outdated; expected individual creative delivery v' + REQUIRED_BACKEND);
      failed += Number(result.telegram_failed) || 0;
      totals.accepted += Number(result.accepted) || 0;
      totals.added += Number(result.added) || 0;
      totals.alerts += Number(result.telegram_alerts) || 0;
      console.log('[Import] Batch ' + number + '/' + total + ' complete:', { accepted: result.accepted || 0, alerts: result.telegram_alerts || 0, pending: result.telegram_failed || 0 });
      if (result.creative_missing) console.warn('[Media] Missing media URLs:', result.creative_missing, '(not marked delivered).');
    } finally { clearInterval(heartbeat); }
  }
  console.log('[Import]', totals);
  if (failed) throw new Error(failed + ' creative deliveries pending. Check CREATIVE_PENDING in Run_Status; other ads in this batch were still processed.');
  return totals;
}

async function assertAccessible(page) {
  const text = await page.locator('body').innerText();
  if (TERMINAL_MESSAGES.test(text) || /\/(login|checkpoint)(\/|\?|$)/i.test(page.url())) {
    throw new SearchError('ACCESS_CHALLENGE', 'The library requires verification or login. Collection paused for this run.', { stop: true });
  }
}

module.exports = { config, selectTerms, sendBatch, assertAccessible, verifyBackend, importRejection, requestImport };
