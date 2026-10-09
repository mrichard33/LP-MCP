/**
 * Confirmation Calls go to the Rehash rep — scripts/test-confirmation-call-assignee.js
 *
 * The user, 2026-10-09: Confirmation Calls stay on the GHL calendar and are
 * assigned to the Rehash team member (John Manieri). The assignee is: an
 * explicit one on the booking → the contact's owner → the Rehash rep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  confirmationCallAssignee, confirmationCallAssigneeFor, REHASH_REP_USER_ID_DEFAULT,
} = await import('../src/config/rehash-assignee.js');

test('default is the Rehash rep (John Manieri)', () => {
  assert.equal(REHASH_REP_USER_ID_DEFAULT, 'TYcZ9DcNkuPCFYsFxRFV');
  assert.equal(confirmationCallAssignee({}), 'TYcZ9DcNkuPCFYsFxRFV');
  assert.equal(confirmationCallAssigneeFor({}, {}), 'TYcZ9DcNkuPCFYsFxRFV');
});

test('the contact owner wins over the default; an explicit assignee wins over both', () => {
  assert.equal(confirmationCallAssigneeFor({ contactOwner: 'owner1' }, {}), 'owner1');
  assert.equal(confirmationCallAssigneeFor({ explicit: 'exp1', contactOwner: 'owner1' }, {}), 'exp1');
  assert.equal(confirmationCallAssigneeFor({ explicit: '  ', contactOwner: '' }, {}), 'TYcZ9DcNkuPCFYsFxRFV',
    'blank values do not count');
});

test('env overrides the default; off turns the default off (owner still used)', () => {
  assert.equal(confirmationCallAssignee({ CONFIRMATION_CALL_ASSIGNED_USER_ID: 'other' }), 'other');
  assert.equal(confirmationCallAssignee({ CONFIRMATION_CALL_ASSIGNED_USER_ID: 'OFF' }), null);
  assert.equal(confirmationCallAssigneeFor({}, { CONFIRMATION_CALL_ASSIGNED_USER_ID: 'off' }), null);
  assert.equal(confirmationCallAssigneeFor({ contactOwner: 'owner1' }, { CONFIRMATION_CALL_ASSIGNED_USER_ID: 'off' }), 'owner1');
});
