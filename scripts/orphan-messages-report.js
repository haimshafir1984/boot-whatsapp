#!/usr/bin/env node
'use strict';
/**
 * Orphan messages: messages sent to the shared Meta number that the gateway could not give to any client
 * (no trigger sentence matched and no client had an open conversation with the sender), plus triggers that arrived too late
 * (parked as stale). Read-only: it reads the gateway's docker log and the gateway inbox database over SSH.
 *
 *   node scripts/orphan-messages-report.js [--out DIR] [--days 30] [--host ...] [--key ...] [--gateway-service flowsbiz-admin-akr2zu]
 *
 * Run it every few days and ALWAYS BEFORE deploying the gateway: the gateway log is replaced by every deploy, and it is the only
 * place that records which messages were ignored. Every run adds what it finds to a ledger file (orphan-ledger.json in --out), so the
 * history survives later deploys; the text of a message is kept in the ledger even after the inbox drops it (7 days).
 * The ledger contains phone numbers and message text: keep it in Downloads, never commit it.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const HOST = val('host', '169.58.236.130');
const KEY = val('key', path.join(os.homedir(), '.ssh', 'flowsbiz_hetzner_ed25519'));
const GATEWAY_SERVICE = val('gateway-service', 'flowsbiz-admin-akr2zu');
const OUT = val('out', path.join(os.homedir(), 'Downloads', 'orphan-messages'));
const DAYS = Number(val('days', 30)) || 30;

function ssh(command, input) {
  const r = spawnSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `root@${HOST}`, command], { encoding: 'utf8', input, maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${String(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}
const il = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** What the sender actually sent, as a short line. */
function describe(msg) {
  if (!msg) return { type: '?', text: '' };
  const type = String(msg.type || '?');
  if (type === 'text') return { type, text: String(msg.text?.body ?? '') };
  if (type === 'interactive') {
    const b = msg.interactive?.button_reply || msg.interactive?.list_reply;
    return { type: 'כפתור', text: b ? `${b.title ?? ''} (${b.id ?? ''})` : '' };
  }
  if (type === 'button') return { type: 'כפתור', text: `${msg.button?.text ?? ''} (${msg.button?.payload ?? ''})` };
  const media = msg[type];
  return { type, text: media?.caption ? String(media.caption) : '' };
}

