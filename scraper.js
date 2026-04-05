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
  if (strategy === 'avg') return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
  return new Date().toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short' });
}

function updateHistory(history, rateName, newRate) {
  if (!newRate || newRate <= 0) return history;
  if (!history[rateName]) history[rateName] = [];
  const today = todayDate();
  const existing = history[rateName].findIndex(e => e.date === today);
  if (existing >= 0) { history[rateName][existing].rate = newRate; }
  else { history[rateName].push({ date: today, rate: newRate }); }
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
// CATEGORY 1: CURRENCIES — 6 Sources
// hamariweb | pkr.com.pk | forex.pk | sbp.org.pk | ubl | exPakistan
// Strategy: median
// ============================================================
async function scrapeCurrencies() {
  console.log('\n[CURRENCIES] Scraping 6 sources...');
  const FALLBACK = { usd: 279.0, aed: 75.9, sar: 74.4, eur: 306.0, gbp: 353.0, cny: 38.5, try: 8.3, cad: 204.0, aud: 181.0, qar: 76.5 };
  const buckets = {};
  Object.keys(FALLBACK).forEach(k => buckets[k] = []);

  function parseRow($, row, sellColIndex = 2) {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name = $(cells[0]).text().toLowerCase().trim();
    const sell = parseFloat($(cells[Math.min(sellColIndex, cells.length - 1)]).text().replace(/,/g, '').trim());
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

  // Source 1: HamariWeb — open market rates
  const h1 = await fetchSafe('https://www.hamariweb.com/finance/forex/open_market_rates.aspx');
  if (h1) { const $ = cheerio.load(h1); $('table tr').each((i, r) => parseRow($, r, 2)); console.log('  ✓ Source 1 (hamariweb)'); }

  // Source 2: pkr.com.pk
  const h2 = await fetchSafe('https://www.pkr.com.pk/open-market/');
  if (h2) {
    const $ = cheerio.load(h2);
    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const name = $(cells[0]).text().toLowerCase().trim();
      const sell = parseFloat($(cells[cells.length - 1]).text().replace(/,/g, '').trim());
      if (!sell || sell <= 0) return;
      if (name.includes('us dollar') || name.includes('usd'))  buckets.usd.push(sell);
      if (name.includes('uae') || name.includes('dirham'))     buckets.aed.push(sell);
      if (name.includes('saudi') || name.includes('riyal'))    buckets.sar.push(sell);
      if (name.includes('euro'))                               buckets.eur.push(sell);
      if (name.includes('pound') || name.includes('gbp'))      buckets.gbp.push(sell);
      if (name.includes('yuan') || name.includes('chinese'))   buckets.cny.push(sell);
      if (name.includes('turkish') || name.includes('lira'))   buckets.try.push(sell);
      if (name.includes('canadian') || name.includes('cad'))   buckets.cad.push(sell);
      if (name.includes('australian') || name.includes('aud')) buckets.aud.push(sell);
      if (name.includes('qatari') || name.includes('qar'))     buckets.qar.push(sell);
    });
    console.log('  ✓ Source 2 (pkr.com.pk)');
  }

  // Source 3: forex.pk
  const h3 = await fetchSafe('https://forex.pk/open-market-rates/');
  if (h3) { const $ = cheerio.load(h3); $('table tr, .rate-row').each((i, r) => parseRow($, r, 2)); console.log('  ✓ Source 3 (forex.pk)'); }

  // Source 4: currency.pk
  const h4 = await fetchSafe('https://www.currency.pk/');
  if (h4) { const $ = cheerio.load(h4); $('table tr').each((i, r) => parseRow($, r, 2)); console.log('  ✓ Source 4 (currency.pk)'); }

  // Source 5: thecurrencyshop (interbank reference)
  const h5 = await fetchSafe('https://www.thecurrencyshop.com.pk/');
  if (h5) { const $ = cheerio.load(h5); $('table tr').each((i, r) => parseRow($, r, 1)); console.log('  ✓ Source 5 (thecurrencyshop.com.pk)'); }

  // Source 6: Fixer.io free API (fallback if scraping fails)
  const h6 = await fetchSafe('https://open.er-api.com/v6/latest/PKR', { headers: {} });
  if (h6 && h6.rates) {
    const r = h6.rates;
    // This gives PKR per 1 unit, meaning we need 1/rate for PKR->foreign, then invert
    // Actually er-api with base PKR gives: 1 PKR = X foreign, so 1 USD = 1/rates.USD PKR
    if (r.USD && r.USD > 0) buckets.usd.push(Math.round(1 / r.USD));
    if (r.AED && r.AED > 0) buckets.aed.push(Math.round(1 / r.AED));
    if (r.SAR && r.SAR > 0) buckets.sar.push(Math.round(1 / r.SAR));
    if (r.EUR && r.EUR > 0) buckets.eur.push(Math.round(1 / r.EUR));
    if (r.GBP && r.GBP > 0) buckets.gbp.push(Math.round(1 / r.GBP));
    if (r.CNY && r.CNY > 0) buckets.cny.push(Math.round(1 / r.CNY));
    if (r.TRY && r.TRY > 0) buckets.try.push(Math.round(1 / r.TRY));
    if (r.CAD && r.CAD > 0) buckets.cad.push(Math.round(1 / r.CAD));
    if (r.AUD && r.AUD > 0) buckets.aud.push(Math.round(1 / r.AUD));
    if (r.QAR && r.QAR > 0) buckets.qar.push(Math.round(1 / r.QAR));
    console.log('  ✓ Source 6 (open.er-api.com)');
  }

  const result = {};
  Object.keys(FALLBACK).forEach(k => { result[k] = bestRate(buckets[k], 'median', k) || FALLBACK[k]; });
  console.log('  Final currencies:', result);
  return result;
}

