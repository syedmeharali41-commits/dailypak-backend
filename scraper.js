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
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache'
};

function bestRate(values, strategy = 'median', label = '') {
  const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  if (strategy === 'first') return valid[0];

  if (strategy === 'avg') {
    return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
  }

  // median
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  console.log(`  [${label}] Sources: [${valid.join(', ')}] → Best: ${result}`);
  return result;
}

async function fetchSafe(url, options = {}) {
  try {
    const res = await axios.get(url, { timeout: 15000, headers: BROWSER_HEADERS, ...options });
    return res.data;
  } catch (e) {
    console.log(`  ⚠ Fetch fail: ${url} — ${e.message}`);
    return null;
  }
}

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
  if (!newRate || newRate <= 0) return history;
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
// CATEGORY 1: CURRENCIES
// Strategy: median
// ============================================================
async function scrapeCurrencies() {
  console.log('\n[CURRENCIES] Scraping 3 sources...');

  const FALLBACK = { usd: 278.5, aed: 75.8, sar: 74.2, eur: 305.0, gbp: 352.0, cny: 38.5, try: 8.1, cad: 204.0, aud: 181.0, qar: 76.5 };
  const buckets = {};
  Object.keys(FALLBACK).forEach(k => buckets[k] = []);

  function parseRow($, row) {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const name = $(cells[0]).text().toLowerCase().trim();
    const sell = parseFloat($(cells[2]).text().replace(/,/g, '').trim());
    if (!sell || sell <= 0) return;
    if (name.includes('us dollar') || name.includes('usd'))         buckets.usd.push(sell);
    if (name.includes('uae') || name.includes('dirham'))            buckets.aed.push(sell);
    if (name.includes('saudi') || name.includes('riyal') || name.includes('sar')) buckets.sar.push(sell);
    if (name.includes('euro'))                                       buckets.eur.push(sell);
    if (name.includes('pound') || name.includes('gbp'))             buckets.gbp.push(sell);
    if (name.includes('yuan') || name.includes('chinese') || name.includes('cny')) buckets.cny.push(sell);
    if (name.includes('turkish') || name.includes('lira'))          buckets.try.push(sell);
    if (name.includes('canadian') || name.includes('cad'))          buckets.cad.push(sell);
    if (name.includes('australian') || name.includes('aud'))        buckets.aud.push(sell);
    if (name.includes('qatari') || name.includes('qar'))            buckets.qar.push(sell);
  }

  const html1 = await fetchSafe('https://www.hamariweb.com/finance/forex/open_market_rates.aspx');
  if (html1) { const $ = cheerio.load(html1); $('table tr').each((i, row) => parseRow($, row)); console.log('  Source 1 (hamariweb) done'); }

  const html2 = await fetchSafe('https://www.pkr.com.pk/open-market/');
  if (html2) {
    const $ = cheerio.load(html2);
    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const name = $(cells[0]).text().toLowerCase().trim();
      const sell = parseFloat($(cells[cells.length - 1]).text().replace(/,/g, '').trim());
      if (!sell || sell <= 0) return;
      if (name.includes('us dollar') || name.includes('usd'))         buckets.usd.push(sell);
      if (name.includes('uae') || name.includes('dirham'))            buckets.aed.push(sell);
      if (name.includes('saudi') || name.includes('riyal'))           buckets.sar.push(sell);
      if (name.includes('euro'))                                       buckets.eur.push(sell);
      if (name.includes('pound') || name.includes('gbp'))             buckets.gbp.push(sell);
      if (name.includes('yuan') || name.includes('chinese'))          buckets.cny.push(sell);
      if (name.includes('turkish') || name.includes('lira'))          buckets.try.push(sell);
      if (name.includes('canadian') || name.includes('cad'))          buckets.cad.push(sell);
      if (name.includes('australian') || name.includes('aud'))        buckets.aud.push(sell);
      if (name.includes('qatari') || name.includes('qar'))            buckets.qar.push(sell);
    });
    console.log('  Source 2 (pkr.com.pk) done');
  }

  const html3 = await fetchSafe('https://forex.pk/open-market-rates/');
  if (html3) { const $ = cheerio.load(html3); $('table tr, .rate-row').each((i, row) => parseRow($, row)); console.log('  Source 3 (forex.pk) done'); }

  const result = {};
  Object.keys(FALLBACK).forEach(k => {
    result[k] = bestRate(buckets[k], 'median', k) || FALLBACK[k];
  });
  console.log('  Final currencies:', result);
  return result;
}

