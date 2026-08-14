# Five9 Admin API v13 — Phase G WSDL extracts (config surface)

Verbatim `xs:complexType` / `xs:simpleType` definitions backing the Phase G
config-surface reads (IVR scripts, DNIS inventory, prompts, domain config) and
the write ops that follow them, quoted from the live schema.

**Source:** `https://api.five9.com/wsadmin/v13/AdminWebService?wsdl&user=x`
**Fetched:** 2026-08-13 — HTTP 200, 961,700 bytes, 20,205 lines.
**Method:** the DOTALL-regex extraction documented in the Phase D FETCH NOTE
(`src/five9/admin-writes.js`), using the flexible
`<xs:complexType[^>]*\bname="X"` pattern. Read-response order was NOT used to
derive any of this.

The flexible pattern is again load-bearing: **`inboundCampaign` carries
`final="extension restriction"`**, so the anchored `<xs:complexType name="X">`
form cannot match it — the same failure mode Phase E hit on
`baseOutboundCampaign` and `outboundCampaign`, where an empty match is
indistinguishable from a truncated fetch. Every block below was diffed
byte-for-byte against the document after being pasted here.

This file exists for the same reason the Phase C/D/E/F comment blocks do: it
records how the schema was verified, so the next person extending this surface
does not re-derive it or guess. Do not edit it by hand — re-extract instead.

## Fetching the WSDL at all

Plain `?wsdl` returns an HTTP 403 carrying a SOAP Fault, not a schema:

```
<faultstring>No user name (&quot;user&quot; parameter) provided</faultstring>
<ns2:InvalidAccountFault .../>
```

**Appending `&user=x` is what makes it fetchable** — any value works, and no
password is involved. The 403 is easy to misread as "the proxy blocked me" or
"we need credentials"; it is neither. The Phase F note recorded the URL with
`&user=x` already, but not why it is load-bearing.

## The schema is not the authority on requiredness

**`inboundCampaign/defaultIvrSchedule` is `minOccurs="0"` and is NOT optional.**
Phase G read the schema and shaped `five9_create_inbound_campaign` and
`five9_set_default_ivr_schedule` as two independent steps: create the campaign,
then attach a script. Five9 refused, live, on action 316167 (2026-08-14):

```
Five9 createInboundCampaign fault: "campaign.defaultIvrSchedule" is required, but is "null"
```

An inbound campaign cannot be created without a script already attached, so the
script must ride along on the create. `five9_create_inbound_campaign` therefore
requires `action_payload.script_name`;
`five9_set_default_ivr_schedule` remains useful for *re-pointing* an existing
campaign, which is what it was always good for.

The general lesson, and the reason this section leads: every other note in this
file treats the WSDL as ground truth for *shape*, and that still holds — field
order, element names, and nesting have all been correct. But `minOccurs` tells
you what the **schema** permits, not what the **server** accepts. Where the two
disagree, only a live call finds out. Do not infer optionality from
`minOccurs="0"` for a field that is semantically load-bearing.

The stored shape, read back from the live `Confirmation - Inbound` campaign —
note that `ivrSchedule` carries only `scriptName`, with no `name`:

```
defaultIvrSchedule: {
  ivrSchedule: { scriptName: "Confirmation After hrs" },
  visualModeSettings: { visualModeEnabled: "true", callbackEnabled: "true",
                        cssTheme: "a", xFrameOption: "DENY", ... }
}
```

`visualModeSettings` is deliberately not emitted on create: the live campaigns
carry real values there, and sending flags we did not compute would overwrite
them. Same reasoning as `setDefaultIVRSchedule` not sending
`isVisualModeEnabled` / `isChatEnabled`.

## Four findings worth carrying forward

1. **The IVR ops are SINGULAR, and create cannot carry the definition.**
   `createIVRScript` / `modifyIVRScript` / `deleteIVRScript` — only
   `getIVRScripts` is plural. `createIVRScript` accepts **`name` and nothing
   else**, so there is no inline-XML path: creating a working script is
   necessarily `createIVRScript(name)` followed by
   `modifyIVRScript(scriptDef)`, and that pair is not atomic. Anything reading
   "createIVRScripts(name, xmlDefinition)" is describing an API that does not
   exist.

2. **`getPrompts` takes no arguments, and its response is `<prompts>`, not
   `<return>`.** It is the only op in this client whose results are not in
   `<return>`, so `returnBlocks()` returns `[]` against it — indistinguishable
   from a domain with no prompts. Hence `promptBlocks()` in
   `src/five9-admin.js`. Name filtering is client-side because the schema
   offers no pattern to send.

