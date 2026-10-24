-- 2026-10-24: website answers for the bot (the user's review, https://claude.ai/artifact/LBxazZzCcex6Etibd5JhKo).
--
-- WHY: the user asked for the bot to know what reecewindows.com says. scripts/website-kb-extract.js read 62 pages;
-- every answer below was reviewed in the doc above. 26 new answers and 12 additions were approved as written; 23
-- rulings were made (8 keep the bot's answer and change nothing; the rest are below, worded per the chat rulings):
--   * specials, financing, PACE, the SAH grant amount: named, never a number (the user: "Name them, no numbers").
--   * hurricane-proof and insurance KEEP the bot's wording (the user, 2026-10-24: "Keep this: old 'no window is
--     hurricane-proof' and insurance wording"): LIB-P01 and LIB-I01 are not touched. The impact-only rule stands:
--     the website only says "impact-resistant glass options" (LIB-P03 / LIB-P15).
--   * phone 866-717-8582; tax credit keeps "Regency line, QMID E1P4" (row 16, unchanged).
--   * UV up to 95%; licensed and insured; background checked
--     and drug tested (said of the CREWS: never "employees", GTD 7.6 hard line 11); both brands; most installed in
--     about 6 weeks; widened doorways / ADA doors.
-- KB-02 (styles) is updated in place; every other addition is its own row (it answers a different question).
-- Every question_pattern LEADS with the customer's words. No dashes in any answer (2026-10-06).
--
-- DATA ONLY. IDEMPOTENT: inserts only when the kb_key is absent; updates are guarded on the new text.
--
-- AFTER RUNNING: POST /n8n/kb/reembed {"faqs":true}, then GET /n8n/kb/faq-probe?q=<question> for every row's
-- leading question and its "also" questions (would_match must name the row), and the neighbours KB-02, LIB-P01,
-- LIB-P03, LIB-P15, LIB-X01, LIB-X06, LIB-C01, LIB-C03 on their own questions.
--
-- ROLLBACK: UPDATE kb_faqs SET active = false WHERE kb_key LIKE 'WEB-%';
--   an updated row keeps its prior answer in notes, after " || prior 2026-10-24: "; copy it back by hand.

-- ── new answers (approved as written) ───────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-01',
       $$Do you do arched or round windows? | Do you have specialty shaped windows? | Can you make a custom shape window? | I have a half-moon window, can you replace it?$$,
       $$Yes. We offer specialty windows in custom shapes, like arches and circles. You can also choose the color, glass style and interior grids.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-01');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-02',
       $$What is a casement window? | How do casement windows open? | Are casement windows good over a sink? | Do casements crank out?$$,
       $$Casement windows are hinged on the side and open outward like a door, which gives you great airflow. They work well in hard-to-reach spots, like over a kitchen sink.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-02');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-03',
       $$What is an awning window? | Can I leave a window open when it rains? | What window is good for a bathroom? | Do you have windows hinged at the top?$$,
       $$Awning windows are hinged at the top and swing out from the bottom. They're great for airflow, can stay open in a light rain, and often go above a picture window or in a bathroom.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-03');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-04',
       $$Do picture windows open? | What is a picture window? | Do you have big fixed windows? | Can I get one large window for the view?$$,
       $$No, picture windows are fixed in place with no moving parts. That gives you a wide, clear view and helps with energy efficiency.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-04');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-05',
       $$Are your windows energy efficient? | Are they Energy Star? | Do they have Low-E glass? | Will they keep the heat out?$$,
       $$Yes. Our windows beat ENERGY STAR guidelines, with dual-glazed insulated glass, three layers of silver-based Low-E coating, high-density argon gas and stainless-steel spacers. That cuts the heat coming through the glass and takes strain off your AC.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-05');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-06',
       $$Will new windows lower my electric bill? | Will I save on my power bill? | Do impact windows save energy? | My AC runs all the time, will new windows help?$$,
       $$They're built to cut the heat coming through your windows, which can help lower cooling costs and keep the house more comfortable. How much depends on your home and the windows you have now.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-06');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-07',
       $$Will impact windows help keep burglars out? | Are impact windows more secure? | Can someone break in through impact glass? | Do they help with break-ins?$$,
       $$They help. Laminated impact glass is much harder to break than regular glass, and our windows have multi-point locks, which makes forced entry a lot tougher.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-07');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-08',
       $$How long do impact windows last? | Will these windows last? | What's the lifespan of impact windows? | How many years do they last?$$,
       $$Quality impact windows are built to last for decades when they're installed and cared for properly. Ours are also backed by a double lifetime warranty.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-08');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-09',
       $$Do new windows add value to my home? | Will impact windows help me sell my house? | Do impact windows raise home value? | Is it worth it if I might sell?$$,
       $$They can. New impact windows improve comfort, energy efficiency and curb appeal, and a lot of buyers look for hurricane-ready homes.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-09');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-10',
       $$Are your doors hurricane rated? | Are your doors HVHZ? | Do your doors meet hurricane code? | Will the door hold up in a storm?$$,
       $$Yes. Our impact doors are High-Velocity Hurricane Zone (HVHZ) doors, built to meet strict building code requirements for high winds and flying debris.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-10');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-11',
       $$How do you install a new door? | What happens on door install day? | Do you take out the old door? | Do you install the frame too?$$,
       $$We take precise measurements, remove the old door, prep the opening and install the frame, then make sure the new door is set for a tight seal. A walkthrough at the end checks the work.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-11');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-12',
       $$What's the process from start to finish? | How does it work after the visit? | What are the steps to get new windows? | What happens after I sign?$$,
       $$It starts with a visit to your home and a written quote. Then you pick your styles and colors, our team takes exact measurements and photos and handles the permits, your custom windows are ordered, and after the install there's a final inspection to make sure everything meets code.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-12');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-13',
       $$Do you pull the permits? | Who handles the permit? | Do I need a permit for new windows? | Will it pass inspection?$$,
       $$Yes, our team handles all the permitting. After the install there's a final inspection to make sure everything meets code.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-13');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-14',
       $$Do you replace the whole frame or just the window? | Is it a full-frame replacement? | Do you do insert replacements? | Do you take out the old frame?$$,
       $$We usually recommend a full-frame replacement, where the whole area the window sits in is replaced. An insert replacement is also an option, depending on how much damage there is around the old window.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-14');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-15',
       $$Do I need to be home for the install? | Does someone have to be there on install day? | Can you install while I'm at work? | Do you need to come inside?$$,
       $$Yes, an adult needs to be home on install day to answer any questions the installers have. They'll need access to both the inside and outside of the home.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-15');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-16',
       $$How do I get ready for install day? | What should I do before the install? | Do I need to move furniture? | Should I take the blinds down?$$,
       $$Please take down any window treatments and security sensors, move furniture to clear a path to the windows, and take down wall decorations near the work area, since vibration can knock them loose.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-16');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-17',
       $$Who takes away the old windows? | Do you haul off the old windows? | Will you clean up after? | Is it going to be a mess?$$,
       $$We do. The team takes away the old windows and cleans up, leaving your home as clean as they found it.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-17');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-18',
       $$What if the wall gets damaged during the install? | Will you fix the stucco around the window? | What if the drywall gets damaged? | Who fixes the wall around the new window?$$,
       $$Our team works carefully, and if the wall or surface around a new window is damaged during the install, we fix it at no charge.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-18');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-19',
       $$What's the address of your office? | Can I stop by your office? | What's your St. Pete address? | Where is the Fort Myers office?$$,
       $$St. Petersburg: 7181 30th Ave N; Tampa: 4917 Ehrlich Rd, Suite 200; Lakeland: 5110 S Florida Ave, Suite 105; Fort Lauderdale: 3590 NW 54th St, Suite 3; Sarasota: 1920 Northgate Blvd, A-10; Fort Myers: 10990 Metro Parkway; Orlando: 1020 Ocoee Apopka Rd, Unit 100, Apopka; Jacksonville: 11760 Marco Beach Dr, Suite 4.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-19');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-20',
       $$Are you the same company as Reece Builders? | Is Reece Builders you? | I saw Reece Builders on Google, is that you? | Reece Builders or Reece Windows?$$,
       $$Yes. Reece Builders and Reece Windows & Doors are the same family company.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-20');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-21',
       $$Can I see your past work? | Do you have photos of jobs? | Can I see projects near me? | Do you have a gallery?$$,
       $$Yes. The completed projects map at reecewindows.com/completed-projects shows past jobs by location, with photos, videos and customer reviews.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-21');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-22',
       $$Do you have good reviews? | Are you rated well? | Where can I read reviews? | Are you on Angie's List?$$,
       $$Our work has earned positive recognition on Angie's List, HomeAdvisor and the Better Business Bureau. You can also read customer reviews on our completed projects map at reecewindows.com/completed-projects.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-22');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-23',
       $$Do you have a hurricane preparedness guide? | Do you have a hurricane checklist? | Can I get your hurricane guide? | How do I get ready for hurricane season?$$,
       $$Yes, we have a free Hurricane Preparedness Guide with a storm terms guide, a supply checklist, an evacuation guide and checklist, a post-storm toolkit and a guide to watches and warnings. You can get it from the form at reecewindows.com/hurricaneprep.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-23');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-24',
       $$Can I use my VA SAH grant for windows or doors? | Does the SAH grant cover window replacement? | Can I use my VA grant for new doors? | Will the VA pay for my windows?$$,
       $$It may, if the replacement improves accessibility, safety or mobility, like a low-threshold entrance. Your VA regional office can confirm what qualifies.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-24');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-25',
       $$Who qualifies for the SAH grant? | Am I eligible for the VA housing grant? | What disability do I need for SAH? | Do I qualify as a veteran?$$,
       $$It's for veterans with a permanent and total service-connected disability rated by the VA, such as the loss or loss of use of limbs, blindness in both eyes, or certain severe burns, on a home they own or will own. Your VA regional office can check your rating and eligibility.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-25');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-26',
       $$How do I apply for the SAH grant? | Where do I apply for the VA housing grant? | What form do I need for SAH? | How long does the VA take to approve it?$$,
       $$You apply with VA Form 26-4555, online through the VA, by mail, or in person at a VA regional office. The VA reviews it and issues a Certificate of Eligibility once it's approved.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-26');

