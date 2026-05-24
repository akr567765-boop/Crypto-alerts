const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Simple rate limiting
const rateLimit = new Map();
function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 100;
  
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  const record = rateLimit.get(ip);
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
    return next();
  }
  
  if (record.count >= max) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  record.count++;
  next();
}

app.use(cors());
app.use(express.json());
app.use(express.static('.'));
app.use('/api/', simpleRateLimit);

// ============================================================
// PERSISTENT STORAGE
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

let telegramChatIds = new Set();
let userAlerts = new Map();
let alertHistory = [];

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      telegramChatIds = new Set(parsed.telegramChatIds || []);
      userAlerts = new Map(Object.entries(parsed.userAlerts || {}));
      alertHistory = parsed.alertHistory || [];
      console.log(`\n📦 Loaded from disk:`);
      console.log(`   📱 Telegram subscribers : ${telegramChatIds.size}`);
      console.log(`   🔔 Alert sets           : ${userAlerts.size}\n`);
    } else {
      saveData();
      console.log(`📁 Created new data.json file`);
    }
  } catch (e) {
    console.error('⚠️ Could not load data.json:', e.message);
  }
}

function saveData() {
  try {
    const payload = {
      telegramChatIds: Array.from(telegramChatIds),
      userAlerts: Object.fromEntries(userAlerts),
      alertHistory: alertHistory.slice(-1000)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('⚠️ Could not save data.json:', e.message);
  }
}

loadData();
setInterval(saveData, 60000);

// ============================================================
// TELEGRAM HELPERS
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tgSend(chatId, text, markdown = false, retryCount = 0) {
  if (!TG_BASE) return false;
  
  try {
    const body = { chat_id: chatId, text };
    if (markdown) body.parse_mode = 'Markdown';
    const res = await axios.post(`${TG_BASE}/sendMessage`, body, { timeout: 15000 });
    
    if (res.data.ok) {
      console.log(`✅ Telegram sent to ${chatId}`);
      return true;
    }
    return false;
  } catch (err) {
    if (err.response?.data?.error_code === 403) {
      telegramChatIds.delete(chatId);
      saveData();
      return false;
    }
    
    if (retryCount < 3) {
      await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 2000));
      return tgSend(chatId, text, markdown, retryCount + 1);
    }
    return false;
  }
}

