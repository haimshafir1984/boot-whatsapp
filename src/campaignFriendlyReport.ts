import type ExcelJS from 'exceljs';
import type { Campaign, CampaignEvent, CampaignResult, DecisionFlowStep } from './storage';

/**
 * Plain-language sheets for the campaign results export (headline numbers, raffles, participants, funnel,
 * emails, glossary). Everything is derived from the campaign's own flow definition and its events, with no
 * campaign-specific text matching, so it works for any campaign. Pure: reads its input, writes only to the workbook.
 */

export interface FriendlyReportInput {
  campaign: Campaign;
  results: CampaignResult[];
  events: CampaignEvent[];
  displayName: (result: CampaignResult) => string;
  generatedAt?: Date;
  /** Shown under the headline numbers, e.g. which campaigns were merged and whose flow the funnel follows. */
  note?: string;
}

const TEAL = 'FF1F5C6B';
const LIGHT = 'FFE8F1F3';
const GREEN = 'FFDDF0E1';
const GREY = 'FF6B7280';
const SHEET_FONT = 'Arial';
const TIME_ZONE = 'Asia/Jerusalem';
const DATE_FORMAT = 'dd/mm/yyyy hh:mm';

const israelParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** A Date whose UTC fields equal Israel wall-clock time, so Excel shows local time with a plain date format. */
export function israelWallClock(iso: string | undefined): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const part: Record<string, number> = {};
  for (const item of israelParts.formatToParts(parsed)) if (item.type !== 'literal') part[item.type] = Number(item.value);
  return new Date(Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second));
}

