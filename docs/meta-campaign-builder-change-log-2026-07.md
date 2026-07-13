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