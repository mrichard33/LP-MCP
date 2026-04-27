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
  // Inbound from GHL W-IME-IN
  app.post('/ime/dispatch',                       handler.requireAuth, handler.dispatch);
  app.post('/ime/work-orders/:id/refetch',        handler.requireAuth, handler.refetch);

  // Outbound — Reece state changes pushed to IME (Phase 2)
  app.post('/ime/work-orders/:id/appointment',    handler.requireAuth, handler.pushAppointment);
  app.put( '/ime/work-orders/:id/appointment',    handler.requireAuth, handler.pushReschedule);
  app.post('/ime/work-orders/:id/install',        handler.requireAuth, handler.pushInstall);
  app.post('/ime/work-orders/:id/close',          handler.requireAuth, handler.pushClose);
  app.post('/ime/work-orders/:id/cancel',         handler.requireAuth, handler.pushCancel);
  app.post('/ime/work-orders/:id/complete',       handler.requireAuth, handler.pushComplete);

  console.log('[ime] routes registered');
}

export function startImeWorkers() {
  scheduleCron();
}
