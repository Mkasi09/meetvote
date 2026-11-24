const apiBaseUrl = window.MEETVOTE_CONFIG?.apiUrl || "http://localhost:8090";
const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const setupForm = document.querySelector("#setup-form");
const loginNotice = document.querySelector("#login-notice");
const appNotice = document.querySelector("#app-notice");
const meetingDialog = document.querySelector("#meeting-dialog");
const electionDialog = document.querySelector("#election-dialog");
const voterDialog = document.querySelector("#voter-dialog");
const videoDialog = document.querySelector("#video-dialog");
const agendaDialog = document.querySelector("#meeting-agenda-dialog");
const meetingNotice = document.querySelector("#meeting-notice");
const electionNotice = document.querySelector("#election-notice");
const voterNotice = document.querySelector("#voter-notice");
const state = {
  token: sessionStorage.getItem("meetvote-token"),
  user: null,
  meetings: [],
  electionTemplates: [],
  hoaMembership: null,
  proxyOptions: null,
  proxyAppointments: [],
  activeView: "overview",
  liveMeetingId: null,
  guestToken: null,
  liveRoomJoined: false,
  liveRoomData: null,
  liveRefresh: null,
  refreshingLiveRoom: false,
  liveBallotSubmitting: false
};
let editingElectionId = null;
let editingElectionMeetingId = null;
let candidateProfileSequence = 0;
const candidatePhotoData = new WeakMap();
const submittingBallotIds = new Set();

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const roleName = (role) => ({
  system_administrator: "System administrator",
  meeting_organiser: "Meeting organiser",
  registered_participant: "Registered resident"
})[role] || "Estate member";
const meetingTypeName = (type) => ({
  agm: "Annual general meeting",
  committee: "Committee meeting",
  special: "Special meeting",
  general: "Community meeting"
})[type] || "Community meeting";
const formatDate = (value, options = {}) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date to be confirmed" : new Intl.DateTimeFormat("en-ZA", options).format(date);
};
function formatCountdown(remainingMs) {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days ? `${days}d ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

let expiredElectionRefreshAt = 0;
let expiredElectionRefreshInProgress = false;
function updateElectionCountdowns() {
  const expiredMeetings = new Set();
  document.querySelectorAll("[data-election-countdown]").forEach((countdown) => {
    const remainingMs = Date.parse(countdown.dataset.endsAt) - Date.now();
    const value = countdown.querySelector("[data-countdown-value]");
    if (!Number.isFinite(remainingMs)) {
      value.textContent = "End time unavailable";
    } else if (remainingMs <= 0) {
      value.textContent = "Closing...";
      expiredMeetings.add(countdown.dataset.meetingId);
    } else {
      value.textContent = formatCountdown(remainingMs);
    }
  });
  if (!expiredMeetings.size || !state.token || expiredElectionRefreshInProgress ||
      Date.now() - expiredElectionRefreshAt < 4000) return;
  expiredElectionRefreshAt = Date.now();
  expiredElectionRefreshInProgress = true;
  void refreshExpiredElectionStatuses([...expiredMeetings]);
}

async function refreshExpiredElectionStatuses(meetingIds) {
  try {
    await Promise.all(meetingIds.map(async (meetingId) => {
      const meeting = state.meetings.find((item) => item.id === meetingId);
      if (meeting) meeting.elections = await api(`/meetings/${encodeURIComponent(meetingId)}/elections`);
    }));
    renderElections();
    await renderResults();
    if (state.liveMeetingId && meetingIds.includes(state.liveMeetingId)) await refreshLiveRoom();
  } catch (error) {
    showNotice(appNotice, error.message);
  } finally {
    expiredElectionRefreshInProgress = false;
  }
}

async function api(path, { method = "GET", body, authenticated = true } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (authenticated && state.token) headers.authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new Error("MeetVote could not reach its service. Check your connection and try again.");
  }
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `MeetVote request failed (${response.status}).`);
  return result;
}

function showNotice(element, message, type = "error") {
  element.textContent = message;
  element.className = `notice notice-${type}`;
  element.hidden = false;
}

function showVideoRoom(joinUrl, title, meetingId = null, guestToken = null) {
  document.querySelector("#video-dialog-title").textContent = title || "Elawini Estate meeting";
  state.liveMeetingId = meetingId;
  state.guestToken = guestToken;
  state.liveRoomJoined = false;
  state.liveRoomData = null;
  document.querySelector(".meeting-room-panel").hidden = true;
  document.querySelector(".meeting-room-layout").classList.add("panel-hidden");
  document.querySelector("#video-controls-toggle").hidden = true;
  document.querySelector("#rejoin-video-button").hidden = !meetingId;
  document.querySelector("#live-guest-note").hidden = !guestToken;
  clearNotice(document.querySelector("#live-meeting-notice"));
  if (state.liveRefresh) clearInterval(state.liveRefresh);
  videoDialog.showModal();
  document.querySelector("#video-frame").src = joinUrl;
  if (meetingId) {
    void refreshLiveRoom();
    state.liveRefresh = setInterval(() => void refreshLiveRoom(), 4000);
  }
}

async function joinMeeting(meetingId) {
  const result = await api(`/meetings/${encodeURIComponent(meetingId)}/join`, { method: "POST" });
  showVideoRoom(result.joinUrl, result.title, meetingId);
}

async function rejoinMeeting() {
  const meetingId = state.liveMeetingId;
  if (!meetingId) return;
  const button = document.querySelector("#rejoin-video-button");
  setBusy(button, true, "Reconnecting…");
  try {
    const result = state.guestToken
      ? await api(`/meetings/${encodeURIComponent(meetingId)}/guest-join`, {
        method: "POST",
        authenticated: false,
        body: { guestToken: state.guestToken }
      })
      : await api(`/meetings/${encodeURIComponent(meetingId)}/join`, { method: "POST" });
    if (!videoDialog.open || state.liveMeetingId !== meetingId) return;
    state.liveRoomJoined = false;
    document.querySelector(".meeting-room-panel").hidden = true;
    document.querySelector(".meeting-room-layout").classList.add("panel-hidden");
    document.querySelector("#video-controls-toggle").hidden = true;
    document.querySelector("#video-frame").src = result.joinUrl;
    clearNotice(document.querySelector("#live-meeting-notice"));
  } catch (error) {
    if (videoDialog.open && state.liveMeetingId === meetingId) {
      showNotice(document.querySelector("#live-meeting-notice"), error.message);
    }
  } finally {
    setBusy(button, false);
  }
}

function clearNotice(element) {
  element.hidden = true;
  element.textContent = "";
}

function setBusy(button, busy, busyText = "Please wait…") {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
  state.user = null;
}

function renderAccountIdentity(user) {
  const name = user.displayName || "Estate member";
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "E";
  document.querySelector("#profile-name").textContent = name;
  document.querySelector("#profile-role").textContent = roleName(user.role);
  document.querySelector("#profile-avatar").textContent = initials;
  document.querySelector("#welcome-heading").textContent = `Welcome, ${name.split(/\s+/)[0]}`;
  document.querySelector("#settings-name").textContent = name;
  document.querySelector("#settings-email").textContent = user.email || "";
  document.querySelector("#settings-role").textContent = roleName(user.role);
  document.querySelector("#settings-avatar").textContent = initials;
  document.querySelector("#profile-display-name").value = name;
  document.querySelector("#profile-email").value = user.email || "";
}

function showApp(user) {
  state.user = user;
  loginView.hidden = true;
  appView.hidden = false;
  renderAccountIdentity(user);
  document.querySelector("#create-meeting-button").hidden = !["system_administrator", "meeting_organiser"].includes(user.role);
  document.querySelector("#hero-create-meeting").hidden = !["system_administrator", "meeting_organiser"].includes(user.role);
  document.querySelector("#accounts-nav-item").hidden = user.role !== "system_administrator";
  void refreshData();
}

function setView(view) {
  state.activeView = view;
  document.querySelectorAll(".page-view").forEach((page) => page.classList.toggle("active", page.dataset.page === view));
  const activeNavView = view === "settings-password" ? "settings" : view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === activeNavView));
  const viewNames = { overview: "Home", voting: "Elections", profile: "Profile", "settings-password": "Password security" };
  document.querySelector("#current-view-name").textContent = viewNames[view] || view[0].toUpperCase() + view.slice(1);
  closeMobileDrawer();
  clearNotice(appNotice);
}

function openMobileDrawer() {
  const drawer = document.querySelector("#mobile-drawer");
  const overlay = document.querySelector("#drawer-overlay");
  const button = document.querySelector("#mobile-menu-button");
  drawer.classList.add("open");
  overlay.classList.add("open");
  button.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");
}

function closeMobileDrawer() {
  const drawer = document.querySelector("#mobile-drawer");
  const overlay = document.querySelector("#drawer-overlay");
  const button = document.querySelector("#mobile-menu-button");
  drawer?.classList.remove("open");
  overlay?.classList.remove("open");
  button?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-open");
}

function meetingCard(meeting) {
  const date = new Date(meeting.starts_at);
  const validDate = !Number.isNaN(date.getTime());
  const day = validDate ? new Intl.DateTimeFormat("en-ZA", { day: "2-digit" }).format(date) : "—";
  const month = validDate ? new Intl.DateTimeFormat("en-ZA", { month: "short" }).format(date) : "TBC";
  return `<article class="meeting-card" data-meeting-id="${escapeHtml(meeting.id)}">
    <div class="meeting-card-main">
      <div class="date-tile"><strong>${day}</strong><small>${escapeHtml(month)}</small></div>
      <div><h3>${escapeHtml(meeting.title)}</h3><p>${escapeHtml(formatDate(meeting.starts_at, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }))} · Organised by ${escapeHtml(meeting.organiser_name)} · Chaired by ${escapeHtml(meeting.chairperson_name || meeting.organiser_name)}</p>${meeting.description ? `<p class="meeting-description">${escapeHtml(meeting.description)}</p>` : ""}</div>
    </div>
    <div class="meeting-card-side"><span class="meeting-count">${meeting.election_count} ${Number(meeting.election_count) === 1 ? "decision" : "decisions"}</span><span class="status-label">${escapeHtml(meetingTypeName(meeting.meeting_type))}</span><button class="button button-quiet agenda-button" type="button" data-meeting-id="${escapeHtml(meeting.id)}" data-meeting-title="${escapeHtml(meeting.title)}">Agenda &amp; motions</button>${meeting.has_live_room ? `<button class="button button-quiet join-meeting-button" type="button" data-meeting-id="${escapeHtml(meeting.id)}">Join meeting</button>` : ""}${["system_administrator", "meeting_organiser"].includes(state.user?.role) ? `<button class="button button-quiet create-election-button" type="button" data-meeting-id="${escapeHtml(meeting.id)}">＋ Election</button><button class="button button-quiet guest-link-button" type="button" data-meeting-id="${escapeHtml(meeting.id)}">Invite guest</button>` : ""}</div>
  </article>`;
}

function renderMeetings() {
  const empty = '<article class="empty-card"><span class="empty-icon">▦</span><h2>No meetings scheduled yet</h2><p>When an Elawini Estate meeting is scheduled, you will find its details here.</p></article>';
  const orderedMeetings = [...state.meetings].sort((left, right) => {
    const leftTime = Date.parse(left.starts_at);
    const rightTime = Date.parse(right.starts_at);
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
    if (!Number.isFinite(rightTime)) return -1;
    return leftTime - rightTime;
  });
  const now = Date.now();
  const upcoming = orderedMeetings.filter((meeting) => {
    const startsAt = Date.parse(meeting.starts_at);
    return !Number.isFinite(startsAt) || startsAt >= now;
  });
  const past = orderedMeetings.filter((meeting) => {
    const startsAt = Date.parse(meeting.starts_at);
    return Number.isFinite(startsAt) && startsAt < now;
  });
  const meetingsList = document.querySelector("#meetings-list");
  if (!orderedMeetings.length) {
    meetingsList.innerHTML = empty;
  } else {
    meetingsList.innerHTML = `<section class="meeting-group" aria-labelledby="upcoming-meetings-heading">
        <div class="meeting-group-heading"><h2 id="upcoming-meetings-heading">Upcoming meetings</h2><span class="meeting-group-count">${upcoming.length}</span></div>
        <div class="meeting-list">${upcoming.length ? upcoming.map(meetingCard).join("") : '<p class="meeting-group-empty">No upcoming meetings scheduled.</p>'}</div>
      </section>
      ${past.length ? `<details class="past-meeting-group">
        <summary><span>Past meetings</span><span class="meeting-group-count">${past.length}</span><span class="past-meeting-caret" aria-hidden="true"></span></summary>
        <div class="meeting-list">${past.map(meetingCard).join("")}</div>
      </details>` : ""}`;
  }
  const overviewEmpty = state.meetings.length
    ? '<article class="empty-card"><span class="empty-icon">▦</span><h2>No upcoming meetings</h2><p>Past meeting records are available in Meetings.</p></article>'
    : empty;
  document.querySelector("#overview-meetings").innerHTML = upcoming.length ? upcoming.slice(0, 3).map(meetingCard).join("") : overviewEmpty;
  document.querySelector("#meeting-count").textContent = upcoming.length;
  const next = upcoming[0];
  document.querySelector("#next-meeting-date").textContent = next ? formatDate(next.starts_at, { day: "numeric", month: "short" }) : "—";
  document.querySelector("#next-meeting-title").textContent = next?.title || "No upcoming meeting";
  const nextMeetingCard = document.querySelector("#next-meeting-card");
  nextMeetingCard.disabled = !next;
  if (next) {
    nextMeetingCard.dataset.meetingId = next.id;
    nextMeetingCard.setAttribute("aria-label", `View next meeting: ${next.title}, ${formatDate(next.starts_at, { dateStyle: "full", timeStyle: "short" })}`);
  } else {
    delete nextMeetingCard.dataset.meetingId;
    nextMeetingCard.setAttribute("aria-label", "No upcoming meeting scheduled");
  }
  const electionMeeting = document.querySelector("#election-meeting");
  electionMeeting.innerHTML = state.meetings.map((meeting) => `<option value="${escapeHtml(meeting.id)}">${escapeHtml(meeting.title)}</option>`).join("");
}

function renderMeetingDocuments(container, meetingId, documents, manager) {
  container.innerHTML = documents.length
    ? documents.map((item) => `<article class="meeting-document">
        <div><strong>${escapeHtml(item.file_name)}</strong><small>${(Number(item.size_bytes) / 1024 / 1024).toFixed(2)} MB · Added ${escapeHtml(formatDate(item.created_at, { dateStyle: "medium" }))}</small></div>
        <div class="meeting-document-actions">
          <button class="button button-quiet meeting-document-download" type="button" data-meeting-id="${escapeHtml(meetingId)}" data-document-id="${escapeHtml(item.id)}">Download</button>
          ${manager ? `<button class="button button-quiet meeting-document-delete" type="button" data-meeting-id="${escapeHtml(meetingId)}" data-document-id="${escapeHtml(item.id)}">Remove</button>` : ""}
        </div>
      </article>`).join("")
    : '<p class="muted">No documents have been shared for this meeting.</p>';
}

function renderDocuments() {
  const container = document.querySelector("#documents-list");
  const meetingsWithDocuments = state.meetings.filter((meeting) => meeting.documents?.length);
  if (!meetingsWithDocuments.length) {
    container.innerHTML = '<article class="empty-card"><span class="empty-icon">▤</span><h2>No meeting documents yet</h2><p>Documents shared for estate meetings will appear here.</p></article>';
    return;
  }
  container.innerHTML = meetingsWithDocuments.map((meeting) => `<section class="document-meeting">
    <h2>${escapeHtml(meeting.title)}</h2>
    <p class="muted">${escapeHtml(formatDate(meeting.starts_at, { dateStyle: "full", timeStyle: "short" }))}</p>
    <div class="meeting-document-list" data-document-list="${escapeHtml(meeting.id)}"></div>
  </section>`).join("");
  meetingsWithDocuments.forEach((meeting) => {
    const list = [...container.querySelectorAll("[data-document-list]")]
      .find((element) => element.dataset.documentList === meeting.id);
    renderMeetingDocuments(
      list,
      meeting.id,
      meeting.documents,
      ["system_administrator", "meeting_organiser"].includes(state.user?.role)
    );
  });
}

function renderReports() {
  const container = document.querySelector("#reports-list");
  container.innerHTML = state.meetings.length
    ? state.meetings.map((meeting) => `<article class="report-card">
        <div><h2>${escapeHtml(meeting.title)}</h2><p>${escapeHtml(formatDate(meeting.starts_at, { dateStyle: "full", timeStyle: "short" }))}</p></div>
        <button class="button button-primary meeting-report-download" type="button" data-meeting-id="${escapeHtml(meeting.id)}">Download meeting report</button>
      </article>`).join("")
    : '<article class="empty-card"><span class="empty-icon">▥</span><h2>No meeting reports yet</h2><p>Reports will be available for scheduled meetings.</p></article>';
}

function downloadBase64File(fileData) {
  const binary = atob(fileData.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: fileData.mimeType }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileData.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

async function downloadMeetingDocument(meetingId, documentId) {
  const fileData = await api(`/meetings/${encodeURIComponent(meetingId)}/documents/${encodeURIComponent(documentId)}`);
  downloadBase64File(fileData);
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("MeetVote could not read this file."));
    reader.readAsDataURL(file);
  });
}

function renderCandidateProfile(profile, index, selectable = false) {
  const name = String(profile.fullName || "Candidate");
  const photo = `<img class="candidate-profile-photo" src="${escapeHtml(profile.photoData || "/candidate-default.svg")}" alt="${escapeHtml(profile.photoData ? name : `Default candidate portrait for ${name}`)}" loading="lazy" decoding="async" />`;
  const tagName = selectable ? "label" : "article";
  const selection = selectable
    ? `<span class="candidate-vote-choice"><input type="radio" name="candidateIndex" value="${index}" required /><span>Select this candidate</span></span>`
    : "";
  return `<${tagName} class="candidate-profile-card">
    <div class="candidate-profile-image">${photo}</div>
    <div class="candidate-profile-content">
      <h4>${escapeHtml(name)}</h4>
      <p class="candidate-position">${escapeHtml(profile.position || "Position not provided")}</p>
      ${profile.biography ? `<p>${escapeHtml(profile.biography)}</p>` : ""}
      ${profile.experience ? `<p><strong>Experience:</strong> ${escapeHtml(profile.experience)}</p>` : ""}
      ${profile.statement ? `<blockquote>${escapeHtml(profile.statement)}</blockquote>` : ""}
    </div>
    ${selection}
  </${tagName}>`;
}

function candidateProfilesForCard(election, options) {
  const profiles = Array.isArray(election.candidateProfiles) ? election.candidateProfiles : [];
  return options.map((name, index) => ({
    ...(profiles[index] || {}),
    fullName: profiles[index]?.fullName || name
  }));
}

function refreshCandidateProfileOrder() {
  const rows = [...document.querySelectorAll("#candidate-profiles-list .candidate-editor-row")];
  rows.forEach((row, index) => {
    row.querySelector(".candidate-editor-order").textContent = `Candidate ${index + 1}`;
    row.querySelector("[data-candidate-move=up]").disabled = index === 0;
    row.querySelector("[data-candidate-move=down]").disabled = index === rows.length - 1;
    row.querySelector("[data-candidate-remove]").disabled = Boolean(editingElectionId) || rows.length <= 2;
  });
  document.querySelector("#add-candidate-button").disabled = Boolean(editingElectionId) || rows.length >= 50;
}

function addCandidateProfileRow(profile = {}) {
  const row = document.createElement("fieldset");
  const rowNumber = ++candidateProfileSequence;
  const name = String(profile.fullName || "");
  const photoData = typeof profile.photoData === "string" ? profile.photoData : null;
  row.className = "candidate-editor-row";
  row.dataset.candidateId = profile.candidateId || "";
  row.innerHTML = `<legend class="sr-only">${escapeHtml(name || `Candidate ${rowNumber}`)}</legend>
    <div class="candidate-editor-heading"><strong class="candidate-editor-order"></strong><div class="candidate-editor-reorder">
      <button class="button button-quiet" type="button" data-candidate-move="up" aria-label="Move candidate up">↑</button>
      <button class="button button-quiet" type="button" data-candidate-move="down" aria-label="Move candidate down">↓</button>
      <button class="button button-quiet candidate-remove-button" type="button" data-candidate-remove>Remove candidate</button>
    </div></div>
    <div class="candidate-editor-grid">
      <div class="candidate-photo-editor">
        <label for="candidate-photo-${rowNumber}">Profile photograph <span class="muted">(optional)</span></label>
        <input id="candidate-photo-${rowNumber}" type="file" accept="image/jpeg,image/png" data-candidate-photo />
        <div class="candidate-preview-frame">
          <img class="candidate-photo-preview" src="${escapeHtml(photoData || "/candidate-default.svg")}" alt="${photoData ? "Candidate photograph preview" : "Default candidate portrait preview"}" />
        </div>
        <button class="text-button candidate-remove-photo" type="button" data-remove-candidate-photo ${photoData ? "" : "hidden"}>Remove photograph</button>
        <small class="field-help candidate-photo-error" role="status"></small>
        <small class="field-help">Optional. The default portrait is used when no photo is available. JPG or PNG, up to 8 MB before optimization.</small>
      </div>
      <div class="candidate-editor-fields">
        <label for="candidate-name-${rowNumber}">Full name <span aria-hidden="true">*</span></label>
        <input id="candidate-name-${rowNumber}" data-candidate-full-name maxlength="160" value="${escapeHtml(name)}" ${editingElectionId ? "readonly" : ""} required />
        <label for="candidate-position-${rowNumber}">Position contested <span aria-hidden="true">*</span></label>
        <input id="candidate-position-${rowNumber}" data-candidate-position maxlength="160" value="${escapeHtml(profile.position || "")}" placeholder="Estate Chairperson" required />
        <label for="candidate-biography-${rowNumber}">Short biography <span aria-hidden="true">*</span></label>
        <textarea id="candidate-biography-${rowNumber}" data-candidate-biography maxlength="800" rows="3" required>${escapeHtml(profile.biography || "")}</textarea>
        <label for="candidate-experience-${rowNumber}">Relevant experience or qualifications <span aria-hidden="true">*</span></label>
        <textarea id="candidate-experience-${rowNumber}" data-candidate-experience maxlength="1200" rows="3" required>${escapeHtml(profile.experience || "")}</textarea>
        <label for="candidate-statement-${rowNumber}">Candidate statement or manifesto <span class="muted">(optional)</span></label>
        <textarea id="candidate-statement-${rowNumber}" data-candidate-statement maxlength="2000" rows="3">${escapeHtml(profile.statement || "")}</textarea>
      </div>
    </div>`;
  const list = document.querySelector("#candidate-profiles-list");
  list.append(row);
  candidatePhotoData.set(row, photoData);
  row.querySelector("[data-candidate-remove]").hidden = Boolean(editingElectionId);
  refreshCandidateProfileOrder();
  return row;
}

function resetElectionEditor() {
  editingElectionId = null;
  editingElectionMeetingId = null;
  const form = document.querySelector("#election-form");
  const details = document.querySelector("#election-details-fields");
  const profileField = document.querySelector("#candidate-profiles-field");
  form.reset();
  document.querySelector("#election-start").required = false;
  document.querySelector("#election-end").required = false;
  details.hidden = false;
  details.querySelectorAll("input, select, textarea").forEach((control) => { control.disabled = false; });
  profileField.hidden = true;
  profileField.querySelectorAll("input, textarea, button").forEach((control) => { control.disabled = true; });
  document.querySelector("#candidate-profiles-list").replaceChildren();
  document.querySelector("#candidate-edit-help").hidden = true;
  document.querySelector("#election-options").readOnly = false;
  document.querySelector("#election-template-tools").hidden = false;
  document.querySelector("#election-edit-help").hidden = true;
  document.querySelector("#election-template-name").value = "";
  document.querySelector("#election-template-select").value = "";
  document.querySelector("#apply-election-template").disabled = true;
  document.querySelector("#update-election-template").hidden = true;
  document.querySelector("#delete-election-template").hidden = true;
  document.querySelector("#election-template-notice").hidden = true;
  renderElectionTemplateOptions();
  const addCandidateButton = document.querySelector("#add-candidate-button");
  addCandidateButton.hidden = false;
  addCandidateButton.disabled = false;
  document.querySelector("#election-dialog-title").textContent = "Create a candidate election";
  const saveButton = document.querySelector("#save-election-button");
  saveButton.textContent = "Create election";
  delete saveButton.dataset.label;
  clearNotice(electionNotice);
}

function renderElectionTemplateOptions() {
  const select = document.querySelector("#election-template-select");
  const selected = select.value;
  select.innerHTML = `<option value="">Choose a template</option>${state.electionTemplates.map((template) =>
    `<option value="${escapeHtml(template.id)}">${escapeHtml(template.templateName)}</option>`).join("")}`;
  select.value = state.electionTemplates.some((template) => template.id === selected) ? selected : "";
  updateElectionTemplateSelection();
}

function updateElectionTemplateSelection() {
  const selectedId = document.querySelector("#election-template-select").value;
  const template = state.electionTemplates.find((item) => item.id === selectedId);
  document.querySelector("#apply-election-template").disabled = !template;
  document.querySelector("#update-election-template").hidden = !template;
  document.querySelector("#delete-election-template").hidden = !template;
  document.querySelector("#election-template-name").value = template?.templateName || "";
}

async function refreshElectionTemplates() {
  state.electionTemplates = await api("/election-templates");
  renderElectionTemplateOptions();
}

function openElectionEditor(electionId) {
  const meeting = state.meetings.find((item) => (item.elections || []).some((election) => election.id === electionId));
  const election = meeting?.elections.find((item) => item.id === electionId);
  if (!election || election.status !== "draft") {
    showNotice(appNotice, "Only draft elections can be edited.");
    return;
  }
  resetElectionEditor();
  editingElectionId = electionId;
  editingElectionMeetingId = meeting.id;
  document.querySelector("#election-dialog-title").textContent = `Edit draft · ${election.title}`;
  document.querySelector("#save-election-button").textContent = "Save draft changes";
  document.querySelector("#election-meeting").value = meeting.id;
  document.querySelector("#election-meeting").disabled = true;
  const typeSelect = document.querySelector("#election-type");
  typeSelect.value = election.voting_type;
  typeSelect.dispatchEvent(new Event("change"));
  typeSelect.disabled = true;
  document.querySelector("#election-title").value = election.title;
  const toLocalInput = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  };
  document.querySelector("#election-start").value = toLocalInput(election.starts_at);
  document.querySelector("#election-end").value = toLocalInput(election.ends_at);
  document.querySelector("#election-start").required = true;
  document.querySelector("#election-end").required = true;
  document.querySelector("#election-template-tools").hidden = true;
  document.querySelector("#election-edit-help").hidden = false;
  const options = election.options || election.candidates || [];
  if (election.voting_type === "multiple_choice") {
    document.querySelector("#election-options").value = options.join("\n");
    document.querySelector("#election-options").readOnly = true;
  }
  const profileField = document.querySelector("#candidate-profiles-field");
  if (election.voting_type === "candidate") {
    profileField.hidden = false;
    document.querySelector("#candidate-edit-help").hidden = false;
    profileField.querySelectorAll("input, textarea, button").forEach((control) => { control.disabled = false; });
    document.querySelector("#add-candidate-button").hidden = true;
    candidateProfilesForCard(election, options).forEach(addCandidateProfileRow);
  }
  clearNotice(electionNotice);
  electionDialog.showModal();
}

async function prepareCandidatePhoto(file) {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a JPG or PNG photograph.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose a photograph smaller than 8 MB.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const loaded = new Image();
      loaded.onload = () => resolve(loaded);
      loaded.onerror = () => reject(new Error("This photograph could not be opened."));
      loaded.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight ||
        image.naturalWidth > 8192 || image.naturalHeight > 8192 ||
        image.naturalWidth * image.naturalHeight > 33_554_432) {
      throw new Error("Choose a valid photograph no larger than 8,192 × 8,192 pixels.");
    }
    const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("MeetVote could not prepare this photograph.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.84;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 1_400_000 && quality > 0.48) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > 1_400_000) throw new Error("This photograph could not be reduced below the 1 MB storage limit.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function collectCandidateProfiles() {
  const rows = [...document.querySelectorAll("#candidate-profiles-list .candidate-editor-row")];
  await Promise.all(rows.map((row) => row.photoTask).filter(Boolean));
  if (rows.some((row) => row.dataset.photoError === "true")) {
    throw new Error("Fix the candidate photograph upload before saving.");
  }
  return rows.map((row) => ({
    ...(row.dataset.candidateId ? { candidateId: row.dataset.candidateId } : {}),
    fullName: row.querySelector("[data-candidate-full-name]").value.trim(),
    position: row.querySelector("[data-candidate-position]").value.trim(),
    biography: row.querySelector("[data-candidate-biography]").value.trim(),
    experience: row.querySelector("[data-candidate-experience]").value.trim(),
    statement: row.querySelector("[data-candidate-statement]").value.trim(),
    photoData: candidatePhotoData.get(row) || null
  }));
}

function removeCandidatePhoto(row) {
  const input = row.querySelector("[data-candidate-photo]");
  const image = row.querySelector(".candidate-photo-preview");
  candidatePhotoData.set(row, null);
  row.dataset.photoError = "false";
  row.dataset.photoRequest = String(Number(row.dataset.photoRequest || 0) + 1);
  row.photoTask = null;
  input.value = "";
  image.src = "/candidate-default.svg";
  image.alt = "Default candidate portrait preview";
  image.hidden = false;
  row.querySelector("[data-remove-candidate-photo]").hidden = true;
  row.querySelector(".candidate-photo-error").textContent = "";
}

function updateCandidatePhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  const row = input.closest(".candidate-editor-row");
  const image = row.querySelector(".candidate-photo-preview");
  const error = row.querySelector(".candidate-photo-error");
  const requestId = Number(row.dataset.photoRequest || 0) + 1;
  row.dataset.photoRequest = String(requestId);
  row.dataset.photoError = "false";
  error.textContent = "";
  row.photoTask = prepareCandidatePhoto(file).then((photoData) => {
    if (row.dataset.photoRequest !== String(requestId)) return;
    candidatePhotoData.set(row, photoData);
    image.src = photoData;
    image.alt = "Candidate photograph preview";
    row.querySelector("[data-remove-candidate-photo]").hidden = false;
  }).catch((photoError) => {
    if (row.dataset.photoRequest !== String(requestId)) return;
    row.dataset.photoError = "true";
    error.textContent = photoError.message;
    showNotice(electionNotice, photoError.message);
  });
}

function electionCard(election, meetingId, meetingTitle) {
  const status = election.status || "draft";
  const date = formatDate(election.starts_at, { day: "numeric", month: "short", year: "numeric" });
  const options = Array.isArray(election.options) && election.options.length
    ? election.options
    : Array.isArray(election.candidates) ? election.candidates : [];
  const isCandidateElection = election.voting_type === "candidate";
  const candidateProfiles = isCandidateElection ? candidateProfilesForCard(election, options) : [];
  const candidates = options.join(", ");
  const isManager = ["system_administrator", "meeting_organiser"].includes(state.user?.role);
  const now = Date.now();
  const canOpen = status === "draft" && Date.parse(election.starts_at) <= now && Date.parse(election.ends_at) > now;
  const electionActions = isManager
    ? `<div class="election-actions">${status === "draft" ? `<button class="button button-quiet edit-election-button" type="button" data-election-id="${escapeHtml(election.id)}">Edit draft</button><button class="button button-quiet voter-management-button" type="button" data-election-id="${escapeHtml(election.id)}">Manage voters</button><button class="button button-primary election-status-button" type="button" data-election-id="${escapeHtml(election.id)}" data-election-status-action="open" ${canOpen ? "" : "disabled"}>Open election</button>` : ""}${status === "open" ? `<button class="button button-quiet election-status-button" type="button" data-election-id="${escapeHtml(election.id)}" data-election-status-action="closed">Close election</button>` : ""}</div>`
    : "";
  const canVote = state.user?.role === "registered_participant" && status === "open" &&
    election.is_eligible && election.is_active_in_live_meeting !== false;
  const ballot = canVote
    ? election.has_voted
      ? '<p class="ballot-receipt" role="status">Your ballot has been recorded.</p>'
      : `<form class="ballot-form" data-election-id="${escapeHtml(election.id)}" novalidate><fieldset><legend>${isCandidateElection ? "Review each profile, then select one candidate" : "Select one choice"}</legend>${isCandidateElection
        ? `<div class="candidate-profile-grid">${candidateProfiles.map((profile, index) => renderCandidateProfile(profile, index, true)).join("")}</div>`
        : options.map((candidate, index) => `<label class="ballot-option"><input type="radio" name="candidateIndex" value="${index}" required /><span>${escapeHtml(candidate)}</span></label>`).join("")}</fieldset><button class="button button-primary" type="submit">Submit confidential ballot</button></form>`
    : "";
  const candidateCards = isCandidateElection && ["draft", "open"].includes(status) && !(canVote && !election.has_voted)
    ? `<details class="candidate-profile-details"><summary>View candidate profiles (${candidateProfiles.length})</summary><div class="candidate-profile-grid">${candidateProfiles.map((profile, index) => renderCandidateProfile(profile, index)).join("")}</div></details>`
    : "";
  const candidateSummary = isCandidateElection && status === "draft"
    ? `<p class="candidate-count">${options.length} ${options.length === 1 ? "candidate" : "candidates"}</p>`
    : "";
  const scheduleNote = isManager && status === "draft" && !canOpen
    ? `<p class="field-help">Voting opens ${escapeHtml(formatDate(election.starts_at, { dateStyle: "medium", timeStyle: "short" }))}.</p>`
    : "";
  const countdown = status === "open"
    ? `<p class="election-countdown" data-election-countdown data-meeting-id="${escapeHtml(meetingId)}" data-ends-at="${escapeHtml(election.ends_at)}"><span>Time remaining</span><strong data-countdown-value></strong></p>`
    : "";
  const liveNote = status === "open" && election.is_active_in_live_meeting === false
    ? '<p class="field-help">This vote is announced in the live meeting.</p>'
    : "";
  const unavailableResultsNote = isManager && status === "closed" && !election.has_results
    ? '<p class="field-help">Voting is closed, but the secure voting service did not return results.</p>'
    : "";
  return `<article class="election-card" data-election="${escapeHtml(election.id)}">
    <div class="election-card-content">
      <div><span class="status-label ${escapeHtml(status)}">${escapeHtml(status[0].toUpperCase() + status.slice(1))}</span></div>
      <div><h3>${escapeHtml(election.title)}</h3><p>${escapeHtml(meetingTitle)} · Starts ${escapeHtml(date)}${election.secret_ballot ? " · Secret ballot" : ""}</p>${candidates && !isCandidateElection ? `<p>Choices: ${escapeHtml(candidates)}</p>` : ""}${candidateSummary}${scheduleNote}${countdown}${liveNote}${unavailableResultsNote}</div>
      <p class="eligibility-result" aria-live="polite"></p>
    </div>
    ${candidateCards}
    ${ballot}
    <div class="election-card-actions">${electionActions}${status !== "closed" ? `<button class="button button-quiet eligibility-button" type="button" data-election-id="${escapeHtml(election.id)}">Check eligibility</button>` : ""}</div>
  </article>`;
}

function bindBallotForms(root) {
  root.querySelectorAll(".ballot-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const liveRoomForm = Boolean(form.closest("#live-voting-panel"));
      const notice = liveRoomForm
        ? document.querySelector("#live-ballot-notice")
        : appNotice;
      if (!form.checkValidity()) {
        form.reportValidity();
        showNotice(notice, "Select an option before submitting your ballot.");
        return;
      }
      const electionId = form.dataset.electionId;
      if (submittingBallotIds.has(electionId) || (liveRoomForm && state.liveBallotSubmitting)) return;
      submittingBallotIds.add(electionId);
      clearNotice(notice);
      setBusy(button, true, "Submitting…");
      if (liveRoomForm) state.liveBallotSubmitting = true;
      let submitted = false;
      try {
        await api(`/elections/${encodeURIComponent(electionId)}/ballot`, {
          method: "POST",
          body: { candidateIndex: Number(new FormData(form).get("candidateIndex")) }
        });
        submitted = true;
      } catch (error) {
        showNotice(notice, error.message);
      } finally {
        if (liveRoomForm) state.liveBallotSubmitting = false;
        setBusy(button, false);
        submittingBallotIds.delete(electionId);
      }
      if (!submitted) return;
      await refreshData();
      if (state.liveMeetingId) await refreshLiveRoom();
      showNotice(notice, "Your confidential ballot has been recorded.", "success");
    });
  });
}

async function renderResults() {
  const list = document.querySelector("#results-list");
  const published = state.meetings.flatMap((meeting) =>
    (meeting.elections || [])
      .filter((election) => election.has_results)
      .map((election) => ({
        ...election,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        meetingStartsAt: meeting.starts_at
      })));
  if (!published.length) {
    list.innerHTML = '<article class="empty-card results-empty"><span class="empty-icon">▥</span><h2>No published results yet</h2><p>Completed election results will appear here after voting closes.</p></article>';
    return;
  }
  list.innerHTML = '<p class="muted">Loading published results…</p>';
  try {
    const resultEntries = await Promise.all(published.map(async (election) => ({
      election,
      result: await api(`/elections/${encodeURIComponent(election.id)}/results`)
    })));
    const formatCount = (value) => new Intl.NumberFormat("en-ZA").format(value);
    const safeCount = (value) => {
      const count = Number(value);
      return Number.isSafeInteger(count) && count >= 0 ? count : 0;
    };
    const renderedResults = resultEntries.map(({ election, result }) => {
      const profiles = Array.isArray(election.candidateProfiles) ? election.candidateProfiles : [];
      const candidates = (Array.isArray(result.candidates) ? result.candidates : [])
        .map((candidate, index) => {
          const name = String(candidate?.name || "Unnamed option");
          const indexedProfile = profiles[index];
          const profile = indexedProfile?.fullName === name
            ? indexedProfile
            : profiles.find((item) => item?.fullName === name) || null;
          return {
            name,
            votes: safeCount(candidate?.votes),
            profile
          };
        })
        .sort((left, right) => right.votes - left.votes);
      const votesCast = safeCount(result.votesCast);
      const eligibleVoters = safeCount(result.eligibleVoters);
      const validVotes = candidates.reduce((total, candidate) => total + candidate.votes, 0);
      const leaders = candidates.filter((candidate) => candidate.votes > 0 && candidate.votes === candidates[0]?.votes);
      const winner = election.voting_type === "candidate" && leaders.length === 1 ? leaders[0] : null;
      const leaderName = leaders.length > 1 ? "Tie" : leaders[0]?.name || "No votes";
      const leaderDetail = leaders.length > 1
        ? leaders.map((candidate) => candidate.name).join(", ")
        : leaders.length === 1 ? `${formatCount(leaders[0].votes)} votes` : "No valid votes recorded";
      const moiOutcome = result.moiOutcome || null;
      const outcomeDetail = moiOutcome?.resolutionType
        ? `${moiOutcome.passed ? "Resolution passed" : "Resolution defeated"} · ${moiOutcome.resolutionType === "special" ? "75% special resolution" : "50%+1 ordinary resolution"} · ${formatCount(moiOutcome.forVotes)} For · ${formatCount(moiOutcome.againstVotes)} Against · ${formatCount(moiOutcome.abstainVotes)} Abstain excluded`
        : moiOutcome?.tieDefeat
          ? "Election tied; the motion or candidacy is defeated"
          : moiOutcome?.winner
            ? `Winner: ${moiOutcome.winner}`
            : "";
      const turnout = eligibleVoters > 0 ? `${((votesCast / eligibleVoters) * 100).toFixed(1)}%` : "N/A";
      const summaryValue = winner
        ? winner.name
        : election.voting_type === "candidate"
          ? leaders.length > 1 ? `Tie · ${leaders.map((candidate) => candidate.name).join(", ")}` : "No valid votes"
          : moiOutcome?.resolutionType
            ? moiOutcome.passed ? "Resolution passed" : "Resolution defeated"
            : leaders.length > 1 ? `Tie · ${leaders.map((candidate) => candidate.name).join(", ")}`
              : leaders[0]?.name || "No votes";
      const summaryMarkup = `<div class="meeting-result-outcome">
        <span>${escapeHtml(election.title)}</span>
        <strong>${escapeHtml(summaryValue)}</strong>
      </div>`;
      const optionColors = ["#6c4ee3", "#e08a2e", "#22a899", "#d34ca9", "#75a827", "#4b8fd8", "#dc5c5c", "#8d66bb"];
      const optionColorClass = (index) => `result-color-${index % optionColors.length}`;
      let votesThroughSlice = 0;
      const pieSlices = candidates.flatMap((candidate, index) => {
        if (!candidate.votes || !validVotes) return [];
        const startAngle = (votesThroughSlice / validVotes) * 2 * Math.PI - Math.PI / 2;
        votesThroughSlice += candidate.votes;
        const endAngle = (votesThroughSlice / validVotes) * 2 * Math.PI - Math.PI / 2;
        const color = optionColors[index % optionColors.length];
        if (candidate.votes === validVotes) {
          return [`<circle cx="50" cy="50" r="48" fill="${color}"></circle>`];
        }
        const startX = 50 + 48 * Math.cos(startAngle);
        const startY = 50 + 48 * Math.sin(startAngle);
        const endX = 50 + 48 * Math.cos(endAngle);
        const endY = 50 + 48 * Math.sin(endAngle);
        const largeArc = candidate.votes / validVotes > 0.5 ? 1 : 0;
        return [`<path d="M 50 50 L ${startX.toFixed(3)} ${startY.toFixed(3)} A 48 48 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z" fill="${color}" stroke="white" stroke-width="0.5"></path>`];
      });
      const chartDescription = validVotes
        ? candidates.filter((candidate) => candidate.votes > 0)
          .map((candidate) => `${candidate.name}: ${formatCount(candidate.votes)} votes, ${(candidate.votes / validVotes * 100).toFixed(1)}%`)
          .join(". ")
        : "No valid votes recorded.";
      const pieGraphic = `<svg class="result-pie" viewBox="0 0 100 100" role="img" aria-label="${escapeHtml(`Vote distribution. ${chartDescription}`)}">${pieSlices.join("") || '<circle cx="50" cy="50" r="48" fill="#e9ebf5"></circle>'}</svg>`;

      const winnerPanel = winner
        ? `<div class="result-winner">
            <img src="${escapeHtml(winner.profile?.photoData || "/candidate-default.svg")}" alt="${escapeHtml(`Portrait of ${winner.name}`)}" loading="lazy" decoding="async" />
            <div><small>Winner</small><strong>${escapeHtml(winner.name)}</strong>
              <span>${formatCount(winner.votes)} votes · ${validVotes ? `${((winner.votes / validVotes) * 100).toFixed(1)}%` : "0.0%"}</span>
              ${winner.profile?.position ? `<span class="result-winner-position">${escapeHtml(winner.profile.position)}</span>` : ""}
            </div>
          </div>`
        : `<div class="result-leading"><span class="result-leading-icon" aria-hidden="true">★</span><div><small>${election.voting_type === "candidate" ? "Election outcome" : "Leading choice"}</small><strong>${escapeHtml(leaderName)}</strong></div><span class="result-leading-detail">${escapeHtml(leaderDetail)}</span></div>`;
      const card = `<article class="election-card result-card">
        <div class="election-card-content">
          <span class="status-label closed">Results published</span>
          <div class="result-heading"><h2>${escapeHtml(election.title)}</h2><p>Published ${escapeHtml(formatDate(result.publishedAt, { dateStyle: "medium", timeStyle: "short" }))}</p></div>
        </div>
        <div class="result-summary" aria-label="Election summary">
          <div class="result-metric"><span>Ballots cast</span><strong>${formatCount(votesCast)}</strong></div>
          <div class="result-metric"><span>Eligible residents</span><strong>${formatCount(eligibleVoters)}</strong></div>
          <div class="result-metric"><span>Turnout</span><strong>${turnout}</strong></div>
          <div class="result-metric"><span>Valid votes</span><strong>${formatCount(validVotes)}</strong></div>
        </div>
        ${outcomeDetail ? `<div class="result-leading"><span class="result-leading-icon" aria-hidden="true">⚖</span><div><small>MOI outcome</small><strong>${escapeHtml(outcomeDetail)}</strong></div></div>` : ""}
        ${winnerPanel}
        <div class="result-chart-layout">
          <div class="result-options" role="list" aria-label="Votes by candidate or option">
          ${candidates.map((candidate, index) => {
            const percentage = validVotes > 0 ? (candidate.votes / validVotes) * 100 : 0;
            const colorClass = optionColorClass(index);
            return `<div class="result-option" role="listitem">
              <div class="result-option-heading"><span class="result-option-name"><span class="result-option-swatch ${colorClass}" aria-hidden="true"></span><span>${escapeHtml(candidate.name)}</span></span><strong>${formatCount(candidate.votes)} <small>(${percentage.toFixed(1)}%)</small></strong></div>
              <progress class="result-progress ${colorClass}" aria-label="${escapeHtml(candidate.name)} votes" value="${candidate.votes}" max="${validVotes || 1}">${percentage.toFixed(1)}%</progress>
            </div>`;
          }).join("") || '<p class="muted">No vote breakdown is available.</p>'}
          </div>
          <aside class="result-chart-panel" aria-label="Vote distribution">
            <figure class="result-pie-figure">
              ${pieGraphic}
              <figcaption><span>Vote distribution</span><strong>${validVotes ? `${formatCount(validVotes)} valid ${validVotes === 1 ? "vote" : "votes"}` : "No valid votes"}</strong></figcaption>
            </figure>
          </aside>
        </div>
      </article>`;
      return { election, card, summaryMarkup };
    });

    const meetingGroups = new Map();
    for (const item of renderedResults) {
      const key = item.election.meetingId;
      if (!meetingGroups.has(key)) {
        meetingGroups.set(key, {
          title: item.election.meetingTitle,
          startsAt: item.election.meetingStartsAt,
          results: []
        });
      }
      meetingGroups.get(key).results.push(item);
    }

    const orderedGroups = [...meetingGroups.values()].sort((left, right) => {
      const leftTime = Date.parse(left.startsAt);
      const rightTime = Date.parse(right.startsAt);
      if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
      if (!Number.isFinite(rightTime)) return -1;
      return rightTime - leftTime;
    });
    list.innerHTML = orderedGroups.map((group, index) => {
      const headingId = `meeting-results-heading-${index}`;
      const meetingDate = Number.isFinite(Date.parse(group.startsAt))
        ? formatDate(group.startsAt, { dateStyle: "full", timeStyle: "short" })
        : "Meeting date unavailable";
      const count = group.results.length;
      return `<section class="meeting-results-group" aria-labelledby="${headingId}">
        <header class="meeting-results-heading">
          <div><p class="eyebrow">MEETING RESULTS</p><h2 id="${headingId}">${escapeHtml(group.title || "Meeting")}</h2><p>${escapeHtml(meetingDate)}</p></div>
          <span class="meeting-group-count">${count} ${count === 1 ? "result" : "results"}</span>
        </header>
        <section class="meeting-results-summary" aria-label="Meeting outcomes">
          <h3>Outcome summary</h3>
          <div class="meeting-results-summary-grid">${group.results.map((item) => item.summaryMarkup).join("")}</div>
        </section>
        <div class="meeting-result-cards">${group.results.map((item) => item.card).join("")}</div>
      </section>`;
    }).join("");
  } catch (error) {
    list.innerHTML = '<article class="empty-card"><h2>Results could not be loaded</h2><p>Try refreshing the page or contact an administrator.</p></article>';
    showNotice(appNotice, error.message);
  }
}

function renderElections() {
  const elections = state.meetings.flatMap((meeting) => (meeting.elections || []).map((election) => ({
    ...election,
    meetingId: meeting.id,
    meetingTitle: meeting.title
  })));
  document.querySelector("#open-vote-count").textContent = elections.filter((election) => election.status === "open").length;
  const list = document.querySelector("#elections-list");
  if (!elections.length) {
    list.innerHTML = '<article class="empty-card"><span class="empty-icon">✓</span><h2>No voting decisions yet</h2><p>Active community votes will appear here when an election is scheduled.</p></article>';
    const overviewList = document.querySelector("#overview-elections");
    if (overviewList) overviewList.innerHTML = '<article class="empty-card compact-empty"><h2>No upcoming elections</h2><p>Scheduled community elections will appear here.</p></article>';
    return;
  }
  const byStartTime = (left, right) => {
    const leftTime = Date.parse(left.starts_at);
    const rightTime = Date.parse(right.starts_at);
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
    if (!Number.isFinite(rightTime)) return -1;
    return leftTime - rightTime;
  };
  const open = elections.filter((election) => election.status === "open");
  const scheduled = elections.filter((election) => election.status === "draft").sort(byStartTime);
  const past = elections.filter((election) => election.status === "closed").sort((left, right) => byStartTime(right, left));
  const cardList = (items) => items.map((election) =>
    electionCard(election, election.meetingId, election.meetingTitle)).join("");
  list.innerHTML = `<section class="election-group" aria-labelledby="open-elections-heading">
      <div class="meeting-group-heading"><h2 id="open-elections-heading">Voting now</h2><span class="meeting-group-count">${open.length}</span></div>
      <div class="election-list">${open.length ? cardList(open) : '<p class="meeting-group-empty">No elections are open for voting right now.</p>'}</div>
    </section>
    <section class="election-group" aria-labelledby="scheduled-elections-heading">
      <div class="meeting-group-heading"><h2 id="scheduled-elections-heading">Scheduled and draft</h2><span class="meeting-group-count">${scheduled.length}</span></div>
      <div class="election-list">${scheduled.length ? cardList(scheduled) : '<p class="meeting-group-empty">No scheduled elections.</p>'}</div>
    </section>
    ${past.length ? `<details class="past-election-group">
      <summary><span>Past elections</span><span class="meeting-group-count">${past.length}</span><span class="past-meeting-caret" aria-hidden="true"></span></summary>
      <div class="election-list">${cardList(past)}</div>
    </details>` : ""}`;
  bindBallotForms(list);
  list.querySelectorAll(".eligibility-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest(".election-card");
      const result = card.querySelector(".eligibility-result");
      setBusy(button, true, "Checking…");
      try {
        const eligibility = await api(`/elections/${encodeURIComponent(button.dataset.electionId)}/voting-authorisation`);
        result.classList.toggle("denied", !eligibility.allowed);
        result.textContent = eligibility.allowed
          ? "You are eligible. Your ballot is available while voting is open."
          : eligibility.reason || "You are not authorised to vote in this election.";
      } catch (error) {
        showNotice(appNotice, error.message);
      } finally {
        setBusy(button, false);
      }
    });
  });
  const overviewList = document.querySelector("#overview-elections");
  if (overviewList) {
    const now = Date.now();
    const upcoming = elections.filter((election) => {
      if (election.status === "open") return true;
      if (election.status !== "draft") return false;
      const startsAt = Date.parse(election.starts_at);
      const endsAt = Date.parse(election.ends_at);
      return (Number.isFinite(startsAt) && startsAt >= now) ||
        (Number.isFinite(endsAt) && endsAt > now);
    }).sort((left, right) => {
      if (left.status !== right.status) return left.status === "open" ? -1 : 1;
      const leftTime = Date.parse(left.status === "open" ? left.ends_at : left.starts_at);
      const rightTime = Date.parse(right.status === "open" ? right.ends_at : right.starts_at);
      if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
      if (!Number.isFinite(rightTime)) return -1;
      return leftTime - rightTime;
    }).slice(0, 2);
    overviewList.innerHTML = upcoming.length
      ? upcoming.map((election) => electionCard(election, election.meetingId, election.meetingTitle)).join("")
      : `<article class="empty-card compact-empty"><h2>No upcoming elections</h2><p>${["system_administrator", "meeting_organiser"].includes(state.user?.role)
        ? "Drafts and past elections remain available on the Elections page."
        : "New community votes will appear here when they are open or scheduled."}</p></article>`;
    bindBallotForms(overviewList);
    overviewList.querySelectorAll(".eligibility-button").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest(".election-card");
        const result = card.querySelector(".eligibility-result");
        setBusy(button, true, "Checking…");
        try {
          const eligibility = await api(`/elections/${encodeURIComponent(button.dataset.electionId)}/voting-authorisation`);
          result.classList.toggle("denied", !eligibility.allowed);
          result.textContent = eligibility.allowed
            ? "You are eligible. Your ballot is available while voting is open."
            : eligibility.reason || "You are not authorised to vote in this election.";
        } catch (error) {
          showNotice(appNotice, error.message);
        } finally {
          setBusy(button, false);
        }
      });
    });
  }
  updateElectionCountdowns();
}

async function openVoterDialog(electionId) {
  clearNotice(voterNotice);
  voterDialog.dataset.electionId = electionId;
  const election = state.meetings.flatMap((meeting) => meeting.elections || []).find((item) => item.id === electionId);
  document.querySelector("#voter-dialog-title").textContent = `Eligible voters · ${election?.title || "Election"}`;
  document.querySelector("#voter-list").innerHTML = '<p class="muted">Loading resident list…</p>';
  voterDialog.showModal();
  try {
    const residents = await api(`/elections/${encodeURIComponent(electionId)}/eligibility`);
    document.querySelector("#voter-list").innerHTML = residents.length
      ? residents.map((resident) => `<label class="checkbox-label voter-option"><input type="checkbox" name="voterId" value="${escapeHtml(resident.id)}" ${resident.votes_allowed > 0 ? "checked" : ""} /><span><strong>${escapeHtml(resident.display_name)}</strong><small>${escapeHtml(resident.email)}</small></span></label>`).join("")
      : '<p class="muted">No registered residents are available. Create resident accounts before assigning voters.</p>';
  } catch (error) {
    showNotice(voterNotice, error.message);
    document.querySelector("#voter-list").replaceChildren();
  }
}

function renderAgenda(result) {
  const items = result.items || [];
  const meetingId = agendaDialog.dataset.meetingId;
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const canManage = !document.querySelector("#agenda-management").hidden;
  const elections = meeting?.elections || [];
  const renderMotion = (motion) => `<article class="motion-card">
    <h4>${escapeHtml(motion.title)}</h4><p>${escapeHtml(motion.text)}</p>
    <small>Proposed by ${escapeHtml(motion.proposer_name)}</small>
  </article>`;
  const agendaList = document.querySelector("#agenda-items-list");
  agendaList.innerHTML = items.length
    ? items.map((item) => {
      const itemStatus = ["pending", "in_progress", "completed"].includes(item.status) ? item.status : "pending";
      const itemElections = elections.filter((election) => election.agenda_item_id === item.id);
      const statusControls = canManage
        ? `<div class="agenda-item-controls">
            <label for="agenda-status-${escapeHtml(item.id)}">Status</label>
            <select id="agenda-status-${escapeHtml(item.id)}" data-agenda-status>
              <option value="pending" ${itemStatus === "pending" ? "selected" : ""}>Pending</option>
              <option value="in_progress" ${itemStatus === "in_progress" ? "selected" : ""}>In progress</option>
              <option value="completed" ${itemStatus === "completed" ? "selected" : ""}>Completed</option>
            </select>
            <button class="button button-quiet agenda-status-save-button" type="button" data-agenda-item-id="${escapeHtml(item.id)}">Save status</button>
            <button class="button button-primary agenda-create-vote-button" type="button" data-meeting-id="${escapeHtml(meetingId)}" data-agenda-item-id="${escapeHtml(item.id)}">＋ Create voting item</button>
          </div>`
        : `<span class="status-label agenda-item-status ${itemStatus}">${itemStatus === "in_progress" ? "In progress" : itemStatus === "completed" ? "Completed" : "Pending"}</span>`;
      const linkedElections = itemElections.map((election) => {
        const canStart = election.status === "draft" &&
          Date.parse(election.starts_at) <= Date.now() &&
          Date.parse(election.ends_at) > Date.now() &&
          Number(election.eligible_voters) > 0;
        const startAction = canManage && election.status === "draft"
          ? `<button class="button button-primary agenda-start-voting-button" type="button" data-meeting-id="${escapeHtml(meetingId)}" data-election-id="${escapeHtml(election.id)}" data-agenda-item-id="${escapeHtml(item.id)}" ${canStart ? "" : "disabled"}>Start voting</button>`
          : "";
        return `<div class="agenda-linked-election"><span class="status-label ${escapeHtml(election.status)}">${escapeHtml(election.status)}</span><strong>${escapeHtml(election.title)}</strong>${startAction}</div>`;
      }).join("");
      return `<section class="agenda-item">
        <div class="agenda-item-heading"><span class="agenda-number">${escapeHtml(item.position)}</span><h3>${escapeHtml(item.title)}</h3></div>
        ${statusControls}
        ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
        ${linkedElections}
        ${item.motions.length ? item.motions.map(renderMotion).join("") : ""}
      </section>`;
    }).join("")
    : '<p class="agenda-empty">No agenda items have been added to this meeting.</p>';
  const unlinkedMotions = result.motions || [];
  if (unlinkedMotions.length) {
    agendaList.insertAdjacentHTML("beforeend", `<section class="agenda-item"><h3>Other motions</h3>${unlinkedMotions.map(renderMotion).join("")}</section>`);
  }
  const agendaSelect = document.querySelector("#motion-agenda-item");
  agendaSelect.innerHTML = `<option value="">Not linked to an agenda item</option>${items.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.position)}. ${escapeHtml(item.title)}</option>`).join("")}`;
}

