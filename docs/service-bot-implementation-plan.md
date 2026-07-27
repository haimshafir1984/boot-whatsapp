# Service Bot Implementation Plan

## Goal

Add an isolated decision-tree service bot for a test client while preserving all existing campaign behavior. The feature must remain disabled by default and must be enabled only for the test client.

## Branch and deployment

- Development branch: `codex/service-bot`
- Test client Dokploy branch: `codex/service-bot`
- Existing clients remain on their current production branch.
- Test client environment variable:

```env
CLIENT_SERVICE_BOT_ENABLED=true
```

- No variable is required for existing clients. Missing means `false`.
- Do not merge or deploy this branch to existing clients until acceptance testing is complete.
- Do not commit or push automatically unless explicitly requested.

## MVP behavior

The bot is a persistent service menu, separate from campaign conversations.

Required capabilities:

1. Main menu with options such as New Customer and Existing Customer.
2. Each option navigates to another node.
3. Menu nodes, information/message nodes and human handoff nodes.
4. Navigation by button/list reply where the provider supports it, with numbered-text fallback.
5. `חזרה` returns to the main menu in the first MVP.
6. `תפריט ראשי` always returns to the main menu.
7. Unknown input returns a fallback and repeats the current menu.
8. Session state per phone number, isolated from campaign state.
9. Optional handoff phone/link.
10. Basic validation that all target node IDs exist and the main node exists.

## Configuration model

Add these types to storage:

```ts
type ServiceBotNodeType = 'menu' | 'message' | 'handoff';

type ServiceBotOption = {
  id: string;
  label: string;
  targetNodeId: string;
};

type ServiceBotNode = {
  id: string;
  title: string;
  type: ServiceBotNodeType;
  text: string;
  options?: ServiceBotOption[];
  handoffPhone?: string;
};

type ServiceBotConfig = {
  enabled: boolean;
  name: string;
  triggerText: string;
  mainMenuNodeId: string;
  fallbackText: string;
  nodes: ServiceBotNode[];
};

type ServiceBotSession = {
  phone: string;
  nodeId: string;
  updatedAt: string;
};
```

Persist `serviceBot` and `serviceBotSessions` inside the existing `StorageData` snapshot so JSON and PostgreSQL clients use the same storage path. Older snapshots must load with an empty/default service bot and no sessions.

## Runtime integration

Create a dedicated `src/serviceBot.ts` module. It should:

- Read the config from Storage.
- Return `false` when `CLIENT_SERVICE_BOT_ENABLED` is false.
- Start on the configured trigger text, for example `תפריט`.
- Continue only when a session exists for the sender.
- Resolve options by button ID, label, or number.
- Save the next node before sending its response.
- Never consume messages that belong to an active campaign conversation.
- Reuse the existing serialized per-sender message queue and WhatsApp transport.

The safe routing order is:

1. Existing campaign pending state.
2. Existing campaign trigger detection.
3. Service Bot session or Service Bot trigger.
4. Ignore unrelated messages as today.

This guarantees the feature cannot intercept an existing campaign flow when enabled.

## API

Add authenticated client endpoints in `src/adminServer.ts`:

- `GET /api/service-bot`
- `PUT /api/service-bot`
- `POST /api/service-bot/validate`
- `DELETE /api/service-bot/sessions`

The update endpoint must validate the graph before saving it. It must reject duplicate node IDs, missing main node, missing target nodes, empty labels and unsupported node types.

## Admin UI follow-up

The first code delivery can expose the API and use a small test configuration. The next UI increment should add a separate Service Bot tab, not place the feature inside the Campaign Builder.

UI MVP:

- Enable/disable switch.
- Trigger text.
- Main menu selector.
- Node list.
- Add/edit/delete node.
- Add/edit/delete option.
- Target-node selector.
- Preview and validation errors.

## Tests

Add `scripts/test-service-bot-flow.js` covering:

1. Feature flag off does not handle messages.
2. Trigger opens the main menu.
3. Numbered input navigates to a child node.
4. Label and option ID both navigate correctly.
5. `חזרה` returns to the main menu.
6. `תפריט ראשי` returns to the main menu.
7. Unknown input repeats fallback and current menu.
8. Missing target node is rejected by validation.
9. Campaign pending state remains higher priority.
10. A second phone has an independent session.

Run:

```bash
npm.cmd run build
node scripts/test-service-bot-flow.js
```

Then run the existing focused regression tests, especially flow concurrency, Meta routing, gateway reliability and outbox durability.

## Acceptance test for the test client

Configure a sample tree:

- Main menu: `לקוח חדש`, `לקוח קיים`, `שעות פתיחה`, `נציג שירות`.
- New customer: information message and return to menu.
- Existing customer: products menu and information nodes.
- Opening hours: fixed text.
- Human handoff: message with WhatsApp link/phone.

Test through the real WhatsApp provider:

- Send the trigger.
- Select every option.
- Test numbered input and button/list input.
- Test back and main menu.
- Send an invalid answer.
- Start a campaign during a service session and verify campaign priority.
- Inspect `/health` and logs for errors.

## Done criteria

- Build passes.
- Dedicated Service Bot tests pass.
- Existing regression tests pass.
- Feature flag is false by default.
- Existing clients are unchanged.
- Test client runs only from `codex/service-bot`.
- Service Bot can be disabled instantly by setting the flag to `false` and redeploying.
- No production branch or existing client is deployed from this branch before acceptance.