// ============================================================
// CATEGORY 2: GOLD & METALS
// Strategy: median
// ============================================================
async function scrapeMetals() {
  console.log('\n[METALS] Scraping 3 sources...');

  const FALLBACK = { gold24k: 245000, gold22k: 224600, goldGram: 21000, silverTola: 2800, platinum: 15925 };
  const b = { gold24k: [], gold22k: [], goldGram: [], silverTola: [] };

  const html1 = await fetchSafe('https://www.bullion.pk/');
  if (html1) {
    const $ = cheerio.load(html1);
    $('table tr, .price-row, .rate-item').each((i, row) => {
      const text = $(row).text().toLowerCase();
      const cells = $(row).find('td');
      const val = parseFloat((cells.length > 1 ? $(cells[1]).text() : $(row).text()).replace(/,/g, '').replace(/rs\.?/gi, '').trim());
      if (!val || val <= 0) return;
      if (text.includes('24') && (text.includes('tola') || text.includes('karat'))) b.gold24k.push(val);
      if (text.includes('22') && (text.includes('tola') || text.includes('karat'))) b.gold22k.push(val);
      if (text.includes('gram') && text.includes('24'))  b.goldGram.push(val);
      if (text.includes('silver') && text.includes('tola')) b.silverTola.push(val);
    });
    console.log('  Source 1 (bullion.pk) done');
  }

  const html2 = await fetchSafe('https://www.goldratepk.com/');
  if (html2) {
    const $ = cheerio.load(html2);
    $('table tr, .gold-rate-box, .rate-box').each((i, row) => {
      const text = $(row).text().toLowerCase();
      const numStr = $(row).text().replace(/[^0-9,.]/g, '').replace(/,/g, '').trim();
      const val = parseFloat(numStr);
      if (!val || val <= 0) return;
      if (text.includes('24') && text.includes('tola'))  b.gold24k.push(val);
      if (text.includes('22') && text.includes('tola'))  b.gold22k.push(val);
      if (text.includes('gram'))                          b.goldGram.push(val);
      if (text.includes('silver'))                        b.silverTola.push(val);
    });
    console.log('  Source 2 (goldratepk.com) done');
  }

  const html3 = await fetchSafe('https://gold.com.pk/');
  if (html3) {
    const $ = cheerio.load(html3);
    $('table tr, .rate, [class*="gold"]').each((i, row) => {
      const text = $(row).text().toLowerCase();
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const val = parseFloat($(cells[1]).text().replace(/,/g, '').replace(/rs\.?/gi, '').trim());
      if (!val || val <= 0) return;
      if (text.includes('24') && text.includes('tola'))  b.gold24k.push(val);
      if (text.includes('22') && text.includes('tola'))  b.gold22k.push(val);
      if (text.includes('gram') && text.includes('24'))  b.goldGram.push(val);
      if (text.includes('silver'))                        b.silverTola.push(val);
    });
    console.log('  Source 3 (gold.com.pk) done');
  }

  const gold24k    = bestRate(b.gold24k,    'median', 'gold24k')    || FALLBACK.gold24k;
  const gold22k    = bestRate(b.gold22k,    'median', 'gold22k')    || FALLBACK.gold22k;
  const goldGram   = bestRate(b.goldGram,   'median', 'goldGram')   || FALLBACK.goldGram;
  const silverTola = bestRate(b.silverTola, 'median', 'silverTola') || FALLBACK.silverTola;
  const platinum   = Math.round(gold24k * 0.065);

  const result = { gold24k, gold22k, goldGram, silverTola, platinum };
  console.log('  Final metals:', result);
  return result;
}

