import { ProviderClient } from './provider.mjs';

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export class DeskService {
  constructor({ db, provider }) {
    this.db = db;
    this.provider = provider || new ProviderClient();
  }

  // 1. Customer Isolation & Ticket Listing
  listTickets(tenantId) {
    const stmt = this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id ASC');
    return stmt.all(tenantId);
  }

  getTicket(tenantId, ticketId) {
    const ticketStmt = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?');
    const ticket = ticketStmt.get(ticketId, tenantId);
    if (!ticket) return null;

    const messagesStmt = this.db.prepare('SELECT * FROM messages WHERE ticket_id = ? AND tenant_id = ? ORDER BY created_at ASC');
    const attemptsStmt = this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND tenant_id = ? ORDER BY created_at DESC');
    const auditStmt = this.db.prepare('SELECT * FROM audit_logs WHERE ticket_id = ? AND tenant_id = ? ORDER BY created_at DESC');

    const rawMessages = messagesStmt.all(ticketId, tenantId);
    const messages = rawMessages.map(m => ({
      ...m,
      body: escapeHtml(m.body)
    }));

    return {
      ...ticket,
      messages,
      attempts: attemptsStmt.all(ticketId, tenantId),
      audit: auditStmt.all(ticketId, tenantId)
    };
  }

  // 2. Safe Inbound Delivery (Idempotent Webhook)
  receiveWebhook({ webhookSecret, tenantId, ticketId, eventId, body }) {
    if (webhookSecret !== 'fictional-webhook-secret') {
      const err = new Error('Invalid webhook secret');
      err.status = 401;
      throw err;
    }

    if (!tenantId || !ticketId || !eventId || !body) {
      const err = new Error('Missing required fields');
      err.status = 400;
      throw err;
    }

    // Proteger aislamiento y verificar ticket
    const ticketStmt = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?');
    const ticket = ticketStmt.get(ticketId, tenantId);
    if (!ticket) {
      const err = new Error('Ticket not found for organization');
      err.status = 404;
      throw err;
    }

    // Transacción SQLite para garantizar atomicidad de webhook e inserción
    this.db.exec('BEGIN TRANSACTION;');
    try {
      // Verificar deduplicación scoped a tenant
      const checkEvent = this.db.prepare('SELECT id FROM events WHERE tenant_id = ? AND event_id = ?');
      const existing = checkEvent.get(tenantId, eventId);
      if (existing) {
        this.db.exec('COMMIT;');
        return { status: 'ignored_duplicate', eventId };
      }

      // Registrar evento
      const insertEvent = this.db.prepare('INSERT INTO events (id, tenant_id, event_id) VALUES (?, ?, ?)');
      insertEvent.run(`${tenantId}:${eventId}`, tenantId, eventId);

      // Registrar mensaje entrante del cliente
      const insertMsg = this.db.prepare('INSERT INTO messages (ticket_id, tenant_id, sender_type, body) VALUES (?, ?, ?, ?)');
      insertMsg.run(ticketId, tenantId, 'customer', body);

      // Auditoría
      const insertAudit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
      insertAudit.run(ticketId, tenantId, 'WEBHOOK_RECEIVED', 'system', `Event ${eventId} ingested`);

      this.db.exec('COMMIT;');
      return { status: 'processed', eventId };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // 3. Draft & Approval Management
  updateDraft(tenantId, ticketId, body) {
    const ticket = this.getTicket(tenantId, ticketId);
    if (!ticket) {
      const err = new Error('Ticket not found');
      err.status = 404;
      throw err;
    }

    // Actualizar borrador e INVALIDAR aprobación previa si cambia el borrador
    const stmt = this.db.prepare('UPDATE tickets SET draft_body = ?, draft_approved = 0 WHERE id = ? AND tenant_id = ?');
    stmt.run(body, ticketId, tenantId);

    const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
    audit.run(ticketId, tenantId, 'DRAFT_UPDATED', 'agent', 'Draft updated and approval invalidated');

    return this.getTicket(tenantId, ticketId);
  }

  approveDraft(tenantId, ticketId) {
    const ticket = this.getTicket(tenantId, ticketId);
    if (!ticket) {
      const err = new Error('Ticket not found');
      err.status = 404;
      throw err;
    }

    if (!ticket.draft_body || ticket.draft_body.trim() === '') {
      const err = new Error('Cannot approve empty draft');
      err.status = 400;
      throw err;
    }

    const stmt = this.db.prepare('UPDATE tickets SET draft_approved = 1 WHERE id = ? AND tenant_id = ?');
    stmt.run(ticketId, tenantId);

    const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
    audit.run(ticketId, tenantId, 'DRAFT_APPROVED', 'agent', 'Draft approved for dispatch');

    return this.getTicket(tenantId, ticketId);
  }

  // 4. Human Takeover
  handoff(tenantId, ticketId) {
    const ticket = this.getTicket(tenantId, ticketId);
    if (!ticket) {
      const err = new Error('Ticket not found');
      err.status = 404;
      throw err;
    }

    const stmt = this.db.prepare('UPDATE tickets SET human_taken_over = 1 WHERE id = ? AND tenant_id = ?');
    stmt.run(ticketId, tenantId);

    const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
    audit.run(ticketId, tenantId, 'HUMAN_TAKEOVER', 'agent', 'Human agent took over conversation');

    return this.getTicket(tenantId, ticketId);
  }

  // 5. Honest Delivery and Recovery (Send Reply)
  async sendReply(tenantId, ticketId, options = {}) {
    const { isAutomation = false } = options;

    const ticket = this.getTicket(tenantId, ticketId);
    if (!ticket) {
      const err = new Error('Ticket not found');
      err.status = 404;
      throw err;
    }

    // Regla de Takeover para automatización
    if (isAutomation && ticket.human_taken_over) {
      const err = new Error('Automation dispatch refused due to human takeover');
      err.status = 400;
      throw err;
    }

    // Validar Aprobación Estricta
    if (!ticket.draft_approved || !ticket.draft_body) {
      const err = new Error('Draft must be approved before sending');
      err.status = 400;
      throw err;
    }

    // Generar clientRef único
    const clientRef = `ref-${ticketId}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const bodyToSend = ticket.draft_body;

    // Proteger contra doble envío: invalidar aprobación de inmediato en la BD
    const invalidateStmt = this.db.prepare('UPDATE tickets SET draft_approved = 0, draft_body = NULL WHERE id = ? AND tenant_id = ?');
    invalidateStmt.run(ticketId, tenantId);

    // Registrar intento inicial PENDING
    const insertAttempt = this.db.prepare('INSERT INTO attempts (ticket_id, tenant_id, client_ref, body, status) VALUES (?, ?, ?, ?, ?)');
    insertAttempt.run(ticketId, tenantId, clientRef, bodyToSend, 'PENDING');

    try {
      const result = await this.provider.send({ clientRef, ticketId, body: bodyToSend });

      // Éxito confirmado
      const updateAttempt = this.db.prepare('UPDATE attempts SET status = ?, provider_message_id = ? WHERE client_ref = ?');
      updateAttempt.run('DELIVERED', result.providerMessageId, clientRef);

      // Registrar mensaje en conversación
      const insertMsg = this.db.prepare('INSERT INTO messages (ticket_id, tenant_id, sender_type, body) VALUES (?, ?, ?, ?)');
      insertMsg.run(ticketId, tenantId, isAutomation ? 'automation' : 'agent', bodyToSend);

      const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
      audit.run(ticketId, tenantId, 'MESSAGE_SENT', isAutomation ? 'automation' : 'agent', `Delivered with ID ${result.providerMessageId}`);

      return { status: 'DELIVERED', clientRef, providerMessageId: result.providerMessageId };
    } catch (err) {
      if (err.kind === 'not_accepted') {
        // Fallo seguro conocido
        const updateAttempt = this.db.prepare('UPDATE attempts SET status = ?, error_details = ? WHERE client_ref = ?');
        updateAttempt.run('FAILED', err.message, clientRef);

        const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
        audit.run(ticketId, tenantId, 'SEND_FAILED', 'system', `Rejected before acceptance: ${err.message}`);

        return { status: 'FAILED', clientRef, error: err.message };
      } else {
        // Estado incierto (UNKNOWN)
        const updateAttempt = this.db.prepare('UPDATE attempts SET status = ?, error_details = ? WHERE client_ref = ?');
        updateAttempt.run('UNKNOWN', err.message, clientRef);

        const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
        audit.run(ticketId, tenantId, 'SEND_UNCERTAIN', 'system', `Delivery state unknown. Ref: ${clientRef}`);

        return { status: 'UNKNOWN', clientRef, error: err.message };
      }
    }
  }

  // 6. Reconciliation of Uncertain Deliveries
  async reconcile(tenantId, ticketId) {
    const ticket = this.getTicket(tenantId, ticketId);
    if (!ticket) {
      const err = new Error('Ticket not found');
      err.status = 404;
      throw err;
    }

    // Buscar último intento UNKNOWN
    const stmt = this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND tenant_id = ? AND status = "UNKNOWN" ORDER BY created_at DESC LIMIT 1');
    const attempt = stmt.get(ticketId, tenantId);

    if (!attempt) {
      return { status: 'no_pending_reconciliation' };
    }

    const lookupResult = await this.provider.lookup(attempt.client_ref);

    if (lookupResult.state === 'delivered') {
      // Confirmado por el proveedor
      const updateAttempt = this.db.prepare('UPDATE attempts SET status = "DELIVERED", provider_message_id = ? WHERE id = ?');
      updateAttempt.run(lookupResult.providerMessageId, attempt.id);

      // Registrar mensaje en conversación
      const insertMsg = this.db.prepare('INSERT INTO messages (ticket_id, tenant_id, sender_type, body) VALUES (?, ?, ?, ?)');
      insertMsg.run(ticketId, tenantId, 'agent', attempt.body);

      const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
      audit.run(ticketId, tenantId, 'RECONCILED_SUCCESS', 'agent', `Confirmed delivered by provider with ID ${lookupResult.providerMessageId}`);

      return { status: 'DELIVERED', providerMessageId: lookupResult.providerMessageId };
    } else {
      // Inconcluso ('not_found') -> permanece UNKNOWN para evitar reintento a ciegas
      const audit = this.db.prepare('INSERT INTO audit_logs (ticket_id, tenant_id, action, actor, details) VALUES (?, ?, ?, ?, ?)');
      audit.run(ticketId, tenantId, 'RECONCILE_INCONCLUSIVE', 'agent', 'Lookup returned not_found. State remains UNKNOWN.');

      return { status: 'UNKNOWN', message: 'Reconciliation inconclusive. Provider returned not_found.' };
    }
  }
}
