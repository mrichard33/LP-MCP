// A Siro recording as GET /core/recordings/{id} returns it with all four flags.
// Shaped like the real records of 2026-10-16 (the four fixed summary sections,
// citation marks, the follow-up block with its context, GPS and an email);
// every value is invented, no real customer.
const HOUR = 3_600_000;
export const FIXTURE_RECORDED_AT = new Date(Date.now() - 3 * HOUR).toISOString();

export const RAW_RECORDING = {
  id: 'rec_abc123',
  userId: 'usr_1',
  organizationId: 'org_1',
  title: 'Dana Sample - 10/16/26',
  conversationType: 'ct-in-home',
  createdAt: FIXTURE_RECORDED_AT,
  updatedAt: FIXTURE_RECORDED_AT,
  deleted: false,
  deletedAt: null,
  result: 'open',
  durationInMilliseconds: 5400000,
  latitude: 28.18,
  longitude: -82.68,
  links: { web: { self: 'https://app.siro.ai/#/recordings/rec_abc123' } },
  summary: [
    { id: 's1', name: 'Customer Need & Motivation', content: '- The lanai slider sticks and the bedroom windows leak during storms.[1][2] - They want storm protection for the lanai slider and a quieter bedroom; call 352-555-0188 if needed.[3]' },
    { id: 's2', name: 'Customer Sentiment', content: '- They liked the **screen design** and trusted the company.[1] - They were glad the quote was $18,400 for the full house.[2]' },
    { id: 's3', name: 'Customer Objections', content: '- **Strongest objection: uncertain return on investment.** Dana worried whether new windows would add enough resale value.[1] - They were not ready to decide and wanted to talk it over with her husband first.[2]' },
    { id: 's4', name: 'Key Outcomes & Next Steps', content: '- No purchase was made. They agreed to revisit the decision by the end of next week.[1] - Brian will call on Friday.[2]' },
  ],
  entityExtractions: [],
  followups: [{
    followupId: 'f1', followupType: 'REHASH', score: 4, status: 'TO_DO', followupAction: '',
    repName: 'Brian Kowalski', teamName: 'St.Pete', repId: 'usr_1',
    thinking: 'HIGH FOLLOW-UP POTENTIAL INDICATORS PRESENT: a long internal note.',
    context: [
      { header: 'first_price_quote', value: '$24,500' },
      { header: 'final_price_quote', value: '$18,400' },
      { header: 'financing', value: '$500 down, about $190 per month.' },
      { header: 'overall_cost', value: '18400' },
      { header: 'main_objection', value: 'Pricing' },
      { header: 'secondary_objection', value: 'Spouse' },
      { header: 'objection_summary', value: 'They held off because the total felt high at $18,400 and her husband was not there.' },
      { header: 'follow_up_summary', value: 'Call at the end of next week once Dana has talked with her husband.' },
      { header: 'follow_up_time', value: 'In 1 Week' },
      { header: 'emotional_tie', value: 'Strong: they plan to stay for years and hate the storm rattle.' },
      { header: 'scope', value: 'Lanai slider plus 4 bedroom windows.' },
      { header: 'FollowupEmailHeader', value: 'Dear Dana, thank you for having me out... (full drafted email)' },
      { header: 'FollowupTextHeader', value: 'Hi Dana, this is Brian... (full drafted text)' },
    ],
    crmCustomer: {
      name: 'Dana Sample', emailAddress: 'dana@example.com', phoneNumber: null,
      opportunity: { account: { latitude: 28.18, longitude: -82.68, phoneNumbers: ['(352) 555-0188'], emailAddresses: ['dana@example.com'] } },
    },
  }],
  crm: {
    integrationConnectionId: 'conn_lp',
    users: [{ id: 'u1', externalId: '4074' }],
    engagement: { id: 'e1', externalId: 'LDS583321' },
    opportunity: { id: 'o1', externalId: '583321' },
    account: { id: 'a1', externalId: '470111' },
  },
};
