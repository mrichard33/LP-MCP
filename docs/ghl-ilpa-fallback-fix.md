# I.LP-A: stop the fallback writing to Lead Perfection itself

**Workflow:** "I.LP-A LP Set Appointment" (`1b3cf452-5d59-4d9e-93b3-1a51b8536431`)
**Why:** on 2026-10-21 (prospect 119890, Sherry Despota) this workflow's fallback called LP's SetAppointment
directly. It took the lead from `{{contact.lp_lead_id}}` (a 2024 lead the contact had just been linked to) and
the date from `{{contact.last_appointment_start_date}}` (a field our LP sync fills from LP, which held 2022-02-09).
LP-MCP now applies one 15-day lead rule to every appointment write; this GHL step goes around it.
GHL's API cannot edit a workflow, so this is a change a person makes in the builder.

## Already handled in code (no GHL change needed)

LP-MCP now tags `lp-appt-deferred` whenever it holds an appointment for the 15-day rule, sends it to a new lead,
or waits for one. The 15-minute check's **"Deferred (Exit)"** branch already exits on that tag, so those contacts
never reach the fallback.

## Steps (about 5 minutes)

1. In GHL, open **Automation → Workflows → "I.LP-A LP Set Appointment"**.
2. Follow the branch **Run Fallback → Has Lead ID → No Appointment Exist → Wait for Lead ID (met) → Has Appt Details**.
3. Click the step **"Send Appointment to Lead Perfection"** (a Custom Webhook to `api.leadperfection.com/api/Leads/SetAppointment`) and **delete it**.
4. Delete the IF/ELSE **"Check Fallback Result"** under it, with both its branches ("Fallback Success" note, "Contains Error" tag + note).
5. In the same place, add a **Webhook** action:
   - Name: `Re-fire LP sync through LP-MCP`
   - Method: **POST**
   - URL: `https://lp-mcp-production.up.railway.app/webhook/ghl/set-lp-appointment`
   - Custom data (key → value; pick the values from the merge-field picker under **Appointment**, NOT under Contact):
     - `contact_id` → `{{contact.id}}`
     - `appointment_date` → the appointment's **start date**
     - `appointment_time` → the appointment's **start time**
     - `calendar_id` → the appointment's **calendar id**
   - Do **not** use `{{contact.last_appointment_start_date}}`, `{{contact.last_appointment_start_time}}` or any
     "LP Appointment Date/Time" field: those are copies of whatever LP last held.
6. The "Format Date", "Format Time to Military" and "Sanitizer step" steps above it are no longer needed; delete them too.
7. **Save** and **Publish**.

## What happens after

The webhook runs LP-MCP's `syncAppointmentToLP`, which applies the rule: the person's newest LP lead within
15 days takes the appointment; an older lead (or none) gets a NEW LP lead with the appointment (Reece ChatBot as
the source when the chatbot booked it); a create already on its way means nothing is written. LP-MCP's
SetAppointment also refuses, as a last line, a lead entered more than 15 days ago or a date in the past.

## Check it

After publishing, `get_workflow_steps` (HL MCP, `forceLive: true`) for the workflow should show no step whose URL
contains `leadperfection.com`.