// ============================================================
// CATEGORY 3: FUEL
// FIX: Strategy changed to 'first' — PSO official sabse reliable
// FIX: Source order changed — PSO pehle, pakwheels aakhir mein
// ============================================================
async function scrapeFuel() {
  console.log('\n[FUEL] Scraping 3 sources...');

  const FALLBACK = { petrol: 255, diesel: 268, kerosene: 186, lightDiesel: 178 };
  const b = { petrol: [], diesel: [], kerosene: [], lightDiesel: [] };

  function parseFuelRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    const val = parseFloat(
      $(cells.length > 0 ? cells[cells.length - 1] : row)
        .text().replace(/,/g, '').replace(/rs\.?/gi, '').trim()
    );
    if (!val || val <= 0 || val > 500) return;
    if (text.includes('petrol') || text.includes('motor spirit') || text.includes(' ms ')) b.petrol.push(val);
    if (text.includes('high speed diesel') || text.includes(' hsd ') || text.includes('diesel')) b.diesel.push(val);
    if (text.includes('kerosene')) b.kerosene.push(val);
    if (text.includes('light diesel') || text.includes(' ldo ')) b.lightDiesel.push(val);
  }

  // SOURCE 1: PSO (Pakistan State Oil) — official govt source (FIRST priority)
  const html1 = await fetchSafe('https://www.psopk.com/retail-fuels/fuel-prices');
  if (html1) {
    const $ = cheerio.load(html1);
    $('table tr, .price-row').each((i, row) => parseFuelRow($, row));
    console.log('  Source 1 (PSO) done');
  }

  // SOURCE 2: hamariweb fuel
  const html2 = await fetchSafe('https://www.hamariweb.com/finance/petrol-prices-in-pakistan/');
  if (html2) {
    const $ = cheerio.load(html2);
    $('table tr').each((i, row) => parseFuelRow($, row));
    console.log('  Source 2 (hamariweb fuel) done');
  }

  // SOURCE 3: PakWheels — fallback
  const html3 = await fetchSafe('https://www.pakwheels.com/fuel-prices/');
  if (html3) {
    const $ = cheerio.load(html3);
    $('table tr, .fuel-price-row, [class*="fuel"]').each((i, row) => parseFuelRow($, row));
    $('[class*="price"], [class*="rate"]').each((i, el) => {
      const val = parseFloat($(el).text().replace(/,/g, '').replace(/rs\.?/gi, '').trim());
      const parentText = $(el).parent().text().toLowerCase();
      if (!val || val <= 0 || val > 500) return;
      if (parentText.includes('petrol'))  b.petrol.push(val);
      if (parentText.includes('diesel'))  b.diesel.push(val);
    });
    console.log('  Source 3 (pakwheels) done');
  }

  const result = {
    petrol:      bestRate(b.petrol,      'first', 'petrol')      || FALLBACK.petrol,
    diesel:      bestRate(b.diesel,      'first', 'diesel')      || FALLBACK.diesel,
    kerosene:    bestRate(b.kerosene,    'first', 'kerosene')    || FALLBACK.kerosene,
    lightDiesel: bestRate(b.lightDiesel, 'first', 'lightDiesel') || FALLBACK.lightDiesel
  };
  console.log('  Final fuel:', result);
  return result;
}

