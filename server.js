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
  process.env.SUPABASE_URL || 'https://dohiidezhkjcllualhta.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvaGlpZGV6aGtqY2xsdWFsaHRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNDczODQsImV4cCI6MjA5NDgyMzM4NH0.EVEhHIzJ1fCNaxlXu-ypm51SnELftLkNPS1ipBzLF_E'
);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ============================================================
// PERSISTENT STORAGE
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

// Initialize data structure
let telegramChatIds = new Set();
let emailSubscribers = new Set();
let userAlerts = new Map();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      telegramChatIds = new Set(parsed.telegramChatIds || []);
      emailSubscribers = new Set(parsed.emailSubscribers || []);
      userAlerts = new Map(Object.entries(parsed.userAlerts || {}));
      console.log(`\n📦 Loaded from disk:`);
      console.log(`   📱 Telegram subscribers : ${telegramChatIds.size}`);
      console.log(`   📧 Email subscribers    : ${emailSubscribers.size}`);
      console.log(`   🔔 Alert sets           : ${userAlerts.size}\n`);
    } else {
      // Create empty data file
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
      emailSubscribers: Array.from(emailSubscribers),
      userAlerts: Object.fromEntries(userAlerts)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('⚠️ Could not save data.json:', e.message);
  }
}

// Load existing data
loadData();

// Auto-save every minute
setInterval(saveData, 60000);

// ============================================================
// TELEGRAM HELPERS
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tgSend(chatId, text, markdown = false) {
  if (!TG_BASE) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env — cannot send message');
    return false;
  }
  try {
    const body = { chat_id: chatId, text };
    if (markdown) body.parse_mode = 'Markdown';
    const res = await axios.post(`${TG_BASE}/sendMessage`, body, { timeout: 10000 });
    if (res.data.ok) {
      console.log(`✅ Telegram → chatId ${chatId} — OK`);
      return true;
    } else {
      console.error(`❌ Telegram API error → chatId ${chatId}:`, res.data);
      return false;
    }
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`❌ Telegram send FAILED → chatId ${chatId}:`, detail);
    if (err.response?.data?.error_code === 403) {
      console.log(`   ↳ User ${chatId} blocked the bot — removing from subscribers`);
      telegramChatIds.delete(chatId);
      saveData();
    }
    return false;
  }
}

async function tgBroadcast(text, markdown = false) {
  if (telegramChatIds.size === 0) {
    console.warn('⚠️ No Telegram subscribers. Send /start to @Crypto0_flowbot first!');
    return 0;
  }
  let sent = 0;
  for (const chatId of telegramChatIds) {
    const ok = await tgSend(chatId, text, markdown);
    if (ok) sent++;
  }
  console.log(`📢 Broadcast sent to ${sent}/${telegramChatIds.size} subscribers`);
  return sent;
}

// ============================================================
// TELEGRAM LONG POLLING
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
          console.log(`✅ Subscribed: ${chatId} (${name}) | Total: ${telegramChatIds.size}`);
          await tgSend(chatId,
            `✅ *Welcome to CryptoFlow Alerts, ${name}!*\n\n` +
            `You are now subscribed to real-time price alerts. 🎯\n\n` +
            `*Commands:*\n` +
            `/start — Subscribe\n` +
            `/stop — Unsubscribe\n` +
            `/status — Check subscription\n` +
            `/test — Send a test alert\n\n` +
            `You'll get a message when price targets are hit! 🚀`,
            true
          );
        } else if (text === '/stop') {
          telegramChatIds.delete(chatId);
          saveData();
          console.log(`❌ Unsubscribed: ${chatId}`);
          await tgSend(chatId, `❌ You have been unsubscribed.\n\nSend /start to re-subscribe.`);
        } else if (text === '/status') {
          const subbed = telegramChatIds.has(chatId);
          await tgSend(chatId,
            subbed ? `✅ You ARE subscribed to CryptoFlow alerts!` : `❌ You are NOT subscribed. Send /start to subscribe.`,
            true
          );
        } else if (text === '/test') {
          await tgSend(chatId,
            `🔔 *TEST ALERT — CryptoFlow*\n\n` +
            `📊 Coin: BTC\n` +
            `💰 Current Price: $77,500\n` +
            `🎯 Target: ↑ Above $1\n\n` +
            `✅ Your Telegram notifications are working perfectly!`,
            true
          );
        }
      }
    }
  } catch (err) {
    // Silently ignore polling errors
  } finally {
    isPolling = false;
    setTimeout(pollTelegram, 3000);
  }
}

// Start polling
setTimeout(() => {
  console.log('🤖 Starting Telegram polling...');
  pollTelegram();
}, 2000);