const excelSafe = (value: unknown): string => {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

const shortTitle = (text: string, max = 60): string => {
  const line = String(text ?? '').replace(/[*_~`]/g, '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Steps in the order a participant walks them (nextStepId chain), unreachable ones appended in saved order. */
export function orderFlowSteps(steps: DecisionFlowStep[]): DecisionFlowStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const ordered: DecisionFlowStep[] = [];
  const queue: string[] = steps.length ? [steps[0].id] : [];
  while (queue.length) {
    const id = queue.shift() as string;
    const step = byId.get(id);
    if (!step || seen.has(id)) continue;
    seen.add(id);
    ordered.push(step);
    const next: string[] = [];
    if (step.nextStepId) next.push(step.nextStepId);
    for (const option of step.options ?? []) if (option.nextStepId) next.push(option.nextStepId);
    for (const rule of step.resultRules ?? []) if (rule.nextStepId) next.push(rule.nextStepId);
    queue.push(...next);
  }
  for (const step of steps) if (!seen.has(step.id)) ordered.push(step);
  return ordered;
}

interface Person {
  phone: string;
  name: string;
  firstEntry: string;
  results: CampaignResult[];
  events: CampaignEvent[];
}

export function addFriendlyReportSheets(workbook: ExcelJS.Workbook, input: FriendlyReportInput): void {
  const { campaign, results, events } = input;
  const flow = orderFlowSteps(campaign.conversation?.decisionFlow ?? []);

  // ---- one row per phone (the raw export has one row per entry)
  const people = new Map<string, Person>();
  const resultOwner = new Map<string, string>();
  for (const result of results) {
    const key = result.phone || result.id;
    resultOwner.set(result.id, key);
    const person = people.get(key) ?? { phone: result.phone, name: input.displayName(result), firstEntry: result.triggeredAt, results: [], events: [] };
    person.results.push(result);
    if (result.triggeredAt && (!person.firstEntry || result.triggeredAt < person.firstEntry)) person.firstEntry = result.triggeredAt;
    people.set(key, person);
  }
  for (const event of events) {
    const key = (event.campaignResultId && resultOwner.get(event.campaignResultId)) || event.phone || '';
    const person = people.get(key);
    if (person) person.events.push(event);
  }
  const list = [...people.values()].sort((a, b) => String(a.firstEntry).localeCompare(String(b.firstEntry)));
  const total = list.length;

  // ---- which flow step each step_sent event belongs to (matched on the stored text prefix)
  const stepIndexByLabel = new Map<string, number>();
  flow.forEach((step, index) => {
    const label = step.text.slice(0, 120);
    if (label && !stepIndexByLabel.has(label)) stepIndexByLabel.set(label, index);
    for (const rule of step.resultRules ?? []) {
      const ruleLabel = rule.label || rule.type;
      if (ruleLabel && !stepIndexByLabel.has(ruleLabel)) stepIndexByLabel.set(ruleLabel, index);
    }
  });
  const stepIndexById = new Map(flow.map((step, index) => [step.id, index]));
  const answeredStepOf = (event: CampaignEvent): number | undefined => {
    const stepId = String(event.dedupeKey ?? '').split(':')[1];
    return stepId ? stepIndexById.get(stepId) : undefined;
  };

  const reached = flow.map(() => new Set<string>());
  const answeredStep = flow.map(() => new Set<string>());
  const furthest = new Map<string, number>();
  const scoreSteps = flow.map((step) => step.kind === 'score_question');
  const scoreAnswered = new Map<string, Set<number>>();
  const raffles = new Map<string, Map<string, string>>();   // raffle label -> phone -> first entry time
  const completedPeople = new Set<string>();
  const confirmedSaved = new Set<string>();
  const answeredAny = new Set<string>();
  const emailPeople = new Set<string>();
  const groupJoin = new Set<string>();
  const humanHandoff = new Set<string>();
  for (const person of list) {
    for (const event of person.events) {
      const key = person.phone;
      if (event.type === 'step_sent') {
        const index = stepIndexByLabel.get(String(event.label ?? ''));
        if (index !== undefined) {
          reached[index].add(key);
          furthest.set(key, Math.max(furthest.get(key) ?? -1, index));
        }
      } else if (event.type === 'step_answered' || event.type === 'score_answered') {
        answeredAny.add(key);
        const index = answeredStepOf(event);
        if (index !== undefined) {
          answeredStep[index].add(key);
          furthest.set(key, Math.max(furthest.get(key) ?? -1, index));
          if (event.type === 'score_answered') {
            const set = scoreAnswered.get(key) ?? new Set<number>();
            set.add(index);
            scoreAnswered.set(key, set);
          }
        }
      } else if (event.type === 'raffle_entry') {
        const [, raffleStepId, raffleOptionId] = String(event.dedupeKey ?? '').split(':');
        const optionText = flow.find((step) => step.id === raffleStepId)?.options?.find((option) => option.id === raffleOptionId)?.text;
        const label = (optionText ? shortTitle(optionText, 60) : '') || String(event.label ?? '').trim() || 'הגרלה';
        const map = raffles.get(label) ?? new Map<string, string>();
        const previous = map.get(key);
        if (!previous || event.createdAt < previous) map.set(key, event.createdAt);
        raffles.set(label, map);
      } else if (event.type === 'completed') completedPeople.add(key);
      else if (event.type === 'contact_card_confirmed') confirmedSaved.add(key);
      else if (event.type === 'email_captured') emailPeople.add(key);
      else if (event.type === 'group_join_request') groupJoin.add(key);
      else if (event.type === 'human_handoff') humanHandoff.add(key);
    }
  }
  const raffleList = [...raffles.entries()].sort((a, b) => [...a[1].values()].sort()[0].localeCompare([...b[1].values()].sort()[0]));
  const inAnyRaffle = new Set<string>();
  raffleList.forEach(([, map]) => map.forEach((_t, phone) => inAnyRaffle.add(phone)));
  const savedPeople = list.filter((person) => person.results.some((result) => result.status === 'saved')).length;
  const scoreSum = list.map((person) => person.results.map((result) => result.scoreTotal).find((value) => typeof value === 'number'));
  const scored = scoreSum.filter((value): value is number => typeof value === 'number');
  const scoreCount = scoreSteps.filter(Boolean).length;

  const stageOf = (person: Person): string => {
    if (completedPeople.has(person.phone)) return 'סיימה את כל התהליך';
    const index = furthest.get(person.phone);
    if (index === undefined) return 'התחילה, לא התקדמה';
    return `הגיעה לשלב ${index + 1}: ${shortTitle(flow[index].text || flow[index].kind, 45)}`;
  };

  // ---- styling helpers
  const font = (size = 11, bold = false, color = 'FF000000', italic = false): Partial<ExcelJS.Font> => ({ name: SHEET_FONT, size, bold, color: { argb: color }, italic });
  const box: Partial<ExcelJS.Borders> = { left: { style: 'thin', color: { argb: 'FFD1D5DB' } }, right: { style: 'thin', color: { argb: 'FFD1D5DB' } }, top: { style: 'thin', color: { argb: 'FFD1D5DB' } }, bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const right: Partial<ExcelJS.Alignment> = { horizontal: 'right', vertical: 'middle', wrapText: true };
  const center: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };
  const headerRow = (sheet: ExcelJS.Worksheet, rowNumber: number, headers: string[], widths: number[]): void => {
    headers.forEach((header, i) => {
      const cell = sheet.getCell(rowNumber, i + 1);
      cell.value = header; cell.font = font(11, true, 'FFFFFFFF'); cell.fill = fill(TEAL); cell.alignment = center; cell.border = box;
      sheet.getColumn(i + 1).width = widths[i];
    });
    sheet.getRow(rowNumber).height = 30;
  };
  const newSheet = (title: string): ExcelJS.Worksheet => workbook.addWorksheet(title, { views: [{ rightToLeft: true }] });

  // ================================================================ 1. תמונת מצב
  const overview = workbook.addWorksheet('תמונת מצב', { views: [{ rightToLeft: true, showGridLines: false }] });
  [46, 16, 70].forEach((width, i) => { overview.getColumn(i + 1).width = width; });
  overview.mergeCells('A1:C1');
  overview.getCell('A1').value = excelSafe(`תוצאות קמפיין – ${campaign.name}`);
  overview.getCell('A1').font = font(20, true, TEAL); overview.getCell('A1').alignment = right; overview.getRow(1).height = 34;
  const stamp = israelWallClock((input.generatedAt ?? new Date()).toISOString()) as Date;
  const pad = (n: number): string => String(n).padStart(2, '0');
  overview.mergeCells('A2:C2');
  overview.getCell('A2').value = `הנתונים נכונים ל-${pad(stamp.getUTCDate())}.${pad(stamp.getUTCMonth() + 1)}.${stamp.getUTCFullYear()} בשעה ${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())} (שעון ישראל)`;
  overview.getCell('A2').font = font(11, false, GREY); overview.getCell('A2').alignment = right;
  let row = 4;
  const section = (title: string): void => {
    overview.mergeCells(row, 1, row, 3);
    const cell = overview.getCell(row, 1);
    cell.value = title; cell.font = font(13, true, 'FFFFFFFF'); cell.fill = fill(TEAL); cell.alignment = right;
    overview.getRow(row).height = 26; row += 1;
  };
  const metric = (name: string, value: number | string, note: string): void => {
    const a = overview.getCell(row, 1); a.value = excelSafe(name); a.font = font(12, true); a.alignment = right; a.border = box; a.fill = fill(LIGHT);
    const b = overview.getCell(row, 2); b.value = value; b.font = font(20, true, TEAL); b.alignment = center; b.border = box;
    const c = overview.getCell(row, 3); c.value = note; c.font = font(10, false, GREY); c.alignment = right; c.border = box;
    overview.getRow(row).height = 36; row += 1;
  };
  section('כניסות');
  metric('נכנסו לקמפיין', total, 'אנשים שונים (כל מספר טלפון נספר פעם אחת).');
  metric('אנשי קשר שנשמרו', savedPeople, 'אנשי קשר שהמערכת שמרה.');
  if (emailPeople.size || list.some((person) => person.results.some((result) => result.email))) {
    metric('מסרו כתובת מייל', list.filter((person) => person.results.some((result) => result.email)).length, 'כתובות מייל תקינות. הרשימה בלשונית "כתובות מייל".');
  }
  row += 1;
  section('מה עשו בתהליך');
  metric('ענו או לחצו על שאלה', answeredAny.size, 'לפחות תשובה או לחיצה אחת.');
  if (scoreCount) metric(`ענו על כל ${scoreCount} שאלות הניקוד`, list.filter((person) => (scoreAnswered.get(person.phone)?.size ?? 0) >= scoreCount).length, 'שאלות שנותנות ניקוד.');
  if (scored.length) metric('ממוצע ניקוד', Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10, 'בין מי שיש לה ניקוד.');
  metric('סיימו את כל התהליך', completedPeople.size, 'הגיעו לשלב האחרון בקמפיין.');
  if (groupJoin.size) metric('ביקשו להצטרף לקבוצה', groupJoin.size, 'בקשות צירוף שנשלחו למנהלת.');
  if (humanHandoff.size) metric('עברו למענה אנושי', humanHandoff.size, 'ביקשו נציג או שלחו שאלה חופשית.');
  row += 1;
  if (raffleList.length) {
    section(raffleList.length > 1 ? 'הגרלות (כל הלינקים ביחד)' : 'הגרלה');
    raffleList.forEach(([label, map], i) => metric(`הגרלה ${raffleList.length > 1 ? String.fromCharCode(0x5d0 + i) + ': ' : ''}${shortTitle(label, 40)}`, map.size, 'אנשים שונים שנכנסו להגרלה.'));
    if (raffleList.length > 1) metric('זכאים לפחות להגרלה אחת', inAnyRaffle.size, 'אנשים שונים, בלי כפילויות.');
    row += 1;
  }
  overview.mergeCells(row, 1, row, 3);
  const noteCell = overview.getCell(row, 1);
  noteCell.value = `המספרים כוללים כל מי שנכנסה לקמפיין, כולל מספרי בדיקה אם היו. פירוט נוסף בלשונית "הסברים".${input.note ? ` ${input.note}` : ''}`;
  noteCell.font = font(10, false, GREY, true); noteCell.alignment = right; overview.getRow(row).height = input.note ? 58 : 30;

  // ================================================================ 2. הגרלות
  if (raffleList.length) {
    const sheet = newSheet('הגרלות');
    sheet.mergeCells('A1:' + String.fromCharCode(65 + 2 + raffleList.length * 2) + '1');
    sheet.getCell('A1').value = 'זכאים להגרלות'; sheet.getCell('A1').font = font(16, true, TEAL);
    const headers = ['#', 'שם', 'טלפון'];
    raffleList.forEach(([label], i) => { headers.push(`הגרלה ${String.fromCharCode(0x5d0 + i)}: ${shortTitle(label, 28)}`, 'מועד הכניסה'); });
    headerRow(sheet, 3, headers, [6, 34, 18, ...raffleList.flatMap(() => [26, 20])]);
    const entrants = list.filter((person) => inAnyRaffle.has(person.phone));
    const firstRaffle = (person: Person): string => raffleList.map(([, map]) => map.get(person.phone)).filter((t): t is string => Boolean(t)).sort()[0];
    entrants.sort((a, b) => firstRaffle(a).localeCompare(firstRaffle(b)));
    entrants.forEach((person, i) => {
      const values: Array<string | number | Date | null> = [i + 1, excelSafe(person.name), person.phone];
      raffleList.forEach(([, map]) => { const t = map.get(person.phone); values.push(t ? 'כן' : 'לא', t ? israelWallClock(t) : null); });
      values.forEach((value, c) => {
        const cell = sheet.getCell(4 + i, c + 1);
        cell.value = value as ExcelJS.CellValue; cell.font = font(11); cell.border = box;
        cell.alignment = c === 0 || (c >= 3 && c % 2 === 1) ? center : right;
        if (c >= 3 && c % 2 === 0) cell.numFmt = DATE_FORMAT;
        if (c === 2) cell.numFmt = '@';
        if (c >= 3 && c % 2 === 1 && value === 'כן') cell.fill = fill(GREEN);
      });
    });
    sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 3 }];
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + Math.max(1, entrants.length), column: headers.length } };
  }

  // ================================================================ 3. משתתפות
  const participants = newSheet('משתתפות');
  const pHeaders = ['#', 'שם', 'טלפון', 'מועד הכניסה', 'עד איפה הגיעה', 'נשמרה במערכת'];
  const pWidths = [6, 34, 18, 20, 52, 14];
  if (scoreCount) { pHeaders.push(`שאלות ניקוד שנענו (מתוך ${scoreCount})`, 'ניקוד'); pWidths.push(18, 10); }
  raffleList.forEach(([label], i) => { pHeaders.push(`הגרלה ${String.fromCharCode(0x5d0 + i)}`); pWidths.push(11); void label; });
  headerRow(participants, 1, pHeaders, pWidths);
  list.forEach((person, i) => {
    const values: Array<string | number | Date | null> = [i + 1, excelSafe(person.name), person.phone, israelWallClock(person.firstEntry), stageOf(person), person.results.some((r) => r.status === 'saved') ? 'כן' : 'לא'];
    if (scoreCount) values.push(scoreAnswered.get(person.phone)?.size ?? 0, scoreSum[i] ?? '');
    raffleList.forEach(([, map]) => values.push(map.has(person.phone) ? 'כן' : 'לא'));
    values.forEach((value, c) => {
      const cell = participants.getCell(2 + i, c + 1);
      cell.value = value as ExcelJS.CellValue; cell.font = font(11); cell.border = box;
      cell.alignment = c === 0 || c === 5 || c >= 6 ? center : right;
      if (c === 3) cell.numFmt = DATE_FORMAT;
      if (c === 2) cell.numFmt = '@';
      if (value === 'כן' && c >= 6 + (scoreCount ? 2 : 0)) cell.fill = fill(GREEN);
    });
  });
  participants.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  participants.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + Math.max(1, list.length), column: pHeaders.length } };

  // ================================================================ 4. כתובות מייל
  const mails = newSheet('כתובות מייל');
  headerRow(mails, 1, ['#', 'שם', 'טלפון', 'כתובת מייל', 'מועד קליטת המייל'], [6, 34, 18, 36, 22]);
  const mailRows = list.flatMap((person) => {
    const withMail = person.results.find((result) => result.email);
    return withMail ? [{ person, email: withMail.email as string, at: withMail.emailCollectedAt }] : [];
  }).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  mailRows.forEach((item, i) => {
    [i + 1, excelSafe(item.person.name), item.person.phone, excelSafe(item.email), israelWallClock(item.at)].forEach((value, c) => {
      const cell = mails.getCell(2 + i, c + 1);
      cell.value = value as ExcelJS.CellValue; cell.font = font(11); cell.border = box; cell.alignment = right;
      if (c === 4) cell.numFmt = DATE_FORMAT;
      if (c === 2) cell.numFmt = '@';
    });
  });
  if (!mailRows.length) {
    mails.mergeCells('A3:E3');
    mails.getCell('A3').value = 'בקמפיין הזה לא נאספו כתובות מייל. כשקמפיין אוסף מיילים, הם יופיעו כאן.';
    mails.getCell('A3').font = font(11, false, GREY, true);
  } else {
    mails.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    mails.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + mailRows.length, column: 5 } };
  }

  // ================================================================ 5. משפך
  const funnel = newSheet('משפך');
  funnel.mergeCells('A1:D1');
  funnel.getCell('A1').value = 'כמה הגיעו לכל שלב'; funnel.getCell('A1').font = font(16, true, TEAL);
  headerRow(funnel, 3, ['שלב', 'כמה אנשים', 'אחוז מהנכנסים', 'תרשים'], [62, 14, 16, 34]);
  const funnelRows: Array<[string, number]> = [['נכנסו לקמפיין', total]];
  flow.forEach((step, index) => {
    if (step.kind === 'contact_card' && !reached[index].size) return;   // the contact card is not logged as a step
    const title = shortTitle(step.text || step.kind, 55);
    funnelRows.push([`שלב ${index + 1} – קיבלו: ${title}`, reached[index].size]);
    if (step.kind === 'question' || step.kind === 'score_question') funnelRows.push([`שלב ${index + 1} – ענו או לחצו`, answeredStep[index].size]);
  });
  funnelRows.push(['סיימו את כל התהליך', completedPeople.size]);
  raffleList.forEach(([label, map]) => funnelRows.push([`נכנסו להגרלה: ${shortTitle(label, 45)}`, map.size]));
  funnelRows.forEach(([name, count], i) => {
    const r = 4 + i;
    const share = total ? count / total : 0;
    [name, count, share, share].forEach((value, c) => {
      const cell = funnel.getCell(r, c + 1);
      cell.value = c === 0 ? excelSafe(value) : (value as number); cell.border = box; cell.alignment = c === 0 ? right : center; cell.font = font(c === 1 ? 12 : 11, c === 1);
      if (c === 2) cell.numFmt = '0%';
      if (c === 3) cell.numFmt = ';;;';
    });
    funnel.getRow(r).height = 24;
  });
  funnel.addConditionalFormatting({
    ref: `D4:D${3 + funnelRows.length}`,
    rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF2A9D8F' }, gradient: false } as unknown as ExcelJS.DataBarRuleType],
  });

  // ================================================================ 6. הסברים
  const notes = newSheet('הסברים');
  notes.getColumn(1).width = 34; notes.getColumn(2).width = 100;
  notes.getCell('A1').value = 'הסברים'; notes.getCell('A1').font = font(16, true, TEAL);
  const glossary: Array<[string, string]> = [
    ['נכנסו לקמפיין', 'אדם ששלח את משפט הפתיחה. כל מספר טלפון נספר פעם אחת, גם אם שלח את ההודעה כמה פעמים.'],
    ['אנשי קשר שנשמרו', 'אנשים שהמערכת שמרה כאיש קשר. זה לא קשור למה שהמשתתפת עצמה שמרה בטלפון.'],
    ['ענו או לחצו על שאלה', 'אדם שלחץ על כפתור או ענה לפחות פעם אחת על שאלה בתהליך.'],
    ['עד איפה הגיעה', 'השלב המתקדם ביותר שהמשתתפת הגיעה אליו, לפי מספר השלב בלשונית "משפך".'],
    ['הגרלות', 'מי שלחצה על כפתור שמסומן בקמפיין ככניסה להגרלה. ההגרלות נספרות על כל הנכנסים לקמפיין, בלי כפילויות.'],
    ['מספרי בדיקה', 'הספירה כוללת גם מספרי בדיקה אם נכנסו לקמפיין.'],
    ['שעות', 'כל התאריכים והשעות בלשוניות הראשונות הם לפי שעון ישראל.'],
    ['לשוניות "טכני"', 'לשימוש מי שרוצה לצלול לפרטים או לייצא למערכת אחרת: מדדים, לחיצות, היסטוריית שלבים, כל האירועים וכל הנתונים. השעות שם ב-UTC.'],
  ];
  glossary.forEach(([term, text], i) => {
    const a = notes.getCell(3 + i, 1); a.value = term; a.font = font(11, true); a.alignment = right; a.border = box; a.fill = fill(LIGHT);
    const b = notes.getCell(3 + i, 2); b.value = text; b.font = font(11); b.alignment = right; b.border = box;
    notes.getRow(3 + i).height = 34;
  });
}