// ============================================================
// CATEGORY 4: CRYPTO
// Strategy: median
// ============================================================
async function scrapeCrypto() {
  console.log('\n[CRYPTO] Scraping 3 sources...');

  const FALLBACK = { bitcoin: 67000, ethereum: 2050, bnb: 580, solana: 130, xrp: 2.1, cardano: 0.65, dogecoin: 0.17, tron: 0.23 };
  const b = { bitcoin: [], ethereum: [], bnb: [], solana: [], xrp: [], cardano: [], dogecoin: [], tron: [] };

  const cg = await fetchSafe(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,cardano,dogecoin,tron&vs_currencies=usd',
    { headers: {} }
  );
  if (cg && typeof cg === 'object') {
    if (cg.bitcoin?.usd)     b.bitcoin.push(cg.bitcoin.usd);
    if (cg.ethereum?.usd)    b.ethereum.push(cg.ethereum.usd);
    if (cg.binancecoin?.usd) b.bnb.push(cg.binancecoin.usd);
    if (cg.solana?.usd)      b.solana.push(cg.solana.usd);
    if (cg.ripple?.usd)      b.xrp.push(cg.ripple.usd);
    if (cg.cardano?.usd)     b.cardano.push(cg.cardano.usd);
    if (cg.dogecoin?.usd)    b.dogecoin.push(cg.dogecoin.usd);
    if (cg.tron?.usd)        b.tron.push(cg.tron.usd);
    console.log('  Source 1 (CoinGecko) done');
  }

  const cc = await fetchSafe(
    'https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,binance-coin,solana,xrp,cardano,dogecoin,tron&limit=10',
    { headers: {} }
  );
  if (cc?.data && Array.isArray(cc.data)) {
    cc.data.forEach(coin => {
      const p = parseFloat(coin.priceUsd);
      if (!p) return;
      if (coin.id === 'bitcoin')      b.bitcoin.push(p);
      if (coin.id === 'ethereum')     b.ethereum.push(p);
      if (coin.id === 'binance-coin') b.bnb.push(p);
      if (coin.id === 'solana')       b.solana.push(p);
      if (coin.id === 'xrp')         b.xrp.push(p);
      if (coin.id === 'cardano')      b.cardano.push(p);
      if (coin.id === 'dogecoin')     b.dogecoin.push(p);
      if (coin.id === 'tron')         b.tron.push(p);
    });
    console.log('  Source 2 (CoinCap) done');
  }

  const symbols = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','TRXUSDT'];
  const binance = await fetchSafe(
    `https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`,
    { headers: {} }
  );
  if (binance && Array.isArray(binance)) {
    binance.forEach(t => {
      const p = parseFloat(t.price);
      if (!p) return;
      if (t.symbol === 'BTCUSDT')  b.bitcoin.push(p);
      if (t.symbol === 'ETHUSDT')  b.ethereum.push(p);
      if (t.symbol === 'BNBUSDT')  b.bnb.push(p);
      if (t.symbol === 'SOLUSDT')  b.solana.push(p);
      if (t.symbol === 'XRPUSDT')  b.xrp.push(p);
      if (t.symbol === 'ADAUSDT')  b.cardano.push(p);
      if (t.symbol === 'DOGEUSDT') b.dogecoin.push(p);
      if (t.symbol === 'TRXUSDT')  b.tron.push(p);
    });
    console.log('  Source 3 (Binance) done');
  }

  const result = {};
  Object.keys(FALLBACK).forEach(k => {
    result[k] = bestRate(b[k], 'median', k) || FALLBACK[k];
  });
  console.log('  Final crypto:', result);
  return result;
}

// ============================================================
// CATEGORY 5: PSX STOCKS
// Strategy: median
// ============================================================
async function scrapeStocks() {
  console.log('\n[STOCKS] Scraping 3 sources...');

  const FALLBACK = { kse100: 115000, kse30: 35000, kmi30: 52000 };
  const b = { kse100: [], kse30: [], kmi30: [] };

  function parseStockRow($, row) {
    const text = $(row).text();
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const val = parseFloat($(cells[1]).text().replace(/,/g, '').trim());
    if (!val || val <= 0) return;
    if (/KSE.?100/i.test(text)) b.kse100.push(val);
    if (/KSE.?30/i.test(text))  b.kse30.push(val);
    if (/KMI.?30/i.test(text))  b.kmi30.push(val);
  }

  const html1 = await fetchSafe('https://dps.psx.com.pk/indices');
  if (html1) { const $ = cheerio.load(html1); $('table tr').each((i, row) => parseStockRow($, row)); console.log('  Source 1 (dps.psx.com.pk) done'); }

  const html2 = await fetchSafe('https://www.psx.com.pk/');
  if (html2) {
    const $ = cheerio.load(html2);
    $('table tr, [class*="index"], [class*="Index"]').each((i, row) => {
      const text = $(row).text();
      const numMatch = text.replace(/,/g, '').match(/\d{5,7}(\.\d+)?/);
      if (!numMatch) return;
      const val = parseFloat(numMatch[0]);
      if (!val || val <= 0) return;
      if (/KSE.?100/i.test(text)) b.kse100.push(val);
      if (/KSE.?30/i.test(text))  b.kse30.push(val);
      if (/KMI.?30/i.test(text))  b.kmi30.push(val);
    });
    console.log('  Source 2 (psx.com.pk) done');
  }

  const html3 = await fetchSafe('https://www.hamariweb.com/finance/pakistan-stock-exchange/');
  if (html3) { const $ = cheerio.load(html3); $('table tr, [class*="index"]').each((i, row) => parseStockRow($, row)); console.log('  Source 3 (hamariweb stocks) done'); }

  const result = {
    kse100: bestRate(b.kse100, 'median', 'kse100') || FALLBACK.kse100,
    kse30:  bestRate(b.kse30,  'median', 'kse30')  || FALLBACK.kse30,
    kmi30:  bestRate(b.kmi30,  'median', 'kmi30')  || FALLBACK.kmi30
  };
  console.log('  Final stocks:', result);
  return result;
}

