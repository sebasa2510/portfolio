#!/usr/bin/env node
// Portfolio site builder.
//
// Reads two sources:
//   inventory.json  — the project inventory (this repo)
//   ../.tato       — the agent system (config, skills, memory, scripts, eval workspace)
//
// Writes a static site: index.html plus a tato/ folder holding the
// first-party source files, so the deployed site is self-contained and the
// page also works when opened straight off disk.
//
// Run: node build.mjs

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, escapeHtml } from './lib/markdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tatoDir = resolve(here, '..', '.tato');
const outDir = join(here, 'index.html');
const assetDir = join(here, 'tato');

const inv = JSON.parse(readFileSync(join(here, 'inventory.json'), 'utf8'));

// ---------------------------------------------------------------- helpers

const UNFILLED = /^\s*(TODO\b|<placeholder>|TBD\b|xxx)/i;
const isFilled = (v) => typeof v === 'string' && v.trim() !== '' && !UNFILLED.test(v.trim());
const isLive = (v) => isFilled(v) && /^https?:\/\//i.test(v.trim());
const esc = escapeHtml;

const HASH = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Resolve a path recorded in the source files to something that works from
// the generated page. "portfolio/x" and ".tato/y" prefixes are both stripped
// because both source files live outside the page root.
const relFrom = (p, base) => {
  if (!isFilled(p)) return null;
  let target = p.trim().replace(/\\/g, '/');
  if (isAbsolute(target) || /^[a-z]+:\/\//i.test(target)) return target;
  for (const prefix of ['portfolio/', '.tato/', 'tato/']) {
    if (target.startsWith(prefix)) {
      const abs = resolve(base, target.slice(prefix.length));
      return existsSync(abs) ? relative(here, abs).replace(/\\/g, '/') : null;
    }
  }
  const abs = resolve(base, target);
  return existsSync(abs) ? relative(here, abs).replace(/\\/g, '/') : null;
};

const ACRONYMS = { sla: 'SLA', api: 'API', seo: 'SEO', mb: 'MB', id: 'ID' };
const humanKey = (k) =>
  k.split('_').map((w) => ACRONYMS[w.toLowerCase()] || w).join(' ').replace(/^(.)/, (c) => c.toUpperCase());

function fmtMetric(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (key.endsWith('_rate')) return `${(value * 100).toFixed(value === 1 ? 0 : 1)}%`;
    if (key.endsWith('_seconds')) return `${value.toLocaleString('en-US')}s`;
    return value.toLocaleString('en-US');
  }
  return String(value);
}

// ------------------------------------------------------- .tato source load

const haveTato = existsSync(tatoDir);
const readJson = (p) => JSON.parse(readFileSync(join(tatoDir, p), 'utf8'));

const tato = haveTato
  ? {
      skills: existsSync(join(tatoDir, 'config/skills.json')) ? readJson('config/skills.json').skills : [],
      repos: existsSync(join(tatoDir, 'config/repos.json')) ? readJson('config/repos.json').repos : [],
      repoTotals: existsSync(join(tatoDir, 'config/repos.json')) ? readJson('config/repos.json').totals : {},
      index: existsSync(join(tatoDir, 'config/repo_skills.json')) ? readJson('config/repo_skills.json') : null,
    }
  : { skills: [], repos: [], repoTotals: {}, index: null };

// The .tato agent system's own class repo is private, so the public site
// links to the copy published in this repo instead.
const TATO_REPO_URL = 'https://github.com/sebasa2510/portfolio';

// ------------------------------------------------------------------ theme

