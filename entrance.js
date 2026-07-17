"use strict";
// Role: the org-root entrance renderer. Fetches each project's governance-kernel snapshot at its
//   recorded stable URL, verifies it against its own snapshot_hash (the same canonical-form sha256
//   the kernel itself uses, ported here so a browser with no build step can recompute it), filters to
//   entrance-surfaced listing claims, and renders each project's door from exactly those claims. A
//   door whose fetch fails or whose snapshot carries no entrance-surfaced claims renders its baked
//   fallback (name, repo URL) instead; the two doors are independent, so one degrading never affects
//   the other.

// ---- the canonical form and its one named hash, ported from epistack's kernel/schema/canonical.mjs
//   and sha256.mjs so this page can recompute a snapshot's hash with no build step. Only the plain
//   (no per-field policy) path is needed: emit-snapshot.mjs's snapshot_hash is hashOf({state, sources,
//   kinds}) called with no policy, so every array anywhere in the tree canonicalizes the same way
//   (sorted by canonical byte order, no dedup) all the way down. ----
function normalizeString(s) {
  return s.normalize("NFC").replace(/\r\n?/g, "\n").replace(/^\s+|\s+$/g, "");
}
function byteCompare(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}
function canonicalize(value) {
  if (typeof value === "number") throw new Error("unexpected floating-point value in snapshot");
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) {
    const elems = value.filter((v) => v !== undefined && v !== null).map(canonicalize);
    return elems.slice().sort((a, b) => byteCompare(encode(a), encode(b)));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (value[k] === undefined || value[k] === null) continue;
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  throw new Error("uncanonical value in snapshot");
}
function encode(node) {
  if (node === true) return "true";
  if (node === false) return "false";
  if (typeof node === "string") return JSON.stringify(node);
  if (Array.isArray(node)) return "[" + node.map(encode).join(",") + "]";
  if (node !== null && typeof node === "object") {
    const keys = Object.keys(node).sort(byteCompare);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + encode(node[k])).join(",") + "}";
  }
  throw new Error("cannot encode node");
}
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashOf(value) {
  return sha256Hex(encode(canonicalize(value)));
}

// ---- the two projects this entrance surfaces ----
const PROJECTS = [
  {
    key: "knowledge-game",
    fallbackName: "The Knowledge Game",
    repoUrl: "https://github.com/A-Viable-Fork/Knowledge-Game",
    snapshotUrl: "https://a-viable-fork.github.io/Knowledge-Game/app/fixtures/knowledge-game.snapshot.json",
  },
  {
    key: "epistack",
    fallbackName: "EpiStack",
    repoUrl: "https://github.com/A-Viable-Fork/epistack",
    snapshotUrl: "https://a-viable-fork.github.io/epistack/self.snapshot.json",
  },
];

// ---- the frame line: the org-root entrance's orienting sentence, fetched from the minimum
//   constitution's own opening rather than authored here. The fallback below is baked only as the
//   degrade text; it is the constitution's own first sentence, verbatim, so a fetch failure changes
//   nothing the reader sees except staleness. No rendered docs site exists yet (epistack's Pages
//   workflow only publishes self.snapshot.json), so this fetches the raw markdown source and parses
//   just the opening sentence: strip the frontmatter block, strip the heading line, take the first
//   paragraph's first sentence. This is a small, fixed slice, not the kind of full-document markdown
//   parse a prior session flagged as fragile for locating a named subsection deep in a long document.
const CONSTITUTION = {
  rawUrl: "https://raw.githubusercontent.com/A-Viable-Fork/epistack/main/docs/the-minimum-constitution.md",
  linkUrl: "https://github.com/A-Viable-Fork/epistack/blob/main/docs/the-minimum-constitution.md",
  fallbackLine: "EpiStack is a minimal shared structure on which independent communities build knowledge that composes.",
};

