# Siro Docs — Condensed Reference

Summarized from docs.siro.ai (every sidebar page: Documentation, API References, Triggering Recordings). Written as a working reference, not a word-for-word copy. Original site: https://docs.siro.ai

---

## 1. Authentication (start here)

**Use "client apps."** One credential works on both Siro APIs. Older org API tokens and Siro OAuth apps still work but are being retired.

| API | Base URL | Header |
|---|---|---|
| Org-wide | `https://functions.siro.ai/api-externalApi/v1` | `Authorization: Bearer <token>` |
| User-scoped | `https://api.siro.ai/v1` | `x-siro-auth-token: <token>` |

**Retirement timeline (from client app release):**
- Release: client apps available; old tokens keep working.
- +30 days: no new org API tokens can be created.
- +9 months after that: org API tokens stop working.
- Siro OAuth apps: valid until a separate date is announced.

**Steps:**
1. Org admin creates a client app in the Siro web app → **API access** tab. Copy `client_id` + `client_secret` (secret shown once).
2. Get a token:
```bash
curl -X POST https://auth.siro.ai/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data grant_type=client_credentials \
  --data client_id=$CLIENT_ID \
  --data client_secret=$CLIENT_SECRET
```
Returns `access_token`, `token_type: bearer`, `expires_in` (~3600 sec). **No refresh token** — request a new one before it expires.

**Rate limit:** 1,000 requests per credential per minute.
**Support:** support@siro.ai · customersuccess@siro.ai

---

## 2. Data model

| Your system | Siro name | Notes |
|---|---|---|
| Sales rep (CRM row) | External User (`User`) | Send `externalId`, `email`, `name`. Auto-matched to a Siro User by email/name. |
| Rep's Siro login | Siro User (`userId`, `siroUserId`) | Manual match: People → Users → user → Integrations → Connect |
| Customer | `Account` | |
| Deal / lead | `Opportunity` | Amount + disposition |
| Appointment | `Engagement` | What gets recorded |
| Recording | `Recordings` | |

- `id` = Siro's internal ID. `externalId` = your CRM's ID (always pair with `integrationConnectionId`).
- Key link: **Recording ↔ Engagement ↔ Opportunity and/or Account.**

---

## 3. Custom CRM integration (quickstart)

Estimated 4–8 hours of dev work.

### Push data into Siro
**Sync appointments** — `PUT /integrations/sync/engagements` (org-wide)
```json
{
  "externalId": "appt-456",
  "startTime": "2026-02-15T14:00:00Z",
  "endTime": "2026-02-15T15:00:00Z",
  "subject": "Smith Consultation",
  "engagementType": { "activityType": "MEETING", "name": "meeting" },
  "engagementUsers": [{ "externalId": "rep-123", "email": "rep@co.com", "name": "John Sales" }],
  "account": { "externalId": "account-789" },
  "opportunity": { "externalId": "opp-101" }
}
```
- `activityType`: MEETING, CALL, APPOINTMENT, EMAIL, TEXT, EVENT. Only MEETING / APPOINTMENT / EVENT show in the rep's Appointment List.

**Sync opportunities** — `PUT /integrations/sync/opportunities`
Fields: `externalId`, `name`, `amount`, `closedAt`, `disposition` (e.g. `WON`), `account.externalId`, `opportunityUsers[]`.

**Accounts** sync automatically when nested in the above. Optional: `emailAddresses`, `phoneNumbers`, `addresses`.

### Pull data back out
**Option A — Webhooks (recommended)**
- Set up in Siro: Organization Admin Area → **Webhooks** → **+ Add Endpoint**. Subscribe to both:
  - `integrations.recordingProcessed` — processing finished (transcript, summary, extractions)
  - `integrations.recordingLinked` — recording firmly linked to a CRM record
- They can arrive in either order. Every payload carries both flags.
- **Rule: act only when `recordingProcessed` AND `recordingLinked` are both `true`.** Dedupe by `recordingId`.
- Verify with the Svix library (headers `svix-id`, `svix-timestamp`, `svix-signature`) using the endpoint's signing secret. Use the **raw** body.