const REASONS = {
  no_trigger_or_pending_conversation: 'אין טריגר מתאים ואין שיחה פתוחה',
  stale_trigger: 'טריגר שהגיע מאוחר מדי',
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ledgerFile = path.join(OUT, 'orphan-ledger.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { items: {}, runs: [] };

  // 1. the gateway log of its current container: which messages were ignored
  const task = ssh(`t=$(docker service ps ${GATEWAY_SERVICE} --filter desired-state=running --format '{{.ID}}' | head -1); echo $t; docker inspect $t --format '{{.CreatedAt}}'`).trim().split('\n');
  const created = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(task[1] || '');
  const since = created ? ` --since ${created[1]}T${created[2]}Z` : '';
  const raw = ssh(`docker service logs --timestamps${since} ${GATEWAY_SERVICE} 2>&1`).split('\n');
  const lineRe = /^(\S+) (\S+?)\.(\d+)\.([a-z0-9]+)@\S+\s+\| ?(.*)$/;
  const lines = raw.map((l) => lineRe.exec(l.replace(/\r$/, ''))).filter((m) => m && m[4] === task[0]);
  if (!lines.length) throw new Error('the gateway log is empty');
  const logFrom = Date.parse(lines[0][1]); const logTo = Date.parse(lines[lines.length - 1][1]);
  const ignored = [];
  let ignoredToOtherNumbers = 0;
  for (const m of lines) {
    const t = Date.parse(m[1]); const text = m[5];
    let x;
    if ((x = /\[META_GATEWAY_IGNORED\] reason=(\S+) (wamid\S+) (\d+)/.exec(text))) ignored.push({ wamid: x[2], phone: x[3], at: t, reason: x[1] });
    else if (/\[META_GATEWAY_IGNORED\] reason=no_matching_phone_number/.test(text)) ignoredToOtherNumbers += 1;
  }

  // 2. the gateway inbox: the text of those messages (kept 7 days) and the triggers parked as stale
  const ids = ignored.map((i) => `'${i.wamid.replace(/[^A-Za-z0-9=_.-]/g, '')}'`);
  const sql = `select coalesce(json_agg(t order by t.received_at), '[]'::json) from (
    select message_id, received_at, sender_phone, resolution, payload->'entry'->0->'changes'->0->'value'->'messages'->0 as msg
    from inbox_items where role = 'gateway' and received_at > now() - interval '${DAYS} days'
      and (message_id in (${ids.length ? ids.join(',') : "''"}) or resolution = 'stale_trigger')) t;`;
  const rows = JSON.parse(ssh("pg=$(docker ps -q -f name=flowsbizadmininboxpostgres | head -1); docker exec -i $pg psql -U postgres -At", sql).trim() || '[]');
  const byId = new Map(rows.map((r) => [r.message_id, r]));

  // 3. merge into the ledger (never lose a text we already have)
  let added = 0;
  const newIds = new Set();
  const upsert = (wamid, rec) => {
    const old = ledger.items[wamid];
    const merged = { ...old, ...rec, text: rec.text || old?.text || '', type: rec.type !== '?' ? rec.type : (old?.type || '?') };
    if (!old) { merged.firstSeenAt = new Date().toISOString(); added += 1; newIds.add(wamid); }
    ledger.items[wamid] = merged;
  };
  for (const i of ignored) {
    const row = byId.get(i.wamid);
    const d = describe(row?.msg);
    upsert(i.wamid, { at: i.at, phone: i.phone, reason: i.reason, ...d, textGone: !row?.msg });
  }
  for (const r of rows.filter((x) => x.resolution === 'stale_trigger')) {
    const d = describe(r.msg);
    upsert(r.message_id, { at: Date.parse(r.received_at), phone: r.sender_phone, reason: 'stale_trigger', ...d, textGone: !r.msg });
  }

  // coverage: the log only goes back to the start of the current gateway container
  const lastRun = ledger.runs[ledger.runs.length - 1];
  const gap = lastRun && logFrom > lastRun.coveredTo + 5 * 60000;
  ledger.runs.push({ at: Date.now(), coveredFrom: logFrom, coveredTo: logTo });
  ledger.runs = ledger.runs.slice(-100);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));

  // 4. print
  const cutoff = Date.now() - DAYS * 86400000;
  const all = Object.entries(ledger.items).map(([wamid, v]) => ({ wamid, ...v })).filter((v) => v.at >= cutoff).sort((a, b) => b.at - a.at);
  console.log(`הודעות יתומות — ${il(Date.now())} (שעון ישראל)`);
  console.log(`  לוג השער נבדק: ${il(logFrom)} עד ${il(logTo)}`);
  if (gap) console.log(`  [!] פער: הריצה הקודמת כיסתה עד ${il(lastRun.coveredTo)} והלוג הנוכחי מתחיל ב-${il(logFrom)}. הודעות יתומות בין השעות האלה לא נרשמו (הלוג הוחלף ב-Deploy).`);
  if (!lastRun) console.log('  (ריצה ראשונה: מה שלפני תחילת הלוג הנוכחי לא ידוע)');
  console.log(`  נמצאו ${all.length} הודעות ב-${DAYS} הימים האחרונים (${added} חדשות מאז הריצה הקודמת)` + (ignoredToOtherNumbers ? `   |   נוספו ${ignoredToOtherNumbers} הודעות למספר אחר שאינו שלנו (לא נספרות)` : ''));
  console.log('');
  if (!all.length) console.log('  אין הודעות יתומות.');
  const isNew = (v) => newIds.has(v.wamid);
  for (const v of all) {
    console.log(`${isNew(v) ? '* ' : '  '}${il(v.at)}  ${String(v.phone).padEnd(13)} ${String(v.type).padEnd(7)} ${REASONS[v.reason] || v.reason}`);
    console.log(`        ${v.text ? v.text.replace(/\s+/g, ' ').slice(0, 160) : (v.textGone ? '(התוכן נמחק מה-inbox אחרי 7 ימים ולא נשמר אצלנו)' : '(ללא טקסט)')}`);
  }
  console.log('');
  console.log(`קובץ היסטוריה: ${ledgerFile}  (מכיל מספרים ותוכן — לא לקומט)   |   * = חדש בריצה הזו`);
})().catch((e) => { console.error(e.message); process.exit(1); });
