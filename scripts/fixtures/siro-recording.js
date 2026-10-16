// A Siro recording as GET /core/recordings/{id} returns it with all four flags
// (shape from docs/siro-reference.md §4; values invented, no real customer).
export const RAW_RECORDING = {
  id: 'rec_abc123',
  siroUserId: 'usr_1',
  siroTeamId: 'team_1',
  user: { id: 'usr_1', email: 'Brian.Rep@ReeceWindows.com', name: 'Brian Kowalski' },
  conversationType: 'ct-in-home',
  dateCreated: '2026-10-14T22:05:00Z',
  updatedAt: '2026-10-14T23:40:00Z',
  deleted: false,
  result: 'not closed',
  duration: 5400,
  summary: [
    { id: 's1', name: 'Customer Need & Motivation', content: 'Sliding glass door in the lanai sticks and the bedroom windows leak during storms. Call 352-555-0188 if needed.' },
    { id: 's2', name: 'Next Steps', content: 'Customer will talk it over with her husband this weekend.' },
  ],
  entityExtractions: [
    { name: 'Objections', value: ['The price is higher than the other quote', 'Wants to talk to her husband first'] },
    { name: 'Customer Priorities', value: 'Storm protection for the lanai slider; quieter bedroom' },
    { name: 'Customer Questions', value: 'How long does the install take?' },
    { name: 'Customer Phone', value: '(352) 555-0188' },
  ],
  followups: { followupId: 'f1', score: 4, status: 'TO_DO', followupAction: 'Call after the weekend to answer the husband\'s questions.' },
  crm: {
    integrationConnectionId: 'conn_lp',
    engagement: { id: 'e1', externalId: 'LDS583321' },
    opportunity: null,
    account: { id: 'a1', externalId: '470111' },
  },
};
