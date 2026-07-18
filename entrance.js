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
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v === true ? "" : v);
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
  if (!project) {
    console.warn(`entrance: no project matches data-door="${mount.getAttribute("data-door")}"; leaving the section's baked markup in place`);
    return { project: mount.getAttribute("data-door"), state: "degraded", count: 0, error: "no matching project" };
  }
  try {
    const snapshot = await fetchSnapshot(project.snapshotUrl);
    const result = renderDoor(mount, project, snapshot);
    return { project: project.key, snapshotUrl: project.snapshotUrl, snapshot, ...result };
  } catch (e) {
    renderFallbackDoor(mount, project);
    console.warn(`entrance: ${project.key} degraded (${e.message})`);
    return { project: project.key, snapshotUrl: project.snapshotUrl, state: "degraded", count: 0, error: e.message };
  }
}

// ==========================================================================================
// The claim lens: progressive enhancement over the six-question answers' claim-spans.
// Reads the fp.* claims from the same Knowledge-Game governance snapshot the Knowledge Game door
// already fetches and hash-verifies (one fetch, one verification, shared with the door; no second
// snapshot). A page span binds to its claim by a two-key rule, successor to this file's original
// "never by data-ref alone" discipline now that Knowledge-Game's own convention gives data-ref a
// stable, build-time-independent meaning: IDENTITY is by span_ref (the claim whose `span_ref`
// extension equals the span's `data-ref`; this is what finds the claim), and HONESTY is by text
// (the claim's statement must equal the span's own text exactly; a mismatch degrades that span to
// plain prose with a console warning naming the ref and the two texts' first divergence). Ref
// matching alone would let a future page edit silently wear a claim's grade over drifted words;
// the text check keeps that impossible. Wires tap/click on a resolved span to isolate the claim:
// its statement, kind, and grade as the origin kernel's own word (never recomputed here, this
// repository holds no kernel), the follow trail toward ground, and the typing-act doors into the
// app. A snapshot that fails its hash check contributes nothing: spans stay plain prose, noted in
// the console, never a broken dialog.
// ==========================================================================================
const FRONT_PAGE = {
  appBase: "https://a-viable-fork.github.io/Knowledge-Game/app/",
  community: "knowledge-game",
};

const ORIGIN_LABELS = {
  "knowledge-game": "Knowledge Game's governance kernel",
  epistack: "epistack's self kernel",
};

const GRADE_HONESTY = {
  constitutive: "constitutive: adopted by stipulation, not evidenced; a definition, not a measurement.",
  asserted: "asserted: the origin kernel's own word alone so far, no independent check carried here.",
  supported: "supported: at least one independent claim argues for this, in the origin kernel.",
  corroborated: "corroborated: independent, disjoint support has accumulated, in the origin kernel.",
  checked: "checked: a real, re-runnable check grounds this, in the origin kernel.",
  "independently-rechecked": "independently rechecked: a second, independent party re-ran the check.",
  ungraded: "ungraded.",
};

function gradeBadge(grade) {
  return el("span", { class: `lens-badge lens-badge-grade lens-grade-${grade || "ungraded"}`, role: "img", "aria-label": `carried grade: ${grade || "ungraded"}` }, grade || "ungraded");
}
function kindBadge(kind) {
  return el("span", { class: "lens-badge lens-badge-kind" }, kind);
}

// the first index at which two strings differ (or the shorter string's length, if one is a
// prefix of the other), used only to name a drift warning's divergence point.
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function buildLensContext(snapshot, epistackSnapshot) {
  const entries = (snapshot.state && snapshot.state.entries) || [];
  const byIdentity = new Map();
  const bySpanRef = new Map();
  for (const e of entries) {
    byIdentity.set(e.identity, e.canonical);
    const spanRef = e.canonical.extensions && e.canonical.extensions.span_ref;
    if (spanRef) bySpanRef.set(spanRef, e.canonical);
  }
  const linksByFrom = new Map();
  for (const l of (snapshot.state && snapshot.state.links) || []) {
    if (!linksByFrom.has(l.from_identity)) linksByFrom.set(l.from_identity, []);
    linksByFrom.get(l.from_identity).push(l);
  }
  const sourcesById = new Map((snapshot.sources || []).map((s) => [s.source_id, s]));
  const epistackByIdentity = new Map();
  if (epistackSnapshot) {
    for (const e of (epistackSnapshot.state && epistackSnapshot.state.entries) || []) {
      epistackByIdentity.set(e.identity, e.canonical);
    }
  }
  return { byIdentity, bySpanRef, linksByFrom, sourcesById, epistackByIdentity, kernelId: snapshot.kernel_id };
}