const FALLBACK_THEME = {
  colors: {
    bg: '#0f1115', panel: '#161a21', panel2: '#1c2129', line: '#272d38',
    text: '#e8eaed', muted: '#939cab', accent: '#6ea8fe', accentInk: '#0b0e14',
  },
  fonts: {
    display: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
};

const bc = inv.brand?.colors || FALLBACK_THEME.colors;
const bf = inv.brand?.fonts || FALLBACK_THEME.fonts;
const T = (k) => (isFilled(bc[k]) ? bc[k].trim() : FALLBACK_THEME.colors[k]);
const fontStack = (v, fb) => (isFilled(v) ? v.trim() : fb);

// ------------------------------------------------------------------ copy

// Publish the first-party source. Third-party code under repos/ is never
// copied: it is other people's licensed work, it is ~565 MB, and the .tato
// README already states it is not vendored into this repository.
const COPY_TREE = [
  ['skills', 'skills'],
  ['config', 'config'],
  ['memory', 'memory'],
  ['scripts', 'scripts'],
  ['seo-intelligence-workspace', 'seo-intelligence-workspace'],
];

// skill_builder.md hardcodes an absolute local path. Rewrite to a relative
// one so publishing the folder does not leak the machine layout.
const SANITIZE = [
  [/[A-Za-z]:\\Users\\[^\\]+\\OneDrive\\Desktop\\\.tato\\/g, '.tato/'],
  [/[A-Za-z]:\\Users\\[^\\]+\\/g, ''],
];

let copied = 0;
const copyReport = [];

if (haveTato) {
  rmSync(assetDir, { recursive: true, force: true });
  mkdirSync(assetDir, { recursive: true });

  for (const [from, to] of COPY_TREE) {
    const src = join(tatoDir, from);
    if (!existsSync(src)) {
      copyReport.push(`  skipped ${from} (not found)`);
      continue;
    }
    const dest = join(assetDir, to);
    mkdirSync(dest, { recursive: true });

    const walk = (dir, rel) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          mkdirSync(join(dest, relPath), { recursive: true });
          walk(abs, relPath);
        } else {
          const isText = /\.(md|json|ps1|txt|html)$/i.test(entry.name);
          if (!isText) continue;
          let body = readFileSync(abs, 'utf8');
          let touched = false;
          for (const [re, rep] of SANITIZE) {
            if (re.test(body)) { body = body.replace(re, rep); touched = true; }
          }
          if (touched) writeFileSync(join(dest, relPath), body, 'utf8');
          else cpSync(abs, join(dest, relPath));
          copied++;
        }
      }
    };
    walk(src, '');
  }

  // README lives at the .tato root
  const readme = join(tatoDir, 'README.md');
  if (existsSync(readme)) {
    let body = readFileSync(readme, 'utf8');
    for (const [re, rep] of SANITIZE) body = body.replace(re, rep);
    writeFileSync(join(assetDir, 'README.md'), body, 'utf8');
    copied++;
  }
  copyReport.push(`  copied ${copied} first-party files to tato/`);
}

// ------------------------------------------------------------------ owner

const owner = inv.owner || {};
const hasName = isFilled(owner.name);
const hasLocation = isFilled(owner.location);

const projects = [...(inv.projects || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter((p) => isFilled(p.title));

// ----------------------------------------------------------------- render

function statusFor(p) {
  if (isLive(p.live_url)) return { kind: 'live', label: 'Live', title: 'Deployed and running' };
  if (isFilled(p.source_url)) return { kind: 'source', label: 'Source', title: 'Published to a code repository' };
  if (p.demo && isFilled(p.demo.file)) return { kind: 'spec', label: 'Specification', title: 'Written design, with a working demo of the logic' };
  return { kind: 'draft', label: 'In progress', title: 'Not yet published' };
}

function linksFor(p) {
  const out = [];
  const live = relFrom(p.live_url, here);
  if (live) out.push({ href: live, label: 'Live demo', primary: true });
  if (p.demo) {
    const href = relFrom(p.demo.file, here);
    if (href) out.push({ href, label: 'Interactive demo', primary: !live });
  }
  if (isLive(p.source_url)) out.push({ href: p.source_url.trim(), label: 'Source', primary: false });
  const seen = new Set();
  return out.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true)));
}

