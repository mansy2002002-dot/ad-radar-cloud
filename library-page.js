// Functions passed to page.evaluate must be self-contained: no Node globals,
// private endpoints, or application state. Read only rendered DOM evidence.
function extractMeta({ minLiveDays = 30, keyword = '', countryCode = 'EG', now = Date.now() }) {
  const clean = (s) => String(s || '').replace(/[\u200b-\u200f\uFEFF]/g, '').trim();
  const plain = (s) => clean(s).replace(/[\u064b-\u065f\u0670]/g, '');
  const idPattern = /(?:معرف المكتبة|Library ID)\s*:\s*(\d+)/i;
  const toUrl = (s) => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch { return ''; } };
  const parseDate = (s) => {
    const text = clean(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    let year, month, day;
    const numbers = text.match(/^(\d{1,4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})/);
    if (numbers) {
      if (numbers[1].length === 4) [year, month, day] = numbers.slice(1).map(Number);
      else [day, month, year] = numbers.slice(1).map(Number); // ar-EG browser locale
    } else {
      const named = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
      if (!named) return null;
      month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
      day = Number(named[2]); year = Number(named[3]);
    }
    const d = new Date(Date.UTC(year, month - 1, day));
    return year >= 2000 && month > 0 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d.getTime() <= now ? d : null;
  };
  const seen = new Set();
  const stats = { cards: 0, dated: 0, active: 0 };
  const ads = [];
  const markers = Array.from(document.querySelectorAll('span')).filter((node) => idPattern.test(clean(node.textContent)));
  for (const marker of markers) {
    let card = marker.parentElement;
    while (card && card !== document.body) {
      const text = plain(card.innerText);
      const ids = text.match(/(?:معرف المكتبة|Library ID)\s*:\s*\d+/gi) || [];
      if (ids.length === 1 && /(?:^|\n)\s*(ممول|Sponsored)\s*(?:\n|$)/i.test(text)) break;
      if (ids.length > 1) { card = null; break; }
      card = card.parentElement;
    }
    if (!card || card === document.body) continue;
    const text = clean(card.innerText);
    const id = text.match(idPattern)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id); stats.cards++;
    const dateText = text.match(/(?:بدأ التشغيل في|تم بدء التشغيل في|Started running on)\s*([^\n]+)/i)?.[1];
    const date = dateText && parseDate(dateText);
    if (!date) continue;
    stats.dated++;
    if (!/(?:^|\n)\s*(نشط|Active)\s*(?:\n|$)/i.test(text)) continue;
    stats.active++;
    const liveDays = Math.floor((now - date.getTime()) / 86400000);
    if (liveDays < minLiveDays) continue;
    const links = Array.from(card.querySelectorAll('a[href]')).map((a) => {
      const raw = toUrl(a.href);
      if (!raw) return null;
      const u = new URL(raw);
      // URLSearchParams already decodes once; decoding again corrupts some stores' URLs.
      const href = u.hostname === 'l.facebook.com' ? toUrl(u.searchParams.get('u')) : raw;
      return { href, host: href ? new URL(href).hostname : '', text: clean(a.innerText || a.getAttribute('aria-label')) };
    }).filter(Boolean);
    const advertiser = links.find((l) => /(^|\.)facebook\.com$/i.test(l.host) && !/\/ads\/|\/help\/|\/policies\/|\/about\//i.test(l.href) && l.text);
    const landing = links.find((l) => l.href && !/(^|\.)(facebook\.com|fb\.com|instagram\.com|fbcdn\.net)$/i.test(l.host));
    const lines = text.split('\n').map(clean).filter(Boolean);
    const sponsored = lines.findIndex((line) => /^(ممول|Sponsored)$/i.test(plain(line)));
    const following = lines.slice(sponsored + 1);
    const end = following.findIndex((line) => /^(?:\d+:\d+\s*\/|Download$|Order Now$|Shop Now$|Install Now$|إرسال رسالة|اتصال الآن|طلب الآن)/i.test(line));
    const caption = sponsored < 0 ? '' : following.slice(0, end < 0 ? following.length : end).join('\n').slice(0, 12000);
    const media = [];
    const add = (type, raw) => { const url = toUrl(raw); if (url && !media.some((item) => item.url === url)) media.push({ type, url }); };
    Array.from(card.querySelectorAll('video')).forEach((v) => {
      const source = [v.currentSrc, v.src, ...Array.from(v.querySelectorAll('source')).map((s) => s.src)].map(toUrl).find(Boolean);
      add('video', source);
    });
    Array.from(card.querySelectorAll('video')).forEach((v) => add('photo', v.poster));
    Array.from(card.querySelectorAll('img[src]')).map((img) => ({ img, rect: img.getBoundingClientRect() }))
      .filter(({ img, rect }) => rect.width >= 100 && rect.height >= 90 && (img.naturalWidth === 0 || img.naturalWidth >= 100))
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
      .forEach(({ img }) => add('photo', img.currentSrc || img.src));
    ads.push({ library_id: id, provider: 'META_LIBRARY', status: 'active', date_basis: 'delivery', start_date: date.toISOString().slice(0, 10),
      live_days: liveDays, advertiser: advertiser?.text || '', advertiser_url: advertiser?.href || '', caption,
      landing_url: landing?.href || '', creative_type: card.querySelector('video') ? 'video' : 'photo', media: media.slice(0, 6), image_url: media.find((m) => m.type === 'photo')?.url || '',
      video_url: media.find((m) => m.type === 'video')?.url || '', preview_url: 'https://www.facebook.com/ads/library/?id=' + id,
      country_codes: [countryCode], search_query: keyword });
  }
  return { ads, stats };
}

