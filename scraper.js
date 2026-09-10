const { chromium } = require('playwright');
const { config, selectTerms, sendBatch, assertAccessible, verifyBackend } = require('./collector-utils');
const { extractMeta } = require('./library-page');
const { SEARCH_TERMS, customTerms } = require('./search-terms');
const { navigatePublic, runSearches } = require('./search-runtime');

function libraryUrl(keyword, country) {
  const url = new URL('https://www.facebook.com/ads/library/');
  for (const [key, value] of Object.entries({
    active_status: 'active', ad_type: 'all', country, media_type: 'all', q: keyword,
    search_type: 'keyword_unordered'
  })) url.searchParams.set(key, value);
  return url.toString();
}

async function scrapeKeyword(page, keyword, options) {
  const sourceUrl = libraryUrl(keyword, options.country);
  await navigatePublic(page, sourceUrl, 'Meta');
  // Wait for evidence of results instead of assuming a fixed delay succeeded.
  await page.waitForFunction(() => /Library ID|معرف المكتبة|No results|لم نعثر|لا توجد نتائج/.test(document.body?.innerText || ''), null, { timeout: 20000 }).catch(() => {});
  await assertAccessible(page);
  const collected = new Map();
  let foundCards = 0, datedCards = 0, unchanged = 0, priorCount = 0;
  for (let round = 0; round < 12 && unchanged < 3; round++) {
    const result = await page.evaluate(extractMeta, { keyword, countryCode: options.country, minLiveDays: options.days });
    foundCards = Math.max(foundCards, result.stats.cards);
    datedCards = Math.max(datedCards, result.stats.dated);
    result.ads.forEach((ad) => collected.set(ad.library_id, mergeCreative(collected.get(ad.library_id), ad)));
    const count = await page.getByText(/Library ID:|معرف المكتبة:/).count();
    unchanged = count <= priorCount ? unchanged + 1 : 0;
    priorCount = Math.max(priorCount, count);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
    await page.waitForTimeout(1000);
  }
  if (!foundCards) {
    const text = await page.locator('body').innerText();
    if (!/No results|لم نعثر|لا توجد نتائج/i.test(text)) throw new Error('No recognizable Meta cards: page not loaded, login required, or layout changed.');
  } else if (!datedCards) throw new Error('Meta dates were not recognized. No fabricated dates were imported.');
  const ads = Array.from(collected.values()).sort((a, b) => b.live_days - a.live_days);
  console.log('[Meta]', { keyword, cards: foundCards, eligible: ads.length });
  return sendBatch(ads, 'meta_library', keyword, sourceUrl, options.configuration);
}

async function main(env = process.env) {
  const configuration = config(env);
  await verifyBackend(configuration);
  const country = (env.COUNTRY_CODE || 'EG').toUpperCase();
  const days = Number(env.MIN_LIVE_DAYS || 30);
  if (!/^[A-Z]{2}$/.test(country) || !Number.isFinite(days) || days < 1) throw new Error('Invalid COUNTRY_CODE or MIN_LIVE_DAYS.');
  const custom = customTerms(env.SEARCH_KEYWORDS);
  if (custom.length > 12) throw new Error('Use at most 12 custom keywords per run.');
  const terms = custom.length ? custom : selectTerms(SEARCH_TERMS, Math.min(12, Number(env.TERMS_PER_RUN) || 4), env.GITHUB_RUN_NUMBER);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'ar-EG', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    console.log('[Meta] Terms:', terms.join(' | '));
    return await runSearches('Meta', terms.map((name) => ({ name })), ({ name }) => scrapeKeyword(page, name, { configuration, country, days }), { secret: configuration.key });
  } finally { await browser.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
function mergeCreative(previous, current) {
  if (!previous) return current;
  // Virtualized cards can lose their media when scrolled off-screen. Retain
  // the richest observed creative, preferring later URLs of the same kind.
  const media = [...(current.media || []), ...(previous.media || [])].filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index).slice(0, 6);
  return { ...previous, ...current, media, video_url: current.video_url || previous.video_url || '', image_url: current.image_url || previous.image_url || '', creative_type: current.creative_type || previous.creative_type || '' };
}
module.exports = { SEARCH_TERMS, libraryUrl, scrapeKeyword, main, mergeCreative };
