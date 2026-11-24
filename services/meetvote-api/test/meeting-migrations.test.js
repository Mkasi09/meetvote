import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const serviceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

test("migrates meeting details and candidate profiles for existing election templates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meetvote-meeting-migration-"));
  const databasePath = join(directory, "meetvote.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('system_administrator','meeting_organiser','registered_participant')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE election_templates (
      id TEXT PRIMARY KEY,
      template_name TEXT NOT NULL,
      title TEXT NOT NULL,
      voting_type TEXT NOT NULL CHECK(voting_type IN ('candidate','resolution','multiple_choice')),
      options_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      organiser_id TEXT NOT NULL REFERENCES users(id),
      openslides_meeting_id TEXT,
      plugnmeet_room_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-organiser", "organiser@example.test", "Legacy Organiser", "unused", "meeting_organiser", new Date().toISOString());
  database.prepare(`INSERT INTO election_templates
    (id, template_name, title, voting_type, options_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy-template", "Legacy template", "Legacy election", "candidate", "[]",
      "legacy-organiser", new Date().toISOString(), new Date().toISOString());
  database.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-meeting", "Legacy AGM", new Date(Date.now() + 60_000).toISOString(),
      "legacy-organiser", "9", "legacy-room", new Date().toISOString());
  database.close();

  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: serviceDirectory,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath },
    stdio: "ignore"
  });
  t.after(async () => {
    const stopped = new Promise((resolve) => {
      if (apiProcess.exitCode !== null) resolve();
      else apiProcess.once("exit", resolve);
    });
    apiProcess.kill();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "isolated MeetVote API did not become ready");

  const migrated = new DatabaseSync(databasePath);
  const columns = new Set(migrated.prepare("PRAGMA table_info(meetings)").all().map(({ name }) => name));
  assert.ok(columns.has("description"));
  assert.ok(columns.has("meeting_type"));
  assert.ok(columns.has("chairperson_id"));
  const templateColumns = new Set(migrated.prepare("PRAGMA table_info(election_templates)").all().map(({ name }) => name));
  assert.ok(templateColumns.has("candidate_profiles_json"));
  assert.equal(migrated.prepare("SELECT candidate_profiles_json FROM election_templates WHERE id = ?")
    .get("legacy-template").candidate_profiles_json, "[]");
  const tables = new Set(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  assert.ok(tables.has("meeting_documents"));
  assert.ok(tables.has("meeting_attendance"));
  assert.ok(tables.has("meeting_presence"));
  assert.ok(tables.has("meeting_questions"));
  assert.deepEqual({ ...migrated.prepare(`SELECT description, meeting_type, chairperson_id
    FROM meetings WHERE id = ?`).get("legacy-meeting") }, {
    description: "",
    meeting_type: "general",
    chairperson_id: "legacy-organiser"
  });
  migrated.close();
});
