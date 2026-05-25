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

// Check environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase environment variables!');
  console.error('   SUPABASE_URL:', SUPABASE_URL ? '✅ Set' : '❌ Missing');
  console.error('   SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? '✅ Set' : '❌ Missing');
  console.error('   TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Missing');
}

// Initialize Supabase only if credentials exist
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('✅ Supabase initialized');
} else {
  console.log('⚠️ Supabase not configured - auth features disabled');
}

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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
      console.log(`   🔔 Alert sets           : ${userAlerts.size}`);
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
// TELEGRAM BOT
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tgSend(chatId, text, markdown = false) {
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
      console.log(`   ↳ User ${chatId} blocked bot, removing`);
      telegramChatIds.delete(chatId);
      saveData();
    } else {
      console.error(`❌ Telegram error:`, err.response?.data?.description || err.message);
    }
    return false;
  }
}

async function tgBroadcast(text, markdown = false) {
  if (telegramChatIds.size === 0) {
    console.log('⚠️ No Telegram subscribers');
    return 0;
  }
  
  console.log(`📢 Broadcasting to ${telegramChatIds.size} subscribers...`);
  let sent = 0;
  for (const chatId of telegramChatIds) {
    const ok = await tgSend(chatId, text, markdown);
    if (ok) sent++;
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`✅ Sent to ${sent}/${telegramChatIds.size} subscribers`);
  return sent;
}

// ============================================================
// TELEGRAM POLLING
// ============================================================
let lastUpdateId = 0;
let isPolling = false;

async function pollTelegram() {
  if (!TG_BASE || isPolling) return;
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
        const text = msg.text.trim().toLowerCase();
        const name = msg.from?.first_name || msg.from?.username || 'User';

        console.log(`📩 Telegram from ${chatId}: "${msg.text}"`);

        if (text === '/start') {
          telegramChatIds.add(chatId);
          saveData();
          console.log(`✅ Subscribed ${chatId} (${name}) | Total: ${telegramChatIds.size}`);
          await tgSend(chatId, 
            `✅ *Welcome to CryptoFlow Alerts, ${name}!*\n\n` +
            `You are now subscribed to real-time price alerts.\n\n` +
            `📊 *Supported coins:* BTC, ETH, SOL, BNB, XRP, ADA, DOGE\n\n` +
            `Send /test to verify your connection.`,
            true
          );
        } else if (text === '/stop') {
          telegramChatIds.delete(chatId);
          saveData();
          await tgSend(chatId, `❌ You have been unsubscribed.\n\nSend /start to re-subscribe.`);
        } else if (text === '/status') {
          const subbed = telegramChatIds.has(chatId);
          await tgSend(chatId, subbed ? `✅ You are subscribed!` : `❌ You are not subscribed. Send /start to subscribe.`);
        } else if (text === '/test') {
          await tgSend(chatId, `🔔 *TEST ALERT*\n\n✅ Your Telegram is working perfectly!`, true);
        }
      }
    }
  } catch (err) {
    // Silent ignore for polling errors
  } finally {
    isPolling = false;
    setTimeout(pollTelegram, 3000);
  }
}

// ============================================================
// BINANCE API - PRICE FETCHING
// ============================================================
let priceCache = new Map();
let lastPriceLog = Date.now();