Payload shape:
```json
{
  "recordingId": "...", "siroUserId": "...", "siroTeamId": "...",
  "recordingProcessed": true, "recordingLinked": true,
  "eventType": "integrations.recordingProcessed",
  "crm": {
    "integrationConnectionId": "...",
    "users": [{ "id": "...", "externalId": "..." }],
    "engagement": { "id": "...", "externalId": "appt-456" },
    "opportunity": { "id": "...", "externalId": "opp-101" },
    "account": { "id": "...", "externalId": "account-789" }
  }
}
```
Then call `GET https://api.siro.ai/v1/core/recordings/{id}?showSummary=true&showEntityExtractions=true` (header `x-siro-auth-token`).

**Option B — Polling**
- `GET /integrations/engagements/{id}` → returns `recordingId`
- `GET /core/entities/extractions/{recordingId}` (user-scoped) → extracted fields
- `GET /core/recordings/{recordingId}/summaries` → summary sections
- Or poll `GET /core/recordings?updatedAt:gte=<last poll>&showCrmLinks=true` (org-wide)
- Suggested cadence: every 10 minutes.

---

## 4. Recordings endpoints — key details

### Org-wide `GET /core/recordings` and `GET /core/recordings/{id}`
- Deleted recordings are **still returned** with `deleted: true` and `deletedAt`. Deleting bumps `updatedAt`.
- Opt-in flags (all off by default):

| Flag | Adds |
|---|---|
| `showCrmLinks` | `crm` block: `integrationConnectionId`, `users[]`, `engagement`, `opportunity`, `contacts[]`, `account`, `lead` — each `{id, externalId}` |
| `showSummary` | `summary[]` of `{id, name, content}` |
| `showEntityExtractions` | `entityExtractions[]` of `{name, value, mappings:[{crmModelName, crmFieldName}]}` (completed only) |
| `showFollowups` | List: `{id, score}`. Single: `followupId, score (1–5), status, followupAction, context[], thinking` |

- `crm` is `null` until a link is confirmed.
- `engagement` is only filled when linked to a **CRM-sourced** appointment (not a Siro-only calendar event).

### User-scoped `GET /core/recordings` (list)
- `limit` default/max 100, opaque `cursor`.
- Filters: `organizationId`, `teamId`, `conversationType`, `result` (`closed` / `not closed` / `in progress`), `dateCreated:gt|lt`, `crmLinkStatus=unlinked`, `orderBy`, `orderDirection`.
- Extras: `showCrmCustomer`, `showFollowups`, `showEvaluationScore`.

### Other recording endpoints
- `GET /core/recordings/{id}/utterances` — transcript lines, paginated.
- `POST /core/recordings/{id}/signedUrl` — empty body; returns a short-lived link to the **redacted** audio (usually .m4a).
- `PUT /core/recordings/{id}/link` — link to a CRM record. Body: `dataType` (ACCOUNT, CONTACT, LEAD, OPPORTUNITY, ENGAGEMENT) + **either** `id` (Siro internal) **or** `externalId` + `integrationConnectionId`. Optional `trigger`. Sending both/neither → 422.
- `DELETE /core/recordings/{id}/link` — remove a link (same body rules).

### Followups — `GET /core/followups`
- `limit` default 25, max 100; `cursor`.
- Filters: `statuses` (TO_DO, IN_PROGRESS, COMPLETE), `minimumScore` (1–5, default 3), `starred`, `createdAfter` / `createdBefore`, `includeHistory`, `excludeCrmCustomer`.

---

## 5. Phone call integration (VoIP → Siro)

Pipeline: **Notify** (call ended) → **Fetch** (download audio) → **Forward** (upload to Siro). Audio: mp3, aac, wav; max 100 MB. Shows in Siro within ~30 min.

**Step 1 — Get upload links:** `POST https://api.siro.ai/v1/core/recordings/signed-urls`
Body: `fileSizeInBytes` (or `fileSize`), `fileType`, optional `organizationId`.
Returns `uploadUrl`, `uploadHeaders`, `downloadUrl`, `expiresAt`.

