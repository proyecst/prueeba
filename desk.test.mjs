import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { createDatabase } from '../src/db.mjs';
import { DeskService } from '../src/service.mjs';

function getTestDb() {
  const dbPath = path.join(process.cwd(), 'data', `test-${Date.now()}-${Math.random()}.db`);
  const db = createDatabase(dbPath);
  return { db, dbPath };
}

function cleanupDb(db, dbPath) {
  try { db.close(); } catch {}
  try { fs.unlinkSync(dbPath); } catch {}
}

test('1. Safe Inbound Delivery - Replay webhook deduplication', () => {
  const { db, dbPath } = getTestDb();
  const service = new DeskService({ db });

  const webhookData = {
    webhookSecret: 'fictional-webhook-secret',
    tenantId: 'alpha',
    ticketId: 101,
    eventId: 'event-1',
    body: 'Need help'
  };

  const res1 = service.receiveWebhook(webhookData);
  assert.strictEqual(res1.status, 'processed');

  // Replay del mismo evento
  const res2 = service.receiveWebhook(webhookData);
  assert.strictEqual(res2.status, 'ignored_duplicate');

  const ticket = service.getTicket('alpha', 101);
  assert.strictEqual(ticket.messages.length, 1); // No duplicado

  cleanupDb(db, dbPath);
});

test('2. Customer Isolation - Cannot access cross-tenant tickets', () => {
  const { db, dbPath } = getTestDb();
  const service = new DeskService({ db });

  // Beta no puede ver el ticket 101 de Alpha
  const crossView = service.getTicket('beta', 101);
  assert.strictEqual(crossView, null);

  cleanupDb(db, dbPath);
});

test('3. Exact Approval - Editing draft invalidates approval & double send prevented', async () => {
  const mockProvider = {
    async send() { return { providerMessageId: 'msg-999' }; }
  };

  const { db, dbPath } = getTestDb();
  const service = new DeskService({ db, provider: mockProvider });

  service.updateDraft('alpha', 101, 'Original draft');
  service.approveDraft('alpha', 101);

  // Modificar invalida la aprobación
  service.updateDraft('alpha', 101, 'Modified draft');
  
  await assert.rejects(async () => {
    await service.sendReply('alpha', 101);
  }, /Draft must be approved/);

  cleanupDb(db, dbPath);
});

test('4. Human Takeover - Automation refused after takeover', async () => {
  const { db, dbPath } = getTestDb();
  const service = new DeskService({ db });

  service.updateDraft('alpha', 101, 'Auto reply');
  service.approveDraft('alpha', 101);
  service.handoff('alpha', 101);

  await assert.rejects(async () => {
    await service.sendReply('alpha', 101, { isAutomation: true });
  }, /Automation dispatch refused due to human takeover/);

  cleanupDb(db, dbPath);
});

test('5. Honest Delivery and Recovery - Timeout results in UNKNOWN state', async () => {
  const mockProvider = {
    async send() {
      const err = new Error('Gateway Timeout');
      err.kind = 'uncertain';
      throw err;
    }
  };

  const { db, dbPath } = getTestDb();
  const service = new DeskService({ db, provider: mockProvider });

  service.updateDraft('alpha', 101, 'Response text');
  service.approveDraft('alpha', 101);

  const res = await service.sendReply('alpha', 101);
  assert.strictEqual(res.status, 'UNKNOWN');

  const ticket = service.getTicket('alpha', 101);
  assert.strictEqual(ticket.attempts[0].status, 'UNKNOWN');

  cleanupDb(db, dbPath);
});
