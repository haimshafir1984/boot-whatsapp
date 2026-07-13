# Meta Campaign Builder Change Log - 2026-07

## Baseline

- Scope: Meta Cloud API campaign builder UX and delivery safety only.
- Do not change Twilio campaign behavior.
- Do not change existing campaign data unless the user saves a campaign from the UI.
- Current local baseline commit before this work: `05eaf85 Generate real XLSX campaign exports`.
- Existing worktree contains unrelated local changes in docs and `src/botState.ts`; they are intentionally left untouched.

## Rollback

- Each implementation step is committed separately.
- Roll back a step with `git revert <commit_sha>`.
- Do not use `git reset --hard` because the worktree contains user changes.

## Test Client

- Primary manual test target: Meta Cloud API test client dashboard.
- Existing active campaigns must continue to work.
- Twilio clients must not lose or change their existing behavior.

## Change Records

### 1. Baseline document

- Status: completed.
- Files: `docs/meta-campaign-builder-change-log-2026-07.md`.
- Verification: document-only change.

### 2. Meta no-intro media/contact and combined isolation

- Status: completed.
- Files: `public/index.html`.
- Changes:
  - Added a Meta provider helper for UI/runtime serialization decisions.
  - Kept combined contact-card mode available only for `META_CLOUD_API` clients.
  - Prevented file-only and contact-only preview from showing empty message bubbles.
  - Kept Twilio serialization on separate contact cards.
- Verification: pending final `npm run build` and manual Meta/Twilio smoke tests.
- Rollback: revert this step commit only.
### 3. Inline campaign file upload

- Status: completed.
- Files: `public/index.html`.
- Changes:
  - Added an inline upload control inside message/file flow blocks.
  - Reused the existing `/api/files` upload path; no server changes.
  - Auto-selects the uploaded file in the current block after upload.
  - Shows a short inline upload status and preserves the existing files manager behavior.
- Verification: pending final `npm run build` and manual upload/send smoke tests.
- Rollback: revert this step commit only.
### 4. Builder summary, terminology, and answer limits

- Status: completed.
- Files: `public/index.html`.
- Changes:
  - Split the final summary into conversation steps and completion items.
  - Replaced the technical flow-map count wording with step wording.
  - Updated answer-limit labels dynamically: buttons up to 3, list/text up to 10.
  - Disabled adding more answers only when the current presentation reaches its limit.
  - Improved collapsed step titles for file-only, contact-card, and score-result blocks.
  - Removed the duplicate bottom add-step control; the main add-step control remains.
- Verification: pending final `npm run build` and manual builder smoke tests.
- Rollback: revert this step commit only.
### 5. Local draft recovery

- Status: completed.
- Files: `public/index.html`.
- Changes:
  - Added local-only draft capture in `localStorage`, scoped by host and campaign id/new campaign.
  - Prompts to restore a local draft when reopening the builder.
  - Warns before closing with unsaved local changes.
  - Clears the relevant draft after a successful campaign save.
  - Does not write drafts to the server and does not mutate existing campaigns without explicit save.
- Verification: pending final `npm run build` and manual draft close/restore/discard tests.
- Rollback: revert this step commit only.
## Final Verification

- `npm run build`: passed.
- Inline JavaScript syntax check for `public/index.html`: passed.
- Push: not performed, per instruction.
- Manual browser/WhatsApp checks: pending user-side review before any push/deploy.