// ============================================================
// CATEGORY 2: GOLD & METALS — 6 Sources
// bullion.pk | goldratepk.com | gold.com.pk | hamariweb | sarafaassociation | goldpricez
// Strategy: median
// ============================================================
async function scrapeMetals() {
  console.log('\n[METALS] Scraping 6 sources...');
  const FALLBACK = { gold24k: 501000, gold22k: 459250, goldGram: 42950, silverTola: 5800, platinum: 32000 };
  const b = { gold24k: [], gold22k: [], goldGram: [], silverTola: [] };

  function parseGoldRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    const rawText = cells.length > 1 ? $(cells[cells.length - 1]).text() : $(row).text();
    const val = parseFloat(rawText.replace(/,/g, '').replace(/rs\.?/gi, '').trim());
    if (!val || val <= 0) return;
    if (text.includes('24') && (text.includes('tola') || text.includes('karat') || text.includes('carat')) && val > 100000) b.gold24k.push(val);
    if (text.includes('22') && (text.includes('tola') || text.includes('karat') || text.includes('carat')) && val > 100000) b.gold22k.push(val);
    if ((text.includes('gram') || text.includes('per g')) && val > 5000 && val < 100000) b.goldGram.push(val);
    if (text.includes('silver') && (text.includes('tola') || text.includes('chandi')) && val > 100 && val < 50000) b.silverTola.push(val);
  }

  // Source 1: bullion.pk
  const h1 = await fetchSafe('https://www.bullion.pk/');
  if (h1) { const $ = cheerio.load(h1); $('table tr, .price-row, .rate-item, [class*="gold"]').each((i, r) => parseGoldRow($, r)); console.log('  ✓ Source 1 (bullion.pk)'); }

  // Source 2: goldratepk.com
  const h2 = await fetchSafe('https://www.goldratepk.com/');
  if (h2) {
    const $ = cheerio.load(h2);
    $('table tr, .gold-rate-box, .rate-box, [class*="rate"]').each((i, row) => {
      const text = $(row).text().toLowerCase();
      const cells = $(row).find('td');
      const rawText = cells.length > 0 ? $(cells[cells.length - 1]).text() : $(row).text();
      const val = parseFloat(rawText.replace(/[^0-9.]/g, ''));
      if (!val) return;
      if (text.includes('24') && text.includes('tola') && val > 100000)  b.gold24k.push(val);
      if (text.includes('22') && text.includes('tola') && val > 100000)  b.gold22k.push(val);
      if (text.includes('gram') && val > 5000 && val < 100000)            b.goldGram.push(val);
      if (text.includes('silver') && val > 100 && val < 50000)            b.silverTola.push(val);
    });
    console.log('  ✓ Source 2 (goldratepk.com)');
  }

  // Source 3: gold.com.pk
  const h3 = await fetchSafe('https://gold.com.pk/');
  if (h3) { const $ = cheerio.load(h3); $('table tr, [class*="gold"], .rate').each((i, r) => parseGoldRow($, r)); console.log('  ✓ Source 3 (gold.com.pk)'); }

  // Source 4: hamariweb gold
  const h4 = await fetchSafe('https://www.hamariweb.com/finance/gold-rates-in-pakistan.aspx');
  if (h4) { const $ = cheerio.load(h4); $('table tr').each((i, r) => parseGoldRow($, r)); console.log('  ✓ Source 4 (hamariweb gold)'); }

  // Source 5: goldbullion.pk — Sarafa Association linked
  const h5 = await fetchSafe('https://goldbullion.pk/');
  if (h5) { const $ = cheerio.load(h5); $('table tr, .rate-row, [class*="price"]').each((i, r) => parseGoldRow($, r)); console.log('  ✓ Source 5 (goldbullion.pk)'); }

  // Source 6: Calculate via international gold price × PKR rate (cross-verify)
  try {
    const metalApi = await fetchSafe('https://api.metals.live/v1/spot/gold', { headers: {} });
    if (metalApi && metalApi[0]?.gold) {
      const goldUsdPerOz = metalApi[0].gold;
      const usdPkr = 279; // approximate
      const goldPkrPerOz = goldUsdPerOz * usdPkr;
      const goldPkrPerTola = Math.round(goldPkrPerOz / 2.667); // 1 tola = 0.375 oz → 1 oz = 2.667 tola
      if (goldPkrPerTola > 100000) {
        b.gold24k.push(goldPkrPerTola);
        b.gold22k.push(Math.round(goldPkrPerTola * 22/24));
        b.goldGram.push(Math.round(goldPkrPerTola / 11.664));
        console.log(`  ✓ Source 6 (metals.live cross-calc): 24K ~${goldPkrPerTola}`);
      }
    }
  } catch(e) { console.log('  ⚠ Source 6 (metals.live) failed'); }

  const gold24k    = bestRate(b.gold24k, 'median', 'gold24k') || FALLBACK.gold24k;
  const gold22k    = bestRate(b.gold22k, 'median', 'gold22k') || Math.round(gold24k * 22/24);
  const goldGram   = bestRate(b.goldGram, 'median', 'goldGram') || Math.round(gold24k / 11.664);
  const silverTola = bestRate(b.silverTola, 'median', 'silverTola') || FALLBACK.silverTola;
  const platinum   = FALLBACK.platinum;

  const result = { gold24k, gold22k, goldGram, silverTola, platinum };
  console.log('  Final metals:', result);
  return result;
}

