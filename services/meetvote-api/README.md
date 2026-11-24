# Elawini Estate MeetVote API

This service owns Elawini identity, sessions, meeting guest links, election-specific eligibility and audit events. It provisions meeting records, candidate assignments and secret polls through private OpenSlides services; it does not expose OpenSlides credentials to the browser.

OpenSlides remains the source of truth for ballots, election results and anonymous vote storage. Each eligible resident is provisioned a separate, election-scoped OpenSlides voting identity; its random password is encrypted in MeetVote's database with `OPENSLIDES_VOTER_PASSWORD_KEY`. Keep this key stable and private because existing voter credentials cannot be recovered if it changes. Ballot selections are submitted directly to OpenSlides and are never stored alongside MeetVote resident IDs. MeetVote stores only whether a resident has used their ballot and the aggregate published tally. plugNmeet remains the source of truth for video sessions.

## Local start

```powershell
Copy-Item .env.example .env
npm start
```

The first local administrator is created once through `POST /auth/bootstrap`. Turn `BOOTSTRAP_ADMIN_ENABLED` off before any shared or production deployment.

If the existing administrator cannot sign in, reset its password from the API service directory in an interactive terminal:

```powershell
npm run reset-admin-password
```

The command asks for the administrator email and a new password without echoing the password, requires confirmation, and records the reset in the audit log. For a Docker deployment, run `docker compose -f infrastructure/meetvote-api-local/docker-compose.yml exec meetvote-api npm run reset-admin-password` from the workspace root.

Start the resident-facing web app in a second terminal:

```powershell
cd apps/web
npm start
```

Open `http://localhost:3000`. To run both services with Docker, run the compose file in `infrastructure/meetvote-api-local`; the database is stored in the `meetvote-data` Docker volume.

The web app is the Elawini Estate MeetVote entry point. Meetings are provisioned in both OpenSlides and plugNmeet. The meeting room combines the video conference with a live agenda and voting panel: organisers can start and end a live session, advance the active agenda item, announce an existing or newly created voting item, and open or close voting. Participants see the active item in the room and eligible residents submit ballots there. Guests can follow the agenda and announced item but cannot vote.

## Meeting agendas and motions

Meeting organisers and administrators can add agenda items from a meeting's **Agenda & motions** view or from the live meeting panel. Each item has a title, optional description, and a `pending`, `in_progress`, or `completed` status; items are numbered in the order they are added. During a live session, organisers can select the current item or advance to the next one; selecting a new item completes the previous one, and participants and guests see the selection update automatically. Organisers can also add a motion with a title and text, optionally linking it to an agenda item. Residents can view the agenda and motions but cannot edit them.

The API exposes `GET /meetings/:id/agenda`, `POST /meetings/:id/agenda` (`title`, optional `description`), `PUT /meetings/:id/agenda/:itemId/status` (`status`), and `POST /meetings/:id/motions` (`title`, `text`, optional `agendaItemId`). `GET /meetings/:id/live` returns the active live session. Organisers use `POST /meetings/:id/live` with `action: "start"` or `"end"`, `PUT /meetings/:id/live/agenda` to select an agenda item, and `PUT /meetings/:id/live/voting-item` to announce an existing election. Elections linked to an agenda item can only be announced or opened while that item is active, and agenda changes are rejected while its vote is open. Starting or ending a session, changing agenda status or the active agenda item, and announcing a voting item are audit logged.

Meeting participants can view and download private meeting PDFs. Organisers and administrators can upload or remove PDFs from the agenda view; files are stored in the MeetVote database and are not exposed through the public static web server. Uploads are limited to valid PDF files up to 8 MB. The API provides `GET /meetings/:id/documents`, `POST /meetings/:id/documents` (`fileName`, `mimeType: "application/pdf"`, and base64 `contentBase64`), `GET /meetings/:id/documents/:documentId`, and `DELETE /meetings/:id/documents/:documentId`.

