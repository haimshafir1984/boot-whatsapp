# Central Meta Token Ownership Analysis - 2026-09-10

## Current behavior

Today each Meta client container sends WhatsApp messages directly to Meta Cloud API.

Evidence in code:

- `src/providers/MetaCloudProvider.ts` posts directly to `/{phone_number_id}/messages` with `META_ACCESS_TOKEN`.
- `src/config.ts` reads `META_ACCESS_TOKEN`, falling back to `DOKPLOY_META_ACCESS_TOKEN`.
- `src/dokployProvisioner.ts` writes the current admin Meta token into every new Meta client as `META_ACCESS_TOKEN`.
- `src/adminServer.ts` bulk redeploy deliberately calls `redeployExistingClient`, which does not rewrite existing client environments.

This means a shared Meta token exists in many deployed client environments. If the token expires or is revoked, every client that still has the old value fails independently with `401` / Meta code `190`.

## Option A - Keep direct client sends, add token sync tooling

The admin remains the source used for provisioning, but clients still own outbound Meta sends. Add an explicit admin action that updates `META_ACCESS_TOKEN` in every existing Meta client environment and then redeploys or marks them as needing redeploy.

Pros:

- Lowest architectural risk.
- Keeps the existing outbox ownership exactly as it works today.
- Media upload cache remains local to each client and needs no redesign.
- Failures stay isolated by client outbox and `needs_review` state.

Cons:

- The shared secret still exists in every client container.
- A token rotation still requires touching every client environment, even if a button automates it.
- Partial sync is possible: one client can remain on the old token if Dokploy update/redeploy fails midway.
- Does not reduce the blast radius of a leaked client environment.

Recommended only as a near-term operational safety tool.

## Option B - Admin holds Meta token; clients ask admin to send

Clients keep campaign state and outbox records, but outbound Meta calls go through a central admin endpoint. The admin is the only service with `DOKPLOY_META_ACCESS_TOKEN`, `DOKPLOY_META_PHONE_NUMBER_ID`, and the Graph API credentials. Clients call something like `/internal/meta/send` on the gateway with their `OWNER_ACCESS_TOKEN`.

Pros:

- Token rotation becomes one admin environment update plus admin redeploy.
- The Meta token is no longer copied into every client environment.
- Central alerting and real token health checks become much easier and more reliable.
- Rate limiting, Meta error classification, and auth failure handling can be enforced in one place.
- This matches the real production topology: all Meta clients share one phone number.

Cons:

- Higher implementation risk than alerting or token sync.
- The admin becomes part of the outbound critical path, not only inbound routing.
- The client outbox must still preserve exactly the current idempotency contract. A client may enqueue locally, ask admin to send, then fail while persisting the provider message id.
- Media sends require a careful design: either the admin must fetch files from the client with signed URLs, or files must be uploaded/stored in a shared place.
- If the admin is down, all Meta outbound sends are down. This is already mostly true for inbound routing, but outbound timeout continuations and retries would also depend on it.
- Delivery statuses still need to be broadcast or routed back so the sending client can update its outbox.

Recommended as the target architecture, but not as an emergency change.

## Option C - Admin owns full Meta execution

The admin owns inbound routing and outbound sending, while clients only store/edit campaign definitions and results. This is a deeper service split.

Pros:

- Cleanest security boundary for a shared Meta number.
- One place for token, delivery tracking, rate limits, and campaign isolation.

Cons:

- Largest rewrite.
- Requires moving parts of campaign execution, outbox, file access, and state ownership.
- More regression risk for active launches.

Not recommended for the next development cycle.

## Recommendation

Use a two-step path:

1. Now: keep direct client sends, but add alerting for Meta auth/API failures, gateway failures, and durable queue failures. This is the implemented change in this branch.
2. Next: implement Option B with a narrow contract:
   - client outbox remains client-owned;
   - client calls admin for the provider send only;
   - admin validates the client by owner token;
   - admin sends to Meta and returns `messageId`;
   - client records the result exactly as today;
   - media sends use signed client file URLs or a dedicated upload handoff;
   - delivery statuses remain routed to all clients until a provider-message ownership registry exists centrally.

This removes the recurring "update token in every client" problem while keeping campaign data and idempotency behavior inside the client, where the current safety fixes already live.