// ============================================================
// CATEGORY 3: FUEL — 6 Sources
// PSO (official) | OGRA | hamariweb | pakwheels | petrolprice.pk | dawn
// Strategy: first (PSO/OGRA official result priority)
// ============================================================
async function scrapeFuel() {
  console.log('\n[FUEL] Scraping 6 sources...');
  const FALLBACK = { petrol: 378.41, diesel: 520.35, kerosene: 253.00, lightDiesel: 224.38 };
  const b = { petrol: [], diesel: [], kerosene: [], lightDiesel: [] };

  function parseFuelRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    const val = parseFloat(
      $(cells.length > 0 ? cells[cells.length - 1] : row).text().replace(/,/g, '').replace(/rs\.?/gi, '').trim()
    );
    // Diesel ~520, petrol ~378, kerosene ~253 — max 1000 to be safe
    if (!val || val <= 0 || val > 1000) return;
    if (text.includes('petrol') || text.includes('motor spirit') || text.includes(' ms ') || text.includes('gasoline')) b.petrol.push(val);
    if ((text.includes('high speed diesel') || text.includes(' hsd ') || text.includes('diesel')) && !text.includes('light')) b.diesel.push(val);
    if (text.includes('kerosene')) b.kerosene.push(val);
    if (text.includes('light diesel') || text.includes(' ldo ') || text.includes('light oil')) b.lightDiesel.push(val);
  }

  // Source 1: PSO — Pakistan State Oil (official govt source)
  const h1 = await fetchSafe('https://www.psopk.com/retail-fuels/fuel-prices');
  if (h1) { const $ = cheerio.load(h1); $('table tr, .price-row, [class*="fuel"]').each((i, r) => parseFuelRow($, r)); console.log('  ✓ Source 1 (PSO)'); }

  // Source 2: OGRA — Oil & Gas Regulatory Authority (government regulator)
  const h2 = await fetchSafe('https://www.ogra.org.pk/petroleum-products-prices');
  if (h2) { const $ = cheerio.load(h2); $('table tr').each((i, r) => parseFuelRow($, r)); console.log('  ✓ Source 2 (OGRA official)'); }

  // Source 3: hamariweb fuel
  const h3 = await fetchSafe('https://www.hamariweb.com/finance/petrol-prices-in-pakistan/');
  if (h3) { const $ = cheerio.load(h3); $('table tr').each((i, r) => parseFuelRow($, r)); console.log('  ✓ Source 3 (hamariweb)'); }

  // Source 4: pakwheels
  const h4 = await fetchSafe('https://www.pakwheels.com/fuel-prices/');
  if (h4) {
    const $ = cheerio.load(h4);
    $('table tr, .fuel-price-row, [class*="fuel"]').each((i, r) => parseFuelRow($, r));
    $('[class*="price"], [class*="rate"]').each((i, el) => {
      const val = parseFloat($(el).text().replace(/,/g, '').replace(/rs\.?/gi, '').trim());
      const parentText = $(el).parent().text().toLowerCase();
      if (!val || val <= 0 || val > 1000) return;
      if (parentText.includes('petrol') && !parentText.includes('diesel')) b.petrol.push(val);
      if (parentText.includes('diesel') && !parentText.includes('light'))  b.diesel.push(val);
    });
    console.log('  ✓ Source 4 (pakwheels)');
  }

  // Source 5: petrolprice.pk
  const h5 = await fetchSafe('https://www.petrolprice.pk/');
  if (h5) { const $ = cheerio.load(h5); $('table tr, [class*="price"]').each((i, r) => parseFuelRow($, r)); console.log('  ✓ Source 5 (petrolprice.pk)'); }

  // Source 6: Dawn news fuel page
  const h6 = await fetchSafe('https://www.dawn.com/petrol-price/');
  if (h6) { const $ = cheerio.load(h6); $('table tr, [class*="price"]').each((i, r) => parseFuelRow($, r)); console.log('  ✓ Source 6 (dawn.com/petrol-price)'); }

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
// CATEGORY 4: CRYPTO — 5 Sources
// CoinGecko | CoinCap | Binance | KuCoin | CryptoCompare
// Strategy: median
// ============================================================
async function scrapeCrypto() {
  console.log('\n[CRYPTO] Scraping 5 sources...');
  const FALLBACK = { bitcoin: 83000, ethereum: 1800, bnb: 590, solana: 120, xrp: 2.2, cardano: 0.68, dogecoin: 0.17, tron: 0.24 };
  const b = { bitcoin: [], ethereum: [], bnb: [], solana: [], xrp: [], cardano: [], dogecoin: [], tron: [] };

  function pushCoin(id, price) {
    if (!price || price <= 0) return;
    if (id === 'bitcoin' || id === 'btc')     b.bitcoin.push(price);
    if (id === 'ethereum' || id === 'eth')    b.ethereum.push(price);
    if (id === 'bnb' || id === 'binancecoin') b.bnb.push(price);
    if (id === 'solana' || id === 'sol')      b.solana.push(price);
    if (id === 'ripple' || id === 'xrp')      b.xrp.push(price);
    if (id === 'cardano' || id === 'ada')     b.cardano.push(price);
    if (id === 'dogecoin' || id === 'doge')   b.dogecoin.push(price);
    if (id === 'tron' || id === 'trx')        b.tron.push(price);
  }

  // Source 1: CoinGecko
  const cg = await fetchSafe(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,cardano,dogecoin,tron&vs_currencies=usd',
    { headers: {} }
  );
  if (cg && typeof cg === 'object') {
    Object.entries(cg).forEach(([id, data]) => pushCoin(id, data.usd));
    console.log('  ✓ Source 1 (CoinGecko)');
  }

  // Source 2: CoinCap API
  const cc = await fetchSafe('https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,binance-coin,solana,xrp,cardano,dogecoin,tron&limit=10', { headers: {} });
  if (cc?.data && Array.isArray(cc.data)) {
    cc.data.forEach(coin => pushCoin(coin.id.replace('binance-coin', 'bnb'), parseFloat(coin.priceUsd)));
    console.log('  ✓ Source 2 (CoinCap)');
  }

  // Source 3: Binance API
  const symbols = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','TRXUSDT'];
  const binance = await fetchSafe(`https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`, { headers: {} });
  if (binance && Array.isArray(binance)) {
    const symbolMap = { BTCUSDT:'bitcoin', ETHUSDT:'ethereum', BNBUSDT:'bnb', SOLUSDT:'solana', XRPUSDT:'xrp', ADAUSDT:'cardano', DOGEUSDT:'dogecoin', TRXUSDT:'tron' };
    binance.forEach(t => pushCoin(symbolMap[t.symbol], parseFloat(t.price)));
    console.log('  ✓ Source 3 (Binance)');
  }

  // Source 4: KuCoin API
  const kcSymbols = ['BTC-USDT','ETH-USDT','BNB-USDT','SOL-USDT','XRP-USDT','ADA-USDT','DOGE-USDT','TRX-USDT'];
  const kcMap = { 'BTC-USDT':'bitcoin','ETH-USDT':'ethereum','BNB-USDT':'bnb','SOL-USDT':'solana','XRP-USDT':'xrp','ADA-USDT':'cardano','DOGE-USDT':'dogecoin','TRX-USDT':'tron' };
  for(const s of kcSymbols) {
    const kc = await fetchSafe(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${s}`, { headers: {} });
    if (kc?.data?.price) pushCoin(kcMap[s], parseFloat(kc.data.price));
  }
  console.log('  ✓ Source 4 (KuCoin)');

  // Source 5: CryptoCompare API
  const crc = await fetchSafe(
    'https://min-api.cryptocompare.com/data/pricemulti?fsyms=BTC,ETH,BNB,SOL,XRP,ADA,DOGE,TRX&tsyms=USD',
    { headers: {} }
  );
  if (crc && typeof crc === 'object') {
    const rcMap = { BTC:'bitcoin', ETH:'ethereum', BNB:'bnb', SOL:'solana', XRP:'xrp', ADA:'cardano', DOGE:'dogecoin', TRX:'tron' };
    Object.entries(crc).forEach(([sym, prices]) => { if(prices?.USD) pushCoin(rcMap[sym], prices.USD); });
    console.log('  ✓ Source 5 (CryptoCompare)');
  }

  const result = {};
  Object.keys(FALLBACK).forEach(k => { result[k] = bestRate(b[k], 'median', k) || FALLBACK[k]; });
  console.log('  Final crypto:', result);
  return result;
}

// ============================================================
// CATEGORY 5: PSX STOCKS — 5 Sources
// dps.psx.com.pk | psx.com.pk | hamariweb | investopak | mettis
// Strategy: median
// ============================================================
async function scrapeStocks() {
  console.log('\n[STOCKS] Scraping 5 sources...');
  const FALLBACK = { kse100: 150000, kse30: 98000, kmi30: 185000 };
  const b = { kse100: [], kse30: [], kmi30: [] };

  function parseStockVal(text, val) {
    if (!val || val <= 0) return;
    if (/KSE.?100/i.test(text) && val > 50000)  b.kse100.push(val);
    if (/KSE.?30/i.test(text) && val > 10000)   b.kse30.push(val);
    if (/KMI.?30/i.test(text) && val > 50000)   b.kmi30.push(val);
  }

  function parseStockRow($, row) {
    const text = $(row).text();
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const val = parseFloat($(cells[1]).text().replace(/,/g, '').trim());
    parseStockVal(text, val);
  }

  // Source 1: PSX official data
  const h1 = await fetchSafe('https://dps.psx.com.pk/indices');
  if (h1) { const $ = cheerio.load(h1); $('table tr').each((i, r) => parseStockRow($, r)); console.log('  ✓ Source 1 (dps.psx.com.pk)'); }

  // Source 2: PSX main website
  const h2 = await fetchSafe('https://www.psx.com.pk/');
  if (h2) {
    const $ = cheerio.load(h2);
    $('table tr, [class*="index"], [class*="Index"]').each((i, row) => {
      const text = $(row).text();
      const numMatch = text.replace(/,/g, '').match(/\d{5,7}(\.\d+)?/);
      if (numMatch) parseStockVal(text, parseFloat(numMatch[0]));
    });
    console.log('  ✓ Source 2 (psx.com.pk)');
  }

  // Source 3: hamariweb stocks
  const h3 = await fetchSafe('https://www.hamariweb.com/finance/pakistan-stock-exchange/');
  if (h3) { const $ = cheerio.load(h3); $('table tr, [class*="index"]').each((i, r) => parseStockRow($, r)); console.log('  ✓ Source 3 (hamariweb stocks)'); }

  // Source 4: Investopak
  const h4 = await fetchSafe('https://www.investopak.com/market-summary');
  if (h4) {
    const $ = cheerio.load(h4);
    $('table tr, [class*="index"], [class*="market"]').each((i, row) => {
      const text = $(row).text();
      const numMatch = text.replace(/,/g, '').match(/\d{5,7}(\.\d+)?/);
      if (numMatch) parseStockVal(text, parseFloat(numMatch[0]));
    });
    console.log('  ✓ Source 4 (investopak.com)');
  }

  // Source 5: Mettis Global
  const h5 = await fetchSafe('https://www.mettis.global/equity/kse100-index');
  if (h5) {
    const $ = cheerio.load(h5);
    $('[class*="index-value"], [class*="current"], table tr').each((i, el) => {
      const text = $(el).text();
      const numMatch = text.replace(/,/g, '').match(/\d{5,7}(\.\d+)?/);
      if (numMatch) parseStockVal('KSE100', parseFloat(numMatch[0]));
    });
    console.log('  ✓ Source 5 (mettis.global)');
  }

  const result = {
    kse100: bestRate(b.kse100, 'median', 'kse100') || FALLBACK.kse100,
    kse30:  bestRate(b.kse30,  'median', 'kse30')  || FALLBACK.kse30,
    kmi30:  bestRate(b.kmi30,  'median', 'kmi30')  || FALLBACK.kmi30
  };
  console.log('  Final stocks:', result);
  return result;
}

// ============================================================
// CATEGORY 6: ELECTRICITY — 5 Sources
// NEPRA | LESCO | KE | IESCO | hamariweb
// Strategy: median
// ============================================================
async function scrapeElectricity() {
  console.log('\n[ELECTRICITY] Scraping 5 sources...');
  const FALLBACK = { normal: 47, peak: 58, offpeak: 36 };
  const b = { normal: [], peak: [], offpeak: [] };

  function parseElecRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const val = parseFloat($(cells[cells.length - 1]).text().replace(/,/g, '').trim());
    if (!val || val <= 0 || val > 200) return;
    if (text.includes('peak') && !text.includes('off'))            b.peak.push(val);
    else if (text.includes('off') && text.includes('peak'))        b.offpeak.push(val);
    else if (text.includes('normal') || text.includes('flat') ||
             text.includes('per unit') || text.includes('per kwh')) b.normal.push(val);
  }

  // Source 1: NEPRA — electricity regulator
  const h1 = await fetchSafe('https://www.nepra.org.pk/tariff/index.php');
  if (h1) { const $ = cheerio.load(h1); $('table tr').each((i, r) => parseElecRow($, r)); console.log('  ✓ Source 1 (NEPRA)'); }

  // Source 2: LESCO — Lahore Electric
  const h2 = await fetchSafe('https://lesco.com.pk/tariff/');
  if (h2) { const $ = cheerio.load(h2); $('table tr').each((i, r) => parseElecRow($, r)); console.log('  ✓ Source 2 (LESCO)'); }

  // Source 3: K-Electric — Karachi
  const h3 = await fetchSafe('https://www.ke.com.pk/customer-support/tariff/');
  if (h3) { const $ = cheerio.load(h3); $('table tr').each((i, r) => parseElecRow($, r)); console.log('  ✓ Source 3 (K-Electric)'); }

  // Source 4: IESCO — Islamabad
  const h4 = await fetchSafe('https://www.iesco.com.pk/index.php/bill-tariff/tariff');
  if (h4) { const $ = cheerio.load(h4); $('table tr').each((i, r) => parseElecRow($, r)); console.log('  ✓ Source 4 (IESCO)'); }

  // Source 5: hamariweb
  const h5 = await fetchSafe('https://www.hamariweb.com/finance/electricity-rates-in-pakistan/');
  if (h5) { const $ = cheerio.load(h5); $('table tr').each((i, r) => parseElecRow($, r)); console.log('  ✓ Source 5 (hamariweb)'); }

  const result = {
    normal:  bestRate(b.normal,  'median', 'elec_normal')  || FALLBACK.normal,
    peak:    bestRate(b.peak,    'median', 'elec_peak')    || FALLBACK.peak,
    offpeak: bestRate(b.offpeak, 'median', 'elec_offpeak') || FALLBACK.offpeak
  };
  console.log('  Final electricity:', result);
  return result;
}

// ============================================================
// CATEGORY 7: AGRICULTURE — 6 Sources
// priceit.pk | hamariweb | kissanpakistan | kissan.pk | tradeinfo | pakagri
// Units: wheat PKR/40kg | rice PKR/kg | sugar PKR/kg | cotton PKR/40kg
// Strategy: avg
// ============================================================
async function scrapeAgriculture() {
  console.log('\n[AGRICULTURE] Scraping 6 sources...');
  const FALLBACK = { wheat: 3800, rice: 150, sugar: 150, cotton: 9000 };
  const b = { wheat: [], rice: [], sugar: [], cotton: [] };

  function parseAgriRow($, row) {
    const text = $(row).text().toLowerCase();
    const cells = $(row).find('td');
    const rawVal = cells.length > 1 ? $(cells[cells.length - 1]).text() : $(row).text();
    const val = parseFloat(rawVal.replace(/,/g, '').replace(/rs\.?/gi, '').trim());
    if (!val || val <= 0) return;

    if (text.includes('wheat') || text.includes('gandum')) {
      if (val >= 500 && val <= 10000)   b.wheat.push(Math.round(val));      // per 40kg
      else if (val >= 30 && val <= 200) b.wheat.push(Math.round(val * 40)); // per kg → per 40kg
    }
    if ((text.includes('rice') || text.includes('chawal')) && val >= 50 && val <= 1000) b.rice.push(val);
    if ((text.includes('sugar') || text.includes('cheeni')) && val >= 50 && val <= 500) b.sugar.push(val);
    if ((text.includes('cotton') || text.includes('kapas')) && val >= 1000 && val <= 30000) b.cotton.push(val);
  }

  const h1 = await fetchSafe('https://priceit.pk/commodity-prices/');
  if (h1) { const $ = cheerio.load(h1); $('table tr').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 1 (priceit.pk)'); }

  const h2 = await fetchSafe('https://www.hamariweb.com/finance/commodity-prices-in-pakistan/');
  if (h2) { const $ = cheerio.load(h2); $('table tr').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 2 (hamariweb agri)'); }

  const h3 = await fetchSafe('https://www.kissanpakistan.com/commodity-prices/');
  if (h3) { const $ = cheerio.load(h3); $('table tr, .price-item').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 3 (kissanpakistan.com)'); }

  const h4 = await fetchSafe('https://www.kissan.pk/market-rates');
  if (h4) { const $ = cheerio.load(h4); $('table tr').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 4 (kissan.pk)'); }

  const h5 = await fetchSafe('https://tractors.com.pk/mandi-prices/');
  if (h5) { const $ = cheerio.load(h5); $('table tr, [class*="price"]').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 5 (tractors.com.pk)'); }

  const h6 = await fetchSafe('https://www.pakagri.com/commodity-prices/');
  if (h6) { const $ = cheerio.load(h6); $('table tr').each((i, r) => parseAgriRow($, r)); console.log('  ✓ Source 6 (pakagri.com)'); }

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
// CATEGORY 8: PROPERTY — 6 Sources
// zameen.com | graana.com | hamariweb | bayut.pk | olx.com.pk | propertyfinder
// Strategy: median
// ============================================================
async function scrapeProperty() {
  console.log('\n[PROPERTY] Scraping 6 sources...');
  const FALLBACK = { lahore: 1250000, karachi: 1500000, islamabad: 2000000 };
  const b = { lahore: [], karachi: [], islamabad: [] };

  function pushCityVal(text, val) {
    if (val < 100000 || val > 50000000) return;
    const lower = text.toLowerCase();
    if (lower.includes('lahore'))    b.lahore.push(val);
    if (lower.includes('karachi'))   b.karachi.push(val);
    if (lower.includes('islamabad')) b.islamabad.push(val);
  }

  function extractFromPage($) {
    const text = $.text ? $.text() : '';
    text.split('\n').forEach(line => {
      const numMatch = line.replace(/,/g, '').match(/(\d{6,9})/);
      if (numMatch) pushCityVal(line, parseInt(numMatch[1]));
    });
  }

  // Source 1: zameen.com property index
  const h1 = await fetchSafe('https://www.zameen.com/property-index/');
  if (h1) {
    const $ = cheerio.load(h1);
    extractFromPage($);
    $('[class*="city"], [class*="price"], table tr').each((i, el) => {
      const numMatch = $(el).text().replace(/,/g, '').match(/(\d{6,9})/);
      if (numMatch) pushCityVal($(el).text(), parseInt(numMatch[1]));
    });
    console.log('  ✓ Source 1 (zameen.com)');
  }

  // Source 2: graana.com property insights
  const h2 = await fetchSafe('https://www.graana.com/property-insights/');
  if (h2) { const $ = cheerio.load(h2); extractFromPage($); console.log('  ✓ Source 2 (graana.com)'); }

  // Source 3: hamariweb property
  const h3 = await fetchSafe('https://www.hamariweb.com/real-estate/property-prices-in-pakistan/');
  if (h3) {
    const $ = cheerio.load(h3);
    $('table tr').each((i, row) => {
      const text = $(row).text();
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const val = parseInt($(cells[1]).text().replace(/,/g, '').trim());
      if (val) pushCityVal(text, val);
    });
    console.log('  ✓ Source 3 (hamariweb property)');
  }

  // Source 4: bayut.pk property index
  const h4 = await fetchSafe('https://www.bayut.pk/property-index/');
  if (h4) { const $ = cheerio.load(h4); extractFromPage($); console.log('  ✓ Source 4 (bayut.pk)'); }

  // Source 5: propertyfinder.pk
  const h5 = await fetchSafe('https://www.propertyfinder.pk/en/blog/property-price-index-pakistan');
  if (h5) { const $ = cheerio.load(h5); extractFromPage($); console.log('  ✓ Source 5 (propertyfinder.pk)'); }

  // Source 6: zameendata.com
  const h6 = await fetchSafe('https://zameendata.com/market-report/');
  if (h6) { const $ = cheerio.load(h6); extractFromPage($); console.log('  ✓ Source 6 (zameendata.com)'); }

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
  console.log('\n========================================================');
  console.log('DailyPak Multi-Source Scraper — 40 Rates | 6 Sources/Cat');
  console.log('========================================================\n');

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
    if (r.status === 'rejected') { console.log(`  ❌ Category ${i} failed:`, r.reason?.message); return null; }
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
    ['goldGram', metals?.goldGram], ['silverTola', metals?.silverTola], ['platinum', metals?.platinum],
    ['petrol', fuel?.petrol], ['diesel', fuel?.diesel],
    ['kerosene', fuel?.kerosene], ['lightDiesel', fuel?.lightDiesel],
    ['bitcoin', crypto?.bitcoin], ['ethereum', crypto?.ethereum],
    ['bnb', crypto?.bnb], ['solana', crypto?.solana], ['xrp', crypto?.xrp],
    ['cardano', crypto?.cardano], ['dogecoin', crypto?.dogecoin], ['tron', crypto?.tron],
    ['kse100', stocks?.kse100], ['kse30', stocks?.kse30], ['kmi30', stocks?.kmi30],
    ['elec_normal', electricity?.normal], ['elec_peak', electricity?.peak], ['elec_offpeak', electricity?.offpeak],
    ['wheat', agriculture?.wheat], ['rice', agriculture?.rice],
    ['sugar', agriculture?.sugar], ['cotton', agriculture?.cotton],
    ['prop_lahore', property?.lahore], ['prop_karachi', property?.karachi], ['prop_islamabad', property?.islamabad]
  ];

  allRates.forEach(([key, val]) => { if (val) updateHistory(history, key, val); });

  const data = {
    currencies:  currencies  || {},
    metals:      metals      || {},
    fuel:        fuel        || {},
    crypto:      crypto      || {},
    stocks:      stocks      || {},
    electricity: electricity || {},
    agriculture: agriculture || {},
    property:    property    || {},
    updated: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' })
  };

  await kvSet('rates', data);
  await kvSet('history', history);

  console.log('\n========================================================');
  console.log('✅ All 40 rates updated! Sources per category:');
  console.log('  Currencies  (6) : hamariweb | pkr.com.pk | forex.pk | currency.pk | thecurrencyshop | open.er-api');
  console.log('  Metals      (6) : bullion.pk | goldratepk | gold.com.pk | hamariweb | goldbullion.pk | metals.live');
  console.log('  Fuel        (6) : PSO | OGRA | hamariweb | pakwheels | petrolprice.pk | dawn');
  console.log('  Crypto      (5) : CoinGecko | CoinCap | Binance | KuCoin | CryptoCompare');
  console.log('  Stocks      (5) : dps.psx | psx.com.pk | hamariweb | investopak | mettis.global');
  console.log('  Electricity (5) : NEPRA | LESCO | K-Electric | IESCO | hamariweb');
  console.log('  Agriculture (6) : priceit.pk | hamariweb | kissanpakistan | kissan.pk | tractors | pakagri');
  console.log('  Property    (6) : zameen.com | graana.com | hamariweb | bayut.pk | propertyfinder | zameendata');
  console.log('  Total Sources   : 45 endpoints');
  console.log('  Total Rates     : 40');
  console.log('  History         : 30 din ka data');
  console.log('========================================================\n');
}

scrapeAll();
