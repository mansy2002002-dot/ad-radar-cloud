const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { config, selectTerms, sendBatch, verifyBackend } = require('../collector-utils');
const { extractMeta, extractTikTok, extractTikTokDetail } = require('../library-page');
const { SEARCH_TERMS, mergeCreative } = require('../scraper');
const { SEARCH_CATEGORIES, customTerms } = require('../search-terms');
const { SearchError, navigatePublic, runSearches, safeError } = require('../search-runtime');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER_PATH ? { executablePath: process.env.TEST_BROWSER_PATH } : {}) });
});
after(async () => { if (browser) await browser.close(); });

const pixel = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
function card(id, date, state = 'نشط') {
  return '<section><div><span>معرف المكتبة: ' + id + '</span></div><div>' + state + '</div><div>بدأ التشغيل في ' + date + '</div>' +
    '<a href="https://www.facebook.com/ShopPage/"><img src="https://cdn.example/avatar.jpg" width="32" height="32">متجر الاختبار</a>' +
    '<div>مُموَّل</div><div>خلاط محمول بـ 299 جنيه &amp; شحن مجاني</div>' +
    '<video src="https://cdn.example/creative.mp4" poster="https://cdn.example/poster.jpg"></video><div>0:00 / 0:50</div>' +
    '<img src="https://cdn.example/product.jpg" width="320" height="260">' +
    '<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2Fproducts%2Fone%3Flabel%3Da%2526b%26fbclid%3Dtest">طلب الآن</a></section>';
}

test('Meta only accepts active dated cards, captures creatives and caption, decodes store once', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent(card('111', '٠١‏/٠٧‏/٢٠٢٦') + card('222', '01/09/2026') + card('333', '31/02/2026') + card('444', '01/07/2026', 'غير نشط'));
  const result = await page.evaluate(extractMeta, { minLiveDays: 30, now: Date.UTC(2026, 8, 5) });
  assert.equal(result.stats.cards, 4);
  assert.equal(result.ads.length, 1);
  const ad = result.ads[0];
  assert.equal(ad.library_id, '111');
  assert.equal(ad.start_date, '2026-07-01');
  assert.equal(ad.caption, 'خلاط محمول بـ 299 جنيه & شحن مجاني');
  assert.equal(ad.advertiser, 'متجر الاختبار');
  assert.equal(ad.landing_url, 'https://shop.example/products/one?label=a%26b&fbclid=test');
  assert(ad.media.some((m) => m.type === 'video'));
  assert(ad.media.some((m) => m.url.endsWith('product.jpg')));
  assert(!ad.media.some((m) => m.url.includes('avatar')));
  await page.close();
});

test('Meta recognizes English month dates and ISO dates without collecting an entire result container', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<main>' + card('111', 'Jul 1, 2026').replace('بدأ التشغيل في', 'Started running on') + card('222', '2026-07-02') + '</main>');
  const result = await page.evaluate(extractMeta, { now: Date.UTC(2026, 8, 5) });
  assert.equal(result.ads.length, 2);
  assert.equal(result.ads[1].start_date, '2026-07-02');
  await page.close();
});

test('TikTok uses a real stable detail ID across CDN / metric changes, and leaves unknown facts empty', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const html = (metric, signature) => '<section><a href="https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?rid=123456789012&utm_source=x">View creative</a>' +
    '<div>Travel advertisement likes ' + metric + '</div><img width="250" height="250" src="https://cdn.example/ad.jpg?sig=' + signature + '"></section>' +
    '<div><img src="' + pixel + '">This unrelated navigation tile is not an advertisement.</div>';
  await page.setContent(html(20, 'a'));
  const first = await page.evaluate(extractTikTok, { country: 'EG' });
  await page.setContent(html(40, 'b'));
  const second = await page.evaluate(extractTikTok, { country: 'EG' });
  assert.equal(first.ads.length, 1);
  assert.equal(first.ads[0].library_id, second.ads[0].library_id);
  assert.equal(first.ads[0].start_date, '');
  assert.equal(first.ads[0].status, 'unknown');
  assert.equal(first.ads[0].landing_url, '');
  await page.close();
});

test('a full rotation covers every category and term; reruns choose the same terms', () => {
  const chosen = Array.from({ length: Math.ceil(SEARCH_TERMS.length / 4) }, (_, i) => selectTerms(SEARCH_TERMS, 4, i + 1)).flat();
  assert.equal(new Set(chosen).size, SEARCH_TERMS.length);
  assert.deepEqual(selectTerms(SEARCH_TERMS, 4, 5), selectTerms(SEARCH_TERMS, 4, 5));
  assert(SEARCH_TERMS.length >= 250);
  assert.equal(SEARCH_TERMS.length, new Set(SEARCH_TERMS).size);
  for (const word of ['ساعة', 'ساعات', 'طبي', 'قياس', 'مساج', 'قطعة', 'تيشرت', 'بنطلون', 'عرض القطعتين', '299', '999']) assert(SEARCH_TERMS.includes(word));
  assert.deepEqual(SEARCH_TERMS.slice(0, Object.keys(SEARCH_CATEGORIES).length), Object.values(SEARCH_CATEGORIES).map((words) => words[0]));
  assert.deepEqual(customTerms('ساعة،تيشرت,ساعة\nبنطلون'), ['ساعة', 'تيشرت', 'بنطلون']);
});