function extractTikTok({ country, keyword = '' }) {
  const ads = [];
  const seen = new Set();
  const detailId = (value) => {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || u.hostname !== 'ads.tiktok.com') return '';
      return u.pathname.match(/^\/business\/creativecenter\/topads\/(\d{8,})\/?$/)?.[1] ||
        (/^\/business\/creativecenter\/inspiration\/topads\//.test(u.pathname) ? u.searchParams.get('rid') || u.searchParams.get('ad_id') || u.pathname.match(/\/(\d{8,})\/?$/)?.[1] || '' : '');
    } catch { return ''; }
  };
  // A detail URL gives a real stable identity. Never derive identity from CDN
  // signatures, mutable engagement counts, timestamps, or arbitrary page divs.
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.href); } catch { continue; }
    const id = detailId(url.toString());
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    let card = anchor;
    while (card && card !== document.body) {
      const ids = new Set(Array.from(card.querySelectorAll('a[href]')).map((a) => detailId(a.href)).filter(Boolean));
      if (ids.size > 1) { card = null; break; }
      if (card.querySelector('video,img,[style*="background-image"]') && String(card.innerText || '').trim().length > 20) break;
      card = card.parentElement;
    }
    if (!card || card === document.body) continue;
    seen.add(id);
    const text = String(card.innerText || '').trim();
    const media = [];
    const add = (type, value) => { if (/^https?:\/\//i.test(value || '') && !media.some((m) => m.url === value)) media.push({ type, url: value }); };
    for (const video of card.querySelectorAll('video')) {
      const src = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map((s) => s.src)].find((s) => /^https?:\/\//i.test(s || ''));
      add('video', src); add('photo', video.poster);
    }
    for (const img of card.querySelectorAll('img[src]')) { const r = img.getBoundingClientRect(); if (r.width >= 100 && r.height >= 90) add('photo', img.currentSrc || img.src); }
    for (const node of card.querySelectorAll('[style*="background-image"]')) {
      const r = node.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 90) add('photo', node.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);
    }
    url.hash = '';
    // Preserve only the observed stable detail ID; discard tracking parameters.
    const rid = url.searchParams.get('rid'); const adId = url.searchParams.get('ad_id'); url.search = '';
    if (rid) url.searchParams.set('rid', rid); else if (adId) url.searchParams.set('ad_id', adId);
    ads.push({ library_id: id, provider: 'TIKTOK', status: 'unknown', start_date: '', date_basis: 'unknown',
      advertiser: card.querySelector('[class*="TopadsVideoCard_secondTitle__"]')?.innerText?.trim() || '', advertiser_url: '', caption: '', card_text: text.slice(0, 12000),
      landing_url: '', preview_url: url.toString(), media: media.slice(0, 6),
      creative_type: 'video',
      image_url: media.find((m) => m.type === 'photo')?.url || '', video_url: media.find((m) => m.type === 'video')?.url || '',
      country_codes: [country], search_query: 'TikTok Top Ads (' + country + ')' + (keyword ? ' — ' + keyword : '') });
  }
  return { ads, stats: { cards: ads.length } };
}

function extractTikTokDetail({ expectedId }) {
  const url = new URL(location.href);
  const id = url.pathname.match(/^\/business\/creativecenter\/topads\/(\d{8,})\/?$/)?.[1] ||
    (/^\/business\/creativecenter\/inspiration\/topads\//.test(url.pathname) ? url.searchParams.get('rid') || url.searchParams.get('ad_id') || url.pathname.match(/\/(\d{8,})\/?$/)?.[1] : '');
  if (url.protocol !== 'https:' || url.hostname !== 'ads.tiktok.com' || id !== String(expectedId)) return { error: 'DETAIL_ID_MISMATCH' };
  // These containers were verified on the public detail page. Do not grab the
  // first video in document: the page also contains TikTok's own promo videos.
  const player = document.querySelector('[class*="TopadsDetailPage_videoWrapper__"]');
  const fields = Array.from(document.querySelectorAll('[class*="TopadsDetailPage_infoItem__"]'));
  const field = (label) => fields.find((node) => node.querySelector('[class*="BasicInfoItem_title__"]')?.textContent?.trim() === label);
  const value = (label) => {
    const s = field(label)?.querySelector('[class*="BasicInfoItem_value__"]')?.innerText?.trim() || '';
    return s === '-' ? '' : s;
  };
  const http = (s) => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch { return ''; } };
  const media = [];
  if (player) for (const v of player.querySelectorAll('video')) {
    const src = [v.currentSrc, v.src, ...Array.from(v.querySelectorAll('source')).map((s) => s.src)].map(http).find(Boolean);
    if (src && !media.some((m) => m.url === src)) media.push({ type: 'video', url: src });
    if (http(v.poster)) media.push({ type: 'photo', url: http(v.poster) });
  }
  return { advertiser: value('Brand name'), advertiser_url: http(field('Brand name')?.querySelector('a[href]')?.href),
    caption: value('Ad caption').slice(0, 12000), landing_url: http(field('Landing Page')?.querySelector('a[href]')?.href),
    media, video_url: media.find((m) => m.type === 'video')?.url || '', creative_type: 'video' };
}

module.exports = { extractMeta, extractTikTok, extractTikTokDetail };