**Step 2 — Upload:** `PUT` the file to `uploadUrl` with the exact `uploadHeaders`:
- `Content-Type`: mp3 → `audio/mpeg`, wav → `audio/wav`, aac → `audio/aac`
- `x-goog-content-length-range: 0,<fileSize>`
Wrong headers → 403 SignatureDoesNotMatch.

**Step 3 — Create recording:** `POST https://api.siro.ai/v1/core/recordings/upload` → 201 with `id`
| Field | Required? | Notes |
|---|---|---|
| `fileUrl` | Yes | The `downloadUrl` from step 1 |
| `fileType` | Yes | mp3 / aac / wav |
| `userId` / `userEmail` / `userPhone` | At least one | `userId` (Siro User UUID) is most reliable — look up via `GET /core/users` |
| `dateCreated` | No | Use the actual call time |
| `integrationConnectionId` + `crmObjects[]` | No (both or neither) | `{objectType, objectId}`; the object must already exist in Siro |
| `contactName` / `contactPhone` | No | Fallback for suggested CRM links |
| `title`, `organizationId`, `conversationType` | No | |

Get `integrationConnectionId` from `GET /core/integrations/connections`.

---

## 6. Scorecards

- **Raw metrics for one call:** `GET /core/scorecards/scorecard-metrics/values` with `requestedOrganizationId`, `conversationTypeId`, `startAt`, `endAt`, `filterBy=RECORDING`, `filterByIds=<recordingId>` (only first ID used). Returns `metricValues` and `recordingsEvaluatedCount`.
- **List available metrics:** `GET /core/scorecards/scorecard-metrics/available`
- **Saved scorecard report:** `GET /core/scorecards/instances` (needs `organizationId`; optional `conversationTypeId`, `isActive=true`) → pick `id` → `GET /core/scorecards/evaluated-instances/{id}` with `startAt`, `endAt`, `filterBy`, `filterByIds`.

| `filterBy` | `filterByIds` |
|---|---|
| RECORDING | recording ID(s) |
| USER | Siro user ID (also returns AI coaching "spotlights") |
| TEAM | team ID |
| ORGANIZATION | org ID |

Non-admins can only see their own team/user data.

---

## 7. Triggering recordings (deep links)

**Format:** `https://app.siro.ai/record?action={action}&redirectUrl={encodedUrl}`
- `action` (required): `start`, `stop` (ends fully, skips debrief), `restart`
- `title` — start only
- `conversationType` — UUID (not display name); start/restart; one-time override. Get UUIDs from `GET /core/conversation-configurations?organizationId=...` (use the `conversationType` field, not `id`).
- `redirectUrl` — URL-encoded. Prefer Universal Links / App Links; custom schemes need Siro whitelisting (contact vince@siro.ai; can take weeks).
- `integrationConnectionId` + `crmObjects` — URL-encoded array of `{objectType, objectId}`. Types: Lead, Account, Contact, Opportunity, Engagement, Event, ServiceAppointment.
- `opportunityId` / `jobId` — deprecated; use `crmObjects`.
- An in-progress recording is never interrupted; deep links skip debrief screens.
- Legacy mobile format: `siro://record?appointmentId=...&title=...&opportunityId=...`

---

## 8. Full endpoint list (64)

Paths below start after `/v1`. Org-wide = functions.siro.ai; user-scoped = api.siro.ai.

**Auth / client apps**
- POST `https://auth.siro.ai/oauth2/token` — get access token
- POST `/core/m2m-clients/{organizationId}/org-admin` — create org-admin client app (secret shown once)
- GET `/core/m2m-clients/{organizationId}` — list client apps (no secrets)
- POST `/core/m2m-clients/{organizationId}/{clientId}/rotate-secret` — new secret; old one works until next rotation; only the creator can rotate
- DELETE `/core/m2m-clients/{organizationId}/{clientId}` — revoke (permanent)
- GET `/core/auth/caller-identity` — info about current token

**Legacy org tokens** (being retired)
- GET `/core/auth/tokens` · GET `/core/auth/tokens/{id}` · POST `/core/auth/tokens` · DELETE `/core/auth/tokens/{id}`

