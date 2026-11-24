import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenSlidesClient } from "../src/openslides.js";

async function withPasswordFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "meetvote-openslides-"));
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, "test-internal-password\n");
  try {
    await run(passwordFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates a meeting through the private OpenSlides action endpoint", async () => {
  await withPasswordFile(async (passwordFile) => {
    let request;
    const client = createOpenSlidesClient({
      baseUrl: "http://openslides.internal",
      passwordFile,
      committeeId: 7,
      adminId: 3,
      fetchImpl: async (url, options) => {
        request = { url: String(url), options };
        return Response.json([{ status: "success", data: [{ id: 21 }] }]);
      }
    });

    const id = await client.createMeeting({ title: "Residents meeting", startsAt: "2026-07-14T16:30:00.000Z" });
    assert.equal(id, 21);
    assert.equal(request.url, "http://openslides.internal/internal/handle_request");
    assert.equal(request.options.headers.authorization, Buffer.from("test-internal-password").toString("base64"));
    const [action] = JSON.parse(request.options.body);
    assert.equal(action.action, "meeting.create");
    assert.equal(action.data[0].committee_id, 7);
    assert.deepEqual(action.data[0].admin_ids, [3]);
    assert.equal(action.data[0].start_time, Date.parse("2026-07-14T16:30:00.000Z") / 1000);
    assert.equal(action.data[0].end_time, Date.parse("2026-07-14T18:30:00.000Z") / 1000);
    assert.equal(await readFile(passwordFile, "utf8"), "test-internal-password\n");
  });
});

test("creates an assignment, nominees and secret candidate poll in order", async () => {
  await withPasswordFile(async (passwordFile) => {
    const requests = [];
    const fetchImpl = async (_url, options) => {
      const request = JSON.parse(options.body)[0];
      requests.push(request);
      const responseByAction = {
        "assignment.create": [{ id: 40 }],
        "user.create": [{ id: 100 + requests.filter((item) => item.action === "user.create").length }],
        "user.assign_meetings": [{ meeting_users: [{
          meeting_id: 9,
          meeting_user_id: 200 + requests.filter((item) => item.action === "user.assign_meetings").length,
          group_ids: [20]
        }] }],
        "assignment_candidate.create": [{ id: 300 }],
        "poll.create": [{ id: 50, option_ids: [501, 502] }]
      };
      return Response.json([{ status: "success", data: responseByAction[request.action] || [] }]);
    };
    const client = createOpenSlidesClient({ baseUrl: "http://openslides.internal", passwordFile, fetchImpl });
    const result = await client.createCandidateElection({ meetingId: "9.0", title: "Trustee election", candidates: ["A. Resident", "B. Resident"] });

    assert.equal(result.openslidesAssignmentId, 40);
    assert.equal(result.openslidesPollId, 50);
    assert.deepEqual(result.candidateOptionIds, [501, 502]);
    assert.deepEqual(requests.map((request) => request.action), [
      "assignment.create", "user.create", "user.assign_meetings", "assignment_candidate.create",
      "user.create", "user.assign_meetings", "assignment_candidate.create", "poll.create"
    ]);
    assert.deepEqual(requests.filter((request) => request.action === "user.assign_meetings").map(({ data }) => data[0]), [
      { id: 101, meeting_ids: [9], group_name: "" },
      { id: 102, meeting_ids: [9], group_name: "" }
    ]);
    const pollCreate = requests.find((request) => request.action === "poll.create").data[0];
    assert.equal(requests[0].data[0].meeting_id, 9);
    assert.equal(pollCreate.type, "pseudoanonymous");
    assert.equal(pollCreate.content_object_id, "assignment/40");
    assert.deepEqual(pollCreate.entitled_group_ids, [20]);
    assert.deepEqual(pollCreate.options, [{ poll_candidate_user_ids: [101] }, { poll_candidate_user_ids: [102] }]);
    assert.equal(requests.some((request) => ["meeting_user.create", "meeting_user.update", "option.create"].includes(request.action)), false);
    assert.equal(pollCreate.max_votes_amount, 1);
    assert.deepEqual(result.candidateOptionIds, [501, 502]);
  });
});

test("sends integer poll IDs to OpenSlides even when SQLite returns decimal text", async () => {
  await withPasswordFile(async (passwordFile) => {
    const requests = [];
    const client = createOpenSlidesClient({
      baseUrl: "http://openslides.internal",
      authUrl: "http://auth.internal",
      voteUrl: "http://vote.internal",
      passwordFile,
      actionUsername: "superadmin",
      actionPasswordFile: passwordFile,
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/system/auth/login")) {
          return new Response("{}", { headers: { authentication: "service-ticket", "set-cookie": "refreshId=service-cookie; HttpOnly" } });
        }
        if (String(url).endsWith("/system/action/handle_request")) {
          return Response.json([{ status: "success", data: [{ id: 1 }] }]);
        }
        return Response.json({ votes: [] });
      }
    });

    await client.startPoll("1.0");
    await client.stopPoll("1.0", { preserveVoteData: true });
    await client.getPollResults("1.0");
    await client.clearPoll("1.0");

    const actions = requests
      .filter(({ url }) => url.endsWith("/system/action/handle_request"))
      .map(({ options }) => JSON.parse(options.body)[0]);
    assert.deepEqual(actions, [
      { action: "poll.start", data: [{ id: 1 }] },
      { action: "poll.stop", data: [{ id: 1, preserve_vote_data: true }] }
    ]);
    assert.equal(requests[1].url, "http://openslides.internal/system/action/handle_request");
    assert.equal(requests[1].options.headers.authentication, "service-ticket");
    assert.equal(requests[1].options.headers.cookie, "refreshId=service-cookie");
    assert.deepEqual(requests.slice(-2).map(({ url }) => url), [
      "http://vote.internal/internal/vote/stop?id=1",
      "http://vote.internal/internal/vote/clear?id=1"
    ]);
  });
});

