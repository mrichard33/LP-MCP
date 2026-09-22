# Five9 Admin API v13 — operation classification

<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: src/five9/op-registry.js (OP_CLASSIFICATION) + src/five9/wsdl-schema.json
     Regenerate: node scripts/five9-gen-op-classification.js
     Verified in CI by scripts/test-five9-op-registry.js -->

Every operation in the v13 Admin API, classified. Generated from
`src/five9/wsdl-schema.json` (v13.0.00/13, sha256 `0da5d331d368…`,
extracted 2026-08-20) — **182 operations, 560 complexTypes**.

## Why this document exists

Before it, the answer to "can we automate X in Five9?" was a research project
per operation: find the op, transcribe its `xs:sequence` by hand, discover its
guards, wire six touch-points. Roughly a day each, and 24 action types deep the
list of what we had *decided about* was shorter than the list of what *exists*.

The tier list that came out of earlier planning was derived from a v9.5-era
reference and did not survive contact with the v13 schema. It named four
operations that do not exist:

| named | reality in v13 |
|---|---|
| `getCallLogReport`, `getCallLogReportCsv` | do not exist — and were listed as already implemented |
| `getAgentAuditReport`, `getAgentAuditReportCsv` | do not exist; the string "audit" appears nowhere in the 961 KB WSDL, so **the Admin API has no audit-trail operation at all** |
| `resetListPositions` | the real name is `resetListPosition`, singular |

It also left 57 operations unclassified, including two feature areas nobody had
looked at: **speed dial** and **IVR icons / script ownership**.

**The schema is the authority.** Every operation name below is a key in
`wsdl-schema.json`; nothing survives here that the artifact does not contain.

## How to read the tiers

The line between `enabled` and `gated` is about the **payload**, not about risk.

| tier | meaning |
|---|---|
| `enabled` | Registered; `approve_action` alone clears it. Guards still run and can refuse — an INBOUND target, a campaign already RUNNING — but the caller needs no extra ceremony in the payload. |
| `gated` | Registered, and the payload must carry something **more** than the approval: a `confirm_token` restating the target, a `compliance_override` plus `legal_basis`, or a declared record count. A gated op can refuse an already-approved action. |
| `denied` | Must not be registered, ever. Every denied row carries a specific reason. Enforced by test — `scripts/test-five9-op-registry.js` fails if a denied operation acquires an action type or a reachable handler. |
| `skip` | Not a registry candidate. Every **read** is `skip` — a read is a direct MCP tool, never an approvable agent action. A **write** is `skip` when it is redundant with something already shipped, or has no identified use. |

`status` is `shipped` when the operation is reachable today (as a `five9_*`
action type, or as a reader in `src/five9-admin.js`), `not-built` otherwise.

## Counts

| | count |
|---|---|
| operations in v13 | **182** |
| reads | 59 |
| writes | 123 |
| `enabled` | 19 |
| `gated` | 45 |
| `denied` | 39 |
| `skip` | 79 |
| shipped today | 80 |
| registered action types | 38 |

**No new operation is registered by this PR.** The registry ships seeded with
exactly the 38 action types that already existed, and one of them —
`five9_create_campaign_profile` — migrated onto `buildFromSchema`.
Tiers below are the *proposal* for later tranches, not a description of what is
live. Each tranche is its own reviewable PR against a builder that has already
proven itself.

## Open questions for Mark

Two feature areas were never considered before this pass. They are classified
here from first principles and flagged rather than decided:

- **Speed dial** — `createSpeedDialNumber`, `getSpeedDialNumbers`,
  `removeSpeedDialNumber`. The schema shows `{code, number, description}`: an
  agent-desktop dialling shortcut with no routing or compliance effect.
  *Proposed `skip`* — no agentic need identified.
- **IVR icons and script ownership** — `getIvrIcons`, `setIvrIcons`,
  `removeIvrIcons`, `getIvrScriptOwnership`, `setIvrScriptOwnership`,
  `removeIvrScriptOwnership`. Icons are the visual representation of a script
  in the IVR designer, with no runtime effect. Ownership reads as an
  access-control grant from its name, but the schema shows a single
  `othersCanCopy` boolean — it governs whether other admins may **copy** a
  script, not who may edit or run it. *Proposed `skip`* for both.

## All 182 operations

