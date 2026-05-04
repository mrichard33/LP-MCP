/**
 * Action Executor — src/action-executor.js
 *
 * Backward-compatibility shim. The implementation lives under src/actions/
 * where it's split into small, single-responsibility files:
 *
 *   src/actions/
 *     ├── index.js              — orchestrator (executeActions + routes + executeActionById)
 *     ├── constants.js          — pipeline/stage/calendar IDs
 *     ├── helpers.js            — ghlFetch, isLPLeadId, interpolate
 *     ├── resolvers.js          — contact/prospect/event context resolution
 *     ├── enrichment.js         — GroupMe card enrichment
 *     ├── approval-path.js      — v4.2 approval pipeline
 *     ├── date-parsers.js       — LP-format date helpers
 *     └── handlers/             — one file per action type
 *
 * Refactored 2026-04-24. Behavior unchanged; v4.2 approval fixes preserved
 * exactly. See docs/PATCH_v4.2_action_executor_hol_fix.md for details.
 *
 * 2026-05-02: also re-exports executeActionById (direct-execute by ID,
 * Jeanne Jewell recovery).
 *
 * This shim exists so existing `import { ... } from './action-executor.js'`
 * statements (currently only in src/index.js) keep working without a diff.
 */

export {
  executeActions,
  executeActionById,
  registerActionExecutorRoutes,
} from './actions/index.js';