function renderProject(p) {
  const st = statusFor(p);
  const links = linksFor(p);

  const desc = isFilled(p.description) ? `<p class="desc">${esc(p.description)}</p>` : '';
  const client = isFilled(p.client) ? `<p class="client">${esc(p.client)}</p>` : '';
  const tags = (p.tags || []).filter(isFilled).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const points = (p.highlights || []).filter(isFilled).map((h) => `<li>${esc(h)}</li>`).join('');

  const mk = Object.keys(p.metrics || {});
  const metrics = mk.length
    ? `<dl class="metrics">${mk.map((k) => `<div><dt>${esc(humanKey(k))}</dt><dd>${esc(fmtMetric(k, p.metrics[k]))}</dd></div>`).join('')}</dl>`
    : '';

  let note = '';
  if (p.demo && (isFilled(p.demo.status) || isFilled(p.demo.note))) {
    const bits = [];
    if (isFilled(p.demo.status)) bits.push(esc(p.demo.status));
    if (isFilled(p.demo.note)) bits.push(esc(p.demo.note));
    note = `<p class="note">${bits.join(' &mdash; ')}</p>`;
  }

  const linkHtml = links.length
    ? `<div class="links">${links.map((l) => `<a class="btn${l.primary ? ' primary' : ''}" href="${esc(l.href)}"${l.primary ? '' : ' rel="noopener"'} target="_blank">${esc(l.label)}</a>`).join('')}</div>`
    : '';

  return `
<article class="project" id="${esc(HASH(p.id || p.title))}">
  <div class="project-head">
    <h3>${esc(p.title)}</h3>
    <span class="status ${st.kind}" title="${esc(st.title)}">${esc(st.label)}</span>
  </div>
  ${client}${desc}${note}${metrics}
  ${points ? `<h4>What it does</h4><ul class="points">${points}</ul>` : ''}
  <div class="tags">${tags}</div>
  <div class="foot">${isFilled(p.session) ? `<span class="meta">${esc(p.session)}</span>` : ''}${linkHtml}</div>
</article>`;
}

// --- .tato sections ---

function skillBodyMd(name) {
  const f = join(assetDir, 'skills', `${name}.md`);
  if (!existsSync(f)) return null;
  const body = readFileSync(f, 'utf8');
  return renderMarkdown(body, `s-${HASH(name)}`);
}

function renderSkillCard(s) {
  const name = s.name;
  const rendered = skillBodyMd(name);
  const fileHref = `tato/skills/${esc(name)}.md`;
  const triggers = (s.trigger_phrases || []).filter(isFilled);
  return `
<details class="skill" id="card-${esc(HASH(name))}">
  <summary>
    <span class="skill-name">${esc(name)}</span>
    ${triggers.length ? `<span class="skill-triggers">${triggers.slice(0, 3).map((t) => `<code>${esc(t)}</code>`).join('')}${triggers.length > 3 ? `<span class="more">+${triggers.length - 3} more</span>` : ''}</span>` : ''}
  </summary>
  <div class="skill-body">
    ${isFilled(s.description) ? `<p class="skill-desc">${esc(s.description)}</p>` : ''}
    ${rendered ? rendered.html : '<p class="muted">Source file not found.</p>'}
    <p class="skill-links"><a href="${fileHref}">view raw source</a></p>
  </div>
</details>`;
}

function renderRepoCard(r) {
  const upstream = isLive(r.url) ? r.url.trim() : null;
  return `
<article class="repo">
  <div class="repo-head">
    <h4>${esc(r.dir)}</h4>
    ${r.has_skills ? '<span class="pill">has skills</span>' : '<span class="pill dim">no skills</span>'}
  </div>
  <p class="repo-desc">${esc(r.description || '')}</p>
  ${isFilled(r.skills) ? `<p class="repo-skills"><strong>Skills:</strong> ${esc(r.skills)}</p>` : ''}
  <dl class="repo-stats">
    <div><dt>size</dt><dd>${esc(fmtMetric('size_mb', r.size_mb))} MB</dd></div>
    <div><dt>files</dt><dd>${esc((r.files ?? 0).toLocaleString('en-US'))}</dd></div>
    <div><dt>pinned</dt><dd><code>${esc(String(r.commit || '').slice(0, 8))}</code></dd></div>
  </dl>
  ${isFilled(r.license_note) ? `<p class="repo-licence"><strong>Licence:</strong> ${esc(r.license_note)}</p>` : ''}
  ${upstream ? `<p class="repo-links"><a class="btn" href="${esc(upstream)}" target="_blank" rel="noopener">upstream repo</a></p>` : ''}
</article>`;
}