Sorted by name. A registered operation shows its action type beneath it.

| operation | kind | tier | status | reason |
|---|---|---|---|---|
| `addDispositionsToCampaign`<br>→ `five9_add_dispositions_to_campaign` | write | **gated** | shipped | Shipped as five9_add_dispositions_to_campaign: confirm_token restating the campaign name, refuses an unknown disposition. The one composition op with NO RUNNING refusal — adding a disposition is additive, widening what an agent can select, and cannot change how any existing call is counted. That asymmetry with removal is deliberate. |
| `addDNISToCampaign`<br>→ `five9_add_dnis_to_campaign` | write | **gated** | shipped | Shipped as five9_add_dnis_to_campaign: REFUSES a number currently assigned to a different campaign without compliance_override, because reassigning a live number silently re-routes a marketing line and breaks its attribution. |
| `addListsToCampaign`<br>→ `five9_add_lists_to_campaign` | write | **gated** | shipped | Shipped as five9_add_lists_to_campaign: confirm_token restating the campaign name, refuses while RUNNING, and refuses a list name that does not exist — Five9 accepts an unknown list silently and the campaign then dials nothing from it. |
| `addNumbersToDnc`<br>→ `five9_add_numbers_to_dnc` | write | **enabled** | shipped | Shipped as five9_add_numbers_to_dnc. DNC is ADD-ONLY by ruling. |
| `addPromptTTS`<br>→ `five9_create_prompt_tts` | write | **enabled** | shipped | Shipped as five9_create_prompt_tts — a new TTS prompt is referenced by nothing until a script points at it. |
| `addPromptWav` | write | **skip** | not-built | Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need. |
| `addPromptWavInline` | write | **skip** | not-built | Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need. |
| `addRecordToList`<br>→ `five9_add_records_to_list` | write | **enabled** | shipped | Shipped as five9_add_records_to_list, capped at MAX_RECORDS_PER_ACTION (50) per action. |
| `addRecordToListSimple` | write | **skip** | not-built | Still not built, but NOT for the reason recorded here until 2026-09-04 ("redundant with addRecordToList; no new capability"). It is not redundant: its listUpdateSimpleSettings is the ONLY settings type carrying callAsap, so it is the only op that could enter the Dial ASAP queue by that name. It stays unbuilt because addRecordToList reaches the same outcome through listUpdateSettings.callNowMode (NONE \| NEW_CRM_ONLY \| NEW_LIST_ONLY \| ANY), which the shipped builder now emits for the callback push. If a future need wants callAsap or timeToCall semantics specifically, this is a real capability gap, not a duplicate. |
| `addSkillAudioFile` | write | **skip** | not-built | Audio asset management; a Five9-UI task with no agentic path that produces the file. |
| `addSkillsToCampaign`<br>→ `five9_add_skills_to_campaign` | write | **gated** | shipped | Shipped as five9_add_skills_to_campaign: confirm_token restating the campaign name, refuses while RUNNING, refuses an unknown skill name. |
| `addToList` | write | **gated** | not-built | Guard: confirm_token restating the list name plus expected_record_count — inline bulk add, reviewable at approval time. |
| `addToListCsv` | write | **gated** | not-built | Guard: confirm_token restating the list name plus expected_record_count; the CSV rides inline, so the approver can see what is being added. |
| `addToListFtp` | write | **denied** | not-built | The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written. |
| `asyncAddRecordsToList` | write | **gated** | not-built | The bulk sibling of add_records_to_list — guard: confirm_token restating the list name plus expected_record_count, mirroring async_delete. NOTE: buildAsyncAddRecordsToListXml already ships, but only to describe the ROLLBACK for async delete; no action type reaches it. |
| `asyncDeleteRecordsFromList`<br>→ `five9_async_delete_records_from_list` | write | **gated** | shipped | Shipped as five9_async_delete_records_from_list: confirm_token restating the list name, a declared expected_record_count, and refusal above FIVE9_MAX_LIST_DELETE or >50% of the list without compliance_override. |
| `asyncUpdateCampaignDispositions` | write | **gated** | not-built | Guard: confirm_token restating the campaign name plus an expected_count, same shape as async_delete_records_from_list — this is the bulk form of a payroll-sensitive change. |
| `asyncUpdateCrmRecords` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. |
| `checkDncForNumbers` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `closeSession` | write | **skip** | not-built | Session lifecycle, not a configuration mutation — the SOAP client manages its own sessions. |
| `createAgentGroup` | write | **enabled** | not-built | A new agent group contains nobody and routes nothing until a separate approved action populates it. |
| `createAutodialCampaign` | write | **denied** | not-built | Reece does not run autodial campaigns (carried-forward ruling, covers the whole autodial family). |
| `createCallVariable` | write | **gated** | not-built | Guard: confirm_token restating the variable name, and refuse a name colliding with an existing variable — call variables are the payload IVR scripts and agent screens read. |
| `createCallVariablesGroup` | write | **gated** | not-built | Guard: confirm_token restating the group name; a group is the namespace call variables resolve within. |
| `createCampaignProfile`<br>→ `five9_create_campaign_profile` | write | **enabled** | shipped | Shipped as five9_create_campaign_profile. FIRST OPERATION MIGRATED ONTO buildFromSchema (PR3) — a new profile is attached to nothing until a separate approved patch moves a campaign onto it. |
| `createContactField` | write | **gated** | not-built | Guard: confirm_token restating the field name, and refuse a name that collides with an existing field — a contact field is the schema every list import maps onto. |
| `createDisposition` | write | **gated** | not-built | Guard: confirm_token restating the disposition name, and refuse a name colliding with an existing one — CC payroll bonus math keys on disposition NAMES. |
| `createInboundCampaign`<br>→ `five9_create_inbound_campaign` | write | **enabled** | shipped | Shipped as five9_create_inbound_campaign; requires action_payload.script_name because Five9 refuses to create one with a null defaultIvrSchedule. |
| `createIVRScript`<br>→ `five9_create_ivr_script` | write | **enabled** | shipped | Shipped as five9_create_ivr_script. createIVRScript takes ONLY <name>, so the executor owns the create→modify seam and compensates with deleteIVRScript when the second call fails. |
| `createList`<br>→ `five9_create_list` | write | **enabled** | shipped | Shipped as five9_create_list, the only `enabled` op in the PR4 tranche: a new list is empty and attached to nothing, so it cannot dial anyone or change what any campaign dials. Populating it (five9_add_records_to_list) and attaching it (five9_add_lists_to_campaign) are the gated steps. Creating one that already exists is a skipped no-op, not a refusal. |
| `createOutboundCampaign`<br>→ `five9_create_outbound_campaign` | write | **gated** | shipped | Shipped as five9_create_outbound_campaign: confirm_token restating the new campaign name, refuses a name that already exists (campaign names key DNIS→source attribution), refuses unless campaign.profileName names an existing campaign profile (Five9 accepts an unresolvable profile and the campaign then silently fails to dial), and creates only with state=NOT_RUNNING — an explicit RUNNING in the payload is a refusal, not something to overwrite. Starting it is five9_start_campaign, separately approved. |
| `createReasonCode` | write | **gated** | not-built | Guard: confirm_token restating the reason code name — adherence reporting keys on the name, the same hazard that denies renameDisposition. |
| `createSkill` | write | **enabled** | not-built | A new skill routes nothing until a separate approved action assigns it to a user or campaign. |
| `createSpeedDialNumber` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. Schema is {code, number, description} — an agent-desktop dialling shortcut with no routing or compliance effect. Proposed skip: no agentic need identified. |
| `createUser` | write | **gated** | not-built | Guard: confirm_token restating the user name, plus the Guardrail 12 role check — a new user carrying admin or supervisor needs compliance_override AND a written legal_basis. |
| `createUserProfile`<br>→ `five9_create_user_profile` | write | **gated** | shipped | Shipped as five9_create_user_profile: confirm_token restating the profile name plus Guardrail 12 on any submitted roles block granting admin or supervisor. |
| `createWebConnector`<br>→ `five9_create_web_connector` | write | **gated** | shipped | Shipped as five9_create_web_connector. Ruled allowed 2026-08-21; PR3’s denial (“there is no destination allow-list”) is ANSWERED, not waived — Guardrail 13 is that allow-list. confirm_token restating the connector name; https-only; hostname must EXACTLY match a FIVE9_WEBCONNECTOR_ALLOWED_HOSTS entry (no suffix matching); embedded credentials, non-standard ports and IP-literal hosts refused; the same check applied to every value in constants / postConstants / variables / postVariables / startPageText, because a second destination hidden in a POST constant defeats a check that only reads url. Unset env var means an EMPTY allow-list, which refuses everything — never “allow all”. Deliberately NO compliance_override path: an override would reintroduce the arbitrary-URL hole one approved action at a time. If Guardrail 13 is ever weakened, this row goes back to denied. |
| `deleteAgentGroup` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteAllFromList` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteCallVariable` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteCallVariablesGroup` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteCampaign` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteCampaignProfile` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteContactField` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteFromContacts` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteFromContactsCsv` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteFromContactsFtp` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written. |
| `deleteFromList` | write | **skip** | not-built | asyncDeleteRecordsFromList already ships with the volume ceiling, proportion guard and declared-count check; a second bulk-delete path would need all three re-implemented to be equally safe. |
| `deleteFromListCsv` | write | **skip** | not-built | Redundant with deleteFromList for the same reason: asyncDeleteRecordsFromList already ships with the volume ceiling, proportion guard and declared-count check this path would have to duplicate. |
| `deleteFromListFtp` | write | **denied** | not-built | The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written. |
| `deleteIVRScript` | write | **denied** | shipped | Reachable ONLY as create-compensation inside executeCreateIvrScript, exactly as today. It must never become a registered action type: nothing may queue a script deletion. |
| `deleteLanguagePrompt` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteList` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deletePrompt` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteReasonCode` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteReasonCodeByType` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteRecordFromList`<br>→ `five9_delete_record_from_list` | write | **enabled** | shipped | Shipped as five9_delete_record_from_list — single-record deletion by dial key. |
| `deleteSkill` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteUser` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteUserProfile` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `deleteWebConnector` | write | **denied** | not-built | Every delete* operation is denied: Five9 has no undo and no audit trail, so a wrong target is unrecoverable and unattributable. |
| `forceStopCampaign` | write | **enabled** | shipped | Reached through five9_stop_campaign when action_payload.force === true; deliberately not a separate action type. |
| `getAgentGroup` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getAgentGroups` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getApiVersions` | read | **skip** | not-built | Read — no identified consumer. |
| `getAutodialCampaign` | read | **denied** | not-built | Reece does not run autodial campaigns (carried-forward ruling, covers the whole autodial family). It is a read, so it could never be an action type; the ruling is recorded here so the family reads as one decision. |
| `getAvailableLocales` | read | **skip** | not-built | Read — no identified consumer. |
| `getCallCountersState` | read | **skip** | shipped | Read — shipped as the five9_get_call_counters_state MCP tool. Kept OUT of five9_get_config on purpose: it is live per-second telemetry, where every config read is “current until somebody edits it”, so folding it in would blur two different freshness contracts. |
| `getCallVariableGroups` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getCallVariables` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getCampaignDNISList` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getCampaignProfileDispositions` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getCampaignProfileFilter` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getCampaignProfiles` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getCampaigns` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getCampaignState` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getCampaignStrategies` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getConfigurationTranslations` | read | **skip** | not-built | Read — no identified consumer. |
| `getContactFields` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getContactRecords` | read | **skip** | shipped | Read — shipped as the five9_get_contact_records MCP tool. Kept separate from five9_get_config because it takes a QUERY (lookupCriteria), not a name pattern. LP remains the system of record for contact data; this verifies what Five9 holds, never treats it as truth — the same reasoning that denies every contact-DB write. |
| `getCrmImportResult` | read | **skip** | shipped | Read — shipped inside the five9_get_import_result MCP tool (job_type dispatch), alongside getListImportResult. |
| `getDialingRules` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getDisposition` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getDispositions` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getDispositionsImportResult` | read | **skip** | shipped | Read — shipped inside the five9_get_import_result MCP tool (job_type dispatch), alongside getListImportResult. |
| `getDNISList` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getInboundCampaign` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getIvrIcons` | read | **skip** | not-built | Read — available if needed; no reader built, and reads are never agent actions. NEW SURFACE — never considered before PR3. |
| `getIvrScriptOwnership` | read | **skip** | not-built | Read — available if needed; no reader built, and reads are never agent actions. NEW SURFACE — never considered before PR3. |
| `getIVRScripts` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getListImportResult` | read | **skip** | shipped | Read — the existing reader, now also exposed through the five9_get_import_result MCP tool (job_type: "list"); folded in rather than duplicated. |
| `getListsForCampaign` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getListsInfo` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getLocale` | read | **skip** | not-built | Read — no identified consumer. |
| `getOutboundCampaign` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getPrompt` | read | **skip** | not-built | Read — available if needed; no reader built, and reads are never agent actions. |
| `getPrompts` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. Also reachable as five9_get_config({ entity_type: 'prompt' }), where name_pattern filters client-side because the operation takes no argument. |
| `getReasonCode` | read | **skip** | not-built | Read — available if needed; no reader built, and reads are never agent actions. |
| `getReasonCodeByType` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getReportResult` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getReportResultCsv` | read | **skip** | not-built | getReportResult already ships; the CSV variant is the same data in a different encoding. |
| `getSkill` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getSkillAudioFiles` | read | **skip** | not-built | Binary audio payload; no agentic consumer, matching the existing skip on the corresponding write ops. |
| `getSkillInfo` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getSkills` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getSkillsInfo` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getSkillVoicemailGreeting` | read | **skip** | not-built | Binary audio payload; no agentic consumer, matching the existing skip on the corresponding write ops. |
| `getSpeedDialNumbers` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `getUserGeneralInfo` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getUserInfo` | read | **skip** | not-built | Singular variant of a pattern reader that already ships; exactUserPattern() covers exact lookup. A separate tool would be zero new capability at the cost of a tool slot. |
| `getUserProfile` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getUserProfiles` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. Takes Five9’s misspelled userProfileNamePatern. |
| `getUsersGeneralInfo` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getUsersInfo` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getUserVoicemailGreeting` | read | **skip** | not-built | Binary audio payload; no agentic consumer, matching the existing skip on the corresponding write ops. |
| `getVCCConfiguration` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `getWebConnectors` | read | **skip** | shipped | Read — shipped inside the five9_get_config MCP tool (entity_type dispatch), not as a tool of its own. Reads are direct MCP tools, never agent actions. |
| `isImportRunning` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `isReportRunning` | read | **skip** | shipped | Read — already wrapped by a reader in src/five9-admin.js; direct MCP tool, never an agent action. |
| `modifyAgentGroup` | write | **gated** | not-built | Guard: confirm_token restating the group name — group membership decides supervisor visibility and reporting rollups. |
| `modifyAutodialCampaign` | write | **denied** | not-built | Reece does not run autodial campaigns (carried-forward ruling, covers the whole autodial family). |
| `modifyCallVariable` | write | **gated** | not-built | Guard: confirm_token restating the variable name, and refuse a change to a variable referenced by a shipped IVR script or list mapping. |
| `modifyCallVariablesGroup` | write | **gated** | not-built | Guard: confirm_token restating the group name, and refuse a rename that would orphan variables resolving through it. |
| `modifyCampaignLists`<br>→ `five9_modify_campaign_lists` | write | **gated** | shipped | Shipped as five9_modify_campaign_lists: confirm_token restating the campaign name, refuses while RUNNING. REPLACES the whole list set, so it read-modify-writes and records lists_detached (anything absent from the payload) on the audit event — naming two lists on a campaign carrying five detaches the other three. |
| `modifyCampaignProfile`<br>→ `five9_modify_campaign_profile` | write | **gated** | shipped | Shipped as five9_modify_campaign_profile: confirm_token restating the profile name, because a profile is shared — `Data Leads` alone serves five campaigns. |
| `modifyCampaignProfileCrmCriteria` | write | **gated** | not-built | Guard: confirm_token restating the profile name, and refuse while any campaign on the profile is RUNNING — CRM criteria decide WHICH records dial, so this is a compliance-exposed selection change. |
| `modifyCampaignProfileDispositions` | write | **gated** | not-built | Guard: confirm_token restating the profile name, and refuse removal of any disposition in the CC payroll bonus mapping. |
| `modifyCampaignProfileFilterOrder` | write | **gated** | not-built | Guard: confirm_token restating the profile name, and refuse while any campaign on the profile is RUNNING — filter order decides dial precedence across the profile. |
| `modifyContactField` | write | **gated** | not-built | Guard: confirm_token restating the field name, and refuse any change to `type` on a field referenced by list-dispatch or a shipped field order — a type change breaks every existing mapping. |
| `modifyDisposition` | write | **gated** | not-built | Guard: confirm_token restating the disposition name, and refuse any payload that changes the name field (that is renameDisposition by another route, which is denied). |
| `modifyInboundCampaign` | write | **denied** | not-built | Guardrail 2 makes inbound campaigns immutable; setDefaultIVRSchedule is the sanctioned way to re-point one. |
| `modifyIVRScript`<br>→ `five9_modify_ivr_script` | write | **gated** | shipped | Shipped as five9_modify_ivr_script: confirm_token restating the script name, and refuses a script live on more than one RUNNING campaign without compliance_override — there is no staging step between save and live. |
| `modifyOutboundCampaign`<br>→ `five9_set_outbound_campaign` | write | **gated** | shipped | Shipped as five9_set_outbound_campaign: confirm_token restating the campaign name, a PATCHABLE_FIELDS whitelist narrower than the schema, and the FCC/FTC abandonment guard on maxQueueTime / maxDroppedCallsPercentage. |
| `modifyPromptTTS` | write | **gated** | not-built | Guard: confirm_token restating the prompt name, and refuse a prompt referenced by an IVR script live on a RUNNING campaign without compliance_override — this changes what callers hear, immediately. |
| `modifyPromptWav` | write | **skip** | not-built | Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need. |
| `modifyPromptWavInline` | write | **skip** | not-built | Binary audio upload; no agentic path produces a WAV, and TTS already covers the prompt need. |
| `modifyReasonCode` | write | **gated** | not-built | Guard: confirm_token restating the reason code name, and refuse any payload that renames it — adherence history keys on the name. |
| `modifySkill` | write | **gated** | not-built | Guard: confirm_token restating the skill name, and refuse while any campaign carrying the skill is RUNNING — skill parameters decide live call routing. |
| `modifyUser` | write | **gated** | not-built | Guard: confirm_token restating the user name, plus the Guardrail 12 role check on any roles block that populates admin or supervisor. |
| `modifyUserCannedReports` | write | **skip** | not-built | Per-user report subscriptions; no agentic need identified. |
| `modifyUserProfile`<br>→ `five9_modify_user_profile` | write | **gated** | shipped | Shipped as five9_modify_user_profile: REPLACES the whole userProfile struct, so it read-modify-writes; confirm_token is checked against Five9’s own spelling of the live profile, and Guardrail 12 applies to changes.roles. |
| `modifyUserProfileSkills`<br>→ `five9_modify_user_profile_skills` | write | **enabled** | shipped | Shipped as five9_modify_user_profile_skills — the narrow patch: {profile_name, add_skills[], remove_skills[]}, cannot touch a role grant. |
| `modifyUserProfileUserList`<br>→ `five9_modify_user_profile_user_list` | write | **enabled** | shipped | Shipped as five9_modify_user_profile_user_list — the narrow patch: {profile_name, add_users[], remove_users[]}, cannot touch a role grant. |
| `modifyVCCConfiguration` | write | **denied** | not-built | Tenant-wide configuration: one call changes settings for every campaign, agent and list at once, and there is no narrower operation to scope an approval to the field actually being changed. |
| `modifyWebConnector`<br>→ `five9_modify_web_connector` | write | **gated** | shipped | Shipped as five9_modify_web_connector, under the same Guardrail 13 as create — repointing an existing connector is the same exfiltration path, so the allow-list is what makes both allowable. Built as a FULL-OBJECT REPLACE: read-modify-write, serialize complete, re-read and diff on changed AND untouched fields. Guardrail 13 runs on the MERGED struct, not on the submitted changes, because a replace re-submits a destination the live connector already carried. confirm_token restating the connector name, re-checked inside the executor against Five9’s own spelling of the live name. |
| `removeDisposition` | write | **denied** | not-built | CC payroll bonus math reads disposition names; removing one silently corrupts payroll history. |
| `removeDispositionsFromCampaign` | write | **gated** | not-built | BUILT (executeRemoveDispositionsFromCampaign) but DELIBERATELY UNREGISTERED — no action type resolves to it, so queuing five9_remove_dispositions_from_campaign fails as unknown. Its required guard is “refuse any disposition in the CC payroll bonus mapping”, and no such mapping exists: searched 2026-08-21 across all six repos (no Bonus_Structure.md), Supabase (no payroll/bonus/commission table; lp_dispositions carries category / is_recoverable / reactivation_track and nothing about pay), and Notion. The two authoritative payroll documents derive EVERY bonus from three Lead Perfection reports rather than from Five9 dispositions, and the only disposition either names is “no-rehash” — which they contradict each other on (“added to the demo-count/bonus totals” vs “no-rehash leads removed from setter bonus”). A guard keyed on a guessed list would read as protection while protecting nothing. To register: give the mapping an authoritative home, point PAYROLL_PROTECTED_DISPOSITIONS at it, and wire the six touch-points. |
| `removeDNISFromCampaign`<br>→ `five9_remove_dnis_from_campaign` | write | **gated** | shipped | Shipped as five9_remove_dnis_from_campaign: confirm_token restating the campaign name, because removing a DNIS dead-ends a live number that still looks fine from the outside. |
| `removeIvrIcons` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. Cosmetic, as setIvrIcons — proposed skip. |
| `removeIvrScriptOwnership` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. Clears the othersCanCopy flag set by setIvrScriptOwnership — proposed skip for the same reason. |
| `removeListsFromCampaign`<br>→ `five9_remove_lists_from_campaign` | write | **gated** | shipped | Shipped as five9_remove_lists_from_campaign: confirm_token restating the campaign name, refuses while RUNNING. The attached-list set before the change rides on the audit event. |
| `removeNumbersFromDnc`<br>→ `five9_remove_numbers_from_dnc_reentry` | write | **gated** | shipped | AMENDED 2026-09-21. The 2026-08-21 ruling (Reece does not take numbers off DNC, so there is no gate, override or reason string that yields it) still governs every general caller: five9_remove_numbers_from_dnc stays in FORBIDDEN_ACTION_TYPES and stays an unknown action type. Mark then ruled that a consumer who RE-ENTERS through a fresh first-party submission is lifted everywhere, Five9 included, so the SOAP method is reachable by exactly one action type — five9_remove_numbers_from_dnc_reentry — which is welded to DNC_LIFT_ON_REENTRY_E0 and re-proves consent:new-submission and the trigger event's age (<=15 min) at execution. It cannot lift a contact-initiated STOP: that rule refuses any contact carrying suppress:dnc-reply / suppress:dnc-voice. "gated" rather than "enabled" because the gate is the whole design. |
| `removeSkillAudioFile` | write | **skip** | not-built | Audio asset management; a Five9-UI task with no agentic path that produces the file. |
| `removeSkillsFromCampaign`<br>→ `five9_remove_skills_from_campaign` | write | **gated** | shipped | Shipped as five9_remove_skills_from_campaign: confirm_token restating the campaign name. Does NOT blanket-refuse while RUNNING — it carries the sharper guard instead: removing the LAST skill on a RUNNING campaign is refused, because every call already queued on it would be stranded with nothing to route to. The same removal is allowed once the campaign is stopped. |
| `removeSpeedDialNumber` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. Removes a desktop shortcut by code; proposed skip for the same reason as createSpeedDialNumber. Note it is remove*, not delete*, and destroys no history. |
| `renameCampaign` | write | **denied** | not-built | DNIS→campaign→source attribution keys on campaign names; a rename silently re-buckets every historical call. |
| `renameDisposition` | write | **denied** | not-built | CC payroll bonus math reads disposition names; a rename silently corrupts payroll history. |
| `resetCampaign`<br>→ `five9_reset_campaign` | write | **gated** | shipped | Shipped as five9_reset_campaign: confirm_token restating the campaign name, and REFUSES a RUNNING campaign — reset clears dispositions and list positions, making every record re-dialable at once. |
| `resetCampaignDispositions`<br>→ `five9_reset_campaign_dispositions` | write | **gated** | shipped | Shipped as five9_reset_campaign_dispositions: confirm_token restating the campaign name, refuses while RUNNING — same re-dialable-at-once blast radius as Guardrail 11, scoped to dispositions. Optional after/before dateTime bounds narrow the reset; passing neither is recorded on the audit event as the unbounded case. |
| `resetListPosition`<br>→ `five9_reset_list_position` | write | **gated** | shipped | Shipped as five9_reset_list_position: confirm_token restating the CAMPAIGN name, refuses while that campaign is RUNNING — rewinding position re-dials records the floor already worked. SCHEMA CORRECTION: the PR4 handoff specified a token on the LIST name and a refusal while “any campaign using the list” is RUNNING, but v13 resetListPosition takes exactly one argument, <campaignName>. There is no list argument to key a token on, so the op is campaign-scoped and the token follows. Schema wins (standing rule). (The v1 handoff called this resetListPositions, plural, which does not exist in v13.) |
| `runReport` | read | **skip** | shipped | Read-path: starts a report run and returns a handle; mutates no configuration. Already wrapped by runReport / runReportAndWait in src/five9-admin.js. |
| `setCampaignStrategies`<br>→ `five9_set_campaign_strategies` | write | **gated** | shipped | Shipped as five9_set_campaign_strategies: confirm_token restating the campaign name, refuses while RUNNING — a strategy governs dial pacing, which is what abandonment rate is downstream of, so it is the compliance-exposed dimension. REPLACES the strategy set; the prior set rides on the audit event. |
| `setDefaultIVRSchedule`<br>→ `five9_set_default_ivr_schedule` | write | **enabled** | shipped | Shipped as five9_set_default_ivr_schedule — the sanctioned way to re-point an inbound campaign, since modifyInboundCampaign is denied. |
| `setDialingRules` | write | **denied** | not-built | State dialing rules — currently REGION — are the TCPA/state-calling-hours enforcement surface; changing them agentically moves a compliance boundary. |
| `setIvrIcons` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. Icons are the visual representation of a script in the Five9 IVR designer and have no runtime effect on routing; proposed skip as cosmetic. |
| `setIvrScriptOwnership` | write | **skip** | not-built | NEW SURFACE, flagged for Mark. The schema shows a single `othersCanCopy` boolean, so this governs whether other admins may COPY a script — not who may edit or run it. Proposed skip: no agentic need, and it is not the access-control grant the name suggests. |
| `setLocale` | write | **skip** | not-built | Tenant display locale, set once at provisioning; no agentic need identified. |
| `setSkillVoicemailGreeting` | write | **skip** | not-built | Audio asset management; a Five9-UI task with no agentic path that produces the greeting. |
| `setUserVoicemailGreeting` | write | **skip** | not-built | Audio asset management; a Five9-UI task with no agentic path that produces the greeting. |
| `startCampaign`<br>→ `five9_start_campaign` | write | **enabled** | shipped | Shipped as five9_start_campaign; refuses an INBOUND target and skips a campaign already RUNNING. |
| `stopCampaign`<br>→ `five9_stop_campaign` | write | **enabled** | shipped | Shipped as five9_stop_campaign; refuses an INBOUND target and skips a campaign already NOT_RUNNING. |
| `updateConfigurationTranslations` | write | **skip** | not-built | Localisation strings for the agent desktop; no agentic need identified. |
| `updateContacts` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. |
| `updateContactsCsv` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. |
| `updateContactsFtp` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written. |
| `updateCrmRecord` | write | **denied** | not-built | LP is the system of record for contact data; writing Five9’s contact DB creates a third divergent copy. |
| `updateDispositions` | write | **denied** | not-built | Bulk disposition rewrite — the same payroll-history corruption as renameDisposition, at list scale and with no per-name review step. |
| `updateDispositionsCsv` | write | **denied** | not-built | Bulk disposition rewrite — the same payroll-history corruption as renameDisposition, at list scale and with no per-name review step. |
| `updateDispositionsFtp` | write | **denied** | not-built | The payload is a file on a remote FTP host, so approve_action has nothing to review — there is no artifact of what would be written. |
| `userSkillAdd`<br>→ `five9_user_skill_add` | write | **enabled** | shipped | Shipped as five9_user_skill_add; reads the user’s current skills first and refuses a level outside 1–9. |
| `userSkillModify`<br>→ `five9_user_skill_modify` | write | **enabled** | shipped | Shipped as five9_user_skill_modify; reads before writing and refuses a skill the user does not hold. |
| `userSkillRemove`<br>→ `five9_user_skill_remove` | write | **enabled** | shipped | Shipped as five9_user_skill_remove; reads before writing. <level> is schema-required even on remove. |

---

_Generated by `scripts/five9-gen-op-classification.js`. To change a row, edit
`OP_CLASSIFICATION` in `src/five9/op-registry.js` and regenerate._