test("treats a poll that OpenSlides already stopped as successfully stopped", async () => {
  await withPasswordFile(async (passwordFile) => {
    let message = "Cannot stop poll 11, because it is not in state started.";
    const client = createOpenSlidesClient({
      baseUrl: "http://openslides.internal",
      authUrl: "http://auth.internal",
      passwordFile,
      actionUsername: "superadmin",
      actionPasswordFile: passwordFile,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/system/auth/login")) {
          return new Response("{}", { headers: {
            authentication: "service-ticket",
            "set-cookie": "refreshId=service-cookie; HttpOnly"
          } });
        }
        return Response.json({ success: false, message }, { status: 400 });
      }
    });

    await client.stopPoll(11);
    message = "The action was rejected.";
    await assert.rejects(client.stopPoll(11), { status: 502, message: /status 400/ });
  });
});

test("rejects invalid OpenSlides meeting identifiers before making election actions", async () => {
  const client = createOpenSlidesClient({
    baseUrl: "http://openslides.internal",
    fetchImpl: async () => {
      throw new Error("OpenSlides must not be called for an invalid meeting ID.");
    }
  });
  await assert.rejects(client.createCandidateElection({
    meetingId: "not-an-id",
    title: "Trustee election",
    candidates: ["A. Resident", "B. Resident"]
  }), { status: 502, message: /invalid meeting identifier/ });
});

test("creates a private voter account and submits an authenticated candidate ballot", async () => {
  await withPasswordFile(async (passwordFile) => {
    const requests = [];
    const client = createOpenSlidesClient({
      baseUrl: "http://openslides.internal",
      authUrl: "http://auth.internal",
      voteUrl: "http://vote.internal",
      passwordFile,
      voterPasswordKey: "test-voter-password-key-with-32-characters",
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/system/auth/login")) {
          return new Response("{}", { headers: { authentication: "private-ticket", "set-cookie": "refreshId=refresh-token; HttpOnly" } });
        }
        if (String(url).endsWith("/internal/handle_request")) {
          const [action] = JSON.parse(options.body);
          const data = action.action === "user.create"
            ? [{ id: 61 }]
            : action.action === "user.assign_meetings"
              ? [{ meeting_users: [{ meeting_id: 9, meeting_user_id: 62, group_ids: [20] }] }]
            : [{ id: 61 }];
          return Response.json([{ status: "success", data }]);
        }
        return Response.json({});
      }
    });

    const voter = await client.createVoter({ meetingId: 9 });
    await client.castVote({
      pollId: 50,
      meetingId: 9,
      openslidesUserId: voter.userId,
      optionId: 502,
      username: voter.username,
      credential: voter.credential
    });
    const voteRequest = requests.find(({ url }) => url.includes("/system/vote?id="));
    assert.equal(voteRequest.options.headers.authentication, "private-ticket");
    assert.equal(voteRequest.options.headers.cookie, "refreshId=refresh-token");
    assert.deepEqual(JSON.parse(voteRequest.options.body), { value: { "502": 1 } });
    const actions = requests.filter(({ url }) => url.endsWith("/internal/handle_request"))
      .map(({ options }) => JSON.parse(options.body)[0]);
    assert.deepEqual(actions.map(({ action }) => action), ["user.create", "user.assign_meetings", "user.set_password", "user.set_present"]);
    assert.equal(actions[0].data[0].first_name, "Elawini voter");
    assert.deepEqual(actions[1].data[0], { id: 61, meeting_ids: [9], group_name: "" });
    assert.deepEqual(actions[3].data[0], { id: voter.userId, meeting_id: 9, present: true });
    assert.notEqual(actions[1].data[0].password, voter.credential.ciphertext);
  });
});

test("refuses voter creation when secure voter authentication is not configured", async () => {
  const client = createOpenSlidesClient({
    baseUrl: "http://openslides.internal",
    authUrl: "http://auth.internal",
    voteUrl: "http://vote.internal",
    voterPasswordKey: "",
    fetchImpl: async () => {
      throw new Error("OpenSlides must not be called without a voter password key.");
    }
  });

  await assert.rejects(client.createVoter({ meetingId: 9 }), {
    status: 503,
    message: /Secure voter authentication is not configured/
  });
});

test("reports missing OpenSlides configuration instead of creating a local-only meeting", async () => {
  const client = createOpenSlidesClient({ baseUrl: "", passwordFile: "" });
  await assert.rejects(client.createMeeting({ title: "Meeting", startsAt: new Date().toISOString() }), {
    status: 503,
    message: /internal meeting service is not configured/
  });
});

test("reports asynchronous OpenSlides actions as still processing", async () => {
  await withPasswordFile(async (passwordFile) => {
    const client = createOpenSlidesClient({
      baseUrl: "http://openslides.internal",
      passwordFile,
      fetchImpl: async () => Response.json({
        status_code: 202,
        success: false,
        message: "Action is running.",
        results: [[{ fqid: "action_worker/2" }]]
      }, { status: 202 })
    });

    await assert.rejects(client.createMeeting({ title: "Meeting", startsAt: new Date().toISOString() }), {
      status: 503,
      message: /still processing/
    });
  });
});
