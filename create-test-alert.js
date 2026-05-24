const fs = require('fs');

// Read existing data or create new
let data;
try {
  data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
} catch (e) {
  data = { telegramChatIds: [], emailSubscribers: [], userAlerts: {} };
}

// Create test user alerts
if (!data.userAlerts['test-user']) {
  data.userAlerts['test-user'] = [];
}

// Add a test alert that will trigger immediately
data.userAlerts['test-user'].push({
  id: Date.now(),
  cryptoId: 'btc',
  cryptoName: 'BTC',
  targetPrice: 1,
  type: 'above',
  notificationChannels: ['telegram'],
  recurring: 'once',
  note: 'Test alert - will trigger immediately',
  createdAt: new Date().toISOString(),
  triggered: false
});

// Add another test alert for BELOW
data.userAlerts['test-user'].push({
  id: Date.now() + 1,
  cryptoId: 'btc',
  cryptoName: 'BTC',
  targetPrice: 100000,
  type: 'below',
  notificationChannels: ['telegram'],
  recurring: 'once',
  note: 'Test alert - BTC below 100k',
  createdAt: new Date().toISOString(),
  triggered: false
});

fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
console.log('✅ Test alerts created!');
console.log('   Alert 1: BTC ABOVE $1 (will trigger immediately)');
console.log('   Alert 2: BTC BELOW $100,000 (will trigger immediately)');
console.log('');
console.log('Restart your server to see the alerts trigger!');
