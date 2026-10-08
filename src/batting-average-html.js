/**
 * LightFire batting average — the page. src/batting-average-html.js
 *
 * Pure: scorecard model (batting-average.js buildScorecard) → one
 * self-contained HTML string. No external scripts, fonts or images, so the file
 * can be emailed or opened offline. Built phone-first (375px): the stat line and
 * the scoreboard strip scroll inside themselves, never the page.
 *
 * Brad's brief: readable in 10 seconds, baseball throughout, a scoreboard and
 * not a business chart, positive coaching tone.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const per100Text = (v) => (v == null ? '—' : Number(v).toFixed(1));

const ARROW = { up: '▲', down: '▼', even: '■' };

/** "0.8 hits per 100 to go" / "0.4 hits per 100 ahead" — the gap to February, in the page's own unit. */
function gapText(h) {
  if (h.per100 == null || h.febPer100 == null) return '';
  const gap = Math.abs(Math.round((h.per100 - h.febPer100) * 10) / 10);
  if (h.direction === 'up') return `${per100Text(gap)} hits per 100 ahead of Feb`;
  if (h.direction === 'down') return `${per100Text(gap)} hits per 100 to go`;
  return 'even with Feb';
}
const RESULT = {
  win: { icon: '✓', label: 'Win' },
  work_on: { icon: '↗', label: 'Work on' },
  maturing: { icon: '⏳', label: 'Maturing' },
  baseline: { icon: '⚾', label: 'To beat' },
  reference: { icon: '–', label: 'Before' },
};

function statRows(rows) {
  return rows.map((r) => `
        <tr>
          <th scope="row">${esc(r.label)}${r.note ? `<span class="tag">${esc(r.note)}</span>` : ''}</th>
          <td>${num(r.atBats)}</td><td>${num(r.walks)}</td><td>${num(r.onBase)}</td><td>${num(r.hits)}</td>
          <td class="avg">${esc(r.text)}</td>
        </tr>`).join('');
}

function scoreboard(model) {
  const innings = model.innings;
  const feb = innings.find((i) => i.result === 'baseline');
  const max = Math.max(1, ...innings.map((i) => i.per100 || 0)) * 1.15;
  const lineAt = feb && feb.per100 != null ? (feb.per100 / max) * 100 : null;
  const cols = innings.map((i, idx) => {
    const r = RESULT[i.result];
    const h = i.per100 == null ? 0 : Math.max(2, (i.per100 / max) * 100);
    const detail = `${i.label}: ${i.hits} hits in ${num(i.atBats)} at bats (${i.text})`;
    return `
      <button type="button" class="inning ${i.result}" data-detail="${esc(detail)}" aria-label="${esc(detail)}, ${r.label}" aria-pressed="${idx === innings.length - 1}">
        <span class="inn-label">${esc(i.label.replace(/ MTD$/, ''))}</span>
        <span class="digit">${per100Text(i.per100)}</span>
        <span class="gauge"><span class="bar" style="height:${h.toFixed(1)}%"></span></span>
        <span class="result"><span class="ico" aria-hidden="true">${r.icon}</span>${r.label}</span>
      </button>`;
  }).join('');
  const last = innings[innings.length - 1];
  return `
    <section class="board-wrap" aria-labelledby="sb-title">
      <h2 id="sb-title">The scoreboard <span class="sub">hits per 100 at bats, by inning</span></h2>
      ${lineAt == null ? '' : `<p class="legend"><span class="dash" aria-hidden="true"></span> February ${per100Text(feb.per100)}: the number to beat</p>`}
      <div class="board">
        <div class="strip" style="--line:${lineAt == null ? -10 : lineAt.toFixed(1)}">
          ${cols}
          ${lineAt == null ? '' : '<span class="tobeat" aria-hidden="true"></span>'}
        </div>
      </div>
      <p class="tapline" id="tapline" aria-live="polite">${esc(`${last.label}: ${last.hits} hits in ${num(last.atBats)} at bats (${last.text})`)}</p>
    </section>`;
}