3. **`campaignCallWrapup.dispostionName` is misspelled in Five9's schema.**
   Missing the `i`. It occurs exactly once in the whole document; the correctly
   spelled `dispositionName` occurs 9 times on *other* types, so the typo looks
   like ours and invites a "fix". Emitting `dispositionName` here raises no
   error and silently sets no wrapup disposition. Copy the typo verbatim.

4. **`getIVRScripts` has no names-only mode.** `getIVRScriptsResponse` returns
   `ivrScriptDef`, which always includes `xmlDefinition`. Stripping definitions
   client-side trims the reply, never the download; `namePattern` (a Five9-side
   regex) is the only real lever on payload size. This is why
   `five9SoapCall` gained an opt-in `maxBytes` ceiling.

Also note `ivrScriptDef` orders `description` **before** `name` — like every
sequence in this schema, it is alphabetical, not logical. Do not assume `name`
leads.

## Inheritance — inboundCampaign is three levels deep

`inboundCampaign` extends **`generalCampaign`**, not `campaign` directly.
Flattened emission order for `createInboundCampaign`, base sequence first:

```
tns:campaign          description, mode, name, profileName, state, trainingMode, type
tns:generalCampaign   autoRecord, callWrapup, ftpHost, ftpPassword, ftpUser,
                      recordingNameAsSid, useFtp
tns:inboundCampaign   defaultIvrSchedule, maxNumOfLines
                    = 16 fields
```

The line count field is `maxNumOfLines`, and the DNIS argument on
add/remove is `DNISList` — capitalised, unbounded.

---

## IVR scripts

```xml
<xs:complexType name="getIVRScripts">
    <xs:sequence>
      <xs:element minOccurs="0" name="namePattern" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getIVRScriptsResponse">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="return" type="tns:ivrScriptDef"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="ivrScriptDef">
    <xs:sequence>
      <xs:element minOccurs="0" name="description" type="xs:string"/>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
      <xs:element minOccurs="0" name="xmlDefinition" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="createIVRScript">
    <xs:sequence>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="createIVRScriptResponse">
    <xs:sequence>
      <xs:element minOccurs="0" name="return" type="tns:ivrScriptDef"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="modifyIVRScript">
    <xs:sequence>
      <xs:element minOccurs="0" name="scriptDef" type="tns:ivrScriptDef"/>
    </xs:sequence>
  </xs:complexType>
```

`modifyIVRScriptResponse` is `<xs:sequence/>` — empty. Verify by re-reading.

```xml
<xs:complexType name="deleteIVRScript">
    <xs:sequence>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

`deleteIVRScript` exists and is recorded here for the create-compensation path
(removing the empty shell when step 2 of create fails). It is deliberately not
exposed as a queueable action type.

## DNIS

```xml
<xs:complexType name="getDNISList">
    <xs:sequence>
      <xs:element minOccurs="0" name="selectUnassigned" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getDNISListResponse">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="return" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getCampaignDNISList">
    <xs:sequence>
      <xs:element minOccurs="0" name="campaignName" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="getCampaignDNISListResponse">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="return" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

Both responses are bare strings, not structs — map them with `decodeXml`, not
`parseXmlBlock`.

```xml
<xs:complexType name="addDNISToCampaign">
    <xs:sequence>
      <xs:element minOccurs="0" name="campaignName" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="DNISList" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="removeDNISFromCampaign">
    <xs:sequence>
      <xs:element minOccurs="0" name="campaignName" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="DNISList" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

## Prompts

```xml
<xs:complexType name="getPrompts">
    <xs:sequence/>
  </xs:complexType>
```

```xml
<xs:complexType name="getPromptsResponse">
    <xs:sequence>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="prompts" type="tns:promptInfo"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="promptInfo">
    <xs:sequence>
      <xs:element minOccurs="0" name="description" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="languages" nillable="true" type="xs:string"/>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
      <xs:element minOccurs="0" name="type" type="tns:promptType"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:simpleType name="promptType">
    <xs:restriction base="xs:string">
      <xs:enumeration value="TTSGenerated"/>
      <xs:enumeration value="PreRecorded"/>
    </xs:restriction>
  </xs:simpleType>
```

```xml
<xs:complexType name="addPromptTTS">
    <xs:sequence>
      <xs:element minOccurs="0" name="prompt" type="tns:promptInfo"/>
      <xs:element minOccurs="0" name="ttsInfo" type="tns:ttsInfo"/>
    </xs:sequence>
  </xs:complexType>
