export class ProviderClient {
  constructor(baseUrl = 'http://127.0.0.1:4301') {
    this.baseUrl = baseUrl;
  }

  async send({ clientRef, ticketId, body }) {
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRef, ticketId, body })
      });

      if (res.status === 503) {
        const error = new Error('Provider rejected message before acceptance');
        error.kind = 'not_accepted';
        throw error;
      }

      if (res.status === 504) {
        const error = new Error('Provider timeout');
        error.kind = 'uncertain';
        throw error;
      }

      if (!res.ok) {
        const error = new Error(`Provider returned status ${res.status}`);
        error.kind = 'uncertain';
        throw error;
      }

      const data = await res.json();
      return data; // { providerMessageId }
    } catch (err) {
      if (err.kind) throw err;
      // Cualquier error de red/fetch es incierto
      const error = new Error(err.message);
      error.kind = 'uncertain';
      throw error;
    }
  }

  async lookup(clientRef) {
    try {
      const res = await fetch(`${this.baseUrl}/messages?clientRef=${encodeURIComponent(clientRef)}`);
      if (!res.ok) {
        return { state: 'not_found' };
      }
      return await res.json();
    } catch (err) {
      return { state: 'not_found' };
    }
  }
}
