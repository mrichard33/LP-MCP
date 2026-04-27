// ─── IME Module Entry — src/ime/index.js ─────────────────────────
//
// Self-contained registration helpers for the IME MIC integration.
// Wire from src/index.js:
//   import { registerImeRoutes, startImeWorkers } from './ime/index.js';
//   registerImeRoutes(app);
//   startImeWorkers();

import * as handler from './webhook-handler.js';
import { scheduleCron } from './retry-cron.js';

export function registerImeRoutes(app) {
  // Inbound from GHL W-IME-IN — auth only
  app.post('/ime/dispatch',                       handler.requireAuth, handler.dispatch);
  app.post('/ime/work-orders/:id/refetch',        handler.requireAuth, handler.refetch);

  // Outbound — auth + requireIMELead guard (v1.6 §6).
  // The guard verifies the WO exists in ime_work_orders before any IME API call,
  // so a misfiring GHL workflow can't push a non-Sam's-Club lead into IME.
  app.post('/ime/work-orders/:id/appointment',    handler.requireAuth, handler.requireIMELead, handler.pushAppointment);
  app.put( '/ime/work-orders/:id/appointment',    handler.requireAuth, handler.requireIMELead, handler.pushReschedule);
  app.post('/ime/work-orders/:id/install',        handler.requireAuth, handler.requireIMELead, handler.pushInstall);
  app.post('/ime/work-orders/:id/close',          handler.requireAuth, handler.requireIMELead, handler.pushClose);
  app.post('/ime/work-orders/:id/cancel',         handler.requireAuth, handler.requireIMELead, handler.pushCancel);
  app.post('/ime/work-orders/:id/complete',       handler.requireAuth, handler.requireIMELead, handler.pushComplete);

  console.log('[ime] routes registered (inbound + outbound with IME-lead guard)');
}

export function startImeWorkers() {
  scheduleCron();
}