function originOf(canonical, ctx) {
  return (canonical.extensions && canonical.extensions.origin_kernel) || ctx.kernelId;
}

// the provenance chip: the claim's own source row, expandable in place, naming every sibling claim
// in this same lens's entries that cites the identical source (the "walk outward from a source"
// this single fetched kernel can honestly support without a second network round-trip).
function renderProvenanceChip(canonical, ctx) {
  const source = ctx.sourcesById.get(canonical.source_id);
  const details = el("div", { class: "lens-provenance-detail", hidden: true });
  const chip = el(
    "button",
    {
      type: "button", class: "lens-provenance-chip", "aria-expanded": "false",
      onclick: (e) => {
        const open = details.hasAttribute("hidden");
        if (open) details.removeAttribute("hidden"); else details.setAttribute("hidden", "");
        e.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
      },
    },
    `Source: ${canonical.source_id}`
  );
  if (source) {
    const siblings = Array.from(ctx.byIdentity.values()).filter((c) => c.identity !== canonical.identity && c.source_id === canonical.source_id);
    details.appendChild(el("p", { class: "lens-provenance-class" }, source.source_class));
    details.appendChild(el("p", { class: "lens-provenance-desc" }, source.description));
    details.appendChild(
      siblings.length
        ? el("p", {}, `${siblings.length} other claim${siblings.length === 1 ? "" : "s"} here cite this same source.`)
        : el("p", {}, "no other claim here cites this source")
    );
  }
  return el("div", { class: "lens-provenance" }, chip, details);
}

// the follow trail: descends from the isolated claim toward ground. At most one of: an outgoing
// restatement link (resolved first within this same Knowledge-Game snapshot, then, if absent
// there, as a crossing into the already-fetched epistack snapshot, marked as a crossing), a `url`
// extension (an artifact door, honestly labeled as leaving the lens), or neither (grounded by
// adoption alone).
function renderFollow(canonical, ctx) {
  const outgoing = (ctx.linksByFrom.get(canonical.identity) || []).find((l) => l.link_kind === "restatement");
  const contradicts = (ctx.linksByFrom.get(canonical.identity) || []).filter((l) => l.link_kind === "contradicts");
  const hops = [
    el(
      "div",
      { class: "lens-hop lens-hop-current" },
      el("p", { class: "lens-hop-label" }, "This claim"),
      el("p", {}, canonical.statement),
      gradeBadge(canonical.declared_grade),
      renderProvenanceChip(canonical, ctx)
    ),
  ];

  if (outgoing) {
    let target = ctx.byIdentity.get(outgoing.to_identity);
    let crossing = false;
    if (!target && ctx.epistackByIdentity.has(outgoing.to_identity)) {
      target = ctx.epistackByIdentity.get(outgoing.to_identity);
      crossing = true;
    }
    if (target) {
      hops.push(
        el(
          "div",
          { class: `lens-hop ${crossing ? "lens-hop-cross-kernel" : ""}` },
          el("p", { class: "lens-hop-label" }, crossing ? "Crossing: leaving Knowledge Game's kernel into epistack's own published snapshot" : `Restated from ${ORIGIN_LABELS[originOf(target, ctx)] || originOf(target, ctx)}`),
          el("p", {}, target.statement),
          gradeBadge(target.declared_grade),
          renderProvenanceChip(target, ctx)
        )
      );
    } else {
      hops.push(el("div", { class: "lens-hop lens-hop-end" }, el("p", { class: "lens-hop-label" }, "Restates a claim absent from every snapshot this lens loaded; unresolved, not hidden.")));
    }
  } else if (canonical.extensions && canonical.extensions.url) {
    hops.push(
      el(
        "div",
        { class: "lens-hop lens-hop-door" },
        el("p", { class: "lens-hop-label" }, "Leaving the lens: this claim's provenance lives outside any fetched snapshot."),
        el("a", { class: "lens-door-link", href: canonical.extensions.url, target: "_blank", rel: "noopener" }, canonical.extensions.url)
      )
    );
  } else {
    hops.push(el("div", { class: "lens-hop lens-hop-end" }, el("p", { class: "lens-hop-label" }, "Grounded by adoption alone: no further citation to follow.")));
  }

  for (const link of contradicts) {
    const target = ctx.byIdentity.get(link.to_identity);
    if (target) hops.push(el("div", { class: "lens-hop lens-hop-contradicts" }, el("p", { class: "lens-hop-label" }, "Contradicts"), el("p", {}, target.statement), gradeBadge(target.declared_grade)));
  }

  return el("div", { class: "lens-follow" }, ...hops);
}

