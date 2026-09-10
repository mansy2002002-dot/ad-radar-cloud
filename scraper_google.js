const { chromium } = require('playwright');

// إعدادات المنافس ورابط الفحص
const ADVERTISER_ID = process.env.GOOGLE_ADVERTISER_ID || 'AR04324359956229783553';
const REGION = process.env.GOOGLE_REGION || 'anywhere';
const TARGET_URL = `https://adstransparency.google.com/advertiser/${ADVERTISER_ID}?region=${REGION}`;

// Telegram configuration must come from GitHub Actions secrets.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message, imageUrl = null) {
  const endpoint = imageUrl ? 'sendPhoto' : 'sendMessage';
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`;

  const payload = imageUrl
    ? { chat_id: TELEGRAM_CHAT_ID, photo: imageUrl, caption: message, parse_mode: 'Markdown' }
    : { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram API error:', data.description);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

async function scrapeGoogleAds() {
  console.log(`[Google Radar] بدء فحص المعلن: ${TARGET_URL}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ar-EG',
    viewport: { width: 1440, height: 1000 }
  });
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 });

    await page.waitForSelector('creative-preview, .creative-container, h1, body', { timeout: 20000 });
    await page.waitForTimeout(5000);

    const advertiserName = await page.evaluate(() => {
      const heading = document.querySelector('h1') || document.querySelector('[role="heading"]');
      return heading ? heading.innerText.trim() : 'منافس محدد';
    });

    const ads = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('creative-preview, a[href*="/creative/"]'));
      const results = [];

      for (const card of cards) {
        const linkElem = card.closest('a') || card.querySelector('a');
        const imgElem = card.querySelector('img');
        const videoElem = card.querySelector('video');

        const adLink = linkElem ? linkElem.href : window.location.href;
        const imageUrl = imgElem ? imgElem.src : '';
        const isVideo = !!videoElem || card.innerText.includes('فيديو') || card.innerText.includes('Video');

        if (imageUrl || isVideo || linkElem) {
          results.push({
            adLink,
            imageUrl,
            format: isVideo ? '🎥 فيديو' : '🖼️ صورة / نص',
            snippet: card.innerText.replace(/\n+/g, ' ').slice(0, 120).trim()
          });
        }
      }
      return results;
    });

    console.log(`[Google Radar] تم العثور على ${ads.length} إعلان للمعلن: ${advertiserName}`);

    if (ads.length === 0) {
      await sendTelegram(`🔍 *رادار جوجل*\n\nلم يتم العثور على إعلانات نشطة حالياً للمعلن:\n*${advertiserName}*`);
      return;
    }

    const targetAds = ads.slice(0, 3);
    for (const ad of targetAds) {
      const message =
        `🚨 *إعلان جديد على جوجل للمنافس!*\n\n` +
        `👤 *المعلن:* ${advertiserName}\n` +
        `📦 *النوع:* ${ad.format}\n` +
        `🔗 *رابط المعاينة:* [فتح الإعلان في جوجل](${ad.adLink})\n` +
        (ad.snippet ? `📝 *النص:* \`${ad.snippet}\`\n` : '');

      if (ad.imageUrl && ad.imageUrl.startsWith('http')) {
        await sendTelegram(message, ad.imageUrl);
      } else {
        await sendTelegram(message);
      }
    }
  } finally {
    await browser.close();
  }
}

scrapeGoogleAds().catch(async (err) => {
  console.error(err);
  await sendTelegram(`❌ *خطأ في رادار جوجل:*\n\`${err.message}\``);
  process.exit(1);
});
