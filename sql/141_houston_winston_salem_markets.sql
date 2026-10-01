-- 141 — Houston TX + Winston-Salem NC service markets, zip 32136 fix, and the
-- KB rows that told visitors Reece serves Florida only (2026-10-01)
--
-- WHAT:
--   1. service_markets gets HOU (Houston) and WSNC (Winston-Salem / Triad).
--      Both use the general number (954) 800-8906 with has_dedicated_phone =
--      false until each market's own phone is known (Mark's ruling 2).
--   2. service_area_zips gets 250 TEMPORARY default zips: every ZCTA whose
--      largest land share sits in one of Mark's default counties (ruling 1).
--        HOU  209: Harris 132, Montgomery 22, Fort Bend 21, Galveston 18, Brazoria 16
--        WSNC  41: Forsyth 16, Stokes 9, Davidson 8, Yadkin 5, Davie 3
--      Generated, never hand-typed, by scripts/build-default-service-zips.js
--      from the US Census 2020 ZCTA↔county relationship file (city names from
--      GeoNames). Reviewable copy: data/service-zips/hou_wsnc_default.csv.
--      Mark's real lists replace these with scripts/import-service-zips.js.
--   3. Zip 32136 is Flagler Beach, Flagler County — it was stored as Umatilla,
--      Lake. market_code stays JAX.
--   4. kb_proof_points "Reece serves Florida only" (ids 38, 76, 114 — three
--      copies from repeated seeding) are deactivated. It was retrievable by
--      kb-retriever and is now false.
--   5. kb_faqs LIB-C03 ("What areas do you serve?") names Houston and
--      Winston-Salem. A list of what we serve that leaves a market out reads
--      as a NO to anyone from that market (see CLAUDE.md, the single-hung
--      lesson). Mirrored in sql/seeds/2026-09-25_golden_kb_v1.sql.
--
-- WHY: Reece serves both markets, but check_service_area answered 77002 and
-- 27101 with "out of mapped service area — do not offer appointments".
--
-- DATA ONLY. No DDL; every column below already exists.
--
-- IDEMPOTENT. Markets use ON CONFLICT DO NOTHING. Zips upsert on zip but only
-- ever overwrite a row that is already HOU/WSNC, so this file can never move a
-- zip out of another market. The UPDATEs are no-ops on a second run.
--
-- AFTER RUNNING:
--   * Re-embed the FAQ: POST /n8n/kb/reembed {"faqs":true}, then
--     GET /n8n/kb/faq-probe?q=do you serve houston  (read would_match).
--   * check_service_area: 77002 → HOU, 27101 → WSNC, 32136 → JAX (Flagler
--     Beach), 75233 → out of area.
--
-- ROLLBACK:
--   DELETE FROM service_area_zips WHERE market_code IN ('HOU','WSNC');
--   DELETE FROM service_markets WHERE market_code IN ('HOU','WSNC');
--   UPDATE service_area_zips SET city='Umatilla', county='Lake' WHERE zip='32136';
--   UPDATE kb_proof_points SET active=true WHERE claim='Reece serves Florida only';
--   (LIB-C03: restore the previous answer from git history of the golden seed.)

BEGIN;

-- ── 1. Markets ──────────────────────────────────────────────────────────────
INSERT INTO service_markets
  (market_code, market_name, service_phone, service_phone_e164, hours, has_dedicated_phone, notes, enabled)
VALUES
  ('HOU', 'Houston', '(954) 800-8906', '+19548008906', 'Mon-Fri 8am-5pm CT', false,
   'TEMP default counties Harris, Fort Bend, Montgomery, Brazoria, Galveston. Dedicated phone TBD. Central time.', true),
  ('WSNC', 'Winston-Salem / Triad', '(954) 800-8906', '+19548008906', 'Mon-Fri 8am-5pm ET', false,
   'TEMP default counties Forsyth, Davie, Davidson, Stokes, Yadkin. Dedicated phone TBD.', true)
ON CONFLICT (market_code) DO NOTHING;

