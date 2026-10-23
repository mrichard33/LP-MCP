# F.0 v2 static emails (the user, 2026-10-23)

Three person-written emails for "F.0 Post-Appointment Follow-Up v2". GHL email templates, built by Mark; LP-MCP never
writes or edits them. Where they go in the workflow: `docs/f0-v2-workflow-spec.md` (steps 0d, 0e and 11).

- **Static Email 1** is the fallback for the AI post-demo email. It goes when the contact has the tag
  `f0-email-fallback` (no Siro recording, the AI email off, or a draft that failed) or when a draft never reached
  Send Ready. LP-MCP adds the tag (`emailFallbackTag`, `src/siro/f0-email.js`).
- **Static Email 3** (day 4) and **Static Email 4** (day 11) are the fallbacks for the two follow-up emails between
  the texts. Those are written from the visit too (GHL positions 7 and 8, prompt rows `F.0-P6-email-V2` /
  `F.0-P7-email-V2`); the static one goes only when LP-MCP tags `f0-email-fallback` or a draft never reached Send Ready.

The rule (the user, 2026-10-23): write every email personalized when the visit data is there; the static email is
only the fallback.

They come from the old F.0 emails (the user's "F.0 Email and SMS Templates", Emails 1, 3 and 4), reworded so the
lead hears one sender:
- **Reece Team voice:** "we", never "I". The body has no sign-off. Each template signs like the AI email:
  "The Reece Team / Reece Windows & Doors", From Name **Reece Team**.
- **The rehash team owns the lead after an unsold demo** (2026-10-11): the sales rep is thanked, never named as the
  one who follows up. Questions go to "reply to this email" or a quick call with `{{custom_values.rehash_rep_name}}`
  (today John; keep that custom value set, or the sentence reads "or  can go over it").
- **No numbers we cannot stand behind:** no dollar figures, no "cash-flow positive / neutral", no "insurers are
  tightening", no "not if, just when".
- **"The building code for your area"**, not the Florida Building Code: Houston and Winston-Salem leads get these too.
- **No em dashes.**
- **Footer:** "Protecting families since 1972" + the office address + Unsubscribe (as the AI email's template).

---

## Static Email 1: the fallback post-demo email

**Subject:** What we saw at your home, {{contact.first_name}}
**Preheader:** A few things worth knowing before you review your proposal

{{default contact.first_name "Hi there"}},

Thank you for having {{default contact.rep_first_name "our team"}} out to your home. We know a 90-minute visit is a real
commitment, and we do not take that lightly.

We will check in over the next couple of days. Our job after the visit is simple: make sure you have everything you
need to make a clear decision. No pressure, just clarity.

When {{default contact.rep_first_name "our team"}} walked through your home and showed you where the exposure points
are, you probably noticed something most homeowners miss from the outside: the specific openings that drive your home's
protection rating. That is exactly why we do this in person. No online tool catches what was found at your home.

Your proposal reflects exactly what your home needs. Not more, not less.

A few things worth knowing as you review it:

- Every product in your proposal meets or exceeds the building code for your area.
- The price includes full installation, permits, HOA paperwork, and a warranty that covers what matters.
- Financing options are available, and we can walk you through how they work for your proposal.

If anything from the visit raised a question you did not get to ask, just reply to this email, or
{{custom_values.rehash_rep_name}} can go over it with you on a quick call. Either way, we will get you an answer.

Out of everything you went over at the visit, what stood out most to you?

**P.S.** Randy Reece's father started this company in 1972 to protect families from storms. Every home we visit gets the
same care as if it were our own.

---

## Static Email 3: the day-4 fallback

**Subject:** "We need to think about it": what that usually means
**Preheader:** You're not the first homeowner to say this after a visit.

{{default contact.first_name "Hi there"}},

After a visit like the one {{default contact.rep_first_name "our team"}} just had at your home, almost every homeowner
says the same thing:

"We just need to think about it."

And that makes complete sense. It is your home. It is a real commitment. Nobody should rush a decision like this.

But here is something we have noticed after years of these visits:

"Thinking about it" rarely means someone needs more information. They already have the proposal. They already saw the
numbers. They already stood in their own home and watched {{default contact.rep_first_name "our team"}} point out the
exact openings that matter.

What "thinking about it" usually means is that the size of the decision has not caught up to the clarity they felt
during the visit.

In that moment, when you could see exactly what was being talked about, it made sense. The problem was clear. The fix
was clear. The investment made sense in context.

Then you sit with it for a day, and the clarity starts to compete with the number.

That is not a sign something is wrong. That is how every homeowner works through a meaningful investment.

The homeowners who move forward tend to do one thing: they go back to the proposal, look at the insurance and energy
savings section, and compare it with what they are paying now. When they see the gap, what they are quietly losing every
month by keeping things the way they are, the decision reframes itself.

It stops being "Should we spend this?" and becomes "How long are we comfortable losing this?"

Your proposal has those numbers. They are specific to your home, your zone, and your current rating.

If you would like us to walk through that section with you, just reply to this email, or
{{custom_values.rehash_rep_name}} can go over it on a quick call. It takes about five minutes.

---

## Static Email 4: the day-11 fallback

**Subject:** The 4 questions you probably have right now
**Preheader:** After more than 50 years doing this, we've noticed a pattern.

{{default contact.first_name "Hi there"}},

These are the questions homeowners ask after they have seen what we saw together at their home.

After more than 50 years as a company, we have noticed a pattern. Almost every homeowner asks the same four questions in
the first couple of weeks after their visit. Here they are:

**1. "Is this the right time, or should I wait?"**
Only you can decide that. What we can tell you: building code requirements only get stricter, not looser, and storm
season comes back every year. Waiting rarely makes the project cheaper or easier.

**2. "How does financing work?"**
Most of our homeowners use one of our financing options to spread the project out over time. We can run the exact
numbers for your proposal.

**3. "What about my HOA?"**
We handle HOA documentation and approval as part of the project. It is not an add-on or an extra cost. Our team has
worked with most of the major HOAs in {{default contact.city "your area"}}, and we know what they need.

**4. "How long does installation take?"**
For a project like yours, installation is typically 1 to 2 days, depending on scope. We coordinate everything: permits,
scheduling, the crew and the final inspection. You do not have to manage any of it.

If your question is not on this list, just reply to this email, or {{custom_values.rehash_rep_name}} can answer it on a
quick call.

**P.S.** Randy's dad used to say, "The best contractor is the one who answers the question you were afraid to ask."
That is what we are here for.
