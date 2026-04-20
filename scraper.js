/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   DailyPak Multi-Source Scraper  v4.0  — ULTRA IMPROVED    ║
 * ║   40 Rates | 50+ Sources | IQR Filter | Weighted Median    ║
 * ║   Smart Fallback | Parallel Fetch | Rate Change Report     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
'use strict';
const axios   = require('axios');
const cheerio = require('cheerio');

// ─── CLOUDFLARE KV ────────────────────────────────────────────
const CF_ACCOUNT_ID      = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN       = process.env.CF_API_TOKEN;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const KV_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`;
const KV_HEADERS = { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };

// ─── USER-AGENTS (rotate to avoid blocks) ────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];
const getUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const BASE_HEADERS = () => ({
  'User-Agent':                getUA(),
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  'Cache-Control':             'no-cache',
  'Pragma':                    'no-cache',
  'DNT':                       '1',
  'Upgrade-Insecure-Requests': '1',
});

// ─── UPDATED MASTER FALLBACK (April 2026) ─────────────────────
// Only used if ALL sources + KV cache fail
const MASTER_FALLBACK = {
  usd:279,    aed:76,    sar:74,    eur:320,   gbp:370,
  cny:39,     try:8,     cad:204,   aud:182,   qar:77,
  gold24k:503000, gold22k:461000, goldGram:43100, silverTola:5800, platinum:32000,
  petrol:458.40,  diesel:168.00,  kerosene:155.00, lightDiesel:148.00,
  bitcoin:75000,  ethereum:2300,  bnb:625,    solana:85, xrp:1.42,
  cardano:0.25,   dogecoin:0.094, tron:0.33,
  kse100:171000,  kse30:112000,   kmi30:211000,
  elec_normal:47, elec_peak:58,   elec_offpeak:36,
  wheat:3800,     rice:150,       sugar:150,  cotton:9000,
  prop_lahore:1250000, prop_karachi:1500000, prop_islamabad:2000000,
};

// Max % allowed change vs previous KV value (sanity guard)
const SANITY = { default:15, crypto:30, gold:12, fuel:25 };

// Staleness alert: if unchanged for > N days, it may be stale
const STALE_DAYS = { petrol:3, diesel:3, gold24k:1, kse100:1, default:7 };

// ─── STATISTICS UTILITIES ──────────────────────────────────────

/**
 * Remove outliers using Inter-Quartile Range (IQR) method.
 * Values outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR] are dropped.
 */
function removeOutliers(arr) {
  if (arr.length < 4) return arr;
  const sorted = [...arr].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo  = q1 - 1.5 * iqr;
  const hi  = q3 + 1.5 * iqr;
  const filtered = arr.filter(v => v >= lo && v <= hi);
  if (filtered.length < arr.length) {
    console.log(`    IQR: removed ${arr.length - filtered.length} outlier(s) ${JSON.stringify(arr.filter(v => v < lo || v > hi))}`);
  }
  return filtered.length > 0 ? filtered : arr;
}

/**
 * Weighted median: official/trusted sources get weight > 1.
 * weights array must match values array.
 */
function weightedMedian(values, weights) {
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  // Expand: repeat each value by its weight
  const expanded = [];
  values.forEach((v, i) => { for (let w = 0; w < (weights?.[i] || 1); w++) expanded.push(v); });
  expanded.sort((a, b) => a - b);
  const mid = Math.floor(expanded.length / 2);
  return expanded.length % 2 === 0 ? (expanded[mid - 1] + expanded[mid]) / 2 : expanded[mid];
}

/**
 * Best-rate selector with IQR cleanup + weighted median.
 * strategy: 'median' | 'avg' | 'weighted'
 * weights: optional array (same length as values), only for 'weighted'
 */
function bestRate(values, strategy = 'median', label = '', weights = null) {
  const valid = values.filter(v => typeof v === 'number' && isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return parseFloat(valid[0].toFixed(4));
  const clean = removeOutliers(valid);
  let result;
  if (strategy === 'avg') {
    result = clean.reduce((a, b) => a + b, 0) / clean.length;
  } else if (strategy === 'weighted' && weights) {
    result = weightedMedian(clean, weights);
  } else {
    const sorted = [...clean].sort((a, b) => a - b);
    const mid    = Math.floor(sorted.length / 2);
    result = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  if (label) console.log(`    📊 [${label}] raw:[${valid.join(',')}] clean:[${clean.join(',')}] → ${parseFloat(result.toFixed(4))}`);
  return parseFloat(result.toFixed(4));
}

// ─── NETWORK ───────────────────────────────────────────────────

async function fetchSafe(url, options = {}, retries = 2, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: 13000,
        headers: BASE_HEADERS(),
        validateStatus: s => s < 500,
        ...options,
      });
      if (res.status === 429) { // Rate limited
        console.log(`    ⏳ Rate limited on ${url}, waiting ${delayMs * 2}ms...`);
        await new Promise(r => setTimeout(r, delayMs * 2));
        continue;
      }
      return res.data;
    } catch (e) {
      const msg = e.code === 'ECONNABORTED' ? 'TIMEOUT' : e.message;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * attempt));
      } else {
        console.log(`    ⚠ [${attempt}/${retries}] ${url.substring(0, 60)} → ${msg}`);
      }
    }
  }
  return null;
}

// ─── KV OPERATIONS ────────────────────────────────────────────
async function kvGet(key) {
  try {
    const res = await axios.get(`${KV_BASE}/${key}`, { headers: KV_HEADERS, timeout: 8000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return null; }
}

async function kvSet(key, value) {
  try {
    await axios.put(`${KV_BASE}/${key}`, JSON.stringify(value), { headers: KV_HEADERS, timeout: 8000 });
    return true;
  } catch (e) { console.log(`  ❌ KV write [${key}] failed: ${e.message}`); return false; }
}

// ─── HELPER: Flatten nested rate object ───────────────────────
function flattenRates(data) {
  if (!data || typeof data !== 'object') return {};
  const flat = {};
  const push = obj => { if (obj) Object.entries(obj).forEach(([k, v]) => { if (typeof v === 'number' && v > 0) flat[k] = v; }); };
  push(data.currencies);
  push(data.metals);
  push(data.fuel);
  push(data.crypto);
  push(data.stocks);
  if (data.electricity) {
    if (data.electricity.normal)  flat.elec_normal  = data.electricity.normal;
    if (data.electricity.peak)    flat.elec_peak    = data.electricity.peak;
    if (data.electricity.offpeak) flat.elec_offpeak = data.electricity.offpeak;
  }
  push(data.agriculture);
  if (data.property) {
    if (data.property.lahore)    flat.prop_lahore    = data.property.lahore;
    if (data.property.karachi)   flat.prop_karachi   = data.property.karachi;
    if (data.property.islamabad) flat.prop_islamabad = data.property.islamabad;
  }
  return flat;
}

// ─── SANITY CHECK ─────────────────────────────────────────────
// Returns the sanitized value (prev cached if change is too large)
function sanityCheck(key, newVal, prevFlat) {
  if (!newVal || newVal <= 0) return null;
  const prev = prevFlat?.[key];
  if (!prev || prev <= 0) return newVal;
  const cat = ['bitcoin','ethereum','bnb','solana','xrp','cardano','dogecoin','tron'].includes(key) ? 'crypto'
            : ['gold24k','gold22k','goldGram','silverTola','platinum'].includes(key) ? 'gold'
            : ['petrol','diesel','kerosene','lightDiesel'].includes(key) ? 'fuel' : 'default';
  const maxPct = SANITY[cat];
  const pct    = Math.abs((newVal - prev) / prev) * 100;
  if (pct > maxPct) {
    console.log(`  🛑 SANITY [${key}]: prev=${prev} new=${newVal} Δ=${pct.toFixed(1)}% > ${maxPct}% → keeping cached`);
    return prev;
  }
  return newVal;
}

// ─── SMART FALLBACK ───────────────────────────────────────────
// Priority: scraped → KV cache → MASTER_FALLBACK
function smartVal(scraped, key, prevFlat) {
  const s = sanityCheck(key, scraped, prevFlat);
  if (s && s > 0) return s;
  const cached = prevFlat?.[key];
  if (cached && cached > 0) { console.log(`    💾 [${key}] using KV cache: ${cached}`); return cached; }
  return MASTER_FALLBACK[key] || null;
}

// ─── HISTORY ──────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (ISO, no timezone confusion)
}

function updateHistory(history, key, newRate) {
  if (!newRate || newRate <= 0) return history;
  if (!history[key]) history[key] = [];
  const today    = todayStr();
  const existing = history[key].findIndex(e => e.date === today);
  if (existing >= 0) history[key][existing].rate = newRate;
  else history[key].push({ date: today, rate: newRate });
  // Keep last 365 days max, sorted ascending
  history[key].sort((a, b) => a.date.localeCompare(b.date));
  if (history[key].length > 365) history[key] = history[key].slice(-365);
  return history;
}

// ─── STALENESS DETECTION ──────────────────────────────────────
function checkStaleness(key, history) {
  if (!history?.[key] || history[key].length < 2) return;
  const last = history[key][history[key].length - 1];
  const prev = history[key][history[key].length - 2];
  if (!last || !prev) return;
  const daysSince = (new Date(todayStr()) - new Date(last.date)) / 86400000;
  const maxDays   = STALE_DAYS[key] || STALE_DAYS.default;
  if (daysSince >= maxDays && last.rate === prev.rate) {
    console.log(`  ⚠️  STALE ALERT [${key}]: rate unchanged for ${daysSince} days (${last.rate})`);
  }
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 1: CURRENCIES
//  Sources: SBP (official) | HamariWeb | pkr.com.pk | forex.pk
//           currency.pk | thecurrencyshop | open.er-api
//  Strategy: weighted median (SBP = weight 3, others = weight 1)
// ────────────────────────────────────────────────────────────────
async function scrapeCurrencies() {
  const CAT = '[CURRENCIES]';
  console.log(`\n${CAT} Starting parallel fetch (7 sources)...`);
  const t = Date.now();

  const KEYS = ['usd','aed','sar','eur','gbp','cny','try','cad','aud','qar'];
  const b       = {}; // bucket: { key: [val, ...] }
  const trusted = {}; // trusted/official values
  KEYS.forEach(k => { b[k] = []; trusted[k] = []; });

  function addCcy(name, val, isTrusted = false) {
    const n  = (name || '').toLowerCase().trim();
    const v  = parseFloat(val);
    if (!v || v <= 10 || v > 10000) return;
    const   MAP = [
      [/us\s*dollar|usd/,               'usd'],
      [/uae|dirham|aed/,                 'aed'],
      [/saudi|riyal|sar/,                'sar'],
      [/euro?|eur/,                      'eur'],
      [/pound|gbp|sterling/,             'gbp'],
      [/yuan|chinese|cny|renminbi/,      'cny'],
      [/turkish|lira|\btry\b/,           'try'],
      [/canadian|cad/,                   'cad'],
      [/australian|aud/,                 'aud'],
      [/qatari|qar/,                     'qar'],
    ];
    MAP.forEach(([rx, key]) => { if (rx.test(n)) { b[key].push(v); if (isTrusted) trusted[key].push(v); } });
  }

  function parseTable($, sellCol = 2) {
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      addCcy($(cells[0]).text(), $(cells[Math.min(sellCol, cells.length-1)]).text().replace(/,/g,''));
    });
  }

  // All sources fetched in parallel
  const [sbp, hw, pkr, fx, cp, shop, erapi] = await Promise.allSettled([
    fetchSafe('https://www.sbp.org.pk/ecodata/exchange_rates.asp'),            // SBP official
    fetchSafe('https://www.hamariweb.com/finance/forex/open_market_rates.aspx'),
    fetchSafe('https://www.pkr.com.pk/open-market/'),
    fetchSafe('https://forex.pk/open-market-rates/'),
    fetchSafe('https://www.currency.pk/'),
    fetchSafe('https://www.thecurrencyshop.com.pk/'),
    fetchSafe('https://open.er-api.com/v6/latest/PKR', { headers: {} }),      // API
  ]);

  // SBP — official (trusted weight = 3)
  if (sbp.status === 'fulfilled' && sbp.value) {
    const $ = cheerio.load(sbp.value);
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const name  = $(cells[0]).text();
      const sell  = $(cells[2]).text().replace(/,/g,'');
      addCcy(name, sell, true); // trusted = true
    });
    console.log('  ✓ SBP official (trusted ×3)');
  }

  if (hw.status    === 'fulfilled' && hw.value)   { parseTable(cheerio.load(hw.value), 2);   console.log('  ✓ hamariweb'); }
  if (pkr.status   === 'fulfilled' && pkr.value)  { const $ = cheerio.load(pkr.value); $('table tr').each((_,r) => { const c=$(r).find('td'); if(c.length<2)return; addCcy($(c[0]).text(),$(c[c.length-1]).text().replace(/,/g,'')); }); console.log('  ✓ pkr.com.pk'); }
  if (fx.status    === 'fulfilled' && fx.value)   { parseTable(cheerio.load(fx.value), 2);   console.log('  ✓ forex.pk'); }
  if (cp.status    === 'fulfilled' && cp.value)   { parseTable(cheerio.load(cp.value), 2);   console.log('  ✓ currency.pk'); }
  if (shop.status  === 'fulfilled' && shop.value) { parseTable(cheerio.load(shop.value), 1); console.log('  ✓ thecurrencyshop'); }

  if (erapi.status === 'fulfilled' && erapi.value?.rates) {
    const r   = erapi.value.rates;
    const inv = v => v > 0 ? parseFloat((1/v).toFixed(2)) : 0;
    [['USD','usd'],['AED','aed'],['SAR','sar'],['EUR','eur'],['GBP','gbp'],
     ['CNY','cny'],['TRY','try'],['CAD','cad'],['AUD','aud'],['QAR','qar']]
      .forEach(([sym,key]) => { const v=inv(r[sym]); if(v>0) b[key].push(v); });
    console.log('  ✓ open.er-api (API)');
  }

  // Weighted median: trusted sources count 3x
  const result = {};
  KEYS.forEach(k => {
    const allVals = b[k];
    const weights = allVals.map(v => trusted[k].includes(v) ? 3 : 1);
    result[k] = bestRate(allVals, 'weighted', k, weights) || MASTER_FALLBACK[k];
  });
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 2: GOLD & METALS — 7 sources (all parallel)
// ────────────────────────────────────────────────────────────────
async function scrapeMetals() {
  const CAT = '[METALS]';
  console.log(`\n${CAT} Starting parallel fetch (7 sources)...`);
  const t  = Date.now();
  const b  = { gold24k:[], gold22k:[], goldGram:[], silverTola:[] };

  function parseGold($, el) {
    const text  = $(el).text().toLowerCase();
    const cells = $(el).find('td');
    const raw   = (cells.length > 1 ? $(cells[cells.length-1]).text() : $(el).text()).replace(/[^0-9.]/g,'');
    const val   = parseFloat(raw);
    if (!val || val <= 0) return;
    // 24K Tola: 300k-800k range
    if (/24\s*(k|karat|carat)/.test(text) && val > 250000 && val < 900000) b.gold24k.push(val);
    // 22K Tola: 250k-750k range
    if (/22\s*(k|karat|carat)/.test(text) && val > 200000 && val < 800000) b.gold22k.push(val);
    // Per gram: 20k-100k
    if (/(per\s*gram|\/gram|gram\s*rate)/.test(text) && val > 20000 && val < 100000) b.goldGram.push(val);
    // Silver per tola: 1000-20000
    if (/(silver|chandi)/.test(text) && val > 1000 && val < 20000) b.silverTola.push(val);
  }

  const [s1,s2,s3,s4,s5,s6,s7] = await Promise.allSettled([
    fetchSafe('https://www.bullion.pk/'),
    fetchSafe('https://www.goldratepk.com/'),
    fetchSafe('https://gold.com.pk/'),
    fetchSafe('https://www.hamariweb.com/finance/gold-rates-in-pakistan.aspx'),
    fetchSafe('https://goldbullion.pk/'),
    fetchSafe('https://www.sarafa.com.pk/'),           // Sarafa Association
    fetchSafe('https://api.metals.live/v1/spot/gold', { headers:{} }),  // International calc
  ]);

  const htmlSrcs = [
    [s1,'bullion.pk'], [s2,'goldratepk.com'], [s3,'gold.com.pk'],
    [s4,'hamariweb'], [s5,'goldbullion.pk'],  [s6,'sarafa.com.pk'],
  ];
  htmlSrcs.forEach(([src, name]) => {
    if (src.status === 'fulfilled' && src.value) {
      const $ = cheerio.load(src.value);
      $('table tr, .price-row, .rate-item, [class*="gold"], [class*="rate"], [class*="price"]').each((_,r) => parseGold($,r));
      console.log(`  ✓ ${name}`);
    }
  });

  // Cross-calculation from international spot price
  if (s7.status === 'fulfilled' && s7.value?.[0]?.gold) {
    const goldUsdOz  = s7.value[0].gold; // USD per troy oz
    const usdPkr     = 280;              // approximate
    const perTola    = Math.round((goldUsdOz * usdPkr) / 2.667); // 1 tola = 0.375 troy oz → 2.667 tola/oz
    if (perTola > 250000 && perTola < 900000) {
      b.gold24k.push(perTola);
      b.gold22k.push(Math.round(perTola * 22/24));
      b.goldGram.push(Math.round(perTola / 11.664));
      console.log(`  ✓ metals.live cross-calc (${goldUsdOz} USD/oz → 24K ≈ Rs ${perTola})`);
    }
  }

  const gold24k    = bestRate(b.gold24k,    'median', 'gold24k')    || MASTER_FALLBACK.gold24k;
  const gold22k    = bestRate(b.gold22k,    'median', 'gold22k')    || Math.round(gold24k * 22/24);
  const goldGram   = bestRate(b.goldGram,   'median', 'goldGram')   || Math.round(gold24k / 11.664);
  const silverTola = bestRate(b.silverTola, 'median', 'silverTola') || MASTER_FALLBACK.silverTola;

  const result = { gold24k, gold22k, goldGram, silverTola, platinum: MASTER_FALLBACK.platinum };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 3: FUEL — 9 sources (parallel + JSON pattern search)
//  Strategy: MEDIAN (official sources weighted higher)
// ────────────────────────────────────────────────────────────────
async function scrapeFuel() {
  const CAT = '[FUEL]';
  console.log(`\n${CAT} Starting parallel fetch (9 sources)...`);
  const t = Date.now();

  // Price ranges: [min, max]
  const RANGES = { petrol:[300,700], diesel:[100,600], kerosene:[100,400], lightDiesel:[100,350] };
  const b       = { petrol:[], diesel:[], kerosene:[], lightDiesel:[] };
  const trusted = { petrol:[], diesel:[], kerosene:[], lightDiesel:[] };

  function addFuel(type, val, isTrusted = false) {
    const v    = parseFloat(val);
    const [lo,hi] = RANGES[type] || [0,10000];
    if (!v || v < lo || v > hi) return;
    const rounded = parseFloat(v.toFixed(2));
    b[type].push(rounded);
    if (isTrusted) trusted[type].push(rounded);
  }

  function parseFuelRow($, el, isTrusted = false) {
    const text  = $(el).text().toLowerCase();
    const cells = $(el).find('td');
    const raw   = (cells.length > 0 ? $(cells[cells.length-1]).text() : $(el).text()).replace(/,/g,'').replace(/rs\.?/gi,'').trim();
    const val   = parseFloat(raw);
    if (!val) return;
    if (/petrol|motor.?spirit|\bms\b|gasoil|euro\s*5/.test(text)) addFuel('petrol', val, isTrusted);
    if (/(high.?speed.?diesel|\bhsd\b)/.test(text) || (text.includes('diesel') && !text.includes('light'))) addFuel('diesel', val, isTrusted);
    if (/kerosene|kero\b/.test(text))        addFuel('kerosene',    val, isTrusted);
    if (/light.?diesel|\bldo\b/.test(text))  addFuel('lightDiesel', val, isTrusted);
  }

  // Regex search for numbers embedded in text (JSON / inline / plain paragraphs)
  function extractFromText(text) {
    const patterns = [
      { rx:/petrol[^0-9]*?([\d]+\.?\d{0,2})\s*(?:rupees|pkr|rs|per)/gi,  type:'petrol' },
      { rx:/diesel[^0-9]*?([\d]+\.?\d{0,2})\s*(?:rupees|pkr|rs|per)/gi,  type:'diesel' },
      { rx:/ms\.?\s+euro\s+5[^0-9]*?([\d]+\.?\d{0,2})/gi,               type:'petrol' },
      { rx:/hsd[^0-9]*?([\d]+\.?\d{0,2})/gi,                             type:'diesel' },
      { rx:/petrol[^\n]{0,30}?(4[3-9]\d\.\d{2})/gi,                      type:'petrol' }, // 430-499
      { rx:/(?:price|rate)[^<]*?(4[3-9]\d\.\d{0,2})/gi,                  type:'petrol' }, // Generic 430-499
    ];
    patterns.forEach(({ rx, type }) => {
      let m;
      while ((m = rx.exec(text)) !== null) addFuel(type, m[1]);
    });
  }

  // ALL 9 sources in parallel
  const [pso, ogra, hw, pw, pp, dawn, geo, bol, express] = await Promise.allSettled([
    fetchSafe('https://www.psopk.com/retail-fuels/fuel-prices'),
    fetchSafe('https://www.ogra.org.pk/petroleum-products-prices'),
    fetchSafe('https://www.hamariweb.com/finance/petrol-prices-in-pakistan/'),
    fetchSafe('https://www.pakwheels.com/fuel-prices/'),
    fetchSafe('https://www.petrolprice.pk/'),
    fetchSafe('https://www.dawn.com/petrol-price/'),
    fetchSafe('https://www.geo.tv/latest/petrol-prices-pakistan'),
    fetchSafe('https://www.bolnews.com/latest/petrol-diesel-prices-today-pakistan/'),
    fetchSafe('https://www.express.pk/petrol-rates-in-pakistan/'),
  ]);

  // PSO & OGRA are official → trusted
  if (pso.status  === 'fulfilled' && pso.value)  { const $ = cheerio.load(pso.value);  $('table tr, [class*="fuel"], [class*="price"]').each((_,r) => parseFuelRow($,r,true));  extractFromText(pso.value);  console.log('  ✓ PSO official (trusted ×3)'); }
  if (ogra.status === 'fulfilled' && ogra.value) { const $ = cheerio.load(ogra.value); $('table tr').each((_,r) => parseFuelRow($,r,true)); extractFromText(ogra.value); console.log('  ✓ OGRA official (trusted ×3)'); }
  if (hw.status   === 'fulfilled' && hw.value)   { const $ = cheerio.load(hw.value);   $('table tr').each((_,r) => parseFuelRow($,r));          extractFromText(hw.value);   console.log('  ✓ hamariweb'); }
  if (pw.status   === 'fulfilled' && pw.value)   { const $ = cheerio.load(pw.value);   $('table tr, [class*="fuel"], [class*="price"]').each((_,r) => parseFuelRow($,r)); extractFromText(pw.value); console.log('  ✓ pakwheels'); }
  if (pp.status   === 'fulfilled' && pp.value)   { const $ = cheerio.load(pp.value);   $('table tr, [class*="price"]').each((_,r) => parseFuelRow($,r)); console.log('  ✓ petrolprice.pk'); }
  if (dawn.status === 'fulfilled' && dawn.value) { const $ = cheerio.load(dawn.value); $('table tr, [class*="price"]').each((_,r) => parseFuelRow($,r)); extractFromText(dawn.value); console.log('  ✓ dawn.com'); }
  if (geo.status  === 'fulfilled' && geo.value)  { extractFromText(geo.value.toString());  console.log('  ✓ geo.tv'); }
  if (bol.status  === 'fulfilled' && bol.value)  { extractFromText(bol.value.toString());  console.log('  ✓ bolnews'); }
  if (express.status === 'fulfilled' && express.value) { const $ = cheerio.load(express.value); $('table tr, [class*="price"]').each((_,r) => parseFuelRow($,r)); extractFromText(express.value.toString()); console.log('  ✓ express.pk'); }

  // Weighted median for fuel (trusted sources count 3x)
  const makeWeights = (vals, trustedVals) => vals.map(v => trustedVals.includes(v) ? 3 : 1);
  const result = {
    petrol:      bestRate(b.petrol,      'weighted', 'petrol',      makeWeights(b.petrol,      trusted.petrol))      || MASTER_FALLBACK.petrol,
    diesel:      bestRate(b.diesel,      'weighted', 'diesel',      makeWeights(b.diesel,      trusted.diesel))      || MASTER_FALLBACK.diesel,
    kerosene:    bestRate(b.kerosene,    'median',   'kerosene')    || MASTER_FALLBACK.kerosene,
    lightDiesel: bestRate(b.lightDiesel, 'median',   'lightDiesel') || MASTER_FALLBACK.lightDiesel,
  };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 4: CRYPTO — 5 sources (fully parallel)
// ────────────────────────────────────────────────────────────────
async function scrapeCrypto() {
  const CAT = '[CRYPTO]';
  console.log(`\n${CAT} Starting fully parallel fetch (5 sources)...`);
  const t   = Date.now();
  const b   = { bitcoin:[], ethereum:[], bnb:[], solana:[], xrp:[], cardano:[], dogecoin:[], tron:[] };

  const ID2KEY  = { bitcoin:'bitcoin', ethereum:'ethereum', 'binance-coin':'bnb', binancecoin:'bnb', solana:'solana', ripple:'xrp', xrp:'xrp', cardano:'cardano', dogecoin:'dogecoin', tron:'tron' };
  const SYM2KEY = { BTC:'bitcoin', ETH:'ethereum', BNB:'bnb', SOL:'solana', XRP:'xrp', ADA:'cardano', DOGE:'dogecoin', TRX:'tron' };
  const KU_MAP  = { 'BTC-USDT':'bitcoin','ETH-USDT':'ethereum','BNB-USDT':'bnb','SOL-USDT':'solana','XRP-USDT':'xrp','ADA-USDT':'cardano','DOGE-USDT':'dogecoin','TRX-USDT':'tron' };

  function push(id, price) {
    const key = ID2KEY[id?.toLowerCase()] || SYM2KEY[id];
    if (key && b[key] && price > 0) b[key].push(parseFloat(price));
  }

  const [cg, cap, binance, kucoin, crc] = await Promise.allSettled([
    fetchSafe('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,cardano,dogecoin,tron&vs_currencies=usd', { headers:{} }),
    fetchSafe('https://api.coincap.io/v2/assets?ids=bitcoin,ethereum,binance-coin,solana,xrp,cardano,dogecoin,tron&limit=10', { headers:{} }),
    fetchSafe(`https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','TRXUSDT'])}`, { headers:{} }),
    Promise.allSettled(Object.keys(KU_MAP).map(sym =>
      fetchSafe(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${sym}`, { headers:{} })
        .then(d => ({ sym, price: d?.data?.price }))
    )),
    fetchSafe('https://min-api.cryptocompare.com/data/pricemulti?fsyms=BTC,ETH,BNB,SOL,XRP,ADA,DOGE,TRX&tsyms=USD', { headers:{} }),
  ]);

  if (cg.status      === 'fulfilled' && cg.value)     { Object.entries(cg.value).forEach(([id,d]) => push(id,d?.usd));   console.log('  ✓ CoinGecko'); }
  if (cap.status     === 'fulfilled' && cap.value?.data) { cap.value.data.forEach(c => push(c.id, parseFloat(c.priceUsd))); console.log('  ✓ CoinCap'); }
  if (binance.status === 'fulfilled' && Array.isArray(binance.value)) { binance.value.forEach(t => push(t.symbol.replace('USDT',''), parseFloat(t.price))); console.log('  ✓ Binance'); }
  if (kucoin.status  === 'fulfilled') { kucoin.value.forEach(r => { if (r.status==='fulfilled' && r.value?.price) push(KU_MAP[r.value.sym], parseFloat(r.value.price)); }); console.log('  ✓ KuCoin (parallel)'); }
  if (crc.status     === 'fulfilled' && crc.value)    { Object.entries(crc.value).forEach(([sym,p]) => { if(p?.USD && SYM2KEY[sym]) push(sym, p.USD); }); console.log('  ✓ CryptoCompare'); }

  const result = {};
  Object.keys(b).forEach(k => { result[k] = bestRate(b[k], 'median', k) || MASTER_FALLBACK[k]; });
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 5: PSX STOCKS — 5 sources (parallel)
// ────────────────────────────────────────────────────────────────
async function scrapeStocks() {
  const CAT = '[STOCKS]';
  console.log(`\n${CAT} Starting parallel fetch (5 sources)...`);
  const t = Date.now();
  const b = { kse100:[], kse30:[], kmi30:[] };

  function addIdx(text, val) {
    if (!val || val <= 0) return;
    if (/KSE.?100/i.test(text) && val > 50000   && val < 700000) b.kse100.push(val);
    if (/KSE.?30/i.test(text)  && val > 20000   && val < 700000) b.kse30.push(val);
    if (/KMI.?30/i.test(text)  && val > 50000   && val < 700000) b.kmi30.push(val);
  }

  const [s1,s2,s3,s4,s5] = await Promise.allSettled([
    fetchSafe('https://dps.psx.com.pk/indices'),
    fetchSafe('https://www.psx.com.pk/'),
    fetchSafe('https://www.hamariweb.com/finance/pakistan-stock-exchange/'),
    fetchSafe('https://www.investopak.com/market-summary'),
    fetchSafe('https://www.mettis.global/equity/kse100-index'),
  ]);

  const htmlSrcs = [[s1,'dps.psx.com.pk'],[s2,'psx.com.pk'],[s3,'hamariweb'],[s4,'investopak'],[s5,'mettis.global']];
  htmlSrcs.forEach(([src, name]) => {
    if (src.status === 'fulfilled' && src.value) {
      const $ = cheerio.load(src.value);
      $('table tr, [class*="index"], [class*="Index"], [class*="market"]').each((_, el) => {
        const text = $(el).text();
        const m    = text.replace(/,/g,'').match(/\d{6,7}(\.\d+)?/);
        if (m) addIdx(text, parseFloat(m[0]));
        const cells = $(el).find('td');
        if (cells.length >= 2) addIdx($(cells[0]).text(), parseFloat($(cells[1]).text().replace(/,/g,'').trim()));
      });
      console.log(`  ✓ ${name}`);
    }
  });

  const result = {
    kse100: bestRate(b.kse100, 'median', 'kse100') || MASTER_FALLBACK.kse100,
    kse30:  bestRate(b.kse30,  'median', 'kse30')  || MASTER_FALLBACK.kse30,
    kmi30:  bestRate(b.kmi30,  'median', 'kmi30')  || MASTER_FALLBACK.kmi30,
  };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 6: ELECTRICITY — 5 sources (parallel)
// ────────────────────────────────────────────────────────────────
async function scrapeElectricity() {
  const CAT = '[ELECTRICITY]';
  console.log(`\n${CAT} Starting parallel fetch (5 sources)...`);
  const t = Date.now();
  const b = { normal:[], peak:[], offpeak:[] };

  function parseElecRow($, el) {
    const text  = $(el).text().toLowerCase();
    const cells = $(el).find('td');
    if (cells.length < 2) return;
    const val   = parseFloat($(cells[cells.length-1]).text().replace(/,/g,'').trim());
    if (!val || val <= 0 || val > 200) return;
    if (/off.?peak/.test(text))                                   b.offpeak.push(val);
    else if (/\bpeak\b/.test(text))                               b.peak.push(val);
    else if (/normal|flat|per.?unit|per.?kwh|general/.test(text)) b.normal.push(val);
  }

  const [s1,s2,s3,s4,s5] = await Promise.allSettled([
    fetchSafe('https://www.nepra.org.pk/tariff/index.php'),
    fetchSafe('https://lesco.com.pk/tariff/'),
    fetchSafe('https://www.ke.com.pk/customer-support/tariff/'),
    fetchSafe('https://www.iesco.com.pk/index.php/bill-tariff/tariff'),
    fetchSafe('https://www.hamariweb.com/finance/electricity-rates-in-pakistan/'),
  ]);

  [[s1,'NEPRA'],[s2,'LESCO'],[s3,'K-Electric'],[s4,'IESCO'],[s5,'hamariweb']].forEach(([src,name]) => {
    if (src.status === 'fulfilled' && src.value) {
      const $ = cheerio.load(src.value);
      $('table tr').each((_,r) => parseElecRow($,r));
      console.log(`  ✓ ${name}`);
    }
  });

  const result = {
    normal:  bestRate(b.normal,  'median', 'elec_normal')  || MASTER_FALLBACK.elec_normal,
    peak:    bestRate(b.peak,    'median', 'elec_peak')    || MASTER_FALLBACK.elec_peak,
    offpeak: bestRate(b.offpeak, 'median', 'elec_offpeak') || MASTER_FALLBACK.elec_offpeak,
  };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 7: AGRICULTURE — 6 sources (parallel)
// ────────────────────────────────────────────────────────────────
async function scrapeAgriculture() {
  const CAT = '[AGRICULTURE]';
  console.log(`\n${CAT} Starting parallel fetch (6 sources)...`);
  const t = Date.now();
  const b = { wheat:[], rice:[], sugar:[], cotton:[] };

  function parseAgri($, el) {
    const text  = $(el).text().toLowerCase();
    const cells = $(el).find('td');
    const raw   = (cells.length > 1 ? $(cells[cells.length-1]).text() : $(el).text()).replace(/[^0-9.]/g,'').trim();
    const val   = parseFloat(raw);
    if (!val || val <= 0) return;
    if (/\bwheat\b|gandum/.test(text)) {
      if (val >= 500 && val <= 20000)  b.wheat.push(Math.round(val));
      else if (val >= 30 && val < 500) b.wheat.push(Math.round(val * 40));
    }
    if (/\brice\b|chawal/.test(text)        && val >= 40  && val <= 800)   b.rice.push(val);
    if (/\bsugar\b|cheeni|sukkar/.test(text) && val >= 50  && val <= 400)   b.sugar.push(val);
    if (/\bcotton\b|kapas/.test(text)        && val >= 2000 && val <= 30000) b.cotton.push(val);
  }

  const [s1,s2,s3,s4,s5,s6] = await Promise.allSettled([
    fetchSafe('https://priceit.pk/commodity-prices/'),
    fetchSafe('https://www.hamariweb.com/finance/commodity-prices-in-pakistan/'),
    fetchSafe('https://www.kissanpakistan.com/commodity-prices/'),
    fetchSafe('https://www.kissan.pk/market-rates'),
    fetchSafe('https://tractors.com.pk/mandi-prices/'),
    fetchSafe('https://www.pakagri.com/commodity-prices/'),
  ]);

  [[s1,'priceit.pk'],[s2,'hamariweb'],[s3,'kissanpakistan'],[s4,'kissan.pk'],[s5,'tractors.com.pk'],[s6,'pakagri.com']].forEach(([src,name]) => {
    if (src.status === 'fulfilled' && src.value) {
      const $ = cheerio.load(src.value);
      $('table tr, .price-item, [class*="commodity"]').each((_,r) => parseAgri($,r));
      console.log(`  ✓ ${name}`);
    }
  });

  const result = {
    wheat:  bestRate(b.wheat,  'avg', 'wheat')  || MASTER_FALLBACK.wheat,
    rice:   bestRate(b.rice,   'avg', 'rice')   || MASTER_FALLBACK.rice,
    sugar:  bestRate(b.sugar,  'avg', 'sugar')  || MASTER_FALLBACK.sugar,
    cotton: bestRate(b.cotton, 'avg', 'cotton') || MASTER_FALLBACK.cotton,
  };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  CATEGORY 8: PROPERTY — 6 sources (parallel + strict parsing)
// ────────────────────────────────────────────────────────────────
async function scrapeProperty() {
  const CAT = '[PROPERTY]';
  console.log(`\n${CAT} Starting parallel fetch (6 sources)...`);
  const t = Date.now();
  const b = { lahore:[], karachi:[], islamabad:[] };

  // Marla rate: Lahore 8-25 lac, Karachi 10-30 lac, Islamabad 15-40 lac
  const CITY_RANGES = { lahore:[800000,25000000], karachi:[1000000,30000000], islamabad:[1500000,40000000] };

  function addCity(city, val) {
    const [lo,hi] = CITY_RANGES[city] || [500000,50000000];
    if (val >= lo && val <= hi) b[city].push(val);
  }

  function extractCityPrices(html) {
    const CITY_RX = /(lahore|karachi|islamabad)[^.\n]{0,150}?([\d,]{7,10})/gi;
    let m;
    while ((m = CITY_RX.exec(html)) !== null) {
      const val = parseInt(m[2].replace(/,/g,''));
      addCity(m[1].toLowerCase(), val);
    }
  }

  const [s1,s2,s3,s4,s5,s6] = await Promise.allSettled([
    fetchSafe('https://www.zameen.com/property-index/'),
    fetchSafe('https://www.graana.com/property-insights/'),
    fetchSafe('https://www.hamariweb.com/real-estate/property-prices-in-pakistan/'),
    fetchSafe('https://www.bayut.pk/property-index/'),
    fetchSafe('https://www.propertyfinder.pk/en/blog/property-price-index-pakistan'),
    fetchSafe('https://zameendata.com/market-report/'),
  ]);

  [[s1,'zameen.com'],[s2,'graana.com'],[s3,'hamariweb'],[s4,'bayut.pk'],[s5,'propertyfinder.pk'],[s6,'zameendata.com']].forEach(([src,name]) => {
    if (src.status === 'fulfilled' && src.value) {
      const html = src.value.toString();
      extractCityPrices(html);
      const $ = cheerio.load(html);
      $('table tr').each((_,row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const text = $(row).text().toLowerCase();
        const val  = parseInt($(cells[cells.length-1]).text().replace(/[^0-9]/g,''));
        if (!val) return;
        if (text.includes('lahore'))    addCity('lahore',    val);
        if (text.includes('karachi'))   addCity('karachi',   val);
        if (text.includes('islamabad')) addCity('islamabad', val);
      });
      console.log(`  ✓ ${name}`);
    }
  });

  const result = {
    lahore:    bestRate(b.lahore,    'median', 'prop_lahore')    || MASTER_FALLBACK.prop_lahore,
    karachi:   bestRate(b.karachi,   'median', 'prop_karachi')   || MASTER_FALLBACK.prop_karachi,
    islamabad: bestRate(b.islamabad, 'median', 'prop_islamabad') || MASTER_FALLBACK.prop_islamabad,
  };
  console.log(`  ✅ Done in ${Date.now()-t}ms | Final:`, result);
  return result;
}

// ────────────────────────────────────────────────────────────────
//  RATE CHANGE REPORT
// ────────────────────────────────────────────────────────────────
function printChangeReport(newFlat, prevFlat, history) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                   📊 RATE CHANGE REPORT                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');

  const KEY_LABELS = {
    usd:'USD/PKR', gold24k:'Gold 24K', petrol:'Petrol/L', bitcoin:'Bitcoin',
    ethereum:'Ethereum', kse100:'KSE-100', diesel:'Diesel/L',
  };

  Object.entries(KEY_LABELS).forEach(([key, label]) => {
    const nw    = newFlat[key];
    const pr    = prevFlat?.[key];
    if (!nw) return;
    const delta = pr ? ((nw - pr) / pr * 100) : 0;
    const arrow = delta > 0.05 ? '▲' : delta < -0.05 ? '▼' : '─';
    const sign  = delta > 0 ? '+' : '';
    console.log(`║  ${arrow} ${label.padEnd(14)} ${String(nw).padEnd(12)} ${pr ? `(${sign}${delta.toFixed(2)}%)` : '(new)'}`);
    // Staleness check
    checkStaleness(key, history);
  });

  console.log('╚══════════════════════════════════════════════════════════╝');
}

// ────────────────────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────────────────────
async function scrapeAll() {
  const START = Date.now();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   DailyPak Scraper v4.0  |  40 Rates  |  50+ Sources    ║');
  console.log('║   IQR Filter | Weighted Median | Parallel | Smart Cache  ║');
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`\n⏰ Started at: ${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}`);

  // Load previous data & history
  const [prevRates, history] = await Promise.all([kvGet('rates'), kvGet('history')]);
  const prevFlat  = flattenRates(prevRates);
  const histStore = (history && typeof history === 'object') ? history : {};
  console.log(`💾 KV cache: ${Object.keys(prevFlat).length} rates loaded`);

  // Run ALL 8 categories in PARALLEL
  console.log('\n🚀 Launching all 8 categories in parallel...\n');
  const catStart = Date.now();
  const settled  = await Promise.allSettled([
    scrapeCurrencies(),
    scrapeMetals(),
    scrapeFuel(),
    scrapeCrypto(),
    scrapeStocks(),
    scrapeElectricity(),
    scrapeAgriculture(),
    scrapeProperty(),
  ]);
  const [currencies, metals, fuel, crypto, stocks, electricity, agriculture, property] =
    settled.map((r, i) => {
      if (r.status === 'rejected') { console.log(`  ❌ Category ${i+1} FAILED:`, r.reason?.message); return null; }
      return r.value;
    });
  console.log(`\n✅ All categories done in ${((Date.now()-catStart)/1000).toFixed(1)}s`);

  // Apply sanity check + smart fallback on every rate
  const sv = (key, raw) => smartVal(raw, key, prevFlat);

  const finalData = {
    currencies: {
      usd:sv('usd',currencies?.usd), aed:sv('aed',currencies?.aed),
      sar:sv('sar',currencies?.sar), eur:sv('eur',currencies?.eur),
      gbp:sv('gbp',currencies?.gbp), cny:sv('cny',currencies?.cny),
      try:sv('try',currencies?.try), cad:sv('cad',currencies?.cad),
      aud:sv('aud',currencies?.aud), qar:sv('qar',currencies?.qar),
    },
    metals: {
      gold24k:sv('gold24k',metals?.gold24k), gold22k:sv('gold22k',metals?.gold22k),
      goldGram:sv('goldGram',metals?.goldGram), silverTola:sv('silverTola',metals?.silverTola),
      platinum: metals?.platinum || MASTER_FALLBACK.platinum,
    },
    fuel: {
      petrol:sv('petrol',fuel?.petrol), diesel:sv('diesel',fuel?.diesel),
      kerosene:sv('kerosene',fuel?.kerosene), lightDiesel:sv('lightDiesel',fuel?.lightDiesel),
    },
    crypto: {
      bitcoin:sv('bitcoin',crypto?.bitcoin), ethereum:sv('ethereum',crypto?.ethereum),
      bnb:sv('bnb',crypto?.bnb), solana:sv('solana',crypto?.solana),
      xrp:sv('xrp',crypto?.xrp), cardano:sv('cardano',crypto?.cardano),
      dogecoin:sv('dogecoin',crypto?.dogecoin), tron:sv('tron',crypto?.tron),
    },
    stocks: {
      kse100:sv('kse100',stocks?.kse100), kse30:sv('kse30',stocks?.kse30), kmi30:sv('kmi30',stocks?.kmi30),
    },
    electricity: {
      normal:sv('elec_normal',electricity?.normal),
      peak:sv('elec_peak',electricity?.peak),
      offpeak:sv('elec_offpeak',electricity?.offpeak),
    },
    agriculture: {
      wheat:sv('wheat',agriculture?.wheat), rice:sv('rice',agriculture?.rice),
      sugar:sv('sugar',agriculture?.sugar), cotton:sv('cotton',agriculture?.cotton),
    },
    property: {
      lahore:sv('prop_lahore',property?.lahore),
      karachi:sv('prop_karachi',property?.karachi),
      islamabad:sv('prop_islamabad',property?.islamabad),
    },
    updated: new Date().toLocaleString('en-PK', {
      timeZone:'Asia/Karachi', dateStyle:'medium', timeStyle:'short',
    }),
  };

  // Build 40-key flat map and update history
  const newFlat = flattenRates(finalData);
  Object.entries(newFlat).forEach(([key,val]) => { if (val) updateHistory(histStore, key, val); });

  // Save to KV (parallel)
  const [r1,r2] = await Promise.all([kvSet('rates', finalData), kvSet('history', histStore)]);
  console.log(`💾 KV saved: rates=${r1?'✓':'❌'} history=${r2?'✓':'❌'}`);

  // Print change report
  printChangeReport(newFlat, prevFlat, histStore);

  const total = ((Date.now()-START)/1000).toFixed(1);
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ✅ COMPLETED in ${total}s                                    ║`);
  console.log(`║  Sources per category:                                   ║`);
  console.log(`║   Currencies  7 (incl. SBP official, weighted ×3)       ║`);
  console.log(`║   Metals      7 (incl. metals.live cross-calc)          ║`);
  console.log(`║   Fuel        9 (PSO+OGRA weighted ×3, text regex)      ║`);
  console.log(`║   Crypto      5 (fully parallel, 8 coins each)          ║`);
  console.log(`║   Stocks      5 (PSX official + 4 sources)              ║`);
  console.log(`║   Electricity 5 (NEPRA + 4 DISCO sources)               ║`);
  console.log(`║   Agriculture 6 (Mandi + agri portals, avg)             ║`);
  console.log(`║   Property    6 (zameen/graana/bayut + 3 more)          ║`);
  console.log(`║  Features: IQR ✓ | Weighted ✓ | Sanity ✓ | Cache ✓     ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

scrapeAll().catch(e => { console.error('\n💥 Fatal error:', e.message); process.exit(1); });