async function fetchBinancePrice(symbol) {
  const upperSymbol = symbol.toUpperCase();
  const now = Date.now();
  
  if (priceCache.has(upperSymbol) && now - priceCache.get(upperSymbol).timestamp < 10000) {
    return priceCache.get(upperSymbol).price;
  }
  
  try {
    const response = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}USDT`,
      { timeout: 5000 }
    );
    const price = parseFloat(response.data.price);
    
    if (price && !isNaN(price) && price > 0) {
      priceCache.set(upperSymbol, { price, timestamp: now });
      
      if (now - lastPriceLog > 60000) {
        console.log(`📊 ${upperSymbol}: $${price}`);
        lastPriceLog = now;
      }
      
      return price;
    }
  } catch (err) {
    // Silent fail - will retry next cycle
  }
  
  return null;
}

// ============================================================
// SEND ALERT NOTIFICATION
// ============================================================
async function sendAlertNotification(alert, currentPrice, userId) {
  const symbol = (alert.cryptoName || alert.cryptoId || '???').toUpperCase();
  const direction = alert.type === 'above' ? '📈 ABOVE' : '📉 BELOW';

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
// PRICE MONITORING
// ============================================================
let isCheckingAlerts = false;
let checkCount = 0;

async function checkAlerts() {
  if (isCheckingAlerts) return;
  isCheckingAlerts = true;
  checkCount++;

  if (checkCount % 6 === 0) {
    let totalAlerts = 0;
    for (const alerts of userAlerts.values()) {
      totalAlerts += alerts.length;
    }
    console.log(`\n🔍 Checking alerts... (${new Date().toLocaleTimeString()})`);
    console.log(`   Active alerts: ${totalAlerts}, Subscribers: ${telegramChatIds.size}`);
  }

  for (const [userId, alerts] of userAlerts.entries()) {
    for (const alert of alerts) {
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) {
        continue;
      }

      const symbol = (alert.cryptoName || alert.cryptoId || '').toUpperCase().trim();
      if (!symbol) continue;

      const currentPrice = await fetchBinancePrice(symbol);
      
      if (currentPrice) {
        let shouldTrigger = false;
        
        if (alert.type === 'above' && currentPrice >= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`🎯 ${symbol} ABOVE TRIGGER! $${currentPrice} >= $${alert.targetPrice}`);
        }
        if (alert.type === 'below' && currentPrice <= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`🎯 ${symbol} BELOW TRIGGER! $${currentPrice} <= $${alert.targetPrice}`);
        }

        if (shouldTrigger) {
          if (alert.recurring === 'once' || !alert.recurring) {
            alert.triggered = true;
            alert.triggeredPrice = currentPrice;
            alert.triggeredAt = new Date().toISOString();
            saveData();
            console.log(`   ✅ ONE-TIME ALERT TRIGGERED for ${symbol}!`);
          } else {
            console.log(`   🔄 RECURRING ALERT TRIGGERED for ${symbol}!`);
          }
          
          await sendAlertNotification(alert, currentPrice, userId);

          if (alert.recurring === 'always') {
            alert.triggered = false;
            saveData();
          } else if (alert.recurring === 'hourly') {
            setTimeout(() => {
              alert.triggered = false;
              saveData();
              console.log(`   🔄 Hourly alert reset: ${symbol}`);
            }, 3600000);
          } else if (alert.recurring === 'daily') {
            setTimeout(() => {
              alert.triggered = false;
              saveData();
              console.log(`   🔄 Daily alert reset: ${symbol}`);
            }, 86400000);
          }
        }
      }
    }
  }

  isCheckingAlerts = false;
}

setInterval(checkAlerts, 10000);
console.log('✅ Price monitoring active (checking every 10 seconds)');

// ============================================================
// API ROUTES
// ============================================================

// Auth routes (only if Supabase is configured)
if (supabase) {
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
} else {
  // Mock auth routes for testing
  app.post('/api/auth/signup', (req, res) => {
    res.json({ user: { id: 'test-user', email: req.body.email }, session: { access_token: 'mock-token' } });
  });
  app.post('/api/auth/login', (req, res) => {
    res.json({ user: { id: 'test-user', email: req.body.email }, session: { access_token: 'mock-token' } });
  });
  app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true });
  });
}

// Alert CRUD
app.get('/api/alerts/:userId', (req, res) => {
  res.json(userAlerts.get(req.params.userId) || []);
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

// Notification routes
app.get('/api/notifications/stats', (req, res) => {
  res.json({ telegram: { active: telegramChatIds.size } });
});

app.post('/api/notifications/test', async (req, res) => {
  console.log(`\n🧪 TEST ALERT to ${telegramChatIds.size} subscribers`);
  const message = `🔔 *TEST ALERT — CryptoFlow*\n\n✅ Your Telegram notifications are working perfectly!`;
  const sent = await tgBroadcast(message, true);
  res.json({ success: true, telegram: sent, subscribers: telegramChatIds.size });
});

app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const price = await fetchBinancePrice(symbol);
  if (price) {
    res.json({ symbol, price });
  } else {
    res.status(404).json({ error: 'Symbol not found' });
  }
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    botTokenConfigured: !!BOT_TOKEN,
    subscriberCount: telegramChatIds.size,
    subscriberIds: Array.from(telegramChatIds),
    totalAlertSets: userAlerts.size
  });
});

app.post('/api/debug/check-now', async (req, res) => {
  console.log('\n🔧 Manual alert check triggered...');
  await checkAlerts();
  res.json({ success: true });
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
    supabase: !!supabase
  });
});

// ============================================================
// WEBSOCKET
// ============================================================
io.on('connection', (socket) => {
  console.log(`🔌 WebSocket client connected: ${socket.id}`);
  
  socket.on('subscribeAlerts', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`📡 Client subscribed to alerts for user ${userId}`);
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 WebSocket disconnected: ${socket.id}`);
  });
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CryptoFlow server running on http://localhost:${PORT}`);
  console.log(`🤖 Telegram Bot  : ${BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`📱 TG Subscribers: ${telegramChatIds.size}`);
  console.log(`🔔 Alert sets    : ${userAlerts.size}`);
  console.log(`✅ Price monitoring active (checking every 10 seconds)`);
  
  setTimeout(() => {
    console.log('🤖 Starting Telegram polling...');
    pollTelegram();
  }, 2000);
  
  console.log(`\n💡 Commands for Telegram bot:`);
  console.log(`   /start  - Subscribe to alerts`);
  console.log(`   /stop   - Unsubscribe`);
  console.log(`   /status - Check subscription`);
  console.log(`   /test   - Send test alert`);
});
