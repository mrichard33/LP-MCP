# GHL fix: a concern tag must be one plain label

**Found 2026-10-17 (Diane, c4mxpy24yMrzsga4nj8g).** One reason-bearing tag reached the contact as three tags:
`concern-expressed:trust (skeptical`, `need references`, `seems too good)`. GHL's tag field splits on commas, so any
tag whose value holds a comma becomes several tags.

**What LP-MCP does.** Every `add_tag` we write for `concern-expressed:` / `pre-demo-concern:` keeps a plain label:
commas and parentheses removed, value capped at 40 characters (`cleanReasonTag`, `src/actions/handlers/tags.js`).

**What only GHL can fix.** The O.V objection validator workflow builds the tag itself:
`pre-demo-concern:{{contact.objection_type_ai}}` (four Add Tag steps in `O.V-objection-validator.json`). When the AI
field holds a sentence, the tag splits. The fix, in GHL:

1. Put only the bare label in the tag: `pre-demo-concern:trust`, `pre-demo-concern:price`, … (one Add Tag step per
   type, or an If/Else on the type field).
2. Put the AI's reason in a contact note or a custom field, never in a tag.
3. Do the same in any other workflow or AI step that writes `concern-expressed:{{…}}`.

GHL tags are plain, reusable labels, never a sentence, a date or an id (Mark, 2026-10-14).
