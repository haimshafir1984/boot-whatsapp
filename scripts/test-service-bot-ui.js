const assert = require('assert');
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

for (const id of [
  'dashboardTabs',
  'serviceBotDashboardTab',
  'serviceBotCard',
  'serviceBotSelector',
  'serviceBotEnabled',
  'serviceBotMainNode',
  'serviceBotNodeList',
  'serviceBotNodeEditor',
  'serviceBotPreview',
  'serviceBotValidation',
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing UI element: ${id}`);
}

for (const endpoint of [
  '/api/service-bot',
  '/api/service-bots',
  '/api/service-bot/validate',
  '/api/service-bot/sessions',
]) {
  assert.ok(html.includes(endpoint), `missing service bot API usage: ${endpoint}`);
}

for (const functionName of [
  'loadServiceBot',
  'selectServiceBot',
  'createServiceBotDraft',
  'duplicateCurrentServiceBot',
  'deleteCurrentServiceBot',
  'renderServiceBotEditor',
  'serviceBotVariableCatalog',
  'setServiceBotFriendlyConditionSource',
  'setServiceBotFriendlyConditionValue',
  'generateMissingServiceBotConditionCombinations',
  'validateServiceBotDraft',
  'saveServiceBot',
  'loadServiceBotSample',
]) {
  assert.match(html, new RegExp(`function\\s+${functionName}\\s*\\(`), `missing UI function: ${functionName}`);
}

assert.match(html, /serviceBotFeatureEnabled = Boolean\(data\.featureEnabled\)/, 'service bot feature state must be tracked');
assert.match(html, /tabs\.style\.display = 'flex'/, 'service bot tab must be visible for every client');
assert.match(html, /const defaultTarget = serviceBotDraft\.nodes\.find/, 'new options must receive an existing target by default');
assert.match(html, /node\.variableKey = `input_\$\{number\}`/, 'new input nodes must receive a safe default variable key');
assert.match(html, /navigationPromptText \?\? 'מה תרצו לעשות עכשיו\?'/, 'an explicitly blank navigation prompt must remain disabled in preview');
const titleUpdateStart = html.indexOf('function updateServiceBotNodeTitle(');
const titleUpdateEnd = html.indexOf('function renameServiceBotNode(', titleUpdateStart);
assert.ok(titleUpdateStart >= 0 && titleUpdateEnd > titleUpdateStart, 'missing service bot title update function');
const titleUpdate = html.slice(titleUpdateStart, titleUpdateEnd);
assert.ok(!titleUpdate.includes('replaceServiceBotTarget'), 'editing a node title must not change its technical id');
assert.ok(html.includes('צריך לבחור מה המשתמש יראה אחרי הלחיצה'), 'missing targets must be explained next to the continuation selector');
assert.ok(html.includes('אין צורך לכתוב שמות משתנים או ערכים באנגלית'), 'friendly condition guidance is missing');
assert.ok(html.includes('מילוי שילובים חסרים'), 'condition combination helper is missing');
assert.ok(html.includes('הגדרה טכנית מתקדמת'), 'legacy technical editing must remain available');
assert.match(html, /variableKey, variableValue: serviceBotStableToken\('answer', optionId\)/, 'new menu options must receive hidden stable condition values');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(inlineScripts.length, 'dashboard must contain an inline script');
for (const script of inlineScripts) new Function(script);

console.log('Service bot UI tests passed.');