export function renderScorecardHtml(model, { generatedAt = new Date(), title = 'LightFire Batting Average', context = null } = {}) {
  const h = model.headline;
  const dir = h.direction;
  const streak = model.hotStreak
    ? `<div class="callout hot"><span class="big" aria-hidden="true">🔥</span><div><strong>Hot streak!</strong> The average has gone up ${model.hotStreak.rises} months in a row.</div></div>`
    : '';
  const monthName = new Date(`${model.todayMonth}-01T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const asOf = generatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #f6f4ee; --card: #ffffff; --ink: #14140f; --ink-2: #52514e; --ink-3: #75736c; --rule: #e2dfd5;
  --board: #17402a; --board-2: #0f2e1e; --board-ink: #f3efe0; --board-dim: #a9b8a8; --led: #ffd257;
  --good: #0ca30c; --warn: #fab219; --accent: #b3261e;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #1a1a19; --card: #232321; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #9d9b92; --rule: #3a3936;
    --board: #143823; --board-2: #0c2618; --accent: #ef6b62; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #1a1a19; --card: #232321; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #9d9b92; --rule: #3a3936;
  --board: #143823; --board-2: #0c2618; --accent: #ef6b62; color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 20px 16px 40px; }
.kicker { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 6px; }
h1 { font-size: 22px; margin: 0 0 16px; line-height: 1.2; }
h2 { font-size: 17px; margin: 0 0 10px; }
h2 .sub { display: block; font-size: 13px; font-weight: 400; color: var(--ink-3); }
.hero { background: radial-gradient(120% 140% at 50% 0%, var(--board) 0%, var(--board-2) 100%); color: var(--board-ink);
  border-radius: 14px; padding: 20px 18px; text-align: center; border: 4px solid #2c5a3f; box-shadow: inset 0 0 0 2px #0a1f14; }
.hero .who { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--board-dim); }
.hero .avg { font: 700 64px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--led);
  letter-spacing: .04em; margin: 8px 0 4px; text-shadow: 0 0 12px rgba(255,210,87,.35); font-variant-numeric: tabular-nums; }
.hero .per { font-size: 18px; font-weight: 600; }
.hero .vs { margin-top: 10px; font-size: 15px; color: var(--board-ink); }
.hero .vs .arrow { font-size: 13px; padding: 2px 8px; border-radius: 999px; margin-left: 4px; white-space: nowrap; }
.hero .vs .arrow.up { background: rgba(12,163,12,.25); color: #7fe27f; }
.hero .vs .arrow.down { background: rgba(250,178,25,.2); color: var(--led); }
.hero .span { margin-top: 8px; font-size: 12px; color: var(--board-dim); }
.hero .context { margin-top: 10px; font-size: 13px; color: var(--board-ink); border-top: 1px dashed #2c5a3f; padding-top: 8px; }
.callout { display: flex; gap: 12px; align-items: flex-start; background: var(--card); border: 1px solid var(--rule);
  border-radius: 12px; padding: 14px; margin-top: 14px; }
.callout .big { font-size: 22px; line-height: 1; }
.callout.coach { border-left: 4px solid var(--accent); }
.callout .lbl { display: block; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 2px; }
section { margin-top: 26px; }
.board { background: var(--board-2); border-radius: 12px; padding: 10px 6px; overflow-x: auto; border: 3px solid #2c5a3f; }
.strip { --gauge-h: 64px; --gauge-base: 41px; position: relative; display: flex; gap: 5px; min-width: min-content; }
.inning { flex: 1 0 48px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 2px;
  background: #0a2015; border: 1px solid #23503a; border-radius: 8px; color: var(--board-ink); font: inherit; cursor: pointer; min-height: 32px; }
.inning[aria-pressed="true"] { outline: 2px solid var(--led); outline-offset: 1px; }
.inn-label { font-size: 11px; line-height: 14px; letter-spacing: .08em; text-transform: uppercase; color: var(--board-dim); white-space: nowrap; }
.digit { font: 700 21px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--led); font-variant-numeric: tabular-nums; }
.gauge { position: relative; width: 14px; height: var(--gauge-h); background: #123222; border-radius: 4px; display: flex; align-items: flex-end; }
.bar { display: block; width: 100%; border-radius: 4px 4px 0 0; background: var(--board-dim); }
.inning.win .bar { background: var(--good); }
.inning.work_on .bar { background: var(--warn); }
.inning.baseline .bar { background: var(--board-ink); }
.inning.maturing .bar { background: repeating-linear-gradient(45deg, #6f8a74 0 3px, #3d5a45 3px 6px); }
.result { display: flex; flex-direction: column; align-items: center; font-size: 10px; line-height: 13px; height: 26px; white-space: nowrap; color: var(--board-dim); }
.inning.win .result { color: #7fe27f; }
.inning.work_on .result { color: var(--warn); }
/* The dashed "number to beat" runs across every gauge at February's height.
   Gauges sit 70px tall, ending 8px + 11px label + 6px gap above each inning's bottom edge. */
.tobeat { position: absolute; left: 0; right: 0; bottom: calc(var(--gauge-base) + var(--gauge-h) * var(--line) / 100); border-top: 2px dashed var(--led);
  pointer-events: none; }
.legend { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); margin: 0 0 8px; }
.legend .dash { display: inline-block; width: 26px; border-top: 2px dashed currentColor; }
.tapline { font-size: 13px; color: var(--ink-2); margin: 8px 2px 0; }
.table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--rule); border-radius: 12px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { padding: 8px 5px; text-align: right; border-bottom: 1px solid var(--rule); white-space: nowrap; }
th[scope="row"], thead th:first-child { text-align: left; }
thead th { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
tbody.season th[colspan] { text-align: left; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); background: transparent; }
td.avg { font-weight: 700; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.tag { display: block; font-size: 10px; font-weight: 400; color: var(--ink-3); white-space: normal; }
th[scope="row"] .tag { max-width: 84px; }
.howto { font-size: 13px; color: var(--ink-2); }
.howto dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; }
.howto dt { font-weight: 600; color: var(--ink); }
.howto dd { margin: 0; }
footer { margin-top: 24px; font-size: 12px; color: var(--ink-3); }
@media (min-width: 640px) { main { padding: 32px 24px 48px; } h1 { font-size: 26px; } .hero .avg { font-size: 84px; } table { font-size: 15px; }
  th, td { padding: 9px 10px; } .inning { flex-basis: 76px; } .digit { font-size: 28px; } .inn-label { font-size: 12px; } .result { font-size: 11px; } th[scope="row"] .tag { max-width: none; } }
@media (forced-colors: active) { .bar { background: CanvasText !important; } .tobeat { border-top-color: CanvasText; } }
</style>
</head>
<body>
<main>
  <p class="kicker">LightFire Partners · ${esc(monthName)}</p>
  <h1>Out of 100 at bats, how many sales does LightFire produce?</h1>

  <section class="hero" aria-label="Headline" style="margin-top:0">
    <div class="who">LightFire is batting</div>
    <div class="avg">${esc(h.text)}</div>
    <div class="per">${per100Text(h.per100)} hits per 100 at bats</div>
    <div class="vs">Number to beat (February): <strong>${esc(h.febText)}</strong>
      ${dir ? `<span class="arrow ${dir}">${ARROW[dir]} ${gapText(h)}</span>` : ''}</div>
    ${context ? `<div class="context">${esc(context)}</div>` : ''}
    <div class="span">${esc(h.span)}${h.maturedOnly ? ' · matured months only; the newest months are still collecting sales' : ' · includes months still maturing'}</div>
  </section>

  ${streak}
  <div class="callout coach"><span class="big" aria-hidden="true">🧢</span><div><span class="lbl">From the dugout</span>${esc(model.coaching.line)}</div></div>

  ${scoreboard(model)}

  <section aria-labelledby="sl-title">
    <h2 id="sl-title">Season stat line <span class="sub">every lead counted in the month it came in</span></h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">At bats</th><th scope="col">Walks<span class="tag">sets</span></th>
          <th scope="col">On base<span class="tag">demos</span></th><th scope="col">Hits<span class="tag">sales</span></th><th scope="col">AVG</th></tr></thead>
        <tbody class="season"><tr><th colspan="6">Last season · before LightFire</th></tr>${statRows(model.rows.last)}</tbody>
        <tbody class="season"><tr><th colspan="6">This season · LightFire${model.startDate ? ` (from ${esc(model.startDate)})` : ''}</th></tr>${statRows(model.rows.this)}</tbody>
      </table>
    </div>
  </section>

  <section class="howto" aria-labelledby="how-title">
    <h2 id="how-title">How we keep score</h2>
    <dl>
      <dt>At bat</dt><dd>A new incoming lead where LightFire made the first setter call. Each lead counts once.</dd>
      <dt>Walk</dt><dd>Appointment set.</dd>
      <dt>On base</dt><dd>Demo.</dd>
      <dt>Hit</dt><dd>Sale.</dd>
      <dt>AVG</dt><dd>Hits ÷ at bats. 9 sales per 100 at bats = .090.</dd>
    </dl>
    <p>Last season (February and Q2) counts every new lead from LP's own monthly report, because Five9 holds no calls before July.</p>
    <p>Not counted: canvass, previous customers, rep self-generated leads, rehash, and appointments that already existed when the setter called. Sales trail the lead by several weeks, so the two newest months are still maturing and will rise.</p>
  </section>

  <footer>Updated ${esc(asOf)} · Calls from Five9 · sets, demos and sales from LP</footer>
</main>
<script>
(function () {
  var line = document.getElementById('tapline');
  var cells = document.querySelectorAll('.inning');
  for (var i = 0; i < cells.length; i++) {
    cells[i].addEventListener('click', function (e) {
      for (var j = 0; j < cells.length; j++) cells[j].setAttribute('aria-pressed', 'false');
      e.currentTarget.setAttribute('aria-pressed', 'true');
      line.textContent = e.currentTarget.getAttribute('data-detail');
    });
  }
})();
</script>
</body>
</html>
`;
}
