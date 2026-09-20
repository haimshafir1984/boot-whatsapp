# שלב B — Outbox הוגן, סיווג תוצאה לא-ודאית, timeout: תוצאות (2026-09-20)

> **⚠ תיקון (2026-09-20) — מספרי ה-JSON במסמך זה אינם מייצגים ייצור.**
> מדידה על PostgreSQL אמיתי (לקוחות על PG; `LOAD_BACKEND=pg`, `docs/results-data/load-ab-pg-2026-09-20.json`, 5 ריצות נקיות לכל צד, mixed) מראה: **Focus 2,908ms · small-a 2,629ms · small-b 2,624ms** (HEAD). לעומת JSON: 6,091 / 12,822 / 13,463ms.
> כלומר **~13 השניות של הקמפיינים הקטנים היו ארטיפקט של backend ה-JSON של הפיקסצ'ר**; הפער "פי 2.1 בין הקטנים לפוקוס" התהפך (הקטנים מהירים יותר בכ-10%). גם הייחוס "96–98% מההמתנה בצד השער" היה שגוי: על PG חלק השער הוא **~59% אצל Focus ו-~84% אצל הקטנים**.
> מספרי ה-JSON מטה נשמרו כהיסטוריה — **אל תצטטו אותם כביצועי ייצור.**
> **סייגים גם למספרי ה-PG:** הפיקסצ'ר מקומי (לא חומרת ייצור), ועדיין **אינו מפעיל את ה-Outbox dispatcher**; השער בו עדיין JSON (כמו בייצור — אין לו שורות outbox).

HEAD `0ea8d26` (נבדק בתחילת הסבב). שינויים ב-working tree בלבד — **לא בוצע commit / push / פריסה**. PostgreSQL אמיתי (18.6, `localhost:5433/flowsbiz_test_18`) שימש לכל בדיקות ה-DB; לא נגעתי ב-16.14 על 5432. הסיסמה לא הודפסה ולא נכתבה לשום קובץ (המשתנה נטען לתוך תהליכי הבדיקה בלבד).

## 0. תקציר

| | |
|---|---|
| קוד B (6.1, 6.3, 6.2, timeout — בסדר הזה) | **מומש ונבדק** |
| רגרסיה מלאה (55 סוויטות, עם PG, ללא SKIP) | 54 עברו, 0 נכשלו, 1 BLOCKED (בדיקת ה-PG של כלי הגיבוי משלב A, לא קשורה ל-B); `test-email-export` עבר רק בניסיון שני (flake קיים, ראו 1.2) |
| mutation מחייב (2 הגנות) | **נתפסו כולן**, הקבצים הוחזרו בדיוק (SHA-256). M1a נתפס רק דרך נעילה/timeout, לא דרך אסרשן — ראו 6 |
| **התחזית הרשומה מראש** | **הופרכה** — B לא הוריד את זמני הקמפיינים הקטנים (ראו 3). הסיבה נמצאה במקום אחר |
| מוכן לפריסה? | **לא.** יש 3 החלטות התנהגות בייצור שדורשות אישור ופער אחד חוסם (אין נתיב מנהל לפתרון הודעה `uncertain`) — סעיף 8 |

## 1. שלב 0 — baseline אמין

### 1.1 רגרסיה על HEAD עם PostgreSQL (לפני שינוי קוד) — `docs/results-data/regression-head-pg.*`
- **7 הבדיקות שדולגו ב-`test-silent-data-loss-fixes` רצות עכשיו ועוברות** (PASS, 49.6s, אפס SKIP). התיקון לדוח שלב A: הטענה "49/49" נכונה רק כשיש PG.
- **0 כשלים אמיתיים ב-HEAD.** נמצאו שני דברים שאינם באג במוצר, פירוט להלן.