## Attendance, live questions, and reports

Registered residents can check in while a meeting is live. The meeting room sends a short-lived presence heartbeat while a resident has the room open; organisers and administrators can see checked-in and currently online names, while residents only see aggregate counts and their own check-in. Before voting can open, at least 25% of eligible Units/Erfs must be represented by an online owner or verified proxy, and at least three registered attendees must be online. The meeting room provides a 15-minute grace period and administrators or organisers can adjourn a meeting that still lacks quorum, rescheduling it within 15 business days. The API exposes `GET /meetings/:id/attendance`, `GET /meetings/:id/quorum`, `POST /meetings/:id/attendance/check-in`, `POST /meetings/:id/presence`, and `POST /meetings/:id/quorum/adjourn`.

Administrators maintain the estate voting register in **Accounts → Members and Units/Erfs** or through `GET /hoa/membership`, `POST/PUT /hoa/members`, `POST/PUT /hoa/units`, and `PUT /hoa/voting-config`. A Unit/Erf can have co-owners but contributes one base vote; it can only be eligible while every active co-owner is in good standing. The development-period setting requires an active Developer Member in good standing.

Meeting organisers and administrators manage proxy appointments with `GET/POST /meetings/:id/proxies`, upload the signed instrument and required Member ID/entity authorization documents with `PUT /meetings/:id/proxies/:proxyId/documents`, and approve or reject appointments with `PUT /meetings/:id/proxies/:proxyId/verify`. Private proxy files are limited to PDF/JPEG/PNG files up to 5 MB, encrypted in the MeetVote database, and can only be downloaded by meeting managers. Set a stable `PROXY_DOCUMENT_ENCRYPTION_KEY` of at least 32 characters in the deployment secret manager before uploading proxy documents; keep it private and do not rotate it while documents remain stored.

Residents can submit questions during a live meeting, optionally anonymously. Questions remain private to the author and organisers until published; organisers can publish, answer, or dismiss them. `GET /meetings/:id/questions` returns only public questions and the current resident's own pending questions, unless the caller manages the meeting. `POST /meetings/:id/questions` submits a question, and organisers moderate with `PUT /meetings/:id/questions/:questionId` using `status: "published"`, `"answered"`, or `"dismissed"`.

The **Reports** view downloads a CSV meeting summary with attendance counts, agenda items, motions, published questions and answers, and aggregate election results. Reports never include individual ballots or voter identities. `GET /meetings/:id/report` is available to meeting participants and returns a base64-encoded CSV.

Meetings include a description, meeting type (`general`, `agm`, `committee`, or `special`), organiser, and chairperson. `POST /meetings` accepts optional `description`, `meetingType`, and `chairpersonId`; omitted values default to an empty description, a community meeting, and the creating user as chairperson. Administrators and meeting organisers can load chairperson choices from `GET /users/meeting-chairpersons`; the endpoint returns names and roles only.

## OpenSlides connection

For local API development, copy `.env.example` to `.env` and run the API from this directory. The default password-file path points to the local OpenSlides stack's internal action password. Configure `OPENSLIDES_COMMITTEE_ID` and `OPENSLIDES_ADMIN_ID` to IDs that exist in that OpenSlides instance before creating meetings. Meeting or candidate-election creation fails explicitly if the internal service is not configured or rejects an action; MeetVote will not silently create a local-only meeting or poll.

The API Docker Compose file mounts the OpenSlides internal password as a read-only Compose secret and connects to the private backendManage port. Poll start/stop use OpenSlides' authenticated public action route as the configured superadmin because those actions also need to authenticate with the vote service; the password is mounted as a Compose secret and is never sent to residents' browsers. When MeetVote closes a poll, it asks OpenSlides to preserve the temporary ballot data until MeetVote retrieves the aggregate tally, then clears it. Set the committee and administrator IDs in the Compose environment if they differ from the defaults.

