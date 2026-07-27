const assert = require('assert');
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

for (const id of [
  'dashboardTabs',
  'serviceBotDashboardTab',
  'serviceBotCard',
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
  '/api/service-bot/validate',
  '/api/service-bot/sessions',
]) {
  assert.ok(html.includes(endpoint), `missing service bot API usage: ${endpoint}`);
}

for (const functionName of [
  'loadServiceBot',
  'renderServiceBotEditor',
  'validateServiceBotDraft',
  'saveServiceBot',
  'loadServiceBotSample',
]) {
  assert.match(html, new RegExp(`function\\s+${functionName}\\s*\\(`), `missing UI function: ${functionName}`);
}

assert.match(html, /if \(!data\.featureEnabled\)/, 'service bot tab must stay hidden when the feature flag is off');
assert.match(html, /const defaultTarget = serviceBotDraft\.nodes\.find/, 'new options must receive an existing target by default');
assert.ok(html.includes('חובה לבחור לאיזה צומת עוברים'), 'missing targets must be explained next to the target selector');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(inlineScripts.length, 'dashboard must contain an inline script');
for (const script of inlineScripts) new Function(script);

console.log('Service bot UI tests passed.');
