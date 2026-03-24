# GHL Field Writeback — Integration Guide

## What This Does

Syncs LP lead data (disposition, rep name, job value, appointment status, etc.) to GHL contact custom fields. Uses change detection so only changed records trigger GHL API calls.

## Architecture

```
LP API → Supabase (lp_leads) → Change Detection → GHL Custom Fields
                                    ↓
                              ghl_fields_hash column
                              (skips if unchanged)
```

## New Files

| File | Purpose |
|------|---------|
| `src/ghl-field-map.js` | Config mapping LP fields → GHL custom field IDs |
| `src/ghl-field-sync.js` | Change detection + GHL push logic |
| `sql/003_add_ghl_fields_hash.sql` | Supabase migration for hash column |

## Modified Files

| File | Change |
|------|--------|
| `src/ghl.js` | Added `updateGHLContactFields()` function |
| `src/sync-engine.js` | Wire in field sync at 3 integration points |

---

## Step 1: Run Supabase Migration

Run `sql/003_add_ghl_fields_hash.sql` in the Supabase SQL Editor.
This adds the `ghl_fields_hash` column to `lp_leads`.

## Step 2: Create GHL Custom Fields

Create these custom fields in GHL (Settings → Custom Fields → Contact):

| Field Name | Type | Notes |
|-----------|------|-------|
| LP Lead ID | Text | Stores LP lead/inquiry ID |
| LP Disposition | Text | Disposition code (e.g., "Set", "Sale") |
| LP Disposition Label | Text | Human-readable label (e.g., "Appointment Set") |
| LP Rep Name | Text | Assigned sales rep in LP |
| LP Appointment Set | Text | "Yes" or "No" |
| LP Appointment Date | Text | Date string (MM/DD/YYYY) |
| LP Demo Completed | Text | "Yes" or "No" |
| LP Closed Won | Text | "Yes" or "No" |
| LP Job Value | Text | Dollar amount as string |
| LP Source | Text | Parent source from LP |
| LP Subsource | Text | Subsource/detail from LP |
| LP Call Count | Text | Number of calls logged in LP |
| LP Last Contact Date | Text | Last contact date (MM/DD/YYYY) |
| LP Promoter Name | Text | Canvasser/promoter who generated lead |

After creating each field, copy its GHL field ID and paste it into `src/ghl-field-map.js`, replacing the corresponding `FILL_IN_GHL_FIELD_ID` placeholder.

## Step 3: Update ghl-field-map.js

Replace each `FILL_IN_GHL_FIELD_ID` with the real GHL custom field ID.
Only fields with real IDs will be synced — placeholders are automatically skipped.

## Step 4: Wire Into sync-engine.js

Three surgical changes to `src/sync-engine.js`:

### 4a. Add Imports (top of file, with other imports)

```javascript
import { syncLeadFieldsToGHL, bulkFieldSync, getFieldSyncStats, logFieldSyncConfig } from './ghl-field-sync.js';
```

### 4b. Add Startup Log (in startSyncScheduler, after token warmup)

Find this line in `startSyncScheduler()`:
```javascript
console.log('[Sync] LP token acquired');
```

Add immediately after:
```javascript
logFieldSyncConfig();
```

### 4c. Add Field Sync to processProspect()

In `processProspect()`, find this block (inside the `for (const lead of leads)` loop, after the GHL tag application):

```javascript
// 5. Apply GHL entry:* tag (once, additive — NEVER use PUT)
if (ghlId && !existing?.ghl_tag_applied) {
  const success = await applyGHLTag(ghlId, tag);
  if (success) {
    await supabase.from('lp_leads')
      .update({ ghl_tag_applied: true })
      .eq('lp_lead_id', lpLeadId);
  }
}
```

Add this block immediately AFTER it:

```javascript
// 5b. Sync LP fields to GHL contact (change-detected)
if (ghlId) {
  // Read the current lead row to get full field data + stored hash
  const { data: currentLead } = await supabase
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, disposition_code, disposition_label, rep_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, promoter_name, ghl_fields_hash')
    .eq('lp_lead_id', lpLeadId)
    .single();

  if (currentLead) {
    await syncLeadFieldsToGHL(currentLead, ghlId, currentLead.ghl_fields_hash);
  }
}
```

### 4d. Add Bulk Field Sync After GHL Backfill (full sync only)

In `fullSync()`, find the GHL backfill completion log:

```javascript
console.log(`[Sync] GHL backfill complete: ${matched}/${unmatchedLeads.length} matched`);
```

Add this block immediately AFTER the GHL backfill try/catch block:

```javascript
// Step 2d: Bulk field sync — push LP data to all GHL-matched contacts
try {
  const fieldStats = await bulkFieldSync(100, 200);
  console.log(`[FieldSync] Bulk complete: ${fieldStats.pushed} updated, ${fieldStats.skipped} unchanged`);
} catch (err) {
  console.warn('[FieldSync] Bulk sync failed:', err.message);
}
```

### 4e. Log Field Sync Stats (incremental sync)

In `incrementalSync()`, find the completion log:

```javascript
console.log(`[Sync] Incremental sync complete — ${counts.leads} leads, ...`);
```

Add before it:
```javascript
const fieldStats = getFieldSyncStats();
if (fieldStats.pushed > 0) {
  console.log(`[FieldSync] Cycle: ${fieldStats.pushed} pushed, ${fieldStats.skipped} unchanged, ${fieldStats.failed} failed`);
}
```

---

## How Change Detection Works

1. When `syncLeadFieldsToGHL()` runs, it calls `buildGHLFieldPayload()` to extract field values from the lead row
2. It computes a hash string: `"fieldId1=value1|fieldId2=value2|..."` (sorted by field ID)
3. Compares this hash against `lp_leads.ghl_fields_hash` (stored from last successful push)
4. If hashes match → skip (no API call)
5. If hashes differ → call `updateGHLContactFields()` → store new hash on success

This means:
- First sync cycle after deployment: ALL GHL-matched leads get updated (hash is null)
- Subsequent cycles: Only leads with actual LP data changes get updated
- Typical incremental cycle: 0-50 GHL updates instead of 194K+

## Rate Limiting

- `bulkFieldSync()` uses a 200ms delay between GHL API calls
- The GHL circuit breaker in `ghl.js` disables all GHL calls after 5 consecutive failures
- Reset happens at the start of each sync cycle via `resetGHLState()`

## Testing

1. Run migration in Supabase
2. Configure at least one field in `ghl-field-map.js` (e.g., `lp_prospect_id` is already configured)
3. Deploy to Railway (merge branch or push to main)
4. Check Railway logs for: `[FieldSync] X/Y GHL fields configured`
5. Trigger an incremental sync and verify logs show field pushes
6. Spot-check a GHL contact to confirm the custom field was populated

## Rollback

If something goes wrong:
1. The feature only writes to GHL custom fields — it never modifies tags, contact names, or other core fields
2. To disable: set all GHL field IDs back to `FILL_IN_GHL_FIELD_ID` in `ghl-field-map.js`
3. To fully revert: revert to the previous commit on main