The local OpenSlides Compose stack builds a pinned 4.3.7 backend from `third_party/openslides/openslides-backend`. MeetVote uses public `user.assign_meetings` and `poll.create` actions to provision voters and candidate options; the local backend patch returns meeting-user and group IDs so polls can be restricted to the same group as eligible voters. Development mode remains disabled. Rebuild and recreate all backend components after changing the patch with `docker compose -f infrastructure/openslides-local/docker-compose.yml up -d --build backendAction backendPresenter backendManage`.

For ballot support, configure a stable random `OPENSLIDES_VOTER_PASSWORD_KEY` of at least 32 characters. The local Compose setup puts the MeetVote API on OpenSlides' private Docker network and reaches auth and voting at `http://auth:9004` and `http://vote:9013`; those services are not exposed to Windows or residents. Compose now refuses to start the API if this key is missing. When using Docker Compose, supply it in the shell environment or Compose's interpolation `.env` file; the API's `services/meetvote-api/.env` is not loaded by Compose automatically. For running the API directly with Node, set `OPENSLIDES_AUTH_URL` and `OPENSLIDES_VOTE_URL` to addresses reachable by that host and keep the key in the ignored local `.env` or deployment secret manager. Generate a key once with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and store it privately. Do not rotate or regenerate it while elections have voter accounts; existing encrypted voter credentials cannot be recovered with a different key.

## Live meetings

The API connects to the private plugNmeet HTTP API using `PLUGNMEET_API_URL`, `PLUGNMEET_API_KEY` and `PLUGNMEET_API_SECRET`. Configure the key and secret to match the plugNmeet server; keep them in the ignored local `.env` or your deployment's secret manager, never in browser configuration. `PLUGNMEET_CLIENT_URL` is the address residents' browsers use to load the meeting client; it is allow-listed by the web app's Content Security Policy and Permissions Policy. For the local HTTPS Compose setup, the client is served at `https://172.20.10.8:3000/meeting/` so it shares the MeetVote origin; its API remains at `https://172.20.10.8:8444`. The HTTPS proxy also serves plugNmeet translation files under `/locales/`, as its client requests locale resources from the site root; regional English requests such as `/locales/en-US/translation.json` are mapped to the bundled English translation. This lets iOS use the camera and microphone inside the meeting dialog while keeping the agenda and voting panel in the same view. Do not apply a stricter camera or microphone policy at the proxy: browsers intersect policies, which can silently block access in the embedded meeting client.

Set `MEETVOTE_PUBLIC_URL` to the public Elawini portal origin so generated guest invitations point to the right address. Guest invitations expire after 24 hours by default, can be given an explicit future expiry through the API, and grant video access only—not a MeetVote account or voting rights. Recording is disabled unless `PLUGNMEET_RECORDING_ENABLED=true` and recording is enabled/configured on the video service.

The room is embedded in the Elawini portal. The self-hosted plugNmeet client may still display its own required notices or branding; this integration does not remove upstream attribution.

## Testing on a phone and PC over Wi-Fi

The local Compose configuration currently advertises `172.20.10.8`. Camera and microphone access requires HTTPS on phones and PCs, so generate a local certificate before starting the HTTPS proxy:

```powershell
.\infrastructure\local-tls\generate-cert.ps1 -IpAddress 172.20.10.8 -Force
docker compose -f infrastructure\meetvote-api-local\docker-compose.yml up -d
docker compose -f infrastructure\plugnmeet-local\docker-compose.yml up -d
```

Install `infrastructure/local-tls/certs/rootCA.crt` as a trusted root certificate on the PC and phone, then open `https://172.20.10.8:3000` on both devices. The HTTPS proxy serves MeetVote and the embedded meeting client path on port 3000, plugNmeet API on 8444, NATS WebSocket on 8445, and LiveKit signaling on 8446; WebRTC media continues over TCP 7881 and UDP 7882. The API remains available on host port 8090 for local development. This private development CA is only for devices you control; do not use it as a production certificate or share its private key.