-- ── additions (approved as written; KB-02 is updated in place below) ─────
UPDATE kb_faqs
   SET canonical_answer = $$We offer single-hung, double-hung, sliding, casement, awning, picture, bay and bow, and garden windows, plus specialty shapes like arches and circles. Each one comes in different colors, interior finishes, hardware and grid patterns. Which rooms are you thinking about?$$,
       question_pattern = question_pattern || $$ | Do you do bay or bow windows? | Do you have casement or awning windows? | What kinds of windows can I pick from?$$,
       notes = coalesce(notes, '') || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'KB-02' AND canonical_answer <> $$We offer single-hung, double-hung, sliding, casement, awning, picture, bay and bow, and garden windows, plus specialty shapes like arches and circles. Each one comes in different colors, interior finishes, hardware and grid patterns. Which rooms are you thinking about?$$;

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-27',
       $$What's the difference between single hung and double hung? | Single hung vs double hung? | Which sash opens on a single hung? | Can both parts of the window open?$$,
       $$A single-hung window has a fixed top sash and a bottom sash that moves. On a double-hung, both sashes move up and down, so you can open the top, the bottom, or both.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #65; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-27');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-28',
       $$What makes your impact windows strong? | How are impact windows made? | What's in the glass? | Are the frames reinforced?$$,
       $$Our impact windows use laminated, multi-layer glass with a polymer interlayer that holds it together, steel-reinforced vinyl frames, fusion-welded corners and multi-point locks. They've passed missile impact testing to earn their hurricane rating.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #69; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-28');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-29',
       $$Do vinyl frames hold up in Florida? | Will the frames warp or fade? | Do I have to paint vinyl windows? | Do vinyl frames rot?$$,
       $$Yes. Our vinyl frames resist warping, rotting, fading, cracking and peeling, and they never need painting. They're easy to clean too.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #72; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-29');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-30',
       $$Do you install front doors? | Do you do entry doors? | Do you have impact front doors? | Can you replace my front door?$$,
       $$Yes. We install impact entry doors in fiberglass and steel, with impact-resistant glass, precision metal hardware and weatherstripping. You can pick the style, color, finish, decorative glass and grid pattern.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #77; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-30');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-31',
       $$What happens at the in-home visit? | What do you do at the consultation? | Will I get a written quote? | What does the specialist do when they come out?$$,
       $$A specialist visits your home, looks at your windows and doors, walks you through styles, colors and options, and gives you a written quote. There's no cost and no obligation.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #95; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-31');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-32',
       $$What affects the price? | Why does price vary so much? | What goes into the cost? | Does the number of windows change the price?$$,
       $$The number of windows, their size and style, the glass, any custom options, and the install conditions, like stucco walls or second-story openings, all play a part. That's why a specialist measures at the in-home visit before giving pricing.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #94; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-32');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-33',
       $$Do you have an online price calculator? | Can I get a price online? | Where's your window cost calculator? | Is there an instant estimate?$$,
       $$Yes, the window cost calculator at reecewindows.com/window-estimate gives you an instant ballpark from your window count and styles. Final pricing comes from the in-home visit, since every home is different.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #9; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-33');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-34',
       $$Where are your offices? | Do you have an office near me? | Do you have a showroom? | Where is your office in Tampa?$$,
       $$We have offices in St. Petersburg, Tampa, Lakeland, Fort Lauderdale, Sarasota, Fort Myers, Orlando (in Apopka) and Jacksonville. Tell me which one is closest to you and I can send the address.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #82; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-34');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-35',
       $$Do you service Cape Coral? | Do you come to Clearwater? | Do you work in Boca Raton? | Do you cover Miami?$$,
       $$We work in the areas around our offices, including Apollo Beach, Belleair, Boca Raton, Bonita Springs, Bradenton, Brandon, Cape Coral, Clearwater, Deerfield Beach, Delray Beach, Dunedin, Estero, Hernando Beach, Hialeah, Homestead, Indian Rocks Beach, Largo, Lutz, Miami, New Port Richey, Palm Beach Gardens, Palm Harbor, Pembroke Pines, Pompano Beach, Riverview, Safety Harbor, Spring Hill, Sun City, Temple Terrace, Tierra Verde, Treasure Island, Wesley Chapel, West Palm Beach and Zephyrhills. Send me your zip code and I'll confirm we cover your home.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #82; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-35');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-36',
       $$Who started Reece? | Who owns Reece? | Is it still family run? | Who runs the company?$$,
       $$Reece was started in 1972 by Michael Reece Sr., Randy Reece's father. Today Randy runs it, after growing up in the business.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #80; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-36');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-37',
       $$What is the VA SAH grant? | What is Specially Adapted Housing? | Is there a grant for disabled veterans? | Do you help veterans with home grants?$$,
       $$It's a grant from the U.S. Department of Veterans Affairs that helps eligible veterans with severe service-connected disabilities buy, build or modify a permanent home to make it more accessible. Unused funds stay available for later projects, and our team can help you understand how it works.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. adds to FAQ #6; source: page$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-37');

