import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { hashPassword, passwordMatches } from "./admin-password.js";
import { createOpenSlidesClient } from "./openslides.js";
import { createPlugNmeetClient } from "./plugnmeet.js";

const port = Number(process.env.PORT || 8090);
const databasePath = process.env.DATABASE_PATH || "./data/meetvote.sqlite";
const sessionTtlHours = Number(process.env.SESSION_TTL_HOURS || 12);
const bootstrapAdminEnabled = process.env.BOOTSTRAP_ADMIN_ENABLED === "true";
const maxRequestBodyBytes = 20 * 1024 * 1024;
const maxCandidatePhotoBytes = 1024 * 1024;
const maxMeetingDocumentBytes = 8 * 1024 * 1024;
const maxProxyDocumentBytes = 5 * 1024 * 1024;
const maxMeetingQuestionLength = 2000;
const maxMeetingAnswerLength = 3000;
const meetingPresenceWindowMs = 30_000;
const openslides = createOpenSlidesClient();
const plugnmeet = createPlugNmeetClient();
const corsOrigins = new Set((process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",").map((origin) => origin.trim()).filter(Boolean));

mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
const ballotSubmissionLocks = new Map();
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('system_administrator','meeting_organiser','registered_participant')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    organiser_id TEXT NOT NULL REFERENCES users(id),
    description TEXT NOT NULL DEFAULT '',
    meeting_type TEXT NOT NULL DEFAULT 'general',
    chairperson_id TEXT REFERENCES users(id),
    openslides_meeting_id TEXT,
    plugnmeet_room_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agenda_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
    created_at TEXT NOT NULL,
    UNIQUE (meeting_id, position)
  );
  CREATE TABLE IF NOT EXISTS motions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    agenda_item_id TEXT REFERENCES agenda_items(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    proposer_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meeting_documents (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK(mime_type = 'application/pdf'),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    content BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meeting_attendance (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checked_in_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS meeting_presence (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS meeting_questions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK(is_anonymous IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','answered','dismissed')),
    answer_text TEXT NOT NULL DEFAULT '',
    answered_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS elections (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    openslides_election_id TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    secret_ballot INTEGER NOT NULL DEFAULT 0,
    openslides_poll_id TEXT,
    candidates_json TEXT NOT NULL DEFAULT '[]',
    candidate_option_ids_json TEXT NOT NULL DEFAULT '[]',
    results_json TEXT,
    results_published_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft','open','closed')) DEFAULT 'draft',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS elections_expiry ON elections(status, ends_at);
  CREATE TABLE IF NOT EXISTS election_candidate_profiles (
    id TEXT PRIMARY KEY,
    election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    profile_order INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    position_title TEXT NOT NULL,
    biography TEXT NOT NULL,
    experience TEXT NOT NULL,
    statement TEXT NOT NULL DEFAULT '',
    photo_mime TEXT,
    photo_data BLOB,
    UNIQUE (election_id, profile_order)
  );
  CREATE TABLE IF NOT EXISTS election_templates (
    id TEXT PRIMARY KEY,
    template_name TEXT NOT NULL,
    title TEXT NOT NULL,
    voting_type TEXT NOT NULL CHECK(voting_type IN ('candidate','resolution','multiple_choice')),
    options_json TEXT NOT NULL DEFAULT '[]',
    candidate_profiles_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meeting_live_sessions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    active_agenda_item_id TEXT REFERENCES agenda_items(id) ON DELETE SET NULL,
    active_election_id TEXT REFERENCES elections(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_session_per_meeting
    ON meeting_live_sessions(meeting_id) WHERE ended_at IS NULL;
  CREATE TABLE IF NOT EXISTS voter_eligibility (
    election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    votes_allowed INTEGER NOT NULL DEFAULT 1 CHECK(votes_allowed > 0),
    PRIMARY KEY (election_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS election_voters (
    election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    openslides_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    credential_json TEXT NOT NULL,
    PRIMARY KEY (election_id, user_id),
    UNIQUE (election_id, openslides_user_id)
  );
  CREATE TABLE IF NOT EXISTS election_votes (
    election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (election_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS hoa_members (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE REFERENCES users(id),
    full_name TEXT NOT NULL,
    membership_number TEXT UNIQUE,
    member_type TEXT NOT NULL DEFAULT 'member' CHECK(member_type IN ('member','developer','special')),
    good_standing INTEGER NOT NULL DEFAULT 0 CHECK(good_standing IN (0,1)),
    is_entity INTEGER NOT NULL DEFAULT 0 CHECK(is_entity IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_hoa_developer
    ON hoa_members(member_type) WHERE member_type = 'developer' AND is_active = 1;
  CREATE TABLE IF NOT EXISTS hoa_units (
    id TEXT PRIMARY KEY,
    unit_number TEXT NOT NULL UNIQUE,
    voting_eligible INTEGER NOT NULL DEFAULT 0 CHECK(voting_eligible IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hoa_unit_members (
    unit_id TEXT NOT NULL REFERENCES hoa_units(id),
    member_id TEXT NOT NULL REFERENCES hoa_members(id),
    PRIMARY KEY (unit_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS hoa_voting_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    development_period_active INTEGER NOT NULL DEFAULT 0 CHECK(development_period_active IN (0,1)),
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meeting_quorum_events (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('quorum_met','adjourned')),
    actor_id TEXT REFERENCES users(id),
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS proxy_appointments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL REFERENCES hoa_units(id),
    member_ids_json TEXT NOT NULL,
    proxy_user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
    verified_by TEXT REFERENCES users(id),
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (meeting_id, unit_id)
  );
  CREATE TABLE IF NOT EXISTS proxy_documents (
    proxy_id TEXT NOT NULL REFERENCES proxy_appointments(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK(document_type = 'instrument' OR document_type LIKE 'member_id_%' OR document_type LIKE 'entity_resolution_%'),
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    encrypted_content BLOB NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (proxy_id, document_type)
  );
  CREATE TABLE IF NOT EXISTS guest_links (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user','guest','system')),
    actor_id TEXT,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
db.prepare(`INSERT OR IGNORE INTO hoa_voting_config
  (id, development_period_active, updated_by, updated_at) VALUES (1, 0, NULL, ?)`).run(new Date().toISOString());
const electionTemplateColumns = new Set(db.prepare("PRAGMA table_info(election_templates)").all().map((column) => column.name));
if (!electionTemplateColumns.has("candidate_profiles_json")) {
  db.exec("ALTER TABLE election_templates ADD COLUMN candidate_profiles_json TEXT NOT NULL DEFAULT '[]'");
}
const electionColumns = new Set(db.prepare("PRAGMA table_info(elections)").all().map((column) => column.name));
if (!electionColumns.has("openslides_poll_id")) db.exec("ALTER TABLE elections ADD COLUMN openslides_poll_id TEXT");
if (!electionColumns.has("candidates_json")) db.exec("ALTER TABLE elections ADD COLUMN candidates_json TEXT NOT NULL DEFAULT '[]'");
if (!electionColumns.has("candidate_option_ids_json")) db.exec("ALTER TABLE elections ADD COLUMN candidate_option_ids_json TEXT NOT NULL DEFAULT '[]'");
if (!electionColumns.has("results_json")) db.exec("ALTER TABLE elections ADD COLUMN results_json TEXT");
if (!electionColumns.has("results_published_at")) db.exec("ALTER TABLE elections ADD COLUMN results_published_at TEXT");
if (!electionColumns.has("voting_type")) db.exec("ALTER TABLE elections ADD COLUMN voting_type TEXT NOT NULL DEFAULT 'candidate'");
if (!electionColumns.has("agenda_item_id")) db.exec("ALTER TABLE elections ADD COLUMN agenda_item_id TEXT REFERENCES agenda_items(id) ON DELETE SET NULL");
if (!electionColumns.has("options_json")) db.exec("ALTER TABLE elections ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'");
if (!electionColumns.has("opened_at")) db.exec("ALTER TABLE elections ADD COLUMN opened_at TEXT");
if (!electionColumns.has("closed_at")) db.exec("ALTER TABLE elections ADD COLUMN closed_at TEXT");
db.exec("UPDATE elections SET options_json = candidates_json WHERE options_json = '[]' AND candidates_json != '[]'");
const meetingColumns = new Set(db.prepare("PRAGMA table_info(meetings)").all().map((column) => column.name));
if (!meetingColumns.has("plugnmeet_room_id")) db.exec("ALTER TABLE meetings ADD COLUMN plugnmeet_room_id TEXT");
if (!meetingColumns.has("description")) db.exec("ALTER TABLE meetings ADD COLUMN description TEXT NOT NULL DEFAULT ''");
if (!meetingColumns.has("meeting_type")) db.exec("ALTER TABLE meetings ADD COLUMN meeting_type TEXT NOT NULL DEFAULT 'general'");
if (!meetingColumns.has("chairperson_id")) {
  db.exec("ALTER TABLE meetings ADD COLUMN chairperson_id TEXT REFERENCES users(id)");
}
db.exec("UPDATE meetings SET chairperson_id = organiser_id WHERE chairperson_id IS NULL");
const agendaColumns = new Set(db.prepare("PRAGMA table_info(agenda_items)").all().map((column) => column.name));
if (!agendaColumns.has("status")) {
  db.exec("ALTER TABLE agenda_items ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed'))");
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
for (const election of db.prepare(`SELECT e.id, e.title, e.candidates_json
  FROM elections e WHERE e.voting_type = 'candidate'
    AND NOT EXISTS (SELECT 1 FROM election_candidate_profiles p WHERE p.election_id = e.id)`).all()) {
  const candidates = JSON.parse(election.candidates_json);
  if (!Array.isArray(candidates)) continue;
  const insertProfile = db.prepare(`INSERT INTO election_candidate_profiles
    (id, election_id, profile_order, full_name, position_title, biography, experience, statement)
    VALUES (?, ?, ?, ?, ?, '', '', '')`);
  candidates.forEach((name, index) => {
    if (typeof name === "string" && name.trim()) {
      insertProfile.run(id(), election.id, index, name.trim(), election.title);
    }
  });
}
const audit = (actorType, actorId, eventType, entityType, entityId, metadata = {}) => {
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id(), actorType, actorId || null, eventType, entityType, entityId, JSON.stringify(metadata), now());
};
const proxyDocumentKey = () => {
  const secret = process.env.PROXY_DOCUMENT_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) fail(503, "Private proxy document storage is not configured.");
  return createHmac("sha256", secret).update("elawini-meetvote-proxy-documents-v1").digest();
};
const proxyDocumentTypes = (memberIds, entityMemberIds) => [
  "instrument",
  ...memberIds.map((memberId) => `member_id_${memberId}`),
  ...entityMemberIds.map((memberId) => `entity_resolution_${memberId}`)
];
const encryptProxyDocument = (content) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", proxyDocumentKey(), iv);
  const encryptedContent = Buffer.concat([cipher.update(content), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), encryptedContent };
};
const decryptProxyDocument = (document) => {
  try {
    const decipher = createDecipheriv("aes-256-gcm", proxyDocumentKey(), document.iv);
    decipher.setAuthTag(document.auth_tag);
    return Buffer.concat([decipher.update(document.encrypted_content), decipher.final()]);
  } catch {
    fail(500, "The private proxy document could not be decrypted.");
  }
};
const proxyDocumentUploadValues = (body) => {
  if (typeof body.fileName !== "string" || !body.fileName.trim() || body.fileName.length > 180) {
    fail(400, "A document filename of 180 characters or fewer is required.");
  }
  if (!["application/pdf", "image/jpeg", "image/png"].includes(body.mimeType) ||
      typeof body.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64) ||
      body.contentBase64.length % 4 !== 0) {
    fail(400, "Upload a valid PDF, JPEG, or PNG document.");
  }
  const content = Buffer.from(body.contentBase64, "base64");
  if (!content.length || content.length > maxProxyDocumentBytes ||
      content.toString("base64") !== body.contentBase64) {
    fail(400, "Proxy documents must be valid files no larger than 5 MB.");
  }
  const isPdf = body.mimeType === "application/pdf" && content.subarray(0, 5).toString() === "%PDF-";
  const isJpeg = body.mimeType === "image/jpeg" && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const isPng = body.mimeType === "image/png" &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPdf && !isJpeg && !isPng) fail(400, "The uploaded file does not match its document type.");
  return {
    fileName: body.fileName.trim().replace(/[\u0000-\u001f\\/]/g, "_"),
    mimeType: body.mimeType,
    content
  };
};
const json = (response, status, body, origin) => {
  const allowedOrigin = origin && corsOrigins.has(origin) ? origin : null;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin, vary: "Origin" } : {}),
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS"
  });
  response.end(JSON.stringify(body));
};
const readBody = async (request) => {
  const parts = [];
  let totalBytes = 0;
  for await (const part of request) {
    totalBytes += part.length;
    if (totalBytes > maxRequestBodyBytes) {
      throw Object.assign(new Error("Request body exceeds the 20 MB limit."), { status: 413 });
    }
    parts.push(part);
  }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
};
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const candidateProfilesForElection = (electionId, options = []) => {
  const profiles = db.prepare(`SELECT id, profile_order, full_name, position_title, biography, experience,
      statement, photo_mime, photo_data
    FROM election_candidate_profiles WHERE election_id = ? ORDER BY profile_order`).all(electionId);
  if (!profiles.length) {
    return options.map((name, index) => ({
      candidateId: null,
      order: index,
      fullName: name,
      position: "",
      biography: "",
      experience: "",
      statement: "",
      photoData: null
    }));
  }
  return profiles.map((profile) => ({
    candidateId: profile.id,
    order: profile.profile_order,
    fullName: profile.full_name,
    position: profile.position_title,
    biography: profile.biography,
    experience: profile.experience,
    statement: profile.statement,
    photoData: profile.photo_data
      ? `data:${profile.photo_mime};base64,${Buffer.from(profile.photo_data).toString("base64")}`
      : null
  }));
};
const candidatePhoto = (value) => {
  if (value === undefined || value === null || value === "") {
    return { mime: null, data: null, provided: value !== undefined };
  }
  if (typeof value !== "string") fail(400, "Candidate photographs must be PNG or JPEG images.");
  const match = value.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail(400, "Candidate photographs must be PNG or JPEG images.");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > maxCandidatePhotoBytes || data.toString("base64") !== match[2]) {
    fail(400, "Candidate photographs must be valid images no larger than 1 MB.");
  }
  const mime = `image/${match[1]}`;
  const isPng = mime === "image/png" &&
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR";
  const isJpeg = mime === "image/jpeg" &&
    data.length >= 4 &&
    data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!isPng && !isJpeg) fail(400, "The uploaded photograph is not a valid PNG or JPEG image.");
  if (isPng) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 33_554_432) {
      fail(400, "Candidate photographs must be no larger than 8,192 × 8,192 pixels.");
    }
  }
  return { mime, data, provided: true };
};
const validateCandidateProfiles = (value) => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) {
    fail(400, "Provide profiles for between two and 50 candidates.");
  }
  const names = new Set();
  return value.map((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      fail(400, "Each candidate must have a complete profile.");
    }
    const text = (field, label, maxLength, { optional = false } = {}) => {
      const input = profile[field];
      if (optional && (input === undefined || input === null || input === "")) return "";
      if (typeof input !== "string" || !input.trim() || input.trim().length > maxLength) {
        fail(400, `${label} is required and must be no longer than ${maxLength} characters.`);
      }
      return input.trim();
    };
    const fullName = text("fullName", "Candidate full name", 160);
    const normalizedName = fullName.toLocaleLowerCase();
    if (names.has(normalizedName)) fail(400, "Candidate full names must be unique.");
    names.add(normalizedName);
    const position = text("position", "Position contested", 160);
    const biography = text("biography", "Candidate biography", 800);
    const experience = text("experience", "Candidate experience or qualifications", 1200);
    const statement = text("statement", "Candidate statement", 2000, { optional: true });
    const photo = candidatePhoto(profile.photoData);
    return {
      candidateId: typeof profile.candidateId === "string" ? profile.candidateId : null,
      fullName,
      position,
      biography,
      experience,
      statement,
      photoMime: photo.mime,
      photoData: photo.data,
      photoProvided: photo.provided
    };
  });
};
const userFromRequest = (request) => {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) fail(401, "Authentication is required.");
  const token = header.slice(7);
  const sessionTokenHash = tokenHash(token);
  const session = db.prepare(`SELECT u.id, u.email, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sessionTokenHash, now());
  if (!session) fail(401, "Your session is invalid or has expired.");
  return { ...session, sessionTokenHash };
};
const allow = (user, ...roles) => {
  if (!roles.includes(user.role)) fail(403, "You do not have permission for this action.");
};
const meetingAccess = (user, meetingId) => {
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId);
  if (!meeting) fail(404, "Meeting not found.");
  if (user.role !== "system_administrator" && meeting.organiser_id !== user.id) fail(403, "You do not manage this meeting.");
  return meeting;
};
const meetingDocumentsAccess = (user, meetingId) => {
  const meeting = db.prepare("SELECT id, organiser_id FROM meetings WHERE id = ?").get(meetingId);
  if (!meeting) fail(404, "Meeting not found.");
  if (user.role === "system_administrator" ||
      user.role === "registered_participant" ||
      (user.role === "meeting_organiser" && meeting.organiser_id === user.id)) return meeting;
  fail(403, "You do not have access to this meeting.");
};
const meetingManager = (user, meeting) => user.role === "system_administrator" ||
  (user.role === "meeting_organiser" && meeting.organiser_id === user.id);
const meetingQuorumStatus = (meetingId) => {
  const liveSession = db.prepare(`SELECT id, started_at FROM meeting_live_sessions
    WHERE meeting_id = ? AND ended_at IS NULL`).get(meetingId);
  const totalEligibleUnits = db.prepare(`SELECT COUNT(*) AS count FROM hoa_units
    WHERE is_active = 1 AND voting_eligible = 1`).get().count;
  const cutoff = new Date(Date.now() - meetingPresenceWindowMs).toISOString();
  const presentMembers = liveSession ? db.prepare(`SELECT COUNT(DISTINCT p.user_id) AS count
    FROM meeting_presence p JOIN users u ON u.id = p.user_id
    WHERE p.meeting_id = ? AND p.last_seen_at > ? AND u.role = 'registered_participant'`)
    .get(meetingId, cutoff).count : 0;
  const representedUnits = liveSession ? db.prepare(`SELECT COUNT(DISTINCT hu.id) AS count FROM hoa_units hu
    WHERE hu.is_active = 1 AND hu.voting_eligible = 1 AND (
      EXISTS (SELECT 1 FROM hoa_unit_members um JOIN hoa_members hm ON hm.id = um.member_id
        JOIN meeting_presence p ON p.user_id = hm.user_id JOIN users u ON u.id = p.user_id
        WHERE um.unit_id = hu.id AND hm.is_active = 1 AND hm.good_standing = 1
          AND p.meeting_id = ? AND p.last_seen_at > ? AND u.role = 'registered_participant')
      OR EXISTS (SELECT 1 FROM proxy_appointments pa JOIN meeting_presence p ON p.user_id = pa.proxy_user_id
        WHERE pa.meeting_id = ? AND pa.unit_id = hu.id AND pa.status = 'verified'
          AND p.meeting_id = ? AND p.last_seen_at > ?)
    )`).get(meetingId, cutoff, meetingId, meetingId, cutoff).count : 0;
  const requiredUnitVotes = Math.ceil(totalEligibleUnits * 0.25);
  const graceEndsAt = liveSession
    ? new Date(Date.parse(liveSession.started_at) + 15 * 60_000).toISOString()
    : null;
  const quorumMet = Boolean(liveSession && totalEligibleUnits > 0 &&
    representedUnits >= requiredUnitVotes && presentMembers >= 3);
  const graceExpired = Boolean(graceEndsAt && Date.parse(graceEndsAt) <= Date.now());
  const status = !liveSession ? "meeting_not_live" : quorumMet ? "met" : graceExpired ? "not_met" : "grace_period";
  return {
    status,
    quorumMet,
    presentMembers,
    requiredMembers: 3,
    representedUnits,
    totalEligibleUnits,
    requiredUnitVotes,
    graceEndsAt,
    graceExpired
  };
};
const addBusinessDays = (date, days) => {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) added += 1;
  }
  return result;
};
const electionTemplateValues = (body) => {
  if (typeof body.templateName !== "string" || !body.templateName.trim() || body.templateName.trim().length > 100) {
    fail(400, "A template name of 100 characters or fewer is required.");
  }
  if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
    fail(400, "An election title of 160 characters or fewer is required.");
  }
  if (!["candidate", "resolution", "multiple_choice"].includes(body.votingType)) {
    fail(400, "votingType must be candidate, resolution or multiple_choice.");
  }
  let candidateProfiles = [];
  if (body.votingType === "candidate" && body.candidateProfiles !== undefined &&
      !(Array.isArray(body.candidateProfiles) && body.candidateProfiles.length === 0)) {
    candidateProfiles = validateCandidateProfiles(body.candidateProfiles).map((profile) => ({
      fullName: profile.fullName,
      position: profile.position,
      biography: profile.biography,
      experience: profile.experience,
      statement: profile.statement,
      photoData: profile.photoData
        ? `data:${profile.photoMime};base64,${profile.photoData.toString("base64")}`
        : null
    }));
  } else if (body.votingType !== "candidate" && body.candidateProfiles !== undefined &&
      (!Array.isArray(body.candidateProfiles) || body.candidateProfiles.length > 0)) {
    fail(400, "Candidate profiles can only be saved with a candidate election template.");
  }
  let options = [];
  if (body.votingType === "multiple_choice") {
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 50 ||
        body.options.some((option) => typeof option !== "string" || !option.trim() || option.trim().length > 160)) {
      fail(400, "Provide between two and 50 voting choices, each no longer than 160 characters.");
    }
    options = body.options.map((option) => option.trim());
    if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
      fail(400, "Voting choices must be unique.");
    }
  }
  return {
    templateName: body.templateName.trim(),
    title: body.title.trim(),
    votingType: body.votingType,
    options,
    candidateProfiles
  };
};

const routes = {
  "GET /health": () => ({ status: "ok", service: "elawini-estate-meetvote-api", time: now() }),
  "POST /auth/logout": ({ user }) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.sessionTokenHash);
    return { loggedOut: true };
  },
  "POST /auth/bootstrap": ({ body }) => {
    if (!bootstrapAdminEnabled) fail(403, "Bootstrap is disabled.");
    if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) fail(409, "An administrator already exists.");
    if (!body.email || !body.password || !body.displayName) fail(400, "email, password and displayName are required.");
    if (body.password.length < 12) fail(400, "Use a password of at least 12 characters.");
    const userId = id();
    db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, body.email.toLowerCase(), body.displayName, hashPassword(body.password), "system_administrator", now());
    audit("system", null, "administrator.bootstrapped", "user", userId, { email: body.email.toLowerCase() });
    return { created: true, userId };
  },
  "POST /auth/login": ({ body }) => {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get((body.email || "").toLowerCase());
    if (!user || !passwordMatches(body.password || "", user.password_hash)) fail(401, "Email or password is incorrect.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionTtlHours * 3600_000).toISOString();
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(tokenHash(token), user.id, expiresAt, now());
    audit("user", user.id, "session.created", "user", user.id);
    return { accessToken: token, expiresAt, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } };
  },
  "GET /me": ({ user }) => ({ id: user.id, email: user.email, displayName: user.display_name, role: user.role }),
  "GET /hoa/membership": ({ user }) => {
    allow(user, "system_administrator");
    const members = db.prepare(`SELECT h.id, h.user_id, h.full_name, h.membership_number, h.member_type,
        h.good_standing, h.is_entity, h.is_active, h.updated_at,
        u.email, u.role
      FROM hoa_members h LEFT JOIN users u ON u.id = h.user_id
      ORDER BY h.full_name COLLATE NOCASE`).all().map((member) => ({
      id: member.id,
      userId: member.user_id,
      fullName: member.full_name,
      membershipNumber: member.membership_number,
      memberType: member.member_type,
      goodStanding: Boolean(member.good_standing),
      isEntity: Boolean(member.is_entity),
      isActive: Boolean(member.is_active),
      updatedAt: member.updated_at,
      email: member.email,
      role: member.role,
      units: db.prepare(`SELECT u.id, u.unit_number FROM hoa_units u
        JOIN hoa_unit_members um ON um.unit_id = u.id
        WHERE um.member_id = ? ORDER BY u.unit_number`).all(member.id)
    }));
    const units = db.prepare(`SELECT id, unit_number, voting_eligible, is_active, updated_at
      FROM hoa_units ORDER BY unit_number COLLATE NOCASE`).all().map((unit) => ({
      id: unit.id,
      unitNumber: unit.unit_number,
      votingEligible: Boolean(unit.voting_eligible),
      isActive: Boolean(unit.is_active),
      updatedAt: unit.updated_at,
      members: db.prepare(`SELECT h.id, h.full_name, h.member_type, h.good_standing, h.is_active
        FROM hoa_members h JOIN hoa_unit_members um ON um.member_id = h.id
        WHERE um.unit_id = ? ORDER BY h.full_name COLLATE NOCASE`).all(unit.id).map((member) => ({
        id: member.id,
        fullName: member.full_name,
        memberType: member.member_type,
        goodStanding: Boolean(member.good_standing),
        isActive: Boolean(member.is_active)
      }))
    }));
    const accounts = db.prepare(`SELECT id, email, display_name, role FROM users
      ORDER BY display_name COLLATE NOCASE`).all();
    const config = db.prepare("SELECT development_period_active, updated_at FROM hoa_voting_config WHERE id = 1").get();
    return {
      members,
      units,
      accounts,
      developmentPeriodActive: Boolean(config.development_period_active),
      updatedAt: config.updated_at
    };
  },
  "POST /hoa/members": ({ user, body }) => {
    allow(user, "system_administrator");
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const membershipNumber = typeof body.membershipNumber === "string" ? body.membershipNumber.trim() : "";
    const memberType = body.memberType || "member";
    if (!fullName || fullName.length > 160) fail(400, "Member name is required and must be 160 characters or fewer.");
    if (membershipNumber.length > 100) fail(400, "Membership number must be 100 characters or fewer.");
    if (!["member", "developer", "special"].includes(memberType)) fail(400, "Member type is invalid.");
    if (body.userId !== undefined && body.userId !== null && typeof body.userId !== "string") {
      fail(400, "Select a valid MeetVote account or leave the account unlinked.");
    }
    if (body.userId && !db.prepare("SELECT 1 FROM users WHERE id = ?").get(body.userId)) fail(400, "The selected account does not exist.");
    if (body.goodStanding !== undefined && typeof body.goodStanding !== "boolean") fail(400, "Good-standing status must be true or false.");
    if (body.isEntity !== undefined && typeof body.isEntity !== "boolean") fail(400, "Entity status must be true or false.");
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") fail(400, "Active status must be true or false.");
    const memberId = id();
    const timestamp = now();
    try {
      db.prepare(`INSERT INTO hoa_members
        (id, user_id, full_name, membership_number, member_type, good_standing, is_entity, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(memberId, body.userId || null, fullName, membershipNumber || null, memberType,
          Number(body.goodStanding === true), Number(body.isEntity === true), Number(body.isActive !== false), timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail(409, "This account, membership number, or Developer designation is already registered.");
      throw error;
    }
    audit("user", user.id, "hoa.member_created", "hoa_member", memberId, { memberType });
    return { id: memberId, fullName, membershipNumber: membershipNumber || null, memberType };
  },
  "PUT /hoa/members/:id": ({ user, params, body }) => {
    allow(user, "system_administrator");
    const existing = db.prepare("SELECT id FROM hoa_members WHERE id = ?").get(params.id);
    if (!existing) fail(404, "Member record not found.");
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const membershipNumber = typeof body.membershipNumber === "string" ? body.membershipNumber.trim() : "";
    const memberType = body.memberType;
    if (!fullName || fullName.length > 160) fail(400, "Member name is required and must be 160 characters or fewer.");
    if (membershipNumber.length > 100) fail(400, "Membership number must be 100 characters or fewer.");
    if (!["member", "developer", "special"].includes(memberType)) fail(400, "Member type is invalid.");
    if (body.userId !== null && body.userId !== "" && typeof body.userId !== "string") fail(400, "Select a valid MeetVote account or leave the account unlinked.");
    if (body.userId && body.userId !== "" && !db.prepare("SELECT 1 FROM users WHERE id = ?").get(body.userId)) fail(400, "The selected account does not exist.");
    if (typeof body.goodStanding !== "boolean" || typeof body.isEntity !== "boolean" || typeof body.isActive !== "boolean") {
      fail(400, "Good-standing, entity, and active statuses are required.");
    }
    try {
      db.prepare(`UPDATE hoa_members SET user_id = ?, full_name = ?, membership_number = ?, member_type = ?,
        good_standing = ?, is_entity = ?, is_active = ?, updated_at = ? WHERE id = ?`)
        .run(body.userId || null, fullName, membershipNumber || null, memberType,
          Number(body.goodStanding), Number(body.isEntity), Number(body.isActive), now(), params.id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail(409, "This account, membership number, or Developer designation is already registered.");
      throw error;
    }
    if (!body.goodStanding || !body.isActive) {
      db.prepare(`UPDATE hoa_units SET voting_eligible = 0, updated_at = ?
        WHERE id IN (SELECT unit_id FROM hoa_unit_members WHERE member_id = ?)`)
        .run(now(), params.id);
    }
    audit("user", user.id, "hoa.member_updated", "hoa_member", params.id, {
      memberType, goodStanding: body.goodStanding, isActive: body.isActive
    });
    return { id: params.id, fullName, membershipNumber: membershipNumber || null, memberType };
  },
  "POST /hoa/units": ({ user, body }) => {
    allow(user, "system_administrator");
    const unitNumber = typeof body.unitNumber === "string" ? body.unitNumber.trim() : "";
    const memberIds = body.memberIds;
    if (!unitNumber || unitNumber.length > 100) fail(400, "Unit/Erf number is required and must be 100 characters or fewer.");
    if (!Array.isArray(memberIds) || !memberIds.length ||
        memberIds.some((memberId) => typeof memberId !== "string") || new Set(memberIds).size !== memberIds.length) {
      fail(400, "Assign at least one unique Member record to the Unit/Erf.");
    }
    const members = memberIds.map((memberId) =>
      db.prepare("SELECT id, good_standing FROM hoa_members WHERE id = ? AND is_active = 1").get(memberId));
    if (members.some((member) => !member)) fail(400, "Every Unit/Erf owner must be an active Member record.");
    if (typeof body.votingEligible !== "boolean") fail(400, "Voting eligibility must be true or false.");
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") fail(400, "Active status must be true or false.");
    if (body.votingEligible && body.isActive === false) fail(400, "An inactive Unit/Erf cannot be eligible to vote.");
    if (body.votingEligible && members.some((member) => !member.good_standing)) {
      fail(409, "A Unit/Erf can only be marked eligible when every co-owner is in good standing.");
    }
    const unitId = id();
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO hoa_units (id, unit_number, voting_eligible, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(unitId, unitNumber, Number(body.votingEligible === true), Number(body.isActive !== false), timestamp, timestamp);
      const addMember = db.prepare("INSERT INTO hoa_unit_members (unit_id, member_id) VALUES (?, ?)");
      memberIds.forEach((memberId) => addMember.run(unitId, memberId));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE")) fail(409, "This Unit/Erf number is already registered.");
      throw error;
    }
    audit("user", user.id, "hoa.unit_created", "hoa_unit", unitId, { unitNumber, ownerCount: memberIds.length });
    return { id: unitId, unitNumber, memberIds };
  },
  "PUT /hoa/units/:id": ({ user, params, body }) => {
    allow(user, "system_administrator");
    const existing = db.prepare("SELECT id FROM hoa_units WHERE id = ?").get(params.id);
    if (!existing) fail(404, "Unit/Erf record not found.");
    const unitNumber = typeof body.unitNumber === "string" ? body.unitNumber.trim() : "";
    const memberIds = body.memberIds;
    if (!unitNumber || unitNumber.length > 100) fail(400, "Unit/Erf number is required and must be 100 characters or fewer.");
    if (!Array.isArray(memberIds) || !memberIds.length ||
        memberIds.some((memberId) => typeof memberId !== "string") || new Set(memberIds).size !== memberIds.length) {
      fail(400, "Assign at least one unique Member record to the Unit/Erf.");
    }
    if (typeof body.votingEligible !== "boolean" || typeof body.isActive !== "boolean") {
      fail(400, "Voting eligibility and active status are required.");
    }
    if (body.votingEligible && !body.isActive) fail(400, "An inactive Unit/Erf cannot be eligible to vote.");
    const members = memberIds.map((memberId) =>
      db.prepare("SELECT id, good_standing FROM hoa_members WHERE id = ? AND is_active = 1").get(memberId));
    if (members.some((member) => !member)) fail(400, "Every Unit/Erf owner must be an active Member record.");
    if (body.votingEligible && members.some((member) => !member.good_standing)) {
      fail(409, "A Unit/Erf can only be marked eligible when every co-owner is in good standing.");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE hoa_units SET unit_number = ?, voting_eligible = ?, is_active = ?, updated_at = ?
        WHERE id = ?`).run(unitNumber, Number(body.votingEligible), Number(body.isActive), now(), params.id);
      db.prepare("DELETE FROM hoa_unit_members WHERE unit_id = ?").run(params.id);
      const addMember = db.prepare("INSERT INTO hoa_unit_members (unit_id, member_id) VALUES (?, ?)");
      memberIds.forEach((memberId) => addMember.run(params.id, memberId));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE")) fail(409, "This Unit/Erf number or owner assignment is already registered.");
      throw error;
    }
    audit("user", user.id, "hoa.unit_updated", "hoa_unit", params.id, {
      unitNumber, ownerCount: memberIds.length, votingEligible: body.votingEligible, isActive: body.isActive
    });
    return { id: params.id, unitNumber, memberIds };
  },
  "PUT /hoa/voting-config": ({ user, body }) => {
    allow(user, "system_administrator");
    if (typeof body.developmentPeriodActive !== "boolean") fail(400, "Development-period status must be true or false.");
    if (body.developmentPeriodActive &&
        !db.prepare("SELECT 1 FROM hoa_members WHERE member_type = 'developer' AND is_active = 1 AND good_standing = 1").get()) {
      fail(409, "Register an active Developer Member in good standing before enabling the development period.");
    }
    const updatedAt = now();
    db.prepare(`UPDATE hoa_voting_config SET development_period_active = ?, updated_by = ?, updated_at = ?
      WHERE id = 1`).run(Number(body.developmentPeriodActive), user.id, updatedAt);
    audit("user", user.id, "hoa.development_period_updated", "hoa_voting_config", "1", {
      active: body.developmentPeriodActive
    });
    return { developmentPeriodActive: body.developmentPeriodActive, updatedAt };
  },
  "GET /meetings/:id/proxies": ({ user, params }) => {
    const meeting = meetingAccess(user, params.id);
    const appointments = db.prepare(`SELECT p.id, p.unit_id, p.member_ids_json, p.proxy_user_id, p.status,
        p.verified_by, p.verified_at, p.created_at, p.updated_at, u.unit_number,
        pu.display_name AS proxy_name, pu.email AS proxy_email, vu.display_name AS verified_by_name
      FROM proxy_appointments p JOIN hoa_units u ON u.id = p.unit_id
      JOIN users pu ON pu.id = p.proxy_user_id
      LEFT JOIN users vu ON vu.id = p.verified_by
      WHERE p.meeting_id = ? ORDER BY u.unit_number COLLATE NOCASE`).all(params.id);
    return appointments.map((appointment) => {
      const memberIds = JSON.parse(appointment.member_ids_json);
      const members = memberIds.map((memberId) =>
        db.prepare("SELECT id, full_name, is_entity FROM hoa_members WHERE id = ?").get(memberId))
        .filter(Boolean);
      const documents = db.prepare(`SELECT document_type, file_name, mime_type, size_bytes, created_at
        FROM proxy_documents WHERE proxy_id = ? ORDER BY document_type`).all(appointment.id);
      return {
        id: appointment.id,
        unitId: appointment.unit_id,
        unitNumber: appointment.unit_number,
        members: members.map((member) => ({ id: member.id, fullName: member.full_name, isEntity: Boolean(member.is_entity) })),
        proxyUserId: appointment.proxy_user_id,
        proxyName: appointment.proxy_name,
        proxyEmail: appointment.proxy_email,
        status: appointment.status,
        verifiedByName: appointment.verified_by_name,
        verifiedAt: appointment.verified_at,
        createdAt: appointment.created_at,
        updatedAt: appointment.updated_at,
        documents
      };
    });
  },
  "GET /meetings/:id/proxy-options": ({ user, params }) => {
    meetingAccess(user, params.id);
    const units = db.prepare(`SELECT id, unit_number FROM hoa_units
      WHERE is_active = 1 AND voting_eligible = 1 ORDER BY unit_number COLLATE NOCASE`).all().map((unit) => ({
      id: unit.id,
      unitNumber: unit.unit_number,
      members: db.prepare(`SELECT h.id, h.full_name, h.is_entity
        FROM hoa_unit_members um JOIN hoa_members h ON h.id = um.member_id
        WHERE um.unit_id = ? AND h.is_active = 1 AND h.good_standing = 1
        ORDER BY h.full_name COLLATE NOCASE`).all(unit.id).map((member) => ({
        id: member.id, fullName: member.full_name, isEntity: Boolean(member.is_entity)
      }))
    }));
    const accounts = db.prepare(`SELECT id, display_name, email FROM users
      WHERE role = 'registered_participant' ORDER BY display_name COLLATE NOCASE`).all();
    return { units, accounts };
  },
  "POST /meetings/:id/proxies": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (Date.parse(meeting.starts_at) <= Date.now() ||
        db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
      fail(409, "Proxy appointments must be submitted before the meeting starts.");
    }
    if (typeof body.unitId !== "string" || typeof body.proxyUserId !== "string" ||
        !Array.isArray(body.memberIds) || !body.memberIds.length ||
        body.memberIds.some((memberId) => typeof memberId !== "string") ||
        new Set(body.memberIds).size !== body.memberIds.length) {
      fail(400, "A Unit/Erf, every co-owner, and a registered proxy account are required.");
    }
    const unit = db.prepare("SELECT id, voting_eligible, is_active FROM hoa_units WHERE id = ?").get(body.unitId);
    if (!unit || !unit.is_active || !unit.voting_eligible) fail(409, "The selected Unit/Erf is not eligible to vote.");
    const owners = db.prepare(`SELECT h.id, h.good_standing, h.is_active
      FROM hoa_unit_members um JOIN hoa_members h ON h.id = um.member_id
      WHERE um.unit_id = ? ORDER BY h.id`).all(unit.id);
    const ownerIds = owners.map((member) => member.id).sort();
    const memberIds = [...body.memberIds].sort();
    if (JSON.stringify(ownerIds) !== JSON.stringify(memberIds) ||
        owners.some((member) => !member.is_active || !member.good_standing)) {
      fail(409, "The appointment must include every active co-owner of an eligible Unit/Erf.");
    }
    const proxyAccount = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'registered_participant'").get(body.proxyUserId);
    if (!proxyAccount) fail(400, "The selected proxy account does not exist.");
    const existing = db.prepare("SELECT id, status FROM proxy_appointments WHERE meeting_id = ? AND unit_id = ?")
      .get(params.id, unit.id);
    if (existing && existing.status !== "rejected") fail(409, "A proxy appointment already exists for this Unit/Erf.");
    const timestamp = now();
    const proxyId = existing ? existing.id : id();
    if (existing) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`UPDATE proxy_appointments SET member_ids_json = ?, proxy_user_id = ?, status = 'pending',
          verified_by = NULL, verified_at = NULL, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(ownerIds), body.proxyUserId, timestamp, proxyId);
        db.prepare("DELETE FROM proxy_documents WHERE proxy_id = ?").run(proxyId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      db.prepare(`INSERT INTO proxy_appointments
        (id, meeting_id, unit_id, member_ids_json, proxy_user_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(proxyId, params.id, unit.id, JSON.stringify(ownerIds), body.proxyUserId, timestamp, timestamp);
    }
    audit("user", user.id, existing ? "proxy.reappointed" : "proxy.appointed", "proxy_appointment", proxyId, {
      meetingId: params.id, unitId: unit.id, memberIds: ownerIds
    });
    return { id: proxyId, status: "pending" };
  },
  "PUT /meetings/:id/proxies/:proxyId/documents": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (Date.parse(meeting.starts_at) <= Date.now() ||
        db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
      fail(409, "Proxy documents must be delivered before the meeting starts.");
    }
    const proxy = db.prepare(`SELECT id, member_ids_json, status FROM proxy_appointments
      WHERE id = ? AND meeting_id = ?`).get(params.proxyId, params.id);
    if (!proxy) fail(404, "Proxy appointment not found.");
    if (proxy.status !== "pending") fail(409, "Documents can only be updated for a pending proxy appointment.");
    if (typeof body.documentType !== "string") fail(400, "Select a proxy document type.");
    const memberIds = JSON.parse(proxy.member_ids_json);
    const signerId = body.documentType.startsWith("member_id_")
      ? body.documentType.slice("member_id_".length)
      : body.documentType.startsWith("entity_resolution_")
        ? body.documentType.slice("entity_resolution_".length)
        : null;
    if (body.documentType !== "instrument" && (!signerId || !memberIds.includes(signerId))) {
      fail(400, "The document type must match an appointing Member.");
    }
    if (body.documentType.startsWith("entity_resolution_") &&
        !db.prepare("SELECT 1 FROM hoa_members WHERE id = ? AND is_entity = 1").get(signerId)) {
      fail(400, "Entity authorization documents are only required for an entity Member.");
    }
    if (!["instrument", "member_id_", "entity_resolution_"].some((prefix) =>
      body.documentType === prefix || body.documentType.startsWith(prefix))) {
      fail(400, "The proxy document type is invalid.");
    }
    const upload = proxyDocumentUploadValues(body);
    const encrypted = encryptProxyDocument(upload.content);
    const timestamp = now();
    db.prepare(`INSERT INTO proxy_documents
      (proxy_id, document_type, file_name, mime_type, size_bytes, iv, auth_tag, encrypted_content, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proxy_id, document_type) DO UPDATE SET file_name = excluded.file_name,
        mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, iv = excluded.iv,
        auth_tag = excluded.auth_tag, encrypted_content = excluded.encrypted_content,
        uploaded_by = excluded.uploaded_by, created_at = excluded.created_at`)
      .run(proxy.id, body.documentType, upload.fileName, upload.mimeType, upload.content.length,
        encrypted.iv, encrypted.authTag, encrypted.encryptedContent, user.id, timestamp);
    audit("user", user.id, "proxy.document_uploaded", "proxy_appointment", proxy.id, {
      meetingId: params.id, documentType: body.documentType, fileName: upload.fileName, sizeBytes: upload.content.length
    });
    return { uploaded: true, documentType: body.documentType, fileName: upload.fileName, sizeBytes: upload.content.length };
  },
  "PUT /meetings/:id/proxies/:proxyId/verify": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    if (!["verified", "rejected"].includes(body.status)) fail(400, "Proxy status must be verified or rejected.");
    const proxy = db.prepare(`SELECT p.id, p.unit_id, p.member_ids_json, p.status, u.voting_eligible, u.is_active
      FROM proxy_appointments p JOIN hoa_units u ON u.id = p.unit_id
      WHERE p.id = ? AND p.meeting_id = ?`).get(params.proxyId, params.id);
    if (!proxy) fail(404, "Proxy appointment not found.");
    if (proxy.status !== "pending") fail(409, "Only pending proxy appointments can be verified or rejected.");
    if (body.status === "verified") {
      const memberIds = JSON.parse(proxy.member_ids_json);
      const members = memberIds.map((memberId) =>
        db.prepare("SELECT id, good_standing, is_active, is_entity FROM hoa_members WHERE id = ?").get(memberId));
      if (!proxy.is_active || !proxy.voting_eligible || members.some((member) =>
        !member || !member.is_active || !member.good_standing)) {
        fail(409, "The Unit/Erf and every appointing Member must remain eligible.");
      }
      const entityIds = members.filter((member) => member.is_entity).map((member) => member.id);
      const requiredDocuments = proxyDocumentTypes(memberIds, entityIds);
      const presentDocuments = new Set(db.prepare("SELECT document_type FROM proxy_documents WHERE proxy_id = ?")
        .all(proxy.id).map((document) => document.document_type));
      if (requiredDocuments.some((documentType) => !presentDocuments.has(documentType))) {
        fail(409, "Upload the signed proxy instrument, each appointing Member's ID, and required entity authorization before verification.");
      }
    }
    const timestamp = now();
    db.prepare(`UPDATE proxy_appointments SET status = ?, verified_by = ?, verified_at = ?, updated_at = ?
      WHERE id = ?`).run(body.status, user.id, timestamp, timestamp, proxy.id);
    audit("user", user.id, `proxy.${body.status}`, "proxy_appointment", proxy.id, {
      meetingId: params.id, reason: typeof body.reason === "string" ? body.reason.slice(0, 1000) : ""
    });
    return { id: proxy.id, status: body.status, verifiedAt: timestamp };
  },
  "GET /meetings/:id/proxies/:proxyId/documents/:documentType": ({ user, params }) => {
    meetingAccess(user, params.id);
    const proxy = db.prepare("SELECT id FROM proxy_appointments WHERE id = ? AND meeting_id = ?")
      .get(params.proxyId, params.id);
    if (!proxy) fail(404, "Proxy appointment not found.");
    const document = db.prepare(`SELECT document_type, file_name, mime_type, size_bytes, iv, auth_tag,
        encrypted_content FROM proxy_documents WHERE proxy_id = ? AND document_type = ?`)
      .get(proxy.id, params.documentType);
    if (!document) fail(404, "Proxy document not found.");
    const content = decryptProxyDocument(document);
    audit("user", user.id, "proxy.document_downloaded", "proxy_appointment", proxy.id, {
      meetingId: params.id, documentType: document.document_type
    });
    return {
      documentType: document.document_type,
      fileName: document.file_name,
      mimeType: document.mime_type,
      sizeBytes: document.size_bytes,
      contentBase64: content.toString("base64")
    };
  },
  "PUT /me/profile": ({ user, body }) => {
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName || displayName.length > 100) fail(400, "Display name must be between 1 and 100 characters.");
    if (displayName !== user.display_name) {
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, user.id);
      audit("user", user.id, "user.profile_updated", "user", user.id, { displayNameChanged: true });
    }
    return { id: user.id, email: user.email, displayName, role: user.role };
  },
  "POST /me/password": ({ user, body }) => {
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      fail(400, "Current and new passwords are required.");
    }
    if (body.newPassword.length < 12) fail(400, "Use a password of at least 12 characters.");
    if (body.newPassword.length > 256) fail(400, "New passwords must be 256 characters or fewer.");
    const account = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
    if (!account || !passwordMatches(body.currentPassword, account.password_hash)) {
      fail(401, "Current password is incorrect.");
    }
    if (passwordMatches(body.newPassword, account.password_hash)) {
      fail(400, "Choose a new password that is different from your current password.");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(body.newPassword), user.id);
      const revokedSessions = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
        .run(user.id, user.sessionTokenHash).changes;
      audit("user", user.id, "user.password_changed", "user", user.id, { otherSessionsRevoked: revokedSessions });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { passwordChanged: true };
  },
  "POST /users": ({ user, body }) => {
    allow(user, "system_administrator");
    if (!body.email || !body.password || !body.displayName || !body.role) fail(400, "email, password, displayName and role are required.");
    if (!['system_administrator', 'meeting_organiser', 'registered_participant'].includes(body.role)) fail(400, "role is invalid.");
    if (body.password.length < 12) fail(400, "Use a password of at least 12 characters.");
    const userId = id();
    try {
      db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)")
        .run(userId, body.email.toLowerCase(), body.displayName, hashPassword(body.password), body.role, now());
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail(409, "A user with this email already exists.");
      throw error;
    }
    audit("user", user.id, "user.created", "user", userId, { role: body.role });
    return { id: userId, email: body.email.toLowerCase(), displayName: body.displayName, role: body.role };
  },
  "GET /users/meeting-chairpersons": ({ user }) => {
    allow(user, "system_administrator", "meeting_organiser");
    return db.prepare(`SELECT id, display_name, role FROM users
      ORDER BY display_name COLLATE NOCASE`).all().map((candidate) => ({
      id: candidate.id,
      displayName: candidate.display_name,
      role: candidate.role
    }));
  },
  "POST /meetings": async ({ user, body }) => {
    allow(user, "system_administrator", "meeting_organiser");
    if (!body.title || !body.startsAt) fail(400, "title and startsAt are required.");
    if (!Number.isFinite(Date.parse(body.startsAt))) fail(400, "startsAt must be a valid date and time.");
    if (body.description !== undefined &&
        (typeof body.description !== "string" || body.description.length > 2000)) {
      fail(400, "description must be 2,000 characters or fewer.");
    }
    const meetingType = body.meetingType || "general";
    if (!["general", "agm", "committee", "special"].includes(meetingType)) {
      fail(400, "meetingType must be general, agm, committee or special.");
    }
    const chairpersonId = body.chairpersonId === undefined ? user.id : body.chairpersonId;
    if (typeof chairpersonId !== "string" || !chairpersonId.trim()) {
      fail(400, "chairpersonId must identify an existing user.");
    }
    const chairperson = db.prepare("SELECT id FROM users WHERE id = ?").get(chairpersonId);
    if (!chairperson) fail(400, "The selected chairperson does not exist.");
    if (!plugnmeet.isConfigured()) fail(503, "Live meeting setup is not configured. Contact an administrator.");
    const meetingId = id();
    const openslidesMeetingId = await openslides.createMeeting({ title: body.title, startsAt: body.startsAt });
    let plugnmeetRoomId;
    try {
      plugnmeetRoomId = await plugnmeet.createRoom({ title: body.title });
    } catch (error) {
      try {
        await openslides.deleteMeeting(openslidesMeetingId);
      } catch {
        fail(502, "Meeting setup did not finish, and cleanup is required. Ask an administrator to check the service configuration.");
      }
      throw error;
    }
    const description = (body.description || "").trim();
    db.prepare(`INSERT INTO meetings
      (id, title, starts_at, organiser_id, openslides_meeting_id, plugnmeet_room_id, created_at,
        description, meeting_type, chairperson_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(meetingId, body.title, body.startsAt, user.id, openslidesMeetingId, plugnmeetRoomId,
        now(), description, meetingType, chairpersonId);
    audit("user", user.id, "meeting.created", "meeting", meetingId, {
      title: body.title, meetingType, chairpersonId, openslidesMeetingId, plugnmeetRoomId
    });
    return { id: meetingId, title: body.title, startsAt: body.startsAt, description, meetingType, chairpersonId };
  },
  "GET /meetings": ({ user }) => {
    const meetings = user.role === "system_administrator" || user.role === "registered_participant"
      ? db.prepare(`SELECT m.id, m.title, m.starts_at, m.description, m.meeting_type,
          COALESCE(chair.display_name, u.display_name) AS chairperson_name, u.display_name AS organiser_name,
          (m.plugnmeet_room_id IS NOT NULL) AS has_live_room,
          COUNT(e.id) AS election_count
        FROM meetings m JOIN users u ON u.id = m.organiser_id
        LEFT JOIN users chair ON chair.id = m.chairperson_id
        LEFT JOIN elections e ON e.meeting_id = m.id
        GROUP BY m.id ORDER BY m.starts_at`).all()
      : db.prepare(`SELECT m.id, m.title, m.starts_at, m.description, m.meeting_type,
          COALESCE(chair.display_name, u.display_name) AS chairperson_name, u.display_name AS organiser_name,
          (m.plugnmeet_room_id IS NOT NULL) AS has_live_room,
          COUNT(e.id) AS election_count
        FROM meetings m JOIN users u ON u.id = m.organiser_id
        LEFT JOIN users chair ON chair.id = m.chairperson_id
        LEFT JOIN elections e ON e.meeting_id = m.id
        WHERE m.organiser_id = ? GROUP BY m.id ORDER BY m.starts_at`).all(user.id);
    return meetings;
  },
  "GET /meetings/:id/agenda": ({ user, params }) => {
    const meeting = db.prepare("SELECT id, organiser_id FROM meetings WHERE id = ?").get(params.id);
    if (!meeting) fail(404, "Meeting not found.");
    if (user.role === "meeting_organiser" && meeting.organiser_id !== user.id) fail(403, "You do not manage this meeting.");
    const items = db.prepare(`SELECT id, title, description, position, status
      FROM agenda_items WHERE meeting_id = ? ORDER BY position, created_at`).all(params.id);
    const motions = db.prepare(`SELECT m.id, m.agenda_item_id, m.title, m.text, m.created_at,
        u.display_name AS proposer_name
      FROM motions m JOIN users u ON u.id = m.proposer_id
      WHERE m.meeting_id = ? ORDER BY m.created_at`).all(params.id);
    return {
      items: items.map((item) => ({
        ...item,
        motions: motions.filter((motion) => motion.agenda_item_id === item.id)
      })),
      motions: motions.filter((motion) => !motion.agenda_item_id)
    };
  },
  "GET /meetings/:id/documents": ({ user, params }) => {
    meetingDocumentsAccess(user, params.id);
    return db.prepare(`SELECT id, meeting_id, file_name, mime_type, size_bytes, created_at
      FROM meeting_documents WHERE meeting_id = ? ORDER BY created_at DESC`).all(params.id);
  },
  "POST /meetings/:id/documents": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    if (typeof body.fileName !== "string" || !body.fileName.trim() || body.fileName.length > 180) {
      fail(400, "A document filename of 180 characters or fewer is required.");
    }
    if (body.mimeType !== "application/pdf" || typeof body.contentBase64 !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(body.contentBase64) || body.contentBase64.length % 4 !== 0) {
      fail(400, "Upload a valid PDF document.");
    }
    const content = Buffer.from(body.contentBase64, "base64");
    if (!content.length || content.length > maxMeetingDocumentBytes ||
        content.toString("base64") !== body.contentBase64 || content.subarray(0, 5).toString("ascii") !== "%PDF-") {
      fail(400, "Upload a valid PDF no larger than 8 MB.");
    }
    const fileName = body.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
    if (!fileName || !/\.pdf$/i.test(fileName)) fail(400, "Document filenames must end in .pdf.");
    const documentId = id();
    const createdAt = now();
    db.prepare(`INSERT INTO meeting_documents
      (id, meeting_id, uploaded_by, file_name, mime_type, size_bytes, content, created_at)
      VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?)`)
      .run(documentId, params.id, user.id, fileName, content.length, content, createdAt);
    audit("user", user.id, "meeting.document_uploaded", "meeting_document", documentId, {
      meetingId: params.id, sizeBytes: content.length
    });
    return { id: documentId, meetingId: params.id, fileName, mimeType: "application/pdf", sizeBytes: content.length, createdAt };
  },
  "GET /meetings/:id/documents/:documentId": ({ user, params }) => {
    meetingDocumentsAccess(user, params.id);
    const document = db.prepare(`SELECT file_name, mime_type, content
      FROM meeting_documents WHERE id = ? AND meeting_id = ?`).get(params.documentId, params.id);
    if (!document) fail(404, "Meeting document not found.");
    return {
      fileName: document.file_name,
      mimeType: document.mime_type,
      contentBase64: Buffer.from(document.content).toString("base64")
    };
  },
  "DELETE /meetings/:id/documents/:documentId": ({ user, params }) => {
    meetingAccess(user, params.id);
    const document = db.prepare("SELECT id FROM meeting_documents WHERE id = ? AND meeting_id = ?")
      .get(params.documentId, params.id);
    if (!document) fail(404, "Meeting document not found.");
    db.prepare("DELETE FROM meeting_documents WHERE id = ?").run(params.documentId);
    audit("user", user.id, "meeting.document_deleted", "meeting_document", params.documentId, { meetingId: params.id });
    return { deleted: true };
  },
  "GET /meetings/:id/attendance": ({ user, params }) => {
    const meeting = meetingDocumentsAccess(user, params.id);
    const manager = meetingManager(user, meeting);
    const registeredResidents = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'registered_participant'").get().count;
    const checkedInCount = db.prepare("SELECT COUNT(*) AS count FROM meeting_attendance WHERE meeting_id = ?")
      .get(params.id).count;
    const liveSession = db.prepare("SELECT id FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL")
      .get(params.id);
    const onlineCount = liveSession
      ? db.prepare(`SELECT COUNT(*) AS count FROM meeting_presence
          WHERE meeting_id = ? AND last_seen_at > ?`)
        .get(params.id, new Date(Date.now() - meetingPresenceWindowMs).toISOString()).count
      : 0;
    const response = {
      registeredResidents,
      checkedInCount,
      onlineCount,
      checkedIn: Boolean(db.prepare("SELECT 1 FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
        .get(params.id, user.id)),
      quorum: meetingQuorumStatus(params.id)
    };
    if (manager) {
      response.attendees = db.prepare(`SELECT u.display_name, a.checked_in_at
        FROM meeting_attendance a JOIN users u ON u.id = a.user_id
        WHERE a.meeting_id = ? ORDER BY a.checked_in_at, u.display_name COLLATE NOCASE`).all(params.id);
      response.onlineParticipants = liveSession
        ? db.prepare(`SELECT u.display_name, p.last_seen_at
            FROM meeting_presence p JOIN users u ON u.id = p.user_id
            WHERE p.meeting_id = ? AND p.last_seen_at > ?
            ORDER BY u.display_name COLLATE NOCASE`)
          .all(params.id, new Date(Date.now() - meetingPresenceWindowMs).toISOString())
        : [];
    }
    return response;
  },
  "GET /meetings/:id/quorum": ({ user, params }) => {
    meetingDocumentsAccess(user, params.id);
    return meetingQuorumStatus(params.id);
  },
  "POST /meetings/:id/quorum/adjourn": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    const quorum = meetingQuorumStatus(params.id);
    if (!quorum.graceExpired || quorum.quorumMet) {
      fail(409, "Adjournment is available only after the 15-minute grace period when quorum has not been reached.");
    }
    if (typeof body.resumeAt !== "string" || !Number.isFinite(Date.parse(body.resumeAt)) ||
        Date.parse(body.resumeAt) <= Date.now()) {
      fail(400, "Provide a future date and time for the adjourned meeting.");
    }
    const latestResume = addBusinessDays(new Date(), 15);
    if (Date.parse(body.resumeAt) > latestResume.getTime()) {
      fail(400, "The adjourned meeting must resume within 15 business days.");
    }
    const liveSession = db.prepare(`SELECT id FROM meeting_live_sessions
      WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    if (!liveSession) fail(409, "This meeting is not live.");
    if (db.prepare("SELECT 1 FROM elections WHERE meeting_id = ? AND status = 'open'").get(params.id)) {
      fail(409, "Close the open voting item before adjourning the meeting.");
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE meetings SET starts_at = ? WHERE id = ?").run(new Date(body.resumeAt).toISOString(), params.id);
      db.prepare("UPDATE meeting_live_sessions SET ended_at = ? WHERE id = ?").run(timestamp, liveSession.id);
      db.prepare(`INSERT INTO meeting_quorum_events
        (id, meeting_id, event_type, actor_id, metadata_json, created_at)
        VALUES (?, ?, 'adjourned', ?, ?, ?)`)
        .run(id(), params.id, user.id, JSON.stringify({
          resumeAt: new Date(body.resumeAt).toISOString(),
          graceEndsAt: quorum.graceEndsAt,
          presentMembers: quorum.presentMembers,
          representedUnits: quorum.representedUnits,
          requiredUnitVotes: quorum.requiredUnitVotes
        }), timestamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit("user", user.id, "meeting.adjourned_for_quorum", "meeting", params.id, {
      resumeAt: new Date(body.resumeAt).toISOString(), presentMembers: quorum.presentMembers,
      representedUnits: quorum.representedUnits, requiredUnitVotes: quorum.requiredUnitVotes
    });
    return { adjourned: true, resumeAt: new Date(body.resumeAt).toISOString(), endedAt: timestamp };
  },
  "POST /meetings/:id/attendance/check-in": ({ user, params }) => {
    if (user.role !== "registered_participant") fail(403, "Only registered residents can check in.");
    meetingDocumentsAccess(user, params.id);
    if (!db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
      fail(409, "Check-in is available while the meeting is live.");
    }
    const checkedInAt = now();
    const result = db.prepare("INSERT OR IGNORE INTO meeting_attendance VALUES (?, ?, ?)")
      .run(params.id, user.id, checkedInAt);
    const attendance = db.prepare("SELECT checked_in_at FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
      .get(params.id, user.id);
    if (result.changes) audit("user", user.id, "meeting.attendance_checked_in", "meeting", params.id, { checkedInAt });
    return { checkedIn: true, checkedInAt: attendance.checked_in_at };
  },
  "POST /meetings/:id/presence": ({ user, params }) => {
    if (user.role !== "registered_participant") fail(403, "Only registered residents are counted as live participants.");
    meetingDocumentsAccess(user, params.id);
    if (!db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
      fail(409, "Live presence is available while the meeting is active.");
    }
    const timestamp = now();
    db.prepare(`INSERT INTO meeting_presence (meeting_id, user_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .run(params.id, user.id, timestamp, timestamp);
    return { present: true, lastSeenAt: timestamp };
  },
  "GET /meetings/:id/questions": ({ user, params }) => {
    const meeting = meetingDocumentsAccess(user, params.id);
    const manager = meetingManager(user, meeting);
    return db.prepare(`SELECT q.id, q.question_text, q.is_anonymous, q.status, q.answer_text,
        q.created_at, q.updated_at, q.user_id,
        CASE WHEN q.is_anonymous = 1 THEN 'Anonymous resident' ELSE u.display_name END AS display_name
      FROM meeting_questions q JOIN users u ON u.id = q.user_id
      WHERE q.meeting_id = ? AND (? = 1 OR q.status IN ('published','answered') OR q.user_id = ?)
      ORDER BY CASE q.status WHEN 'pending' THEN 0 WHEN 'published' THEN 1 WHEN 'answered' THEN 2 ELSE 3 END,
        q.created_at`).all(params.id, Number(manager), user.id)
      .map((question) => ({
        id: question.id,
        question: question.question_text,
        isAnonymous: Boolean(question.is_anonymous),
        status: question.status,
        answer: question.answer_text,
        displayName: question.display_name,
        createdAt: question.created_at,
        updatedAt: question.updated_at,
        isOwn: question.user_id === user.id
      }));
  },
  "POST /meetings/:id/questions": ({ user, params, body }) => {
    if (user.role !== "registered_participant") fail(403, "Only registered residents can submit meeting questions.");
    meetingDocumentsAccess(user, params.id);
    if (!db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
      fail(409, "Questions can be submitted while the meeting is live.");
    }
    if (typeof body.question !== "string" || !body.question.trim() ||
        body.question.trim().length > maxMeetingQuestionLength) {
      fail(400, `Question text is required and must be ${maxMeetingQuestionLength} characters or fewer.`);
    }
    if (body.isAnonymous !== undefined && typeof body.isAnonymous !== "boolean") {
      fail(400, "isAnonymous must be true or false.");
    }
    const questionId = id();
    const timestamp = now();
    db.prepare(`INSERT INTO meeting_questions
      (id, meeting_id, user_id, question_text, is_anonymous, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(questionId, params.id, user.id, body.question.trim(), body.isAnonymous ? 1 : 0, timestamp, timestamp);
    audit("user", user.id, "meeting.question_submitted", "meeting_question", questionId, {
      meetingId: params.id, anonymous: Boolean(body.isAnonymous)
    });
    return { id: questionId, status: "pending", createdAt: timestamp };
  },
  "PUT /meetings/:id/questions/:questionId": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    const question = db.prepare("SELECT id, status FROM meeting_questions WHERE id = ? AND meeting_id = ?")
      .get(params.questionId, params.id);
    if (!question) fail(404, "Meeting question not found.");
    const nextStatus = body.status;
    const allowed = question.status === "pending"
      ? ["published", "dismissed"]
      : question.status === "published" ? ["answered", "dismissed"] : [];
    if (!allowed.includes(nextStatus)) {
      fail(409, "Questions can be published or dismissed from pending, then answered or dismissed after publication.");
    }
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (nextStatus === "answered" && (!answer || answer.length > maxMeetingAnswerLength)) {
      fail(400, `An answer is required and must be ${maxMeetingAnswerLength} characters or fewer.`);
    }
    const timestamp = now();
    db.prepare(`UPDATE meeting_questions SET status = ?, answer_text = ?, answered_by = ?, updated_at = ?
      WHERE id = ?`).run(nextStatus, nextStatus === "answered" ? answer : "", nextStatus === "answered" ? user.id : null,
      timestamp, params.questionId);
    audit("user", user.id, "meeting.question_moderated", "meeting_question", params.questionId, { status: nextStatus });
    return { id: params.questionId, status: nextStatus, updatedAt: timestamp };
  },
  "GET /meetings/:id/report": ({ user, params }) => {
    const meeting = meetingDocumentsAccess(user, params.id);
    const details = db.prepare(`SELECT m.title, m.description, m.meeting_type, m.starts_at,
        organiser.display_name AS organiser_name, chair.display_name AS chairperson_name
      FROM meetings m JOIN users organiser ON organiser.id = m.organiser_id
      LEFT JOIN users chair ON chair.id = m.chairperson_id WHERE m.id = ?`).get(params.id);
    const registeredResidents = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'registered_participant'").get().count;
    const checkedInCount = db.prepare("SELECT COUNT(*) AS count FROM meeting_attendance WHERE meeting_id = ?")
      .get(params.id).count;
    const rows = [["Section", "Item", "Status", "Details"]];
    const addRow = (section, item, status = "", value = "") => rows.push([section, item, status, value]);
    addRow("Meeting", "Title", "", details.title);
    addRow("Meeting", "Type", "", details.meeting_type);
    addRow("Meeting", "Date", "", details.starts_at);
    addRow("Meeting", "Description", "", details.description);
    addRow("Meeting", "Organiser", "", details.organiser_name);
    addRow("Meeting", "Chairperson", "", details.chairperson_name || details.organiser_name);
    addRow("Attendance", "Registered residents", "", registeredResidents);
    addRow("Attendance", "Checked in", "", checkedInCount);
    const quorum = meetingQuorumStatus(params.id);
    addRow("Attendance", "Quorum", quorum.status, `${quorum.representedUnits}/${quorum.totalEligibleUnits} represented Units; ${quorum.presentMembers}/${quorum.requiredMembers} live attendees`);
    db.prepare(`SELECT position, title, description, status FROM agenda_items
      WHERE meeting_id = ? ORDER BY position`).all(params.id)
      .forEach((item) => addRow("Agenda", `${item.position}. ${item.title}`, item.status, item.description));
    db.prepare(`SELECT m.title, m.text, u.display_name AS proposer_name
      FROM motions m JOIN users u ON u.id = m.proposer_id
      WHERE m.meeting_id = ? ORDER BY m.created_at`).all(params.id)
      .forEach((motion) => addRow("Motion", motion.title, "", `${motion.text} (Proposed by ${motion.proposer_name})`));
    db.prepare(`SELECT q.question_text, q.is_anonymous, q.status, q.answer_text,
        u.display_name AS display_name
      FROM meeting_questions q JOIN users u ON u.id = q.user_id
      WHERE q.meeting_id = ? AND q.status IN ('published','answered')
      ORDER BY q.created_at`).all(params.id)
      .forEach((question) => addRow(
        "Question",
        question.is_anonymous ? "Anonymous resident" : question.display_name,
        question.status,
        question.answer_text ? `${question.question_text}\nAnswer: ${question.answer_text}` : question.question_text
      ));
    db.prepare(`SELECT title, status, starts_at, ends_at, results_json
      FROM elections WHERE meeting_id = ? ORDER BY starts_at`).all(params.id)
      .forEach((election) => {
        addRow("Vote", election.title, election.status, `${election.starts_at} — ${election.ends_at}`);
        if (election.results_json) {
          const results = JSON.parse(election.results_json);
          (results.candidates || []).forEach((option) => addRow("Aggregate result", option.name, "", option.votes));
          addRow("Aggregate result", "Ballots cast", "", results.votesCast);
          addRow("Aggregate result", "Eligible voters", "", results.eligibleVoters);
        }
      });
    const csv = rows.map((row) => row.map((value) => {
      const text = String(value ?? "");
      const safe = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(",")).join("\r\n");
    const slug = details.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || meeting.id;
    return {
      fileName: `${slug}-meeting-report.csv`,
      mimeType: "text/csv;charset=utf-8",
      contentBase64: Buffer.from(csv, "utf8").toString("base64")
    };
  },
  "PUT /meetings/:id/agenda/:itemId/status": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    if (!["pending", "in_progress", "completed"].includes(body.status)) {
      fail(400, "status must be pending, in_progress or completed.");
    }
    const item = db.prepare("SELECT id FROM agenda_items WHERE id = ? AND meeting_id = ?")
      .get(params.itemId, params.id);
    if (!item) fail(404, "Agenda item not found.");
    const session = db.prepare(`SELECT id, active_agenda_item_id, active_election_id
      FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    const activeElectionOpen = session?.active_election_id &&
      db.prepare("SELECT 1 FROM elections WHERE id = ? AND status = 'open'").get(session.active_election_id);
    if (activeElectionOpen &&
        (session.active_agenda_item_id !== params.itemId || body.status !== "in_progress")) {
      fail(409, "Close voting before moving to another agenda item.");
    }

    db.exec("BEGIN");
    try {
      if (session && session.active_agenda_item_id !== params.itemId && body.status === "in_progress") {
        if (session.active_agenda_item_id) {
          db.prepare("UPDATE agenda_items SET status = 'completed' WHERE id = ? AND meeting_id = ?")
            .run(session.active_agenda_item_id, params.id);
        }
        db.prepare("UPDATE meeting_live_sessions SET active_agenda_item_id = ? WHERE id = ?")
          .run(params.itemId, session.id);
      } else if (session?.active_agenda_item_id === params.itemId && body.status !== "in_progress") {
        db.prepare("UPDATE meeting_live_sessions SET active_agenda_item_id = NULL WHERE id = ?")
          .run(session.id);
      }
      db.prepare("UPDATE agenda_items SET status = ? WHERE id = ? AND meeting_id = ?")
        .run(body.status, params.itemId, params.id);
      audit("user", user.id, "agenda_item.status_updated", "agenda_item", params.itemId, {
        meetingId: params.id, status: body.status
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { agendaItemId: params.itemId, status: body.status };
  },
  "GET /meetings/:id/live": ({ user, params }) => {
    const meeting = db.prepare("SELECT id, organiser_id FROM meetings WHERE id = ?").get(params.id);
    if (!meeting) fail(404, "Meeting not found.");
    if (user.role === "meeting_organiser" && meeting.organiser_id !== user.id) fail(403, "You do not manage this meeting.");
    const session = db.prepare(`SELECT id, active_agenda_item_id, active_election_id, started_at
      FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    return { live: Boolean(session), session: session || null };
  },
  "POST /meetings/:id/live": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    if (body.action === "start") {
      if (db.prepare("SELECT 1 FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL").get(params.id)) {
        fail(409, "This meeting is already live.");
      }
      const openElections = db.prepare("SELECT id FROM elections WHERE meeting_id = ? AND status = 'open'").all(params.id);
      if (openElections.length > 1) fail(409, "Close extra open voting items before starting this meeting.");
      db.prepare("DELETE FROM meeting_presence WHERE meeting_id = ?").run(params.id);
      const sessionId = id();
      const startedAt = now();
      const activeElectionId = openElections[0]?.id || null;
      db.prepare(`INSERT INTO meeting_live_sessions
        (id, meeting_id, active_election_id, started_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId, params.id, activeElectionId, startedAt);
      audit("user", user.id, "meeting.live_started", "meeting", params.id, { sessionId, startedAt });
      return { live: true, session: { id: sessionId, started_at: startedAt } };
    }
    if (body.action === "end") {
      const session = db.prepare(`SELECT id FROM meeting_live_sessions
        WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
      if (!session) fail(409, "This meeting is not live.");
      const openElection = db.prepare("SELECT id FROM elections WHERE meeting_id = ? AND status = 'open' LIMIT 1").get(params.id);
      if (openElection) fail(409, "Close the active voting item before ending the meeting.");
      const endedAt = now();
      db.prepare("UPDATE meeting_live_sessions SET ended_at = ? WHERE id = ?").run(endedAt, session.id);
      audit("user", user.id, "meeting.live_ended", "meeting", params.id, { sessionId: session.id, endedAt });
      return { live: false, endedAt };
    }
    fail(400, "action must be start or end.");
  },
  "PUT /meetings/:id/live/agenda": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    const session = db.prepare(`SELECT id, active_agenda_item_id, active_election_id FROM meeting_live_sessions
      WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    if (!session) fail(409, "Start the meeting before selecting its active agenda item.");
    if (body.agendaItemId !== null && body.agendaItemId !== undefined && typeof body.agendaItemId !== "string") {
      fail(400, "agendaItemId must be a meeting agenda item.");
    }
    const agendaItemId = body.agendaItemId || null;
    if (agendaItemId) {
      const item = db.prepare("SELECT id FROM agenda_items WHERE id = ? AND meeting_id = ?")
        .get(agendaItemId, params.id);
      if (!item) fail(400, "The selected agenda item does not belong to this meeting.");
    }
    if (session.active_agenda_item_id !== agendaItemId && session.active_election_id &&
        db.prepare("SELECT 1 FROM elections WHERE id = ? AND status = 'open'").get(session.active_election_id)) {
      fail(409, "Close voting before moving to another agenda item.");
    }
    db.exec("BEGIN");
    try {
      if (session.active_agenda_item_id && session.active_agenda_item_id !== agendaItemId) {
        db.prepare("UPDATE agenda_items SET status = 'completed' WHERE id = ? AND meeting_id = ?")
          .run(session.active_agenda_item_id, params.id);
      }
      if (agendaItemId) {
        db.prepare("UPDATE agenda_items SET status = 'in_progress' WHERE id = ? AND meeting_id = ?")
          .run(agendaItemId, params.id);
      }
      db.prepare("UPDATE meeting_live_sessions SET active_agenda_item_id = ? WHERE id = ?")
        .run(agendaItemId, session.id);
      audit("user", user.id, "meeting.agenda_item_selected", "meeting", params.id, {
        sessionId: session.id, agendaItemId
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { agendaItemId };
  },
  "PUT /meetings/:id/live/voting-item": ({ user, params, body }) => {
    meetingAccess(user, params.id);
    const session = db.prepare(`SELECT id FROM meeting_live_sessions
      WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    if (!session) fail(409, "Start the meeting before selecting a voting item.");
    if (body.electionId !== null && body.electionId !== undefined) {
      const election = db.prepare("SELECT id, agenda_item_id FROM elections WHERE id = ? AND meeting_id = ?")
        .get(body.electionId, params.id);
      if (!election) fail(400, "The selected voting item does not belong to this meeting.");
      const activeAgendaItemId = db.prepare(`SELECT active_agenda_item_id FROM meeting_live_sessions
        WHERE id = ?`).get(session.id).active_agenda_item_id;
      if (election.agenda_item_id && election.agenda_item_id !== activeAgendaItemId) {
        fail(409, "Select this voting item's agenda item before announcing it.");
      }
      const openElection = db.prepare(`SELECT id FROM elections
        WHERE meeting_id = ? AND status = 'open' AND id != ? LIMIT 1`).get(params.id, body.electionId);
      if (openElection) fail(409, "Close the currently open voting item before announcing another.");
    } else {
      const activeOpenElection = db.prepare(`SELECT e.id FROM elections e
        JOIN meeting_live_sessions s ON s.active_election_id = e.id
        WHERE s.id = ? AND e.status = 'open' LIMIT 1`).get(session.id);
      if (activeOpenElection) fail(409, "Close voting before clearing the announced voting item.");
    }
    db.prepare("UPDATE meeting_live_sessions SET active_election_id = ? WHERE id = ?")
      .run(body.electionId || null, session.id);
    audit("user", user.id, "meeting.voting_item_selected", "meeting", params.id, {
      sessionId: session.id, electionId: body.electionId || null
    });
    return { electionId: body.electionId || null };
  },
  "POST /meetings/:id/agenda": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      fail(400, "Agenda item title is required and must be 160 characters or fewer.");
    }
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000)) {
      fail(400, "Agenda item description must be 2,000 characters or fewer.");
    }
    const itemId = id();
    const position = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM agenda_items WHERE meeting_id = ?")
      .get(params.id).next_position;
    db.prepare("INSERT INTO agenda_items (id, meeting_id, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(itemId, params.id, body.title.trim(), (body.description || "").trim(), position, now());
    audit("user", user.id, "agenda_item.created", "meeting", params.id, { agendaItemId: itemId });
    return { id: itemId, title: body.title.trim(), description: (body.description || "").trim(), position, status: "pending" };
  },
  "POST /meetings/:id/motions": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      fail(400, "Motion title is required and must be 160 characters or fewer.");
    }
    if (typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > 5000) {
      fail(400, "Motion text is required and must be 5,000 characters or fewer.");
    }
    if (body.agendaItemId !== undefined && body.agendaItemId !== null) {
      const agendaItem = db.prepare("SELECT id FROM agenda_items WHERE id = ? AND meeting_id = ?")
        .get(body.agendaItemId, params.id);
      if (!agendaItem) fail(400, "The selected agenda item does not belong to this meeting.");
    }
    const motionId = id();
    db.prepare("INSERT INTO motions (id, meeting_id, agenda_item_id, title, text, proposer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(motionId, params.id, body.agendaItemId || null, body.title.trim(), body.text.trim(), user.id, now());
    audit("user", user.id, "motion.created", "meeting", params.id, { motionId });
    return { id: motionId, title: body.title.trim(), text: body.text.trim() };
  },
  "GET /meetings/:id/elections": ({ user, params }) => {
    const meeting = db.prepare("SELECT id, organiser_id FROM meetings WHERE id = ?").get(params.id);
    if (!meeting) fail(404, "Meeting not found.");
    if (user.role === "meeting_organiser" && meeting.organiser_id !== user.id) fail(403, "You do not manage this meeting.");
    const canMonitorTurnout = user.role === "system_administrator" ||
      (user.role === "meeting_organiser" && meeting.organiser_id === user.id);
    const canManageVoting = canMonitorTurnout;
    return db.prepare(`SELECT e.id, e.title, e.starts_at, e.ends_at, e.secret_ballot, e.status,
        e.candidates_json, e.options_json, e.voting_type, e.agenda_item_id,
        e.opened_at, e.closed_at, e.results_published_at,
        EXISTS(SELECT 1 FROM voter_eligibility v WHERE v.election_id = e.id AND v.user_id = ?) AS is_eligible,
        EXISTS(SELECT 1 FROM election_votes v WHERE v.election_id = e.id AND v.user_id = ?) AS has_voted,
        (NOT EXISTS(SELECT 1 FROM meeting_live_sessions s WHERE s.meeting_id = e.meeting_id AND s.ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM meeting_live_sessions s WHERE s.meeting_id = e.meeting_id
            AND s.ended_at IS NULL AND s.active_election_id = e.id)) AS is_active_in_live_meeting,
        (SELECT COUNT(*) FROM election_votes v WHERE v.election_id = e.id) AS votes_cast,
        (SELECT COUNT(*) FROM voter_eligibility v WHERE v.election_id = e.id) AS eligible_voters
      FROM elections e WHERE e.meeting_id = ? AND (? = 1 OR e.status != 'draft')
      ORDER BY e.starts_at`).all(user.id, user.id, params.id, Number(canManageVoting))
      .map((election) => ({
        ...election,
        secret_ballot: Boolean(election.secret_ballot),
        is_eligible: Boolean(election.is_eligible),
        has_voted: Boolean(election.has_voted),
        is_active_in_live_meeting: Boolean(election.is_active_in_live_meeting),
        has_results: Boolean(election.results_published_at),
        candidates: JSON.parse(election.candidates_json),
        options: JSON.parse(election.options_json),
        candidateProfiles: election.voting_type === "candidate"
          ? candidateProfilesForElection(election.id, JSON.parse(election.candidates_json))
          : [],
        participation_count: canMonitorTurnout ? election.votes_cast : null,
        eligible_voter_count: canMonitorTurnout ? election.eligible_voters : null
      }));
  },
  "POST /meetings/:id/guest-links": ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (!meeting.plugnmeet_room_id) fail(503, "Live meeting setup is not available for this meeting.");
    const expiresAt = body.expiresAt || new Date(Date.now() + 24 * 3600_000).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) fail(400, "expiresAt must be a valid future date and time.");
    const rawToken = randomBytes(32).toString("base64url");
    const shareUrl = new URL("/", process.env.MEETVOTE_PUBLIC_URL || "http://localhost:3000");
    shareUrl.searchParams.set("meeting", params.id);
    shareUrl.searchParams.set("guest", rawToken);
    const guestLinkId = id();
    db.prepare("INSERT INTO guest_links VALUES (?, ?, ?, ?, ?)").run(guestLinkId, params.id, tokenHash(rawToken), expiresAt, now());
    audit("user", user.id, "guest_link.created", "meeting", params.id, { guestLinkId, expiresAt });
    return { id: guestLinkId, shareUrl: shareUrl.toString(), expiresAt, voting: false };
  },
  "POST /meetings/:id/join": async ({ user, params }) => {
    const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(params.id);
    if (!meeting) fail(404, "Meeting not found.");
    if (!meeting.plugnmeet_room_id) fail(503, "Live meeting setup is not available for this meeting.");
    const isAdmin = user.role === "system_administrator" ||
      (user.role === "meeting_organiser" && meeting.organiser_id === user.id);
    const accessToken = await plugnmeet.createJoinToken({
      roomId: meeting.plugnmeet_room_id,
      userId: user.id,
      name: user.display_name,
      isAdmin
    });
    audit("user", user.id, "meeting.join_token_issued", "meeting", meeting.id);
    const joinUrl = new URL(plugnmeet.getClientUrl());
    joinUrl.searchParams.set("access_token", accessToken);
    return { joinUrl: joinUrl.toString(), title: meeting.title };
  },
  "POST /meetings/:id/guest-join": async ({ params, body }) => {
    if (typeof body.guestToken !== "string" || body.guestToken.length < 20) fail(401, "This guest invitation is invalid or expired.");
    const guest = db.prepare(`SELECT g.id, g.expires_at, m.title, m.plugnmeet_room_id
      FROM guest_links g JOIN meetings m ON m.id = g.meeting_id
      WHERE g.meeting_id = ? AND g.token_hash = ?`).get(params.id, tokenHash(body.guestToken));
    if (!guest || Date.parse(guest.expires_at) <= Date.now()) fail(401, "This guest invitation is invalid or expired.");
    if (!guest.plugnmeet_room_id) fail(503, "Live meeting setup is not available for this meeting.");
    const guestId = `guest-${randomBytes(18).toString("hex")}`;
    const accessToken = await plugnmeet.createJoinToken({
      roomId: guest.plugnmeet_room_id,
      userId: guestId,
      name: "Estate guest"
    });
    audit("guest", guest.id, "meeting.guest_join_token_issued", "meeting", params.id);
    const joinUrl = new URL(plugnmeet.getClientUrl());
    joinUrl.searchParams.set("access_token", accessToken);
    return { joinUrl: joinUrl.toString(), title: guest.title, voting: false };
  },
  "POST /meetings/:id/guest-live": ({ params, body }) => {
    if (typeof body.guestToken !== "string" || body.guestToken.length < 20) fail(401, "This guest invitation is invalid or expired.");
    const guest = db.prepare(`SELECT g.id FROM guest_links g
      WHERE g.meeting_id = ? AND g.token_hash = ? AND g.expires_at > ?`)
      .get(params.id, tokenHash(body.guestToken), now());
    if (!guest) fail(401, "This guest invitation is invalid or expired.");
    const meeting = db.prepare("SELECT id, title FROM meetings WHERE id = ?").get(params.id);
    if (!meeting) fail(404, "Meeting not found.");
    const session = db.prepare(`SELECT id, active_agenda_item_id, active_election_id, started_at
      FROM meeting_live_sessions WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    const agenda = db.prepare(`SELECT id, title, description, position, status
      FROM agenda_items WHERE meeting_id = ? ORDER BY position, created_at`).all(params.id);
    const elections = session?.active_election_id
      ? db.prepare(`SELECT id, title, status, voting_type, candidates_json, options_json, opened_at, closed_at
        FROM elections WHERE id = ? AND meeting_id = ? AND status = 'open'`).all(session.active_election_id, params.id)
      : [];
    const publicElections = elections.map((election) => ({
      id: election.id,
      title: election.title,
      status: election.status,
      voting_type: election.voting_type,
      candidates: JSON.parse(election.candidates_json),
      options: JSON.parse(election.options_json),
      candidateProfiles: election.voting_type === "candidate"
        ? candidateProfilesForElection(election.id, JSON.parse(election.candidates_json))
        : [],
      opened_at: election.opened_at,
      closed_at: election.closed_at
    }));
    return { meeting, live: Boolean(session), session: session || null, agenda, elections: publicElections, guest: true };
  },
  "GET /election-templates": ({ user }) => {
    allow(user, "system_administrator", "meeting_organiser");
    return db.prepare(`SELECT id, template_name, title, voting_type, options_json, candidate_profiles_json,
        created_at, updated_at
      FROM election_templates ORDER BY template_name COLLATE NOCASE`).all()
      .map((template) => ({
        id: template.id,
        templateName: template.template_name,
        title: template.title,
        votingType: template.voting_type,
        options: JSON.parse(template.options_json),
        candidateProfiles: JSON.parse(template.candidate_profiles_json),
        createdAt: template.created_at,
        updatedAt: template.updated_at
      }));
  },
  "POST /election-templates": ({ user, body }) => {
    allow(user, "system_administrator", "meeting_organiser");
    const values = electionTemplateValues(body);
    const templateId = id();
    const timestamp = now();
    db.prepare(`INSERT INTO election_templates
      (id, template_name, title, voting_type, options_json, candidate_profiles_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(templateId, values.templateName, values.title, values.votingType, JSON.stringify(values.options),
        JSON.stringify(values.candidateProfiles), user.id, timestamp, timestamp);
    audit("user", user.id, "election_template.created", "election_template", templateId, {
      votingType: values.votingType, candidateCount: values.candidateProfiles.length
    });
    return { id: templateId, ...values, createdAt: timestamp, updatedAt: timestamp };
  },
  "PUT /election-templates/:id": ({ user, params, body }) => {
    allow(user, "system_administrator", "meeting_organiser");
    const existing = db.prepare("SELECT id, voting_type, candidate_profiles_json FROM election_templates WHERE id = ?")
      .get(params.id);
    if (!existing) fail(404, "Election template not found.");
    const values = electionTemplateValues(body);
    if (body.candidateProfiles === undefined && values.votingType === existing.voting_type) {
      values.candidateProfiles = JSON.parse(existing.candidate_profiles_json);
    }
    const updatedAt = now();
    db.prepare(`UPDATE election_templates SET template_name = ?, title = ?, voting_type = ?,
      options_json = ?, candidate_profiles_json = ?, updated_at = ? WHERE id = ?`)
      .run(values.templateName, values.title, values.votingType, JSON.stringify(values.options),
        JSON.stringify(values.candidateProfiles), updatedAt, params.id);
    audit("user", user.id, "election_template.updated", "election_template", params.id, {
      votingType: values.votingType, candidateCount: values.candidateProfiles.length
    });
    return { id: params.id, ...values, updatedAt };
  },
  "DELETE /election-templates/:id": ({ user, params }) => {
    allow(user, "system_administrator", "meeting_organiser");
    const existing = db.prepare("SELECT id FROM election_templates WHERE id = ?").get(params.id);
    if (!existing) fail(404, "Election template not found.");
    db.prepare("DELETE FROM election_templates WHERE id = ?").run(params.id);
    audit("user", user.id, "election_template.deleted", "election_template", params.id);
    return { deleted: true };
  },
  "POST /meetings/:id/elections": async ({ user, params, body }) => {
    const meeting = meetingAccess(user, params.id);
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      fail(400, "A voting item title is required and must be 160 characters or fewer.");
    }
    if (!meeting.openslides_meeting_id) fail(503, "This meeting is not linked to the election service. Contact an administrator.");
    const liveSession = db.prepare(`SELECT id, active_agenda_item_id FROM meeting_live_sessions
      WHERE meeting_id = ? AND ended_at IS NULL`).get(params.id);
    if (liveSession && db.prepare("SELECT 1 FROM elections WHERE meeting_id = ? AND status = 'open' LIMIT 1").get(params.id)) {
      fail(409, "Close the active voting item before creating another.");
    }
    const startsAt = body.startsAt || (liveSession ? now() : null);
    const endsAt = body.endsAt || (liveSession ? new Date(Date.now() + 2 * 60 * 60_000).toISOString() : null);
    if (!startsAt || !endsAt || !Number.isFinite(Date.parse(startsAt)) ||
        !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt)) {
      fail(400, "Provide valid voting start and end times, with the end after the start.");
    }
    const votingType = body.votingType || "candidate";
    if (!["candidate", "resolution", "multiple_choice"].includes(votingType)) {
      fail(400, "votingType must be candidate, resolution or multiple_choice.");
    }
    const candidateProfiles = votingType === "candidate"
      ? validateCandidateProfiles(body.candidateProfiles)
      : null;
    const options = votingType === "candidate"
      ? candidateProfiles.map((candidate) => candidate.fullName)
      : votingType === "resolution"
        ? ["For", "Against", "Abstain"]
        : body.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 50 ||
        options.some((option) => typeof option !== "string" || !option.trim() || option.trim().length > 160)) {
      fail(400, votingType === "candidate"
        ? "Provide between two and 50 candidate names, each no longer than 160 characters."
        : "Provide between two and 50 voting choices, each no longer than 160 characters.");
    }
    const choices = options.map((option) => option.trim());
    if (new Set(choices.map((option) => option.toLocaleLowerCase())).size !== choices.length) {
      fail(400, "Voting choices must be unique.");
    }
    const agendaItemId = body.agendaItemId || liveSession?.active_agenda_item_id || null;
    if (agendaItemId && !db.prepare("SELECT 1 FROM agenda_items WHERE id = ? AND meeting_id = ?").get(agendaItemId, params.id)) {
      fail(400, "The selected agenda item does not belong to this meeting.");
    }
    const election = votingType === "candidate"
      ? await openslides.createCandidateElection({
        meetingId: meeting.openslides_meeting_id,
        title: body.title.trim(),
        candidates: choices
      })
      : await openslides.createChoiceElection({
        meetingId: meeting.openslides_meeting_id,
        title: body.title.trim(),
        options: choices
      });
    const electionId = id();
    const secretBallot = true;
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT INTO elections
        (id, meeting_id, title, openslides_election_id, starts_at, ends_at, secret_ballot, status, created_at,
          openslides_poll_id, candidates_json, candidate_option_ids_json, voting_type, agenda_item_id, options_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
        .run(electionId, params.id, body.title.trim(), election.openslidesAssignmentId, startsAt, endsAt, secretBallot ? 1 : 0,
          now(), election.openslidesPollId, JSON.stringify(choices), JSON.stringify(election.candidateOptionIds),
          votingType, agendaItemId, JSON.stringify(choices));
      if (candidateProfiles) {
        const insertProfile = db.prepare(`INSERT INTO election_candidate_profiles
          (id, election_id, profile_order, full_name, position_title, biography, experience, statement, photo_mime, photo_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        candidateProfiles.forEach((profile, index) => insertProfile.run(
          id(), electionId, index, profile.fullName, profile.position, profile.biography,
          profile.experience, profile.statement, profile.photoMime, profile.photoData
        ));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit("user", user.id, "election.created", "election", electionId, {
      secretBallot, votingType, agendaItemId, candidateCount: candidateProfiles?.length || 0,
      openslidesAssignmentId: election.openslidesAssignmentId,
      openslidesPollId: election.openslidesPollId, optionCount: choices.length
    });
    if (liveSession) {
      db.prepare("UPDATE meeting_live_sessions SET active_election_id = ? WHERE id = ?").run(electionId, liveSession.id);
      audit("user", user.id, "meeting.voting_item_selected", "meeting", params.id, {
        sessionId: liveSession.id, electionId
      });
    }
    return { id: electionId, title: body.title.trim(), status: "draft", votingType, options: choices };
  },
  "PUT /elections/:id/eligibility": async ({ user, params, body }) => {
    const election = db.prepare(`SELECT e.status, e.openslides_poll_id, m.organiser_id, m.openslides_meeting_id
      FROM elections e
      JOIN meetings m ON m.id = e.meeting_id WHERE e.id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    if (user.role !== "system_administrator" && election.organiser_id !== user.id) fail(403, "You do not manage this election.");
    if (election.status !== "draft") fail(409, "Voter eligibility can only be changed while an election is in draft.");
    if (!Array.isArray(body.userIds) || body.userIds.some((userId) => typeof userId !== "string") ||
        new Set(body.userIds).size !== body.userIds.length) {
      fail(400, "userIds must be a list of unique registered resident IDs.");
    }
    const residents = body.userIds.map((userId) =>
      db.prepare("SELECT id FROM users WHERE id = ? AND role = 'registered_participant'").get(userId));
    if (residents.some((resident) => !resident)) fail(400, "Only registered residents can be made eligible to vote.");
    if (body.votesAllowed !== undefined &&
        (!Number.isInteger(body.votesAllowed) || body.votesAllowed < 1 || body.votesAllowed > 100)) {
      fail(400, "votesAllowed must be a whole number between 1 and 100.");
    }
    if (!election.openslides_poll_id || !election.openslides_meeting_id) fail(503, "This election is not connected to the secure voting service.");
    const mappings = [];
    for (const resident of residents) {
      let mapping = db.prepare(`SELECT openslides_user_id, username, credential_json
        FROM election_voters WHERE election_id = ? AND user_id = ?`).get(params.id, resident.id);
      if (!mapping) {
        const voter = await openslides.createVoter({
          meetingId: election.openslides_meeting_id
        });
        mapping = {
          openslides_user_id: voter.userId,
          username: voter.username,
          credential_json: JSON.stringify(voter.credential)
        };
        mappings.push({ userId: resident.id, ...mapping });
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const insertMapping = db.prepare(`INSERT INTO election_voters
        (election_id, user_id, openslides_user_id, username, credential_json) VALUES (?, ?, ?, ?, ?)`);
      for (const mapping of mappings) {
        insertMapping.run(params.id, mapping.userId, mapping.openslides_user_id, mapping.username, mapping.credential_json);
      }
      db.prepare("DELETE FROM voter_eligibility WHERE election_id = ?").run(params.id);
      const insertEligibility = db.prepare("INSERT INTO voter_eligibility VALUES (?, ?, ?)");
      for (const resident of residents) {
        insertEligibility.run(params.id, resident.id, body.votesAllowed || 1);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit("user", user.id, "election.eligibility_set", "election", params.id, { voterCount: body.userIds.length });
    return { electionId: params.id, eligibleVoters: body.userIds.length };
  },
  "GET /elections/:id/eligibility": ({ user, params }) => {
    const election = db.prepare(`SELECT m.organiser_id FROM elections e
      JOIN meetings m ON m.id = e.meeting_id WHERE e.id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    if (user.role !== "system_administrator" && election.organiser_id !== user.id) fail(403, "You do not manage this election.");
    return db.prepare(`SELECT u.id, u.display_name, u.email, COALESCE(v.votes_allowed, 0) AS votes_allowed
      FROM users u LEFT JOIN voter_eligibility v ON v.user_id = u.id AND v.election_id = ?
      WHERE u.role = 'registered_participant' ORDER BY u.display_name COLLATE NOCASE`).all(params.id);
  },
  "PUT /elections/:id": async ({ user, params, body }) => {
    const election = db.prepare(`SELECT e.id, e.meeting_id, e.title, e.starts_at, e.ends_at, e.status,
        e.openslides_election_id, e.openslides_poll_id
      FROM elections e WHERE e.id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    const meeting = meetingAccess(user, election.meeting_id);
    if (election.status !== "draft") fail(409, "Only draft elections can be edited.");
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      fail(400, "An election title of 160 characters or fewer is required.");
    }
    if (!body.startsAt || !body.endsAt || !Number.isFinite(Date.parse(body.startsAt)) ||
        !Number.isFinite(Date.parse(body.endsAt)) || Date.parse(body.endsAt) <= Date.parse(body.startsAt)) {
      fail(400, "Provide valid voting start and end times, with the end after the start.");
    }
    if (Object.hasOwn(body, "votingType") || Object.hasOwn(body, "options")) {
      fail(400, "Ballot choices cannot be changed after an election is created. Save a template for future meetings.");
    }
    const title = body.title.trim();
    if (title !== election.title) {
      await openslides.updateElectionTitle({
        assignmentId: election.openslides_election_id,
        pollId: election.openslides_poll_id,
        title
      });
    }
    db.prepare("UPDATE elections SET title = ?, starts_at = ?, ends_at = ? WHERE id = ?")
      .run(title, body.startsAt, body.endsAt, params.id);
    audit("user", user.id, "election.updated", "election", params.id, {
      titleChanged: title !== election.title,
      scheduleChanged: body.startsAt !== election.starts_at || body.endsAt !== election.ends_at,
      meetingId: meeting.id
    });
    return { id: params.id, title, startsAt: body.startsAt, endsAt: body.endsAt, status: election.status };
  },
  "PUT /elections/:id/candidates": ({ user, params, body }) => {
    const election = db.prepare(`SELECT id, meeting_id, voting_type, status, starts_at, candidates_json,
        candidate_option_ids_json
      FROM elections WHERE id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    meetingAccess(user, election.meeting_id);
    if (election.voting_type !== "candidate") fail(400, "Candidate profiles are only available for candidate elections.");
    if (election.status !== "draft" || Date.parse(election.starts_at) <= Date.now()) {
      fail(409, "Candidate profiles can only be edited before the election starts.");
    }

    const existing = db.prepare(`SELECT id, profile_order, full_name, photo_mime, photo_data
      FROM election_candidate_profiles WHERE election_id = ? ORDER BY profile_order`).all(params.id);
    const profiles = validateCandidateProfiles(body.candidateProfiles);
    const optionIds = JSON.parse(election.candidate_option_ids_json);
    if (profiles.length !== existing.length || profiles.length !== optionIds.length) {
      fail(409, "The candidate list cannot be added to or shortened after the election is created.");
    }
    const existingById = new Map(existing.map((profile) => [profile.id, profile]));
    const optionIdByCandidateId = new Map(existing.map((profile) => [profile.id, optionIds[profile.profile_order]]));
    const seenIds = new Set();
    const reorderedOptionIds = profiles.map((profile) => {
      const current = existingById.get(profile.candidateId);
      if (!current || seenIds.has(profile.candidateId)) fail(400, "Candidate order contains an invalid or repeated candidate.");
      seenIds.add(profile.candidateId);
      if (profile.fullName !== current.full_name) {
        fail(400, "Candidate names are fixed after an election is created because they are ballot choices.");
      }
      if (!profile.photoProvided) {
        profile.photoMime = current.photo_mime;
        profile.photoData = current.photo_data ? Buffer.from(current.photo_data) : null;
      }
      return optionIdByCandidateId.get(profile.candidateId);
    });
    if (seenIds.size !== existing.length) fail(400, "All candidates must remain in the election.");
    const names = profiles.map((profile) => profile.fullName);
    const encodedNames = JSON.stringify(names);

    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE elections SET candidates_json = ?, options_json = ?, candidate_option_ids_json = ?
        WHERE id = ?`).run(encodedNames, encodedNames, JSON.stringify(reorderedOptionIds), params.id);
      db.prepare("DELETE FROM election_candidate_profiles WHERE election_id = ?").run(params.id);
      const insertProfile = db.prepare(`INSERT INTO election_candidate_profiles
        (id, election_id, profile_order, full_name, position_title, biography, experience, statement, photo_mime, photo_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      profiles.forEach((profile, index) => insertProfile.run(
        profile.candidateId, params.id, index, profile.fullName, profile.position,
        profile.biography, profile.experience, profile.statement, profile.photoMime, profile.photoData
      ));
      audit("user", user.id, "election.candidate_profiles_updated", "election", params.id, {
        candidateCount: profiles.length,
        candidatesWithoutPhotos: profiles.filter((profile) => !profile.photoData).length
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      electionId: params.id,
      candidateProfiles: candidateProfilesForElection(params.id, names)
    };
  },
  "PUT /elections/:id/status": async ({ user, params, body }) => {
    const election = db.prepare(`SELECT e.openslides_poll_id, e.status AS current_status,
        e.starts_at, e.ends_at, e.opened_at, e.meeting_id, e.agenda_item_id, m.organiser_id
      FROM elections e JOIN meetings m ON m.id = e.meeting_id WHERE e.id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    if (user.role !== "system_administrator" && election.organiser_id !== user.id) fail(403, "You do not manage this election.");
    if (!['draft', 'open', 'closed'].includes(body.status)) fail(400, "status must be draft, open or closed.");
    if (body.status === "draft" && election.current_status !== "draft") fail(409, "An election cannot be moved back to draft.");
    if (body.status === "open" && election.current_status !== "draft") fail(409, "Only a draft election can be opened.");
    if (body.status === "closed" && election.current_status !== "open") fail(409, "Only an open election can be closed.");
    if (body.status === "open") {
      const currentTime = Date.now();
      if (Date.parse(election.starts_at) > currentTime || Date.parse(election.ends_at) <= currentTime) {
        fail(409, "An election can only be opened during its scheduled voting period.");
      }
      const quorum = meetingQuorumStatus(election.meeting_id);
      if (!quorum.quorumMet) {
        fail(409, `A quorum is required before voting can open: ${quorum.presentMembers} of ${quorum.requiredMembers} registered participants are online and ${quorum.representedUnits} of ${quorum.totalEligibleUnits} eligible Unit/Erf votes are represented (at least ${quorum.requiredUnitVotes} Unit/Erf votes required).`);
      }
      const candidateElection = db.prepare("SELECT voting_type, candidates_json FROM elections WHERE id = ?").get(params.id);
      if (candidateElection.voting_type === "candidate") {
        const candidateCount = JSON.parse(candidateElection.candidates_json).length;
        const incompleteCount = db.prepare(`SELECT COUNT(*) AS count FROM election_candidate_profiles
          WHERE election_id = ? AND (
            TRIM(full_name) = '' OR TRIM(position_title) = '' OR TRIM(biography) = '' OR TRIM(experience) = '')`)
          .get(params.id).count;
        const profileCount = db.prepare("SELECT COUNT(*) AS count FROM election_candidate_profiles WHERE election_id = ?")
          .get(params.id).count;
        if (profileCount !== candidateCount || incompleteCount) {
          fail(409, "Add a position, biography and experience to every candidate before opening the election.");
        }
      }
      const voterCount = db.prepare("SELECT COUNT(*) AS count FROM voter_eligibility WHERE election_id = ?").get(params.id).count;
      if (!voterCount) {
        fail(409, "Assign at least one registered resident before opening this election.");
      }
      const mappedVoterCount = db.prepare(`SELECT COUNT(*) AS count FROM election_voters
        WHERE election_id = ? AND user_id IN (SELECT user_id FROM voter_eligibility WHERE election_id = ?)`).get(params.id, params.id).count;
      if (mappedVoterCount !== voterCount) fail(503, "Eligible voters are not fully connected to the secure voting service.");
      const otherOpenElection = db.prepare("SELECT id FROM elections WHERE meeting_id = ? AND status = 'open' AND id != ? LIMIT 1")
        .get(election.meeting_id, params.id);
      if (otherOpenElection) fail(409, "Close the other open voting item before opening this one.");
      const liveSession = db.prepare(`SELECT active_agenda_item_id FROM meeting_live_sessions
        WHERE meeting_id = ? AND ended_at IS NULL`).get(election.meeting_id);
      if (liveSession && election.agenda_item_id &&
          liveSession.active_agenda_item_id !== election.agenda_item_id) {
        fail(409, "Select this voting item's agenda item before opening it.");
      }
    }
    if (body.status === "closed") {
      return closeElection(params.id, { type: "user", id: user.id });
    }
    let openedAt;
    if (body.status !== election.current_status && body.status !== "draft") {
      if (!election.openslides_poll_id) fail(503, "This election is not linked to a poll. Contact an administrator.");
      if (body.status === "open") {
        await openslides.startPoll(election.openslides_poll_id);
        openedAt = now();
      }
    }
    if (openedAt) {
      db.prepare("UPDATE elections SET status = ?, opened_at = ? WHERE id = ?")
        .run(body.status, openedAt, params.id);
    } else {
      db.prepare("UPDATE elections SET status = ? WHERE id = ?").run(body.status, params.id);
    }
    if (body.status === "open") {
      const liveSession = db.prepare(`SELECT id FROM meeting_live_sessions
        WHERE meeting_id = ? AND ended_at IS NULL`).get(election.meeting_id);
      if (liveSession) {
        db.prepare("UPDATE meeting_live_sessions SET active_election_id = ? WHERE id = ?").run(params.id, liveSession.id);
        audit("user", user.id, "meeting.voting_item_selected", "meeting", election.meeting_id, {
          sessionId: liveSession.id, electionId: params.id
        });
      }
      const quorum = meetingQuorumStatus(election.meeting_id);
      db.prepare(`INSERT INTO meeting_quorum_events
        (id, meeting_id, event_type, actor_id, metadata_json, created_at)
        VALUES (?, ?, 'quorum_met', ?, ?, ?)`)
        .run(id(), election.meeting_id, user.id, JSON.stringify({
          electionId: params.id,
          presentMembers: quorum.presentMembers,
          representedUnits: quorum.representedUnits,
          totalEligibleUnits: quorum.totalEligibleUnits,
          requiredUnitVotes: quorum.requiredUnitVotes
        }), now());
    }
    audit("user", user.id, `election.${body.status}`, "election", params.id, {
      ...(openedAt ? { openedAt } : {})
    });
    return { id: params.id, status: body.status };
  },
  "GET /elections/:id/voting-authorisation": ({ user, params }) => {
    const election = db.prepare("SELECT * FROM elections WHERE id = ?").get(params.id);
    if (!election) fail(404, "Election not found.");
    const eligibility = db.prepare("SELECT votes_allowed FROM voter_eligibility WHERE election_id = ? AND user_id = ?").get(params.id, user.id);
    const startsAt = Date.parse(election.starts_at);
    const endsAt = Date.parse(election.ends_at);
    const isOpen = electionAcceptingBallots(election);
    const alreadyVoted = Boolean(db.prepare("SELECT 1 FROM election_votes WHERE election_id = ? AND user_id = ?").get(params.id, user.id));
    const allowed = Boolean(user.role === "registered_participant" && eligibility && isOpen && !alreadyVoted);
    const reason = allowed
      ? null
      : alreadyVoted
        ? "You have already submitted a ballot."
        : user.role !== "registered_participant"
          ? "Only registered residents can vote."
          : !eligibility
            ? "You are not on the eligible voter list for this election."
            : election.status !== "open"
              ? "You are eligible, but this election has not been opened yet."
              : startsAt > Date.now()
                ? "You are eligible, but voting has not started yet."
                : endsAt <= Date.now()
                  ? "The scheduled voting period has ended."
                  : "You are not authorised to vote in this election.";
    audit("user", user.id, allowed ? "vote.authorisation_granted" : "vote.authorisation_denied", "election", params.id, { reason: allowed ? "eligible" : "not_eligible_or_closed" });
    return {
      allowed,
      alreadyVoted,
      reason,
      votesAllowed: eligibility?.votes_allowed || 0
    };
  },
  "GET /elections/:id/ballot": async ({ user, params }) => {
    if (user.role !== "registered_participant") fail(403, "Only registered residents can vote.");
    const election = db.prepare("SELECT * FROM elections WHERE id = ?").get(params.id);
    if (!election) fail(404, "Election not found.");
    const eligibility = db.prepare("SELECT 1 FROM voter_eligibility WHERE election_id = ? AND user_id = ?").get(params.id, user.id);
    const isOpen = electionAcceptingBallots(election);
    const alreadyVoted = Boolean(db.prepare("SELECT 1 FROM election_votes WHERE election_id = ? AND user_id = ?").get(params.id, user.id));
    if (!eligibility || !isOpen) return { allowed: false, alreadyVoted, reason: alreadyVoted ? "You have already submitted a ballot." : "You are not authorised to vote in this election." };
    if (alreadyVoted) return { allowed: false, alreadyVoted: true, reason: "You have already submitted a ballot." };
    const candidates = JSON.parse(election.candidates_json);
    const mapping = db.prepare(`SELECT username, credential_json FROM election_voters
      WHERE election_id = ? AND user_id = ?`).get(params.id, user.id);
    if (!mapping) fail(503, "Your secure voting account is not ready. Contact an administrator.");
    if (!election.openslides_poll_id) fail(503, "This election is not connected to the secure voting service.");
    if (await openslides.hasVoted({
      pollId: election.openslides_poll_id,
      username: mapping.username,
      credential: JSON.parse(mapping.credential_json)
    })) {
      db.prepare("INSERT OR IGNORE INTO election_votes VALUES (?, ?)").run(params.id, user.id);
      return { allowed: false, alreadyVoted: true, reason: "You have already submitted a ballot." };
    }
    return {
      allowed: true,
      alreadyVoted: false,
      candidates,
      candidateProfiles: election.voting_type === "candidate"
        ? candidateProfilesForElection(params.id, candidates)
        : []
    };
  },
  "POST /elections/:id/ballot": async ({ user, params, body }) => {
    if (user.role !== "registered_participant") fail(403, "Only registered residents can vote.");
    const election = db.prepare("SELECT * FROM elections WHERE id = ?").get(params.id);
    if (!election) fail(404, "Election not found.");
    const eligibility = db.prepare("SELECT 1 FROM voter_eligibility WHERE election_id = ? AND user_id = ?").get(params.id, user.id);
    if (!eligibility) fail(403, "You are not eligible to vote in this election.");
    if (!electionAcceptingBallots(election)) {
      fail(409, "This election is not currently accepting ballots.");
    }
    if (!Number.isInteger(body.candidateIndex) || body.candidateIndex < 0 ||
        body.candidateIndex >= JSON.parse(election.candidates_json).length) {
      fail(400, "Select one candidate before submitting your ballot.");
    }
    if (db.prepare("SELECT 1 FROM election_votes WHERE election_id = ? AND user_id = ?").get(params.id, user.id)) {
      fail(409, "You have already submitted a ballot.");
    }
    const voter = db.prepare(`SELECT openslides_user_id, username, credential_json FROM election_voters
      WHERE election_id = ? AND user_id = ?`).get(params.id, user.id);
    const optionIds = JSON.parse(election.candidate_option_ids_json);
    if (!voter || optionIds.length !== JSON.parse(election.candidates_json).length) {
      fail(503, "Your secure voting account is not ready. Contact an administrator.");
    }
    const lockKey = `${params.id}:${user.id}`;
    const existingSubmission = ballotSubmissionLocks.get(lockKey);
    if (existingSubmission) {
      await existingSubmission;
      return { cast: true, alreadySubmitted: true };
    }
    const submission = (async () => {
      if (db.prepare("SELECT 1 FROM election_votes WHERE election_id = ? AND user_id = ?").get(params.id, user.id)) {
        return;
      }
      const voted = await openslides.hasVoted({
        pollId: election.openslides_poll_id,
        username: voter.username,
        credential: JSON.parse(voter.credential_json)
      });
      if (voted) {
        db.prepare("INSERT OR IGNORE INTO election_votes VALUES (?, ?)").run(params.id, user.id);
        fail(409, "You have already submitted a ballot.");
      }
      await openslides.castVote({
        pollId: election.openslides_poll_id,
        meetingId: db.prepare("SELECT openslides_meeting_id FROM meetings WHERE id = ?").get(election.meeting_id).openslides_meeting_id,
        openslidesUserId: voter.openslides_user_id,
        optionId: optionIds[body.candidateIndex],
        username: voter.username,
        credential: JSON.parse(voter.credential_json)
      });
      try {
        db.prepare("INSERT INTO election_votes VALUES (?, ?)").run(params.id, user.id);
      } catch {
        fail(409, "Your ballot was accepted, but this account has already been marked as having voted.");
      }
      audit("system", null, "vote.cast", "election", params.id);
    })();
    ballotSubmissionLocks.set(lockKey, submission);
    try {
      await submission;
      return { cast: true };
    } finally {
      ballotSubmissionLocks.delete(lockKey);
    }
  },
  "GET /elections/:id/results": ({ user, params }) => {
    const election = db.prepare(`SELECT e.status, e.results_json, e.results_published_at, m.organiser_id
      FROM elections e JOIN meetings m ON m.id = e.meeting_id WHERE e.id = ?`).get(params.id);
    if (!election) fail(404, "Election not found.");
    if (user.role === "meeting_organiser" && election.organiser_id !== user.id) fail(403, "You do not manage this election.");
    if (election.status !== "closed" || !election.results_json || !election.results_published_at) {
      fail(404, "Results have not been published for this election.");
    }
    return { electionId: params.id, publishedAt: election.results_published_at, ...JSON.parse(election.results_json) };
  }
};

const electionsClosing = new Map();
function closeElectionWithoutResults(electionId, actor, error, automatic = true) {
  const closedAt = now();
  const update = db.prepare(`UPDATE elections SET status = 'closed', results_json = NULL,
    results_published_at = NULL, closed_at = ? WHERE id = ? AND status = 'open'`)
    .run(closedAt, electionId);
  if (!update.changes) return { id: electionId, status: "closed" };
  audit(actor.type, actor.id, "election.closed", "election", electionId, {
    closedAt,
    ...(automatic ? { automatic: true } : {}),
    resultsAvailable: false
  });
  console.error(`${automatic ? "Automatically closed" : "Closed"} election ${electionId} without publishing results: ${error.message}`);
  return { id: electionId, status: "closed", resultsPublished: false };
}

async function closeElection(electionId, actor, automatic = false) {
  const pendingClose = electionsClosing.get(electionId);
  if (pendingClose) return pendingClose;
  const closing = (async () => {
    const election = db.prepare(`SELECT id, openslides_poll_id, status, opened_at, meeting_id
      FROM elections WHERE id = ?`).get(electionId);
    if (!election) fail(404, "Election not found.");
    if (election.status !== "open") return { id: electionId, status: election.status };
    if (!election.openslides_poll_id) fail(503, "This election is not linked to a poll. Contact an administrator.");

    let ballots;
    try {
      await openslides.stopPoll(election.openslides_poll_id, { preserveVoteData: true });
      try {
        ballots = await openslides.getPollResults(election.openslides_poll_id);
      } finally {
        try {
          await openslides.clearPoll(election.openslides_poll_id);
        } catch (error) {
          console.error(`Could not clear secure ballot data for election ${electionId}: ${error.message}`);
        }
      }
    } catch (error) {
      if ([502, 503].includes(error.status)) {
        return closeElectionWithoutResults(electionId, actor, error, automatic);
      }
      throw error;
    }
    const electionData = db.prepare(`SELECT e.options_json, e.candidate_option_ids_json, e.voting_type,
        m.meeting_type
      FROM elections e JOIN meetings m ON m.id = e.meeting_id WHERE e.id = ?`).get(electionId);
    const options = JSON.parse(electionData.options_json);
    const optionIds = JSON.parse(electionData.candidate_option_ids_json);
    if (optionIds.length !== options.length) {
      const error = Object.assign(new Error("Voting results are not available for this election."), { status: 503 });
      return closeElectionWithoutResults(electionId, actor, error, automatic);
    }
    const closedAt = now();
    const candidateResults = options.map((name, index) => ({
      name,
      votes: ballots.reduce((count, ballot) =>
        count + (ballot?.value?.[String(optionIds[index])] === 1 ? 1 : 0), 0)
    }));
    const developmentConfig = db.prepare("SELECT development_period_active FROM hoa_voting_config WHERE id = 1").get();
    const developerBonusVoteWeight = developmentConfig?.development_period_active
      ? 0.5
      : 0;
    let moiOutcome = null;
    if (electionData.voting_type === "resolution") {
      const forResult = candidateResults.find(({ name }) => name === "For");
      const againstResult = candidateResults.find(({ name }) => name === "Against");
      const abstainResult = candidateResults.find(({ name }) => name === "Abstain");
      const forVotes = forResult?.votes || 0;
      const againstVotes = againstResult?.votes || 0;
      const abstainVotes = abstainResult?.votes || 0;
      const denominator = forVotes + againstVotes;
      const requiredPercent = electionData.meeting_type === "special" ? 75 : 50;
      const thresholdPassed = denominator > 0
        ? (forVotes / denominator) * 100 >= (requiredPercent === 50 ? 50 : 75)
          && (requiredPercent === 50 ? forVotes > againstVotes : true)
        : false;
      moiOutcome = {
        resolutionType: electionData.meeting_type === "special" ? "special" : "ordinary",
        requiredPercent,
        forVotes,
        againstVotes,
        abstainVotes,
        abstainExcludedFromDenominator: true,
        denominator,
        forPercent: denominator ? Number(((forVotes / denominator) * 100).toFixed(2)) : 0,
        developerBonusVoteWeight,
        passed: thresholdPassed && forVotes !== againstVotes
      };
    } else {
      const topVoteCount = candidateResults.reduce((maximum, option) => Math.max(maximum, option.votes), 0);
      const winners = candidateResults.filter((option) => option.votes === topVoteCount);
      moiOutcome = {
        resultType: "election",
        tieDefeat: topVoteCount > 0 && winners.length > 1,
        winner: topVoteCount > 0 && winners.length === 1 ? winners[0].name : null,
        developerBonusVoteWeight
      };
    }
    const results = {
      votesCast: ballots.length,
      eligibleVoters: voterCountForElection(electionId),
      candidates: candidateResults,
      moiOutcome,
      openedAt: election.opened_at,
      closedAt
    };
    const update = db.prepare(`UPDATE elections SET status = 'closed', results_json = ?, results_published_at = ?,
      closed_at = ? WHERE id = ? AND status = 'open'`)
      .run(JSON.stringify(results), closedAt, closedAt, electionId);
    if (!update.changes) {
      const current = db.prepare("SELECT status FROM elections WHERE id = ?").get(electionId);
      if (current?.status === "closed") return { id: electionId, status: "closed" };
      fail(409, "Election status changed while closing.");
    }
    audit(actor.type, actor.id, "election.closed", "election", electionId, {
      closedAt,
      ...(automatic ? { automatic: true } : {})
    });
    return { id: electionId, status: "closed" };
  })();
  electionsClosing.set(electionId, closing);
  try {
    return await closing;
  } finally {
    if (electionsClosing.get(electionId) === closing) electionsClosing.delete(electionId);
  }
}

let checkingExpiredElections = false;
const expiredElectionFailures = new Map();
async function closeExpiredElections() {
  if (checkingExpiredElections) return;
  checkingExpiredElections = true;
  try {
    const expired = db.prepare(`SELECT id FROM elections
      WHERE status = 'open' AND ends_at <= ? ORDER BY ends_at`).all(now());
    for (const election of expired) {
      try {
        await closeElection(election.id, { type: "system", id: null }, true);
        expiredElectionFailures.delete(election.id);
      } catch (error) {
        if ([502, 503].includes(error.status)) {
          closeElectionWithoutResults(election.id, { type: "system", id: null }, error);
          expiredElectionFailures.delete(election.id);
        } else if (expiredElectionFailures.get(election.id) !== error.message) {
          console.error(`Automatic close failed for election ${election.id}: ${error.message}`);
          expiredElectionFailures.set(election.id, error.message);
        }
      }
    }
  } catch (error) {
    console.error(`Automatic election expiry check failed: ${error.message}`);
  } finally {
    checkingExpiredElections = false;
  }
}

function voterCountForElection(electionId) {
  return db.prepare("SELECT COUNT(*) AS count FROM voter_eligibility WHERE election_id = ?").get(electionId).count;
}

function electionAcceptingBallots(election) {
  const startsAt = Date.parse(election.starts_at);
  const endsAt = Date.parse(election.ends_at);
  if (election.status !== "open" || startsAt > Date.now() || endsAt <= Date.now()) return false;
  const liveSession = db.prepare(`SELECT active_election_id FROM meeting_live_sessions
    WHERE meeting_id = ? AND ended_at IS NULL`).get(election.meeting_id);
  return !liveSession || liveSession.active_election_id === election.id;
}

const matchRoute = (method, path) => {
  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(" ");
    if (routeMethod !== method) continue;
    const keys = [];
    const expression = new RegExp(`^${routePath.replace(/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return "([^/]+)"; })}$`);
    const hit = path.match(expression);
    if (hit) return { handler, params: Object.fromEntries(keys.map((key, index) => [key, hit[index + 1]])) };
  }
};

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return json(response, 204, {}, request.headers.origin);
    const route = matchRoute(request.method, new URL(request.url, "http://localhost").pathname);
    if (!route) return json(response, 404, { error: "Route not found." }, request.headers.origin);
    const path = new URL(request.url, "http://localhost").pathname;
    const guestRoute = request.method === "POST" && /^\/meetings\/[^/]+\/guest-(join|live)$/.test(path);
    const protectedRoute = !guestRoute && !["GET /health", "POST /auth/bootstrap", "POST /auth/login"].includes(`${request.method} ${path}`);
    const user = protectedRoute ? userFromRequest(request) : null;
    const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : {};
    return json(response, 200, await route.handler({ user, body, params: route.params }), request.headers.origin);
  } catch (error) {
    return json(response, error.status || 500, { error: error.message || "Internal server error." }, request.headers.origin);
  }
}).listen(port, "0.0.0.0", () => console.log(`Elawini MeetVote API listening on ${port}`));

const electionExpiryTimer = setInterval(() => void closeExpiredElections(), 1000);
electionExpiryTimer.unref();
void closeExpiredElections();
