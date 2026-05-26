const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Created data directory: ${DATA_DIR}`);
}

let telegramChatIds = new Set();
let userAlerts = new Map();
let userCredentials = new Map();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      telegramChatIds = new Set(parsed.telegramChatIds || []);
      userAlerts = new Map(Object.entries(parsed.userAlerts || {}));
      userCredentials = new Map(Object.entries(parsed.userCredentials || {}));
      console.log(`📦 Loaded: ${telegramChatIds.size} subscribers, ${userAlerts.size} alert sets, ${userCredentials.size} users`);
    } else {
      console.log(`📁 No existing data file, starting fresh`);
      saveData();
    }
  } catch(e) { console.error('Load error:', e.message); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      telegramChatIds: Array.from(telegramChatIds),
      userAlerts: Object.fromEntries(userAlerts),
      userCredentials: Object.fromEntries(userCredentials),
      lastSaved: new Date().toISOString()
    }, null, 2));
    console.log(`💾 Data saved`);
  } catch(e) { console.error('Save error:', e.message); }
}

loadData();
setInterval(saveData, 30000);

// Telegram
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tgSend(chatId, text, markdown = false) {
  if (!TG_BASE) return false;
  try {
    const body = { chat_id: chatId, text };
    if (markdown) body.parse_mode = 'Markdown';
    const res = await axios.post(`${TG_BASE}/sendMessage`, body, { timeout: 15000 });
    if (res.data.ok) {
      console.log(`✅ Sent to ${chatId}`);
      return true;
    }
  } catch(e) {
    if (e.response?.data?.error_code === 403) {
      telegramChatIds.delete(chatId);
      saveData();
    }
  }
  return false;
}

async function tgBroadcast(text, markdown = false) {
  if (telegramChatIds.size === 0) return 0;
  let sent = 0;
  for (const chatId of telegramChatIds) {
    if (await tgSend(chatId, text, markdown)) sent++;
    await new Promise(r => setTimeout(r, 100));
  }
  return sent;
}

// Telegram polling
let lastUpdateId = 0;
let isPolling = false;

async function pollTelegram() {
  if (!TG_BASE || isPolling) return;
  isPolling = true;
  try {
    const res = await axios.get(`${TG_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, { timeout: 35000 });
    if (res.data.ok && res.data.result) {
      for (const update of res.data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text || !msg?.chat?.id) continue;
        const chatId = msg.chat.id;
        const text = msg.text.trim().toLowerCase();
        const name = msg.from?.first_name || 'User';
        console.log(`📩 TG from ${chatId}: "${msg.text}"`);

        if (text === '/start') {
          telegramChatIds.add(chatId);
          saveData();
          await tgSend(chatId, `✅ *Welcome ${name}!*\n\nYou are subscribed to CryptoFlow alerts.\n\nSend /test to verify.`, true);
        } else if (text === '/stop') {
          telegramChatIds.delete(chatId);
          saveData();
          await tgSend(chatId, `❌ Unsubscribed. Send /start to resubscribe.`);
        } else if (text === '/status') {
          await tgSend(chatId, telegramChatIds.has(chatId) ? `✅ Subscribed!` : `❌ Not subscribed.`);
        } else if (text === '/test') {
          await tgSend(chatId, `🔔 *TEST ALERT*\n\n✅ Your Telegram is working!`, true);
        }
      }
    }
  } catch(e) {}
  isPolling = false;
  setTimeout(pollTelegram, 3000);
}

// ============================================================
// PRICE FETCHING - ONLY Kraken and CoinGecko (NO BINANCE)
// ============================================================
let priceCache = new Map();
let currentBtcPrice = null;

const COIN_MAP = {
  'BTC':  { kraken: 'XBTUSD',   coingecko: 'bitcoin' },
  'ETH':  { kraken: 'ETHUSD',   coingecko: 'ethereum' },
  'SOL':  { kraken: 'SOLUSD',   coingecko: 'solana' },
  'XRP':  { kraken: 'XRPUSD',   coingecko: 'ripple' },
  'BNB':  { kraken: null,        coingecko: 'binancecoin' },
  'ADA':  { kraken: 'ADAUSD',   coingecko: 'cardano' },
  'DOGE': { kraken: 'XDGUSD',   coingecko: 'dogecoin' },
  'AVAX': { kraken: 'AVAXUSD',  coingecko: 'avalanche-2' },
  'DOT':  { kraken: 'DOTUSD',   coingecko: 'polkadot' },
  'MATIC':{ kraken: 'MATICUSD', coingecko: 'matic-network' },
  'LINK': { kraken: 'LINKUSD',  coingecko: 'chainlink' },
  'UNI':  { kraken: 'UNIUSD',   coingecko: 'uniswap' },
  'ATOM': { kraken: 'ATOMUSD',  coingecko: 'cosmos' },
  'LTC':  { kraken: 'LTCUSD',   coingecko: 'litecoin' },
  'EUR':  { kraken: null,        coingecko: null },
};