-- ── 2. Default zips (generated — see header) ────────────────────────────────
INSERT INTO service_area_zips (zip, city, county, market_code) VALUES
  ('27006', 'Advance', 'Davie', 'WSNC'),
  ('27009', 'Belews Creek', 'Forsyth', 'WSNC'),
  ('27011', 'Boonville', 'Yadkin', 'WSNC'),
  ('27012', 'Clemmons', 'Forsyth', 'WSNC'),
  ('27014', 'Cooleemee', 'Davie', 'WSNC'),
  ('27016', 'Danbury', 'Stokes', 'WSNC'),
  ('27018', 'East Bend', 'Yadkin', 'WSNC'),
  ('27019', 'Germanton', 'Stokes', 'WSNC'),
  ('27020', 'Hamptonville', 'Yadkin', 'WSNC'),
  ('27021', 'King', 'Stokes', 'WSNC'),
  ('27022', 'Lawsonville', 'Stokes', 'WSNC'),
  ('27023', 'Lewisville', 'Forsyth', 'WSNC'),
  ('27028', 'Mocksville', 'Davie', 'WSNC'),
  ('27040', 'Pfafftown', 'Forsyth', 'WSNC'),
  ('27042', 'Pine Hall', 'Stokes', 'WSNC'),
  ('27043', 'Pinnacle', 'Stokes', 'WSNC'),
  ('27045', 'Rural Hall', 'Forsyth', 'WSNC'),
  ('27046', 'Sandy Ridge', 'Stokes', 'WSNC'),
  ('27050', 'Tobaccoville', 'Forsyth', 'WSNC'),
  ('27051', 'Walkertown', 'Forsyth', 'WSNC'),
  ('27052', 'Walnut Cove', 'Stokes', 'WSNC'),
  ('27053', 'Westfield', 'Stokes', 'WSNC'),
  ('27055', 'Yadkinville', 'Yadkin', 'WSNC'),
  ('27101', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27103', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27104', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27105', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27106', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27107', 'Winston-Salem', 'Davidson', 'WSNC'),
  ('27109', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27110', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27127', 'Winston-Salem', 'Forsyth', 'WSNC'),
  ('27239', 'Denton', 'Davidson', 'WSNC'),
  ('27284', 'Kernersville', 'Forsyth', 'WSNC'),
  ('27292', 'Lexington', 'Davidson', 'WSNC'),
  ('27295', 'Lexington', 'Davidson', 'WSNC'),
  ('27299', 'Linwood', 'Davidson', 'WSNC'),
  ('27351', 'Southmont', 'Davidson', 'WSNC'),
  ('27360', 'Thomasville', 'Davidson', 'WSNC'),
  ('27374', 'Welcome', 'Davidson', 'WSNC'),
  ('28642', 'Jonesville', 'Yadkin', 'WSNC'),
  ('77002', 'Houston', 'Harris', 'HOU'),
  ('77003', 'Houston', 'Harris', 'HOU'),
  ('77004', 'Houston', 'Harris', 'HOU'),
  ('77005', 'Houston', 'Harris', 'HOU'),
  ('77006', 'Houston', 'Harris', 'HOU'),
  ('77007', 'Houston', 'Harris', 'HOU'),
  ('77008', 'Houston', 'Harris', 'HOU'),
  ('77009', 'Houston', 'Harris', 'HOU'),
  ('77010', 'Houston', 'Harris', 'HOU'),
  ('77011', 'Houston', 'Harris', 'HOU'),
  ('77012', 'Houston', 'Harris', 'HOU'),
  ('77013', 'Houston', 'Harris', 'HOU'),
  ('77014', 'Houston', 'Harris', 'HOU'),
  ('77015', 'Houston', 'Harris', 'HOU'),
  ('77016', 'Houston', 'Harris', 'HOU'),
  ('77017', 'Houston', 'Harris', 'HOU'),
  ('77018', 'Houston', 'Harris', 'HOU'),
  ('77019', 'Houston', 'Harris', 'HOU'),
  ('77020', 'Houston', 'Harris', 'HOU'),
  ('77021', 'Houston', 'Harris', 'HOU'),
  ('77022', 'Houston', 'Harris', 'HOU'),
  ('77023', 'Houston', 'Harris', 'HOU'),
  ('77024', 'Houston', 'Harris', 'HOU'),
  ('77025', 'Houston', 'Harris', 'HOU'),
  ('77026', 'Houston', 'Harris', 'HOU'),
  ('77027', 'Houston', 'Harris', 'HOU'),
  ('77028', 'Houston', 'Harris', 'HOU'),
  ('77029', 'Houston', 'Harris', 'HOU'),
  ('77030', 'Houston', 'Harris', 'HOU'),
  ('77031', 'Houston', 'Harris', 'HOU'),
  ('77032', 'Houston', 'Harris', 'HOU'),
  ('77033', 'Houston', 'Harris', 'HOU'),
  ('77034', 'Houston', 'Harris', 'HOU'),
  ('77035', 'Houston', 'Harris', 'HOU'),
  ('77036', 'Houston', 'Harris', 'HOU'),
  ('77037', 'Houston', 'Harris', 'HOU'),
  ('77038', 'Houston', 'Harris', 'HOU'),
  ('77039', 'Houston', 'Harris', 'HOU'),
  ('77040', 'Houston', 'Harris', 'HOU'),
  ('77041', 'Houston', 'Harris', 'HOU'),
  ('77042', 'Houston', 'Harris', 'HOU'),
  ('77043', 'Houston', 'Harris', 'HOU'),
  ('77044', 'Houston', 'Harris', 'HOU'),
  ('77045', 'Houston', 'Harris', 'HOU'),
  ('77046', 'Houston', 'Harris', 'HOU'),
  ('77047', 'Houston', 'Harris', 'HOU'),
  ('77048', 'Houston', 'Harris', 'HOU'),
  ('77049', 'Houston', 'Harris', 'HOU'),
  ('77050', 'Houston', 'Harris', 'HOU'),
  ('77051', 'Houston', 'Harris', 'HOU'),
  ('77053', 'Houston', 'Fort Bend', 'HOU'),
  ('77054', 'Houston', 'Harris', 'HOU'),
  ('77055', 'Houston', 'Harris', 'HOU'),
  ('77056', 'Houston', 'Harris', 'HOU'),
  ('77057', 'Houston', 'Harris', 'HOU'),
  ('77058', 'Houston', 'Harris', 'HOU'),
  ('77059', 'Houston', 'Harris', 'HOU'),
  ('77060', 'Houston', 'Harris', 'HOU'),
  ('77061', 'Houston', 'Harris', 'HOU'),
  ('77062', 'Houston', 'Harris', 'HOU'),
  ('77063', 'Houston', 'Harris', 'HOU'),
  ('77064', 'Houston', 'Harris', 'HOU'),
  ('77065', 'Houston', 'Harris', 'HOU'),
  ('77066', 'Houston', 'Harris', 'HOU'),
  ('77067', 'Houston', 'Harris', 'HOU'),
  ('77068', 'Houston', 'Harris', 'HOU'),
  ('77069', 'Houston', 'Harris', 'HOU'),
  ('77070', 'Houston', 'Harris', 'HOU'),
  ('77071', 'Houston', 'Harris', 'HOU'),
  ('77072', 'Houston', 'Harris', 'HOU'),
  ('77073', 'Houston', 'Harris', 'HOU'),
  ('77074', 'Houston', 'Harris', 'HOU'),
  ('77075', 'Houston', 'Harris', 'HOU'),
  ('77076', 'Houston', 'Harris', 'HOU'),
  ('77077', 'Houston', 'Harris', 'HOU'),
  ('77078', 'Houston', 'Harris', 'HOU'),
  ('77079', 'Houston', 'Harris', 'HOU'),
  ('77080', 'Houston', 'Harris', 'HOU'),
  ('77081', 'Houston', 'Harris', 'HOU'),
  ('77082', 'Houston', 'Harris', 'HOU'),
  ('77083', 'Houston', 'Harris', 'HOU'),
  ('77084', 'Houston', 'Harris', 'HOU'),
  ('77085', 'Houston', 'Harris', 'HOU'),
  ('77086', 'Houston', 'Harris', 'HOU'),
  ('77087', 'Houston', 'Harris', 'HOU'),
  ('77088', 'Houston', 'Harris', 'HOU'),
  ('77089', 'Houston', 'Harris', 'HOU'),
  ('77090', 'Houston', 'Harris', 'HOU'),
  ('77091', 'Houston', 'Harris', 'HOU'),
  ('77092', 'Houston', 'Harris', 'HOU'),
  ('77093', 'Houston', 'Harris', 'HOU'),
  ('77094', 'Houston', 'Harris', 'HOU'),
  ('77095', 'Houston', 'Harris', 'HOU'),
  ('77096', 'Houston', 'Harris', 'HOU'),
  ('77098', 'Houston', 'Harris', 'HOU'),
  ('77099', 'Houston', 'Harris', 'HOU'),
  ('77204', 'Houston', 'Harris', 'HOU'),
  ('77301', 'Conroe', 'Montgomery', 'HOU'),
  ('77302', 'Conroe', 'Montgomery', 'HOU'),
  ('77303', 'Conroe', 'Montgomery', 'HOU'),
  ('77304', 'Conroe', 'Montgomery', 'HOU'),
  ('77306', 'Conroe', 'Montgomery', 'HOU'),
  ('77316', 'Montgomery', 'Montgomery', 'HOU'),
  ('77318', 'Willis', 'Montgomery', 'HOU'),
  ('77336', 'Huffman', 'Harris', 'HOU'),
  ('77338', 'Humble', 'Harris', 'HOU'),
  ('77339', 'Kingwood', 'Harris', 'HOU'),
  ('77345', 'Kingwood', 'Harris', 'HOU'),
  ('77346', 'Humble', 'Harris', 'HOU'),
  ('77354', 'Magnolia', 'Montgomery', 'HOU'),
  ('77355', 'Magnolia', 'Montgomery', 'HOU'),
  ('77356', 'Montgomery', 'Montgomery', 'HOU'),
  ('77357', 'New Caney', 'Montgomery', 'HOU'),
  ('77362', 'Pinehurst', 'Montgomery', 'HOU'),
  ('77365', 'Porter', 'Montgomery', 'HOU'),
  ('77372', 'Splendora', 'Montgomery', 'HOU'),
  ('77373', 'Spring', 'Harris', 'HOU'),
  ('77375', 'Tomball', 'Harris', 'HOU'),
  ('77377', 'Tomball', 'Harris', 'HOU'),
  ('77378', 'Willis', 'Montgomery', 'HOU'),
  ('77379', 'Spring', 'Harris', 'HOU'),
  ('77380', 'Spring', 'Montgomery', 'HOU'),
  ('77381', 'Spring', 'Montgomery', 'HOU'),
  ('77382', 'Spring', 'Montgomery', 'HOU'),
  ('77384', 'Conroe', 'Montgomery', 'HOU'),
  ('77385', 'Conroe', 'Montgomery', 'HOU'),
  ('77386', 'Spring', 'Montgomery', 'HOU'),
  ('77388', 'Spring', 'Harris', 'HOU'),
  ('77389', 'Spring', 'Harris', 'HOU'),
  ('77396', 'Humble', 'Harris', 'HOU'),
  ('77401', 'Bellaire', 'Harris', 'HOU'),
  ('77406', 'Richmond', 'Fort Bend', 'HOU'),
  ('77407', 'Richmond', 'Fort Bend', 'HOU'),
  ('77417', 'Beasley', 'Fort Bend', 'HOU'),
  ('77422', 'Brazoria', 'Brazoria', 'HOU'),
  ('77429', 'Cypress', 'Harris', 'HOU'),
  ('77430', 'Damon', 'Brazoria', 'HOU'),
  ('77431', 'Danciger', 'Brazoria', 'HOU'),
  ('77433', 'Cypress', 'Harris', 'HOU'),
  ('77441', 'Fulshear', 'Fort Bend', 'HOU'),
  ('77444', 'Guy', 'Fort Bend', 'HOU'),
  ('77447', 'Hockley', 'Harris', 'HOU'),
  ('77449', 'Katy', 'Harris', 'HOU'),
  ('77450', 'Katy', 'Harris', 'HOU'),
  ('77451', 'Kendleton', 'Fort Bend', 'HOU'),
  ('77459', 'Missouri City', 'Fort Bend', 'HOU'),
  ('77461', 'Needville', 'Fort Bend', 'HOU'),
  ('77464', 'Orchard', 'Fort Bend', 'HOU'),
  ('77469', 'Richmond', 'Fort Bend', 'HOU'),
  ('77471', 'Rosenberg', 'Fort Bend', 'HOU'),
  ('77476', 'Simonton', 'Fort Bend', 'HOU'),
  ('77477', 'Stafford', 'Fort Bend', 'HOU'),
  ('77478', 'Sugar Land', 'Fort Bend', 'HOU'),
  ('77479', 'Sugar Land', 'Fort Bend', 'HOU'),
  ('77480', 'Sweeny', 'Brazoria', 'HOU'),
  ('77481', 'Thompsons', 'Fort Bend', 'HOU'),
  ('77486', 'West Columbia', 'Brazoria', 'HOU'),
  ('77489', 'Missouri City', 'Fort Bend', 'HOU'),
  ('77493', 'Katy', 'Harris', 'HOU'),
  ('77494', 'Katy', 'Fort Bend', 'HOU'),
  ('77498', 'Sugar Land', 'Fort Bend', 'HOU'),
  ('77502', 'Pasadena', 'Harris', 'HOU'),
  ('77503', 'Pasadena', 'Harris', 'HOU'),
  ('77504', 'Pasadena', 'Harris', 'HOU'),
  ('77505', 'Pasadena', 'Harris', 'HOU'),
  ('77506', 'Pasadena', 'Harris', 'HOU'),
  ('77507', 'Pasadena', 'Harris', 'HOU'),
  ('77510', 'Santa Fe', 'Galveston', 'HOU'),
  ('77511', 'Alvin', 'Brazoria', 'HOU'),
  ('77515', 'Angleton', 'Brazoria', 'HOU'),
  ('77517', 'Santa Fe', 'Galveston', 'HOU'),
  ('77518', 'Bacliff', 'Galveston', 'HOU'),
  ('77520', 'Baytown', 'Harris', 'HOU'),
  ('77521', 'Baytown', 'Harris', 'HOU'),
  ('77530', 'Channelview', 'Harris', 'HOU'),
  ('77531', 'Clute', 'Brazoria', 'HOU'),
  ('77532', 'Crosby', 'Harris', 'HOU'),
  ('77534', 'Danbury', 'Brazoria', 'HOU'),
  ('77536', 'Deer Park', 'Harris', 'HOU'),
  ('77539', 'Dickinson', 'Galveston', 'HOU'),
  ('77541', 'Freeport', 'Brazoria', 'HOU'),
  ('77545', 'Fresno', 'Fort Bend', 'HOU'),
  ('77546', 'Friendswood', 'Galveston', 'HOU'),
  ('77547', 'Galena Park', 'Harris', 'HOU'),
  ('77550', 'Galveston', 'Galveston', 'HOU'),
  ('77551', 'Galveston', 'Galveston', 'HOU'),
  ('77554', 'Galveston', 'Galveston', 'HOU'),
  ('77555', 'Galveston', 'Galveston', 'HOU'),
  ('77562', 'Highlands', 'Harris', 'HOU'),
  ('77563', 'Hitchcock', 'Galveston', 'HOU'),
  ('77565', 'Kemah', 'Galveston', 'HOU'),
  ('77566', 'Lake Jackson', 'Brazoria', 'HOU'),
  ('77568', 'La Marque', 'Galveston', 'HOU'),
  ('77571', 'La Porte', 'Harris', 'HOU'),
  ('77573', 'League City', 'Galveston', 'HOU'),
  ('77577', 'Liverpool', 'Brazoria', 'HOU'),
  ('77578', 'Manvel', 'Brazoria', 'HOU'),
  ('77581', 'Pearland', 'Brazoria', 'HOU'),
  ('77583', 'Rosharon', 'Brazoria', 'HOU'),
  ('77584', 'Pearland', 'Brazoria', 'HOU'),
  ('77586', 'Seabrook', 'Harris', 'HOU'),
  ('77587', 'South Houston', 'Harris', 'HOU'),
  ('77590', 'Texas City', 'Galveston', 'HOU'),
  ('77591', 'Texas City', 'Galveston', 'HOU'),
  ('77598', 'Webster', 'Harris', 'HOU'),
  ('77617', 'Gilchrist', 'Galveston', 'HOU'),
  ('77623', 'High Island', 'Galveston', 'HOU'),
  ('77650', 'Port Bolivar', 'Galveston', 'HOU'),
  ('77873', 'Richards', 'Montgomery', 'HOU')
ON CONFLICT (zip) DO UPDATE
   SET city = EXCLUDED.city, county = EXCLUDED.county, market_code = EXCLUDED.market_code, updated_at = now()
 WHERE service_area_zips.market_code IN ('HOU', 'WSNC');

-- ── 3. 32136 is Flagler Beach ───────────────────────────────────────────────
UPDATE service_area_zips
   SET city = 'Flagler Beach', county = 'Flagler', updated_at = now()
 WHERE zip = '32136' AND (city IS DISTINCT FROM 'Flagler Beach' OR county IS DISTINCT FROM 'Flagler');

-- ── 4. "Reece serves Florida only" is no longer true ────────────────────────
UPDATE kb_proof_points
   SET active = false,
       notes = concat_ws(' ', notes, 'Deactivated 2026-10-01 (sql/141): Reece also serves Houston TX and Winston-Salem NC.'),
       updated_at = now()
 WHERE claim = 'Reece serves Florida only' AND active;

-- ── 5. LIB-C03 names every market ───────────────────────────────────────────
UPDATE kb_faqs
   SET canonical_answer = $$We're based in St. Petersburg and serve Fort Lauderdale, Tampa, St. Petersburg, Sarasota, Fort Myers, Lakeland, Orlando, and Jacksonville in Florida, plus Houston, Texas and Winston-Salem, North Carolina. Send me your zip code and I'll confirm we cover your home.$$,
       updated_at = now()
 WHERE kb_key = 'LIB-C03'
   AND canonical_answer IS DISTINCT FROM $$We're based in St. Petersburg and serve Fort Lauderdale, Tampa, St. Petersburg, Sarasota, Fort Myers, Lakeland, Orlando, and Jacksonville in Florida, plus Houston, Texas and Winston-Salem, North Carolina. Send me your zip code and I'll confirm we cover your home.$$;

COMMIT;

-- ── Checks (read-only) ──────────────────────────────────────────────────────
-- Expect HOU 209, WSNC 41; 32136 Flagler Beach / Flagler / JAX; 0 active "Florida only".
SELECT json_build_object(
  'zips_per_market', (SELECT json_object_agg(market_code, n) FROM (SELECT market_code, count(*) n FROM service_area_zips WHERE market_code IN ('HOU','WSNC') GROUP BY 1) s),
  'markets', (SELECT json_agg(row_to_json(m)) FROM (SELECT market_code, market_name, service_phone, has_dedicated_phone, hours, enabled FROM service_markets WHERE market_code IN ('HOU','WSNC')) m),
  'zip_32136', (SELECT row_to_json(z) FROM (SELECT zip, city, county, market_code FROM service_area_zips WHERE zip = '32136') z),
  'florida_only_active', (SELECT count(*) FROM kb_proof_points WHERE claim = 'Reece serves Florida only' AND active),
  'lib_c03', (SELECT canonical_answer FROM kb_faqs WHERE kb_key = 'LIB-C03')
) AS sql_141_check;