// the typing-act doors: real deep links into the app's own compose surface for the identical
// registered community ("knowledge-game") this lens reads, carrying the claim's identity as the
// target. Attest and decompose carry no dedicated compose shape anywhere in the app yet, so both
// land as honestly labeled doors into the claim's own card rather than a pre-fill that does not
// exist.
function composeHref(action, identity) {
  return `${FRONT_PAGE.appBase}#community=${FRONT_PAGE.community}&view=contribute&action=${action}&target=${encodeURIComponent(identity)}`;
}
function cardHref(identity) {
  return `${FRONT_PAGE.appBase}#community=${FRONT_PAGE.community}&claim=${encodeURIComponent(identity)}`;
}

function renderActionSheet(canonical, state) {
  const followBtn = el(
    "button",
    { type: "button", class: "lens-action lens-action-read", "aria-pressed": state.followOpen ? "true" : "false", onclick: () => { state.followOpen = !state.followOpen; state.rerender(); } },
    state.followOpen ? "Hide follow" : "Follow"
  );
  const gatedActions = [
    el("a", { class: "lens-action lens-action-gated", href: composeHref("comment", canonical.identity) }, "Comment (through the gate)"),
    el("a", { class: "lens-action lens-action-gated", href: composeHref("fork", canonical.identity) }, "Fork this type (through the gate)"),
    el("a", { class: "lens-action lens-action-gated", href: composeHref("contest", canonical.identity) }, "Contest this claim's type (through the gate; admitting a contest moves no existing grade)"),
    el("a", { class: "lens-action lens-action-door", href: cardHref(canonical.identity) }, "Attest (opens this claim's card in the app; no dedicated attest shape exists yet)"),
    el("a", { class: "lens-action lens-action-door", href: cardHref(canonical.identity) }, "Decompose (opens this claim's card in the app; no dedicated decompose shape exists yet)"),
  ];
  return el("div", { class: "lens-actions" }, el("div", { class: "lens-actions-read" }, followBtn), el("div", { class: "lens-actions-gated" }, ...gatedActions));
}

