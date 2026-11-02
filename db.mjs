import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export function createDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  
  // Pragmas para seguridad e integridad
  db.exec('PRAGMA foreign_keys = ON;');

  // Schema setup
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      tenant_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      human_taken_over INTEGER NOT NULL DEFAULT 0,
      draft_body TEXT,
      draft_approved INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      ticket_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      sender_type TEXT NOT NULL, -- 'customer' | 'agent' | 'automation'
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      ticket_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      client_ref TEXT UNIQUE NOT NULL,
      provider_message_id TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL, -- 'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN'
      error_details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      ticket_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
  `);

  // Fixtures de prueba iniciales si la tabla tickets está vacía
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM tickets');
  const row = countStmt.get();
  if (row.cnt === 0) {
    db.exec(`
      INSERT INTO tickets (id, tenant_id, subject, status, human_taken_over, draft_body, draft_approved)
      VALUES 
        (101, 'alpha', 'Ayuda con mi póliza Alpha', 'open', 0, NULL, 0),
        (202, 'beta', 'Consulta sobre cobertura Beta', 'open', 0, NULL, 0);
    `);
  }

  return db;
}