// ============================================================
// SEND ALERT NOTIFICATION
// ============================================================
async function sendAlertNotification(alert, currentPrice, userId) {
  const symbol = (alert.cryptoName || alert.cryptoId || '???').toUpperCase();
  const direction = alert.type === 'above' ? '📈 ABOVE ↑' : '📉 BELOW ↓';
  const channels = alert.notificationChannels || ['telegram'];

  console.log(`\n🔔 Sending alert notification:`);
  console.log(`   Coin     : ${symbol}`);
  console.log(`   Price    : $${currentPrice.toLocaleString()}`);
  console.log(`   Target   : ${alert.type} $${alert.targetPrice.toLocaleString()}`);
  console.log(`   Channels : ${channels.join(', ')}`);
  console.log(`   TG subs  : ${telegramChatIds.size}`);

  const message =
    `🚨 *PRICE ALERT TRIGGERED!*\n\n` +
    `📊 *Coin:* ${symbol}/USDT\n` +
    `💰 *Current Price:* $${currentPrice.toLocaleString()}\n` +
    `🎯 *Target:* ${direction} $${alert.targetPrice.toLocaleString()}\n` +
    (alert.note ? `📝 *Note:* ${alert.note}\n` : '') +
    `\n🕐 ${new Date().toLocaleString()}\n` +
    `\n_CryptoFlow Alerts_`;

  if (channels.includes('telegram')) {
    if (!BOT_TOKEN) {
      console.error('   ❌ TELEGRAM_BOT_TOKEN not set in .env');
    } else if (telegramChatIds.size === 0) {
      console.error('   ❌ No Telegram subscribers. Send /start to @Crypto0_flowbot');
    } else {
      await tgBroadcast(message, true);
    }
  }

  if (channels.includes('email') && emailSubscribers.size > 0) {
    console.log(`   📧 Email alert for ${emailSubscribers.size} subscribers`);
  }

  // Always emit for UI update
  io.emit(`alertTriggered_${userId}`, { ...alert, currentPrice });
}

// ============================================================
// PRICE MONITORING
// ============================================================
let isCheckingAlerts = false;

async function checkAlerts() {
  if (isCheckingAlerts) return;
  isCheckingAlerts = true;

  console.log(`\n🔍 Checking alerts... (${new Date().toLocaleTimeString()})`);
  console.log(`   Total alert sets: ${userAlerts.size}`);

  for (const [userId, alerts] of userAlerts.entries()) {
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      
      // Skip triggered non-recurring alerts
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
        if (!currentPrice || isNaN(currentPrice)) continue;

        let shouldTrigger = false;
        if (alert.type === 'above' && currentPrice >= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`   🎯 ABOVE TRIGGER! ${symbol} at $${currentPrice} >= $${alert.targetPrice}`);
        }
        if (alert.type === 'below' && currentPrice <= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`   🎯 BELOW TRIGGER! ${symbol} at $${currentPrice} <= $${alert.targetPrice}`);
        }

        if (shouldTrigger) {
          const triggeredPrice = currentPrice;
          
          if (alert.recurring === 'once' || !alert.recurring) {
            alert.triggered = true;
            alert.triggeredPrice = triggeredPrice;
            alert.triggeredAt = new Date().toISOString();
            saveData();
            console.log(`   ✅ ONE-TIME ALERT TRIGGERED for ${symbol}!`);
          } else {
            console.log(`   🔄 RECURRING ALERT TRIGGERED for ${symbol}!`);
          }
          
          await sendAlertNotification(alert, triggeredPrice, userId);
          
          // Handle recurring resets
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
      } catch (err) {
        // Silent fail for individual coins
      }
    }
  }

  isCheckingAlerts = false;
}

// Run alert checks every 10 seconds
setInterval(checkAlerts, 10000);

// ============================================================
// PRICE CACHE + WEBSOCKET
// ============================================================
let cachedPrices = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30000;

const SYMBOL_MAP = {
  bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', binancecoin: 'BNBUSDT',
  ripple: 'XRPUSDT', cardano: 'ADAUSDT', solana: 'SOLUSDT',
  dogecoin: 'DOGEUSDT', polkadot: 'DOTUSDT'
};

async function fetchPrices() {
  const now = Date.now();
  if (cachedPrices && now - lastFetchTime < CACHE_DURATION) return cachedPrices;

  try {
    const results = await Promise.all(
      Object.entries(SYMBOL_MAP).map(async ([id, symbol]) => {
        try {
          const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
          return { id, usd: parseFloat(res.data.lastPrice), usd_24h_change: parseFloat(res.data.priceChangePercent) };
        } catch { return null; }
      })
    );
    const prices = {};
    results.filter(Boolean).forEach(r => { prices[r.id] = { usd: r.usd, usd_24h_change: r.usd_24h_change }; });
    cachedPrices = prices;
    lastFetchTime = now;
    return prices;
  } catch (e) {
    return cachedPrices || null;
  }
}