// ============================================================
// CATEGORY 6: ELECTRICITY
// Strategy: median
// ============================================================
async function scrapeElectricity() {
  console.log('\n[ELECTRICITY] Scraping 3 sources...');

  const FALLBACK = { normal: 47, peak: 58, offpeak: 36 };
  const b = { normal: [], peak: [], offpeak: [] };

  function parseElecRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const val = parseFloat($(cells[cells.length - 1]).text().replace(/,/g, '').trim());
    if (!val || val <= 0 || val > 200) return;
    if (text.includes('peak') && !text.includes('off')) b.peak.push(val);
    else if (text.includes('off') && text.includes('peak'))  b.offpeak.push(val);
    else if (text.includes('normal') || text.includes('unit') || text.includes('per kwh')) b.normal.push(val);
  }

  const html1 = await fetchSafe('https://www.nepra.org.pk/tariff/index.php');
  if (html1) { const $ = cheerio.load(html1); $('table tr').each((i, row) => parseElecRow($, row)); console.log('  Source 1 (NEPRA) done'); }

  const html2 = await fetchSafe('https://lesco.com.pk/tariff/');
  if (html2) { const $ = cheerio.load(html2); $('table tr').each((i, row) => parseElecRow($, row)); console.log('  Source 2 (LESCO) done'); }

  const html3 = await fetchSafe('https://www.hamariweb.com/finance/electricity-rates-in-pakistan/');
  if (html3) { const $ = cheerio.load(html3); $('table tr').each((i, row) => parseElecRow($, row)); console.log('  Source 3 (hamariweb electricity) done'); }

  const result = {
    normal:  bestRate(b.normal,  'median', 'elec_normal')  || FALLBACK.normal,
    peak:    bestRate(b.peak,    'median', 'elec_peak')    || FALLBACK.peak,
    offpeak: bestRate(b.offpeak, 'median', 'elec_offpeak') || FALLBACK.offpeak
  };
  console.log('  Final electricity:', result);
  return result;
}

