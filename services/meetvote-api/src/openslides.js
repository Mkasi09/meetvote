import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const required = (value, name) => {
  if (!value) throw Object.assign(new Error(`The internal meeting service is not configured (${name}). Contact an administrator.`), { status: 503 });
  return value;
};

function positiveId(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error(`The internal meeting service returned an invalid ${name}. Contact an administrator.`), { status: 502 });
  }
  return parsed;
}

function findField(value, field) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, field) && value[field] !== null) return value[field];
  for (const child of Object.values(value)) {
    const found = findField(child, field);
    if (found !== undefined) return found;
  }
}

function findActionError(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.status === "error") return value.message || value.error || "unknown action error";
  for (const child of Object.values(value)) {
    const found = findActionError(child);
    if (found) return found;
  }
}

export function createOpenSlidesClient({
  baseUrl = process.env.OPENSLIDES_URL,
  passwordFile = process.env.OPENSLIDES_INTERNAL_PASSWORD_FILE,
  authUrl = process.env.OPENSLIDES_AUTH_URL,
  voteUrl = process.env.OPENSLIDES_VOTE_URL,
  voterPasswordKey = process.env.OPENSLIDES_VOTER_PASSWORD_KEY,
  actionUsername = process.env.OPENSLIDES_ACTION_USERNAME,
  actionPasswordFile = process.env.OPENSLIDES_ACTION_PASSWORD_FILE,
  committeeId = Number(process.env.OPENSLIDES_COMMITTEE_ID || 1),
  adminId = Number(process.env.OPENSLIDES_ADMIN_ID || 1),
  fetchImpl = fetch
} = {}) {
  let passwordPromise;
  const action = async (name, data) => {
    const url = required(baseUrl, "OpenSlides URL");
    const file = required(passwordFile, "OpenSlides internal password file");
    passwordPromise ||= readFile(file, "utf8").then((value) => value.trim());
    const password = required(await passwordPromise, "OpenSlides internal password");
    let response;
    try {
      response = await fetchImpl(new URL("/internal/handle_request", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: Buffer.from(password).toString("base64")
        },
        body: JSON.stringify([{ action: name, data }]),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw Object.assign(new Error("The internal meeting service is unavailable. Try again or contact an administrator."), { status: 502 });
    }

    const responseText = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`The internal meeting service rejected the request (status ${response.status}).`), { status: 502 });
    }
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw Object.assign(new Error("The internal meeting service returned an invalid response."), { status: 502 });
    }
    if (response.status === 202 || result.status_code === 202) {
      throw Object.assign(new Error("The internal meeting service is still processing this request. Wait before retrying, and contact an administrator if it does not finish."), { status: 503 });
    }
    if (result.success === false) {
      throw Object.assign(new Error("The internal meeting service rejected the request. Check the service configuration and permissions."), { status: 502 });
    }
    const failure = findActionError(result) || findField(result, "error") || findField(result, "message_error");
    if (failure) throw Object.assign(new Error("The internal meeting service rejected the request. Check the service configuration and permissions."), { status: 502 });
    return result;
  };
  const actionId = async (name, data, field = "id") => {
    const result = await action(name, [data]);
    const id = findField(result, field);
    if (!id) throw Object.assign(new Error("The internal meeting service did not return the required meeting identifier."), { status: 502 });
    return positiveId(id, "identifier");
  };
  const actionAsServiceUser = async (name, data) => {
    const url = required(baseUrl, "OpenSlides URL");
    const username = required(actionUsername, "OpenSlides action username");
    const servicePasswordFile = required(actionPasswordFile, "OpenSlides action password file");
    const password = required((await readFile(servicePasswordFile, "utf8")).trim(), "OpenSlides action password");
    const authUrlValue = required(authUrl, "OpenSlides authentication URL");
    let loginResponse;
    try {
      loginResponse = await fetchImpl(new URL("/system/auth/login", authUrlValue), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error("OpenSlides action authentication is unavailable. Try again or contact an administrator."), { status: 502 });
    }
    if (!loginResponse.ok) {
      throw Object.assign(new Error("OpenSlides action authentication was rejected. Contact an administrator."), { status: 502 });
    }
    const authentication = loginResponse.headers.get("authentication");
    const cookies = loginResponse.headers.getSetCookie?.() || [];
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    if (!authentication || !cookie) {
      throw Object.assign(new Error("OpenSlides action authentication returned an invalid response."), { status: 502 });
    }

    let response;
    try {
      response = await fetchImpl(new URL("/system/action/handle_request", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authentication,
          cookie
        },
        body: JSON.stringify([{ action: name, data }]),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error("The internal meeting service is unavailable. Try again or contact an administrator."), { status: 502 });
    }
    const responseText = await response.text();
    let result;
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      if (!response.ok) {
        throw Object.assign(new Error(`The internal meeting service rejected the request (status ${response.status}).`), { status: 502 });
      }
      throw Object.assign(new Error("The internal meeting service returned an invalid response."), { status: 502 });
    }
    if (!response.ok) {
      if (name === "poll.stop" && /Cannot stop poll \d+, because it is not in state started\./.test(responseText)) {
        return;
      }
      throw Object.assign(new Error(`The internal meeting service rejected the request (status ${response.status}).`), { status: 502 });
    }
    if (result.success === false || findActionError(result) || findField(result, "error") || findField(result, "message_error")) {
      throw Object.assign(new Error("The internal meeting service rejected the request. Check the service configuration and permissions."), { status: 502 });
    }
    return result;
  };
  const assignUserToMeeting = async (userId, meetingId) => {
    const result = await action("user.assign_meetings", [{
      id: positiveId(userId, "user identifier"),
      meeting_ids: [meetingId],
      group_name: ""
    }]);
    const findMeetingUser = (value) => {
      if (!value || typeof value !== "object") return undefined;
      if (!Array.isArray(value) && value.meeting_id === meetingId) return value;
      for (const child of Object.values(value)) {
        const found = findMeetingUser(child);
        if (found) return found;
      }
    };
    const meetingUser = findMeetingUser(result);
    if (!meetingUser?.meeting_user_id) {
      throw Object.assign(new Error("The internal meeting service did not return the required meeting participant identifier."), { status: 502 });
    }
    const groupIds = meetingUser.group_ids;
    if (!Array.isArray(groupIds) || !groupIds.length) {
      throw Object.assign(new Error("The internal meeting service did not return the resident voting group."), { status: 502 });
    }
    return {
      meetingUserId: positiveId(meetingUser.meeting_user_id, "meeting participant identifier"),
      groupIds: groupIds.map((groupId) => positiveId(groupId, "voting group identifier"))
    };
  };
  const credentialsKey = () => {
    if (!voterPasswordKey || voterPasswordKey.length < 32) {
      throw Object.assign(new Error("Secure voter authentication is not configured. Contact an administrator."), { status: 503 });
    }
    return createHash("sha256").update(voterPasswordKey).digest();
  };
  const authenticateVoter = async (username, password) => {
    const url = required(authUrl, "OpenSlides authentication URL");
    let response;
    try {
      response = await fetchImpl(new URL("/system/auth/login", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error("Secure voter sign-in is unavailable. Try again or contact an administrator."), { status: 502 });
    }
    if (!response.ok) {
      throw Object.assign(new Error("Secure voter sign-in was rejected. Contact an administrator."), { status: 502 });
    }
    const ticket = response.headers.get("authentication");
    if (!ticket) {
      throw Object.assign(new Error("Secure voter sign-in returned an invalid response."), { status: 502 });
    }
    const cookies = response.headers.getSetCookie?.() || [];
    return {
      authentication: ticket,
      cookie: cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ")
    };
  };
  const voteRequest = async (path, { ticket, method = "GET", body } = {}) => {
    const url = required(voteUrl, "OpenSlides vote service URL");
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(ticket ? { authentication: ticket.authentication } : {}),
          ...(ticket?.cookie ? { cookie: ticket.cookie } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error("The secure voting service is unavailable. Try again or contact an administrator."), { status: 502 });
    }
    const text = await response.text();
    if (!response.ok) {
      let errorCode;
      try { errorCode = JSON.parse(text).error; } catch { /* Do not expose upstream error content. */ }
      if (response.status === 409 || (response.status === 400 && errorCode === "double-vote")) {
        throw Object.assign(new Error("A ballot has already been submitted for this election."), { status: 409 });
      }
      throw Object.assign(new Error("The secure voting service rejected the request. Contact an administrator."), { status: 502 });
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error("The secure voting service returned an invalid response."), { status: 502 });
    }
  };

  return {
    async createMeeting({ title, startsAt }) {
      return actionId("meeting.create", {
        name: title,
        committee_id: committeeId,
        language: "en",
        admin_ids: [adminId],
        time_zone: "Africa/Johannesburg",
        start_time: Math.floor(new Date(startsAt).getTime() / 1000),
        end_time: Math.floor(new Date(startsAt).getTime() / 1000) + 2 * 60 * 60
      });
    },
    async deleteMeeting(meetingId) {
      await action("meeting.delete", [{ id: meetingId }]);
    },
    async createCandidateElection({ meetingId, title, candidates }) {
      meetingId = positiveId(meetingId, "meeting identifier");
      const openslidesAssignmentId = await actionId("assignment.create", {
        title,
        meeting_id: meetingId,
        open_posts: 1
      });
      const nomineeRefs = [];
      for (const candidateName of candidates) {
        const username = `mv${randomUUID().replaceAll("-", "")}`;
        const user = await action("user.create", [{
          first_name: candidateName,
          username,
          meeting_id: meetingId
        }]);
        const userId = findField(user, "id");
        if (!userId) {
          throw Object.assign(new Error("The internal meeting service could not add an election candidate to the meeting."), { status: 502 });
        }
        const { meetingUserId, groupIds } = await assignUserToMeeting(userId, meetingId);
        await action("assignment_candidate.create", [{
          assignment_id: openslidesAssignmentId,
          meeting_user_id: meetingUserId
        }]);
        nomineeRefs.push({ userId, meetingUserId, groupIds, name: candidateName });
      }

      const entitledGroupIds = nomineeRefs[0].groupIds;
      if (nomineeRefs.some(({ groupIds }) =>
        groupIds.length !== entitledGroupIds.length ||
        groupIds.some((groupId) => !entitledGroupIds.includes(groupId)))) {
        throw Object.assign(new Error("Candidates were assigned to inconsistent voting groups."), { status: 502 });
      }
      const pollResponse = await action("poll.create", [{
        title,
        type: "pseudoanonymous",
        pollmethod: "Y",
        meeting_id: meetingId,
        content_object_id: `assignment/${openslidesAssignmentId}`,
        entitled_group_ids: entitledGroupIds,
        options: nomineeRefs.map(({ userId }) => ({
          poll_candidate_user_ids: [userId]
        })),
        min_votes_amount: 1,
        max_votes_amount: 1
      }]);
      const openslidesPollId = findField(pollResponse, "id");
      if (!openslidesPollId) {
        throw Object.assign(new Error("The internal meeting service did not return the election poll identifier."), { status: 502 });
      }
      const candidateOptionIds = findField(pollResponse, "option_ids");
      if (!Array.isArray(candidateOptionIds) || candidateOptionIds.length !== nomineeRefs.length) {
        throw Object.assign(new Error("The internal meeting service did not return the required candidate option identifiers."), { status: 502 });
      }
      return { openslidesAssignmentId, openslidesPollId, candidateOptionIds, candidates: nomineeRefs };
    },
    async createChoiceElection({ meetingId, title, options }) {
      return this.createCandidateElection({ meetingId, title, candidates: options });
    },
    async updateElectionTitle({ assignmentId, pollId, title }) {
      await action("assignment.update", [{ id: positiveId(assignmentId, "assignment identifier"), title }]);
      await action("poll.update", [{ id: positiveId(pollId, "poll identifier"), title }]);
    },
    async createVoter({ meetingId }) {
      meetingId = positiveId(meetingId, "meeting identifier");
      required(authUrl, "OpenSlides authentication URL");
      required(voteUrl, "OpenSlides vote service URL");
      const key = credentialsKey();
      const username = `mv${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(32).toString("base64url");
      const user = await action("user.create", [{
        first_name: "Elawini voter",
        username,
        meeting_id: meetingId
      }]);
      const userId = findField(user, "id");
      if (!userId) {
        throw Object.assign(new Error("The internal meeting service could not add an eligible voter to the meeting."), { status: 502 });
      }
      await assignUserToMeeting(userId, meetingId);
      await action("user.set_password", [{ id: userId, password, set_as_default: true }]);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      return {
        userId,
        username,
        credential: {
          iv: iv.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url")
        }
      };
    },
    async hasVoted({ pollId, username, credential }) {
      pollId = positiveId(pollId, "poll identifier");
      const password = decryptVoterCredential(credential, credentialsKey);
      const ticket = await authenticateVoter(username, password);
      const response = await voteRequest(`/system/vote/voted?ids=${encodeURIComponent(pollId)}`, { ticket });
      return Array.isArray(response[String(pollId)]) && response[String(pollId)].length > 0;
    },
    async castVote({ pollId, meetingId, openslidesUserId, optionId, username, credential }) {
      pollId = positiveId(pollId, "poll identifier");
      meetingId = positiveId(meetingId, "meeting identifier");
      openslidesUserId = positiveId(openslidesUserId, "voter identifier");
      optionId = positiveId(optionId, "candidate identifier");
      const password = decryptVoterCredential(credential, credentialsKey);
      const ticket = await authenticateVoter(username, password);
      await action("user.set_present", [{ id: openslidesUserId, meeting_id: meetingId, present: true }]);
      await voteRequest(`/system/vote?id=${encodeURIComponent(pollId)}`, {
        ticket,
        method: "POST",
        body: { value: { [String(optionId)]: 1 } }
      });
    },
    async startPoll(pollId) {
      await actionAsServiceUser("poll.start", [{ id: positiveId(pollId, "poll identifier") }]);
    },
    async stopPoll(pollId, { preserveVoteData = false } = {}) {
      const data = { id: positiveId(pollId, "poll identifier") };
      if (preserveVoteData) data.preserve_vote_data = true;
      await actionAsServiceUser("poll.stop", [data]);
    },
    async getPollResults(pollId) {
      pollId = positiveId(pollId, "poll identifier");
      const response = await voteRequest(`/internal/vote/stop?id=${encodeURIComponent(pollId)}`, { method: "POST" });
      if (!Array.isArray(response.votes)) {
        throw Object.assign(new Error("The secure voting service returned invalid election results."), { status: 502 });
      }
      return response.votes;
    },
    async clearPoll(pollId) {
      pollId = positiveId(pollId, "poll identifier");
      await voteRequest(`/internal/vote/clear?id=${encodeURIComponent(pollId)}`, { method: "POST" });
    }
  };
}

function decryptVoterCredential(credential, keyFactory) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFactory(), Buffer.from(credential.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(credential.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw Object.assign(new Error("Stored voter credentials could not be unlocked. Contact an administrator."), { status: 503 });
  }
}