function renderSeoWorkspace() {
  const base = 'tato/seo-intelligence-workspace';
  const benchPath = join(tatoDir, 'seo-intelligence-workspace/iteration-1/benchmark.json');
  if (!existsSync(benchPath)) return '';
  const bench = JSON.parse(readFileSync(benchPath, 'utf8'));
  const s = bench.summary || {};

  const evals = (bench.runs || []).map((r) => `
    <tr>
      <td>${esc(r.eval_name)}</td>
      <td><code>${esc(r.run)}</code></td>
      <td>${esc(r.assertions_passed)}/${esc(r.assertions_total)}</td>
    </tr>`).join('');

  return `
<div class="sub-panel">
  <h3>Evaluation harness</h3>
  <p>Three authored evals run against the <code>seo_intelligence</code> skill, scored on a self-authored assertion suite.</p>
  <dl class="metrics">
    <div><dt>Evals</dt><dd>${esc(s.total_evals ?? '—')}</dd></div>
    <div><dt>Assertions passed</dt><dd>${esc(`${s.assertions_passed ?? 0}/${s.assertions_total ?? 0}`)}</dd></div>
    <div><dt>Pass rate</dt><dd>${esc(fmtMetric('pass_rate', s.pass_rate ?? 0))}</dd></div>
  </dl>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Eval</th><th>Run</th><th>Assertions</th></tr></thead>
      <tbody>${evals}</tbody>
    </table>
  </div>
  <p class="caveat"><strong>Caveat:</strong> every run recorded here is <code>with_skill</code>. There is no <code>without_skill</code> baseline, so this shows the skill works — it does not prove the skill beats no skill.</p>
  <p class="repo-links">
    <a class="btn primary" href="${base}/iteration-1/review.html">Open the full review report</a>
    <a class="btn" href="${base}/evals/evals.json">evals.json</a>
    <a class="btn" href="${base}/iteration-1/benchmark.json">benchmark.json</a>
  </p>
</div>`;
}