test('ingest does not report rejected or partially failed imports as success', async () => {
  const cfg = config({ WEB_APP_URL: 'https://script.google.com/macros/s/example/exec', INGEST_KEY: 'test-secret' });
  await assert.rejects(sendBatch([], 'meta_library', 'q', 'source', cfg, async () => ({ ok: true, json: async () => ({ ok: false }) })), /rejected/);
  await assert.rejects(sendBatch([], 'meta_library', 'q', 'source', cfg, async () => ({ ok: true, json: async () => ({ ok: true, telegram_failed: 1, version: '1.4.0', delivery_mode: 'individual_creative_required' }) })), /deliveries pending/);
  assert.throws(() => config({ WEB_APP_URL: 'https://example.com', INGEST_KEY: 'x' }), /exec/);
});

test('preflight rejects old deployed text endpoint before an import', async () => {
  const cfg = { url: 'https://script.google.com/macros/s/test/exec' };
  await assert.rejects(verifyBackend(cfg, async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return { ok: true, json: async () => { throw new Error('Ad Radar webhook is running.'); } };
  }), /OLD WEB APP/);
  await verifyBackend(cfg, async () => ({ ok: true, json: async () => ({ version: '1.4.0', delivery_mode: 'individual_creative_required' }) }));
});

test('video URLs survive later virtualized observations with empty sources', () => {
  const previous = { library_id: '111', video_url: 'https://cdn.example/video.mp4', image_url: 'https://cdn.example/poster.jpg', media: [{ type: 'video', url: 'https://cdn.example/video.mp4' }], creative_type: 'video' };
  const result = mergeCreative(previous, { library_id: '111', video_url: '', image_url: '', media: [] });
  assert.equal(result.video_url, previous.video_url);
  assert.equal(result.media.length, 1);
  assert.equal(result.creative_type, 'video');
});

test('blob player does not hide an available HTTP source; poster-only video is labelled video', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const html = card('111', '01/07/2026').replace('src="https://cdn.example/creative.mp4"', 'src="blob:local-player"').replace('</video>', '<source src="https://cdn.example/real.mp4"></video>') + card('222', '01/07/2026').replace('src="https://cdn.example/creative.mp4"', 'src="blob:local-only"');
  await page.setContent(html);
  const result = await page.evaluate(extractMeta, { now: Date.UTC(2026, 8, 5) });
  assert.equal(result.ads[0].video_url, 'https://cdn.example/real.mp4');
  assert.equal(result.ads[1].video_url, '');
  assert.equal(result.ads[1].creative_type, 'video');
  await page.close();
});

test('later batches still process when one ad has a missing creative', async () => {
  const cfg = { url: 'https://script.google.com/macros/s/test/exec', key: 'dummy' };
  let batches = 0;
  await assert.rejects(sendBatch(Array.from({ length: 7 }, (_, i) => ({ library_id: i })), 'meta_library', 'q', 'source', cfg, async (url, options) => {
    batches++;
    assert(JSON.parse(options.body).ads.length <= 3);
    return { ok: true, json: async () => ({ ok: true, version: '1.4.0', delivery_mode: 'individual_creative_required', telegram_failed: batches === 1 ? 1 : 0 }) };
  }), /deliveries pending/);
  assert.equal(batches, 3);
});

test('current TikTok paths and CSS covers yield separate real video identities', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const tile = (host, id) => '<section><div style="width:250px;height:300px;background-image:url(https://cdn.example/cover-' + id + '.jpg)"></div><span>Conversions, Watches, Likes 50</span><a href="https://' + host + '/business/creativecenter/topads/' + id + '">See analytics</a></section>';
  await page.setContent('<main>' + tile('ads.tiktok.com', '7662665049610387463') + tile('ads.tiktok.com', '7665232582635946001') + tile('evil.example', '99999999999999') + '</main>');
  const result = await page.evaluate(extractTikTok, { country: 'EG' });
  assert.equal(result.ads.length, 2);
  assert.equal(result.ads[0].preview_url, 'https://ads.tiktok.com/business/creativecenter/topads/7662665049610387463');
  assert.equal(result.ads[0].creative_type, 'video');
  assert.equal(result.ads[0].video_url, '');
  assert.match(result.ads[0].image_url, /cover-7662665049610387463/);
  await page.close();
});