function renderPanel(canonical, ctx, state) {
  return el(
    "div",
    { class: "lens-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "lens-panel-title", tabindex: "-1" },
    el("button", { type: "button", class: "lens-close", "aria-label": "Close, restore reading", onclick: () => ctx.close() }, "×"),
    el("p", { id: "lens-panel-title", class: "lens-panel-kind-line" }, kindBadge(canonical.kind), gradeBadge(canonical.declared_grade)),
    el("p", { class: "lens-panel-statement" }, canonical.statement),
    el("p", { class: "lens-panel-origin" }, `Carried from ${ORIGIN_LABELS[originOf(canonical, ctx)] || originOf(canonical, ctx)}.`),
    el("p", { class: "lens-panel-honesty" }, `${GRADE_HONESTY[canonical.declared_grade] || GRADE_HONESTY.ungraded} Standing does not transfer across kernels; reading requires nothing.`),
    renderActionSheet(canonical, state),
    state.followOpen ? renderFollow(canonical, ctx) : null
  );
}

function wireLens(ctx) {
  const scrim = el("div", { class: "lens-scrim", hidden: true });
  document.body.appendChild(scrim);
  let openSpan = null;
  const state = { followOpen: false, rerender: () => rerenderOpen() };

  function close() {
    scrim.setAttribute("hidden", "");
    scrim.innerHTML = "";
    document.body.classList.remove("lens-open");
    if (openSpan) { openSpan.classList.remove("claim-span-open"); openSpan.focus({ preventScroll: true }); }
    openSpan = null;
    state.followOpen = false;
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("scroll", onScroll, true);
  }
  ctx.close = close;

  function rerenderOpen() {
    if (!openSpan) return;
    const canonical = ctx.bySpanRef.get(openSpan.getAttribute("data-ref"));
    if (!canonical) return;
    scrim.innerHTML = "";
    const panel = renderPanel(canonical, ctx, state);
    scrim.appendChild(panel);
    panel.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  let openScrollY = 0;
  function onScroll() {
    if (Math.abs(window.scrollY - openScrollY) > 240) close();
  }

  function open(span) {
    const canonical = ctx.bySpanRef.get(span.getAttribute("data-ref"));
    if (!canonical) return; // unresolved span: no claim to open, prose stays plain
    if (openSpan) close();
    openSpan = span;
    openSpan.classList.add("claim-span-open");
    document.body.classList.add("lens-open");
    scrim.removeAttribute("hidden");
    openScrollY = window.scrollY;
    rerenderOpen();
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("scroll", onScroll, true);
  }

  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });

  const spans = document.querySelectorAll(".claim-span");
  let wired = 0;
  for (const span of spans) {
    const ref = span.getAttribute("data-ref");
    const canonical = ctx.bySpanRef.get(ref);
    if (!canonical) {
      console.warn(`entrance: claim-span "${ref}" has no matching span_ref in the governance snapshot; left as plain prose`);
      continue;
    }
    if (canonical.statement !== span.textContent) {
      const at = firstDivergence(canonical.statement, span.textContent);
      console.warn(
        `entrance: claim-span "${ref}" text has drifted from its claim's statement, first divergence at character ${at}` +
        ` (page: "...${span.textContent.slice(Math.max(0, at - 10), at + 30)}...", claim: "...${canonical.statement.slice(Math.max(0, at - 10), at + 30)}...");` +
        ` left as plain prose`
      );
      continue;
    }
    span.setAttribute("tabindex", "0");
    span.setAttribute("role", "button");
    span.classList.add("claim-span-live");
    span.addEventListener("click", () => open(span));
    span.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(span); } });
    wired++;
  }
  return wired;
}

// no fetch of its own: the lens reads the Knowledge Game door's already-fetched, already-hash-
// verified snapshot. A door that degraded (fetch failure or hash mismatch) carries no `snapshot`
// in its result, so the lens degrades identically and for the identical reason; a corrupted local
// copy contributes nothing to either the door or the lens.
function loadLens(kgSnapshot, kgSnapshotUrl, epistackSnapshot) {
  const spans = document.querySelectorAll(".claim-span");
  if (!spans.length) return { state: "no-spans", wired: 0 };
  if (!kgSnapshot) {
    console.warn(`entrance: claim lens degraded (Knowledge Game snapshot unavailable); spans remain plain prose`);
    return { state: "degraded", wired: 0, total: spans.length, error: "knowledge-game snapshot unavailable" };
  }
  const ctx = buildLensContext(kgSnapshot, epistackSnapshot);
  const wired = wireLens(ctx);
  return { state: "live", wired, total: spans.length, snapshotUrl: kgSnapshotUrl };
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

  const kgResult = results.find((r) => r.project === "knowledge-game");
  const epistackResult = results.find((r) => r.project === "epistack");
  window.__entranceLens = loadLens(kgResult && kgResult.snapshot, kgResult && kgResult.snapshotUrl, epistackResult && epistackResult.snapshot);
}

main();
