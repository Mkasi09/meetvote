import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, passwordMatches, resetAdminPassword } from "../src/admin-password.js";

const createDatabase = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
    "admin-id", "admin@elawini.local", "Estate Administrator", hashPassword("OldSecurePassword2026!"), "system_administrator"
  );
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
    "resident-id", "resident@elawini.local", "Estate Resident", hashPassword("ResidentPassword2026!"), "registered_participant"
  );
  return db;
};

test("resets only an administrator password and audits the change", () => {
  const db = createDatabase();
  try {
    const account = resetAdminPassword(db, "ADMIN@ELAWINI.LOCAL", "NewSecurePassword2026!");
    const saved = db.prepare("SELECT password_hash FROM users WHERE id = ?").get("admin-id");
    assert.equal(account.email, "admin@elawini.local");
    assert.equal(passwordMatches("NewSecurePassword2026!", saved.password_hash), true);
    assert.equal(passwordMatches("OldSecurePassword2026!", saved.password_hash), false);
    assert.equal(db.prepare("SELECT event_type FROM audit_events").get().event_type, "administrator.password_reset");
  } finally {
    db.close();
  }
});

test("does not reset non-administrator accounts or accept short passwords", () => {
  const db = createDatabase();
  try {
    assert.throws(() => resetAdminPassword(db, "resident@elawini.local", "NewSecurePassword2026!"), /No administrator account/);
    assert.throws(() => resetAdminPassword(db, "admin@elawini.local", "short"), /at least 12 characters/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
  } finally {
    db.close();
  }
});