async function fetchFromKraken(symbol) {
  const mapping = COIN_MAP[symbol];
  if (!mapping?.kraken) return null;
  try {
    const res = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${mapping.kraken}`, { timeout: 8000 });
    if (res.data.error?.length) return null;
    const pairData = Object.values(res.data.result)[0];
    const price = parseFloat(pairData.c[0]);
    if (price && !isNaN(price) && price > 0) {
      console.log(`💲 Kraken ${symbol}: $${price}`);
      return price;
    }
  } catch(e) {
    console.log(`⚠️ Kraken failed for ${symbol}: ${e.message}`);
  }
  return null;
}

async function fetchFromCoinGecko(symbol) {
  const mapping = COIN_MAP[symbol];
  const coinId = mapping?.coingecko || symbol.toLowerCase();
  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, { timeout: 10000 });
    const price = res.data[coinId]?.usd;
    if (price && !isNaN(price) && price > 0) {
      console.log(`💲 CoinGecko ${symbol}: $${price}`);
      return price;
    }
  } catch(e) {
    console.log(`⚠️ CoinGecko failed for ${symbol}: ${e.message}`);
  }
  return null;
}

async function fetchEurUsdt() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=eur', { timeout: 10000 });
    const usdtInEur = res.data?.tether?.eur;
    if (usdtInEur && usdtInEur > 0) {
      const price = parseFloat((1 / usdtInEur).toFixed(6));
      console.log(`💲 EUR/USDT (inverted): $${price}`);
      return price;
    }
  } catch(e) {
    console.log(`⚠️ EUR fetch failed: ${e.message}`);
  }
  return null;
}

async function fetchPrice(symbol) {
  const upperSymbol = symbol.toUpperCase();
  const now = Date.now();

  if (priceCache.has(upperSymbol) && now - priceCache.get(upperSymbol).time < 15000) {
    return priceCache.get(upperSymbol).price;
  }

  console.log(`🌐 Fetching ${upperSymbol} price...`);

  let price;
  if (upperSymbol === 'EUR') {
    price = await fetchEurUsdt();
  } else {
    price = await fetchFromKraken(upperSymbol) || await fetchFromCoinGecko(upperSymbol);
  }

  if (price) {
    priceCache.set(upperSymbol, { price, time: now });
    if (upperSymbol === 'BTC') currentBtcPrice = price;
    console.log(`✅ ${upperSymbol}: $${price}`);
  } else {
    console.error(`❌ Could not fetch price for ${upperSymbol} from any source`);
  }
  return price || null;
}

// Alert checking
let isChecking = false;
let checkCount = 0;
let lastLogTime = Date.now();

async function checkAlerts() {
  if (isChecking) return;
  isChecking = true;
  checkCount++;

  const now = Date.now();
  if (now - lastLogTime > 60000) {
    let total = 0;
    for (const alerts of userAlerts.values()) total += alerts.length;
    console.log(`\n🔍 Check #${checkCount} — Active: ${total}, Subscribers: ${telegramChatIds.size}`);
    lastLogTime = now;
  }

  for (const [userId, alerts] of userAlerts.entries()) {
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) continue;

      const price = await fetchPrice(alert.cryptoName);
      if (!price) continue;

      let shouldTrigger = false;
      if (alert.type === 'above' && price >= alert.targetPrice) shouldTrigger = true;
      if (alert.type === 'below' && price <= alert.targetPrice) shouldTrigger = true;

      if (shouldTrigger) {
        console.log(`\n🎯 TRIGGERED: ${alert.cryptoName} ${alert.type} target:$${alert.targetPrice} (current: $${price})`);

        const message = `🚨 *PRICE ALERT!*\n\n📊 *${alert.cryptoName}/USDT*\n💰 *Current:* $${price.toLocaleString()}\n🎯 *Target:* ${alert.type === 'above' ? '📈 ABOVE' : '📉 BELOW'} $${alert.targetPrice.toLocaleString()}\n\n🕐 ${new Date().toLocaleString()}\n\n_CryptoFlow Alerts_`;

        const sent = await tgBroadcast(message, true);
        if (sent > 0) console.log(`   ✅ Alert sent to ${sent} subscriber(s)`);

        if (alert.recurring === 'always') {
          // never mark triggered
        } else if (alert.recurring === 'hourly') {
          alert.triggered = true; saveData();
          setTimeout(() => { alert.triggered = false; saveData(); console.log(`🔄 Hourly reset for ${alert.cryptoName}`); }, 3600000);
        } else if (alert.recurring === 'daily') {
          alert.triggered = true; saveData();
          setTimeout(() => { alert.triggered = false; saveData(); console.log(`🔄 Daily reset for ${alert.cryptoName}`); }, 86400000);
        } else {
          alert.triggered = true; saveData();
        }
      }
    }
  }
  isChecking = false;
}

