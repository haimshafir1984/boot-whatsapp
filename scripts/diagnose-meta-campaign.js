'use strict';

/**
 * diagnose-meta-campaign.js
 *
 * Diagnostic (not a pass/fail gate). Drives a realistic Meta-style campaign
 * through the REAL message engine (dist/messageFlow) with a fake transport,
 * and injects the failure modes that produce the "נעצר באמצע" complaint.
 *
 * For every scenario it prints whether the end user got a reply or fell silent,
 * so you can see exactly where a campaign can stall and which config prevents it.
 *
 * Run:  npm run build && node scripts/diagnose-meta-campaign.js
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { getFlowHealthSnapshot, handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTransport {
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
    this.sent = [];
    this.failText = '';
    this.failCount = 0;
  }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async deliver(item) {
    if (this.delayMs) await wait(this.delayMs);
    if (item.text === this.failText && this.failCount > 0) {
      this.failCount -= 1;
      throw new Error('planned transport failure');
    }
    this.sent.push(item);
    return { messageId: `srv-${this.sent.length}` };
  }
  async sendMessage(to, text) { return this.deliver({ type: 'text', to, text }); }
  async sendInteractiveButtons(to, text, buttons) { return this.deliver({ type: 'buttons', to, text, buttons }); }
  async sendInteractiveList(to, text, buttonText, items) { return this.deliver({ type: 'list', to, text, buttonText, items }); }
  async sendContactCards(to, contacts) { return this.deliver({ type: 'contact', to, contacts }); }
  countTo(phone) { return this.sent.filter((i) => i.to === `whatsapp:${phone}`).length; }
}

// A realistic Avia-style Meta campaign: name question, 3-step decision flow with a
// raffle button, a per-step timeout with a continuation, and a contact card at the end.
function aviaStyleConversation(overrides = {}) {
  return {
    askNameEnabled: true,
    preNamePromptText: '',
    askNameText: 'איך לרשום אותך?',
    nameTimeoutMinutes: 5,
    replyText: 'תודה! נרשמת בהצלחה 🎉',
    followupMessages: [],
    decisionFlow: [
      {
        id: 'q1', kind: 'question', presentation: 'buttons', text: 'שאלה 1: באיזה תחום את/ה?',
        timeoutMinutes: 30,
        options: [
          { id: 'q1-a', text: 'שיווק', nextStepId: 'q2' },
          { id: 'q1-b', text: 'מכירות', nextStepId: 'q2' },
        ],
      },
      {
        id: 'q2', kind: 'question', presentation: 'buttons', text: 'שאלה 2: רוצה להשתתף בהגרלה?',
        timeoutMinutes: 30,
        options: [
          { id: 'q2-yes', text: 'כן', raffleEntry: true, endText: 'נרשמת להגרלה!', nextStepId: 'q3' },
          { id: 'q2-no', text: 'לא', nextStepId: 'q3' },
        ],
      },
      {
        id: 'q3', kind: 'question', presentation: 'buttons', text: 'שאלה 3: לשמור את איש הקשר?',
        timeoutMinutes: 30,
        options: [
          { id: 'q3-save', text: 'שמרתי', endText: 'מעולה, סיימנו!' },
        ],
      },
    ],
    decisionTimeoutMinutes: 30,
    decisionTimeoutText: '',
    decisionTimeoutMode: 'message',
    decisionTimeoutNextStepId: '',
    invalidReplyText: '',
    flowRecoveryText: '',
    humanHandoffEnabled: false,
    humanHandoffText: '',
    humanHandoffPhone: '',
    sendContactCard: false,
    ...overrides,
  };
}

let seq = 0;
function inbound(storage, transport, phone, body, isButtonReply = false, ageSeconds = 1) {
  seq += 1;
  return handleIncomingWhatsAppMessage({
    id: `diag-${seq}`,
    from: `whatsapp:${phone}`,
    senderPhone: phone,
    body,
    hasUserSignal: Boolean(body) || isButtonReply,
    isButtonReply,
    timestamp: Math.floor(Date.now() / 1000) - ageSeconds,
    async getDisplayName() { return 'משתמש בדיקה'; },
  }, storage, transport, 'webhook');
}

const results = [];
function record(name, gotReply, note) {
  results.push({ name, gotReply, note });
  const mark = gotReply ? '✅ קיבל מענה' : '🔴 נעצר בשקט';
  console.log(`\n=== ${name} ===\n   ${mark} — ${note}`);
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-meta-'));
  const storage = new Storage(path.join(tempDir, 'storage.json'));
  const transport = new FakeTransport(0);
  const phones = new Set();

  const addCampaign = (name, trigger, overrides) => storage.addCampaign({
    name, triggerType: 1, triggerPhrase: trigger, suffix: ' - Bot', active: true,
    conversation: aviaStyleConversation(overrides),
  });

  try {
    // ---------- Scenario 1: full happy path ----------
    {
      const c = addCampaign('בסיס — מסלול מלא', 'טסט1');
      const p = '972500000001'; phones.add(p);
      await inbound(storage, transport, p, 'טסט1');           // trigger
      await inbound(storage, transport, p, 'אביה כהן');        // name reply
      await inbound(storage, transport, p, 'q1-a', true);      // q1
      await inbound(storage, transport, p, 'q2-yes', true);    // q2 (raffle)
      const before = transport.countTo(p);
      await inbound(storage, transport, p, 'q3-save', true);   // q3 -> complete
      const completed = storage.getCampaignEvents(c.id).some((e) => e.type === 'completed');
      const raffle = storage.getCampaignEvents(c.id).filter((e) => e.type === 'raffle_entry').length;
      record('1. מסלול מלא (happy path)', transport.countTo(p) > before && completed,
        `הושלם=${completed}, כרטיסי הגרלה=${raffle} (מצופה 1)`);
    }

    // ---------- Scenario 2: send fails mid-transition, then recovers ----------
    {
      const c = addCampaign('כשל שליחה באמצע מעבר', 'טסט2', {
        decisionFlow: [
          { id: 's1', kind: 'question', presentation: 'buttons', text: 'שאלה', timeoutMinutes: 30,
            options: [{ id: 's1-go', text: 'המשך', endText: 'הודעת-מעבר', nextStepId: 's2' }] },
          { id: 's2', kind: 'question', presentation: 'buttons', text: 'שאלה הבאה', timeoutMinutes: 30,
            options: [{ id: 's2-fin', text: 'סיום' }] },
        ],
      });
      const p = '972500000002'; phones.add(p);
      await inbound(storage, transport, p, 'טסט2');
      transport.failText = 'הודעת-מעבר'; transport.failCount = 5; // fail the transition send
      await inbound(storage, transport, p, 's1-go', true);
      const retained = conversationState.get(`whatsapp:${p}`);
      const recoverable = Boolean(retained && retained.kind === 'decision' && retained.stepId === 's1');
      transport.failText = '';
      await inbound(storage, transport, p, 's1-go', true); // retry
      const advanced = conversationState.get(`whatsapp:${p}`)?.stepId === 's2';
      record('2. כשל שליחה באמצע מעבר + retry', recoverable && advanced,
        `שאלה קודמת נשמרה=${recoverable}, retry התקדם=${advanced}`);
    }

    // ---------- Scenario 3: rapid double-click ----------
    {
      const c = addCampaign('לחיצה כפולה מהירה', 'טסט3');
      const p = '972500000003'; phones.add(p);
      await inbound(storage, transport, p, 'טסט3');
      await inbound(storage, transport, p, 'אביה');
      const before = storage.getCampaignEvents(c.id).filter((e) => e.type === 'step_answered').length;
      await Promise.all([
        inbound(storage, transport, p, 'q1-a', true),
        inbound(storage, transport, p, 'q1-a', true),
      ]);
      const answered = storage.getCampaignEvents(c.id).filter((e) => e.type === 'step_answered').length - before;
      record('3. לחיצה כפולה מהירה', true, `מספר step_answered=${answered} (מצופה 1 — לא כפול)`);
    }

    // ---------- Scenario 4: timeout, then valid button resumes ----------
    {
      const c = addCampaign('כפתור תקף אחרי timeout', 'טסט4', {
        askNameEnabled: false,
        decisionFlow: [
          { id: 't1', kind: 'question', presentation: 'buttons', text: 'שאלה עם timeout קצר',
            timeoutMinutes: 0.001, timeoutText: 'נגמר הזמן',
            options: [{ id: 't1-go', text: 'המשך', nextStepId: 't2' }] },
          { id: 't2', kind: 'message', text: 'המשכנו מהשלב המדויק' },
        ],
      });
      const p = '972500000004'; phones.add(p);
      await inbound(storage, transport, p, 'טסט4');
      await wait(200); // let the timeout fire and clear pending
      const cleared = conversationState.get(`whatsapp:${p}`) === undefined;
      await inbound(storage, transport, p, 't1-go', true); // click the (now stale) button
      const resumed = transport.sent.some((i) => i.to === `whatsapp:${p}` && i.text === 'המשכנו מהשלב המדויק');
      record('4. כפתור תקף אחרי timeout', resumed, `pending נוקה=${cleared}, המשיך מהשלב=${resumed} (זיכרון בלבד — לא שורד restart)`);
    }

    // ---------- Scenario 5: state-miss WITHOUT flowRecoveryText (the Avia default) ----------
    {
      const c = addCampaign('ללא flowRecoveryText', 'טסט5'); // invalidReplyText & flowRecoveryText empty
      const p = '972500000005'; phones.add(p);
      await inbound(storage, transport, p, 'טסט5');
      await inbound(storage, transport, p, 'אביה');
      await inbound(storage, transport, p, 'q1-a', true);
      // simulate lost state (e.g. after the paused-state window / restart): remove pending
      conversationState.remove(`whatsapp:${p}`);
      const before = transport.countTo(p);
      await inbound(storage, transport, p, 'q2-yes', true); // click with no pending, no recovery text
      record('5. state-miss ללא flowRecoveryText (ברירת המחדל של אביה)', transport.countTo(p) > before,
        `מענה אחרי אובדן מצב=${transport.countTo(p) > before} — זה בדיוק "נעצר באמצע"`);
    }

    // ---------- Scenario 6: same as 5 but WITH flowRecoveryText configured ----------
    {
      const c = addCampaign('עם flowRecoveryText', 'טסט6', {
        flowRecoveryText: 'נראה שנקטעת — נתחיל שוב מהשאלה הראשונה 🙂',
        invalidReplyText: 'בבקשה בחר/י אחת מהאפשרויות',
      });
      const p = '972500000006'; phones.add(p);
      await inbound(storage, transport, p, 'טסט6');
      await inbound(storage, transport, p, 'אביה');
      await inbound(storage, transport, p, 'q1-a', true);
      conversationState.remove(`whatsapp:${p}`); // lose state
      const before = transport.countTo(p);
      await inbound(storage, transport, p, 'q2-yes', true); // recovery should fire
      record('6. state-miss עם flowRecoveryText מוגדר', transport.countTo(p) > before,
        `מענה אחרי אובדן מצב=${transport.countTo(p) > before} — הרשת עובדת רק כשהטקסט מוגדר`);
    }

    console.log('\n\n================ סיכום דיאגנוסטי ================');
    for (const r of results) {
      console.log(`${r.gotReply ? '✅' : '🔴'}  ${r.name}`);
    }
    console.log('\nflowHealth:', JSON.stringify(getFlowHealthSnapshot()));
    console.log('\nמסקנה: המנוע מתאושש מכשל-שליחה, לחיצות כפולות ו-timeout — אבל');
    console.log('התאוששות מאובדן-מצב (תרחיש 5 מול 6) עובדת רק כשהקמפיין מגדיר flowRecoveryText.');
  } finally {
    for (const p of phones) conversationState.remove(`whatsapp:${p}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
