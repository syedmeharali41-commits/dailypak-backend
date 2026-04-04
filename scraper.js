const axios = require('axios');
const cheerio = require('cheerio');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`;
const KV_HEADERS = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

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
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  history[rateName] = history[rateName].filter(entry => {
    const parts = entry.date.split(' ');
    const entryDate = new Date(`${parts[1]} ${parts[0]} ${new Date().getFullYear()}`);
    return entryDate >= cutoff;
  });
  return history;
}

// ============================================================
// CATEGORY 1: CURRENCIES (10)
// ============================================================
async function scrapeCurrencies() {
  try {
    const res = await axios.get('https://www.hamariweb.com/finance/forex/open_market_rates.aspx', {
      timeout: 15000, headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(res.data);
    const rates = { usd: 278.5, aed: 75.8, sar: 74.2, eur: 305.0, gbp: 352.0, cny: 38.5, try: 8.1, cad: 204.0, aud: 181.0, qar: 76.5 };
    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const name = $(cells[0]).text().toLowerCase().trim();
      const sell = parseFloat($(cells[2]).text().replace(/,/g, '').trim());
      if (!sell || sell <= 0) return;
      if (name.includes('us dollar') || name.includes('usd')) rates.usd = sell;
      else if (name.includes('uae') || name.includes('dirham') || name.includes('aed')) rates.aed = sell;
      else if (name.includes('saudi') || name.includes('riyal') || name.includes('sar')) rates.sar = sell;
      else if (name.includes('euro') || name.includes('eur')) rates.eur = sell;
      else if (name.includes('pound') || name.includes('gbp')) rates.gbp = sell;
      else if (name.includes('yuan') || name.includes('chinese') || name.includes('cny')) rates.cny = sell;
      else if (name.includes('turkish') || name.includes('lira') || name.includes('try')) rates.try = sell;
      else if (name.includes('canadian') || name.includes('cad')) rates.cad = sell;
      else if (name.includes('australian') || name.includes('aud')) rates.aud = sell;
      else if (name.includes('qatari') || name.includes('qar')) rates.qar = sell;
    });
    console.log('Currencies scraped:', rates);
    return rates;
  } catch (e) {
    console.log('Currencies scrape fail, fallback use kar raha hoon:', e.message);
    return { usd: 278.5, aed: 75.8, sar: 74.2, eur: 305.0, gbp: 352.0, cny: 38.5, try: 8.1, cad: 204.0, aud: 181.0, qar: 76.5 };
  }
}

// ============================================================
// CATEGORY 2: GOLD & METALS (5)
// ============================================================
async function scrapeMetals() {
  try {
    const res = await axios.get('https://gold.pk/', {
      timeout: 15000, headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(res.data);
    let gold24k = 490000, gold22k = 449200, goldGram = 42000, silverTola = 7800;

    $('table tr, .rate-row, .gold-rate').each((i, row) => {
      const text = $(row).text();
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const label = $(cells[0]).text().toLowerCase().trim();
      const val = parseFloat($(cells[1]).text().replace(/,/g, '').replace(/rs\.?/gi, '').trim());
      if (!val || val <= 0) return;
      if (label.includes('24') && label.includes('tola')) gold24k = val;
      else if (label.includes('22') && label.includes('tola')) gold22k = val;
      else if (label.includes('gram') && label.includes('24')) goldGram = val;
      else if (label.includes('silver') && label.includes('tola')) silverTola = val;
    });

    // Platinum international se calculate karo (gold se approximate)
    const platinum = Math.round(gold24k * 0.065);

    console.log('Metals scraped:', { gold24k, gold22k, goldGram, silverTola, platinum });
    return { gold24k, gold22k, goldGram, silverTola, platinum };
  } catch (e) {
    console.log('Metals scrape fail, fallback:', e.message);
    return { gold24k: 490000, gold22k: 449200, goldGram: 42000, silverTola: 7800, platinum: 31850 };
  }
}

// ============================================================
// CATEGORY 3: FUEL (4)
// ============================================================
async function scrapeFuel() {
  try {
    const res = await axios.get('https://www.ogra.org.pk/petroleum-products', {
      timeout: 15000, headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(res.data);
    let petrol = 289, diesel = 283, kerosene = 186, lightDiesel = 178;

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const text = $(row).text().toLowerCase();
      const val = parseFloat($(cells[cells.length - 1]).text().replace(/,/g, '').trim());
      if (!val || val <= 0) return;
      if (text.includes('petrol') || text.includes('motor spirit') || text.includes(' ms ')) petrol = val;
      else if (text.includes('high speed diesel') || text.includes('hsd')) diesel = val;
      else if (text.includes('kerosene')) kerosene = val;
      else if (text.includes('light diesel') || text.includes('ldo')) lightDiesel = val;
    });

    console.log('Fuel scraped:', { petrol, diesel, kerosene, lightDiesel });
    return { petrol, diesel, kerosene, lightDiesel };
  } catch (e) {
    console.log('Fuel scrape fail, fallback:', e.message);
    return { petrol: 289, diesel: 283, kerosene: 186, lightDiesel: 178 };
  }
}

// ============================================================
// CATEGORY 4: CRYPTO (8)
// ============================================================
async function scrapeCrypto() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,cardano,dogecoin,tron&vs_currencies=usd',
      { timeout: 15000 }
    );
    const d = res.data;
    const result = {
      bitcoin: d.bitcoin?.usd || 67000,
      ethereum: d.ethereum?.usd || 2050,
      bnb: d.binancecoin?.usd || 580,
      solana: d.solana?.usd || 130,
      xrp: d.ripple?.usd || 2.1,
      cardano: d.cardano?.usd || 0.65,
      dogecoin: d.dogecoin?.usd || 0.17,
      tron: d.tron?.usd || 0.23
    };
    console.log('Crypto scraped:', result);
    return result;
  } catch (e) {
    console.log('Crypto scrape fail, fallback:', e.message);
    return { bitcoin: 67000, ethereum: 2050, bnb: 580, solana: 130, xrp: 2.1, cardano: 0.65, dogecoin: 0.17, tron: 0.23 };
  }
}

// ============================================================
// CATEGORY 5: PSX STOCKS (3)
// ============================================================
async function scrapeStocks() {
  try {
    const res = await axios.get('https://dps.psx.com.pk/indices', {
      timeout: 15000, headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(res.data);
    let kse100 = 115000, kse30 = 35000, kmi30 = 52000;

    $('table tr').each((i, row) => {
      const text = $(row).text();
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const val = parseFloat($(cells[1]).text().replace(/,/g, '').trim());
      if (!val || val <= 0) return;
      if (text.includes('KSE-100') || text.includes('KSE100')) kse100 = val;
      else if (text.includes('KSE-30') || text.includes('KSE30')) kse30 = val;
      else if (text.includes('KMI-30') || text.includes('KMI30')) kmi30 = val;
    });

    console.log('Stocks scraped:', { kse100, kse30, kmi30 });
    return { kse100, kse30, kmi30 };
  } catch (e) {
    console.log('Stocks scrape fail, fallback:', e.message);
    return { kse100: 115000, kse30: 35000, kmi30: 52000 };
  }
}

// ============================================================
// CATEGORY 6: ELECTRICITY (3) - Static (NEPRA regulated)
// ============================================================
function getElectricity() {
  return { normal: 47, peak: 58, offpeak: 36 };
}

// ============================================================
// CATEGORY 7: AGRICULTURE (4)
// ============================================================
async function scrapeAgriculture() {
  try {
    const res = await axios.get('https://priceit.pk/wheat-price-in-pakistan/', {
      timeout: 15000, headers: BROWSER_HEADERS
    });
    const $ = cheerio.load(res.data);
    let wheat = 2500;
    $('table tr').each((i, row) => {
      const text = $(row).text().toLowerCase();
      if (text.includes('punjab') || text.includes('per kg')) {
        const val = parseFloat($(row).find('td').last().text().replace(/,/g, '').replace('rs', '').trim());
        if (val > 0 && val < 500) wheat = val;
      }
    });
    console.log('Agriculture wheat scraped:', wheat);
    return {
      wheat,
      rice: 175,
      sugar: 155,
      cotton: 8500
    };
  } catch (e) {
    console.log('Agriculture scrape fail, fallback:', e.message);
    return { wheat: 2500, rice: 175, sugar: 155, cotton: 8500 };
  }
}

// ============================================================
// CATEGORY 8: PROPERTY (3) - Static (quarterly update)
// ============================================================
function getProperty() {
  return { lahore: 1250000, karachi: 1500000, islamabad: 2000000 };
}

// ============================================================
// MAIN FUNCTION
// ============================================================
async function scrapeAll() {
  console.log('\n========================================');
  console.log('DailyPak Scraper — 40 Rates Shuru...');
  console.log('========================================\n');

  const currencies = await scrapeCurrencies();
  const metals = await scrapeMetals();
  const fuel = await scrapeFuel();
  const crypto = await scrapeCrypto();
  const stocks = await scrapeStocks();
  const electricity = getElectricity();
  const agriculture = await scrapeAgriculture();
  const property = getProperty();

  // Purani history KV se lo
  let history = await kvGet('history');
  if (!history || typeof history !== 'object') history = {};

  // ---- CURRENCIES history ----
  updateHistory(history, 'usd', currencies.usd);
  updateHistory(history, 'aed', currencies.aed);
  updateHistory(history, 'sar', currencies.sar);
  updateHistory(history, 'eur', currencies.eur);
  updateHistory(history, 'gbp', currencies.gbp);
  updateHistory(history, 'cny', currencies.cny);
  updateHistory(history, 'try', currencies.try);
  updateHistory(history, 'cad', currencies.cad);
  updateHistory(history, 'aud', currencies.aud);
  updateHistory(history, 'qar', currencies.qar);

  // ---- METALS history ----
  updateHistory(history, 'gold24k', metals.gold24k);
  updateHistory(history, 'gold22k', metals.gold22k);
  updateHistory(history, 'goldGram', metals.goldGram);
  updateHistory(history, 'silverTola', metals.silverTola);
  updateHistory(history, 'platinum', metals.platinum);

  // ---- FUEL history ----
  updateHistory(history, 'petrol', fuel.petrol);
  updateHistory(history, 'diesel', fuel.diesel);
  updateHistory(history, 'kerosene', fuel.kerosene);
  updateHistory(history, 'lightDiesel', fuel.lightDiesel);

  // ---- CRYPTO history ----
  updateHistory(history, 'bitcoin', crypto.bitcoin);
  updateHistory(history, 'ethereum', crypto.ethereum);
  updateHistory(history, 'bnb', crypto.bnb);
  updateHistory(history, 'solana', crypto.solana);
  updateHistory(history, 'xrp', crypto.xrp);
  updateHistory(history, 'cardano', crypto.cardano);
  updateHistory(history, 'dogecoin', crypto.dogecoin);
  updateHistory(history, 'tron', crypto.tron);

  // ---- STOCKS history ----
  updateHistory(history, 'kse100', stocks.kse100);
  updateHistory(history, 'kse30', stocks.kse30);
  updateHistory(history, 'kmi30', stocks.kmi30);

  // ---- AGRICULTURE history ----
  updateHistory(history, 'wheat', agriculture.wheat);
  updateHistory(history, 'rice', agriculture.rice);
  updateHistory(history, 'sugar', agriculture.sugar);
  updateHistory(history, 'cotton', agriculture.cotton);

  // ---- ELECTRICITY history ----
  updateHistory(history, 'elec_normal', electricity.normal);
  updateHistory(history, 'elec_peak', electricity.peak);
  updateHistory(history, 'elec_offpeak', electricity.offpeak);

  // ---- PROPERTY history ----
  updateHistory(history, 'prop_lahore', property.lahore);
  updateHistory(history, 'prop_karachi', property.karachi);
  updateHistory(history, 'prop_islamabad', property.islamabad);

  // Final data object
  const data = {
    currencies,
    metals,
    fuel,
    crypto,
    stocks,
    electricity,
    agriculture,
    property,
    updated: new Date().toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  };

  // Save to Cloudflare KV
  await kvSet('rates', data);
  await kvSet('history', history);

  console.log('\n========================================');
  console.log('Data saved! Summary:');
  console.log(`  Currencies : ${Object.keys(currencies).length} rates`);
  console.log(`  Metals     : ${Object.keys(metals).length} rates`);
  console.log(`  Fuel       : ${Object.keys(fuel).length} rates`);
  console.log(`  Crypto     : ${Object.keys(crypto).length} rates`);
  console.log(`  Stocks     : ${Object.keys(stocks).length} rates`);
  console.log(`  Electricity: ${Object.keys(electricity).length} rates`);
  console.log(`  Agriculture: ${Object.keys(agriculture).length} rates`);
  console.log(`  Property   : ${Object.keys(property).length} rates`);
  console.log(`  TOTAL      : 40 rates`);
  console.log(`  History    : 30 din ka data save`);
  console.log('========================================\n');
}

scrapeAll();