function renderProxyAppointments(meetingId) {
  const options = state.proxyOptions || { units: [], accounts: [] };
  const unitSelect = document.querySelector("#proxy-unit-select");
  unitSelect.innerHTML = `<option value="">Select a Unit/Erf</option>${options.units.map((unit) =>
    `<option value="${escapeHtml(unit.id)}">${escapeHtml(unit.unitNumber)} · ${unit.members.map((member) => escapeHtml(member.fullName)).join(", ")}</option>`).join("")}`;
  document.querySelector("#proxy-account-select").innerHTML =
    `<option value="">Select a registered proxy</option>${options.accounts.map((account) =>
      `<option value="${escapeHtml(account.id)}">${escapeHtml(account.display_name)} · ${escapeHtml(account.email)}</option>`).join("")}`;
  const container = document.querySelector("#proxy-appointments-list");
  if (!state.proxyAppointments.length) {
    container.innerHTML = '<p class="muted">No proxy appointments have been submitted for this meeting.</p>';
    return;
  }
  container.innerHTML = state.proxyAppointments.map((proxy) => {
    const requiredTypes = [
      { type: "instrument", label: "Signed proxy instrument" },
      ...proxy.members.map((member) => ({ type: `member_id_${member.id}`, label: `${member.fullName} · ID document` })),
      ...proxy.members.filter((member) => member.isEntity)
        .map((member) => ({ type: `entity_resolution_${member.id}`, label: `${member.fullName} · entity authorization` }))
    ];
    const existingTypes = new Map(proxy.documents.map((document) => [document.document_type, document]));
    const documents = requiredTypes.map(({ type, label }) => {
      const current = existingTypes.get(type);
      return `<div class="proxy-document-row"><div><strong>${escapeHtml(label)}</strong>${current
        ? `<small>${escapeHtml(current.file_name)} · ${(Number(current.size_bytes) / 1024 / 1024).toFixed(2)} MB</small>`
        : '<small>Required before verification</small>'}</div>
        <div class="meeting-document-actions">${current
        ? `<button class="button button-quiet proxy-document-download" type="button" data-proxy-id="${escapeHtml(proxy.id)}" data-document-type="${escapeHtml(type)}">Download</button>`
        : ""}
        ${proxy.status === "pending" ? `<input class="proxy-document-upload" type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" data-proxy-id="${escapeHtml(proxy.id)}" data-document-type="${escapeHtml(type)}" aria-label="Upload ${escapeHtml(label)}" />` : ""}</div></div>`;
    }).join("");
    return `<article class="proxy-appointment-card">
      <div class="proxy-appointment-heading"><div><h4>Unit/Erf ${escapeHtml(proxy.unitNumber)}</h4><p>${proxy.members.map((member) => escapeHtml(member.fullName)).join(", ")} appoint ${escapeHtml(proxy.proxyName)} (${escapeHtml(proxy.proxyEmail)})</p></div>
      <span class="status-label ${escapeHtml(proxy.status)}">${escapeHtml(proxy.status)}</span></div>
      ${documents}
      ${proxy.status === "pending" ? `<div class="hoa-record-actions"><button class="button button-primary proxy-verify-button" type="button" data-proxy-id="${escapeHtml(proxy.id)}" data-proxy-status="verified">Verify appointment</button><button class="button button-quiet proxy-verify-button" type="button" data-proxy-id="${escapeHtml(proxy.id)}" data-proxy-status="rejected">Reject</button></div>` : `<small class="muted">${proxy.verifiedByName ? `${escapeHtml(proxy.status)} by ${escapeHtml(proxy.verifiedByName)}` : ""}</small>`}
    </article>`;
  }).join("");
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const beforeMeeting = meeting && Date.parse(meeting.starts_at) > Date.now();
  document.querySelector("#proxy-appointment-form").hidden = !beforeMeeting;
}