async function tgBroadcast(text, markdown = false) {
  if (telegramChatIds.size === 0) return 0;
  
  let sent = 0;
  for (const chatId of telegramChatIds) {
    const ok = await tgSend(chatId, text, markdown);
    if (ok) sent++;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return sent;
}

// ============================================================
// TELEGRAM POLLING
// ============================================================
let lastUpdateId = 0;
let isPolling = false;

async function pollTelegram() {
  if (!TG_BASE) return;
  if (isPolling) return;
  isPolling = true;

  try {
    const url = `${TG_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const res = await axios.get(url, { timeout: 35000 });

    if (res.data.ok && res.data.result) {
      for (const update of res.data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text || !msg?.chat?.id) continue;

        const chatId = msg.chat.id;
        const text = (msg.text || '').trim().toLowerCase();
        const name = msg.from?.first_name || msg.from?.username || 'there';

        console.log(`📩 Telegram from ${chatId}: "${msg.text}"`);

        if (text === '/start') {
          telegramChatIds.add(chatId);
          saveData();
          console.log(`✅ Subscribed: ${chatId} | Total: ${telegramChatIds.size}`);
          await tgSend(chatId,
            `✅ *Welcome to CryptoFlow Alerts, ${name}!*\n\n` +
            `You are now subscribed to real-time price alerts.\n\n` +
            `*Commands:*\n` +
            `/start — Subscribe\n` +
            `/stop — Unsubscribe\n` +
            `/status — Check subscription\n` +
            `/test — Send a test alert`,
            true
          );
        } else if (text === '/stop') {
          telegramChatIds.delete(chatId);
          saveData();
          await tgSend(chatId, `❌ You have been unsubscribed.`);
        } else if (text === '/status') {
          const subbed = telegramChatIds.has(chatId);
          await tgSend(chatId, subbed ? `✅ You ARE subscribed!` : `❌ You are NOT subscribed.`);
        } else if (text === '/test') {
          await tgSend(chatId, `🔔 *TEST ALERT — CryptoFlow*\n\n✅ Working!`, true);
        }
      }
    }
  } catch (err) {
    // Silent
  } finally {
    isPolling = false;
    setTimeout(pollTelegram, 3000);
  }
}

// ============================================================
// SEND ALERT NOTIFICATION
// ============================================================
async function sendAlertNotification(alert, currentPrice, userId) {
  const symbol = (alert.cryptoName || alert.cryptoId || '???').toUpperCase();
  const direction = alert.type === 'above' ? '📈 ABOVE ↑' : '📉 BELOW ↓';

  console.log(`\n🔔 ========================================`);
  console.log(`🔔 ALERT TRIGGERED!`);
  console.log(`🔔 ${symbol} at $${currentPrice} (Target: $${alert.targetPrice})`);
  console.log(`🔔 Subscribers: ${telegramChatIds.size}`);
  console.log(`========================================\n`);

  const message =
    `🚨 *PRICE ALERT TRIGGERED!*\n\n` +
    `📊 *Coin:* ${symbol}/USDT\n` +
    `💰 *Current Price:* $${currentPrice.toLocaleString()}\n` +
    `🎯 *Target:* ${direction} $${alert.targetPrice.toLocaleString()}\n` +
    (alert.note ? `📝 *Note:* ${alert.note}\n` : '') +
    `\n🕐 ${new Date().toLocaleString()}\n` +
    `\n_CryptoFlow Alerts_`;

  const tgSent = await tgBroadcast(message, true);
  console.log(`📤 Sent to ${tgSent} subscribers\n`);

  alertHistory.unshift({
    id: Date.now(),
    symbol,
    price: currentPrice,
    targetPrice: alert.targetPrice,
    type: alert.type,
    triggeredAt: new Date().toISOString(),
    userId,
    telegramSent: tgSent
  });
  
  if (alertHistory.length > 1000) alertHistory.pop();
  saveData();

  io.emit(`alertTriggered_${userId}`, { ...alert, currentPrice });
}

// ============================================================
// PRICE MONITORING - FIXED VERSION
// ============================================================
let isCheckingAlerts = false;
let lastCheckLog = Date.now();

async function checkAlerts() {
  if (isCheckingAlerts) return;
  isCheckingAlerts = true;

  // Log every minute that we're checking
  const now = Date.now();
  if (now - lastCheckLog > 60000) {
    console.log(`\n🔍 Checking alerts... (${new Date().toLocaleTimeString()})`);
    let totalAlerts = 0;
    for (const alerts of userAlerts.values()) {
      totalAlerts += alerts.length;
    }
    console.log(`   Active alerts: ${totalAlerts}, Subscribers: ${telegramChatIds.size}`);
    lastCheckLog = now;
  }

  for (const [userId, alerts] of userAlerts.entries()) {
    for (const alert of alerts) {
      // Skip triggered one-time alerts
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) {
        continue;
      }

      const symbol = (alert.cryptoName || alert.cryptoId || '').toUpperCase().trim();
      if (!symbol) continue;

      try {
        const response = await axios.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
          { timeout: 5000 }
        );
        const currentPrice = parseFloat(response.data.price);
        
        let shouldTrigger = false;
        let condition = '';
        
        if (alert.type === 'above' && currentPrice >= alert.targetPrice) {
          shouldTrigger = true;
          condition = `ABOVE: $${currentPrice} >= $${alert.targetPrice}`;
        }
        if (alert.type === 'below' && currentPrice <= alert.targetPrice) {
          shouldTrigger = true;
          condition = `BELOW: $${currentPrice} <= $${alert.targetPrice}`;
        }

        if (shouldTrigger) {
          console.log(`\n🎯 ${symbol} TRIGGERED! ${condition}`);
          
          if (alert.recurring === 'once' || !alert.recurring) {
            alert.triggered = true;
            alert.triggeredPrice = currentPrice;
            alert.triggeredAt = new Date().toISOString();
            saveData();
          }
          
          await sendAlertNotification(alert, currentPrice, userId);

          if (alert.recurring === 'always') {
            alert.triggered = false;
            saveData();
          } else if (alert.recurring === 'hourly') {
            setTimeout(() => {
              alert.triggered = false;
              saveData();
              console.log(`   🔄 Hourly reset: ${symbol}`);
            }, 3600000);
          } else if (alert.recurring === 'daily') {
            setTimeout(() => {
              alert.triggered = false;
              saveData();
              console.log(`   🔄 Daily reset: ${symbol}`);
            }, 86400000);
          }
        }
      } catch (err) {
        // Silent fail
      }
    }
  }

  isCheckingAlerts = false;
}

// Start price monitoring - check every 10 seconds
setInterval(checkAlerts, 10000);
console.log('✅ Price monitoring started (checking every 10 seconds)');

// ============================================================
// PRICE API FOR FRONTEND
// ============================================================
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, { timeout: 5000 });
    res.json({ symbol, price: parseFloat(response.data.price) });
  } catch (err) {
    res.status(404).json({ error: 'Symbol not found' });
  }
});

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, username } = req.body;
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { username: username || email.split('@')[0] } }
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.post('/api/auth/logout', async (req, res) => {
  const { error } = await supabase.auth.signOut();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ============================================================
// ALERT ROUTES
// ============================================================
app.get('/api/alerts/:userId', (req, res) => {
  const alerts = userAlerts.get(req.params.userId) || [];
  res.json(alerts);
});

app.post('/api/alerts', (req, res) => {
  const { userId, alert } = req.body;
  if (!userAlerts.has(userId)) userAlerts.set(userId, []);
  const newAlert = {
    id: Date.now(),
    ...alert,
    notificationChannels: ['telegram'],
    createdAt: new Date().toISOString(),
    triggered: false
  };
  userAlerts.get(userId).push(newAlert);
  saveData();
  console.log(`✅ Alert created: ${newAlert.cryptoName} ${newAlert.type} $${newAlert.targetPrice}`);
  res.json(newAlert);
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
    } else {
      res.status(404).json({ error: 'Alert not found' });
    }
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.delete('/api/alerts/:userId/:alertId', (req, res) => {
  const { userId, alertId } = req.params;
  if (userAlerts.has(userId)) {
    userAlerts.set(userId, userAlerts.get(userId).filter(a => a.id !== parseInt(alertId)));
    saveData();
  }
  res.json({ success: true });
});

// ============================================================
// NOTIFICATION ROUTES
// ============================================================
app.get('/api/notifications/stats', (req, res) => {
  res.json({ telegram: { active: telegramChatIds.size } });
});

app.post('/api/notifications/test', async (req, res) => {
  const { coin = 'BTC', targetPrice = 100000, currentPrice = 105000, direction = 'above' } = req.body;

  console.log(`\n🧪 TEST ALERT to ${telegramChatIds.size} subscribers`);
  
  const message = `🔔 *TEST ALERT — CryptoFlow*\n\n📊 *Coin:* ${coin}\n💰 *Price:* $${Number(currentPrice).toLocaleString()}\n🎯 *Target:* ${direction === 'above' ? '↑ Above' : '↓ Below'} $${Number(targetPrice).toLocaleString()}\n\n✅ Notifications are working!`;

  const sent = await tgBroadcast(message, true);
  res.json({ success: true, telegram: sent, subscribers: telegramChatIds.size });
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    botTokenConfigured: !!BOT_TOKEN,
    subscribers: Array.from(telegramChatIds),
    subscriberCount: telegramChatIds.size,
    totalAlertSets: userAlerts.size
  });
});

app.post('/api/debug/check-now', async (req, res) => {
  console.log('\n🔧 Manual alert check triggered...');
  await checkAlerts();
  res.json({ success: true, message: 'Alert check completed' });
});

app.get('/api/debug/alerts', (req, res) => {
  const allAlerts = [];
  for (const [userId, alerts] of userAlerts.entries()) {
    allAlerts.push({ userId, alerts });
  }
  res.json(allAlerts);
});

app.get('/api/health', (req, res) => {
  let totalAlerts = 0;
  for (const alerts of userAlerts.values()) {
    totalAlerts += alerts.length;
  }
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    telegram: !!BOT_TOKEN,
    subscribers: telegramChatIds.size,
    alerts: totalAlerts,
    monitoring: 'active (every 10s)'
  });
});

// ============================================================
// WEBSOCKET
// ============================================================
io.on('connection', (socket) => {
  console.log(`🔌 WebSocket client connected`);
  socket.on('disconnect', () => console.log(`🔌 WebSocket disconnected`));
});

// ============================================================
// HTML ROUTES
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'auth', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html')));
app.get('/alerts', (req, res) => res.sendFile(path.join(__dirname, 'alerts', 'alerts.html')));
app.get('/risk', (req, res) => res.sendFile(path.join(__dirname, 'risk', 'risk.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings', 'settings.html')));

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 CryptoFlow server running on port ${PORT}`);
  console.log(`🤖 Telegram Bot  : ${BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`📱 TG Subscribers: ${telegramChatIds.size}`);
  console.log(`🔔 Alert sets    : ${userAlerts.size}`);
  console.log(`✅ Price monitoring active (checking every 10 seconds)`);
  
  setTimeout(() => {
    console.log('🤖 Starting Telegram polling...');
    pollTelegram();
  }, 2000);
  
  console.log(`\n💡 Send /start to @cryptoflow_flowbot on Telegram to subscribe!\n`);
});
