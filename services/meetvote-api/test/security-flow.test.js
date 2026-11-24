import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let baseUrl;
let apiProcess;
let mockOpenSlides;
let mockPlugNmeet;
let mockOpenSlidesAuth;
let mockOpenSlidesVote;
let plugNmeetRequests = [];
let openSlidesUsers = new Map();
let openSlidesPollActions = [];
let openSlidesInternalActions = [];
let submittedBallots = [];
let votedOpenSlidesUsers = new Set();
let voteDataCleared = false;
let simulateAlreadyStoppedPoll = false;
let simulateVoteResultsFailure = false;
let tempDirectory;
const serviceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = Date.now();
const testPhotoData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6u0AAAAASUVORK5CYII=";
const candidateProfiles = (names) => names.map((fullName) => ({
  fullName,
  position: "Estate trustee",
  biography: "A registered resident.",
  experience: "Community service.",
  photoData: testPhotoData
}));
const request = async (path, { method = "GET", token, body, origin } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: Object.fromEntries(response.headers.entries())
  };
};

test("only an eligible registered participant receives voting authorisation", async (t) => {
  tempDirectory = await mkdtemp(join(tmpdir(), "meetvote-security-flow-"));
  const passwordFile = join(tempDirectory, "openslides-password");
  await writeFile(passwordFile, "test-password\n");
  openSlidesPollActions = [];
  openSlidesInternalActions = [];
  let nextId = 100;
  let createdPollEntitledGroupIds;
  mockOpenSlides = createServer(async (request, response) => {
    const actions = await new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
      request.on("error", reject);
    });
    const { action } = actions[0];
    if (request.url === "/system/action/handle_request") {
      assert.equal(request.headers.authentication, "ticket:superadmin");
      openSlidesPollActions.push({ action, data: actions[0].data });
    } else {
      assert.equal(request.url, "/internal/handle_request");
      openSlidesInternalActions.push({ action, data: actions[0].data });
    }
    let data = [{ id: ++nextId }];
    if (action === "user.create") {
      const openslidesUserId = ++nextId;
      data = [{ id: openslidesUserId, meeting_user_id: ++nextId }];
      openSlidesUsers.set(actions[0].data[0].username, openslidesUserId);
    }
    if (action === "user.assign_meetings") {
      data = [{
        meeting_users: actions[0].data[0].meeting_ids.map((meetingId) => ({
          meeting_id: meetingId,
          meeting_user_id: ++nextId,
          group_ids: [7]
        }))
      }];
    }
    if (action === "poll.create") {
      createdPollEntitledGroupIds = actions[0].data[0].entitled_group_ids;
      data = [{
        id: 50,
        option_ids: actions[0].data[0].options.map((_, index) => 501 + index)
      }];
    }
    if (action === "poll.start") {
      voteDataCleared = false;
      submittedBallots = [];
      votedOpenSlidesUsers = new Set();
    }
    if (action === "poll.stop" && !actions[0].data[0].preserve_vote_data) voteDataCleared = true;
    if (action === "poll.stop" && simulateAlreadyStoppedPoll) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        success: false,
        message: "Cannot stop poll 50, because it is not in state started."
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ status: "success", data }]));
  });
  await new Promise((resolve) => mockOpenSlides.listen(0, "127.0.0.1", resolve));
  const mockAddress = mockOpenSlides.address();
  plugNmeetRequests = [];
  mockPlugNmeet = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    plugNmeetRequests.push({ path: request.url, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url.endsWith("/room/create")
      ? { status: true, room_info: { room_id: body.room_id } }
      : { status: true, token: { value: "test-live-meeting-token" } }));
  });
  await new Promise((resolve) => mockPlugNmeet.listen(0, "127.0.0.1", resolve));
  const plugNmeetAddress = mockPlugNmeet.address();
  openSlidesUsers = new Map();
  submittedBallots = [];
  votedOpenSlidesUsers = new Set();
  voteDataCleared = false;
  mockOpenSlidesAuth = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, {
      "content-type": "application/json",
      authentication: `ticket:${body.username}`,
      "set-cookie": "refreshId=refresh-token; HttpOnly"
    });
    response.end(JSON.stringify({ success: true }));
  });
  await new Promise((resolve) => mockOpenSlidesAuth.listen(0, "127.0.0.1", resolve));
  const authAddress = mockOpenSlidesAuth.address();
  mockOpenSlidesVote = createServer(async (request, response) => {
    const user = (request.headers.authentication || "").replace("ticket:", "");
    const openslidesUserId = openSlidesUsers.get(user);
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/system/vote/voted") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ "50": votedOpenSlidesUsers.has(user) ? [openslidesUserId] : [] }));
      return;
    }
    if (url.pathname === "/system/vote") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      submittedBallots.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      votedOpenSlidesUsers.add(user);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (url.pathname === "/internal/vote/stop") {
      if (simulateVoteResultsFailure || voteDataCleared) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not-exist", message: "Poll is unavailable." }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ votes: submittedBallots, user_ids: [...votedOpenSlidesUsers].map((name) => openSlidesUsers.get(name)) }));
      return;
    }
    if (url.pathname === "/internal/vote/clear") {
      voteDataCleared = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise((resolve) => mockOpenSlidesVote.listen(0, "127.0.0.1", resolve));
  const voteAddress = mockOpenSlidesVote.address();
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const apiPort = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  baseUrl = `http://127.0.0.1:${apiPort}`;
  apiProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: serviceDirectory,
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATABASE_PATH: join(tempDirectory, "meetvote.sqlite"),
      BOOTSTRAP_ADMIN_ENABLED: "true",
      CORS_ORIGIN: "http://localhost:3000,http://192.168.43.93:3000",
      OPENSLIDES_URL: `http://127.0.0.1:${mockAddress.port}`,
      OPENSLIDES_INTERNAL_PASSWORD_FILE: passwordFile,
      OPENSLIDES_ACTION_USERNAME: "superadmin",
      OPENSLIDES_ACTION_PASSWORD_FILE: passwordFile,
      OPENSLIDES_AUTH_URL: `http://127.0.0.1:${authAddress.port}`,
      OPENSLIDES_VOTE_URL: `http://127.0.0.1:${voteAddress.port}`,
      OPENSLIDES_VOTER_PASSWORD_KEY: "test-voter-password-key-with-32-characters",
      PROXY_DOCUMENT_ENCRYPTION_KEY: "test-proxy-document-key-with-32-characters",
      PLUGNMEET_API_URL: `http://127.0.0.1:${plugNmeetAddress.port}`,
      PLUGNMEET_CLIENT_URL: "http://video-client.test/meeting/",
      PLUGNMEET_API_KEY: "test-video-api-key",
      PLUGNMEET_API_SECRET: "test-video-api-secret",
      MEETVOTE_PUBLIC_URL: "https://meetvote.elawini.test"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    const stopped = new Promise((resolve) => {
      if (apiProcess.exitCode !== null) resolve();
      else apiProcess.once("exit", resolve);
    });
    apiProcess.kill();
    await stopped;
    await new Promise((resolve) => mockOpenSlides.close(resolve));
    await new Promise((resolve) => mockPlugNmeet.close(resolve));
    await new Promise((resolve) => mockOpenSlidesAuth.close(resolve));
    await new Promise((resolve) => mockOpenSlidesVote.close(resolve));
    await rm(tempDirectory, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; }
    } catch { /* Wait for the isolated API process to bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "isolated MeetVote API did not become ready");
  const localhostCors = await request("/health", { origin: "http://localhost:3000" });
  assert.equal(localhostCors.body.status, "ok");
  assert.equal(localhostCors.headers["access-control-allow-origin"], "http://localhost:3000");
  const lanCors = await request("/health", { origin: "http://192.168.43.93:3000" });
  assert.equal(lanCors.status, 200);
  assert.equal(lanCors.headers["access-control-allow-origin"], "http://192.168.43.93:3000");
  const blockedOrigin = await request("/health", { origin: "http://untrusted.example" });
  assert.equal(blockedOrigin.headers["access-control-allow-origin"], undefined);

  const bootstrap = await request("/auth/bootstrap", {
    method: "POST",
    body: { email: "admin@elawini.local", password: "EstateMeetingSecure2026!", displayName: "Elawini Administrator" }
  });
  assert.ok([200, 409].includes(bootstrap.status));

  const login = await request("/auth/login", {
    method: "POST",
    body: { email: "admin@elawini.local", password: "EstateMeetingSecure2026!" }
  });
  assert.equal(login.status, 200);
  const adminToken = login.body.accessToken;
  const secondAdminLogin = await request("/auth/login", {
    method: "POST",
    body: { email: "admin@elawini.local", password: "EstateMeetingSecure2026!" }
  });
  assert.equal(secondAdminLogin.status, 200);
  const accountProfileSave = await request("/me/profile", {
    method: "PUT",
    token: adminToken,
    body: { displayName: "  MeetVote Administrator  " }
  });
  assert.equal(accountProfileSave.status, 200);
  assert.equal(accountProfileSave.body.displayName, "MeetVote Administrator");
  assert.equal((await request("/me/profile", {
    method: "PUT", token: adminToken, body: { displayName: "   " }
  })).status, 400);
  assert.equal((await request("/me", { token: adminToken })).body.displayName, "MeetVote Administrator");
  assert.equal((await request("/me/password", {
    method: "POST", token: adminToken,
    body: { currentPassword: "WrongCurrentPassword!", newPassword: "EstateVotingSecure2027!" }
  })).status, 401);
  assert.equal((await request("/me/password", {
    method: "POST", token: adminToken,
    body: { currentPassword: "EstateMeetingSecure2026!", newPassword: "short" }
  })).status, 400);
  const passwordUpdate = await request("/me/password", {
    method: "POST",
    token: adminToken,
    body: { currentPassword: "EstateMeetingSecure2026!", newPassword: "EstateVotingSecure2027!" }
  });
  assert.equal(passwordUpdate.status, 200, JSON.stringify(passwordUpdate.body));
  assert.equal((await request("/me", { token: adminToken })).status, 200);
  assert.equal((await request("/me", { token: secondAdminLogin.body.accessToken })).status, 401);
  assert.equal((await request("/auth/login", {
    method: "POST",
    body: { email: "admin@elawini.local", password: "EstateMeetingSecure2026!" }
  })).status, 401);
  const changedPasswordLogin = await request("/auth/login", {
    method: "POST",
    body: { email: "admin@elawini.local", password: "EstateVotingSecure2027!" }
  });
  assert.equal(changedPasswordLogin.status, 200);
  const profileRestore = await request("/me/profile", {
    method: "PUT", token: adminToken, body: { displayName: "Elawini Administrator" }
  });
  assert.equal(profileRestore.status, 200);

  const secondBootstrap = await request("/auth/bootstrap", {
    method: "POST",
    body: { email: `another-admin-${suffix}@elawini.local`, password: "LocalTestPassword2026!", displayName: "Another administrator" }
  });
  assert.equal(secondBootstrap.status, 409);

  const createUser = async (name, role) => request("/users", {
    method: "POST",
    token: adminToken,
    body: {
      email: `${name}-${suffix}@elawini.local`,
      displayName: name,
      password: "LocalTestPassword2026!",
      role
    }
  });
  const eligible = await createUser("Eligible resident", "registered_participant");
  const ineligible = await createUser("Ineligible resident", "registered_participant");
  const quorumResident = await createUser("Quorum resident", "registered_participant");
  assert.equal(eligible.status, 200);
  assert.equal(ineligible.status, 200);
  assert.equal(quorumResident.status, 200);
  const memberA = await request("/hoa/members", {
    method: "POST", token: adminToken,
    body: {
      userId: eligible.body.id, fullName: "Eligible resident", membershipNumber: `MEM-A-${suffix}`,
      memberType: "member", goodStanding: true, isEntity: false, isActive: true
    }
  });
  const memberB = await request("/hoa/members", {
    method: "POST", token: adminToken,
    body: {
      fullName: "Co-owner", membershipNumber: `MEM-B-${suffix}`,
      memberType: "member", goodStanding: true, isEntity: false
    }
  });
  assert.equal(memberA.status, 200, JSON.stringify(memberA.body));
  assert.equal(memberB.status, 200, JSON.stringify(memberB.body));
  assert.equal((await request("/hoa/members", {
    method: "POST", token: adminToken,
    body: { fullName: "Duplicate Developer", memberType: "developer", goodStanding: true }
  })).status, 200);
  const membershipDeveloper = await request("/hoa/members", {
    method: "POST", token: adminToken,
    body: {
      userId: ineligible.body.id, fullName: "Estate Developer", membershipNumber: `DEV-${suffix}`,
      memberType: "developer", goodStanding: true, isEntity: true
    }
  });
  assert.equal(membershipDeveloper.status, 409);
  const developerRecord = (await request("/hoa/membership", { token: adminToken })).body.members
    .find((member) => member.memberType === "developer");
  assert.ok(developerRecord);
  assert.equal((await request("/hoa/voting-config", {
    method: "PUT", token: adminToken, body: { developmentPeriodActive: true }
  })).status, 200);
  const hoaUnit = await request("/hoa/units", {
    method: "POST", token: adminToken,
    body: {
      unitNumber: `ERF-${suffix}`, memberIds: [memberA.body.id, memberB.body.id],
      votingEligible: true, isActive: true
    }
  });
  assert.equal(hoaUnit.status, 200, JSON.stringify(hoaUnit.body));
  assert.equal((await request("/hoa/units", {
    method: "POST", token: adminToken,
    body: { unitNumber: `ERF-BAD-${suffix}`, memberIds: [memberB.body.id, memberB.body.id], votingEligible: true }
  })).status, 400);
  const hoaRegistry = await request("/hoa/membership", { token: adminToken });
  assert.equal(hoaRegistry.status, 200);
  assert.equal(hoaRegistry.body.developmentPeriodActive, true);
  assert.equal(hoaRegistry.body.units.find((unit) => unit.id === hoaUnit.body.id).members.length, 2);
  const participantLogin = async (email) => request("/auth/login", {
    method: "POST", body: { email, password: "LocalTestPassword2026!" }
  });
  const eligibleLogin = await participantLogin(`Eligible resident-${suffix}@elawini.local`);
  const ineligibleLogin = await participantLogin(`Ineligible resident-${suffix}@elawini.local`);
  const quorumLogin = await participantLogin(`Quorum resident-${suffix}@elawini.local`);
  assert.equal(eligibleLogin.status, 200);
  assert.equal(ineligibleLogin.status, 200);
  assert.equal(quorumLogin.status, 200);
  assert.equal((await request("/hoa/membership", { token: eligibleLogin.body.accessToken })).status, 403);
  const chairpersons = await request("/users/meeting-chairpersons", { token: adminToken });
  assert.equal(chairpersons.status, 200);
  assert.ok(chairpersons.body.some(({ id }) => id === eligible.body.id));
  assert.equal("email" in chairpersons.body[0], false);
  assert.equal((await request("/users/meeting-chairpersons", { token: eligibleLogin.body.accessToken })).status, 403);
  assert.equal((await request("/meetings", {
    method: "POST", token: adminToken,
    body: { title: "Invalid meeting type", meetingType: "unlisted", startsAt: new Date().toISOString() }
  })).status, 400);
  assert.equal((await request("/meetings", {
    method: "POST", token: adminToken,
    body: { title: "Invalid chairperson", chairpersonId: "missing-user", startsAt: new Date().toISOString() }
  })).status, 400);

  const meeting = await request("/meetings", {
    method: "POST", token: adminToken,
    body: {
      title: `Annual General Meeting ${suffix}`,
      description: "Annual estate governance and resident updates.",
      meetingType: "agm",
      chairpersonId: eligible.body.id,
      startsAt: new Date().toISOString()
    }
  });
  assert.equal(meeting.status, 200);
  assert.equal(meeting.body.meetingType, "agm");
  assert.equal(meeting.body.chairpersonId, eligible.body.id);
  assert.equal((await request("/meetings", { token: eligibleLogin.body.accessToken })).body
    .find(({ id }) => id === meeting.body.id).description, "Annual estate governance and resident updates.");
  assert.equal((await request("/meetings", { token: eligibleLogin.body.accessToken })).body
    .find(({ id }) => id === meeting.body.id).chairperson_name, "Eligible resident");
  const guest = await request(`/meetings/${meeting.body.id}/guest-links`, { method: "POST", token: adminToken, body: {} });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.voting, false);
  const guestToken = new URL(guest.body.shareUrl).searchParams.get("guest");
  assert.equal(new URL(guest.body.shareUrl).origin, "https://meetvote.elawini.test");
  assert.ok(guestToken);
  const proxyMeeting = await request("/meetings", {
    method: "POST", token: adminToken,
    body: {
      title: `Proxy test meeting ${suffix}`,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }
  });
  assert.equal(proxyMeeting.status, 200);
  const proxyAppointment = await request(`/meetings/${proxyMeeting.body.id}/proxies`, {
    method: "POST", token: adminToken,
    body: { unitId: hoaUnit.body.id, memberIds: [memberA.body.id, memberB.body.id], proxyUserId: ineligible.body.id }
  });
  assert.equal(proxyAppointment.status, 200, JSON.stringify(proxyAppointment.body));
  const proxyPdf = Buffer.from("%PDF-1.7\nElawini test document\n");
  const uploadProxyDocument = (documentType, fileName) => request(
    `/meetings/${proxyMeeting.body.id}/proxies/${proxyAppointment.body.id}/documents`,
    {
      method: "PUT", token: adminToken,
      body: { documentType, fileName, mimeType: "application/pdf", contentBase64: proxyPdf.toString("base64") }
    }
  );
  assert.equal((await uploadProxyDocument("instrument", "signed-proxy.pdf")).status, 200);
  assert.equal((await uploadProxyDocument(`member_id_${memberA.body.id}`, "member-a-id.pdf")).status, 200);
  assert.equal((await uploadProxyDocument(`member_id_${memberB.body.id}`, "member-b-id.pdf")).status, 200);
  const proxyList = await request(`/meetings/${proxyMeeting.body.id}/proxies`, { token: adminToken });
  assert.equal(proxyList.status, 200);
  assert.equal(proxyList.body[0].documents.length, 3);
  assert.equal("contentBase64" in proxyList.body[0].documents[0], false);
  assert.equal((await request(`/meetings/${proxyMeeting.body.id}/proxies`, { token: eligibleLogin.body.accessToken })).status, 403);
  const privateProxyDocument = await request(
    `/meetings/${proxyMeeting.body.id}/proxies/${proxyAppointment.body.id}/documents/instrument`,
    { token: adminToken }
  );
  assert.equal(privateProxyDocument.status, 200);
  assert.equal(Buffer.from(privateProxyDocument.body.contentBase64, "base64").toString(), proxyPdf.toString());
  assert.equal((await request(`/meetings/${proxyMeeting.body.id}/proxies/${proxyAppointment.body.id}/verify`, {
    method: "PUT", token: adminToken, body: { status: "verified" }
  })).status, 200);
  const memberBUpdate = await request(`/hoa/members/${memberB.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      userId: null, fullName: "Co-owner", membershipNumber: `MEM-B-${suffix}`,
      memberType: "member", goodStanding: false, isEntity: false, isActive: true
    }
  });
  assert.equal(memberBUpdate.status, 200);
  assert.equal((await request("/hoa/membership", { token: adminToken })).body.units
    .find((unit) => unit.id === hoaUnit.body.id).votingEligible, false);
  const restoreMemberB = await request(`/hoa/members/${memberB.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      userId: null, fullName: "Co-owner", membershipNumber: `MEM-B-${suffix}`,
      memberType: "member", goodStanding: true, isEntity: false, isActive: true
    }
  });
  assert.equal(restoreMemberB.status, 200);
  assert.equal((await request("/hoa/membership", { token: adminToken })).body.units
    .find((unit) => unit.id === hoaUnit.body.id).votingEligible, false);
  assert.equal((await request(`/hoa/units/${hoaUnit.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      unitNumber: `ERF-${suffix}`, memberIds: [memberA.body.id, memberB.body.id],
      votingEligible: true, isActive: true
    }
  })).status, 200);
  const guestJoin = await request(`/meetings/${meeting.body.id}/guest-join`, {
    method: "POST", body: { guestToken }
  });
  assert.equal(guestJoin.status, 200);
  assert.equal(guestJoin.body.voting, false);
  assert.equal(new URL(guestJoin.body.joinUrl).origin, "http://video-client.test");
  assert.equal(new URL(guestJoin.body.joinUrl).pathname, "/meeting/");
  assert.equal((await request(`/meetings/${meeting.body.id}/guest-join`, {
    method: "POST", body: { guestToken: "invalid-guest-token" }
  })).status, 401);

  const templatePath = "/election-templates";
  assert.equal((await request(templatePath, { token: eligibleLogin.body.accessToken })).status, 403);
  assert.equal((await request(templatePath, {
    method: "POST", token: eligibleLogin.body.accessToken,
    body: { templateName: "Resident template", title: "Test", votingType: "resolution" }
  })).status, 403);
  assert.equal((await request(templatePath, {
    method: "POST", token: adminToken,
    body: { templateName: "Incomplete", title: "Choose an option", votingType: "multiple_choice", options: ["Only one"] }
  })).status, 400);
  const savedTemplate = await request(templatePath, {
    method: "POST", token: adminToken,
    body: {
      templateName: "Maintenance priorities",
      title: "Choose the maintenance priority",
      votingType: "multiple_choice",
      options: ["Roads", "Lighting"]
    }
  });
  assert.equal(savedTemplate.status, 200);
  assert.deepEqual(savedTemplate.body.options, ["Roads", "Lighting"]);
  const updatedTemplate = await request(`${templatePath}/${savedTemplate.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      templateName: "Estate priorities",
      title: "Choose the next estate project",
      votingType: "multiple_choice",
      options: ["Security", "Landscaping", "Lighting"]
    }
  });
  assert.equal(updatedTemplate.status, 200);
  const listedTemplates = await request(templatePath, { token: adminToken });
  assert.ok(listedTemplates.body.some(({ id, templateName }) =>
    id === savedTemplate.body.id && templateName === "Estate priorities"));
  const candidateTemplateProfiles = candidateProfiles(["Template Candidate One", "Template Candidate Two"]);
  const savedCandidateTemplate = await request(templatePath, {
    method: "POST", token: adminToken,
    body: {
      templateName: "Trustee election",
      title: "Elect the estate trustees",
      votingType: "candidate",
      candidateProfiles: candidateTemplateProfiles
    }
  });
  assert.equal(savedCandidateTemplate.status, 200);
  assert.deepEqual(savedCandidateTemplate.body.candidateProfiles.map((profile) => ({
    fullName: profile.fullName,
    position: profile.position,
    biography: profile.biography,
    experience: profile.experience,
    statement: profile.statement,
    photoData: profile.photoData
  })), candidateTemplateProfiles.map((profile) => ({ ...profile, statement: "" })));
  const updatedCandidateProfiles = candidateTemplateProfiles.map((profile, index) => ({
    ...profile,
    biography: index === 0 ? "Updated fictional test profile." : profile.biography
  }));
  const updatedCandidateTemplate = await request(`${templatePath}/${savedCandidateTemplate.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      templateName: "Trustee election",
      title: "Elect the estate trustees",
      votingType: "candidate",
      candidateProfiles: updatedCandidateProfiles
    }
  });
  assert.equal(updatedCandidateTemplate.status, 200);
  assert.equal(updatedCandidateTemplate.body.candidateProfiles[0].biography, "Updated fictional test profile.");
  const listedCandidateTemplate = await request(templatePath, { token: adminToken });
  assert.deepEqual(listedCandidateTemplate.body.find(({ id }) =>
    id === savedCandidateTemplate.body.id).candidateProfiles, updatedCandidateTemplate.body.candidateProfiles);
  assert.equal((await request(templatePath, {
    method: "POST", token: adminToken,
    body: {
      templateName: "Incomplete candidate template",
      title: "Elect the estate trustees",
      votingType: "candidate",
      candidateProfiles: candidateProfiles(["Only Candidate"])
    }
  })).status, 400);
  const templateElection = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: updatedTemplate.body.title,
      votingType: updatedTemplate.body.votingType,
      options: updatedTemplate.body.options,
      startsAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 10 * 60 * 60_000).toISOString()
    }
  });
  assert.equal(templateElection.status, 200);
  assert.equal(templateElection.body.title, updatedTemplate.body.title);
  assert.deepEqual(templateElection.body.options, updatedTemplate.body.options);
  assert.equal((await request(`${templatePath}/${savedTemplate.body.id}`, {
    method: "DELETE", token: adminToken
  })).status, 200);
  assert.deepEqual((await request(`/meetings/${meeting.body.id}/elections`, { token: adminToken }))
    .body.find(({ id }) => id === templateElection.body.id).options, updatedTemplate.body.options);

  const election = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: "Trustee election",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      secretBallot: true,
      candidateProfiles: candidateProfiles(["Candidate One", "Candidate Two"])
        .map(({ photoData, ...profile }) => profile)
    }
  });
  assert.equal(election.status, 200);
  assert.deepEqual(createdPollEntitledGroupIds, [7]);
  const draftElectionList = `/meetings/${meeting.body.id}/elections`;
  assert.ok((await request(draftElectionList, { token: adminToken })).body.some(({ id }) => id === election.body.id));
  assert.deepEqual((await request(draftElectionList, { token: adminToken })).body
    .find(({ id }) => id === election.body.id).candidateProfiles.map(({ photoData }) => photoData), [null, null]);
  assert.ok(!(await request(draftElectionList, { token: eligibleLogin.body.accessToken })).body.some(({ id }) => id === election.body.id));
  const eligibilityPath = `/elections/${election.body.id}/eligibility`;
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  const voterRoster = await request(eligibilityPath, { token: adminToken });
  assert.equal(voterRoster.status, 200);
  assert.deepEqual(voterRoster.body.map(({ id, votes_allowed }) => ({ id, votes_allowed })),
    [
      { id: eligible.body.id, votes_allowed: 1 },
      { id: ineligible.body.id, votes_allowed: 0 },
      { id: quorumResident.body.id, votes_allowed: 0 }
    ]);
  assert.equal(JSON.stringify(voterRoster.body).includes("password_hash"), false);
  const draftAuthorisation = await request(`/elections/${election.body.id}/voting-authorisation`, {
    token: eligibleLogin.body.accessToken
  });
  assert.equal(draftAuthorisation.body.allowed, false);
  assert.equal(draftAuthorisation.body.votesAllowed, 1);
  assert.match(draftAuthorisation.body.reason, /eligible, but this election has not been opened yet/i);
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id, eligible.body.id] }
  })).status, 400);
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [adminToken] }
  })).status, 400);
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [] }
  })).body.eligibleVoters, 0);
  assert.equal((await request(`/elections/${election.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 409);
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  const futureElection = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: "Future trustee election",
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      candidateProfiles: candidateProfiles(["Candidate Three", "Candidate Four"])
    }
  });
  assert.equal(futureElection.status, 200);
  const futureElectionPath = `/elections/${futureElection.body.id}`;
  assert.equal((await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "start" }
  })).status, 200);
  for (const token of [eligibleLogin.body.accessToken, ineligibleLogin.body.accessToken, quorumLogin.body.accessToken]) {
    assert.equal((await request(`/meetings/${meeting.body.id}/presence`, { method: "POST", token })).status, 200);
  }
  const quorumStatus = await request(`/meetings/${meeting.body.id}/quorum`, { token: adminToken });
  assert.equal(quorumStatus.status, 200);
  assert.equal(quorumStatus.body.quorumMet, true);
  assert.equal((await request(`/elections/${election.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  assert.equal((await request(`/elections/${election.body.id}`, {
    method: "PUT", token: adminToken,
    body: {
      title: "No longer editable",
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    }
  })).status, 409);
  assert.ok((await request(draftElectionList, { token: eligibleLogin.body.accessToken })).body.some(({ id }) => id === election.body.id));
  assert.deepEqual(openSlidesPollActions[0], { action: "poll.start", data: [{ id: 50 }] });
  assert.equal((await request(eligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [] }
  })).status, 409);

  const futureElectionDetails = (await request(`/meetings/${meeting.body.id}/elections`, {
    token: adminToken
  })).body.find(({ id }) => id === futureElection.body.id);
  const updatedProfiles = futureElectionDetails.candidateProfiles.map((profile) => ({ ...profile }));
  updatedProfiles[0].biography = "Updated biography for this candidate.";
  const profileUpdate = await request(`${futureElectionPath}/candidates`, {
    method: "PUT", token: adminToken, body: { candidateProfiles: updatedProfiles }
  });
  assert.equal(profileUpdate.status, 200, profileUpdate.body.error);
  const renamedProfiles = updatedProfiles.map((profile) => ({ ...profile }));
  renamedProfiles[0].fullName = "Changed ballot name";
  assert.equal((await request(`${futureElectionPath}/candidates`, {
    method: "PUT", token: adminToken, body: { candidateProfiles: renamedProfiles }
  })).status, 400);
  const updatedStartsAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const updatedEndsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const editedElection = await request(futureElectionPath, {
    method: "PUT", token: adminToken,
    body: { title: "Updated trustee election", startsAt: updatedStartsAt, endsAt: updatedEndsAt }
  });
  assert.equal(editedElection.status, 200);
  assert.equal(editedElection.body.title, "Updated trustee election");
  assert.equal(editedElection.body.startsAt, updatedStartsAt);
  assert.deepEqual(openSlidesInternalActions.slice(-2).map(({ action }) => action),
    ["assignment.update", "poll.update"]);
  assert.equal((await request(futureElectionPath, {
    method: "PUT", token: adminToken,
    body: { title: "Changed choices", startsAt: updatedStartsAt, endsAt: updatedEndsAt, options: ["A", "B"] }
  })).status, 400);
  assert.equal((await request(`/elections/${futureElection.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${futureElection.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 409);

  assert.equal((await request(eligibilityPath, { token: eligibleLogin.body.accessToken })).status, 403);
  const memberJoin = await request(`/meetings/${meeting.body.id}/join`, {
    method: "POST", token: eligibleLogin.body.accessToken
  });
  assert.equal(memberJoin.status, 200);
  assert.equal(new URL(memberJoin.body.joinUrl).origin, "http://video-client.test");
  assert.equal(new URL(memberJoin.body.joinUrl).pathname, "/meeting/");
  assert.equal(plugNmeetRequests.some(({ path, body }) =>
    path.endsWith("/room/getJoinToken") && body.user_info.user_id === eligible.body.id && body.user_info.is_admin === false), true);
  assert.equal(plugNmeetRequests.some(({ path, body }) =>
    path.endsWith("/room/getJoinToken") && body.user_info.user_id.startsWith("guest-") && body.user_info.is_admin === false), true);

  assert.equal((await request("/users", {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: {
      email: `unauthorised-${suffix}@elawini.local`,
      displayName: "Unauthorised account",
      password: "LocalTestPassword2026!",
      role: "registered_participant"
    }
  })).status, 403);

  const residentMeetings = await request("/meetings", { token: eligibleLogin.body.accessToken });
  assert.equal(residentMeetings.status, 200);
  assert.equal(residentMeetings.body.some((item) => item.id === meeting.body.id), true);
  const residentElections = await request(`/meetings/${meeting.body.id}/elections`, { token: eligibleLogin.body.accessToken });
  assert.equal(residentElections.status, 200);
  assert.equal(residentElections.body[0].id, election.body.id);
  assert.deepEqual(residentElections.body[0].candidates, ["Candidate One", "Candidate Two"]);

  const agendaItem = await request(`/meetings/${meeting.body.id}/agenda`, {
    method: "POST",
    token: adminToken,
    body: { title: "Budget and maintenance", description: "Review the proposed estate budget." }
  });
  assert.equal(agendaItem.status, 200);
  assert.equal(agendaItem.body.position, 1);
  assert.equal(agendaItem.body.status, "pending");
  const uploadedDocument = await request(`/meetings/${meeting.body.id}/documents`, {
    method: "POST",
    token: adminToken,
    body: {
      fileName: "Meeting agenda.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\nElawini meeting agenda").toString("base64")
    }
  });
  assert.equal(uploadedDocument.status, 200);
  assert.equal(uploadedDocument.body.fileName, "Meeting agenda.pdf");
  assert.equal((await request(`/meetings/${meeting.body.id}/documents`, {
    method: "POST",
    token: adminToken,
    body: {
      fileName: "not-a-pdf.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("Not a PDF").toString("base64")
    }
  })).status, 400);
  const oversizedPdf = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
  Buffer.from("%PDF-").copy(oversizedPdf);
  assert.equal((await request(`/meetings/${meeting.body.id}/documents`, {
    method: "POST",
    token: adminToken,
    body: {
      fileName: "oversized.pdf",
      mimeType: "application/pdf",
      contentBase64: oversizedPdf.toString("base64")
    }
  })).status, 400);
  const residentDocuments = await request(`/meetings/${meeting.body.id}/documents`, { token: eligibleLogin.body.accessToken });
  assert.equal(residentDocuments.status, 200);
  assert.equal(residentDocuments.body.length, 1);
  assert.equal("content" in residentDocuments.body[0], false);
  const downloadedDocument = await request(`/meetings/${meeting.body.id}/documents/${uploadedDocument.body.id}`, {
    token: eligibleLogin.body.accessToken
  });
  assert.equal(Buffer.from(downloadedDocument.body.contentBase64, "base64").toString(), "%PDF-1.4\nElawini meeting agenda");
  assert.equal((await request(`/meetings/${meeting.body.id}/documents`, {
    method: "POST", token: eligibleLogin.body.accessToken,
    body: { fileName: "private.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQ=" }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/documents/${uploadedDocument.body.id}`, {
    method: "DELETE", token: eligibleLogin.body.accessToken
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/documents/${uploadedDocument.body.id}`, {
    method: "DELETE", token: adminToken
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/documents/${uploadedDocument.body.id}`, {
    token: eligibleLogin.body.accessToken
  })).status, 404);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${agendaItem.body.id}/status`, {
    method: "PUT", token: eligibleLogin.body.accessToken, body: { status: "completed" }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${agendaItem.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "in-review" }
  })).status, 400);
  const secondAgendaItem = await request(`/meetings/${meeting.body.id}/agenda`, {
    method: "POST",
    token: adminToken,
    body: { title: "Resident questions" }
  });
  assert.equal(secondAgendaItem.status, 200);
  assert.equal(secondAgendaItem.body.position, 2);
  const motion = await request(`/meetings/${meeting.body.id}/motions`, {
    method: "POST",
    token: adminToken,
    body: {
      agendaItemId: agendaItem.body.id,
      title: "Approve the annual budget",
      text: "That the proposed annual budget be adopted."
    }
  });
  assert.equal(motion.status, 200);
  const residentAgenda = await request(`/meetings/${meeting.body.id}/agenda`, { token: eligibleLogin.body.accessToken });
  assert.equal(residentAgenda.status, 200);
  assert.equal(residentAgenda.body.items[0].title, "Budget and maintenance");
  assert.equal(residentAgenda.body.items[0].status, "pending");
  assert.equal(residentAgenda.body.items[0].motions[0].title, "Approve the annual budget");
  assert.equal(residentAgenda.body.items[0].motions[0].proposer_name, "Elawini Administrator");
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { title: "Unauthorised agenda item" }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${agendaItem.body.id}/status`, {
    method: "PUT", token: eligibleLogin.body.accessToken, body: { status: "in_progress" }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${agendaItem.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "waiting" }
  })).status, 400);
  assert.equal((await request(`/meetings/${meeting.body.id}/motions`, {
    method: "POST",
    token: adminToken,
    body: { agendaItemId: "another-meeting-item", title: "Invalid motion", text: "Invalid agenda reference." }
  })).status, 400);

  const eligibleAuthorisation = await request(`/elections/${election.body.id}/voting-authorisation`, { token: eligibleLogin.body.accessToken });
  const ineligibleAuthorisation = await request(`/elections/${election.body.id}/voting-authorisation`, { token: ineligibleLogin.body.accessToken });
  const guestAuthorisation = await request(`/elections/${election.body.id}/voting-authorisation`, { token: guestToken });

  assert.equal(eligibleAuthorisation.status, 200);
  assert.equal(eligibleAuthorisation.body.allowed, true);
  assert.equal(ineligibleAuthorisation.status, 200);
  assert.equal(ineligibleAuthorisation.body.allowed, false);
  assert.equal(guestAuthorisation.status, 401);
  const eligibleBallot = await request(`/elections/${election.body.id}/ballot`, { token: eligibleLogin.body.accessToken });
  const ineligibleBallot = await request(`/elections/${election.body.id}/ballot`, { token: ineligibleLogin.body.accessToken });
  assert.equal(eligibleBallot.status, 200);
  assert.equal(eligibleBallot.body.allowed, true);
  assert.deepEqual(eligibleBallot.body.candidates, ["Candidate One", "Candidate Two"]);
  assert.equal(ineligibleBallot.status, 200);
  assert.equal(ineligibleBallot.body.allowed, false);
  assert.equal((await request(`/elections/${election.body.id}/ballot`, {
    method: "POST",
    token: ineligibleLogin.body.accessToken,
    body: { candidateIndex: 0 }
  })).status, 403);
  assert.equal((await request(`/elections/${election.body.id}/ballot`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { candidateIndex: 9 }
  })).status, 400);
  const concurrentBallots = await Promise.all([1, 0].map((candidateIndex) => request(`/elections/${election.body.id}/ballot`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { candidateIndex }
  })));
  assert.equal(concurrentBallots[0].status, 200);
  assert.equal(concurrentBallots[1].status, 200);
  assert.deepEqual(submittedBallots, [{ value: { "502": 1 } }]);
  assert.equal((await request(`/elections/${election.body.id}/ballot`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { candidateIndex: 0 }
  })).status, 409);
  assert.equal((await request(`/elections/${election.body.id}/ballot`, {
    token: eligibleLogin.body.accessToken
  })).body.alreadyVoted, true);
  simulateAlreadyStoppedPoll = true;
  const closedElection = await request(`/elections/${election.body.id}/status`, {
    method: "PUT",
    token: adminToken,
    body: { status: "closed" }
  });
  simulateAlreadyStoppedPoll = false;
  assert.equal(closedElection.status, 200);
  assert.deepEqual(openSlidesPollActions.at(-1), {
    action: "poll.stop",
    data: [{ id: 50, preserve_vote_data: true }]
  });
  const publishedResults = await request(`/elections/${election.body.id}/results`, { token: eligibleLogin.body.accessToken });
  assert.equal(publishedResults.status, 200);
  assert.equal(publishedResults.body.votesCast, 1);
  assert.deepEqual(publishedResults.body.candidates, [
    { name: "Candidate One", votes: 0 },
    { name: "Candidate Two", votes: 1 }
  ]);
  assert.equal("user_ids" in publishedResults.body, false);
  assert.equal((await request(`/elections/${election.body.id}/results`, { token: ineligibleLogin.body.accessToken })).status, 200);
  assert.equal((await request(`/elections/${election.body.id}/ballot`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { candidateIndex: 0 }
  })).status, 409);
  assert.equal((await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "end" }
  })).status, 200);

  const liveSession = await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "start" }
  });
  assert.equal(liveSession.status, 200);
  assert.equal(liveSession.body.live, true);
  const residentAttendance = await request(`/meetings/${meeting.body.id}/attendance`, {
    token: eligibleLogin.body.accessToken
  });
  assert.equal(residentAttendance.status, 200);
  assert.equal(residentAttendance.body.checkedIn, false);
  assert.equal(residentAttendance.body.quorum.status, "grace_period");
  assert.equal(JSON.stringify(residentAttendance.body).includes("Eligible resident"), false);
  assert.equal((await request(`/meetings/${meeting.body.id}/attendance/check-in`, {
    method: "POST", token: eligibleLogin.body.accessToken
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/attendance/check-in`, {
    method: "POST", token: adminToken
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/presence`, {
    method: "POST", token: eligibleLogin.body.accessToken
  })).status, 200);
  const organiserAttendance = await request(`/meetings/${meeting.body.id}/attendance`, { token: adminToken });
  assert.equal(organiserAttendance.body.checkedInCount, 1);
  assert.equal(organiserAttendance.body.onlineCount, 1);
  assert.equal(organiserAttendance.body.attendees[0].display_name, "Eligible resident");
  assert.equal(organiserAttendance.body.onlineParticipants[0].display_name, "Eligible resident");

  const residentQuestion = await request(`/meetings/${meeting.body.id}/questions`, {
    method: "POST",
    token: eligibleLogin.body.accessToken,
    body: { question: "Can the proposed budget be reviewed?", isAnonymous: true }
  });
  assert.equal(residentQuestion.status, 200);
  assert.equal(residentQuestion.body.status, "pending");
  assert.deepEqual((await request(`/meetings/${meeting.body.id}/questions`, {
    token: ineligibleLogin.body.accessToken
  })).body, []);
  const pendingQuestions = await request(`/meetings/${meeting.body.id}/questions`, { token: adminToken });
  assert.equal(pendingQuestions.body.length, 1);
  assert.equal(pendingQuestions.body[0].displayName, "Anonymous resident");
  assert.equal("user_id" in pendingQuestions.body[0], false);
  assert.equal((await request(`/meetings/${meeting.body.id}/questions/${residentQuestion.body.id}`, {
    method: "PUT", token: ineligibleLogin.body.accessToken, body: { status: "published" }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/questions/${residentQuestion.body.id}`, {
    method: "PUT", token: adminToken, body: { status: "answered", answer: "We will share the details." }
  })).status, 409);
  assert.equal((await request(`/meetings/${meeting.body.id}/questions/${residentQuestion.body.id}`, {
    method: "PUT", token: adminToken, body: { status: "published" }
  })).status, 200);
  const publicQuestion = await request(`/meetings/${meeting.body.id}/questions`, { token: ineligibleLogin.body.accessToken });
  assert.equal(publicQuestion.body[0].question, "Can the proposed budget be reviewed?");
  assert.equal((await request(`/meetings/${meeting.body.id}/questions/${residentQuestion.body.id}`, {
    method: "PUT", token: adminToken,
    body: { status: "answered", answer: "The budget will be reviewed at the next meeting." }
  })).status, 200);
  const answeredQuestion = await request(`/meetings/${meeting.body.id}/questions`, { token: ineligibleLogin.body.accessToken });
  assert.equal(answeredQuestion.body[0].status, "answered");
  assert.equal(answeredQuestion.body[0].answer, "The budget will be reviewed at the next meeting.");
  assert.equal((await request(`/meetings/${meeting.body.id}/presence`, {
    method: "POST", token: ineligibleLogin.body.accessToken
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/presence`, {
    method: "POST", token: quorumLogin.body.accessToken
  })).status, 200);

  assert.equal((await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "start" }
  })).status, 409);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/agenda`, {
    method: "PUT", token: eligibleLogin.body.accessToken, body: { agendaItemId: agendaItem.body.id }
  })).status, 403);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/agenda`, {
    method: "PUT", token: adminToken, body: { agendaItemId: agendaItem.body.id }
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda`, { token: adminToken }))
    .body.items[0].status, "in_progress");

  const resolution = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: { title: "Approve the annual budget", votingType: "resolution", agendaItemId: agendaItem.body.id }
  });
  assert.equal(resolution.status, 200);
  assert.deepEqual(resolution.body.options, ["For", "Against", "Abstain"]);
  const agendaElections = await request(`/meetings/${meeting.body.id}/elections`, { token: adminToken });
  assert.equal(agendaElections.body.find((item) => item.id === resolution.body.id).agenda_item_id, agendaItem.body.id);
  const resolutionEligibilityPath = `/elections/${resolution.body.id}/eligibility`;
  assert.equal((await request(resolutionEligibilityPath, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${resolution.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/agenda`, {
    method: "PUT", token: adminToken, body: { agendaItemId: secondAgendaItem.body.id }
  })).status, 409);
  const liveState = await request(`/meetings/${meeting.body.id}/live`, { token: eligibleLogin.body.accessToken });
  assert.equal(liveState.status, 200);
  assert.equal(liveState.body.session.active_election_id, resolution.body.id);
  const liveElections = await request(`/meetings/${meeting.body.id}/elections`, { token: eligibleLogin.body.accessToken });
  const liveResolution = liveElections.body.find((item) => item.id === resolution.body.id);
  assert.equal(liveResolution.voting_type, "resolution");
  assert.equal(liveResolution.is_active_in_live_meeting, true);
  assert.equal(liveResolution.eligible_voter_count, null);
  assert.equal(liveResolution.participation_count, null);
  const managerElections = await request(`/meetings/${meeting.body.id}/elections`, { token: adminToken });
  const managerResolution = managerElections.body.find((item) => item.id === resolution.body.id);
  assert.equal(managerResolution.eligible_voter_count, 1);
  assert.equal(managerResolution.participation_count, 0);
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${agendaItem.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "completed" }
  })).status, 409);
  const residentTurnout = await request(`/meetings/${meeting.body.id}/elections`, { token: eligibleLogin.body.accessToken });
  assert.equal(residentTurnout.body.find((item) => item.id === resolution.body.id).participation_count, null);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/voting-item`, {
    method: "PUT", token: adminToken, body: { electionId: null }
  })).status, 409);
  assert.equal((await request(`/elections/${resolution.body.id}/ballot`, {
    method: "POST", token: eligibleLogin.body.accessToken, body: { candidateIndex: 2 }
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/elections`, { token: adminToken }))
    .body.find((item) => item.id === resolution.body.id).participation_count, 1);
  assert.equal((await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "end" }
  })).status, 409);
  assert.equal((await request(`/elections/${resolution.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "closed" }
  })).status, 200);
  const resolutionResults = await request(`/elections/${resolution.body.id}/results`, { token: eligibleLogin.body.accessToken });
  assert.equal(resolutionResults.status, 200);
  assert.deepEqual(resolutionResults.body.candidates.map(({ name }) => name), ["For", "Against", "Abstain"]);
  assert.equal(resolutionResults.body.votesCast, 1);
  assert.deepEqual(resolutionResults.body.candidates.map(({ votes }) => votes), [0, 0, 1]);
  assert.ok(resolutionResults.body.openedAt);
  assert.ok(resolutionResults.body.closedAt);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/agenda`, {
    method: "PUT", token: adminToken, body: { agendaItemId: secondAgendaItem.body.id }
  })).status, 200);
  const agendaAfterMove = await request(`/meetings/${meeting.body.id}/agenda`, { token: adminToken });
  assert.equal(agendaAfterMove.body.items[0].status, "completed");
  assert.equal(agendaAfterMove.body.items[1].status, "in_progress");
  assert.equal((await request(`/meetings/${meeting.body.id}/agenda/${secondAgendaItem.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "completed" }
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/live`, { token: adminToken }))
    .body.session.active_agenda_item_id, null);
  const misplacedVote = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: { title: "Vote on the old agenda item", votingType: "resolution", agendaItemId: agendaItem.body.id }
  });
  assert.equal(misplacedVote.status, 200);
  assert.equal((await request(`/elections/${misplacedVote.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${misplacedVote.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 409);
  assert.equal((await request(`/meetings/${meeting.body.id}/live/voting-item`, {
    method: "PUT", token: adminToken, body: { electionId: misplacedVote.body.id }
  })).status, 409);
  const multipleChoice = await request(`/meetings/${meeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: { title: "Choose the maintenance priority", votingType: "multiple_choice", options: ["Roads", "Lighting"] }
  });
  assert.equal(multipleChoice.status, 200);
  assert.deepEqual(multipleChoice.body.options, ["Roads", "Lighting"]);
  const guestLiveDuringMeeting = await request(`/meetings/${meeting.body.id}/guest-live`, {
    method: "POST", body: { guestToken }
  });
  assert.equal(guestLiveDuringMeeting.status, 200);
  assert.equal(guestLiveDuringMeeting.body.guest, true);
  assert.deepEqual(guestLiveDuringMeeting.body.elections, []);
  assert.equal((await request(`/elections/${multipleChoice.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${multipleChoice.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  const openGuestLive = await request(`/meetings/${meeting.body.id}/guest-live`, {
    method: "POST", body: { guestToken }
  });
  assert.deepEqual(openGuestLive.body.elections.map(({ id }) => id), [multipleChoice.body.id]);
  assert.equal("is_eligible" in openGuestLive.body.elections[0], false);
  assert.equal((await request(`/elections/${multipleChoice.body.id}/ballot`, {
    method: "POST", body: { candidateIndex: 0 }
  })).status, 401);
  assert.equal((await request(`/elections/${multipleChoice.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "closed" }
  })).status, 200);
  assert.equal((await request(`/meetings/${meeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "end" }
  })).status, 200);
  const report = await request(`/meetings/${meeting.body.id}/report`, { token: ineligibleLogin.body.accessToken });
  assert.equal(report.status, 200);
  assert.equal(report.body.mimeType, "text/csv;charset=utf-8");
  const reportCsv = Buffer.from(report.body.contentBase64, "base64").toString("utf8");
  assert.match(reportCsv, /represented Units/);
  assert.match(reportCsv, /Aggregate result/);
  assert.match(reportCsv, /Can the proposed budget be reviewed\?/);
  assert.doesNotMatch(reportCsv, /eligible@example\.test|password_hash|user_id/i);
  const guestLive = await request(`/meetings/${meeting.body.id}/guest-live`, {
    method: "POST", body: { guestToken }
  });
  assert.equal(guestLive.status, 200);
  assert.equal(guestLive.body.guest, true);
  assert.equal(guestLive.body.live, false);
  assert.equal((await request(`/meetings/${meeting.body.id}/guest-live`, {
    method: "POST", body: { guestToken: "invalid-guest-token" }
  })).status, 401);

  const defaultMeeting = await request("/meetings", {
    method: "POST", token: adminToken,
    body: { title: "Default community meeting", startsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }
  });
  assert.equal(defaultMeeting.status, 200);
  assert.equal(defaultMeeting.body.meetingType, "general");
  assert.equal(defaultMeeting.body.chairpersonId, login.body.user.id);
  assert.equal((await request(`/meetings/${defaultMeeting.body.id}/attendance/check-in`, {
    method: "POST", token: eligibleLogin.body.accessToken
  })).status, 409);
  assert.equal((await request(`/meetings/${defaultMeeting.body.id}/questions`, {
    method: "POST", token: eligibleLogin.body.accessToken,
    body: { question: "Can we discuss this?" }
  })).status, 409);
  const defaultMeetingListItem = (await request("/meetings", { token: adminToken })).body
    .find(({ id }) => id === defaultMeeting.body.id);
  assert.equal(defaultMeetingListItem.description, "");
  assert.equal(defaultMeetingListItem.meeting_type, "general");
  assert.equal(defaultMeetingListItem.chairperson_name, "Elawini Administrator");
  assert.equal((await request(`/meetings/${defaultMeeting.body.id}/live`, {
    method: "POST", token: adminToken, body: { action: "start" }
  })).status, 200);
  for (const token of [eligibleLogin.body.accessToken, ineligibleLogin.body.accessToken, quorumLogin.body.accessToken]) {
    assert.equal((await request(`/meetings/${defaultMeeting.body.id}/presence`, { method: "POST", token })).status, 200);
  }

  const expiringElection = await request(`/meetings/${defaultMeeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: "Automatic close deadline test",
      votingType: "multiple_choice",
      options: ["Approve", "Reject"],
      startsAt: new Date(Date.now() - 10_000).toISOString(),
      endsAt: new Date(Date.now() + 2500).toISOString()
    }
  });
  assert.equal(expiringElection.status, 200);
  assert.equal((await request(`/elections/${expiringElection.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${expiringElection.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  const closeDeadline = Date.now() + 7000;
  let expiredStatus = "open";
  while (Date.now() < closeDeadline && expiredStatus === "open") {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refreshed = await request(`/meetings/${defaultMeeting.body.id}/elections`, { token: adminToken });
    expiredStatus = refreshed.body.find(({ id }) => id === expiringElection.body.id)?.status;
  }
  assert.equal(expiredStatus, "closed");
  assert.equal((await request(`/elections/${expiringElection.body.id}/results`, { token: adminToken })).status, 200);

  const unavailableResultsElection = await request(`/meetings/${defaultMeeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: "Automatic close without results test",
      votingType: "multiple_choice",
      options: ["Approve", "Reject"],
      startsAt: new Date(Date.now() - 10_000).toISOString(),
      endsAt: new Date(Date.now() + 2000).toISOString()
    }
  });
  assert.equal(unavailableResultsElection.status, 200);
  assert.equal((await request(`/elections/${unavailableResultsElection.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${unavailableResultsElection.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  simulateVoteResultsFailure = true;
  const unavailableCloseDeadline = Date.now() + 7000;
  let unavailableResultsStatus = "open";
  while (Date.now() < unavailableCloseDeadline && unavailableResultsStatus === "open") {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refreshed = await request(`/meetings/${defaultMeeting.body.id}/elections`, { token: adminToken });
    unavailableResultsStatus = refreshed.body.find(({ id }) => id === unavailableResultsElection.body.id)?.status;
  }
  simulateVoteResultsFailure = false;
  assert.equal(unavailableResultsStatus, "closed");
  assert.equal((await request(`/elections/${unavailableResultsElection.body.id}/results`, { token: adminToken })).status, 404);

  const manualUnavailableResultsElection = await request(`/meetings/${defaultMeeting.body.id}/elections`, {
    method: "POST", token: adminToken,
    body: {
      title: "Manual close without results test",
      votingType: "multiple_choice",
      options: ["Approve", "Reject"],
      startsAt: new Date(Date.now() - 10_000).toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString()
    }
  });
  assert.equal(manualUnavailableResultsElection.status, 200);
  assert.equal((await request(`/elections/${manualUnavailableResultsElection.body.id}/eligibility`, {
    method: "PUT", token: adminToken, body: { userIds: [eligible.body.id] }
  })).status, 200);
  assert.equal((await request(`/elections/${manualUnavailableResultsElection.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "open" }
  })).status, 200);
  simulateVoteResultsFailure = true;
  const manualClose = await request(`/elections/${manualUnavailableResultsElection.body.id}/status`, {
    method: "PUT", token: adminToken, body: { status: "closed" }
  });
  simulateVoteResultsFailure = false;
  assert.equal(manualClose.status, 200);
  assert.equal(manualClose.body.resultsPublished, false);
  assert.equal((await request(`/elections/${manualUnavailableResultsElection.body.id}/results`, { token: adminToken })).status, 404);

  assert.equal((await request("/auth/logout", { method: "POST", token: ineligibleLogin.body.accessToken })).status, 200);
  assert.equal((await request("/me", { token: ineligibleLogin.body.accessToken })).status, 401);
});
