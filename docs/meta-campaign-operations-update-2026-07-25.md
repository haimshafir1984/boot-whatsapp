# Meta campaign operations update - 2026-07-25

## Purpose

This record is the operational source of truth for the Meta campaign work completed after the PostgreSQL rollout. It covers only deployed code and verified runtime behaviour. It does not replace the general PostgreSQL migration or Meta architecture plans.

## Current production model

- Existing client applications are PostgreSQL-backed. Each new Dokploy client is provisioned with a dedicated PostgreSQL service and a separate application service.
- Auto Deploy remains disabled. A customer deployment is a manual, deliberate action after the relevant checks have passed.
- The application uses a durable outbox. Delivery is at-least-once; a provider delivery acknowledgement received before the local sent mark can still result in a duplicate after a process failure.
- Meta free-form messages are limited to the 24-hour customer-service window. A manager notification outside that window must use an approved Meta template.

## Reliability and performance changes

| Area | Delivered behaviour | Key commits |
| --- | --- | --- |
| Meta gateway | Durable inbound handling, retries, client routing protection, and flow-recovery coverage. | 4f5d161 |
| Flow concurrency | Per-user serialization, duplicate-reply protection, durable pending conversation state, timeout recovery, and flow-health metrics. | 4f5d161 and prior reliability work |
| PostgreSQL writes | Runtime writes synchronize normalized rows incrementally; app_state remains a checkpoint instead of being rewritten for every message. Writes are coalesced. | 0b12ce3 |
| Campaign freshness | A reply resolves the latest saved campaign flow before it is processed, so a participant waiting on a button can use a newly saved action. | 6ea532b |
| Recovery guardrails | GET /api/campaigns/:id/checkpoint reads the PostgreSQL app_state checkpoint for an authenticated writable client. It never writes data. | 8b416fe |

## Group-join manager action

The campaign builder now supports a dedicated request_group_join option action.

- Campaign settings contain the manager WhatsApp number, Meta template name, language, and template variables.
- The default template variables are participant phone and campaign name; supported placeholders include {phone}, {campaign}, and {name}.
- The runtime sends the manager request once per participant/option using a campaign-event dedupe key.
- It records Meta delivery status and logs sent, failed, and untracked delivery events.
- After the participant confirmation, the option follows its configured next step or completes the campaign.
- The campaign preflight detects a missing manager number and warns when a Meta template is required but not configured.

Relevant commits: c06f3c2, 9f1b3f9, 472d9c3, 3d4a555, 37fbf29, 0d2a515, 9c57d34.

## Referral hub and leaderboard

A campaign can contain a dedicated referral hub (referralHub) with three supported option actions:

- referral_link: generates and sends the participant's personal WhatsApp share link.
- referral_leaderboard: renders the current top five referrers.
- referral_my_rank: renders the participant's position, participant count, invitations, and gap to the next rank.

Operational rules:

- Button labels and answer text are editable by the campaign manager.
- The referral action is persisted even when a stale editor payload omits its action field; the server infers standard actions and preserves the referralHub marker.
- Each referral action now honours nextStepId:
  - choose the referral hub itself to show another choice;
  - choose a later flow step to continue the campaign;
  - leave the target empty to complete the campaign.
- The common configuration is: Leaders -> referral hub, My rank -> final message.
- A result preface configured on a calculated result step is sent before the calculated outcome.

Relevant commits: 0fafa7d, c20b2d3, 6ea532b, 64f8d4c, d32664b, fce4071.

### Reversible demo data

For visual QA only, an authenticated writable client may use:

- POST /api/campaign-results/:id/referrals/demo
- DELETE /api/campaign-results/:id/referrals/demo

Demo records are marked isDemo and are removed only by the delete endpoint. They must be deleted before a real campaign report is presented.

## Hebrew data recovery incident and rule

On 2026-07-24, a campaign update sent through a Windows PowerShell JSON pipeline used an unsafe text encoding and replaced Hebrew values with question marks. Campaign results, contacts, events, and the three later-added flow steps were preserved.

Recovery used the PostgreSQL app_state checkpoint to restore only corrupted strings from matching campaign and flow IDs, then preserved later flow additions and their referral actions. The restored campaign was verified through the client API with zero remaining corrupted text fields.

Mandatory operating rule: do not use Windows PowerShell JSON serialization or piping to write Hebrew campaign payloads. Use the browser editor, or a UTF-8 Node fetch request with Content-Type application/json; charset=utf-8. Before any direct campaign write, keep an export or local JSON copy of the current campaign payload.

## Verification commands

Run the relevant checks before a manual customer deployment:

    npm run build
    npm run test:flow-concurrency
    npm run test:referral-ranking
    node scripts/test-group-join-flow.js
    node scripts/test-score-result-preface.js
    node scripts/test-meta-gateway-reliability.js

The referral-ranking test covers a return to the hub followed by a configured next step. The group-join test covers a manager request followed by configured flow continuation.

## Remaining risks

- flowRecoveryText and invalidReplyText remain required campaign configuration for robust state-miss recovery.
- The after-timeout button context is still memory-resident; a restart falls back to normal flow recovery rather than exact timed-out-button continuation.
- Meta manager delivery can fail for business eligibility/payment reasons or a closed 24-hour window; the runtime records the delivery failure but cannot override Meta policy.
- A full distributed timer/locking model is still required before running multiple replicas for one customer.
