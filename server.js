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

// Persistent storage
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
      console.log(`\n📦 Loaded from persistent storage:`);
      console.log(`   📱 Subscribers: ${telegramChatIds.size}`);
      console.log(`   🔔 Alert sets: ${userAlerts.size}`);
      console.log(`   👤 Users: ${userCredentials.size}`);
    } else {
      console.log(`📁 No existing data file, starting fresh`);
      saveData();
    }
  } catch(e) { console.error('Load error:', e.message); }
}

function saveData() {
  try {
    const payload = {
      telegramChatIds: Array.from(telegramChatIds),
      userAlerts: Object.fromEntries(userAlerts),
      userCredentials: Object.fromEntries(userCredentials),
      lastSaved: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
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

// Price fetching - WITH DEBUG LOGGING
let priceCache = new Map();
let currentBtcPrice = null;
let priceFetchAttempts = 0;
let priceFetchSuccesses = 0;

async function fetchPrice(symbol) {
  const upperSymbol = symbol.toUpperCase();
  const now = Date.now();
  
  // Check cache first
  if (priceCache.has(upperSymbol) && now - priceCache.get(upperSymbol).time < 10000) {
    console.log(`📦 Cache hit for ${upperSymbol}: $${priceCache.get(upperSymbol).price}`);
    return priceCache.get(upperSymbol).price;
  }
  
  priceFetchAttempts++;
  console.log(`🌐 Fetching ${upperSymbol} from Binance (attempt #${priceFetchAttempts})...`);
  
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}USDT`;
    console.log(`   URL: ${url}`);
    
    const res = await axios.get(url, { timeout: 5000 });
    const price = parseFloat(res.data.price);
    
    if (price && !isNaN(price) && price > 0) {
      priceFetchSuccesses++;
      priceCache.set(upperSymbol, { price, time: now });
      if (upperSymbol === 'BTC') currentBtcPrice = price;
      console.log(`✅ Fetched ${upperSymbol}: $${price} (success rate: ${priceFetchSuccesses}/${priceFetchAttempts})`);
      return price;
    } else {
      console.log(`❌ Invalid price for ${upperSymbol}: ${res.data.price}`);
      return null;
    }
  } catch(e) {
    console.error(`❌ Price fetch FAILED for ${upperSymbol}:`);
    console.error(`   Error: ${e.message}`);
    if (e.response) {
      console.error(`   Status: ${e.response.status}`);
      console.error(`   Data:`, e.response.data);
    }
    if (e.code === 'ENOTFOUND') {
      console.error(`   DNS lookup failed - possible network block`);
    }
    if (e.code === 'ECONNABORTED') {
      console.error(`   Request timeout - Binance may be blocking Railway IP`);
    }
    return null;
  }
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
  let totalAlerts = 0;
  for (const alerts of userAlerts.values()) totalAlerts += alerts.length;
  
  if (now - lastLogTime > 60000 || checkCount % 6 === 0) {
    console.log(`\n🔍 Alert check #${checkCount} at ${new Date().toLocaleTimeString()}`);
    console.log(`   Active alerts: ${totalAlerts}, Subscribers: ${telegramChatIds.size}`);
    console.log(`   Price fetch stats: ${priceFetchSuccesses}/${priceFetchAttempts} successful`);
    lastLogTime = now;
  }
  
  for (const [userId, alerts] of userAlerts.entries()) {
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) {
        continue;
      }
      
      console.log(`   Checking alert: ${alert.cryptoName} ${alert.type} target $${alert.targetPrice}`);
      
      const price = await fetchPrice(alert.cryptoName);
      if (!price) {
        console.log(`   ⚠️ Could not fetch price for ${alert.cryptoName}, skipping`);
        continue;
      }
      
      console.log(`   Current ${alert.cryptoName} price: $${price}, Target: $${alert.targetPrice}`);
      
      let shouldTrigger = false;
      let condition = '';
      
      if (alert.type === 'above' && price >= alert.targetPrice) {
        shouldTrigger = true;
        condition = `ABOVE: $${price} >= $${alert.targetPrice}`;
      }
      if (alert.type === 'below' && price <= alert.targetPrice) {
        shouldTrigger = true;
        condition = `BELOW: $${price} <= $${alert.targetPrice}`;
      }
      
      if (shouldTrigger) {
        console.log(`\n🎯 ${alert.cryptoName} ${condition}`);
        console.log(`🚨 TRIGGERING ALERT!`);
        
        const message = `🚨 *PRICE ALERT!*\n\n📊 *${alert.cryptoName}/USDT*\n💰 *Current:* $${price.toLocaleString()}\n🎯 *Target:* ${alert.type === 'above' ? '📈 ABOVE' : '📉 BELOW'} $${alert.targetPrice.toLocaleString()}\n\n🕐 ${new Date().toLocaleString()}`;
        
        const sent = await tgBroadcast(message, true);
        
        if (alert.recurring === 'always') {
          // Don't mark as triggered
        } else if (alert.recurring === 'hourly') {
          alert.triggered = true;
          saveData();
          setTimeout(() => { alert.triggered = false; saveData(); }, 3600000);
        } else if (alert.recurring === 'daily') {
          alert.triggered = true;
          saveData();
          setTimeout(() => { alert.triggered = false; saveData(); }, 86400000);
        } else {
          alert.triggered = true;
          saveData();
        }
        
        if (sent > 0) {
          console.log(`   ✅ Alert sent to ${sent} subscribers`);
        } else {
          console.log(`   ⚠️ No subscribers to send to!`);
        }
      }
    }
  }
  isChecking = false;
}