```

`modifyPromptTTS` has the identical sequence. Both responses are
`<xs:sequence/>` — empty. There is no `promptTTSInfo` type; the pair is
`promptInfo` + `ttsInfo`.

```xml
<xs:complexType name="ttsInfo">
    <xs:sequence>
      <xs:element minOccurs="0" name="language" type="xs:string"/>
      <xs:element minOccurs="0" name="sayAs" type="tns:sayAs"/>
      <xs:element minOccurs="0" name="sayAsFormat" type="tns:sayAsFormat"/>
      <xs:element minOccurs="0" name="text" type="xs:string"/>
      <xs:element minOccurs="0" name="voice" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

`getPrompt` (singular) takes `promptName` and is available if a single-prompt
read is ever needed. `addPromptWav`, `addPromptWavInline`, `modifyPromptWav`,
`modifyPromptWavInline`, `deletePrompt` and `deleteLanguagePrompt` also exist;
none are implemented.

## Domain configuration

```xml
<xs:complexType name="getVCCConfiguration">
    <xs:sequence/>
  </xs:complexType>
```

```xml
<xs:complexType name="getVCCConfigurationResponse">
    <xs:sequence>
      <xs:element minOccurs="0" name="return" type="tns:vccConfiguration"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="vccConfiguration">
    <xs:sequence>
      <xs:element minOccurs="0" name="agentProductivity" type="tns:agentProductivity"/>
      <xs:element minOccurs="0" name="campaignsSettings" type="tns:campaignsSettings"/>
      <xs:element minOccurs="0" name="domainId" type="xs:long"/>
      <xs:element minOccurs="0" name="domainName" type="xs:string"/>
      <xs:element minOccurs="0" name="emailProperties" type="tns:emailNotifications"/>
      <xs:element minOccurs="0" name="extensionSettings" type="tns:extensionSettings"/>
      <xs:element minOccurs="0" name="keyPerfomanceIndicators" type="tns:keyPerfomanceIndicators"/>
      <xs:element minOccurs="0" name="miscOptions" type="tns:miscVccOptions"/>
      <xs:element minOccurs="0" name="passwordPolicies" type="tns:passwordPolicies"/>
      <xs:element minOccurs="0" name="recordingsServer" type="tns:remoteHostLoginSettings"/>
      <xs:element minOccurs="0" name="reportsServer" type="tns:remoteHostLoginSettings"/>
      <xs:element minOccurs="0" name="saleforceEmailAccount" type="tns:sForceEmailAccount"/>
      <xs:element minOccurs="0" name="stateDialingRule" type="tns:stateDialingRule"/>
      <xs:element minOccurs="0" name="timeZoneAssignment" type="tns:timeZoneAssignment"/>
      <xs:element minOccurs="0" name="transcriptsServer" type="tns:remoteHostLoginSettings"/>
    </xs:sequence>
  </xs:complexType>
```

Note `keyPerfomanceIndicators` — a second Five9 misspelling, distinct from the
`dispostionName` one. It only matters when reading that sub-tree.

```xml
<xs:complexType name="campaignsSettings">
    <xs:sequence>
      <xs:element minOccurs="0" name="gracefulAgentStateTransitionDelay" type="xs:int"/>
      <xs:element minOccurs="0" name="gracefulAgentStateTransitionModeEnabled" type="xs:boolean"/>
      <xs:element minOccurs="0" name="priorityEnabled" type="xs:boolean"/>
      <xs:element minOccurs="0" name="ratioEnabled" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

`modifyVCCConfiguration` exists. It is deliberately not implemented — domain
configuration stays read-only.

---

## Inbound campaign + IVR schedule (Phase G writes)

```xml
<xs:complexType name="createInboundCampaign">
    <xs:sequence>
      <xs:element minOccurs="0" name="campaign" type="tns:inboundCampaign"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType final="extension restriction" name="inboundCampaign">
    <xs:complexContent>
      <xs:extension base="tns:generalCampaign">
        <xs:sequence>
          <xs:element minOccurs="0" name="defaultIvrSchedule" type="tns:inboundIvrScriptSchedule"/>
          <xs:element minOccurs="0" name="maxNumOfLines" type="xs:int"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
```

```xml
<xs:complexType name="generalCampaign">
    <xs:complexContent>
      <xs:extension base="tns:campaign">
        <xs:sequence>
          <xs:element minOccurs="0" name="autoRecord" type="xs:boolean"/>
          <xs:element minOccurs="0" name="callWrapup" type="tns:campaignCallWrapup"/>
          <xs:element minOccurs="0" name="ftpHost" type="xs:string"/>
          <xs:element minOccurs="0" name="ftpPassword" type="xs:string"/>
          <xs:element minOccurs="0" name="ftpUser" type="xs:string"/>
          <xs:element minOccurs="0" name="recordingNameAsSid" type="xs:boolean"/>
          <xs:element minOccurs="0" name="useFtp" type="xs:boolean"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
