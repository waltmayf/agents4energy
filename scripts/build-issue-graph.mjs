#!/usr/bin/env node
// Build a self-contained HTML dependency graph from a GitHub project's issues.
//
// Pulls every issue via `gh`, reads each issue's *native* GitHub dependencies
// (the blocked-by / blocking feature), and emits a single offline HTML file:
//   - a left→right DAG of dependency-linked issues, columns = dependency depth,
//   - the longest chain still gating open work highlighted as the critical path,
//   - every remaining (unlinked) issue listed in a backlog section, grouped by
//     milestone, so the whole project is represented — not just the linked part.
//
// Usage:
//   node scripts/build-issue-graph.mjs --repo owner/name [options]
//
// Options:
//   --repo   owner/name           (required)  target repository
//   --out    path.html            (default ./issue-dependency-graph.html)
//   --state  all|open|closed      (default all)   which issues to include
//   --limit  N                    (default 1000)  max issues to fetch
//   --open   /path/to/open        (optional)  command to open the file when done
//
// Requires: `gh` authenticated for the target repo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const execFileP = promisify(execFile);
const gh = (args) =>
  execFileP('gh', args, { maxBuffer: 128 * 1024 * 1024 }).then((r) => r.stdout);

// ---- args ----------------------------------------------------------------
let values;
try {
  ({ values } = parseArgs({
    options: {
      repo: { type: 'string' },
      out: { type: 'string', default: 'issue-dependency-graph.html' },
      state: { type: 'string', default: 'all' },
      limit: { type: 'string', default: '1000' },
      open: { type: 'string' },
    },
  }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!values.repo || !values.repo.includes('/')) {
  console.error('usage: node scripts/build-issue-graph.mjs --repo owner/name [--out file] [--state all|open|closed] [--limit N]');
  process.exit(1);
}
const REPO = values.repo;
const [OWNER, NAME] = REPO.split('/');

// ---- concurrency pool ----------------------------------------------------
async function pool(items, size, worker) {
  const queue = [...items];
  let done = 0;
  const total = items.length;
  const runners = Array.from({ length: Math.min(size, total) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
      done++;
      if (done % 20 === 0 || done === total) {
        process.stderr.write(`\r  dependencies: ${done}/${total}`);
      }
    }
  });
  await Promise.all(runners);
  if (total) process.stderr.write('\n');
}

// ---- fetch issues --------------------------------------------------------
console.error(`Fetching issues for ${REPO} (state=${values.state}) …`);
const issues = JSON.parse(
  await gh([
    'issue', 'list', '--repo', REPO, '--state', values.state,
    '--limit', values.limit,
    '--json', 'number,title,state,labels,milestone,createdAt,closedAt',
  ])
);
console.error(`  ${issues.length} issues`);
const present = new Set(issues.map((i) => i.number));

// ---- fetch native blocked-by for each issue ------------------------------
// One direction is enough: edge (a → b) "a blocks b" ⇔ b blocked_by a.
const blockedBy = {};
await pool(issues, 8, async (iss) => {
  try {
    // Plain GET (no -F, which would flip gh to POST). Dependency lists are small,
    // so one page of 100 is plenty; parse the numbers in JS.
    const out = await gh([
      'api', `repos/${OWNER}/${NAME}/issues/${iss.number}/dependencies/blocked_by?per_page=100`,
      '--jq', '[.[].number]',
    ]);
    blockedBy[iss.number] = JSON.parse((out || '').trim() || '[]');
  } catch {
    blockedBy[iss.number] = []; // endpoint 404 / no deps
  }
});

// ---- assemble nodes + edges ---------------------------------------------
const nodes = {};
for (const i of issues) {
  nodes[i.number] = {
    t: i.title,
    s: i.state.toLowerCase(),
    m: (i.milestone && i.milestone.title) || null,
    labels: (i.labels || []).map((l) => l.name),
  };
}
const edges = [];
let dropped = 0;
for (const i of issues) {
  for (const a of blockedBy[i.number] || []) {
    if (present.has(a)) edges.push([a, i.number]); // a blocks i
    else dropped++; // blocker filtered out by --state
  }
}
const edgeCount = edges.length;
const linked = new Set(edges.flat());
console.error(`  ${edgeCount} dependency edges, ${linked.size} linked issues, ${issues.length - linked.size} in backlog`);
if (dropped) console.error(`  (${dropped} edges dropped — blocker outside --state=${values.state}; use --state all for the full graph)`);

// ---- emit HTML -----------------------------------------------------------
const DATA = {
  repo: REPO,
  generatedAt: new Date().toISOString().slice(0, 10),
  counts: {
    total: issues.length,
    open: issues.filter((i) => i.state.toLowerCase() === 'open').length,
    edges: edgeCount,
    linked: linked.size,
  },
  nodes,
  edges,
};

// emit() is called at the very end, after CSS / clientMain consts are initialized.
function emit() {
  writeFileSync(values.out, buildHtml(DATA));
  console.error(`\nWrote ${values.out}`);
  if (values.open) execFile(values.open, [values.out]);
}

// =====================================================================
// Everything below runs in the BROWSER. clientMain is serialized via
// Function.prototype.toString() so it stays real, editable JS here (no
// escaping) and the generator never executes it. It reads window.__DATA__.
// =====================================================================
function buildHtml(data) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.repo} · issue dependency graph</title>
<style>${CSS}</style></head>
<body>
<div id="app"></div>
<div class="tip" id="tip"></div>
<script>window.__DATA__ = ${JSON.stringify(data)};</script>
<script>(${clientMain.toString()})();</script>
</body></html>`;
}

const CSS = `
:root{
  --surface-0:#f4f4f2;--surface-1:#fcfcfb;--surface-2:#ffffff;
  --border:#e3e3df;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#8a8984;
  --ready:#2a78d6;--blocked:#fab219;--done:#0ca30c;
  --edge:#c9c9c4;--edge-crit:#d03b3b;
  --node-done-fill:#eef0ee;--node-done-border:#cdd3cd;--chip-open:#2a78d6;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  --surface-0:#141413;--surface-1:#1a1a19;--surface-2:#232321;
  --border:#33332f;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#87867e;
  --ready:#3987e5;--blocked:#fab219;--done:#0ca30c;
  --edge:#3a3a36;--edge-crit:#e66767;--node-done-fill:#20211e;--node-done-border:#39392f;--chip-open:#3987e5;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-0);color:var(--text-primary);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
header{padding:26px 32px 4px}
h1{font-size:19px;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--text-secondary);font-size:13px;margin:0}
.wrap{padding:6px 24px 48px;max-width:1240px;margin:0 auto}
.legend{display:flex;flex-wrap:wrap;gap:6px 20px;margin:14px 8px 16px;font-size:12.5px;color:var(--text-secondary);align-items:center}
.legend .item{display:flex;align-items:center;gap:7px}
.sw{width:13px;height:13px;border-radius:4px;flex:none}
.sw.ready{background:var(--ready)}.sw.blocked{background:var(--blocked)}
.sw.done{background:var(--node-done-fill);border:1.5px solid var(--node-done-border)}
.lg-line{width:22px;height:0;border-top:2px solid var(--edge)}
.lg-line.crit{border-top:2.5px solid var(--edge-crit)}
label.toggle{margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.board{background:var(--surface-1);border:1px solid var(--border);border-radius:14px;padding:10px 6px 6px;overflow-x:auto}
svg{display:block;height:auto}
.col-label{fill:var(--text-muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.node rect{stroke-width:1.5}
.node.done rect{fill:var(--node-done-fill);stroke:var(--node-done-border)}
.node.ready rect{fill:var(--surface-2);stroke:var(--ready);stroke-width:2.25}
.node.blocked rect{fill:var(--surface-2);stroke:var(--blocked);stroke-width:2.25}
.node .num{font-weight:700;font-size:13px}
.node.done .num{fill:var(--text-muted)}.node.ready .num{fill:var(--ready)}.node.blocked .num{fill:var(--text-primary)}
.node .title{font-size:11px}
.node.done .title{fill:var(--text-muted)}.node:not(.done) .title{fill:var(--text-secondary)}
.node .badge{font-size:10px;font-weight:700}
.node{cursor:default}.node:hover rect{filter:brightness(1.03)}
body.openonly .node.done{opacity:.14}
.edge{fill:none;stroke:var(--edge);stroke-width:2}
.edge.crit{stroke:var(--edge-crit);stroke-width:2.5}
.tip{position:fixed;pointer-events:none;z-index:10;background:var(--surface-2);border:1px solid var(--border);
  border-radius:9px;padding:9px 11px;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:12.5px;opacity:0;transition:opacity .1s}
.tip .t-num{font-weight:700;margin-bottom:2px}
.tip .t-meta{color:var(--text-secondary);font-size:11.5px;margin-top:5px}
.tip .t-state{display:inline-block;padding:1px 7px;border-radius:99px;font-size:10.5px;font-weight:700;margin-top:6px}
h2{font-size:14px;margin:28px 6px 4px;font-weight:650}
h2 .muted{color:var(--text-muted);font-weight:500}
.ms-group{margin:14px 4px}
.ms-title{font-size:12px;color:var(--text-secondary);font-weight:600;margin:0 0 7px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{display:flex;gap:6px;align-items:baseline;max-width:270px;padding:5px 10px;border-radius:8px;
  background:var(--surface-1);border:1px solid var(--border);font-size:12px;border-left-width:3px}
.chip.open{border-left-color:var(--chip-open)}
.chip.closed{border-left-color:var(--node-done-border);color:var(--text-muted)}
body.openonly .chip.closed{display:none}
.chip .cn{font-weight:700;flex:none}
.chip .ct{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.foot{color:var(--text-muted);font-size:11.5px;margin:18px 8px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
a{color:inherit}
`;

// ---- browser entry point -------------------------------------------------
function clientMain() {
  const D = window.__DATA__;
  const NODES = D.nodes;
  const EDGES = D.edges;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (t, a = {}, kids = []) => {
    const n = document.createElementNS(NS, t);
    for (const k in a) n.setAttribute(k, a[k]);
    for (const c of kids) n.appendChild(c);
    return n;
  };

  // classify state / readiness
  const isOpen = (n) => NODES[n].s === 'open';
  function cls(n) {
    if (!isOpen(n)) return 'done';
    return EDGES.some(([a, b]) => b == n && isOpen(a)) ? 'blocked' : 'ready';
  }

  // connected (has any edge) vs backlog
  const deg = {};
  Object.keys(NODES).forEach((n) => (deg[n] = 0));
  EDGES.forEach(([a, b]) => { deg[a]++; deg[b]++; });
  const linked = Object.keys(NODES).filter((n) => deg[n] > 0).map(Number);
  const backlog = Object.keys(NODES).filter((n) => deg[n] === 0).map(Number);

  // longest-path depth (DAG; cycle-guarded by iteration cap)
  const depth = {};
  linked.forEach((n) => (depth[n] = 0));
  for (let i = 0; i < linked.length + 5; i++) {
    let changed = false;
    EDGES.forEach(([a, b]) => { if (depth[b] < depth[a] + 1) { depth[b] = depth[a] + 1; changed = true; } });
    if (!changed) break;
  }
  const cols = [...new Set(linked.map((n) => depth[n]))].sort((a, b) => a - b);

  // group by column, order within column by barycenter of neighbors (reduce crossings)
  const byCol = {};
  cols.forEach((c) => (byCol[c] = []));
  linked.forEach((n) => byCol[depth[n]].push(n));
  Object.values(byCol).forEach((arr) => arr.sort((a, b) => a - b));
  const orderIndex = () => { const o = {}; cols.forEach((c) => byCol[c].forEach((n, i) => (o[n] = i))); return o; };
  for (let pass = 0; pass < 6; pass++) {
    const o = orderIndex();
    cols.forEach((c) => {
      byCol[c].sort((x, y) => {
        const bc = (n) => {
          const nb = EDGES.filter(([a, b]) => a == n || b == n).map(([a, b]) => (a == n ? b : a)).filter((m) => depth[m] !== c);
          if (!nb.length) return o[n];
          return nb.reduce((s, m) => s + o[m], 0) / nb.length;
        };
        return bc(x) - bc(y);
      });
    });
  }

  // critical path: longest chain gating open work
  const crit = new Set();
  (() => {
    const openBlocked = linked.filter((n) => isOpen(n) && EDGES.some(([a, b]) => b == n && isOpen(a)));
    const pool = openBlocked.length ? openBlocked : linked.filter(isOpen);
    if (!pool.length) return;
    let target = pool[0];
    pool.forEach((n) => { if (depth[n] > depth[target]) target = n; });
    let n = target;
    while (depth[n] > 0) {
      const pred = EDGES.filter(([a, b]) => b == n && depth[a] === depth[n] - 1).map(([a]) => a);
      if (!pred.length) break;
      crit.add(pred[0] + '->' + n);
      n = pred[0];
    }
  })();

  // ---- layout geometry ----
  const NW = 190, NH = 58, HGAP = 92, VGAP = 24, padX = 60, padTop = 44;
  const step = NW + HGAP;
  const maxCount = Math.max(1, ...cols.map((c) => byCol[c].length));
  const W = padX * 2 + (cols.length - 1) * step + NW;
  const H = padTop + maxCount * (NH + VGAP) + 10;
  const pos = {};
  cols.forEach((c, ci) => {
    const arr = byCol[c], total = arr.length * NH + (arr.length - 1) * VGAP;
    const startY = padTop + (H - padTop - 10 - total) / 2;
    arr.forEach((id, i) => (pos[id] = { x: padX + ci * step, y: startY + i * (NH + VGAP) }));
  });

  // ---- build DOM ----
  const app = document.getElementById('app');
  const c = D.counts;
  app.innerHTML =
    '<header><h1>' + D.repo + ' · issue dependency graph</h1>' +
    '<p class="sub">Native GitHub <em>blocked-by</em> relationships, laid out left→right by dependency depth. ' +
    '<strong>' + c.open + ' open</strong> of ' + c.total + ' issues · ' + c.edges + ' dependency links · ' +
    c.linked + ' linked, ' + (c.total - c.linked) + ' unlinked.</p></header>' +
    '<div class="wrap">' +
      '<div class="legend">' +
        '<span class="item"><span class="sw ready"></span> Open · ready</span>' +
        '<span class="item"><span class="sw blocked"></span> Open · blocked</span>' +
        '<span class="item"><span class="sw done"></span> Closed</span>' +
        '<span class="item"><span class="lg-line crit"></span> Critical path</span>' +
        '<span class="item"><span class="lg-line"></span> blocker → dependent</span>' +
        '<label class="toggle"><input type="checkbox" id="openonly"> open only</label>' +
      '</div>' +
      (linked.length ? '<div class="board" id="board"></div>'
                     : '<p class="sub" style="margin:20px 8px">No native dependency links found in this project.</p>') +
      '<div id="backlog"></div>' +
      '<p class="foot">Snapshot ' + D.generatedAt + '. Source of truth: GitHub native issue dependencies ' +
      '(<code>gh api …/dependencies/blocked_by</code>). Regenerate with ' +
      '<code>node scripts/build-issue-graph.mjs --repo ' + D.repo + '</code>.</p>' +
    '</div>';

  document.getElementById('openonly').addEventListener('change', (e) =>
    document.body.classList.toggle('openonly', e.target.checked));

  // ---- SVG DAG ----
  if (linked.length) {
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, style: 'min-width:' + Math.min(W, 900) + 'px;max-width:100%' });
    svg.appendChild(el('defs')).innerHTML =
      '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--edge)"/></marker>' +
      '<marker id="arrow-crit" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="var(--edge-crit)"/></marker>';

    cols.forEach((col, ci) => {
      const label = col === 0 ? 'no blockers' : 'depth ' + col;
      svg.appendChild(el('text', { class: 'col-label', x: padX + ci * step + NW / 2, y: 26, 'text-anchor': 'middle' }))
        .textContent = label;
    });

    EDGES.forEach(([a, b]) => {
      const p1 = pos[a], p2 = pos[b];
      const x1 = p1.x + NW, y1 = p1.y + NH / 2, x2 = p2.x, y2 = p2.y + NH / 2, mx = (x1 + x2) / 2;
      const isCrit = crit.has(a + '->' + b);
      svg.appendChild(el('path', {
        d: 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2,
        class: 'edge' + (isCrit ? ' crit' : ''),
        'marker-end': isCrit ? 'url(#arrow-crit)' : 'url(#arrow)',
      }));
    });

    const tip = document.getElementById('tip');
    linked.forEach((n) => {
      const p = pos[n], k = cls(n), info = NODES[n];
      const g = el('g', { class: 'node ' + k, transform: 'translate(' + p.x + ',' + p.y + ')' });
      g.appendChild(el('rect', { width: NW, height: NH, rx: 11 }));
      g.appendChild(el('text', { class: 'num', x: 12, y: 21 })).textContent = '#' + n;
      const badge = el('text', { class: 'badge', x: NW - 12, y: 21, 'text-anchor': 'end',
        fill: k === 'done' ? 'var(--text-muted)' : k === 'ready' ? 'var(--ready)' : 'var(--blocked)' });
      badge.textContent = k === 'done' ? '✓ closed' : k === 'ready' ? '● ready' : '▲ blocked';
      g.appendChild(badge);
      // 2-line title
      const words = info.t.split(' '); let l1 = '', l2 = '';
      for (const w of words) { if ((l1 + ' ' + w).trim().length <= 30 && !l2) l1 = (l1 + ' ' + w).trim(); else l2 = (l2 + ' ' + w).trim(); }
      if (l2.length > 32) l2 = l2.slice(0, 31) + '…';
      [l1, l2].forEach((ln, i) => { if (ln) g.appendChild(el('text', { class: 'title', x: 12, y: 37 + i * 13 })).textContent = ln; });
      g.addEventListener('mousemove', (e) => {
        tip.style.opacity = 1; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
        const col = k === 'done' ? 'var(--done)' : k === 'ready' ? 'var(--ready)' : 'var(--blocked)';
        const bby = EDGES.filter(([, b]) => b == n).map(([a]) => '#' + a);
        const bks = EDGES.filter(([a]) => a == n).map(([, b]) => '#' + b);
        tip.innerHTML = '<div class="t-num">#' + n + ' · ' + info.t + '</div>' +
          '<div class="t-state" style="background:' + col + '22;color:' + col + '">' + info.s.toUpperCase() + '</div>' +
          '<div class="t-meta">milestone: ' + (info.m || '—') + '<br>blocked by: ' + (bby.length ? bby.join(', ') : '—') +
          '<br>blocks: ' + (bks.length ? bks.join(', ') : '—') + '</div>';
      });
      g.addEventListener('mouseleave', () => (tip.style.opacity = 0));
      svg.appendChild(g);
    });
    document.getElementById('board').appendChild(svg);
  }

  // ---- backlog (unlinked issues), grouped by milestone ----
  if (backlog.length) {
    const bl = document.getElementById('backlog');
    bl.appendChild(document.createElement('h2')).innerHTML =
      'Backlog <span class="muted">— ' + backlog.length + ' issues with no dependency links</span>';
    const groups = {};
    backlog.forEach((n) => { const m = NODES[n].m || '(no milestone)'; (groups[m] = groups[m] || []).push(n); });
    Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length).forEach((m) => {
      const arr = groups[m].sort((a, b) => a - b);
      const openCt = arr.filter(isOpen).length;
      const grp = document.createElement('div'); grp.className = 'ms-group';
      const title = document.createElement('p'); title.className = 'ms-title';
      title.textContent = m + '  ·  ' + arr.length + ' issues' + (openCt ? ' (' + openCt + ' open)' : '');
      grp.appendChild(title);
      const chips = document.createElement('div'); chips.className = 'chips';
      arr.forEach((n) => {
        const chip = document.createElement('div'); chip.className = 'chip ' + (isOpen(n) ? 'open' : 'closed');
        chip.title = '#' + n + ' · ' + NODES[n].t + ' (' + NODES[n].s + ')';
        chip.innerHTML = '<span class="cn">#' + n + '</span><span class="ct">' + NODES[n].t + '</span>';
        chips.appendChild(chip);
      });
      grp.appendChild(chips); bl.appendChild(grp);
    });
  }
}

emit();
