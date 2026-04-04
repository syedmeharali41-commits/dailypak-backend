const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeUSD() {
  try {
    const res = await axios.get('https://www.sbp.org.pk/ecodata/index2.asp', {
      timeout: 10000
    });
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
    const res = await axios.get('https://goldrates.com.pk', {
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const rate = $('.gold-24k').first().text().trim();
    return parseFloat(rate.replace(/,/g, '')) || 245000;
  } catch (e) {
    console.log('Gold scrape fail, fallback use kar raha hoon');
    return 245000;
  }
}

async function scrapePetrol() {
  try {
    const res = await axios.get('https://www.ogra.org.pk/petroleum-products', {
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const rate = $('table tr').eq(1).find('td').eq(2).text().trim();
    return parseFloat(rate) || 289;
  } catch (e) {
    console.log('Petrol scrape fail, fallback use kar raha hoon');
    return 289;
  }
}

async function scrapeCrypto() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { timeout: 10000 }
    );
    return {
      bitcoin: res.data.bitcoin.usd,
      ethereum: res.data.ethereum.usd
    };
  } catch (e) {
    console.log('Crypto scrape fail, fallback use kar raha hoon');
    return { bitcoin: 83000, ethereum: 3000 };
  }
}

async function scrapeAll() {
  console.log('Scraping shuru ho rahi hai...');

  const usd     = await scrapeUSD();
  const gold    = await scrapeGold();
  const petrol  = await scrapePetrol();
  const crypto  = await scrapeCrypto();

  const data = {
    usd:      usd,
    gold:     gold,
    petrol:   petrol,
    bitcoin:  crypto.bitcoin,
    ethereum: crypto.ethereum,
    updated:  new Date().toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  };

  console.log('Data ready:', data);

  // Cloudflare KV mein save karo
  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}/values/rates`;

  await axios.put(kvUrl, JSON.stringify(data), {
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('Cloudflare KV mein save ho gaya!');
}

scrapeAll();