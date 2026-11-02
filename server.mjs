import http from 'node:http';
import path from 'node:path';
import { createDatabase } from './db.mjs';
import { DeskService } from './service.mjs';

const dbPath = path.join(process.cwd(), 'data', 'desk.db');
const db = createDatabase(dbPath);
const service = new DeskService({ db });

const PORT = 4300;

function resolveActor(req) {
  const auth = req.headers['authorization'];
  if (auth === 'Bearer demo-alpha-token') return { tenantId: 'alpha', ticketId: 101 };
  if (auth === 'Bearer demo-beta-token') return { tenantId: 'beta', ticketId: 202 };
  return null;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function renderUI(ticket) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>JustInsurance Support Inbox</title>
    <style>
      body { font-family: sans-serif; margin: 20px; background: #f4f6f8; }
      .container { max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 8px; }
      .msg { border-bottom: 1px solid #ddd; padding: 8px 0; }
      .customer { color: #d9534f; }
      .agent { color: #0275d8; }
      .badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
      .badge-unknown { background: #f0ad4e; color: white; }
      .badge-delivered { background: #5cb85c; color: white; }
      .audit-log { background: #f8f9fa; font-size: 12px; padding: 10px; margin-top: 20px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>Ticket #${ticket.id} - ${ticket.subject} (Tenant: ${ticket.tenant_id})</h2>
      <p>Human Takeover: <strong>${ticket.human_taken_over ? 'YES' : 'NO'}</strong></p>
      <hr>
      <h3>Conversation</h3>
      ${ticket.messages.map(m => `<div class="msg <span class="${m.sender_type}">"><strong>${m.sender_type}:</strong> ${m.body}</div>`).join('')}
      
      <h3>Current Draft</h3>
      <p>${ticket.draft_body ? ticket.draft_body : '<em>No draft saved</em>'}</p>
      <p>Approved: <strong>${ticket.draft_approved ? 'YES' : 'NO'}</strong></p>
      
      <h3>Audit Trail</h3>
      <div class="audit-log">
        ${ticket.audit.map(a => `<div>[${a.created_at}] <strong>${a.action}</strong> by ${a.actor}: ${a.details}</div>`).join('')}
      </div>
    </div>
  </body>
  </html>
  `;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const actor = resolveActor(req);

  // Webhook Route
  if (req.method === 'POST' && url.pathname === '/webhooks/ghl') {
    const secret = req.headers['x-demo-webhook-secret'];
    try {
      const payload = await parseJsonBody(req);
      const result = service.receiveWebhook({
        webhookSecret: secret,
        tenantId: payload.tenantId,
        ticketId: payload.ticketId,
        eventId: payload.eventId,
        body: payload.body
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // Vista Web UI
  if (req.method === 'GET' && url.pathname === '/') {
    const ticket = service.getTicket('alpha', 101);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderUI(ticket));
  }

  // Rutas API requeridas
  if (!actor) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/tickets') {
      const tickets = service.listTickets(actor.tenantId);
      return sendJson(res, 200, tickets);
    }

    const ticketMatch = url.pathname.match(/^\/api\/tickets\/(\d+)(\/.*)?$/);
    if (ticketMatch) {
      const ticketId = parseInt(ticketMatch[1], 10);
      const subRoute = ticketMatch[2];

      if (req.method === 'GET' && !subRoute) {
        const ticket = service.getTicket(actor.tenantId, ticketId);
        if (!ticket) return sendJson(res, 404, { error: 'Not found or unauthorized' });
        return sendJson(res, 200, ticket);
      }

      if (req.method === 'POST' && subRoute === '/draft') {
        const body = await parseJsonBody(req);
        const updated = service.updateDraft(actor.tenantId, ticketId, body.body);
        return sendJson(res, 200, updated);
      }

      if (req.method === 'POST' && subRoute === '/approve') {
        const updated = service.approveDraft(actor.tenantId, ticketId);
        return sendJson(res, 200, updated);
      }

      if (req.method === 'POST' && subRoute === '/send') {
        const result = await service.sendReply(actor.tenantId, ticketId);
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && subRoute === '/handoff') {
        const updated = service.handoff(actor.tenantId, ticketId);
        return sendJson(res, 200, updated);
      }

      if (req.method === 'POST' && subRoute === '/automation') {
        const result = await service.sendReply(actor.tenantId, ticketId, { isAutomation: true });
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && subRoute === '/reconcile') {
        const result = await service.reconcile(actor.tenantId, ticketId);
        return sendJson(res, 200, result);
      }
    }

    return sendJson(res, 404, { error: 'Route not found' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Support Desk running on http://127.0.0.1:${PORT}`);
});
