import http from 'node:http';

const PORT = 4301;
let mode = 'normal';
const deliveries = [];
let msgCounter = 1;

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/control') {
    const body = await parseJsonBody(req);
    if (body.mode) mode = body.mode;
    return sendJson(res, 200, { mode });
  }

  if (req.method === 'GET' && url.pathname === '/deliveries') {
    return sendJson(res, 200, deliveries);
  }

  if (req.method === 'GET' && url.pathname === '/messages') {
    const clientRef = url.searchParams.get('clientRef');
    const found = deliveries.filter(d => d.clientRef === clientRef);
    if (found.length > 0) {
      return sendJson(res, 200, { state: 'delivered', providerMessageId: found[0].providerMessageId, count: found.length });
    }
    return sendJson(res, 200, { state: 'not_found' });
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const body = await parseJsonBody(req);
    const providerMessageId = `msg-${msgCounter++}`;

    if (mode === 'reject_before_accept') {
      return sendJson(res, 503, { error: 'Service Unavailable' });
    }

    if (mode === 'accept_then_timeout') {
      deliveries.push({ clientRef: body.clientRef, ticketId: body.ticketId, body: body.body, providerMessageId });
      return sendJson(res, 504, { error: 'Gateway Timeout' });
    }

    deliveries.push({ clientRef: body.clientRef, ticketId: body.ticketId, body: body.body, providerMessageId });
    return sendJson(res, 200, { providerMessageId });
  }

  return sendJson(res, 404, { error: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`Mock Provider running on http://127.0.0.1:${PORT}`);
});