On Windows, import the root certificate into the current user's **Trusted Root Certification Authorities** store. On Android, copy the certificate to the phone and use **Settings → Security → Encryption & credentials → Install a certificate → CA certificate** (menu names vary by device). If Windows Firewall blocks phone access, run this from an elevated PowerShell prompt to allow the HTTPS ports from the local subnet only:

```powershell
New-NetFirewallRule -DisplayName "Elawini MeetVote HTTPS LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000,"8444-8446" -RemoteAddress LocalSubnet -Profile Private,Public
```

If the computer's Wi-Fi address changes, rerun the certificate script with the new IP and `-Force`; the existing trusted local CA is retained. Update the LAN address in the MeetVote Compose file, plugNmeet Compose/config, and `client/dist/assets/config.js`, then restart both Compose stacks. Permit the existing media ports TCP 7881 and UDP 7882 through the computer firewall for the local subnet only. Guests can join from the phone but cannot vote.

## Voting rule

Organisers and administrators can create candidate elections, For/Against/Abstain resolutions, and multiple-choice votes. Create them through `POST /meetings/:id/elections` with `votingType` set to `candidate`, `resolution`, or `multiple_choice`; candidate names use `candidates`, while multiple-choice options use `options`. During a live session, omitted `startsAt` and `endsAt` default to now and two hours later, and the item is announced against the active agenda item. Existing scheduled elections can also be selected and announced from the meeting panel.

Organisers and administrators manage eligible voters through `GET /elections/:id/eligibility` and `PUT /elections/:id/eligibility` (`userIds`). The roster contains registered residents only; eligibility is locked once an election is opened. Voting can be opened only during its scheduled period and after at least one resident is assigned. `GET /elections/:id/voting-authorisation` and `POST /elections/:id/ballot` enforce the role, eligibility, schedule, active meeting item, and one-vote rules on the server. Guest links and organiser accounts cannot vote.

Eligible residents submit one confidential choice through `GET /elections/:id/ballot` and `POST /elections/:id/ballot` (`candidateIndex`). MeetVote authenticates the resident's private OpenSlides voting identity and forwards the ballot to the OpenSlides Vote Service. OpenSlides' pseudoanonymous poll stores selections; MeetVote retains no choice linked to a resident. During voting, turnout counts are available to meeting organisers and administrators only, without ballot selections. Opening and closing timestamps and meeting-control changes are audit logged. Elections close automatically when their scheduled end time passes, including after an API restart; the Elections page and live meeting panel show a countdown while voting is open. Closing an election stops the OpenSlides poll, reads anonymous ballots, publishes aggregate results through `GET /elections/:id/results` and the Results page, and records the turnout. The Results page groups published elections by meeting, with a summary and separate vote breakdown for every completed election; a single-winner candidate race highlights the winner and profile photo. If the external voting service cannot return results at expiry, MeetVote still closes voting and records that results are unavailable rather than publishing a fabricated tally. A live meeting cannot be ended while a voting item remains open.

Organisers and administrators can create full-screen election setups, save reusable templates, and edit draft elections before they open. Templates store a name, title, vote type, and multiple-choice options for future meetings; candidate names and profiles are entered separately for each election. Candidate photos are optional; the default portrait is shown when a photo is not available. Use `GET /election-templates`, `POST /election-templates`, `PUT /election-templates/:id`, and `DELETE /election-templates/:id` to manage templates. `PUT /elections/:id` updates a draft's title and schedule, while `PUT /elections/:id/candidates` updates candidate profile details and order before the scheduled start. Once created, ballot choices and candidate names cannot be changed; create a new election from a template instead. Elections that are open or closed are not editable.

The local database migration creates `election_voters` for encrypted, per-election OpenSlides credentials and `election_votes` for one-vote enforcement. The latter records participation only; it contains no candidate choice. Result publication stores aggregates only, and the API discards the user-ID list returned separately by OpenSlides' vote service.