async function loadMeetingProxies(meetingId) {
  const [options, appointments] = await Promise.all([
    api(`/meetings/${encodeURIComponent(meetingId)}/proxy-options`),
    api(`/meetings/${encodeURIComponent(meetingId)}/proxies`)
  ]);
  state.proxyOptions = options;
  state.proxyAppointments = appointments;
  renderProxyAppointments(meetingId);
}

function renderLiveRoom(data) {
  const { meeting, live, session, agenda, elections, documents = [], attendance = {}, questions = [], guest = false } = data;
  const manager = !guest && ["system_administrator", "meeting_organiser"].includes(state.user?.role);
  const sessionValue = session || {};
  const agendaItems = agenda.items || agenda;
  document.querySelector("#live-agenda-section").hidden = !manager && agendaItems.length === 0;
  const status = document.querySelector("#live-meeting-status");
  status.textContent = live
    ? `Live · ${formatDate(sessionValue.started_at, { timeStyle: "short" })}`
    : "Meeting not started";
  status.className = `status-label ${live ? "open" : ""}`;
  const toggle = document.querySelector("#live-meeting-toggle");
  toggle.hidden = !manager;
  toggle.textContent = live ? "End meeting" : "Start meeting";
  toggle.dataset.action = live ? "end" : "start";
  document.querySelector("#live-next-agenda").hidden = !manager || !live;
  document.querySelector("#live-create-vote").hidden = !manager || !live;
  document.querySelector("#live-guest-note").hidden = !guest;
  document.querySelector("#live-agenda-form").hidden = !manager || !live;
  document.querySelector("#live-documents-section").hidden = guest;
  document.querySelector("#live-attendance-section").hidden = guest;
  document.querySelector("#live-questions-section").hidden = guest;
  document.querySelector("#live-question-form").hidden = guest || !live || state.user?.role !== "registered_participant";
  const checkIn = document.querySelector("#live-check-in");
  checkIn.hidden = guest || !live || state.user?.role !== "registered_participant" || attendance.checkedIn;
  const attendanceSummary = document.querySelector("#live-attendance-summary");
  const quorum = attendance.quorum || {};
  const quorumLabel = quorum.quorumMet
    ? "Quorum met"
    : quorum.status === "meeting_not_live"
      ? "Quorum pending"
      : quorum.status === "grace_period"
        ? `15-minute grace period ends ${formatDate(quorum.graceEndsAt, { timeStyle: "short" })}`
        : "Quorum not met";
  attendanceSummary.textContent = `${Number(attendance.checkedInCount || 0)} of ${Number(attendance.registeredResidents || 0)} registered residents checked in · ${Number(attendance.onlineCount || 0)} online · ${Number(quorum.presentMembers || 0)} of ${Number(quorum.requiredMembers || 3)} Members/attendees present · ${Number(quorum.representedUnits || 0)} of ${Number(quorum.totalEligibleUnits || 0)} eligible Unit/Erf votes represented (at least ${Number(quorum.requiredUnitVotes || 0)} required) · ${quorumLabel}.${attendance.checkedIn ? " You are checked in." : ""}`;
  document.querySelector("#live-quorum-adjourn-form").hidden = !manager || !live || quorum.status !== "not_met";
  const attendanceLists = document.querySelector("#live-attendance-lists");
  attendanceLists.hidden = !manager;
  attendanceLists.innerHTML = manager
    ? `<div class="attendance-roster"><h4>Checked in</h4>${attendance.attendees?.length
      ? attendance.attendees.map((attendee) => `<p>${escapeHtml(attendee.display_name)} <small>${escapeHtml(formatDate(attendee.checked_in_at, { timeStyle: "short" }))}</small></p>`).join("")
      : '<p class="muted">No residents have checked in.</p>'}
      <h4>Online in MeetVote now</h4>${attendance.onlineParticipants?.length
      ? attendance.onlineParticipants.map((participant) => `<p>${escapeHtml(participant.display_name)}</p>`).join("")
      : '<p class="muted">No resident presence detected.</p>'}</div>`
    : "";
  const questionsList = document.querySelector("#live-questions-list");
  questionsList.innerHTML = questions.length
    ? questions.map((question) => `<article class="live-question-card">
        <div class="live-question-heading"><span class="status-label ${escapeHtml(question.status)}">${escapeHtml(question.status)}</span><small>${escapeHtml(question.displayName)} · ${escapeHtml(formatDate(question.createdAt, { timeStyle: "short" }))}</small></div>
        <p>${escapeHtml(question.question)}</p>
        ${question.answer ? `<div class="live-question-answer"><strong>Chairperson's answer</strong><p>${escapeHtml(question.answer)}</p></div>` : ""}
        ${manager && question.status === "pending" ? `<div class="live-question-actions">
          <button class="button button-quiet question-moderation-button" type="button" data-question-id="${escapeHtml(question.id)}" data-question-status="published">Publish</button>
          <button class="button button-quiet question-moderation-button" type="button" data-question-id="${escapeHtml(question.id)}" data-question-status="dismissed">Dismiss</button>
        </div>` : ""}
        ${manager && question.status === "published" ? `<form class="question-answer-form" data-question-id="${escapeHtml(question.id)}">
          <label for="question-answer-${escapeHtml(question.id)}">Answer</label>
          <textarea id="question-answer-${escapeHtml(question.id)}" name="answer" maxlength="3000" rows="2" required></textarea>
          <button class="button button-primary" type="submit">Mark answered</button>
          <button class="button button-quiet question-moderation-button" type="button" data-question-id="${escapeHtml(question.id)}" data-question-status="dismissed">Dismiss</button>
        </form>` : ""}
      </article>`).join("")
    : '<p class="muted">No questions yet.</p>';
  renderMeetingDocuments(
    document.querySelector("#live-documents-list"),
    state.liveMeetingId,
    documents,
    manager
  );

  const agendaList = document.querySelector("#live-agenda-list");
  agendaList.innerHTML = agendaItems.length
    ? agendaItems.map((item) => `<button class="live-agenda-item ${item.id === sessionValue.active_agenda_item_id ? "active" : ""}" type="button" data-live-agenda-id="${escapeHtml(item.id)}" ${manager && live ? "" : "disabled"}>
        <span>${escapeHtml(item.position)}.</span><span><strong>${escapeHtml(item.title)}</strong>${item.description ? `<small>${escapeHtml(item.description)}</small>` : ""}</span>
      </button>`).join("")
    : '<p class="muted">No agenda items have been added.</p>';

  const votingPanel = document.querySelector("#live-voting-panel");
  const electionSelect = `<label class="sr-only" for="live-voting-select">Announced voting item</label><select id="live-voting-select" ${manager && live ? "" : "disabled"}><option value="">Select a voting item</option>${elections.map((election) =>
    `<option value="${escapeHtml(election.id)}" ${election.id === sessionValue.active_election_id ? "selected" : ""}>${escapeHtml(election.title)} · ${escapeHtml(election.status)}</option>`).join("")}</select>`;
  const activeElection = elections.find((election) => election.id === sessionValue.active_election_id);
  const votingOngoing = activeElection?.status === "open";
  const electionActions = activeElection && manager
    ? `<div class="live-vote-actions">${activeElection.status === "draft"
      ? `<button class="button button-quiet voter-management-button" type="button" data-election-id="${escapeHtml(activeElection.id)}">Manage eligible voters</button><button class="button button-primary live-election-status" type="button" data-election-id="${escapeHtml(activeElection.id)}" data-election-status-action="open" ${!live ? "disabled" : ""}>Open voting</button>`
      : activeElection.status === "open"
        ? `<button class="button button-quiet live-election-status" type="button" data-election-id="${escapeHtml(activeElection.id)}" data-election-status-action="closed">Close voting</button>`
        : ""}
    </div>`
    : "";
  let ballot = '<p class="muted">No voting item announced.</p>';
  if (activeElection) {
    const options = activeElection.options?.length ? activeElection.options : activeElection.candidates || [];
    const isCandidateElection = activeElection.voting_type === "candidate";
    const candidateProfiles = isCandidateElection ? candidateProfilesForCard(activeElection, options) : [];
    const canVote = !guest && state.user?.role === "registered_participant" &&
      live && activeElection.status === "open" && activeElection.is_eligible;
    const canSelectCandidate = canVote && !activeElection.has_voted;
    const candidateCards = isCandidateElection && !canSelectCandidate
      ? `<div class="candidate-profile-grid">${candidateProfiles.map((profile, index) => renderCandidateProfile(profile, index)).join("")}</div>`
      : "";
    const form = canVote
      ? activeElection.has_voted
        ? '<p class="ballot-receipt" role="status">Your ballot has been recorded.</p>'
        : `<form class="ballot-form" data-election-id="${escapeHtml(activeElection.id)}" novalidate><fieldset><legend>${isCandidateElection ? "Review each profile, then select one candidate" : "Select one choice"}</legend>${isCandidateElection
          ? `<div class="candidate-profile-grid">${candidateProfiles.map((profile, index) => renderCandidateProfile(profile, index, true)).join("")}</div>`
          : options.map((option, index) => `<label class="ballot-option"><input type="radio" name="candidateIndex" value="${index}" required /><span>${escapeHtml(option)}</span></label>`).join("")}</fieldset><button class="button button-primary" type="submit">Submit confidential ballot</button></form>`
      : guest
        ? '<p class="muted">Guests may follow the discussion but cannot vote.</p>'
        : state.user?.role === "registered_participant" && live && activeElection.status === "open"
          ? activeElection.has_voted
            ? '<p class="ballot-receipt" role="status">Your ballot has been recorded.</p>'
            : '<p class="muted">You are not on the eligible voter list for this item.</p>'
          : `<p class="muted">${activeElection.status === "closed" ? "Voting is closed." : "Voting has not opened yet."}</p>`;
    const turnout = manager
      ? `<p class="live-turnout" aria-live="polite">Turnout: ${Number(activeElection.participation_count || 0)} of ${Number(activeElection.eligible_voter_count || 0)} eligible residents</p>`
      : "";
    const countdown = votingOngoing
      ? `<p class="election-countdown" data-election-countdown data-meeting-id="${escapeHtml(state.liveMeetingId)}" data-ends-at="${escapeHtml(activeElection.ends_at)}"><span>Time remaining</span><strong data-countdown-value></strong></p>`
      : "";
    ballot = `<article class="live-vote-item"><span class="status-label ${escapeHtml(activeElection.status)}">${escapeHtml(activeElection.status)}</span><h4>${escapeHtml(activeElection.title)}</h4><p>${escapeHtml(activeElection.voting_type === "resolution" ? "For / Against / Abstain resolution" : activeElection.voting_type === "multiple_choice" ? "Multiple-choice vote" : "Candidate election")}</p>${countdown}${candidateCards}${form}${turnout}${electionActions}</article>`;
  }
  if (votingOngoing && state.liveRoomJoined) setLivePanelVisible(true);
  updateLivePanelToggle();
  if (!state.liveBallotSubmitting) {
    votingPanel.innerHTML = `${manager && live ? electionSelect : ""}${ballot}`;
    bindBallotForms(votingPanel);
  }
  const nextAgenda = agendaItems.findIndex((item) => item.id === sessionValue.active_agenda_item_id) + 1;
  document.querySelector("#live-next-agenda").disabled = nextAgenda < 0 || nextAgenda >= agendaItems.length;
  videoDialog.dataset.meetingTitle = meeting.title;
  updateElectionCountdowns();
}

function setLivePanelVisible(visible) {
  const panel = document.querySelector(".meeting-room-panel");
  const layout = document.querySelector(".meeting-room-layout");
  panel.hidden = !visible;
  layout.classList.toggle("panel-hidden", !visible);
  updateLivePanelToggle();
}

function updateLivePanelToggle() {
  const button = document.querySelector("#video-controls-toggle");
  const visible = !document.querySelector(".meeting-room-panel").hidden;
  const activeElection = state.liveRoomData?.elections?.find(
    (election) => election.id === state.liveRoomData.session?.active_election_id
  );
  const votingOngoing = activeElection?.status === "open";
  button.hidden = !state.liveRoomJoined;
  button.disabled = votingOngoing;
  button.title = votingOngoing
    ? "The agenda and voting panel stays open while voting is in progress"
    : "";
  button.setAttribute("aria-expanded", String(visible));
  button.textContent = visible ? "Hide agenda & voting" : "Show agenda & voting";
}

async function refreshLiveRoom() {
  if (!state.liveMeetingId || state.refreshingLiveRoom || state.liveBallotSubmitting || !videoDialog.open) return;
  state.refreshingLiveRoom = true;
  try {
    let data;
    if (state.guestToken) {
      data = await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/guest-live`, {
        method: "POST",
        authenticated: false,
        body: { guestToken: state.guestToken }
      });
      data.agenda = { items: data.agenda };
      data.documents = [];
      data.attendance = {};
      data.questions = [];
    } else {
      const meeting = state.meetings.find((item) => item.id === state.liveMeetingId);
      const [live, agenda, elections] = await Promise.all([
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/live`),
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/agenda`),
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/elections`)
      ]);
      if (live.live && state.user?.role === "registered_participant") {
        await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/presence`, { method: "POST" });
      }
      const [documents, attendance, questions] = await Promise.all([
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/documents`),
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/attendance`),
        api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/questions`)
      ]);
      data = { meeting: { title: meeting?.title || "Elawini Estate meeting" }, ...live, agenda, elections, documents, attendance, questions };
    }
    state.liveRoomData = data;
    renderLiveRoom(data);
    clearNotice(document.querySelector("#live-meeting-notice"));
  } catch (error) {
    showNotice(document.querySelector("#live-meeting-notice"), error.message);
  } finally {
    state.refreshingLiveRoom = false;
  }
}

async function openMeetingAgenda(meetingId, title) {
  document.querySelector("#agenda-meeting-title").textContent = title;
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const meetingDetails = meeting
    ? [
      meetingTypeName(meeting.meeting_type),
      `${formatDate(meeting.starts_at, { dateStyle: "full", timeStyle: "short" })} · Organised by ${meeting.organiser_name} · Chaired by ${meeting.chairperson_name || meeting.organiser_name}`,
      meeting.description
    ].filter(Boolean).join(" · ")
    : "Agenda items and motions for this meeting.";
  document.querySelector("#agenda-meeting-description").textContent = meetingDetails;
  const canManage = ["system_administrator", "meeting_organiser"].includes(state.user?.role);
  document.querySelector("#agenda-management").hidden = !canManage;
  document.querySelector("#agenda-notice").hidden = true;
  document.querySelector("#agenda-items-list").innerHTML = '<p class="agenda-empty">Loading agenda…</p>';
  document.querySelector("#agenda-documents-list").innerHTML = '<p class="muted">Loading documents…</p>';
  document.querySelector("#proxy-appointments-list").innerHTML = '<p class="muted">Loading proxy appointments…</p>';
  agendaDialog.dataset.meetingId = meetingId;
  agendaDialog.showModal();
  try {
    const [agenda, documents] = await Promise.all([
      api(`/meetings/${encodeURIComponent(meetingId)}/agenda`),
      api(`/meetings/${encodeURIComponent(meetingId)}/documents`)
    ]);
    renderAgenda(agenda);
    renderMeetingDocuments(
      document.querySelector("#agenda-documents-list"),
      meetingId,
      documents,
      canManage
    );
    if (canManage) {
      try {
        await loadMeetingProxies(meetingId);
      } catch (error) {
        document.querySelector("#proxy-appointments-list").innerHTML = "";
        showNotice(document.querySelector("#agenda-notice"), error.message);
      }
    }
  } catch (error) {
    document.querySelector("#agenda-items-list").innerHTML = "";
    showNotice(document.querySelector("#agenda-notice"), error.message);
  }
}

function openElectionDialog(meetingId, { agendaItemId = "", requireSchedule = true } = {}) {
  resetElectionEditor();
  renderElectionTemplateOptions();
  document.querySelector("#election-meeting").value = meetingId;
  document.querySelector("#election-agenda-item").value = agendaItemId;
  document.querySelector("#election-start").required = requireSchedule;
  document.querySelector("#election-end").required = requireSchedule;
  document.querySelector("#election-type").dispatchEvent(new Event("change"));
  electionDialog.showModal();
}

async function refreshData() {
  clearNotice(appNotice);
  try {
    const meetings = await api("/meetings");
    state.meetings = await Promise.all(meetings.map(async (meeting) => {
      const meetingPath = `/meetings/${encodeURIComponent(meeting.id)}`;
      const [elections, documents] = await Promise.all([
        api(`${meetingPath}/elections`),
        api(`${meetingPath}/documents`)
      ]);
      return { ...meeting, elections, documents };
    }));
    if (["system_administrator", "meeting_organiser"].includes(state.user?.role)) {
      await refreshElectionTemplates();
    } else {
      state.electionTemplates = [];
    }
    if (state.user?.role === "system_administrator") await refreshHoaMembership();
    renderMeetings();
    renderDocuments();
    renderReports();
    renderElections();
    await renderResults();
  } catch (error) {
    showNotice(appNotice, error.message);
  }
}

function renderHoaMembership() {
  const registry = state.hoaMembership;
  if (!registry) return;
  const accountSelect = document.querySelector("#hoa-member-account");
  accountSelect.innerHTML = `<option value="">Not linked</option>${registry.accounts.map((account) =>
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.display_name)} · ${escapeHtml(account.email)}</option>`).join("")}`;
  document.querySelector("#hoa-development-period-active").checked = registry.developmentPeriodActive;
  document.querySelector("#hoa-members-list").innerHTML = registry.members.length
    ? registry.members.map((member) => `<article class="hoa-record">
        <div><h4>${escapeHtml(member.fullName)}</h4><p>${escapeHtml(member.memberType === "developer" ? "Developer" : member.memberType === "special" ? "Special Member" : "Member")}${member.membershipNumber ? ` · ${escapeHtml(member.membershipNumber)}` : ""}</p>
        <p>${member.email ? `${escapeHtml(member.email)} · ` : "No account linked · "}${member.goodStanding ? "In good standing" : "Not in good standing"} · ${member.units.length} Unit/Erf</p>
        <span class="hoa-record-status ${member.isActive ? "" : "status-inactive"}">${member.isActive ? "Active" : "Inactive"}</span>${member.isEntity ? '<span class="hoa-record-status">Entity</span>' : ""}</div>
        <div class="hoa-record-actions"><button class="button button-quiet" type="button" data-hoa-member-edit="${escapeHtml(member.id)}">Edit</button></div>
      </article>`).join("")
    : '<p class="muted">No Members have been registered yet.</p>';
  const selectedIds = new Set([...document.querySelectorAll("#hoa-unit-members input:checked")].map((input) => input.value));
  document.querySelector("#hoa-unit-members").innerHTML = registry.members.length
    ? registry.members.map((member) => `<label class="checkbox-label"><input type="checkbox" value="${escapeHtml(member.id)}" ${selectedIds.has(member.id) ? "checked" : ""} ${member.isActive ? "" : "disabled"} /> ${escapeHtml(member.fullName)}${member.goodStanding ? "" : " · not in good standing"}${member.isActive ? "" : " · inactive"}</label>`).join("")
    : '<p class="muted">Add Members before creating Units/Erfs.</p>';
  document.querySelector("#hoa-units-list").innerHTML = registry.units.length
    ? registry.units.map((unit) => `<article class="hoa-record">
        <div><h4>Unit/Erf ${escapeHtml(unit.unitNumber)}</h4><p>${unit.members.map((member) => escapeHtml(member.fullName)).join(", ")}</p>
        <span class="hoa-record-status ${unit.votingEligible && unit.isActive ? "" : "status-inactive"}">${unit.votingEligible && unit.isActive ? "Eligible to vote" : "Not eligible"}</span>
        <span class="hoa-record-status ${unit.isActive ? "" : "status-inactive"}">${unit.isActive ? "Active" : "Inactive"}</span></div>
        <div class="hoa-record-actions"><button class="button button-quiet" type="button" data-hoa-unit-edit="${escapeHtml(unit.id)}">Edit</button></div>
      </article>`).join("")
    : '<p class="muted">No Units/Erfs have been registered yet.</p>';
  updateHoaUnitEligibilityControl();
}

