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
      console.log(`\n📦 Loaded: ${telegramChatIds.size} subscribers, ${userAlerts.size} alerts`);
    } else {
      saveData();
    }
  } catch (e) {
    console.error('Load error:', e.message);
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
    console.error('Save error:', e.message);
  }
}

loadData();
setInterval(saveData, 60000);

// ============================================================
// TELEGRAM
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
      console.log(`✅ TG sent to ${chatId}`);
      return true;
    }
    return false;
  } catch (err) {
    if (err.response?.data?.error_code === 403) {
      telegramChatIds.delete(chatId);
      saveData();
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
    await new Promise(r => setTimeout(r, 100));
  }
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
        const name = msg.from?.first_name || 'User';

        console.log(`📩 TG from ${chatId}: "${msg.text}"`);

        if (text === '/start') {
          telegramChatIds.add(chatId);
          saveData();
          console.log(`✅ Subscribed ${chatId} | Total: ${telegramChatIds.size}`);
          await tgSend(chatId, `✅ *Welcome to CryptoFlow!*\n\nYou are now subscribed to price alerts.\n\nSend /test to verify.`, true);
        } else if (text === '/stop') {
          telegramChatIds.delete(chatId);
          saveData();
          await tgSend(chatId, `❌ Unsubscribed.`);
        } else if (text === '/status') {
          const subbed = telegramChatIds.has(chatId);
          await tgSend(chatId, subbed ? `✅ Subscribed!` : `❌ Not subscribed.`);
        } else if (text === '/test') {
          await tgSend(chatId, `🔔 *TEST* ✅ Your Telegram is working!`, true);
        }
      }
    }
  } catch (err) {
    // silent
  } finally {
    isPolling = false;
    setTimeout(pollTelegram, 3000);
  }
}

// ============================================================
// PRICE FETCHING - Using multiple sources
// ============================================================
async function fetchPrice(symbol) {
  const upperSymbol = symbol.toUpperCase();
  
  // Try Binance first
  try {
    const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}USDT`, { timeout: 5000 });
    return parseFloat(response.data.price);
  } catch (err) {
    console.log(`   Binance failed for ${upperSymbol}, trying CoinGecko...`);
  }
  
  // Try CoinGecko as fallback
  try {
    const coinMap = {
      'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana',
      'BNB': 'binancecoin', 'XRP': 'ripple', 'ADA': 'cardano', 'DOGE': 'dogecoin'
    };
    const coinId = coinMap[upperSymbol];
    if (coinId) {
      const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, { timeout: 5000 });
      return response.data[coinId]?.usd || null;
    }
  } catch (err) {
    console.log(`   CoinGecko failed for ${upperSymbol}`);
  }
  
  return null;
}

// ============================================================
// SEND ALERT
// ============================================================
async function sendAlertNotification(alert, currentPrice, userId) {
  const symbol = (alert.cryptoName || alert.cryptoId || '???').toUpperCase();
  const direction = alert.type === 'above' ? '📈 ABOVE' : '📉 BELOW';

  console.log(`\n🔔 ALERT: ${symbol} at $${currentPrice} (Target: $${alert.targetPrice})`);

  const message =
    `🚨 *PRICE ALERT!*\n\n` +
    `📊 *Coin:* ${symbol}/USDT\n` +
    `💰 *Current:* $${currentPrice.toLocaleString()}\n` +
    `🎯 *Target:* ${direction} $${alert.targetPrice.toLocaleString()}\n\n` +
    `🕐 ${new Date().toLocaleString()}`;

  const sent = await tgBroadcast(message, true);
  
  alertHistory.unshift({
    id: Date.now(), symbol, price: currentPrice,
    targetPrice: alert.targetPrice, type: alert.type,
    triggeredAt: new Date().toISOString(), userId, telegramSent: sent
  });
  if (alertHistory.length > 1000) alertHistory.pop();
  saveData();
  
  io.emit(`alertTriggered_${userId}`, { ...alert, currentPrice });
}

// ============================================================
// PRICE MONITORING
// ============================================================
let isCheckingAlerts = false;
let lastPriceTime = Date.now();

async function checkAlerts() {
  if (isCheckingAlerts) return;
  isCheckingAlerts = true;

  for (const [userId, alerts] of userAlerts.entries()) {
    for (const alert of alerts) {
      if (alert.triggered && (alert.recurring === 'once' || !alert.recurring)) {
        continue;
      }

      const symbol = (alert.cryptoName || alert.cryptoId || '').toUpperCase().trim();
      if (!symbol) continue;

      const currentPrice = await fetchPrice(symbol);
      
      if (currentPrice && !isNaN(currentPrice)) {
        // Log price every minute
        if (Date.now() - lastPriceTime > 60000) {
          console.log(`📊 ${symbol} price: $${currentPrice}`);
          lastPriceTime = Date.now();
        }
        
        let shouldTrigger = false;
        if (alert.type === 'above' && currentPrice >= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`🎯 ${symbol} ABOVE! $${currentPrice} >= $${alert.targetPrice}`);
        }
        if (alert.type === 'below' && currentPrice <= alert.targetPrice) {
          shouldTrigger = true;
          console.log(`🎯 ${symbol} BELOW! $${currentPrice} <= $${alert.targetPrice}`);
        }

        if (shouldTrigger) {
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
            setTimeout(() => { alert.triggered = false; saveData(); }, 3600000);
          } else if (alert.recurring === 'daily') {
            setTimeout(() => { alert.triggered = false; saveData(); }, 86400000);
          }
        }
      } else {
        console.log(`⚠️ Could not fetch price for ${symbol}`);
      }
    }
  }

  isCheckingAlerts = false;
}

setInterval(checkAlerts, 15000);
console.log('✅ Price monitoring active (checking every 15 seconds)');

// ============================================================
// ROUTES
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
      res.status(404).json({ error: 'Not found' });
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

app.get('/api/notifications/stats', (req, res) => {
  res.json({ telegram: { active: telegramChatIds.size } });
});

app.post('/api/notifications/test', async (req, res) => {
  console.log(`\n🧪 TEST to ${telegramChatIds.size} subscribers`);
  const sent = await tgBroadcast(`🔔 *TEST ALERT*\n\n✅ Your Telegram is working!`, true);
  res.json({ success: true, telegram: sent });
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    botTokenConfigured: !!BOT_TOKEN,
    subscriberCount: telegramChatIds.size,
    totalAlertSets: userAlerts.size
  });
});

app.get('/api/price/:symbol', async (req, res) => {
  const price = await fetchPrice(req.params.symbol);
  res.json({ symbol: req.params.symbol, price });
});

app.post('/api/debug/check-now', async (req, res) => {
  console.log('\n🔧 Manual alert check...');
  await checkAlerts();
  res.json({ success: true });
});

app.get('/api/health', (req, res) => {
  let total = 0;
  for (const alerts of userAlerts.values()) total += alerts.length;
  res.json({ status: 'healthy', subscribers: telegramChatIds.size, alerts: total });
});

// ============================================================
// WEBSOCKET
// ============================================================
io.on('connection', (socket) => {
  console.log(`🔌 WebSocket connected`);
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
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  console.log(`📱 Subscribers: ${telegramChatIds.size}`);
  console.log(`🔔 Alerts: ${userAlerts.size}`);
  console.log(`✅ Monitoring active\n`);
  
  setTimeout(() => pollTelegram(), 2000);
});