function renderTato() {
  if (!haveTato) return '';
  const idx = tato.index;
  const totals = tato.repoTotals || {};

  const withSkills = tato.repos.filter((r) => r.has_skills).length;
  const stats = [
    ['First-party skills', String(tato.skills.length)],
    ['Vendored repos', String(tato.repos.length)],
    ['Repos with skills', String(withSkills)],
    ['Skill files scanned', String(totals.skill_files ?? idx?.totals?.skill_files ?? '—')],
    ['Distinct skills', String(totals.distinct_skills ?? idx?.totals?.distinct ?? '—')],
    ['Vendored size', `${totals.size_mb ?? '—'} MB`],
  ];

  // Repos whose skill content may not be republished. openaccountants ships
  // 781 Guides under OpenAccountants Guide License v1.0, which permits personal
  // and educational reference but requires a separate commercial licence to
  // redistribute the collection as a dataset (Section 4d). The index below is
  // exactly that kind of republication, so its names and descriptions are
  // withheld. The repo is still linked in the cards above, and the count is
  // still reported - only the copied text is withheld.
  const NON_REPUBLISHABLE = new Set(['openaccountants']);

  const skillIndex = (idx?.skills || []).map((s) => {
    const url = (tato.repos.find((x) => x.dir === s.repo) || {}).url || null;
    if (NON_REPUBLISHABLE.has(s.repo)) {
      return { n: s.name, r: s.repo, d: '', u: url, withheld: true };
    }
    return {
      n: s.name,
      r: s.repo,
      d: String(s.description || '').replace(/\s+/g, ' ').slice(0, 240),
      u: url,
      withheld: false,
    };
  });

  const withheldCount = skillIndex.filter((s) => s.withheld).length;
  const publishedCount = skillIndex.length - withheldCount;

  return `
<section id="agent-system">
  <h2>The .tato agent system</h2>
  <p class="lede">A file-based operating system for an AI agent: a JSON skill registry, a persistent memory store, and system prompts that route each request to the right skill. Routing is two-tier &mdash; ${esc(tato.skills.length)} first-party skills are searched first, and ${esc(totals.distinct_skills ?? idx?.totals?.distinct ?? '—')} skills vendored from ${esc(tato.repos.length)} external repos are the fallback.</p>

  <dl class="metrics wide">
    ${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
  </dl>

  <p class="repo-links">
    <a class="btn primary" href="${esc(TATO_REPO_URL)}" target="_blank" rel="noopener">View the source repository</a>
    <a class="btn" href="tato/README.md">README</a>
    <a class="btn" href="tato/config/skills.json">skills.json</a>
    <a class="btn" href="tato/config/repos.json">repos.json</a>
  </p>

  <h3 id="tato-skills">First-party skills <span class="count">${tato.skills.length}</span></h3>
  <p class="muted">Each skill is a system prompt file registered in <code>config/skills.json</code> with trigger phrases. Expand one to read it in full.</p>
  <div class="skills">${tato.skills.map(renderSkillCard).join('')}</div>

  <h3 id="tato-repos">Vendored repositories <span class="count">${tato.repos.length}</span></h3>
  <p class="muted">Pinned as git submodules. Their code is <strong>not</strong> republished here &mdash; each links to its upstream source, and the agent stores only a commit pointer, which is what keeps the pushed history under 1 MB instead of ${esc(totals.size_mb ?? 566)} MB.</p>
  <div class="repos">${tato.repos.map(renderRepoCard).join('')}</div>

  <h3 id="tato-index">Skill index <span class="count">${skillIndex.length}</span></h3>
  <p class="muted">Generated by <code>scripts/index-repo-skills.ps1</code>, which scans every <code>SKILL.md</code>, reads its frontmatter, and collapses the per-agent packaging copies that vendored repos ship. Search by name, description, or repo.</p>
  ${withheldCount > 0 ? `<p class="muted withheld-note"><strong>${withheldCount} of these are listed by name only.</strong> They come from <code>openaccountants</code>, whose Guides are under the OpenAccountants Guide License v1.0 &mdash; that licence allows personal and educational reference but not redistributing the collection. Linking is fine, so each name below jumps to upstream; the descriptions are withheld.</p>` : ''}
  <div class="index-tools">
    <input id="skill-filter" type="search" placeholder="Filter skills&hellip;" aria-label="Filter skills">
    <select id="repo-filter" aria-label="Filter by repository">
      <option value="">All repositories</option>
      ${(idx?.by_repo || []).map((b) => `<option value="${esc(b.repo)}">${esc(b.repo)} (${esc(b.distinct)})</option>`).join('')}
    </select>
    <span id="skill-count" class="muted"></span>
  </div>
  <ul class="skillindex" id="skillindex">${skillIndex
    .map(
      (s) => `<li data-repo="${esc(s.r)}"${s.withheld ? ' data-withheld="1"' : ''}><a class="si-name"${s.u ? ` href="${esc(s.u)}" target="_blank" rel="noopener"` : ''}>${esc(s.n)}</a><span class="si-repo">${esc(s.r)}</span>${s.d ? `<span class="si-desc">${esc(s.d)}</span>` : '<span class="si-desc withheld">name only &mdash; see upstream</span>'}</li>`
    )
    .join('')}</ul>

  <h3 id="tato-evals">SEO evaluation workspace</h3>
  ${renderSeoWorkspace()}

  <h3 id="tato-scripts">Maintenance scripts</h3>
  <div class="repos">
    <article class="repo">
      <div class="repo-head"><h4>index-repo-skills.ps1</h4></div>
      <p class="repo-desc">Scans <code>repos/</code> for <code>SKILL.md</code>, parses frontmatter, collapses duplicate packaging copies, and writes <code>config/repo_skills.json</code>. Also the source of the ${esc(idx?.totals?.collapsed_copies ?? 31)} collapsed copies and ${esc(idx?.totals?.excluded_paths ?? 4)} excluded test-fixture paths above.</p>
      <p class="repo-links"><a class="btn" href="tato/scripts/index-repo-skills.ps1">view source</a></p>
    </article>
  </div>
</section>`;
}

