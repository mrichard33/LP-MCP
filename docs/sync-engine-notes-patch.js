// ─── Sync Engine Patch Instructions ────────────────────────────────
//
// The sync-engine.js file is 77KB and cannot be rewritten in a single commit.
// Apply these 3 targeted changes manually or via search-and-replace.
//
// ═══ CHANGE 1: Add import (line ~12, with other imports) ═══
//
// FIND this line:
//   import { upsertProspect, updateProspectGHL } from './upsert-prospect.js';
//
// ADD immediately AFTER it:
//   import { combineNotes } from './safe-notes.js';
//
//
// ═══ CHANGE 2: Fix processProspect() notes assembly (~line 380) ═══
//
// FIND this exact line inside processProspect(), in the "6-8. Sync sub-entities" section:
//   const notes = [...(getField(prospect, 'notes', 'Notes') || []), ...(getField(lead, 'notes', 'Notes') || [])];
//
// REPLACE with:
//   const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lead, 'notes', 'Notes'));
//
//
// ═══ CHANGE 3: Fix syncAllChildRecords() notes assembly (~line 470) ═══
//
// FIND this exact line inside syncAllChildRecords(), in the "Sync child records" loop:
//   const notes = [...(getField(prospect, 'notes', 'Notes') || []), ...(getField(lpLead, 'notes', 'Notes') || [])];
//
// REPLACE with:
//   const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lpLead, 'notes', 'Notes'));
//
//
// ═══ VERIFICATION ═══
//
// After applying all 3 changes, search for this pattern in sync-engine.js:
//   ...(getField(
//
// It should appear in extractArray(), upsertLeadOnly(), and other places
// that spread ARRAYS (not notes). The two notes-specific spread lines
// above should be the ONLY ones replaced with combineNotes().
//
// The spread operator is safe for calls, jobs, milestones, and leads
// because LP always returns those as proper arrays. Only notes come
// back as strings sometimes.