// ============================================================
// CATEGORY 7: AGRICULTURE
// FIX: Strategy changed to 'avg' — local price variation handle karne ke liye
// ============================================================
async function scrapeAgriculture() {
  console.log('\n[AGRICULTURE] Scraping 3 sources...');

  const FALLBACK = { wheat: 65, rice: 175, sugar: 155, cotton: 8500 };
  const b = { wheat: [], rice: [], sugar: [], cotton: [] };

  function parseAgriRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    const rawVal = cells.length > 1 ? $(cells[cells.length - 1]).text() : $(row).text();
    const val = parseFloat(rawVal.replace(/,/g, '').replace(/rs\.?/gi, '').trim());
    if (!val || val <= 0) return;

    if (text.includes('wheat') || text.includes('gandum')) {
      if (val > 500 && val < 5000)    b.wheat.push(Math.round(val / 40));
      else if (val > 30 && val < 500) b.wheat.push(val);
    }
    if ((text.includes('rice') || text.includes('chawal')) && val > 50 && val < 1000) b.rice.push(val);
    if ((text.includes('sugar') || text.includes('cheeni')) && val > 50 && val < 500) b.sugar.push(val);
    if (text.includes('cotton') || text.includes('kapas')) {
      if (val > 1000) b.cotton.push(val);
    }
  }

  const html1 = await fetchSafe('https://priceit.pk/commodity-prices/');
  if (html1) { const $ = cheerio.load(html1); $('table tr').each((i, row) => parseAgriRow($, row)); console.log('  Source 1 (priceit.pk) done'); }

  const html2 = await fetchSafe('https://www.hamariweb.com/finance/commodity-prices-in-pakistan/');
  if (html2) { const $ = cheerio.load(html2); $('table tr').each((i, row) => parseAgriRow($, row)); console.log('  Source 2 (hamariweb agri) done'); }

  const html3 = await fetchSafe('https://www.kissanpakistan.com/commodity-prices/');
  if (html3) { const $ = cheerio.load(html3); $('table tr, .price-item').each((i, row) => parseAgriRow($, row)); console.log('  Source 3 (kissanpakistan) done'); }

  const result = {
    wheat:  bestRate(b.wheat,  'avg', 'wheat')  || FALLBACK.wheat,
    rice:   bestRate(b.rice,   'avg', 'rice')   || FALLBACK.rice,
    sugar:  bestRate(b.sugar,  'avg', 'sugar')  || FALLBACK.sugar,
    cotton: bestRate(b.cotton, 'avg', 'cotton') || FALLBACK.cotton
  };
  console.log('  Final agriculture:', result);
  return result;
}

// ============================================================
// CATEGORY 8: PROPERTY
// Strategy: median
// ============================================================
async function scrapeProperty() {
  console.log('\n[PROPERTY] Scraping 3 sources...');

  const FALLBACK = { lahore: 1250000, karachi: 1500000, islamabad: 2000000 };
  const b = { lahore: [], karachi: [], islamabad: [] };

  function extractCityRates($) {
    const text = $.text ? $.text() : '';
    const lines = text.split('\n').filter(l => l.trim().length > 3);
    lines.forEach(line => {
      const lower = line.toLowerCase();
      const numMatch = line.replace(/,/g, '').match(/(\d{6,9})/);
      if (!numMatch) return;
      const val = parseInt(numMatch[1]);
      if (val < 100000 || val > 50000000) return;
      if (lower.includes('lahore'))    b.lahore.push(val);
      if (lower.includes('karachi'))   b.karachi.push(val);
      if (lower.includes('islamabad')) b.islamabad.push(val);
    });
  }

  const html1 = await fetchSafe('https://www.zameen.com/property-index/');
  if (html1) {
    const $ = cheerio.load(html1);
    extractCityRates($);
    $('[class*="city"], [class*="price"], table tr').each((i, el) => {
      const text = $(el).text().toLowerCase();
      const numMatch = $(el).text().replace(/,/g, '').match(/(\d{6,9})/);
      if (!numMatch) return;
      const val = parseInt(numMatch[1]);
      if (val < 100000 || val > 50000000) return;
      if (text.includes('lahore'))    b.lahore.push(val);
      if (text.includes('karachi'))   b.karachi.push(val);
      if (text.includes('islamabad')) b.islamabad.push(val);
    });
    console.log('  Source 1 (zameen.com) done');
  }

  const html2 = await fetchSafe('https://www.graana.com/property-insights/');
  if (html2) { const $ = cheerio.load(html2); extractCityRates($); console.log('  Source 2 (graana.com) done'); }

  const html3 = await fetchSafe('https://www.hamariweb.com/real-estate/property-prices-in-pakistan/');
  if (html3) {
    const $ = cheerio.load(html3);
    $('table tr').each((i, row) => {
      const text = $(row).text().toLowerCase();
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const val = parseInt($(cells[1]).text().replace(/,/g, '').trim());
      if (!val || val < 100000) return;
      if (text.includes('lahore'))    b.lahore.push(val);
      if (text.includes('karachi'))   b.karachi.push(val);
      if (text.includes('islamabad')) b.islamabad.push(val);
    });
    console.log('  Source 3 (hamariweb property) done');
  }

  const result = {
    lahore:    bestRate(b.lahore,    'median', 'lahore')    || FALLBACK.lahore,
    karachi:   bestRate(b.karachi,   'median', 'karachi')   || FALLBACK.karachi,
    islamabad: bestRate(b.islamabad, 'median', 'islamabad') || FALLBACK.islamabad
  };
  console.log('  Final property:', result);
  return result;
}

