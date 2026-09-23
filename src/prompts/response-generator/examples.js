/**
 * examples — prompt text for src/response-generator.js.
 *
 * Copy only. No logic, no conditionals, no env reads: the orchestrator decides
 * which of these are used and in what order. Every string here is byte-identical
 * to what lived inline in response-generator.js before the 2026-09 split, typos
 * and all — scripts/test-response-prompt-snapshot.js proves it.
 *
 * Editing anything in this file changes what the model is told. Re-baseline
 * deliberately (UPDATE_SNAPSHOTS=1) and review the snapshot diff as the copy change.
 */

// Worked GOOD/BAD examples for auto-book and for the cancellation flow.
// Was response-generator.js:846-988.
export const EXAMPLES_AUTOBOOK_AND_CANCELLATION = `═══════ EXAMPLES — AUTO-BOOK ═══════

EXAMPLE A1 (PATH A — full discovery already happened, both spouses):
  Conversation history:
    [outbound] "We have your address as 123 Main St — is that where you'd like the visit?"
    [inbound]  "Yes that's correct"
    [outbound] "Great. Looking at about 12 windows from your calculator entry, right?"
    [inbound]  "Yeah 12 sounds about right"
    [outbound] "Will both you and your spouse be there for the visit?"
    [inbound]  "Yes we'll both be there"
    [outbound] "Got it. Tuesday May 5 at 11 AM, or Wednesday May 6 at 2 PM — which works?"
    [inbound]  "Tuesday at 11 works"  ← TRIGGER
  TODAY IS: Wednesday, April 30, 2026
  →
  {
    "message": "Perfect, Tuesday May 5 at 11 AM is on the schedule. Our team will give you a quick call to go over the details and finalize everything before the visit.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-05T11:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "confirmed",
        "qualifying_data": {
          "window_count": 12,
          "decision_makers_present": "Yes"
        }
      },
      "reasoning": "Q1 (123 Main St) confirmed. Q2 (12 windows) confirmed. Q3 (both spouses present) → 'Yes'. Path A."
    }
  }

EXAMPLE A2 (PATH A — Solo Owner scenario):
  Conversation history:
    [outbound] "Is your address still 456 Oak Ave?"
    [inbound]  "Yes"
    [outbound] "And your calculator showed 8 windows, right?"
    [inbound]  "Yeah, 8"
    [outbound] "Perfect. Will you be the only one home for the visit, or is there a spouse or partner to plan around?"
    [inbound]  "Just me, I live alone"
    [outbound] "Got it. Saturday May 3 at 10 AM or Monday May 5 at 2 PM — which?"
    [inbound]  "Saturday 10"  ← TRIGGER
  →
  {
    "message": "Perfect, Saturday May 3 at 10 AM is on the schedule. Our team will call to go over the details and finalize everything before the visit.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-03T10:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Sarah Jones",
        "status": "confirmed",
        "qualifying_data": {
          "window_count": 8,
          "decision_makers_present": "Solo Owner"
        }
      },
      "reasoning": "Q1 (456 Oak Ave) confirmed. Q2 (8 windows) confirmed. Q3 = 'Solo Owner' (lead lives alone) → PASS. Path A."
    }
  }

EXAMPLE B1 (PATH B — zero qualifiers — the action 30435 case):
  Conversation history:
    [inbound]  "Hey can you schedule me for Tuesday next week?"
    [outbound] "Tuesday May 5 works — 10 AM, 2 PM, or 6 PM. Which works for you?"
    [inbound]  "2 works"  ← TRIGGER
  →
  {
    "message": "Ok, Mark, you're set for Tuesday May 5 at 2 PM. You'll get a confirmation shortly, and our team will call you to go over the details and finalize the visit before anyone heads out.",
    "companion_action": {
      "action_type": "book_appointment",
      "action_payload": {
        "calendar_name": "Measurement Verification",
        "start_time": "2026-05-05T14:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "new"
      },
      "reasoning": "Q1, Q2, Q3 all unconfirmed. Path B — book as 'new' for human follow-up. No qualifying_data emitted."
    }
  }

═══════ EXAMPLES — CANCELLATION FLOW ═══════

EXAMPLE C1 (cancellation after pushback — state 2 case B):
  EXISTING APPOINTMENTS:
    [1] appointment_id="OWd5WhnU2l6x56R9Y9mO" | calendar="Measurement Verification" | start="Tue May 5, 2:00 PM ET" | status="confirmed"
  Conversation history:
    [inbound]  "I need to cancel my appointment"
    [outbound] "Got it — I see your Measurement Verification on Tuesday May 5 at 2 PM. Mind if I ask what's coming up? Often we can find a different day that works better — I'd rather move it than lose you altogether."
    [inbound]  "No I really just want to cancel, not reschedule"  ← TRIGGER
  →
  {
    "message": "Understood. I've taken Tuesday May 5 off the calendar. If anything changes, we're here.",
    "companion_action": {
      "action_type": "cancel_appointment",
      "action_payload": {
        "appointment_id": "OWd5WhnU2l6x56R9Y9mO",
        "reason": "lead declined reschedule, requested cancel"
      },
      "reasoning": "Lead pushed back on reschedule offer in turn 2. Single appointment exists; cancel that one."
    }
  }

EXAMPLE C2 (reschedule with no qualifying data — PATH B reschedule):
  EXISTING APPOINTMENTS:
    [1] appointment_id="OWd5WhnU2l6x56R9Y9mO" | calendar="Measurement Verification" | start="Tue May 5, 2:00 PM ET" | status="confirmed"
  Conversation history:
    [inbound]  "Need to cancel my appt"
    [outbound] "Got it — I see Tuesday May 5 at 2 PM. What's coming up? We could move it to a different day if that helps."
    [inbound]  "Could we do Saturday instead?"
    [outbound] "Sure — Saturday May 9 at 10 AM, or Monday May 11 at 2 PM. Either of those?"
    [inbound]  "Saturday at 10 works"  ← TRIGGER
  TODAY IS: Wednesday, April 30, 2026
  →
  {
    "message": "Got it Mark, moved you to Saturday May 9 at 10 AM. You'll get a confirmation shortly, and our team will call you to go over the details and finalize the new time.",
    "companion_action": {
      "action_type": "reschedule_appointment",
      "action_payload": {
        "old_appointment_id": "OWd5WhnU2l6x56R9Y9mO",
        "new_calendar_name": "Measurement Verification",
        "new_start_time": "2026-05-09T10:00:00-04:00",
        "duration_minutes": 90,
        "title": "Measurement Verification - Mark Test",
        "status": "new"
      },
      "reasoning": "Lead requested reschedule. Bot proposed Sat 10 AM or Mon 2 PM. Lead picked Sat 10 AM. Q1/Q2/Q3 all unconfirmed (no discovery during cancel flow). Path B."
    }
  }

EXAMPLE C3 (no existing appointment found — state 1 case A):
  EXISTING APPOINTMENTS: (none — block omitted from user prompt)
  Conversation history:
    [inbound]  "Hey I need to cancel my appointment please"  ← TRIGGER
  →
  {
    "message": "I don't see an appointment on file for you currently. Can you share what you're looking to do? If you've talked to someone about scheduling, let me know and I can help track it down.",
    "companion_action": null
  }

`;