function stripMarkdownInline(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

// pulls the first sentence of the first paragraph after the frontmatter and the '# ' heading.
function extractOpeningSentence(markdown) {
  let text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  text = text.replace(/^\s*\n+/, "").replace(/^#[^\n]*\n/, "").trim();
  const paragraphEnd = text.search(/\n\s*\n/);
  const firstParagraph = stripMarkdownInline((paragraphEnd === -1 ? text : text.slice(0, paragraphEnd)).replace(/\s+/g, " ").trim());
  const m = /^.*?[.!?](?=\s|$)/.exec(firstParagraph);
  return m ? m[0].trim() : null;
}

async function loadFrameLine(mount) {
  if (!mount) return { state: "degraded", line: CONSTITUTION.fallbackLine, error: "no mount" };
  try {
    const res = await fetch(CONSTITUTION.rawUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const sentence = extractOpeningSentence(text);
    if (!sentence) throw new Error("could not parse an opening sentence");
    mount.textContent = sentence;
    return { state: "live", line: sentence };
  } catch (e) {
    // mount already carries the baked fallback line from the HTML; leave it untouched.
    console.warn(`entrance: constitution frame line degraded (${e.message})`);
    return { state: "degraded", line: mount.textContent, error: e.message };
  }
}

async function fetchSnapshot(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (typeof json.snapshot_hash === "string") {
    const recomputed = await hashOf({ state: json.state, sources: json.sources, kinds: json.kinds });
    if (recomputed !== json.snapshot_hash) throw new Error("snapshot_hash does not verify");
  }
  return json;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

// a "claim-N" (or any ref ending in digits) references_claim value is resolved by position: the
// build preserves claim array order into the emitted entries array, and this deployment's own
// refs number claims 1..N in that same order (kernel/governance/corpora/knowledge-game-data.js),
// so the Nth non-entrance-surfaced entry is claim-N. If no ordinal is found, or the referenced
// claim's own snapshot entry doesn't exist, the status renders unresolved rather than guessing.
function resolveReferencedClaim(entries, ref) {
  if (!ref) return null;
  const m = /(\d+)\s*$/.exec(ref);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  const nonEntrance = entries.filter((e) => !(e.canonical.extensions && e.canonical.extensions.entrance_surfaced));
  return nonEntrance[idx] || null;
}

function renderStatusItem(entries, statusEntry, repoUrl) {
  const ext = statusEntry.canonical.extensions || {};
  const ref = ext.references_claim || ext.references;
  const target = resolveReferencedClaim(entries, ref);
  const grade = target ? target.canonical.declared_grade : statusEntry.canonical.declared_grade;
  const checkerId = target && target.canonical.checking_records && target.canonical.checking_records[0]
    ? target.canonical.checking_records[0].checker_id
    : null;
  const href = checkerId ? `${repoUrl}/blob/main/${checkerId}` : repoUrl;
  const dot = el("span", { class: `grade-dot g-${grade || "ungraded"}`, "aria-hidden": "true" });
  const text = el("span", { class: "status-text" }, statusEntry.canonical.statement);
  const a = el("a", { href, target: "_blank", rel: "noopener", "aria-label": `${statusEntry.canonical.statement} (computed grade: ${grade || "ungraded"})` }, dot, text);
  return el("li", {}, a);
}

function renderFallbackDoor(mount, project) {
  mount.innerHTML = "";
  mount.appendChild(el("h2", {}, project.fallbackName));
  mount.appendChild(el("div", { class: "door-links" }, el("a", { href: project.repoUrl, target: "_blank", rel: "noopener" }, "View the repository")));
}

function renderDoor(mount, project, snapshot) {
  const entries = (snapshot.state && snapshot.state.entries) || [];
  const surfaced = entries.filter((e) => e.canonical && e.canonical.extensions && e.canonical.extensions.entrance_surfaced === true);
  if (surfaced.length === 0) {
    renderFallbackDoor(mount, project);
    return { state: "degraded", count: 0 };
  }

  const roleOf = (e) => e.canonical.extensions.role;
  const title = surfaced.find((e) => roleOf(e) === "title");
  const tagline = surfaced.find((e) => roleOf(e) === "tagline");
  const statuses = surfaced.filter((e) => roleOf(e) === "status");
  const links = surfaced.filter((e) => roleOf(e) === "link");

  mount.innerHTML = "";
  const h2 = el("h2", {}, title ? title.canonical.statement : project.fallbackName);
  if (title) h2.appendChild(el("span", { class: "adopted-mark", title: "adopted definition" }, "§"));
  mount.appendChild(h2);

  if (tagline) mount.appendChild(el("p", { class: "tagline" }, tagline.canonical.statement));

  if (statuses.length) {
    const ul = el("ul", { class: "status-list" });
    for (const s of statuses) ul.appendChild(renderStatusItem(entries, s, project.repoUrl));
    mount.appendChild(ul);
  }

  if (links.length) {
    const div = el("div", { class: "door-links" });
    for (const l of links) {
      const url = l.canonical.extensions.url;
      if (!url) continue;
      div.appendChild(el("a", { href: url, target: "_blank", rel: "noopener" }, l.canonical.statement));
    }
    mount.appendChild(div);
  }

  return { state: "rendered", count: surfaced.length };
}

async function loadDoor(project, mount) {
  try {
    const snapshot = await fetchSnapshot(project.snapshotUrl);
    const result = renderDoor(mount, project, snapshot);
    return { project: project.key, snapshotUrl: project.snapshotUrl, ...result };
  } catch (e) {
    renderFallbackDoor(mount, project);
    console.warn(`entrance: ${project.key} degraded (${e.message})`);
    return { project: project.key, snapshotUrl: project.snapshotUrl, state: "degraded", count: 0, error: e.message };
  }
}

async function main() {
  const mounts = document.querySelectorAll("[data-door]");
  const frameMount = document.getElementById("frame-line");
  const [frameResult, ...results] = await Promise.all([
    loadFrameLine(frameMount),
    ...Array.from(mounts).map((mount) => {
      const project = PROJECTS.find((p) => p.key === mount.getAttribute("data-door"));
      return loadDoor(project, mount);
    }),
  ]);
  window.__entranceDoors = results; // inspectable from the console for the degrade test
  window.__entranceFrame = frameResult;
}

main();
