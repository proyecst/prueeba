# Handoff

## Changes and ownership

In this exercise, we refactored and completed the JustInsurance Support Desk implementation to strictly fulfill all security, transaction, concurrency, and delivery requirements:

1. **Safe Inbound Delivery (Idempotency & Webhooks):**
   - Implemented an `events` table in SQLite with a unique composite key `(tenant_id, event_id)`.
   - Wrapped event ingestion and customer message creation inside a single atomic SQLite transaction (`BEGIN TRANSACTION` / `COMMIT`).
   - Webhook authentication is strictly validated against `X-Demo-Webhook-Secret`. Duplicate event replays return `ignored_duplicate` without creating duplicate messages or side effects.

2. **Customer Isolation (Multi-Tenancy):**
   - Enforced server-side authorization resolving the tenant identity exclusively from the `Authorization` Bearer token.
   - All queries and mutations (`getTicket`, `updateDraft`, `approveDraft`, `sendReply`, `reconcile`) filter strictly by `tenant_id`. Cross-tenant requests (e.g., Tenant Beta accessing Ticket 101) return HTTP 404/401, ignoring client-supplied tenant overrides.

3. **Exact Approval & Double-Send Protection:**
   - Saved drafts require explicit human approval (`draft_approved = 1`).
   - Updating a draft automatically invalidates prior approval (`draft_approved = 0`).
   - Before dispatching a message to the provider, the system immediately clears the draft and invalidates approval in the database to prevent double-sending under high concurrency or repeated button clicks.

4. **Honest Delivery and Recovery:**
   - Implemented an `UNKNOWN` attempt state for provider timeouts (HTTP 504) or network losses. The system persists the `client_ref` and does NOT attempt blind automatic retries.
   - Rejection before acceptance (HTTP 503) is marked as a safe `FAILED` state.
   - Provided an explicit `/api/tickets/:id/reconcile` endpoint allowing operators to verify delivery status via `GET /messages?clientRef=...`. Reconciled delivered attempts upgrade safely to `DELIVERED` state without re-dispatching.

5. **Human Takeover Enforcement:**
   - When an agent triggers handoff (`human_taken_over = 1`), server-side logic in `sendReply` explicitly blocks any background automation dispatch (`isAutomation = true`). Human agents retain full ability to dispatch approved messages.

6. **Usable Inbox & HTML Sanitization:**
   - Enhanced the inbox UI to render untrusted customer input using HTML entity encoding to prevent XSS. Included an explicit audit log for all major actions (`WEBHOOK_RECEIVED`, `DRAFT_UPDATED`, `DRAFT_APPROVED`, `HUMAN_TAKEOVER`, `MESSAGE_SENT`, `SEND_UNCERTAIN`, `RECONCILED_SUCCESS`).

---

## Verification

### Automated Suite Results
We wrote an extensive automated integration test suite in `test/desk.test.mjs` covering all core scenarios:

```
✔ 1. Safe Inbound Delivery - Replay webhook deduplication
✔ 2. Customer Isolation - Cannot access cross-tenant tickets
✔ 3. Exact Approval - Editing draft invalidates approval & double send prevented
✔ 4. Human Takeover - Automation refused after takeover
✔ 5. Honest Delivery and Recovery - Timeout results in UNKNOWN state
```

### Manual Checks & Commands
- **Start Provider:** `npm run provider`
- **Start Support Desk:** `npm start`
- **Run Event Replay:** `npm run event` (Run twice to verify deduplication)
- **Run Tests:** `npm test`

---

## Operator Instructions

1. **Uncertain Send (UNKNOWN state):**
   - If a send operation times out or encounters network disruption, the attempt enters `UNKNOWN` state.
   - **Do NOT resend the message manually.**
   - Click the **Reconcile** button in the inbox. The system will query the provider using `clientRef`.
   - If confirmed, the message will transition to `DELIVERED`. If `not_found`, the state remains `UNKNOWN` for manual review.

2. **Draft Editing:**
   - Any modification to an approved draft clears its approval. Always click **Approve** again before sending.

3. **System Restart:**
   - All state is persisted in SQLite (`data/desk.db`). Restarting the service preserves all tickets, messages, audit logs, and pending attempts.

---

## Remaining Risks and Production Plan

1. **High-Concurrency Database Locking:**
   - SQLite provides single-writer transaction locks. For production scale, transition to PostgreSQL with row-level locks or distributed lock mechanisms (e.g., Redis Redlock).

2. **Real GHL OAuth Integration:**
   - Replace demo Bearer tokens with real GHL OAuth 2.0 PKCE flow, including access/refresh token rotation and secure vault storage per organization.

3. **Webhook Verification:**
   - Replace fixed secret checking with GHL HMAC signature verification (`X-GHL-Signature`) using raw request body hashing.

---

## AI Use and Time

- **Tools Used:** Cursor / Claude Code assistant for code generation, architecture validation, and test suite creation.
- **Accepted Suggestion:** Atomic transactional wrapping for webhook event ingestion and database mutation to guarantee strict idempotency.
- **Approximate Time Spent:** 1 hour 45 minutes total (including architecture design, code implementation, test writing, and documentation).