**Legacy OAuth apps** (being retired)
- GET `/core/oauth/apps` · GET `/core/oauth/apps/{clientId}` · POST `/core/oauth/apps` · DELETE `/core/oauth/apps/{clientId}` (revokes all its tokens)
- GET `/core/oauth/apps/{clientId}/access-token` · GET `.../access-token/{tokenId}` · POST `.../access-token` · DELETE `.../access-token/{tokenId}`

**Organizations, users, teams**
- GET `/core/organizations` · GET `/core/organizations/{id}` · POST `/core/organizations` · PATCH `/core/organizations/{id}`
- GET `/core/users` · GET `/core/users/{id}` · POST `/core/users` (admins only) · PUT `/core/users/{id}`
- GET `/core/organizations/{orgId}/teams` · GET `.../teams/{teamId}` · POST `.../teams` · PATCH `.../teams/{teamId}` · DELETE `.../teams/{teamId}` (hard delete)

**Integration connections**
- GET `/core/integrations/connections` (filter by platform) · GET `/{id}` · POST · PATCH `/{id}` · DELETE `/{id}`
- PUT `/core/integrations/salesforce` — upsert Salesforce auth details

**CRM data (integrations)**
- Accounts: GET / POST `/integrations/accounts` · DELETE `/integrations/accounts/{id}`
- Engagements: GET `/integrations/engagements` · GET / DELETE `/{id}` · PUT `/integrations/sync/engagements`
- Engagement users: GET / POST `/integrations/engagement-users` · GET / PUT / DELETE `/{id}`
- Opportunities: GET `/integrations/opportunities` · GET / DELETE `/{id}` · PUT `/integrations/sync/opportunities`
- Opportunity users: GET / POST `/integrations/opportunity-users` · GET / PUT / DELETE `/{id}`

**Recordings & insights**
- GET `/core/recordings` · GET `/core/recordings/{id}` (both org-wide and user-scoped versions)
- GET `/core/recordings/{id}/summaries` · GET `/core/recordings/{id}/utterances`
- POST `/core/recordings/{id}/signedUrl` (download redacted audio)
- POST `/core/recordings/signed-urls` · POST `/core/recordings/upload`
- PUT / DELETE `/core/recordings/{id}/link`
- GET `/core/entities/extractions/{recordingId}`
- GET `/core/followups`
- GET `/core/conversation-configurations`
- GET `/core/scorecards/instances` · GET `/core/scorecards/evaluated-instances/{id}`
- GET `/core/scorecards/scorecard-metrics/available` · GET `/core/scorecards/scorecard-metrics/values`

**Other**
- GET `/core/mobile-events` · GET `/core/mobile-events/{id}`
- GET `/audit/logs`

**Webhooks (Siro → you):** `integrations.recordingLinked` (crm always filled) · `integrations.recordingProcessed` (crm filled if already linked)

---

## 9. Native integrations (setup summaries)

**CRMs:** Salesforce, HubSpot, Improveit360, LeadPerfection, Microsoft Dynamics, Pipedrive, Zoho
**DMS (auto dealers):** Auto/Mate, CDK Drive, Dealertrack, PBS, Tekion
**Other:** CompanyCam, Hatch, Ingage, Leap SalesPro, Paradigm Vendo, SalesRabbit

### LeadPerfection
Syncs LP appointments into Siro, autofills LP fields from transcripts, pushes AI summaries/notes into LP. Syncs every 10 minutes.
1. In LP: **Security → Employees** → add user "Siro" (first, last, username). **Security → Passwords** → set a password.
2. **Security → User Access** → edit Siro row → Function Level Security → **API Security** → enable: `GetSalesApptDetailDateRange` (fetch appointments), `GetSalesApptDispProd` (timezone), `AddNotes` (write notes). All three are required.
3. Each rep must be enabled at the account level in LP.
4. In Siro: **Admin → Integrations → New Integration → Lead_Perfection**. Enter username, password, and Client ID (the prefix before `.leadperfection.com`). Custom LP domain → tell your CSM.

