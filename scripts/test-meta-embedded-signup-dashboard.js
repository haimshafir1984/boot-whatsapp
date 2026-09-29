'use strict';

// embedded-signup-automation-plan-2026-09-28, stage 7 step 4: the owner
// dashboard's client page (owner-public/client.html) gets a connect-link
// button + onboarding status + retry button, and the existing manual Meta
// screen moves under a collapsed "advanced" <details> with corrected help
// text. There is no DOM test harness in this repo for plain, build-less
// dashboard HTML (no jsdom dependency) - this follows the same
// source-assertion convention already used by scripts/test-client-disable.js
// for the very same file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'owner-public', 'client.html'), 'utf8');

// 1. The new Embedded Signup section exists, is hidden by default (shown only for META_CLOUD_API
//    clients, same as the other provider-specific sections), and has the three UI pieces section
//    3.6 asks for: create-link button, an onboarding status line, and a retry button.
assert.match(html, /<section id="metaEmbeddedSignupSection" style="display:none">/, 'the Embedded Signup section must exist and be hidden until a Meta client is loaded');
assert.match(html, /id="metaOnboardingStatus"/, 'a status element must exist to show not-connected / pending / connected / failed');
assert.match(html, /onclick="createMetaConnectLink\(\)"/, 'a button must call createMetaConnectLink()');
assert.match(html, /id="metaConnectRetryButton"[^>]*onclick="retryMetaEmbeddedSignup\(\)"/, 'the retry button must call retryMetaEmbeddedSignup()');
assert.match(html, /id="metaConnectLinkBox"/, 'a box to display (and copy) the created link must exist');

// 2. loadClient() must toggle the new section exactly like the existing Meta section (same
//    isMetaClient condition), and must render the onboarding status whenever it does.
assert.match(
  html,
  /document\.getElementById\('metaEmbeddedSignupSection'\)\.style\.display = isMetaClient \? '' : 'none';\s*\n\s*if \(isMetaClient\) renderMetaOnboardingStatus\(\);/,
  'loadClient() must show/hide the Embedded Signup section for Meta clients and render its status',
);

// 3. The three functions call the real backend routes built in stage 7 step 3.
assert.match(html, /\/owner\/api\/clients\/\$\{encodeURIComponent\(currentClient\.id\)\}\/meta-connect-link/, 'createMetaConnectLink must call the link-creation endpoint');
assert.match(html, /\/owner\/api\/clients\/\$\{encodeURIComponent\(currentClient\.id\)\}\/meta-connect-retry/, 'retryMetaEmbeddedSignup must call the retry endpoint');

// 4. renderMetaOnboardingStatus covers all four states section 3.6 asks for: not connected,
//    pending, connected (with the display number), and failed (with step + error) - and shows
//    the retry button exactly when there is something to retry (failed, or a stuck smb sync).
const renderFn = html.match(/function renderMetaOnboardingStatus\(\) \{[\s\S]*?\n {4}\}/);
assert.ok(renderFn, 'renderMetaOnboardingStatus must be defined');
const renderBody = renderFn[0];
assert.match(renderBody, /'לא מחובר/, 'must render a not-connected state');
assert.match(renderBody, /ממתין/, 'must render a pending state');
assert.match(renderBody, /מחובר\./, 'must render a connected state with the display number');
assert.match(renderBody, /נכשל בשלב/, 'must render a failed state with the step and error');
assert.match(renderBody, /retryButton\.style\.display = ''/, 'the retry button must be shown for at least one non-happy state');

// 5. The old manual screen is now collapsed by default under "advanced", and its help text no
//    longer implies a dedicated-WABA client can leave the token blank and fall back to the
//    central one (embedded-signup-automation-plan-2026-09-28.md section 0: "תיקון לדברים
//    שנאמרו קודם").
assert.match(html, /<details id="metaSettingsSection" style="display:none">/, 'the manual Meta screen must be a collapsed <details>, not an always-expanded <section>');
assert.match(html, /<summary>מתקדם: חיבור Meta ידני \(מסלול גיבוי\)<\/summary>/, 'the manual screen must be clearly labeled as an advanced/backup path');
assert.match(html, /לקוחה עם WABA משלה \(מספר ייעודי\) <strong>חייבת<\/strong> טוקן משלה/, 'the corrected help text must say a dedicated-WABA client must have its own token');
assert.match(html, /אין להשאיר את השדה ריק כשמגדירים מסלול ידני/, 'the corrected help text must say not to leave the token field blank');
assert.doesNotMatch(html, /ריק משאיר את הקיים או את ברירת המחדל המרכזית/, 'the old (incorrect) claim that a blank token falls back to the shared central token must be gone');

// 6. The page's inline script is still syntactically valid (same check as test-client-disable.js).
for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  assert.doesNotThrow(() => new Function(script), 'owner client dashboard inline JavaScript must remain syntactically valid');
}

console.log('Embedded Signup dashboard tests passed.');
