// n8n-avatar.js — copied from main for dev branch compatibility
// See main branch for authoritative version

export function registerN8nAvatarRoutes(app) {
  // Stub — full implementation lives on main and will be merged
  app.post('/n8n/avatar/score', (req, res) => res.json({ stub: true, message: 'Avatar routes on main branch' }));
  app.post('/n8n/avatar/parse-gpt', (req, res) => res.json({ stub: true }));
  app.post('/n8n/avatar/unified-inputs', (req, res) => res.json({ stub: true }));
  app.post('/n8n/avatar/pick-best', (req, res) => res.json({ stub: true }));
  app.post('/n8n/avatar/build-ghl', (req, res) => res.json({ stub: true }));
  app.post('/n8n/avatar/build-notion', (req, res) => res.json({ stub: true }));
}
