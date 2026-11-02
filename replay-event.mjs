async function run() {
  const payload = {
    tenantId: 'alpha',
    ticketId: 101,
    eventId: 'event-1',
    body: 'Please help with my claim'
  };

  const res = await fetch('http://127.0.0.1:4300/webhooks/ghl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Webhook-Secret': 'fictional-webhook-secret'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('Webhook Response:', res.status, data);
}

run();