async function refreshHoaMembership() {
  try {
    state.hoaMembership = await api("/hoa/membership");
    renderHoaMembership();
  } catch (error) {
    showNotice(document.querySelector("#hoa-registry-notice"), error.message);
  }
}

function updateHoaUnitEligibilityControl() {
  const selected = [...document.querySelectorAll("#hoa-unit-members input:checked")];
  const allowed = selected.length > 0 && selected.every((input) =>
    state.hoaMembership?.members.some((member) => member.id === input.value && member.isActive && member.goodStanding));
  const eligible = document.querySelector("#hoa-unit-voting-eligible");
  eligible.disabled = !allowed;
  if (!allowed) eligible.checked = false;
}

function resetHoaMemberForm() {
  const form = document.querySelector("#hoa-member-form");
  form.reset();
  document.querySelector("#hoa-member-id").value = "";
  document.querySelector("#hoa-member-active").checked = true;
  document.querySelector("#hoa-member-form-heading").textContent = "Add a Member";
  form.querySelector('button[type="submit"]').textContent = "Add Member";
  document.querySelector("#hoa-member-cancel").hidden = true;
}

function resetHoaUnitForm() {
  const form = document.querySelector("#hoa-unit-form");
  form.reset();
  document.querySelector("#hoa-unit-id").value = "";
  document.querySelector("#hoa-unit-active").checked = true;
  document.querySelector("#hoa-unit-form-heading").textContent = "Add a Unit/Erf";
  form.querySelector('button[type="submit"]').textContent = "Add Unit/Erf";
  document.querySelector("#hoa-unit-cancel").hidden = true;
  renderHoaMembership();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice(loginNotice);
  const button = loginForm.querySelector("button[type=submit]");
  setBusy(button, true, "Signing in…");
  const data = new FormData(loginForm);
  try {
    const result = await api("/auth/login", {
      method: "POST",
      authenticated: false,
      body: { email: data.get("email"), password: data.get("password") }
    });
    state.token = result.accessToken;
    sessionStorage.setItem("meetvote-token", state.token);
    showApp(result.user);
    setView("overview");
  } catch (error) {
    showNotice(loginNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#toggle-setup").addEventListener("click", (event) => {
  const setup = setupForm.hidden;
  setupForm.hidden = !setup;
  loginForm.hidden = setup;
  document.querySelector("#login-heading").textContent = setup ? "Set up your administrator account" : "Sign in to your account";
  event.currentTarget.textContent = setup ? "Back to sign in" : "First administrator setup (only if none exists)";
  clearNotice(loginNotice);
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice(loginNotice);
  const button = setupForm.querySelector("button[type=submit]");
  setBusy(button, true, "Creating account…");
  const data = new FormData(setupForm);
  try {
    await api("/auth/bootstrap", {
      method: "POST",
      authenticated: false,
      body: { displayName: data.get("displayName"), email: data.get("email"), password: data.get("password") }
    });
    setupForm.reset();
    setupForm.hidden = true;
    loginForm.hidden = false;
    document.querySelector("#login-heading").textContent = "Sign in to your account";
    document.querySelector("#toggle-setup").textContent = "First administrator setup (only if none exists)";
    document.querySelector("#login-email").value = data.get("email");
    showNotice(loginNotice, "Administrator account created. Sign in to continue.", "success");
  } catch (error) {
    showNotice(loginNotice, error.message === "An administrator already exists."
      ? "An administrator account already exists. Sign in with that account. The administrator can create resident and organiser accounts from Accounts."
      : error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelectorAll("[data-view], [data-go]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view || button.dataset.go));
});

document.querySelector("#add-candidate-button").addEventListener("click", () => addCandidateProfileRow());
document.addEventListener("click", (event) => {
  const removeCandidate = event.target.closest("[data-candidate-remove]");
  const moveCandidate = event.target.closest("[data-candidate-move]");
  const removePhoto = event.target.closest("[data-remove-candidate-photo]");
  if (removeCandidate && !removeCandidate.disabled) {
    const row = removeCandidate.closest(".candidate-editor-row");
    candidatePhotoData.delete(row);
    row.remove();
    refreshCandidateProfileOrder();
  }
  if (moveCandidate && !moveCandidate.disabled) {
    const row = moveCandidate.closest(".candidate-editor-row");
    const sibling = moveCandidate.dataset.candidateMove === "up"
      ? row.previousElementSibling
      : row.nextElementSibling;
    if (sibling) {
      if (moveCandidate.dataset.candidateMove === "up") row.parentElement.insertBefore(row, sibling);
      else row.parentElement.insertBefore(sibling, row);
      refreshCandidateProfileOrder();
    }
  }
  if (removePhoto) removeCandidatePhoto(removePhoto.closest(".candidate-editor-row"));
});

document.querySelector(".sidebar-brand").addEventListener("click", (event) => {
  event.preventDefault();
  setView("overview");
});

document.querySelector("#next-meeting-card").addEventListener("click", (event) => {
  const meetingId = event.currentTarget.dataset.meetingId;
  if (!meetingId) return;
  setView("meetings");
  requestAnimationFrame(() => {
    const meetingCardElement = [...document.querySelectorAll("#meetings-list .meeting-card")]
      .find((card) => card.dataset.meetingId === meetingId);
    if (!meetingCardElement) return;
    meetingCardElement.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center"
    });
    const agendaButton = meetingCardElement.querySelector(".agenda-button");
    agendaButton?.focus({ preventScroll: true });
    agendaButton?.click();
  });
});

document.querySelector("#mobile-menu-button").addEventListener("click", openMobileDrawer);
document.querySelector("#drawer-close").addEventListener("click", closeMobileDrawer);
document.querySelector("#drawer-overlay").addEventListener("click", closeMobileDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileDrawer();
});

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  clearNotice(document.querySelector("#profile-notice"));
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  setBusy(button, true, "Saving…");
  try {
    const updatedUser = await api("/me/profile", {
      method: "PUT",
      body: { displayName: data.get("displayName") }
    });
    state.user = { ...state.user, ...updatedUser };
    renderAccountIdentity(state.user);
    showNotice(document.querySelector("#profile-notice"), "Your profile has been updated.", "success");
  } catch (error) {
    showNotice(document.querySelector("#profile-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  clearNotice(document.querySelector("#password-notice"));
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  if (data.get("newPassword") !== data.get("confirmPassword")) {
    showNotice(document.querySelector("#password-notice"), "The new passwords do not match.");
    return;
  }
  setBusy(button, true, "Updating…");
  try {
    await api("/me/password", {
      method: "POST",
      body: { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") }
    });
    form.reset();
    showNotice(document.querySelector("#password-notice"), "Your password has been updated. Other active sessions were signed out.", "success");
  } catch (error) {
    showNotice(document.querySelector("#password-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice(appNotice);
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  setBusy(button, true, "Creating account…");
  try {
    const account = await api("/users", {
      method: "POST",
      body: {
        displayName: data.get("displayName"),
        email: data.get("email"),
        password: data.get("password"),
        role: data.get("role")
      }
    });
    form.reset();
    showNotice(appNotice, `${account.displayName} has been added as a ${roleName(account.role).toLowerCase()}. Share the temporary password securely.`, "success");
  } catch (error) {
    showNotice(appNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#proxy-appointment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const meetingId = agendaDialog.dataset.meetingId;
  const unitId = document.querySelector("#proxy-unit-select").value;
  const unit = state.proxyOptions?.units.find((item) => item.id === unitId);
  if (!unit) {
    showNotice(document.querySelector("#agenda-notice"), "Select an eligible Unit/Erf.");
    return;
  }
  setBusy(button, true, "Creating…");
  try {
    await api(`/meetings/${encodeURIComponent(meetingId)}/proxies`, {
      method: "POST",
      body: {
        unitId,
        memberIds: unit.members.map((member) => member.id),
        proxyUserId: document.querySelector("#proxy-account-select").value
      }
    });
    await loadMeetingProxies(meetingId);
    showNotice(document.querySelector("#agenda-notice"), "Proxy appointment created. Upload each required document before verification.", "success");
  } catch (error) {
    showNotice(document.querySelector("#agenda-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#proxy-appointments-list").addEventListener("change", async (event) => {
  const input = event.target.closest(".proxy-document-upload");
  const file = input?.files?.[0];
  if (!input || !file) return;
  if (file.size > 5 * 1024 * 1024) {
    showNotice(document.querySelector("#agenda-notice"), "Proxy documents must be no larger than 5 MB.");
    input.value = "";
    return;
  }
  input.disabled = true;
  try {
    const meetingId = agendaDialog.dataset.meetingId;
    await api(`/meetings/${encodeURIComponent(meetingId)}/proxies/${encodeURIComponent(input.dataset.proxyId)}/documents`, {
      method: "PUT",
      body: {
        documentType: input.dataset.documentType,
        fileName: file.name,
        mimeType: file.type,
        contentBase64: await fileAsBase64(file)
      }
    });
    await loadMeetingProxies(meetingId);
    showNotice(document.querySelector("#agenda-notice"), "Private proxy document uploaded and encrypted.", "success");
  } catch (error) {
    showNotice(document.querySelector("#agenda-notice"), error.message);
  } finally {
    input.disabled = false;
  }
});

document.querySelector("#proxy-appointments-list").addEventListener("click", async (event) => {
  const downloadButton = event.target.closest(".proxy-document-download");
  const verifyButton = event.target.closest(".proxy-verify-button");
  const meetingId = agendaDialog.dataset.meetingId;
  if (downloadButton) {
    try {
      const fileData = await api(`/meetings/${encodeURIComponent(meetingId)}/proxies/${encodeURIComponent(downloadButton.dataset.proxyId)}/documents/${encodeURIComponent(downloadButton.dataset.documentType)}`);
      downloadBase64File(fileData);
    } catch (error) {
      showNotice(document.querySelector("#agenda-notice"), error.message);
    }
  }
  if (verifyButton) {
    verifyButton.disabled = true;
    try {
      await api(`/meetings/${encodeURIComponent(meetingId)}/proxies/${encodeURIComponent(verifyButton.dataset.proxyId)}/verify`, {
        method: "PUT", body: { status: verifyButton.dataset.proxyStatus }
      });
      await loadMeetingProxies(meetingId);
      showNotice(document.querySelector("#agenda-notice"), `Proxy appointment ${verifyButton.dataset.proxyStatus}.`, "success");
    } catch (error) {
      showNotice(document.querySelector("#agenda-notice"), error.message);
    } finally {
      verifyButton.disabled = false;
    }
  }
});

document.querySelector("#live-quorum-adjourn-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const value = document.querySelector("#live-quorum-resume-at").value;
  if (!state.liveMeetingId || !value) return;
  setBusy(button, true, "Adjourning…");
  try {
    const result = await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/quorum/adjourn`, {
      method: "POST", body: { resumeAt: new Date(value).toISOString() }
    });
    showNotice(document.querySelector("#live-meeting-notice"),
      `Meeting adjourned for lack of quorum. It is scheduled to resume ${formatDate(result.resumeAt, { dateStyle: "medium", timeStyle: "short" })}.`, "success");
    await refreshLiveRoom();
  } catch (error) {
    showNotice(document.querySelector("#live-meeting-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#hoa-member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const memberId = document.querySelector("#hoa-member-id").value;
  const body = {
    fullName: document.querySelector("#hoa-member-name").value,
    membershipNumber: document.querySelector("#hoa-member-number").value,
    userId: document.querySelector("#hoa-member-account").value || null,
    memberType: document.querySelector("#hoa-member-type").value,
    goodStanding: document.querySelector("#hoa-member-good-standing").checked,
    isEntity: document.querySelector("#hoa-member-entity").checked,
    isActive: document.querySelector("#hoa-member-active").checked
  };
  setBusy(button, true, memberId ? "Saving…" : "Adding…");
  try {
    await api(memberId ? `/hoa/members/${encodeURIComponent(memberId)}` : "/hoa/members", {
      method: memberId ? "PUT" : "POST", body
    });
    resetHoaMemberForm();
    showNotice(document.querySelector("#hoa-registry-notice"), `Member ${memberId ? "updated" : "added"}.`, "success");
    await refreshHoaMembership();
  } catch (error) {
    showNotice(document.querySelector("#hoa-registry-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#hoa-member-cancel").addEventListener("click", resetHoaMemberForm);
document.querySelector("#hoa-members-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-hoa-member-edit]");
  if (!button || !state.hoaMembership) return;
  const member = state.hoaMembership.members.find((item) => item.id === button.dataset.hoaMemberEdit);
  if (!member) return;
  document.querySelector("#hoa-member-id").value = member.id;
  document.querySelector("#hoa-member-name").value = member.fullName;
  document.querySelector("#hoa-member-number").value = member.membershipNumber || "";
  document.querySelector("#hoa-member-account").value = member.userId || "";
  document.querySelector("#hoa-member-type").value = member.memberType;
  document.querySelector("#hoa-member-good-standing").checked = member.goodStanding;
  document.querySelector("#hoa-member-entity").checked = member.isEntity;
  document.querySelector("#hoa-member-active").checked = member.isActive;
  document.querySelector("#hoa-member-form-heading").textContent = "Edit Member";
  document.querySelector("#hoa-member-form").querySelector('button[type="submit"]').textContent = "Save Member";
  document.querySelector("#hoa-member-cancel").hidden = false;
  document.querySelector("#hoa-member-form").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector("#hoa-unit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const unitId = document.querySelector("#hoa-unit-id").value;
  const memberIds = [...document.querySelectorAll("#hoa-unit-members input:checked")].map((input) => input.value);
  if (!memberIds.length) {
    showNotice(document.querySelector("#hoa-registry-notice"), "Select at least one Member as a Unit/Erf owner.");
    return;
  }
  const body = {
    unitNumber: document.querySelector("#hoa-unit-number").value,
    memberIds,
    votingEligible: document.querySelector("#hoa-unit-voting-eligible").checked,
    isActive: document.querySelector("#hoa-unit-active").checked
  };
  setBusy(button, true, unitId ? "Saving…" : "Adding…");
  try {
    await api(unitId ? `/hoa/units/${encodeURIComponent(unitId)}` : "/hoa/units", {
      method: unitId ? "PUT" : "POST", body
    });
    resetHoaUnitForm();
    showNotice(document.querySelector("#hoa-registry-notice"), `Unit/Erf ${unitId ? "updated" : "added"}.`, "success");
    await refreshHoaMembership();
  } catch (error) {
    showNotice(document.querySelector("#hoa-registry-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#hoa-unit-cancel").addEventListener("click", resetHoaUnitForm);
document.querySelector("#hoa-unit-members").addEventListener("change", updateHoaUnitEligibilityControl);
document.querySelector("#hoa-units-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-hoa-unit-edit]");
  if (!button || !state.hoaMembership) return;
  const unit = state.hoaMembership.units.find((item) => item.id === button.dataset.hoaUnitEdit);
  if (!unit) return;
  document.querySelector("#hoa-unit-id").value = unit.id;
  document.querySelector("#hoa-unit-number").value = unit.unitNumber;
  document.querySelector("#hoa-unit-voting-eligible").checked = unit.votingEligible;
  document.querySelector("#hoa-unit-active").checked = unit.isActive;
  document.querySelector("#hoa-unit-form-heading").textContent = "Edit Unit/Erf";
  document.querySelector("#hoa-unit-form").querySelector('button[type="submit"]').textContent = "Save Unit/Erf";
  document.querySelector("#hoa-unit-cancel").hidden = false;
  renderHoaMembership();
  const selectedIds = new Set(unit.members.map((member) => member.id));
  document.querySelectorAll("#hoa-unit-members input").forEach((input) => { input.checked = selectedIds.has(input.value); });
  updateHoaUnitEligibilityControl();
  document.querySelector("#hoa-unit-form").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector("#hoa-voting-config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, "Saving…");
  try {
    await api("/hoa/voting-config", {
      method: "PUT",
      body: { developmentPeriodActive: document.querySelector("#hoa-development-period-active").checked }
    });
    showNotice(document.querySelector("#hoa-registry-notice"), "Voting configuration saved.", "success");
    await refreshHoaMembership();
  } catch (error) {
    showNotice(document.querySelector("#hoa-registry-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#logout-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Signing out…");
  try {
    await api("/auth/logout", { method: "POST" });
    sessionStorage.removeItem("meetvote-token");
    state.token = null;
    showLogin();
  } catch (error) {
    showNotice(appNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#create-meeting-button").addEventListener("click", async (event) => {
  clearNotice(meetingNotice);
  const button = event.currentTarget;
  const chairpersonSelect = document.querySelector("#meeting-chairperson");
  setBusy(button, true, "Loading…");
  try {
    const chairpersons = await api("/users/meeting-chairpersons");
    chairpersonSelect.innerHTML = chairpersons.map((person) =>
      `<option value="${escapeHtml(person.id)}">${escapeHtml(person.displayName)} · ${escapeHtml(roleName(person.role))}</option>`
    ).join("");
    chairpersonSelect.value = chairpersons.some((person) => person.id === state.user.id)
      ? state.user.id
      : chairpersons[0]?.id || "";
    if (!chairpersonSelect.value) {
      showNotice(meetingNotice, "No chairperson accounts are available. Create an account first.");
      return;
    }
    meetingDialog.showModal();
  } catch (error) {
    showNotice(meetingNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});
document.querySelector("#meeting-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#save-meeting-button").click();
});
document.querySelectorAll("[data-close-meeting]").forEach((button) => {
  button.addEventListener("click", () => meetingDialog.close());
});
document.querySelector("#hero-create-meeting").addEventListener("click", () => {
  document.querySelector("#create-meeting-button").click();
});
document.querySelector("[data-settings-logout]").addEventListener("click", () => {
  document.querySelector("#logout-button").click();
});
document.querySelector("#save-meeting-button").addEventListener("click", async () => {
  const form = document.querySelector("#meeting-form");
  if (!form.reportValidity()) return;
  clearNotice(meetingNotice);
  const button = document.querySelector("#save-meeting-button");
  const data = new FormData(form);
  setBusy(button, true, "Creating…");
  try {
    await api("/meetings", {
      method: "POST",
      body: {
        title: data.get("title"),
        description: data.get("description"),
        meetingType: data.get("meetingType"),
        chairpersonId: data.get("chairpersonId"),
        startsAt: new Date(data.get("startsAt")).toISOString()
      }
    });
    meetingDialog.close();
    form.reset();
    await refreshData();
    setView("meetings");
    showNotice(appNotice, "Meeting created and linked to the internal meeting service.", "success");
  } catch (error) {
    showNotice(meetingNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

document.addEventListener("click", (event) => {
  const createElection = event.target.closest(".create-election-button");
  const joinMeetingButton = event.target.closest(".join-meeting-button");
  const guestLinkButton = event.target.closest(".guest-link-button");
  const agendaButton = event.target.closest(".agenda-button");
  const agendaStatusButton = event.target.closest(".agenda-status-save-button");
  const agendaCreateVoteButton = event.target.closest(".agenda-create-vote-button");
  const agendaStartVotingButton = event.target.closest(".agenda-start-voting-button");
  const editElectionButton = event.target.closest(".edit-election-button");
  const manageVotersButton = event.target.closest(".voter-management-button");
  const electionStatusButton = event.target.closest(".election-status-button");
  const liveToggle = event.target.closest("#live-meeting-toggle");
  const liveAgendaItem = event.target.closest(".live-agenda-item");
  const liveNextAgenda = event.target.closest("#live-next-agenda");
  const liveCreateVote = event.target.closest("#live-create-vote");
  const liveElectionStatus = event.target.closest(".live-election-status");
  const documentDownload = event.target.closest(".meeting-document-download");
  const documentDelete = event.target.closest(".meeting-document-delete");
  const reportDownload = event.target.closest(".meeting-report-download");
  const checkInButton = event.target.closest("#live-check-in");
  const questionModerationButton = event.target.closest(".question-moderation-button");
  if (agendaButton) void openMeetingAgenda(agendaButton.dataset.meetingId, agendaButton.dataset.meetingTitle);
  if (agendaStatusButton) {
    const itemId = agendaStatusButton.dataset.agendaItemId;
    const status = agendaStatusButton.closest(".agenda-item")?.querySelector("[data-agenda-status]")?.value;
    const meetingId = agendaDialog.dataset.meetingId;
    setBusy(agendaStatusButton, true, "Saving…");
    void api(`/meetings/${encodeURIComponent(meetingId)}/agenda/${encodeURIComponent(itemId)}/status`, {
      method: "PUT",
      body: { status }
    }).then(async () => {
      renderAgenda(await api(`/meetings/${encodeURIComponent(meetingId)}/agenda`));
      showNotice(document.querySelector("#agenda-notice"), "Agenda status updated.", "success");
    }).catch((error) => showNotice(document.querySelector("#agenda-notice"), error.message))
      .finally(() => setBusy(agendaStatusButton, false));
  }
  if (agendaCreateVoteButton) {
    openElectionDialog(agendaCreateVoteButton.dataset.meetingId, {
      agendaItemId: agendaCreateVoteButton.dataset.agendaItemId,
      requireSchedule: state.liveMeetingId !== agendaCreateVoteButton.dataset.meetingId
    });
  }
  if (agendaStartVotingButton) {
    const meetingId = agendaStartVotingButton.dataset.meetingId;
    const electionId = agendaStartVotingButton.dataset.electionId;
    setBusy(agendaStartVotingButton, true, "Starting…");
    void (async () => {
      try {
        const live = await api(`/meetings/${encodeURIComponent(meetingId)}/live`);
        if (!live.live) throw new Error("Start the live meeting before opening this vote.");
        await api(`/meetings/${encodeURIComponent(meetingId)}/live/agenda`, {
          method: "PUT",
          body: { agendaItemId: agendaStartVotingButton.dataset.agendaItemId }
        });
        await api(`/meetings/${encodeURIComponent(meetingId)}/live/voting-item`, {
          method: "PUT",
          body: { electionId }
        });
        await api(`/elections/${encodeURIComponent(electionId)}/status`, {
          method: "PUT",
          body: { status: "open" }
        });
        await refreshData();
        if (state.liveMeetingId === meetingId) await refreshLiveRoom();
        renderAgenda(await api(`/meetings/${encodeURIComponent(meetingId)}/agenda`));
        showNotice(document.querySelector("#agenda-notice"), "Voting is open for eligible residents.", "success");
      } catch (error) {
        showNotice(document.querySelector("#agenda-notice"), error.message);
      } finally {
        setBusy(agendaStartVotingButton, false);
      }
    })();
  }
  if (manageVotersButton) void openVoterDialog(manageVotersButton.dataset.electionId);
  if (editElectionButton) openElectionEditor(editElectionButton.dataset.electionId);
  if (documentDownload) {
    setBusy(documentDownload, true, "Downloading…");
    void downloadMeetingDocument(documentDownload.dataset.meetingId, documentDownload.dataset.documentId)
      .catch((error) => {
        const notice = documentDownload.closest("#video-dialog")
          ? document.querySelector("#live-meeting-notice")
          : documentDownload.closest("#meeting-agenda-dialog")
            ? document.querySelector("#agenda-notice")
            : appNotice;
        showNotice(notice, error.message);
      })
      .finally(() => setBusy(documentDownload, false));
  }
  if (documentDelete) {
    setBusy(documentDelete, true, "Removing…");
    void api(`/meetings/${encodeURIComponent(documentDelete.dataset.meetingId)}/documents/${encodeURIComponent(documentDelete.dataset.documentId)}`, {
      method: "DELETE"
    }).then(async () => {
      await refreshData();
      const meeting = state.meetings.find((item) => item.id === documentDelete.dataset.meetingId);
      if (agendaDialog.open && meeting) {
        renderMeetingDocuments(document.querySelector("#agenda-documents-list"), meeting.id, meeting.documents, true);
      }
      if (state.liveMeetingId === documentDelete.dataset.meetingId) await refreshLiveRoom();
      const notice = documentDelete.closest("#video-dialog")
        ? document.querySelector("#live-meeting-notice")
        : documentDelete.closest("#meeting-agenda-dialog")
          ? document.querySelector("#agenda-notice")
          : appNotice;
      showNotice(notice, "Meeting document removed.", "success");
    }).catch((error) => showNotice(appNotice, error.message))
      .finally(() => setBusy(documentDelete, false));
  }
  if (reportDownload) {
    setBusy(reportDownload, true, "Preparing…");
    void api(`/meetings/${encodeURIComponent(reportDownload.dataset.meetingId)}/report`)
      .then((report) => downloadBase64File(report))
      .catch((error) => showNotice(appNotice, error.message))
      .finally(() => setBusy(reportDownload, false));
  }
  if (checkInButton) {
    setBusy(checkInButton, true, "Checking in…");
    void api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/attendance/check-in`, { method: "POST" })
      .then(() => refreshLiveRoom())
      .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message))
      .finally(() => setBusy(checkInButton, false));
  }
  if (questionModerationButton) {
    const meetingId = state.liveMeetingId;
    setBusy(questionModerationButton, true, "Saving…");
    void api(`/meetings/${encodeURIComponent(meetingId)}/questions/${encodeURIComponent(questionModerationButton.dataset.questionId)}`, {
      method: "PUT",
      body: { status: questionModerationButton.dataset.questionStatus }
    }).then(() => refreshLiveRoom())
      .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message))
      .finally(() => setBusy(questionModerationButton, false));
  }
  if (electionStatusButton) {
    setBusy(electionStatusButton, true, "Updating…");
    void api(`/elections/${encodeURIComponent(electionStatusButton.dataset.electionId)}/status`, {
      method: "PUT",
      body: { status: electionStatusButton.dataset.electionStatusAction }
    })
      .then(async (result) => {
        await refreshData();
        if (result.resultsPublished === false) {
          showNotice(appNotice, "Election closed, but results could not be retrieved from the secure voting service.", "info");
        } else {
          showNotice(appNotice, `Election ${electionStatusButton.dataset.electionStatusAction === "open" ? "opened" : "closed"}.`, "success");
        }
      })
      .catch((error) => showNotice(appNotice, error.message))
      .finally(() => setBusy(electionStatusButton, false));
  }
  if (liveToggle) {
    liveToggle.disabled = true;
    void api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/live`, {
      method: "POST",
      body: { action: liveToggle.dataset.action }
    }).then(() => refreshLiveRoom())
      .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message))
      .finally(() => { liveToggle.disabled = false; });
  }
  if (liveAgendaItem) {
    void api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/live/agenda`, {
      method: "PUT",
      body: { agendaItemId: liveAgendaItem.dataset.liveAgendaId }
    }).then(() => refreshLiveRoom())
      .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message));
  }
  if (liveNextAgenda) {
    const agendaItems = state.liveRoomData?.agenda.items || state.liveRoomData?.agenda || [];
    const currentIndex = agendaItems.findIndex((item) => item.id === state.liveRoomData?.session?.active_agenda_item_id);
    const nextItem = agendaItems[currentIndex + 1];
    if (nextItem) {
      void api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/live/agenda`, {
        method: "PUT",
        body: { agendaItemId: nextItem.id }
      }).then(() => refreshLiveRoom())
        .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message));
    }
  }
  if (liveCreateVote) {
    openElectionDialog(state.liveMeetingId, {
      agendaItemId: state.liveRoomData?.session?.active_agenda_item_id || "",
      requireSchedule: false
    });
  }
  if (liveElectionStatus) {
    setBusy(liveElectionStatus, true, "Updating…");
    void api(`/elections/${encodeURIComponent(liveElectionStatus.dataset.electionId)}/status`, {
      method: "PUT",
      body: { status: liveElectionStatus.dataset.electionStatusAction }
    }).then(async (result) => {
      await refreshData();
      await refreshLiveRoom();
      if (result.resultsPublished === false) {
        showNotice(document.querySelector("#live-meeting-notice"), "Voting is closed, but results could not be retrieved from the secure voting service.", "info");
      }
    }).catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message))
      .finally(() => setBusy(liveElectionStatus, false));
  }
  if (createElection) {
    openElectionDialog(createElection.dataset.meetingId);
  }
  if (joinMeetingButton) {
    setBusy(joinMeetingButton, true, "Joining…");
    void joinMeeting(joinMeetingButton.dataset.meetingId)
      .catch((error) => showNotice(appNotice, error.message))
      .finally(() => setBusy(joinMeetingButton, false));
  }
  if (guestLinkButton) {
    setBusy(guestLinkButton, true, "Creating…");
    void api(`/meetings/${encodeURIComponent(guestLinkButton.dataset.meetingId)}/guest-links`, { method: "POST", body: {} })
      .then(async (result) => {
        try {
          await navigator.clipboard.writeText(result.shareUrl);
          showNotice(appNotice, `Guest invitation copied. It expires ${formatDate(result.expiresAt, { dateStyle: "medium", timeStyle: "short" })} and does not allow voting.`, "success");
        } catch {
          showNotice(appNotice, `Copy this guest invitation before sharing it: ${result.shareUrl}`);
        }
      })
      .catch((error) => showNotice(appNotice, error.message))
      .finally(() => setBusy(guestLinkButton, false));
  }
  if (event.target.closest("[data-close-agenda]")) agendaDialog.close();
  if (event.target.closest("[data-close-voters]")) voterDialog.close();
  if (event.target.closest("[data-close-election]")) electionDialog.close();
});

document.querySelector("#voter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const userIds = [...form.querySelectorAll('input[name="voterId"]:checked')].map((input) => input.value);
  setBusy(button, true, "Saving…");
  try {
    const result = await api(`/elections/${encodeURIComponent(voterDialog.dataset.electionId)}/eligibility`, {
      method: "PUT",
      body: { userIds }
    });
    voterDialog.close();
    if (state.liveMeetingId) await refreshLiveRoom();
    showNotice(appNotice, `${result.eligibleVoters} eligible ${result.eligibleVoters === 1 ? "resident" : "residents"} saved.`, "success");
  } catch (error) {
    showNotice(voterNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#agenda-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  setBusy(button, true, "Adding…");
  try {
    await api(`/meetings/${encodeURIComponent(agendaDialog.dataset.meetingId)}/agenda`, {
      method: "POST",
      body: { title: data.get("title"), description: data.get("description") }
    });
    form.reset();
    renderAgenda(await api(`/meetings/${encodeURIComponent(agendaDialog.dataset.meetingId)}/agenda`));
    showNotice(document.querySelector("#agenda-notice"), "Agenda item added.", "success");
  } catch (error) {
    showNotice(document.querySelector("#agenda-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#agenda-document-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const file = form.querySelector('input[type="file"]').files[0];
  if (!file) return;
  if (file.type !== "application/pdf" || file.size > 8 * 1024 * 1024) {
    showNotice(document.querySelector("#agenda-notice"), "Choose a PDF document no larger than 8 MB.");
    return;
  }
  setBusy(button, true, "Uploading…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const meetingId = agendaDialog.dataset.meetingId;
    await api(`/meetings/${encodeURIComponent(meetingId)}/documents`, {
      method: "POST",
      body: { fileName: file.name, mimeType: file.type, contentBase64: btoa(binary) }
    });
    form.reset();
    await refreshData();
    const meeting = state.meetings.find((item) => item.id === meetingId);
    renderMeetingDocuments(document.querySelector("#agenda-documents-list"), meetingId, meeting?.documents || [], true);
    if (state.liveMeetingId === meetingId) await refreshLiveRoom();
    showNotice(document.querySelector("#agenda-notice"), "Document uploaded and shared with meeting participants.", "success");
  } catch (error) {
    showNotice(document.querySelector("#agenda-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#live-agenda-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  setBusy(button, true, "Adding…");
  try {
    await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/agenda`, {
      method: "POST",
      body: { title: data.get("title") }
    });
    form.reset();
    await refreshLiveRoom();
  } catch (error) {
    showNotice(document.querySelector("#live-meeting-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#live-question-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  setBusy(button, true, "Submitting…");
  try {
    await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/questions`, {
      method: "POST",
      body: { question: data.get("question"), isAnonymous: data.get("isAnonymous") === "on" }
    });
    form.reset();
    await refreshLiveRoom();
    showNotice(document.querySelector("#live-meeting-notice"), "Question sent to the meeting organiser for review.", "success");
  } catch (error) {
    showNotice(document.querySelector("#live-meeting-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest(".question-answer-form");
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, "Saving…");
  try {
    await api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/questions/${encodeURIComponent(form.dataset.questionId)}`, {
      method: "PUT",
      body: { status: "answered", answer: new FormData(form).get("answer") }
    });
    await refreshLiveRoom();
    showNotice(document.querySelector("#live-meeting-notice"), "Answer published.", "success");
  } catch (error) {
    showNotice(document.querySelector("#live-meeting-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#motion-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  setBusy(button, true, "Adding…");
  try {
    await api(`/meetings/${encodeURIComponent(agendaDialog.dataset.meetingId)}/motions`, {
      method: "POST",
      body: {
        agendaItemId: data.get("agendaItemId") || null,
        title: data.get("title"),
        text: data.get("text")
      }
    });
    form.reset();
    renderAgenda(await api(`/meetings/${encodeURIComponent(agendaDialog.dataset.meetingId)}/agenda`));
    showNotice(document.querySelector("#agenda-notice"), "Motion added to the meeting.", "success");
  } catch (error) {
    showNotice(document.querySelector("#agenda-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#close-video-button").addEventListener("click", () => videoDialog.close());
document.querySelector("#rejoin-video-button").addEventListener("click", () => void rejoinMeeting());
document.querySelector("#video-frame").addEventListener("load", () => {
  if (!videoDialog.open || !state.liveMeetingId && !state.guestToken) return;
  state.liveRoomJoined = true;
  const activeElection = state.liveRoomData?.elections?.find(
    (election) => election.id === state.liveRoomData.session?.active_election_id
  );
  setLivePanelVisible(activeElection?.status === "open");
});
const controlsToggle = document.querySelector("#video-controls-toggle");
controlsToggle.addEventListener("click", () => {
  if (controlsToggle.disabled) return;
  setLivePanelVisible(document.querySelector(".meeting-room-panel").hidden);
});
videoDialog.addEventListener("close", () => {
  if (state.liveRefresh) clearInterval(state.liveRefresh);
  state.liveRefresh = null;
  state.liveMeetingId = null;
  state.guestToken = null;
  state.liveRoomJoined = false;
  state.liveRoomData = null;
  document.querySelector("#rejoin-video-button").hidden = true;
  document.querySelector("#video-controls-toggle").hidden = true;
  document.querySelector(".meeting-room-panel").hidden = true;
  document.querySelector(".meeting-room-layout").classList.add("panel-hidden");
  document.querySelector("#video-frame").src = "about:blank";
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-candidate-photo]")) {
    updateCandidatePhoto(event.target);
    return;
  }
  if (event.target.id !== "live-voting-select" || !state.liveMeetingId) return;
  void api(`/meetings/${encodeURIComponent(state.liveMeetingId)}/live/voting-item`, {
    method: "PUT",
    body: { electionId: event.target.value || null }
  }).then(() => refreshLiveRoom())
    .catch((error) => showNotice(document.querySelector("#live-meeting-notice"), error.message));
});

document.querySelector("#election-template-select").addEventListener("change", updateElectionTemplateSelection);
document.querySelector("#apply-election-template").addEventListener("click", () => {
  const template = state.electionTemplates.find((item) =>
    item.id === document.querySelector("#election-template-select").value);
  if (!template) {
    showNotice(document.querySelector("#election-template-notice"), "Choose a saved template first.");
    return;
  }
  document.querySelector("#candidate-profiles-list").replaceChildren();
  const typeSelect = document.querySelector("#election-type");
  typeSelect.value = template.votingType;
  typeSelect.dispatchEvent(new Event("change"));
  document.querySelector("#election-title").value = template.title;
  document.querySelector("#election-options").value = template.options.join("\n");
  if (template.votingType === "candidate" && template.candidateProfiles?.length) {
    const profileList = document.querySelector("#candidate-profiles-list");
    profileList.replaceChildren();
    template.candidateProfiles.forEach(addCandidateProfileRow);
  }
  showNotice(document.querySelector("#election-template-notice"), `${template.templateName} applied. Select a meeting and review the details before creating the election.`, "success");
});

async function saveElectionTemplate(updateSelected) {
  const templateName = document.querySelector("#election-template-name").value.trim();
  const data = new FormData(document.querySelector("#election-form"));
  const votingType = data.get("votingType") || document.querySelector("#election-type").value;
  const selectedTemplateId = document.querySelector("#election-template-select").value;
  const button = document.querySelector(updateSelected ? "#update-election-template" : "#save-election-template");
  setBusy(button, true, updateSelected ? "Updating…" : "Saving…");
  try {
    const candidateRows = [...document.querySelectorAll("#candidate-profiles-list .candidate-editor-row")];
    const hasCandidateData = candidateRows.some((row) =>
      ["[data-candidate-full-name]", "[data-candidate-position]", "[data-candidate-biography]",
        "[data-candidate-experience]", "[data-candidate-statement]"]
        .some((selector) => row.querySelector(selector).value.trim()) ||
      Boolean(candidatePhotoData.get(row)));
    const candidateProfiles = votingType === "candidate" && hasCandidateData
      ? await collectCandidateProfiles()
      : [];
    const payload = {
      templateName,
      title: data.get("title"),
      votingType,
      options: votingType === "multiple_choice"
        ? String(data.get("options") || "").split(/\r?\n/).map((option) => option.trim()).filter(Boolean)
        : [],
      candidateProfiles
    };
    const saved = await api(updateSelected
      ? `/election-templates/${encodeURIComponent(selectedTemplateId)}`
      : "/election-templates", {
      method: updateSelected ? "PUT" : "POST",
      body: payload
    });
    await refreshElectionTemplates();
    document.querySelector("#election-template-select").value = saved.id;
    updateElectionTemplateSelection();
    showNotice(document.querySelector("#election-template-notice"),
      updateSelected ? "Template updated for future meetings." : "Template saved for future meetings.", "success");
  } catch (error) {
    showNotice(document.querySelector("#election-template-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
}

document.querySelector("#save-election-template").addEventListener("click", () => void saveElectionTemplate(false));
document.querySelector("#update-election-template").addEventListener("click", () => void saveElectionTemplate(true));
document.querySelector("#delete-election-template").addEventListener("click", async () => {
  const templateId = document.querySelector("#election-template-select").value;
  if (!templateId || !window.confirm("Delete this reusable election template? Existing elections will not be changed.")) return;
  const button = document.querySelector("#delete-election-template");
  setBusy(button, true, "Deleting…");
  try {
    await api(`/election-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
    await refreshElectionTemplates();
    document.querySelector("#election-template-name").value = "";
    showNotice(document.querySelector("#election-template-notice"), "Template deleted. Existing elections were not changed.", "success");
  } catch (error) {
    showNotice(document.querySelector("#election-template-notice"), error.message);
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#election-type").addEventListener("change", (event) => {
  const isCandidate = event.target.value === "candidate";
  const isMultipleChoice = event.target.value === "multiple_choice";
  const profileField = document.querySelector("#candidate-profiles-field");
  profileField.hidden = !isCandidate;
  profileField.querySelectorAll("input, textarea, button").forEach((control) => { control.disabled = !isCandidate; });
  document.querySelector("#add-candidate-button").hidden = Boolean(editingElectionId);
  if (isCandidate && !editingElectionId && !document.querySelector("#candidate-profiles-list").childElementCount) {
    addCandidateProfileRow();
    addCandidateProfileRow();
  }
  document.querySelector("#election-options-field").hidden = !isMultipleChoice;
  document.querySelector("#election-options").required = isMultipleChoice;
});

document.querySelector("#election-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  clearNotice(electionNotice);
  const button = document.querySelector("#save-election-button");
  const data = new FormData(form);
  const editingId = editingElectionId;
  const votingType = data.get("votingType") || document.querySelector("#election-type").value;
  const meetingId = editingId ? editingElectionMeetingId : data.get("meetingId");
  const agendaItemId = String(data.get("agendaItemId") || "") ||
    (state.liveMeetingId === meetingId ? state.liveRoomData?.session?.active_agenda_item_id || "" : "");
  setBusy(button, true, editingId ? "Saving…" : "Creating…");
  try {
    if (editingId) {
      if (votingType === "candidate") {
        await api(`/elections/${encodeURIComponent(editingId)}/candidates`, {
          method: "PUT",
          body: { candidateProfiles: await collectCandidateProfiles() }
        });
      }
      await api(`/elections/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        body: {
          title: data.get("title"),
          startsAt: new Date(data.get("startsAt")).toISOString(),
          endsAt: new Date(data.get("endsAt")).toISOString()
        }
      });
    } else {
      const candidateProfiles = votingType === "candidate" ? await collectCandidateProfiles() : null;
      const body = {
        title: data.get("title"),
        votingType,
        ...(data.get("startsAt") ? { startsAt: new Date(data.get("startsAt")).toISOString() } : {}),
        ...(data.get("endsAt") ? { endsAt: new Date(data.get("endsAt")).toISOString() } : {}),
        ...(agendaItemId ? { agendaItemId } : {}),
        ...(votingType === "candidate"
          ? { candidateProfiles }
          : votingType === "multiple_choice"
            ? { options: String(data.get("options")).split(/\r?\n/).map((option) => option.trim()).filter(Boolean) }
            : {})
      };
      await api(`/meetings/${encodeURIComponent(meetingId)}/elections`, { method: "POST", body });
    }
    electionDialog.close();
    resetElectionEditor();
    await refreshData();
    const inLiveRoom = state.liveMeetingId === meetingId;
    if (inLiveRoom) await refreshLiveRoom();
    if (editingId) {
      if (agendaDialog.open && agendaDialog.dataset.meetingId === meetingId) {
        renderAgenda(await api(`/meetings/${encodeURIComponent(meetingId)}/agenda`));
        showNotice(document.querySelector("#agenda-notice"), "Draft election updated.", "success");
      } else {
        showNotice(appNotice, "Draft election updated.", "success");
      }
    } else if (agendaItemId && agendaDialog.open) {
      renderAgenda(await api(`/meetings/${encodeURIComponent(meetingId)}/agenda`));
      showNotice(document.querySelector("#agenda-notice"), "Voting item created and linked to this agenda item.", "success");
    } else {
      if (!inLiveRoom) setView("voting");
      showNotice(inLiveRoom ? document.querySelector("#live-meeting-notice") : appNotice,
        inLiveRoom ? "Voting item created and announced in the meeting." : "Voting item created.",
        "success");
    }
  } catch (error) {
    showNotice(electionNotice, error.message);
  } finally {
    setBusy(button, false);
  }
});

async function initialize() {
  const locationUrl = new URL(window.location.href);
  const guestToken = locationUrl.searchParams.get("guest");
  const guestMeetingId = locationUrl.searchParams.get("meeting");
  if (guestToken && guestMeetingId) {
    locationUrl.searchParams.delete("guest");
    locationUrl.searchParams.delete("meeting");
    history.replaceState(null, "", `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`);
    try {
      const result = await api(`/meetings/${encodeURIComponent(guestMeetingId)}/guest-join`, {
        method: "POST",
        authenticated: false,
        body: { guestToken }
      });
      showVideoRoom(result.joinUrl, result.title, guestMeetingId, guestToken);
    } catch (error) {
      showNotice(loginNotice, error.message);
    }
  }
  if (!state.token) return;
  try {
    const user = await api("/me");
    showApp(user);
  } catch {
    sessionStorage.removeItem("meetvote-token");
    state.token = null;
  }
}

window.setInterval(updateElectionCountdowns, 1000);
void initialize();