```

```xml
<xs:complexType name="campaign">
    <xs:sequence>
      <xs:element minOccurs="0" name="description" type="xs:string"/>
      <xs:element minOccurs="0" name="mode" type="tns:campaignMode"/>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
      <xs:element minOccurs="0" name="profileName" type="xs:string"/>
      <xs:element minOccurs="0" name="state" type="tns:campaignState"/>
      <xs:element minOccurs="0" name="trainingMode" type="xs:boolean"/>
      <xs:element minOccurs="0" name="type" type="tns:campaignType"/>
    </xs:sequence>
  </xs:complexType>
```

**The typo — copy it verbatim.**

```xml
<xs:complexType name="campaignCallWrapup">
    <xs:sequence>
      <xs:element minOccurs="0" name="agentNotReady" type="xs:boolean"/>
      <xs:element minOccurs="0" name="dispostionName" type="xs:string"/>
      <xs:element minOccurs="0" name="enabled" type="xs:boolean"/>
      <xs:element minOccurs="0" name="reasonCodeName" type="xs:string"/>
      <xs:element minOccurs="0" name="timeout" type="tns:timer"/>
    </xs:sequence>
  </xs:complexType>
```

`tns:timer` is `{days, hours, minutes, seconds}` — all four `xs:int` and all
four schema-**required** (no `minOccurs="0"`). `secondsToTimerXml` in
`src/five9/admin-writes.js` already emits it correctly.

```xml
<xs:complexType name="inboundIvrScriptSchedule">
    <xs:sequence>
      <xs:element minOccurs="0" name="ivrSchedule" type="tns:ivrScriptSchedule"/>
      <xs:element minOccurs="0" name="visualModeSettings" type="tns:visualModeSettings"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="ivrScriptSchedule">
    <xs:sequence>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
      <xs:element minOccurs="0" name="scriptName" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="scriptParameters" nillable="true" type="tns:scriptParameterValue"/>
    </xs:sequence>
  </xs:complexType>
```

The script attached to an inbound campaign is read at
`defaultIvrSchedule.ivrSchedule.scriptName` — two levels down, not
`defaultIvrSchedule.scriptName`. That path is what the modify-script usage
check walks.

```xml
<xs:complexType name="setDefaultIVRSchedule">
    <xs:sequence>
      <xs:element minOccurs="0" name="campaignName" type="xs:string"/>
      <xs:element minOccurs="0" name="scriptName" type="xs:string"/>
      <xs:element maxOccurs="unbounded" minOccurs="0" name="params" type="tns:scriptParameterValue"/>
      <xs:element minOccurs="0" name="isVisualModeEnabled" type="xs:boolean"/>
      <xs:element minOccurs="0" name="isChatEnabled" type="xs:boolean"/>
    </xs:sequence>
  </xs:complexType>
```

```xml
<xs:complexType name="scriptParameterValue">
    <xs:sequence>
      <xs:element minOccurs="0" name="name" type="xs:string"/>
      <xs:element minOccurs="0" name="value" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
```

`createInboundCampaignResponse`, `addDNISToCampaignResponse`,
`removeDNISFromCampaignResponse` and `setDefaultIVRScheduleResponse` are all
`<xs:sequence/>` — empty. Every one of these ops must be verified by a
read-back; the response tells you nothing.

## Enums

Summarised, not verbatim — the enumerations only, in schema order:

```text
campaignMode    BASIC | ADVANCED
campaignType    OUTBOUND | AUTODIAL | INBOUND
campaignState   NOT_RUNNING | STARTING | RUNNING | STOPPING | RESETTING
promptType      TTSGenerated | PreRecorded
```

`sayAs` and `sayAsFormat` (on `ttsInfo`) carry 19 and 23 enumerations
respectively; `Default` is valid for both and is what a plain text prompt wants.

## Ops present but not implemented

`deleteCampaign`, `deletePrompt`, `deleteLanguagePrompt`, `modifyIVRScript`
as a standalone action, `modifyVCCConfiguration`, `addPromptWav` /
`addPromptWavInline` / `modifyPromptWav` / `modifyPromptWavInline`,
`getPrompt`, `modifyInboundCampaign`. Recorded so the next person knows they
exist and that leaving them out was a decision, not an oversight.
