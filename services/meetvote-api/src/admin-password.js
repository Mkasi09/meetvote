import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";

export const hashPassword = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};

export const passwordMatches = (password, stored) => {
  const [salt, expected] = stored.split(":");
  const actual = scryptSync(password, salt, 64).toString("hex");
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
};

export function resetAdminPassword(db, email, password) {
  if (password.length < 12) throw new Error("Use a password of at least 12 characters.");
  const account = db.prepare(`SELECT id, email, display_name FROM users
    WHERE email = ? AND role = 'system_administrator'`).get(email.toLowerCase());
  if (!account) throw new Error("No administrator account was found for that email.");

  const timestamp = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), account.id);
    db.prepare("INSERT INTO audit_events VALUES (?, 'system', NULL, 'administrator.password_reset', 'user', ?, ?, ?)")
      .run(randomUUID(), account.id, JSON.stringify({ email: account.email }), timestamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return account;
}