setInterval(checkAlerts, 10000);
console.log('✅ Price monitoring active (Kraken + CoinGecko only - NO BINANCE)');

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/alerts/:userId', (req, res) => {
  const alerts = userAlerts.get(req.params.userId) || [];
  console.log(`📋 Returning ${alerts.length} alerts for user ${req.params.userId}`);
  res.json(alerts);
});

app.post('/api/alerts', (req, res) => {
  const { userId, alert } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!userAlerts.has(userId)) userAlerts.set(userId, []);

  const newAlert = {
    id: Date.now(),
    cryptoId: alert.cryptoId,
    cryptoName: alert.cryptoName.toUpperCase(),
    targetPrice: alert.targetPrice,
    type: alert.type,
    recurring: alert.recurring || 'once',
    note: alert.note || '',
    createdAt: new Date().toISOString(),
    triggered: false
  };
  userAlerts.get(userId).push(newAlert);
  saveData();
  console.log(`✅ Alert created: ${newAlert.cryptoName} ${newAlert.type} $${newAlert.targetPrice}`);
  res.json(newAlert);
});

app.delete('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  if (userAlerts.has(userId)) {
    userAlerts.set(userId, userAlerts.get(userId).filter(a => a.id !== parseInt(alertId)));
    saveData();
    console.log(`🗑️ Alert ${alertId} deleted`);
  }
  res.json({ success: true });
});

app.put('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  if (userAlerts.has(userId)) {
    const alerts = userAlerts.get(userId);
    const index = alerts.findIndex(a => a.id === parseInt(alertId));
    if (index !== -1) {
      alerts[index] = { ...alerts[index], ...req.body };
      saveData();
      console.log(`✏️ Alert ${alertId} updated`);
      return res.json(alerts[index]);
    }
  }
  res.json({ success: true });
});

app.post('/api/auth/signup', (req, res) => {
  const { email, username } = req.body;
  if (userCredentials.has(email)) {
    const userId = userCredentials.get(email);
    return res.json({
      user: { id: userId, email, user_metadata: { username: username || email.split('@')[0] } },
      session: { access_token: 'mock-' + userId }
    });
  }
  const userId = crypto.randomUUID();
  userCredentials.set(email, userId);
  saveData();
  console.log(`📝 New user: ${email} (${userId})`);
  res.json({
    user: { id: userId, email, user_metadata: { username: username || email.split('@')[0] } },
    session: { access_token: 'mock-' + userId }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email } = req.body;
  let userId = userCredentials.get(email);
  if (!userId) {
    userId = crypto.randomUUID();
    userCredentials.set(email, userId);
    saveData();
    console.log(`🆕 New user from login: ${email} (${userId})`);
  } else {
    console.log(`🔐 Login: ${email} (${userId})`);
  }
  res.json({
    user: { id: userId, email, user_metadata: { username: email.split('@')[0] } },
    session: { access_token: 'mock-' + userId }
  });
});

app.post('/api/auth/logout', (req, res) => res.json({ success: true }));

app.get('/api/notifications/stats', (req, res) => {
  res.json({ telegram: { active: telegramChatIds.size } });
});

app.post('/api/notifications/test', async (req, res) => {
  console.log(`🧪 Test alert to ${telegramChatIds.size} subscribers`);
  const sent = await tgBroadcast(`🔔 *TEST ALERT*\n\n✅ Your Telegram is working!\n\nBTC: $${currentBtcPrice || 'loading...'}`, true);
  res.json({ success: true, telegram: sent });
});

app.get('/api/telegram/status', (req, res) => {
  let total = 0;
  for (const alerts of userAlerts.values()) total += alerts.length;
  res.json({
    configured: !!BOT_TOKEN,
    subscribers: telegramChatIds.size,
    alerts: total,
    users: userCredentials.size,
    currentBTC: currentBtcPrice
  });
});

app.get('/api/health', (req, res) => {
  let total = 0;
  for (const alerts of userAlerts.values()) total += alerts.length;
  res.json({
    status: 'healthy',
    subscribers: telegramChatIds.size,
    alerts: total,
    btcPrice: currentBtcPrice
  });
});

app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const price = await fetchPrice(symbol);
  if (price) {
    res.json({ symbol, price });
  } else {
    res.status(404).json({ error: 'Could not fetch price' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'auth', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html')));
app.get('/alerts', (req, res) => res.sendFile(path.join(__dirname, 'alerts', 'alerts.html')));
app.get('/risk', (req, res) => res.sendFile(path.join(__dirname, 'risk', 'risk.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings', 'settings.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  console.log(`💾 Storage: ${DATA_DIR}`);
  console.log(`📱 Subscribers: ${telegramChatIds.size}`);
  console.log(`✅ Monitoring active (Kraken + CoinGecko - NO BINANCE)\n`);
  setTimeout(pollTelegram, 2000);
});