// ---------------------------------------------------------------- assemble

const masthead = `
<header class="masthead">
  ${hasName ? `<h1>${esc(owner.name)}</h1>` : '<h1 class="unnamed">Portfolio</h1>'}
  ${isFilled(owner.title) ? `<p class="title">${esc(owner.title)}</p>` : ''}
  ${isFilled(owner.bio) ? `<p class="bio">${esc(owner.bio)}</p>` : ''}
  ${hasLocation ? `<p class="loc">${esc(owner.location)}</p>` : ''}
</header>`;

const nav = `
<nav class="nav">
  <a href="#work">Work</a>
  ${haveTato ? '<a href="#agent-system">Agent system</a>' : ''}
  <a href="#tato-skills">Skills</a>
  <a href="#tato-repos">Repos</a>
  <a href="#tato-index">Index</a>
</nav>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(hasName ? `${owner.name} — Portfolio` : 'Portfolio')}</title>
<meta name="description" content="${esc(
  isFilled(owner.bio) ? owner.bio.slice(0, 180) : 'Selected projects and agent systems.'
)}">
<style>
  :root {
    --bg: ${T('bg')}; --panel: ${T('panel')}; --panel-2: ${T('panel2')};
    --line: ${T('line')}; --text: ${T('text')}; --muted: ${T('muted')};
    --accent: ${T('accent')}; --accent-ink: ${T('accentInk')};
    --radius: 10px;
    --display: ${fontStack(bf.display, FALLBACK_THEME.fonts.display)};
    --body: ${fontStack(bf.body, FALLBACK_THEME.fonts.body)};
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--body); font-size: 15px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 48px 24px 80px; }
  a { color: var(--accent); }
  h1, h2, h3, h4 { font-family: var(--display); letter-spacing: -0.015em; }
  h2 {
    font-size: 14px; text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--muted); margin: 52px 0 18px; font-weight: 600;
    border-top: 1px solid var(--line); padding-top: 40px;
  }
  h3 { font-size: 19px; margin: 34px 0 8px; font-weight: 600; }
  h4 { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
  .count {
    font-family: var(--mono); font-size: 11px; color: var(--accent);
    border: 1px solid var(--accent); border-radius: 999px; padding: 1px 8px;
    vertical-align: middle; margin-left: 8px; font-weight: 400; letter-spacing: 0;
  }
  .lede { color: var(--muted); max-width: 70ch; }
  .muted { color: var(--muted); font-size: 13px; max-width: 74ch; }
  code { font-family: var(--mono); font-size: 0.9em; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
  .caveat { color: var(--muted); font-size: 13px; border-left: 2px solid var(--line); background: var(--panel-2); padding: 10px 14px; border-radius: 0 7px 7px 0; max-width: 74ch; }

  .nav { display: flex; gap: 18px; flex-wrap: wrap; padding: 14px 0 0; }
  .nav a { color: var(--muted); text-decoration: none; font-size: 13px; text-transform: uppercase; letter-spacing: 0.07em; }
  .nav a:hover { color: var(--text); }

  .masthead { margin-top: 18px; }
  h1 { font-size: 34px; margin: 0 0 6px; font-weight: 600; }
  h1.unnamed { color: var(--muted); }
  .title { color: var(--accent); margin: 0 0 18px; }
  .bio { color: var(--muted); max-width: 62ch; margin: 0 0 10px; }
  .loc { color: var(--muted); margin: 0; font-size: 13px; }

  .project { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; margin-bottom: 18px; }
  .project-head, .repo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
  .project-head h3 { margin: 0; font-size: 20px; }
  .status, .pill {
    font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted); white-space: nowrap;
  }
  .status.live { color: #4ade80; border-color: #4ade80; }
  .status.source { color: var(--accent); border-color: var(--accent); }
  .status.spec { color: #fbbf24; border-color: #fbbf24; }
  .pill.dim { opacity: 0.55; }
  .client { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .desc { margin: 0 0 14px; }
  .note { color: var(--muted); font-size: 13px; background: var(--panel-2); border-left: 2px solid var(--line); padding: 10px 14px; border-radius: 0 7px 7px 0; margin: 0 0 16px; }
  .metrics { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; padding: 0; }
  .metrics.wide > div { flex: 1 1 130px; }
  .metrics > div, .repo-stats > div { background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 8px 12px; min-width: 96px; }
  .metrics dt, .repo-stats dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 3px; }
  .metrics dd, .repo-stats dd { margin: 0; font-family: var(--mono); font-size: 16px; }
  .points { margin: 0 0 18px; padding-left: 18px; }
  .points li { margin-bottom: 7px; }
  .points li::marker { color: var(--accent); }
  .tags { margin-bottom: 18px; }
  .tag { display: inline-block; font-family: var(--mono); font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; margin: 0 6px 6px 0; text-transform: uppercase; letter-spacing: 0.05em; }
  .foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 16px; border-top: 1px solid var(--line); }
  .meta { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .links, .repo-links { display: flex; gap: 10px; flex-wrap: wrap; margin-left: auto; }
  .repo-links { margin: 12px 0 0; }
  .btn { display: inline-block; font-size: 13px; font-weight: 500; text-decoration: none; padding: 7px 14px; border-radius: 7px; border: 1px solid var(--line); color: var(--muted); }
  .btn:hover { color: var(--text); border-color: var(--muted); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); color: var(--accent-ink); }

  .skills { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .skill { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .skill summary { cursor: pointer; padding: 14px 18px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .skill summary:hover { background: var(--panel-2); }
  .skill-name { font-family: var(--mono); font-size: 14px; color: var(--accent); }
  .skill-triggers { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .skill-triggers code { font-size: 11px; color: var(--muted); }
  .skill-triggers .more { font-size: 11px; color: var(--muted); }
  .skill-body { padding: 0 18px 18px; border-top: 1px solid var(--line); }
  .skill-desc { color: var(--text); margin: 16px 0 8px; }
  .skill-links { font-size: 12px; margin: 16px 0 0; }
  .skill-body h1 { font-size: 22px; }
  .skill-body h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 26px 0 10px; border: 0; padding: 0; }
  .skill-body h3 { font-size: 15px; margin: 20px 0 6px; }
  .skill-body p, .skill-body li { font-size: 14px; }
  .skill-body ul, .skill-body ol { padding-left: 20px; }
  .skill-body li { margin-bottom: 5px; }
  .skill-body table { font-size: 13px; }
  .skill-body pre.code { background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
  .skill-body pre.code code { background: none; border: 0; padding: 0; font-size: inherit; }
  .skill-body blockquote { border-left: 2px solid var(--line); margin: 12px 0; padding-left: 14px; color: var(--muted); }
  .skill-body hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }

  .table-wrap { overflow-x: auto; margin: 0 0 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  td code { font-size: 12px; }

  .repos { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin-bottom: 8px; }
  .repo { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; }
  .repo-desc { font-size: 13.5px; color: var(--muted); margin: 0 0 12px; }
  .repo-skills { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; }
.repo-licence { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; padding: 9px 11px; border-left: 2px solid var(--line); background: var(--panel-2, rgba(127,127,127,.06)); }
  .repo-stats { display: flex; gap: 8px; flex-wrap: wrap; margin: auto 0 0; padding: 0; }
  .repo-stats > div { flex: 1 1 70px; min-width: 0; padding: 6px 9px; }
  .repo-stats dd { font-size: 13px; }

  .sub-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; }
  .sub-panel h3 { margin-top: 0; }

  .index-tools { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  .index-tools input, .index-tools select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 8px 11px; font-family: inherit; font-size: 13px; outline: none;
  }
  .index-tools input { flex: 1 1 220px; }
  .index-tools input:focus, .index-tools select:focus { border-color: var(--accent); }
  .skillindex { list-style: none; margin: 0; padding: 0; max-height: 460px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--radius); }
  .skillindex li { display: grid; grid-template-columns: minmax(140px, 210px) 130px 1fr; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--line); font-size: 12.5px; align-items: baseline; }
  .skillindex li:last-child { border-bottom: 0; }
  .si-name { font-family: var(--mono); text-decoration: none; }
  .si-repo { color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .si-desc { color: var(--muted); }
.si-desc.withheld { opacity: .55; font-style: italic; }
.withheld-note { border-left: 2px solid var(--line); padding-left: 11px; }
  .skillindex li[hidden] { display: none; }
  @media (max-width: 700px) {
    .skillindex li { grid-template-columns: 1fr; gap: 2px; }
  }

  footer { margin-top: 52px; padding-top: 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  @media (max-width: 620px) { h1 { font-size: 27px; } .links { margin-left: 0; width: 100%; } }
</style>
</head>
<body>
<div class="wrap">
${nav}
${masthead}
<section id="work">
<h2>Selected work</h2>
${projects.map(renderProject).join('\n')}
</section>
${renderTato()}
<footer>
  <p>Built from <code>inventory.json</code> and the <code>.tato</code> agent system by <code>build.mjs</code>. Third-party repositories are linked, not republished.</p>
</footer>
</div>
<script>
(function () {
  var input = document.getElementById('skill-filter');
  var select = document.getElementById('repo-filter');
  var list = document.getElementById('skillindex');
  if (!input || !select || !list) return;
  var items = Array.prototype.slice.call(list.children);
  var count = document.getElementById('skill-count');
  function apply() {
    var q = input.value.trim().toLowerCase();
    var repo = select.value;
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var okRepo = !repo || el.getAttribute('data-repo') === repo;
      var okQ = !q || el.textContent.toLowerCase().indexOf(q) !== -1;
      var show = okRepo && okQ;
      if (show) { el.removeAttribute('hidden'); shown++; } else { el.setAttribute('hidden', ''); }
    }
    if (count) count.textContent = shown + ' of ' + items.length;
  }
  input.addEventListener('input', apply);
  select.addEventListener('change', apply);
  apply();
})();
</script>
</body>
</html>
`;

writeFileSync(outDir, html, 'utf8');

// ------------------------------------------------------------------ report

const warnings = [];
if (!hasName) warnings.push('owner.name is unfilled — header shows "Portfolio"');
if (!hasLocation) warnings.push('owner.location is unfilled — omitted');
if (!inv.brand?.colors) warnings.push('brand.colors is null — using the neutral fallback palette');
if (!inv.brand?.fonts) warnings.push('brand.fonts is null — using system fonts');
if (!projects.some((p) => isLive(p.live_url))) {
  warnings.push('no project has a live_url — cards link to source or demo only');
}
if (!haveTato) warnings.push('../.tato not found — the agent-system section was skipped');

console.log(`Wrote index.html (${(html.length / 1024).toFixed(0)} KB)`);
if (haveTato) {
  console.log(`.tato section: ${tato.skills.length} first-party skills, ${tato.repos.length} repos, ${tato.index?.skills?.length ?? 0} indexed skills`);
  for (const line of copyReport) console.log(line);
}
if (warnings.length) {
  console.log('\nOpen items:');
  for (const w of warnings) console.log(`  - ${w}`);
}
