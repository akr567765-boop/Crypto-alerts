const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Use persistent volume if available, otherwise fallback to local
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Created data directory: ${DATA_DIR}`);
}

let telegramChatIds = new Set();
let userAlerts = new Map();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      telegramChatIds = new Set(parsed.telegramChatIds || []);
      userAlerts = new Map(Object.entries(parsed.userAlerts || {}));
      console.log(`\n📦 Loaded from persistent storage:`);
      console.log(`   📱 Subscribers: ${telegramChatIds.size}`);
      console.log(`   🔔 Alert sets: ${userAlerts.size}`);
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
      lastSaved: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    console.log(`💾 Data saved to persistent storage`);
  } catch(e) { console.error('Save error:', e.message); }
}

loadData();
setInterval(saveData, 30000); // Save every 30 seconds

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

// Price fetching
let priceCache = new Map();
let currentBtcPrice = null;

async function fetchPrice(symbol) {
  const upperSymbol = symbol.toUpperCase();
  const now = Date.now();
  if (priceCache.has(upperSymbol) && now - priceCache.get(upperSymbol).time < 10000) {
    return priceCache.get(upperSymbol).price;
  }
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}USDT`, { timeout: 5000 });
    const price = parseFloat(res.data.price);
    if (price && !isNaN(price)) {
      priceCache.set(upperSymbol, { price, time: now });
      if (upperSymbol === 'BTC') currentBtcPrice = price;
      return price;
    }
  } catch(e) {}
  return null;
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
    console.log(`\n🔍 Alert check #${checkCount} at ${new Date().toLocaleTimeString()}`);
    console.log(`   Active: ${total}, Subscribers: ${telegramChatIds.size}`);
    lastLogTime = now;
  }
  
  for (const [userId, alerts] of userAlerts.entries()) {
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) {
        continue;
      }
      
      const price = await fetchPrice(alert.cryptoName);
      if (!price) continue;
      
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
        }
      }
    }
  }
  isChecking = false;
}

setInterval(checkAlerts, 10000);
console.log('✅ Price monitoring active');

// Routes
app.get('/api/alerts/:userId', (req, res) => {
  res.json(userAlerts.get(req.params.userId) || []);
});

app.post('/api/alerts', (req, res) => {
  const { userId, alert } = req.body;
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
  console.log(`✅ Alert created: ${newAlert.cryptoName} ${newAlert.type} $${newAlert.targetPrice}`);
  res.json(newAlert);
});

app.delete('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  if (userAlerts.has(userId)) {
    userAlerts.set(userId, userAlerts.get(userId).filter(a => a.id !== parseInt(alertId)));
    saveData();
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
      res.json(alerts[index]);
    }
  }
  res.json({ success: true });
});

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
    storagePath: DATA_DIR
  });
});

app.get('/api/health', (req, res) => {
  let total = 0;
  for (const alerts of userAlerts.values()) total += alerts.length;
  res.json({ 
    status: 'healthy', 
    subscribers: telegramChatIds.size,
    alerts: total,
    storage: DATA_DIR
  });
});

// Auth routes (mock)
app.post('/api/auth/signup', (req, res) => {
  res.json({ user: { id: 'user-1', email: req.body.email }, session: { access_token: 'mock' } });
});
app.post('/api/auth/login', (req, res) => {
  res.json({ user: { id: 'user-1', email: req.body.email }, session: { access_token: 'mock' } });
});
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
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
  console.log(`✅ Monitoring active\n`);
  setTimeout(pollTelegram, 2000);
});