-- ── rulings: new rows ─────────────────────────────────────────────────
INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-38',
       $$Do you have any specials right now? | Are you running any deals? | Do you have a promotion? | Is there a sale going on? | Do you do free installation?$$,
       $$We do run seasonal specials, like free installation or trade-in value on your old windows at times. A specialist goes over what's running now at your in-home visit.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: specials named, no numbers$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-38');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-39',
       $$Can I use PACE financing? | Do you take PACE? | Can I pay through my property taxes? | Do you do PACE loans?$$,
       $$PACE financing may be an option. It's paid back through your property taxes over time, and a specialist can go over whether it fits your home.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: PACE named, no numbers or deadline$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-39');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-40',
       $$Are your installers background checked? | Are your crews drug tested? | Do you background check your workers? | Is it safe to have your crew in my home?$$,
       $$Yes. Our install crews are background checked and drug tested, and they're factory-trained and Reece-certified.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: website answer; crew wording keeps "crews", never "employees" (GTD 7.6 hard line 11)$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-40');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-41',
       $$What brand of windows do you use? | Who makes your windows? | What manufacturer do you use? | Are they Regency windows?$$,
       $$We install Regency Plus vinyl windows and Conservation Windows. A specialist can walk you through both at the in-home visit.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: both makers the website names$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-41');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-42',
       $$How soon can my windows be installed? | How long until my install? | How long does it take to get my windows? | What is the lead time?$$,
       $$Most windows are installed within about 6 weeks. Your exact date depends on your order and the permits, and the team confirms it with you.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: website banner "Most Windows Installed In 6 Weeks"$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-42');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-43',
       $$What's your phone number? | Can I call you? | What number do I call? | How do I reach you by phone?$$,
       $$You can reach us at 866-717-8582.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: the user picked 866-717-8582$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-43');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-44',
       $$How much is the SAH grant? | What is the SAH grant amount? | How much will the VA give me? | What is the max for the VA housing grant?$$,
       $$The VA sets the maximum grant amount each year, so your VA regional office can tell you the current amount. Our team can help you plan the project around it.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: no dollar amount$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-44');