// ============================================================
// MAIN FUNCTION
// ============================================================
async function scrapeAll() {
  console.log('\n========================================');
  console.log('DailyPak Multi-Source Scraper — 40 Rates');
  console.log('========================================\n');

  const [currencies, metals, fuel, crypto, stocks, electricity, agriculture, property] = await Promise.allSettled([
    scrapeCurrencies(),
    scrapeMetals(),
    scrapeFuel(),
    scrapeCrypto(),
    scrapeStocks(),
    scrapeElectricity(),
    scrapeAgriculture(),
    scrapeProperty()
  ]).then(results => results.map((r, i) => {
    if (r.status === 'rejected') {
      console.log(`  ❌ Category ${i} failed:`, r.reason?.message);
      return null;
    }
    return r.value;
  }));

  let history = await kvGet('history');
  if (!history || typeof history !== 'object') history = {};

  const allRates = [
    ['usd', currencies?.usd], ['aed', currencies?.aed], ['sar', currencies?.sar],
    ['eur', currencies?.eur], ['gbp', currencies?.gbp], ['cny', currencies?.cny],
    ['try', currencies?.try], ['cad', currencies?.cad], ['aud', currencies?.aud],
    ['qar', currencies?.qar],
    ['gold24k', metals?.gold24k], ['gold22k', metals?.gold22k],
    ['goldGram', metals?.goldGram], ['silverTola', metals?.silverTola],
    ['platinum', metals?.platinum],
    ['petrol', fuel?.petrol], ['diesel', fuel?.diesel],
    ['kerosene', fuel?.kerosene], ['lightDiesel', fuel?.lightDiesel],
    ['bitcoin', crypto?.bitcoin], ['ethereum', crypto?.ethereum],
    ['bnb', crypto?.bnb], ['solana', crypto?.solana], ['xrp', crypto?.xrp],
    ['cardano', crypto?.cardano], ['dogecoin', crypto?.dogecoin], ['tron', crypto?.tron],
    ['kse100', stocks?.kse100], ['kse30', stocks?.kse30], ['kmi30', stocks?.kmi30],
    ['elec_normal', electricity?.normal], ['elec_peak', electricity?.peak],
    ['elec_offpeak', electricity?.offpeak],
    ['wheat', agriculture?.wheat], ['rice', agriculture?.rice],
    ['sugar', agriculture?.sugar], ['cotton', agriculture?.cotton],
    ['prop_lahore', property?.lahore], ['prop_karachi', property?.karachi],
    ['prop_islamabad', property?.islamabad]
  ];

  allRates.forEach(([key, val]) => { if (val) updateHistory(history, key, val); });

  const data = {
    currencies:   currencies   || {},
    metals:       metals       || {},
    fuel:         fuel         || {},
    crypto:       crypto       || {},
    stocks:       stocks       || {},
    electricity:  electricity  || {},
    agriculture:  agriculture  || {},
    property:     property     || {},
    updated: new Date().toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  };

  await kvSet('rates', data);
  await kvSet('history', history);

  console.log('\n========================================');
  console.log('✅ All done! Sources used per category:');
  console.log('  Currencies  : hamariweb | pkr.com.pk | forex.pk        → median');
  console.log('  Metals      : bullion.pk | goldratepk.com | gold.com.pk → median');
  console.log('  Fuel        : PSO (official) | hamariweb | pakwheels    → first ✓');
  console.log('  Crypto      : CoinGecko | CoinCap | Binance             → median');
  console.log('  Stocks      : dps.psx.com.pk | psx.com.pk | hamariweb  → median');
  console.log('  Electricity : NEPRA | LESCO | hamariweb                 → median');
  console.log('  Agriculture : priceit.pk | hamariweb | kissanpakistan   → avg ✓');
  console.log('  Property    : zameen.com | graana.com | hamariweb       → median');
  console.log('  Total Rates : 40');
  console.log('  History     : 30 din ka data');
  console.log('========================================\n');
}

scrapeAll();