### 1.2 שני פגמים בבדיקות שנמצאו על HEAD
| בדיקה | תסמין | סיבה שנמצאה | טיפול |
|---|---|---|---|
| `test-referral-ranking` (0.2) | מדפיס "passed" ואינו יוצא (timeout 240s) | **באג ניקוי בבדיקה, לא בקוד המוצר.** תרחיש ה-"tie" משאיר שיחה פתוחה של `972500001099` עם timer של 30 דקות (`getActiveResourcesInfo` → `Timeout:1`, ורישום `conversationState.map` → `whatsapp:972500001099:decision:timer 1800000`). כל שאר הטלפונים נוקו | שורה אחת: `conversationState.remove('whatsapp:972500001099')`. עכשיו יוצאת תוך 0.4s, exit 0. (~20 דקות מתוך ה-30 שהוקצו) |
| `test-email-export` | ב-~1 מתוך 6 הרצות: מדפיס "tests passed" ואז קורס בסגירה (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`, exit `-1073740791`) | flake בסגירת התהליך (libuv, Windows/Node 24), אחרי שהבדיקה סיימה. **הסיבה הראשונית לא נחקרה**; נמדד: 1/6 בהרצה חוזרת, ו-2 מתוך 4 הרצות רגרסיה מלאות | ה-runner מריץ אותו עד 3 פעמים ומדווח `PASS-FLAKY` בגלוי (ולא PASS שקט). מסומן ב-manifest `# flaky-teardown` |

### 1.3 baseline נקי ל-mixed (0.3) — `docs/baseline-2026-09-20/baseline-mixed-clean.json`
כלל שנקבע לפני המדידה: ריצה עם אירוע `[META_GATEWAY_CLIENT_SKIPPED]` = **מזוהמת**; נשמרת ומדווחת, אך מוצאת מהסט. נאספו 5 ריצות נקיות (1,2,3,5,6); **ריצה 4 מזוהמת: 123 אירועי SKIP** על שלושת הלקוחות (focus, small-a, small-b), ה-median המשולב שלה 7216ms → exit 1 על סף ה-7s.

**כמה פעמים ה-SKIP ירה** (רק ריצות שבהן נספר, מהלוג של ה-runner):

| קבוצת ריצות | ריצות | מזוהמות | אירועי SKIP |
|---|---|---|---|
| baseline נקי (mixed) | 7 | 1 (ריצה 4) | 123 |
| A/B mixed — HEAD | 7 | 1 (ריצה 2) | 41 |
| A/B mixed — B | 6 | 0 | 0 |
| A/B single (120 Focus) — HEAD | 7 | 1 (ריצה 4) | 2 |
| A/B single — B | 6 | 0 | 0 |
| **סה"כ** | **33** | **3 (9%)** | **166** |

בנוסף: ריצה 4 של ה-baseline הראשון (לפני הרחבת ה-runner) הראתה שורות SKIP, אך **המספר לא נשמר** — לא נספר כאן. כשהאירוע קורה הוא מכה בדרך כלל בהרבה הודעות בריצה אחת (123 ו-41 ב-mixed; רק 2 ב-single).
**מנגנון (מהקוד, `src/adminServer.ts:1695-1723` + `fetchRoutesForClient`)**: ה-fetch של `/owner-api/meta-routes` מוגבל ל-3s (`AbortSignal.timeout(3000)`); כשלקוח עמוס לא עונה בזמן, `AsyncExpiringCache.get` מוחק את הרשומה בכשל, ההודעות הבאות מקבלות `unavailable` וה-fail-closed חוסם. **הסתייגות:** בפיקסצ'ר השער וכל הלקוחות רצים באותו תהליך Node, ולכן קפיצות event-loop מנופחות ביחס לייצור; שכיחות 9% אינה הערכה לייצור. הפגם (#4) **אינו מתוקן כאן** (קוד שער, מחוץ ל-B).

## 2. התחזית הרשומה מראש (נכתבה לפני מימוש; נשארת כלשונה)

נתוני HEAD, תרחיש mixed (baseline ראשון, לא נקי): focus median 6091ms, small-a 12822ms, small-b 13463ms — הקטנים איטיים פי ~2.1. אומת: `BOT_REPLY_DELAY_MS=0`, הקמפיינים הקטנים נוצרים מאותו `makeCampaign` כמו פוקוס; אין השהיה שמבדילה ביניהם.
- **השערה:** מחסום האצווה — `await Promise.all(eligible)` יחד עם בחירת עד 20 ראשי-תור הישנים ביותר — גורם לקטנים להמתין מאחורי אצוות מלאות של פוקוס.
- **תחזית:** אחרי 6.2 (מאגר עובדים + wake-up) חציוני small-a/small-b יירדו משמעותית ו-focus יישאר דומה או ישתפר מעט.
- **הפרכה:** אם אחרי B הקטנים עדיין ~13 שניות — B לא תיקן; אסור לטעון שכן.
- (נרשם באותו רגע כהסתייגות: פיקסצ'ר העומס משתמש בשליחה ישירה, לא ב-`startOutboxDispatcher`.)

## 3. תוצאת התחזית: **הופרכה**

**[JSON בלבד — ארטיפקט, לא ייצור]** **הקטנים נשארו ~13 שניות.** מדידה מתחלפת (HEAD/B לסירוגין, 5 ריצות נקיות כל צד; חציון-של-חציונים, ms):

| קבוצה | HEAD (A) | B | B מול A (median / p95) |
|---|---|---|---|
| focus | 6679 | 6131 | −8.2% / −0.6% |
| small-a | 13573 | 12984 | −4.3% / −2.8% |
| small-b | 13876 | 13634 | −1.7% / −3.9% |
| baileys | 2212 | 1748 | −21% / −21% |

זה בתוך הרעש (טווחי החציון בין ריצות: focus 5008–6913 ב-A, 5400–6811 ב-B). אין ירידה משמעותית של הקטנים.

**מדוע — ומה כן נמצא (ממצאים, מנוסחים כמה שנבדק):**
1. **הפיקסצ'ר אינו מפעיל את ה-Outbox dispatcher כלל** (`startOutboxDispatcher` נקרא רק מ-`src/index.ts` ומבדיקות ייעודיות). ההשערה על מחסום האצווה לא יכולה להסביר את ה-13s בתרחיש הזה — שיפור ב-B לא יכול להופיע בו. (נבדק ב-grep, לא רק מוסק.)
2. **פיצול ההמתנה לשני שלבים** (הרחבת הפיקסצ'ר, 3 ריצות על B): **[JSON בלבד; על PG: שער ~84% אצל הקטנים, ~59% אצל Focus]** אצל הקטנים **96–98% מההמתנה = trigger → הגעת ההודעה ללקוח (צד השער)**: 13.3–16.0s; צד הלקוח (הגעה → תשובה ראשונה) 0.3–0.7s. אצל פוקוס: שער 4.2–5.5s, לקוח 1.2–1.3s.
3. **הסיבה הסבירה: סדר ההגעה.** הפיקסצ'ר שולח את המערך `[100 פוקוס, 25 קטן-א, 25 קטן-ב]` במקביל, והשער מנקז עם `maxConcurrentSenders=50` — הקטנים תמיד בסוף התור. **ניסוי בקרה** (`LOAD_ARRIVAL=interleaved`, 3 ריצות, הגעה משולבת): שלוש הקבוצות מקבלות חציון דומה — focus 7.1–9.8s, small-a 6.7–8.9s, small-b 6.7–9.0s (gateway leg 5.6–8.5s לכולן).
   **[JSON בלבד — על PG הפער התהפך: הקטנים מהירים יותר]** כלומר "×2.1" הוא **אפקט תור FIFO בשער + סדר הגעה בפיקסצ'ר**, לא רעב לפי סוג קמפיין ולא ה-Outbox. **השערת ה-fixture בטענת המשתמש ("אין הבדל בין הקמפיינים") נכונה לגבי השהיות/הגדרות, אך סדר ההגעה הוא תכונה של הפיקסצ'ר שלא נבדקה קודם.**
4. **מה שכן מוסבר בפועל ב-B:** איכות ה-Outbox נבדקת ונמדדת בבדיקות ייעודיות (סעיף 5), לא בעומס. ההשפעה של B על זמן-תגובה ראשונה של משתתף בייצור **לא נמדדה ואין לטעון עליה**.
5. **משמעות ל-D:** זמן ההמתנה הדומיננטי נמצא בשער (תור + fan-out לכל הלקוחות). זה בהיקף שלב D; לא נגעתי בו.

## 4. כל 5 הריצות (נקיות) — ובנוסף warm-up וריצות מזוהמות

זמנים ב-ms, trigger → תשובה ראשונה, לפי קבוצה. `exit 1` = כשל בסף החציון המשולב של 7s (תצפית בלבד, לא שער; מסומן). נתונים גולמיים: `docs/results-data/load-ab-*.json`, `docs/baseline-2026-09-20/baseline-mixed-clean.json`.

### mixed A (HEAD)
| עץ | ריצה | קבוצה | median | p95 | p99 | max |
|---|---|---|---|---|---|---|
| A | warm-up (נזרק) | focus | 6171 | 7879 | 7892 | 7892 |
| A | warm-up (נזרק) | small-a | 12814 | 13114 | 13124 | 13124 |
| A | warm-up (נזרק) | small-b | 13368 | 13937 | 13973 | 13973 |
| A | warm-up (נזרק) | baileys | 1675 | 1969 | 1992 | 1992 |
| A | run1 (exit 1) | focus | 5008 | 7463 | 7476 | 7476 |
| A | run1 (exit 1) | small-a | 13257 | 14597 | 14606 | 14606 |
| A | run1 (exit 1) | small-b | 13876 | 14163 | 14173 | 14173 |
| A | run1 (exit 1) | baileys | 1647 | 1972 | 1994 | 1994 |
| A | run2 **מזוהמת (41 SKIP)** (exit 1) | focus | 5706 | 7958 | 8620 | 8620 |
| A | run2 **מזוהמת (41 SKIP)** (exit 1) | small-a | 14467 | 15014 | 15026 | 15026 |
| A | run2 **מזוהמת (41 SKIP)** (exit 1) | small-b | 15239 | 15885 | 15897 | 15897 |
| A | run2 **מזוהמת (41 SKIP)** (exit 1) | baileys | 2191 | 2575 | 2601 | 2601 |
| A | run3 (exit 1) | focus | 6679 | 8186 | 8201 | 8201 |
| A | run3 (exit 1) | small-a | 13573 | 13669 | 13677 | 13677 |
| A | run3 (exit 1) | small-b | 13868 | 14480 | 14494 | 14494 |
| A | run3 (exit 1) | baileys | 2212 | 2589 | 2614 | 2614 |
| A | run4 (exit 1) | focus | 6913 | 7836 | 7849 | 7849 |
| A | run4 (exit 1) | small-a | 14045 | 14355 | 14364 | 14364 |
| A | run4 (exit 1) | small-b | 13975 | 14686 | 14694 | 14694 |
| A | run4 (exit 1) | baileys | 2229 | 2588 | 2613 | 2613 |
| A | run5 (exit 1) | focus | 6276 | 7204 | 8006 | 8006 |
| A | run5 (exit 1) | small-a | 12980 | 13889 | 13926 | 13926 |
| A | run5 (exit 1) | small-b | 13623 | 13904 | 13913 | 13913 |
| A | run5 (exit 1) | baileys | 1721 | 2006 | 2029 | 2029 |
| A | run6 (exit 1) | focus | 6787 | 8333 | 8344 | 8344 |
| A | run6 (exit 1) | small-a | 13964 | 14073 | 14083 | 14083 |
| A | run6 (exit 1) | small-b | 14273 | 14863 | 14880 | 14880 |
| A | run6 (exit 1) | baileys | 2221 | 2603 | 2631 | 2631 |

### mixed B
| B | warm-up (נזרק) | focus | 6907 | 7625 | 8428 | 8428 |
| B | warm-up (נזרק) | small-a | 13463 | 14322 | 14330 | 14330 |
| B | warm-up (נזרק) | small-b | 14047 | 14345 | 14355 | 14355 |
| B | warm-up (נזרק) | baileys | 2247 | 2557 | 2579 | 2579 |
| B | run1 (exit 1) | focus | 6811 | 8219 | 8230 | 8230 |
| B | run1 (exit 1) | small-a | 13585 | 13677 | 13684 | 13684 |
| B | run1 (exit 1) | small-b | 13932 | 14521 | 14530 | 14530 |
| B | run1 (exit 1) | baileys | 2208 | 2593 | 2622 | 2622 |
| B | run2 | focus | 6008 | 7792 | 7806 | 7806 |
| B | run2 | small-a | 12790 | 13076 | 13087 | 13087 |
| B | run2 | small-b | 13425 | 13882 | 13891 | 13891 |
| B | run2 | baileys | 1646 | 1934 | 1957 | 1957 |
| B | run3 (exit 1) | focus | 6801 | 8233 | 8246 | 8246 |
| B | run3 (exit 1) | small-a | 13612 | 13708 | 13717 | 13717 |
| B | run3 (exit 1) | small-b | 13975 | 14575 | 14584 | 14584 |
| B | run3 (exit 1) | baileys | 2220 | 2601 | 2625 | 2625 |
| B | run4 (exit 1) | focus | 5400 | 7567 | 8240 | 8240 |
| B | run4 (exit 1) | small-a | 12984 | 13907 | 13916 | 13916 |
| B | run4 (exit 1) | small-b | 13634 | 13732 | 13848 | 13848 |
| B | run4 (exit 1) | baileys | 1748 | 2051 | 2078 | 2078 |
| B | run5 | focus | 6131 | 7503 | 7516 | 7516 |
| B | run5 | small-a | 12149 | 13104 | 13113 | 13113 |
| B | run5 | small-b | 13361 | 13920 | 13953 | 13953 |
| B | run5 | baileys | 1738 | 2030 | 2055 | 2055 |

### baseline clean
| BASE | warm-up (נזרק) | focus | 5181 | 6435 | 6449 | 6449 |
| BASE | warm-up (נזרק) | small-a | 11310 | 11400 | 11612 | 11612 |
| BASE | warm-up (נזרק) | small-b | 11663 | 12023 | 12033 | 12033 |
| BASE | warm-up (נזרק) | baileys | 1551 | 1795 | 1813 | 1813 |
| BASE | run1 | focus | 5439 | 6833 | 6844 | 6844 |
| BASE | run1 | small-a | 12078 | 12267 | 12275 | 12275 |
| BASE | run1 | small-b | 11999 | 12312 | 12320 | 12320 |
| BASE | run1 | baileys | 1690 | 2015 | 2038 | 2038 |
| BASE | run2 | focus | 5248 | 6646 | 6658 | 6658 |
| BASE | run2 | small-a | 12064 | 12263 | 12271 | 12271 |
| BASE | run2 | small-b | 11979 | 12311 | 12320 | 12320 |
| BASE | run2 | baileys | 1458 | 1701 | 1719 | 1719 |
| BASE | run3 | focus | 5475 | 6796 | 6808 | 6808 |
| BASE | run3 | small-a | 11280 | 12179 | 12189 | 12189 |
| BASE | run3 | small-b | 12089 | 12641 | 12650 | 12650 |
| BASE | run3 | baileys | 1570 | 1832 | 1851 | 1851 |
| BASE | run4 **מזוהמת (123 SKIP)** (exit 1) | focus | 6237 | 7297 | 7311 | 7311 |
| BASE | run4 **מזוהמת (123 SKIP)** (exit 1) | small-a | 13727 | 14276 | 14285 | 14285 |
| BASE | run4 **מזוהמת (123 SKIP)** (exit 1) | small-b | 14393 | 14545 | 14555 | 14555 |
| BASE | run4 **מזוהמת (123 SKIP)** (exit 1) | baileys | 1670 | 1951 | 1971 | 1971 |
| BASE | run5 | focus | 6105 | 7624 | 7637 | 7637 |
| BASE | run5 | small-a | 12834 | 13128 | 13138 | 13138 |
| BASE | run5 | small-b | 13327 | 13918 | 13934 | 13934 |
| BASE | run5 | baileys | 1706 | 2011 | 2039 | 2039 |
| BASE | run6 (exit 1) | focus | 6671 | 8340 | 8353 | 8353 |
| BASE | run6 (exit 1) | small-a | 13349 | 14255 | 14265 | 14265 |
| BASE | run6 (exit 1) | small-b | 13978 | 14284 | 14296 | 14296 |
| BASE | run6 (exit 1) | baileys | 1716 | 2011 | 2044 | 2044 |

### single
| A | warm-up (נזרק) | focus | 6767 | 12725 | 13506 | 13511 |
| A | run1 | focus | 5437 | 11617 | 11640 | 11645 |
| A | run2 | focus | 5248 | 11240 | 11630 | 11635 |
| A | run3 | focus | 5443 | 11630 | 11647 | 11652 |
| A | run4 **מזוהמת (2 SKIP)** | focus | 5190 | 12519 | 12717 | 12915 |
| A | run5 | focus | 5398 | 11586 | 11601 | 11602 |
| A | run6 | focus | 5386 | 11553 | 11578 | 11583 |
| B | warm-up (נזרק) | focus | 5525 | 11639 | 11659 | 11664 |
| B | run1 | focus | 5311 | 11754 | 11776 | 11783 |
| B | run2 | focus | 5843 | 12263 | 12587 | 12594 |
| B | run3 | focus | 5143 | 11173 | 11551 | 11556 |
| B | run4 | focus | 5478 | 11596 | 11620 | 11625 |
| B | run5 | focus | 5165 | 11156 | 11563 | 11568 |



### 4.1 הערכת סבילות (סבילות שנקבעה מראש: חציון +10%, p95 +15%)

| השוואה | focus median / p95 | small-a | small-b | baileys |
|---|---|---|---|---|
| **B מול HEAD המתחלף (בקרה במקביל)** | −8.2% / −0.6% | −4.3% / −2.8% | −1.7% / −3.9% | −21% / −21% |
| B מול baseline נקי קודם (עצמאי) | **+12.0%** / +14.0% | +7.5% / +11.5% | **+12.8%** / +10.1% | +3.4% / +2.0% |
| HEAD המתחלף מול אותו baseline | +22.0% / +14.7% | +12.4% / +14.7% | +14.8% / +14.5% | +30.9% / +28.7% |
| single (120 Focus): B מול A | median 5311 מול 5398 (−1.6%), p95 11596 מול 11586 (+0.1%) | | | |

**פסיקה, בלי לייפות:** מול **בקרה מקבילה** אין נסיגה. מול ה-baseline העצמאי שנקבע מראש, שני ערכי חציון חורגים מ-+10% (focus +12.0%, small-b +12.8%) — **אבל HEAD עצמו, ללא שינוי, חורג יותר באותה מדידה** (+22%, +14.8%), כלומר המכונה איטית יותר כעת (drift). את הסיבה לדריפט (חום/רקע) לא בודדתי. לכן: **לא הוכחה נסיגה בגלל B; ההשוואה הפורמלית מול ה-baseline הישן אינה עוברת בשני ערכים, והסיבה סביבתית ואינה מוכחת.** p99/max: ב-focus +2.8% מול A (בתוך הרעש); לא נמצא >+25%.
מדידה מקבילה נבחרה לפני שראיתי תוצאות B (סיבה: דריפט של 5.2s→6.7s נצפה כבר בתוך ה-baseline הנקי).

## 5. דרישה → מימוש → בדיקה → תוצאה

| # | דרישה (סעיף 6) | מימוש | בדיקה | תוצאה |
|---|---|---|---|---|
| 6.1 | סינון זכאות **לפני** LIMIT | `Storage.getPendingOutboxMessages(limit, now, _, isBlocked)`: ראשי-תור לכל נמען (בלי לדלג על הודעה קודמת), אחר כך `claimable` ו-`isBlocked`, ורק אז `slice`. הדיספצ'ר מעביר `isHeldForReview` | `test-outbox-fairness.js` (8): 0/1/20/100 חסומים לפני 5 תקינים — התקינים נשלחים במחזור הראשון, החסומים `queued` עם `attempts=0`; שאילתת storage; ראש חסום לא מדולג; head ב-retry לא נעקף | עובר. **על עותק HEAD נכשלים 5 מתוך 8** (20 ו-100 חסומים, שאילתה, ראש חסום, בדיקת claim) — הפגם הקיים אומת |
| 6.1 | hold סמוך ל-claim, בלי צריכת ניסיון | `dispatchMessage` בודק `isHeldForReview` לפני `claim`; cooldown קצר למניעת בחירה חוזרת | scenario "hold placed after selection" | עובר |
| 6.1 | ביטול ריצה = `cancelled`, לא retry | לא שונה (`CampaignWorkCancelledError` → failed) | test-outbox-* קיימות + graceful | עובר |
| 6.3 | סיווג אחיד לפני timeout | `src/sendOutcome.ts`: `rejected_permanent / rejected_transient / uncertain`; נצרך ב-dispatcher, `sendBotMessage`, `sendFileWithRetry`, `sendTrackedOutboxMessage`, שערי fallback (`isUncertainOutcome` במקום `instanceof OutboxPersistUncertainError` ב-6 אתרים) ו-`MetaCloudProvider` | `test-outbox-classification.js` (17): dispatcher (uncertain נשלח פעם אחת ולא חוזר, ההודעה התלויה חסומה, אחרים זורמים; permanent→failed; transient→retry + `Retry-After` חסום 10 דק'), Meta (400/429/500/503/408/ECONNREFUSED/ECONNRESET/timeout), flow (טקסט, קובץ, **כפתורים אינטראקטיביים ללא fallback לטקסט**) | עובר; mutation M2a/b — סעיף 6 |
| 6.3 | `MetaCloudProvider.sendFile`: cache עם media ID + ניסיון ראשון עמום | לא מבצע re-upload+resend אחרי `uncertain`; media ID שנדחה (4xx) עדיין מושבת מחדש | scenario ייעודי: POST אחד בלבד | עובר |
| 6.3 | העלאת מדיה: אין מסקנה על שליחת ההודעה | כשל upload תמיד `rejected_transient` | scenario | עובר |
| 6.3 | `processing` ישן אחרי crash אינו הוכחה | `Storage.recoverOrphanedOutboxProcessing`: שורת `processing` שהתהליך הנוכחי לא תבע → `uncertain` (ללא המתנה של 2 דק', ללא reclaim). `isOutboxClaimable` לעולם לא מחזיר true ל-processing | classification (JSON) + **PG אמיתי** | עובר; M2c |
| 6.3 | מצב `uncertain` מתמשך, שורד crash/restart | סטטוס חדש, נשמר דרך `persist(['outboxMessages'])` ו-delta הקיים (ללא מיגרציה: `status` הוא טקסט); `markOutboxUncertain`, `resolveOutboxUncertain(sent\|not_sent)`, `getUncertainOutboxMessages`; `getOutboxHealth().uncertain` | **`test-outbox-uncertain-postgres.js` מול PG 18 אמיתי**: timeout→uncertain→"crash"→restart×2: נשאר uncertain, אפס שליחות, התלוי חסום; `processing` יתום→uncertain במסד; החלטת מפעיל durable | עובר (3/3); נכשל תחת M2a/b/c |
| 6.2 | מאגר עובדים במקום `Promise.all`; 20 נמענים, configurable; נמען סדרתי | `startOutboxDispatcher(..., {concurrency, shutdownWaitMs})`; `OUTBOX_CONCURRENCY` (1..100, ברירת מחדל 20) | `test-outbox-pool.js` (9): worker תקוע אחד לא חוסם 39 אחרים; slot ממוחזר מיד; גבולות; נמען אחד סדרתי; claim ישיר מול dispatcher | עובר |
| 6.2 | wake-up אחרי enqueue, ללא busy-loop | `Storage.onOutboxWake` (setImmediate אחרי enqueue/retry/resolve) + timer ל-`nextAttemptAt`; poll רק גיבוי | scenarios: הודעה מאוחרת נשלחת תוך <500ms; retry נשלח בדיוק ב-`nextAttemptAt` עם ≤8 שאילתות; 25 חסומים → ≤5 שאילתות ב-600ms | עובר |
| 6.2 | backoff רק לכשל retry; `Retry-After` | ראו 6.3 | classification | עובר |
| 6.2 | shutdown: מפסיק לקבל עבודה וממתין זמן מוגדר | `stop()` — `shutdownWaitMs` (ברירת מחדל 30s, `OUTBOX_SHUTDOWN_WAIT_MS`); שליחה שנתקעה נשארת `processing` ותיהפך `uncertain` בהפעלה הבאה | pool scenario + `test-graceful-shutdown` | עובר |
| timeout | timeout מפורש לכל `fetch` ב-`MetaCloudProvider` (כולל קריאת הגוף), **אחרון** | `AbortSignal.timeout`: שליחה 15s (`META_SEND_TIMEOUT_MS`, 1–120s), מדיה 60s (`META_MEDIA_UPLOAD_TIMEOUT_MS`, 1–300s) | `test-meta-timeouts.js` (7): signal בכל fetch, גבולות, POST תקוע→uncertain, upload תקוע→retryable ללא POST, 200 עם גוף שנתקע → מתקבל, 502 עם גוף תקוע → uncertain, **end-to-end: dispatcher + Meta אמיתי + Graph תקוע = בקשה אחת, שורה uncertain, ההמשך חסום, ללא שליחה חוזרת לאורך מחזורי poll** | עובר |
| שימור | dirty tracking / append-only / fail-closed / `META_INBOX_MAX_ATTEMPTS` / handover / `redeployExistingClient` / `campaignWork` | לא נערכו (`adminServer.ts` לא שונה) | רגרסיה מלאה כולל `test-postgres-*`, `test-meta-*`, `test-flush-scoped-wait` | עבר |

## 6. Mutation מחייב (סעיף 8.3) — תוצאה בפועל (`docs/results-data/mutation-stage-b.json`)

הכלי: `scripts/mutation-stage-b.js` — עורך `dist/*.js` (לא `src/`), מריץ, **מחזיר בדיוק ומאמת SHA-256** (כל 5 הוחזרו: `restoredExactly=true`). לא בוצע `git reset`.

| מוטציה | הגנה | בדיקות שנכשלו |
|---|---|---|
| M1a — הסרת הפרדיקט לגמרי | סינון לפני LIMIT | `test-outbox-fairness`: **נתקע** (timeout, exit `null`). **נתפס דרך non-termination**: בלי הפרדיקט הדיספצ'ר בוחר שוב ושוב את החסומים ונכנס ל-spin על microtasks (ה-cooldown חי בתוך אותו פרדיקט). לא דרך אסרשן — ראיה חלשה יותר |
| M1b — LIMIT קודם, סינון אחר כך (סדר HEAD) | סינון לפני LIMIT | `test-outbox-fairness`: **3 scenarios נכשלו** (20 חסומים, 100 חסומים, שאילתת storage) |
| M2a — `classifySendError` מחזיר תמיד transient (retry אחיד) | סיווג uncertain | classification **9**, timeouts **3**, uncertain-postgres **1** |
| M2b — ענף ה-uncertain בדיספצ'ר הוסר | סיווג uncertain | classification 1, timeouts 1, uncertain-postgres 1 |
| M2c — התאוששות יתומי `processing` הוסרה | 6.3 crash | classification 1, uncertain-postgres 1 |

M3 (הסרת בדיקת run/context) שייכת לשלב C ולא בוצעה.

## 7. רגרסיה סופית — `docs/results-data/regression-b-final2.json`
55 סוויטות (49 מהמסמך + backup + 5 של B), ברצף, env מנוקה מסודות, עם `TEST_DATABASE_URL`: **54 עברו** (מהן 1 `PASS-FLAKY`: `test-email-export`, ניסיון ראשון קרס בסגירה, שני עבר), **0 נכשלו**, **1 BLOCKED**: `test-backup-tool.js` — בדיקת ה-round-trip האמיתית של שלב A **עדיין לא נכתבה** (PG כבר זמין; לא נעשה בסבב הזה). 0 סמני SKIP.
שינויי בדיקות קיימות (חוזה, במפורש):
- `test-graceful-shutdown.js`: ה-storage המדומה הורחב ב-4 מתודות (`recoverOrphanedOutboxProcessing`, `onOutboxWake`, `getNextOutboxDueAtMs`, `getOutboxMessage`) — ה-fake התיישן כי הדיספצ'ר תלוי בהן עכשיו; כל ההצהרות המקוריות (stop ממתין לשליחה, אין כתיבה אחרי close) נשמרו ועוברות.
- `test-referral-ranking.js`: שורת ניקוי אחת (1.2).

## 8. שינויי התנהגות בייצור — **דורשים החלטה שלך לפני פריסה**

1. **קוד 5xx / 408 / כשל תעבורה לא-מוסבר של Meta = `uncertain`** (היה: retry). לפי טבלת 6.3, אך תפעולית: תקלת 502/503 רגעית של Graph כבר לא תגרום ל-retry אלא תחנה את המשתתף (`needs_review`) ותשלח התראה קריטית. זה מונע כפילות אבל עלול להיות רועש. אפשר לשנות ל-5xx→retry ב-`classifyHttpStatus` (שורה אחת) אם תבחר.
2. **`processing` יתום אחרי restart = `uncertain`** (היה: reclaim ושליחה אוטומטית אחרי 2 דקות). ב-restart של Swarm כל הודעה שהייתה באמצע שליחה תעצור עד החלטת מנהל.
3. **⛔ פער חוסם: אין נתיב מנהל לפתור הודעה `uncertain`.** `resolveOutboxUncertain` קיים רק ב-`Storage`; `POST /api/needs-review/:jid/resolve` משחרר את ה-hold של השיחה אך **לא נוגע בשורת ה-outbox**, שנשארת "outstanding" וחוסמת claim של כל הודעה עתידית לאותו נמען (רק `cancelOutboxForRecipient` בעת מעבר לקמפיין אחר מנקה אותה). בלי זה משתתף יכול להישאר תקוע גם אחרי שחרור ה-hold. הצעה: להרחיב את ה-endpoint עם `uncertainOutboxAction: sent | not_sent | abandon`. לא ממשתי — שינוי API ותפעול שהחלטתו שלך.
4. שגיאות ללא סיווג (Baileys, Twilio, `Error` רגיל) **ממשיכות להיות retry** כמו היום — סיכון הכפילות נשאר לספקים האלה.
5. ברירות מחדל חדשות: timeout שליחה 15s / מדיה 60s; `OUTBOX_CONCURRENCY=20`; ההמתנה ב-shutdown עד 30s (היום: ללא גבול). `OUTBOX_MAX_MESSAGES_PER_TICK` הוסר (המאגר לא צריך אותו).
6. התראה קריטית **לכל הודעה** uncertain (`outbox-uncertain-<id>`, throttle 30 דק' לכל מפתח) — אפשרי הצפה במייל בתקלה רחבה.

## 9. מה לא הושלם / לא נבדק (במפורש)
- נתיב מנהל/ממשק ל-`uncertain` (8.3), והצגתו בדשבורד/`/health` (ספירת `uncertain` נכללת ב-`getOutboxHealth` אך לא ודאתי שצרכן ה-health מציג אותה).
- פתרון אוטומטי של `uncertain` דרך webhook סטטוס מסירה: אין `providerMessageId` לשורה כזו — **לא ממומש**.
- לא בוצע audit ממצה של כל אתר ב-`messageFlow` שבולע שגיאת שליחה; הרחבתי את 6 שערי ה-`OutboxPersistUncertainError` הקיימים ואת 3 מסלולי השליחה. אתרים אחרים שבולעים שגיאה בלי שער לא נבדקו.
- נתיב השליחה הישיר (`sendBotMessage` וכו') אינו נספר ב-`concurrency` של המאגר.
- **ביצועים לא נמדדו בשטח:** `getPendingOutboxMessages` ממיין את כל שורות ה-outbox בכל `fill`; נמדד 2.6ms/קריאה על 13k שורות (בהרצה מבודדת), והוא עכשיו נקרא בכל סיום שליחה (מתמזג, אך לא נמדד תחת עומס ייצור).
- תרחישי 8.4 שלא הורצו: בידוד A→B, תקלת לקוח/hang, restart שער/לקוח בעומס, DB outage, webhook כפול, 20/100 held **כעומס מתוזמן** (כוסה כבדיקת נכונות, לא כמדידת זמן), 1,000 כניסות/20 דק'. mixed+Baileys ו-single הורצו.
- הבדיקות החדשות של הפול (`test-outbox-pool`) לא הפיקו פלט שמיש על עותק HEAD (התהליך הסתיים בשקט) — לכן אין הוכחה "נכשל ב-HEAD" עבורה; ל-classification העותק לא נטען (מודול חדש). הראיה לשתיהן היא ה-mutation ובדיקת ההיגיון, לא ריצה על HEAD.
- הפגם #4 (`AsyncExpiringCache` מוחק ברענון כושל) לא טופל: קוד שער, D.
- שלב A: בדיקת ה-PG האמיתית של הגיבוי עדיין לא נכתבה.
- לא נעשתה פריסה ולא נבדק אצל לקוחות; "מוכן לפריסה" מותנה בסעיף 8.

## 10. קבצים
- מוצר: `src/sendOutcome.ts` (חדש), `src/storage.ts`, `src/outboxDispatcher.ts`, `src/messageFlow.ts`, `src/providers/MetaCloudProvider.ts`.
- בדיקות חדשות: `scripts/test-outbox-fairness.js`, `test-outbox-classification.js`, `test-outbox-pool.js`, `test-meta-timeouts.js`, `test-outbox-uncertain-postgres.js`.
- כלים: `scripts/run-regression.js` (+ retry ל-flaky), `regression-manifest.txt`, `run-load-baseline.js`, `run-load-ab.js`, `mutation-stage-b.js`; הרחבת `test-load-shared-campaign-isolation.js` (פיצול gateway/client leg, `LOAD_ARRIVAL=interleaved`).
- נתונים: `docs/results-data/`, `docs/baseline-2026-09-20/`.
- לא נגעתי ב-`package.json`, במסמכים או בסקריפטים הלא-מנוהלים שלך, ולא ב-D–F.