INSERT INTO kb_faqs (kb_key, question_pattern, canonical_answer, answer_short, channel, tier, active, notes)
SELECT 'WEB-45',
       $$Can you widen my doorways for a wheelchair? | Do you do ADA doors? | Can you make my entry wheelchair accessible? | Do you do barrier-free entries?$$,
       $$Yes. We can help with accessibility upgrades like widened doorways, barrier-free entries and ADA-friendly doors. A specialist can look at what your home needs at the in-home visit.$$,
       NULL, 'both', 'factual', true,
       $$2026-10-24 website (reecewindows.com), approved by the user. ruling: website answer$$
WHERE NOT EXISTS (SELECT 1 FROM kb_faqs WHERE kb_key = 'WEB-45');

-- ── rulings: existing rows updated in place ───────────────────────────
UPDATE kb_faqs
   SET canonical_answer = $$Yes. Every window and door we sell is a hurricane impact window or door, with impact-resistant glass options for every opening. A specialist checks each opening and matches it to the right impact product for your home and your area's code.$$,
       notes = coalesce(notes, '') || $$ | ruling (the user, 2026-10-24): the website says "impact-resistant glass options"; impact only stands (2026-10-13).$$ || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'LIB-P03' AND canonical_answer <> $$Yes. Every window and door we sell is a hurricane impact window or door, with impact-resistant glass options for every opening. A specialist checks each opening and matches it to the right impact product for your home and your area's code.$$;