### SalesRabbit
Links each recording to the nearest pin (GPS where the recording **ended**) by writing a link into the pin notes. Needs a tier above Basic and Admin/Owner role. Repeat visits overwrite the link.
1. Settings → Custom Lead Fields → API → field titled `siro` (lowercase).
2. Settings → Connectors → Create New: App Connect, name "Listen in Siro", Connected to Lead = Required, whole-org visibility, URL `https://app.siro.ai/link/?link=https%3A%2F%2Fapp.siro.ai%2Fanalyze%2F{lead.customFields.siro}`
3. Integrations → API → API Token → copy.
4. Siro → Integrations → **+ New Legacy Integration** → Sales Rabbit → paste token.
5. Each rep links their own account in Siro settings — email search is **case-sensitive**.

### Salesforce
Two parts: install the Siro Salesforce package, then finish in the Siro Setup Assistant using client app credentials. Needs System Admin; admin email must match the Siro email. Integration user needs API access to User, Account, Contact, Lead, Opportunity, Event, Task (and ServiceAppointment + a Field Service license if used). One SF org can connect to multiple Siro orgs (Setup Assistant → System Connections → Add Connection).

### HubSpot, Pipedrive, Zoho, Microsoft Dynamics, Improveit360 (via Merge)
Same pattern: contact Siro CSM → open the Merge "magic link" (must say "Siro.ai"; expires ~7 days) → authorize → data in 1–2 hours. User emails must match between systems.
- **HubSpot:** read Users, Contacts, Companies, Deals, Leads, Engagements, Appointments; write scopes `crm.objects.companies/contacts/deals/line_items.write`. HubSpot Companies = Siro Accounts.
- **Pipedrive:** Deals, Persons, Organizations, Activities, Users.
- **Zoho:** Meetings, Leads, Contacts, Accounts, Deals, Users. Link Meetings to records for best matching.
- **Dynamics 365:** admin-level; BookableResourceBookings, BookableResources, WorkOrders, Opportunities, Contacts, Accounts, Leads. Confirm config with CSM first.
- **Improveit360:** Salesforce admin for the i360 org; use the Merge OAuth login (don't type credentials into a form; don't add Siro as a Connected App manually). Classic uses `i360_Appointment__c`; Lightning uses `i360core__Sales_Appointment__c` (recording link lands in `i360core__Recording_Link__c`).

### Others
- **CompanyCam:** jobsite photos appear as bookmarks in transcripts (matched by time + identical email). Admin → Integrations → New → CompanyCam.
- **Ingage:** slides shown appear as bookmarks. Copy API key from Ingage (Manage → Company → Integrations → Public API Keys) → paste in Siro, name it "Ingage".
- **Hatch:** uses Siro's extracted fields for follow-up texts; one-way. Needs a connected CRM first (Salesforce, HubSpot, Dynamics, i360, LeadPerfection, ServiceTitan). Set up by CSMs (~24 hrs).
- **Leap SalesPro / Paradigm Vendo:** a Siro button inside the app starts recording and returns the rep afterward. No data sync. Leap is set up in Leap's admin; Vendo via Manage → Offices → Integrations → Siro.ai.
- **DMS (Auto/Mate, CDK, Dealertrack, PBS, Tekion):** sync deals, repair orders, service appointments, customers, employees. Set up per rooftop via CSM forms or vendor portals. CDK syncs once daily.

---

**Note:** The per-endpoint field-by-field schemas (shown in the "Try it" panels) come from Siro's OpenAPI files and are only partly captured above. Check the live page for any endpoint you build against.

---

## Events we emit (LP-MCP, added 2026-10-16)

`siro.recording_processed` — once per recording (idempotency key `siro:<recording_id>`), only in live
mode (`SIRO_WEBHOOK_MODE` / `SIRO_SYNC_MODE`), and only when the recording is processed AND matched to
an LP lead. Payload:

```json
{ "recording_id": "...", "lp_lead_id": "...", "lp_prospect_id": "...", "ghl_contact_id": "...",
  "rep_name": "...", "result": "closed | not closed | in progress", "followup_score": 1-5,
  "objections": ["price", "spouse"], "interests": ["..."],
  "match_method": "engagement | account | opportunity | phone | none" }
```

Rule examples (commented out): `sql/seeds/2026-10-16_siro_rules_EXAMPLES.sql`.
