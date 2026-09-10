const { chromium } = require('playwright');

// إعدادات البحث أو صفحة الإعلانات في تيك توك
const TARGET_URL = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/ads/pad/en?region=EG';

// Telegram configuration must come from GitHub Actions secrets.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message, imageUrl = null) {
  const endpoint = imageUrl ? 'sendPhoto' : 'sendMessage';
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`;
  
  const payload = imageUrl ? {
    chat_id: TELEGRAM_CHAT_ID,
    photo: imageUrl,
    caption: message,
    parse_mode: 'Markdown'
  } : {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  };

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

async function scrapeTiktokAds() {
  console.log(`[TikTok Radar] بدء فحص الإعلانات: ${TARGET_URL}`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ar-EG',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(7000); // الانتظار حتى تحميل عناصر الإعلانات بالكامل
    
    // سحب الكروت أو الإعلانات الظاهرة
    const ads = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="item"], [class*="ad"]'));
      const results = [];
      
      for (const card of cards.slice(0, 5)) {
        const linkElem = card.querySelector('a');
        const imgElem = card.querySelector('img');
        const textContent = card.innerText ? card.innerText.replace(/\n+/g, ' ').trim() : '';
        
        if (textContent.length > 10) {
          results.push({
            adLink: linkElem ? linkElem.href : window.location.href,
            imageUrl: imgElem ? imgElem.src : '',
            snippet: textContent.slice(0, 150)
          });
        }
      }
      return results;
    });

    console.log(`[TikTok Radar] تم العثور على ${ads.length} إعلان.`);

    if (ads.length === 0) {
      await sendTelegram(`🔍 *رادار تيك توك*\n\nلم يتم العثور على إعلانات نشطة في الفحص الحالي.`);
      return;
    }

    const targetAds = ads.slice(0, 3);
    for (const ad of targetAds) {
      const message = `🚨 *إعلان جديد على تيك توك!*\n\n` +
                    `📝 *النص:* \`${ad.snippet}\`\n` +
                    `🔗 *رابط التفاصيل:* [فتح في تيك توك](${ad.adLink})`;

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

scrapeTiktokAds().catch(async (err) => {
  console.error(err);
  await sendTelegram(`❌ *خطأ في رادار تيك توك:*\n\`${err.message}\``);
  process.exit(1);
});