function detailFixture() {
  const field = (name, html) => '<div class="TopadsDetailPage_infoItem__test"><span class="BasicInfoItem_title__test">' + name + '</span><span class="BasicInfoItem_value__test">' + html + '</span></div>';
  return '<meta charset="utf-8"><video src="https://cdn.example/promo.mp4"></video>' +
    '<div class="TopadsDetailPage_videoWrapper__test"><video src="blob:player"><source src="https://cdn.example/real.mp4"></video></div>' +
    field('Brand name', '<a href="https://www.tiktok.com/@shop">Watch Shop</a>') +
    field('Landing Page', '<a href="https://shop.example/product/1">Shop</a>') +
    field('Ad caption', 'ساعة جديدة 299 جنيه') +
    '<video src="https://cdn.example/recommended.mp4"></video>';
}

test('TikTok detail collects the ad video and labelled caption, never site promo videos', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html', body: detailFixture() }) : route.abort());
  await page.goto('https://ads.tiktok.com/business/creativecenter/topads/7662665049610387463');
  const result = await page.evaluate(extractTikTokDetail, { expectedId: '7662665049610387463' });
  assert.equal(result.video_url, 'https://cdn.example/real.mp4');
  assert.equal(result.caption, 'ساعة جديدة 299 جنيه');
  assert.equal(result.advertiser, 'Watch Shop');
  assert.equal(result.advertiser_url, 'https://www.tiktok.com/@shop');
  assert.equal(result.landing_url, 'https://shop.example/product/1');
  assert.equal(result.media.length, 1);
  assert.equal((await page.evaluate(extractTikTokDetail, { expectedId: '9999999999' })).error, 'DETAIL_ID_MISMATCH');
  await page.close();
});

test('a denied search is not retried and later independent searches still complete', async () => {
  let attempts = 0;
  const page = { goto: async () => { attempts++; return { status: () => 403 }; }, waitForTimeout: async () => assert.fail('403 must not retry') };
  const summary = await runSearches('Meta', [{ name: 'denied' }, { name: 'available' }], async ({ name }) => {
    if (name === 'denied') await navigatePublic(page, 'https://example.com', 'Meta');
    return { alerts: 3 };
  }, { report: () => {} });
  assert.equal(attempts, 1);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.completed, 1);
  assert.equal(summary.skipped, 1);
});

test('all blocked searches remain failures; actual delivery errors cannot be hidden by partial success', async () => {
  await assert.rejects(runSearches('TikTok', [{ name: 'EG' }, { name: 'SA' }], async () => { throw new SearchError('HTTP_403', 'refused'); }, { report: () => {} }), /No searches completed/);
  let worked = 0;
  await assert.rejects(runSearches('Meta', [{ name: 'one' }, { name: 'two' }], async () => {
    if (!worked++) throw new Error('creative deliveries pending');
  }, { report: () => {} }), /extraction\/import failures/);
  assert.equal(worked, 2);
});

test('rate limits and verification stop remaining work; transient navigation retries once', async () => {
  let called = 0, report;
  await assert.rejects(runSearches('TikTok', [{ name: 'EG' }, { name: 'SA' }], async () => { called++; throw new SearchError('HTTP_429', 'rate limited', { stop: true }); }, { report: (value) => { report = value; } }), /No searches completed/);
  assert.equal(called, 1);
  assert.equal(report.results[1].status, 'deferred');
  let navigations = 0, sleeps = 0;
  await navigatePublic({ goto: async () => ({ status: () => ++navigations === 1 ? 503 : 200 }), waitForTimeout: async () => { sleeps++; } }, 'https://example.com', 'TikTok');
  assert.equal(navigations, 2); assert.equal(sleeps, 1);
  assert.equal(safeError(new Error('token SECRET failed at https://cdn.example/signed?key=SECRET'), 'SECRET'), 'token [redacted] failed at [url]');
});

test('TikTok country failure does not prevent a later country sending an enriched video', async () => {
  const { scrapeCountry } = require('../scraper_tiktok');
  const context = await browser.newContext();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => ({ ok: true, version: '1.4.0', delivery_mode: 'individual_creative_required', accepted: body.ads.length, telegram_alerts: body.ads.length }) };
  };
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!route.request().isNavigationRequest()) return route.abort();
    if (url.searchParams.get('region') === 'EG') return route.fulfill({ status: 403, body: 'Access denied' });
    if (/\/topads\/7662665049610387463$/.test(url.pathname)) return route.fulfill({ contentType: 'text/html', body: detailFixture() });
    return route.fulfill({ contentType: 'text/html', body: '<section><div>Conversions Watches 50 Likes</div><img width="250" height="250" src="https://cdn.example/cover.jpg"><a href="https://ads.tiktok.com/business/creativecenter/topads/7662665049610387463">See analytics</a></section>' });
  });
  try {
    const summary = await runSearches('TikTok', [{ name: 'EG' }, { name: 'SA' }], ({ name }) => scrapeCountry(context, name, { url: 'https://script.google.com/macros/s/mock/exec', key: 'test' }), { report: () => {} });
    assert.equal(summary.status, 'partial');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ads[0].video_url, 'https://cdn.example/real.mp4');
    assert.equal(calls[0].ads[0].caption, 'ساعة جديدة 299 جنيه');
  } finally { global.fetch = originalFetch; await context.close(); }
});