UPDATE kb_faqs
   SET canonical_answer = $$Yes. Every window and door we sell is hurricane impact-rated, with impact-resistant glass options, and a specialist matches each opening to the right one for your home and your area's code.$$,
       notes = coalesce(notes, '') || $$ | ruling (the user, 2026-10-24): adds the website's "impact-resistant glass options"; impact only stands.$$ || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'LIB-P15' AND canonical_answer <> $$Yes. Every window and door we sell is hurricane impact-rated, with impact-resistant glass options, and a specialist matches each opening to the right one for your home and your area's code.$$;

UPDATE kb_faqs
   SET canonical_answer = $$Yes. Our glass blocks up to 95% of UV rays, a major cause of fading on floors, furniture and drapes.$$,
       notes = coalesce(notes, '') || $$ | ruling (the user, 2026-10-24): the website figure, 95%.$$ || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'LIB-P06' AND canonical_answer <> $$Yes. Our glass blocks up to 95% of UV rays, a major cause of fading on floors, furniture and drapes.$$;

UPDATE kb_faqs
   SET canonical_answer = $$Yes. Reece is a licensed and insured Florida contractor, CGC#1507607, with Florida-certified installers and an A+ rating from the BBB.$$,
       notes = coalesce(notes, '') || $$ | ruling (the user, 2026-10-24): the website says licensed, insured and Florida-certified installers.$$ || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'LIB-C02' AND canonical_answer <> $$Yes. Reece is a licensed and insured Florida contractor, CGC#1507607, with Florida-certified installers and an A+ rating from the BBB.$$;

UPDATE kb_faqs
   SET canonical_answer = $$Yes, we offer financing, including no-interest options and PACE, so you can protect your home now and pay over time. A specialist walks you through the terms at the visit.$$,
       notes = coalesce(notes, '') || $$ | ruling (the user, 2026-10-24): name the financing, no numbers. Replaces "0% APR".$$ || ' || prior 2026-10-24: ' || canonical_answer,
       updated_at = now()
 WHERE kb_key = 'LIB-X06' AND canonical_answer <> $$Yes, we offer financing, including no-interest options and PACE, so you can protect your home now and pay over time. A specialist walks you through the terms at the visit.$$;

-- ── check (expect web_rows = 45, every updated flag true) ───────────────────
SELECT (SELECT count(*) FROM kb_faqs WHERE kb_key LIKE 'WEB-%' AND active) AS web_rows,
       (SELECT canonical_answer LIKE 'No window is hurricane-proof%' FROM kb_faqs WHERE kb_key = 'LIB-P01') AS p01_kept,
       (SELECT canonical_answer LIKE '%no-interest%' FROM kb_faqs WHERE kb_key = 'LIB-X06') AS x06,
       (SELECT canonical_answer LIKE '%Bay and bow%' OR canonical_answer LIKE '%bay and bow%' FROM kb_faqs WHERE kb_key = 'KB-02') AS kb02;