setInterval(checkAlerts, 15000); // Check every 15 seconds
console.log('✅ Price monitoring active (checking every 15 seconds)');

// ============================================================
// AUTH ROUTES
// ============================================================

app.post('/api/auth/signup', (req, res) => {
  const { email, password, username } = req.body;
  
  if (userCredentials.has(email)) {
    const userId = userCredentials.get(email);
    console.log(`📝 Existing user signed up again: ${email} (${userId})`);
    return res.json({ 
      user: { id: userId, email: email, user_metadata: { username: username || email.split('@')[0] } }, 
      session: { access_token: 'mock-token-' + userId }
    });
  }
  
  const userId = crypto.randomUUID ? crypto.randomUUID() : 'user_' + Date.now() + '_' + email.replace(/[^a-zA-Z0-9]/g, '');
  userCredentials.set(email, userId);
  saveData();
  
  console.log(`✅ New user signed up: ${email} (${userId})`);
  res.json({ 
    user: { id: userId, email: email, user_metadata: { username: username || email.split('@')[0] } }, 
    session: { access_token: 'mock-token-' + userId }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  let userId = userCredentials.get(email);
  
  if (!userId) {
    userId = crypto.randomUUID ? crypto.randomUUID() : 'user_' + Date.now() + '_' + email.replace(/[^a-zA-Z0-9]/g, '');
    userCredentials.set(email, userId);
    saveData();
    console.log(`🆕 New user from login: ${email} (${userId})`);
  } else {
    console.log(`🔐 User logged in: ${email} (${userId})`);
  }
  
  res.json({ 
    user: { id: userId, email: email, user_metadata: { username: email.split('@')[0] } }, 
    session: { access_token: 'mock-token-' + userId }
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
});

// ============================================================
// ALERT ROUTES
// ============================================================

app.get('/api/alerts/:userId', (req, res) => {
  const userId = req.params.userId;
  const alerts = userAlerts.get(userId) || [];
  console.log(`📋 Returning ${alerts.length} alerts for user ${userId}`);
  res.json(alerts);
});

app.post('/api/alerts', (req, res) => {
  const { userId, alert } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  if (!userAlerts.has(userId)) userAlerts.set(userId, []);
  
  const newAlert = {
    id: Date.now(),
    cryptoId: alert.cryptoId,
    cryptoName: alert.cryptoName,
    targetPrice: alert.targetPrice,
    type: alert.type,
    recurring: alert.recurring || 'once',
    note: alert.note || '',
    createdAt: new Date().toISOString(),
    triggered: false
  };
  userAlerts.get(userId).push(newAlert);
  saveData();
  console.log(`✅ Alert created for user ${userId}: ${newAlert.cryptoName} ${newAlert.type} $${newAlert.targetPrice}`);
  res.json(newAlert);
});

app.delete('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  if (userAlerts.has(userId)) {
    const before = userAlerts.get(userId).length;
    userAlerts.set(userId, userAlerts.get(userId).filter(a => a.id !== parseInt(alertId)));
    const after = userAlerts.get(userId).length;
    saveData();
    console.log(`🗑️ Alert deleted for user ${userId} (${before} -> ${after})`);
  }
  res.json({ success: true });
});

app.put('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  const updates = req.body;
  if (userAlerts.has(userId)) {
    const alerts = userAlerts.get(userId);
    const index = alerts.findIndex(a => a.id === parseInt(alertId));
    if (index !== -1) {
      alerts[index] = { ...alerts[index], ...updates };
      saveData();
      console.log(`✏️ Alert updated for user ${userId}`);
      res.json(alerts[index]);
    }
  }
  res.json({ success: true });
});

// ============================================================
// OTHER ROUTES
// ============================================================

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
    storagePath: DATA_DIR,
    priceFetchStats: {
      attempts: priceFetchAttempts,
      successes: priceFetchSuccesses,
      successRate: priceFetchAttempts > 0 ? (priceFetchSuccesses / priceFetchAttempts * 100).toFixed(1) : 0
    }
  });
});

app.get('/api/health', (req, res) => {
  let total = 0;
  for (const alerts of userAlerts.values()) total += alerts.length;
  res.json({ 
    status: 'healthy', 
    subscribers: telegramChatIds.size,
    alerts: total,
    users: userCredentials.size
  });
});

// Price endpoint for frontend
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const price = await fetchPrice(symbol);
  if (price) {
    res.json({ symbol, price });
  } else {
    res.status(404).json({ error: 'Could not fetch price' });
  }
});

// HTML routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'auth', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html')));
app.get('/alerts', (req, res) => res.sendFile(path.join(__dirname, 'alerts', 'alerts.html')));
app.get('/risk', (req, res) => res.sendFile(path.join(__dirname, 'risk', 'risk.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings', 'settings.html')));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  console.log(`💾 Persistent storage: ${DATA_DIR}`);
  console.log(`📱 Subscribers: ${telegramChatIds.size}`);
  console.log(`👤 Users: ${userCredentials.size}`);
  console.log(`✅ Price monitoring active (checking every 15 seconds)`);
  console.log(`\n📊 Waiting for price fetches...\n`);
  setTimeout(pollTelegram, 2000);
});
