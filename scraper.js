const axios = require('axios');
const cheerio = require('cheerio');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`;
const KV_HEADERS = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };

async function kvGet(key) {
  try {
    const res = await axios.get(`${KV_BASE}/${key}`, { headers: KV_HEADERS });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch (e) { return null; }
}

async function kvSet(key, value) {
  await axios.put(`${KV_BASE}/${key}`, JSON.stringify(value), { headers: KV_HEADERS });
}

function todayDate() {
  return new Date().toLocaleDateString('en-PK', {
    timeZone: 'Asia/Karachi', day: '2-digit', month: 'short'
  });
}

function updateHistory(history, rateName, newRate) {
  if (!history[rateName]) history[rateName] = [];
  const today = todayDate();
  const existing = history[rateName].findIndex(e => e.date === today);
  if (existing >= 0) {
    history[rateName][existing].rate = newRate;
  } else {
    history[rateName].push({ date: today, rate: newRate });
  }
  // 30 din se purana hata do
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  history[rateName] = history[rateName].filter(entry => {
    const parts = entry.date.split(' ');
    const entryDate = new Date(`${parts[1]} ${parts[0]} ${new Date().getFullYear()}`);
    return entryDate >= cutoff;
  });
  return history;
}

async function scrapeUSD() {
  try {
    const res = await axios.get('https://www.sbp.org.pk/ecodata/index2.asp', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const rate = $('table tr').eq(1).find('td').eq(1).text().trim();
    return parseFloat(rate) || 278.50;
  } catch (e) {
    console.log('USD scrape fail, fallback use kar raha hoon');
    return 278.50;
  }
}

async function scrapeGold() {
  try {
    const res = await axios.get('https://goldrates.com.pk', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const rate = $('.gold-24k').first().text().trim();
    return parseFloat(rate.replace(/,/g, '')) || 245000;
  } catch (e) {
    console.log('Gold scrape fail, fallback use kar raha hoon');
    return 245000;
  }
}

async function scrapePetrolDiesel() {
  try {
    const res = await axios.get('https://www.ogra.org.pk/petroleum-products', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    let petrol = 289, diesel = 270;
    $('table tr').each((i, row) => {
      const text = $(row).text().toLowerCase();
      if (text.includes('petrol') || text.includes('ms')) {
        const val = parseFloat($(row).find('td').eq(2).text().trim());
        if (val > 0) petrol = val;
      }
      if (text.includes('diesel') || text.includes('hsd')) {
        const val = parseFloat($(row).find('td').eq(2).text().trim());
        if (val > 0) diesel = val;
      }
    });
    return { petrol, diesel };
  } catch (e) {
    console.log('Petrol/Diesel scrape fail, fallback use kar raha hoon');
    return { petrol: 289, diesel: 270 };
  }
}

async function scrapeCrypto() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { timeout: 10000 }
    );
    return { bitcoin: res.data.bitcoin.usd, ethereum: res.data.ethereum.usd };
  } catch (e) {
    console.log('Crypto scrape fail, fallback use kar raha hoon');
    return { bitcoin: 67000, ethereum: 2000 };
  }
}

async function scrapePSX() {
  try {
    const res = await axios.get('https://dps.psx.com.pk/indices', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    let kse100 = null;
    $('table tr').each((i, row) => {
      const text = $(row).text();
      if (text.includes('KSE-100') || text.includes('KSE100')) {
        const val = parseFloat($(row).find('td').eq(1).text().replace(/,/g, '').trim());
        if (val > 0) kse100 = val;
      }
    });
    return kse100 || 115000;
  } catch (e) {
    console.log('PSX scrape fail, fallback use kar raha hoon');
    return 115000;
  }
}

async function scrapeAll() {
  console.log('Scraping shuru ho rahi hai...');

  const usd = await scrapeUSD();
  const gold = await scrapeGold();
  const { petrol, diesel } = await scrapePetrolDiesel();
  const crypto = await scrapeCrypto();
  const psx = await scrapePSX();

  // Purani history KV se lo
  let history = await kvGet('history');
  if (!history || typeof history !== 'object') history = {};

  // Har rate ki history update karo — 30 din tak rakho
  updateHistory(history, 'usd', usd);
  updateHistory(history, 'gold', gold);
  updateHistory(history, 'petrol', petrol);
  updateHistory(history, 'diesel', diesel);
  updateHistory(history, 'bitcoin', crypto.bitcoin);
  updateHistory(history, 'ethereum', crypto.ethereum);
  updateHistory(history, 'psx', psx);

  const data = {
    usd,
    gold,
    petrol,
    diesel,
    bitcoin: crypto.bitcoin,
    ethereum: crypto.ethereum,
    psx,
    electricity: 42,
    updated: new Date().toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  };

  // Latest rates save karo
  await kvSet('rates', data);

  // History alag key mein save karo
  await kvSet('history', history);

  console.log('Data ready:', data);
  console.log('History 30 din tak save ho gayi!');
}

scrapeAll();