setInterval(async () => {
  const prices = await fetchPrices();
  if (prices) io.emit('priceUpdate', prices);
}, 15000);

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

app.post('/api/auth/reset-password', async (req, res) => {
  const { email } = req.body;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'http://localhost:3000/update-password.html'
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/auth/update-password', async (req, res) => {
  const { access_token, new_password } = req.body;
  if (access_token) await supabase.auth.setSession({ access_token, refresh_token: '' });
  const { error } = await supabase.auth.updateUser({ password: new_password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ============================================================
// ALERT ROUTES
// ============================================================
app.get('/api/alerts/:userId', (req, res) => {
  res.json(userAlerts.get(req.params.userId) || []);
});

app.post('/api/alerts', (req, res) => {
  const { userId, alert } = req.body;
  if (!userAlerts.has(userId)) userAlerts.set(userId, []);
  const newAlert = {
    id: Date.now(),
    ...alert,
    notificationChannels: alert.notificationChannels || ['telegram'],
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

// ============================================================
// NOTIFICATION ROUTES
// ============================================================
app.get('/api/notifications/stats', (req, res) => {
  res.json({ telegram: { active: telegramChatIds.size }, email: { active: emailSubscribers.size } });
});

app.post('/api/notifications/email/subscribe', (req, res) => {
  const { email } = req.body;
  if (!email?.includes('@')) return res.status(400).json({ success: false, message: 'Invalid email' });
  emailSubscribers.add(email);
  saveData();
  res.json({ success: true });
});

app.post('/api/notifications/email/unsubscribe', (req, res) => {
  emailSubscribers.delete(req.body.email);
  saveData();
  res.json({ success: true });
});

app.post('/api/notifications/test', async (req, res) => {
  const { coin = 'BTC', targetPrice = 100000, currentPrice = 105000, direction = 'above' } = req.body;

  console.log(`\n🧪 Test alert requested`);
  console.log(`   Subscribers: ${telegramChatIds.size}`);

  const message =
    `🔔 *TEST ALERT — CryptoFlow*\n\n` +
    `📊 *Coin:* ${coin}\n` +
    `💰 *Price:* $${Number(currentPrice).toLocaleString()}\n` +
    `🎯 *Target:* ${direction === 'above' ? '↑ Above' : '↓ Below'} $${Number(targetPrice).toLocaleString()}\n\n` +
    `✅ Notifications are working!`;

  const sent = await tgBroadcast(message, true);
  res.json({ success: true, telegram: sent, email: emailSubscribers.size });
});

// Debug endpoint
app.get('/api/telegram/status', (req, res) => {
  res.json({
    botTokenConfigured: !!BOT_TOKEN,
    subscribers: Array.from(telegramChatIds),
    subscriberCount: telegramChatIds.size,
    emailSubscribers: emailSubscribers.size,
    totalAlertSets: userAlerts.size
  });
});

// Manual trigger endpoint
app.post('/api/debug/check-now', async (req, res) => {
  console.log('\n🔧 Manual alert check triggered...');
  await checkAlerts();
  res.json({ success: true, message: 'Alert check completed' });
});

// ============================================================
// WEBSOCKET
// ============================================================
io.on('connection', (socket) => {
  console.log(`🔌 WebSocket client connected`);
  fetchPrices().then(prices => { if (prices) socket.emit('priceUpdate', prices); });
  socket.on('disconnect', () => console.log(`🔌 WebSocket client disconnected`));
});

// ============================================================
// HTML ROUTES
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'auth', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html')));
app.get('/alerts', (req, res) => res.sendFile(path.join(__dirname, 'alerts', 'alerts.html')));
app.get('/risk', (req, res) => res.sendFile(path.join(__dirname, 'risk', 'risk.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings', 'settings.html')));
app.get('/update-password', (req, res) => res.sendFile(path.join(__dirname, 'auth', 'update-password.html')));

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CryptoFlow server running on http://localhost:${PORT}`);
  console.log(`🤖 Telegram Bot  : ${BOT_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`📱 TG Subscribers: ${telegramChatIds.size}`);
  console.log(`📧 Email Subscribers: ${emailSubscribers.size}`);
  console.log(`🔔 Alert sets: ${userAlerts.size}`);
  console.log(`\n💡 Commands for Telegram bot:`);
  console.log(`   /start  - Subscribe to alerts`);
  console.log(`   /stop   - Unsubscribe`);
  console.log(`   /status - Check subscription`);
  console.log(`   /test   - Send test alert\n`);
});
