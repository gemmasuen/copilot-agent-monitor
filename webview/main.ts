import { formatAgo, formatDuration, formatTokens } from "../src/model/format";
import type { AgentView, FeedItem, SessionSnapshot, TaskKind, TaskView } from "../src/model/snapshot";
import type { FromWebview, SessionOption, ToWebview } from "../src/webview/messages";

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const NODE_W = 228;
const NODE_H = 108;
const H_GAP = 28;
const V_GAP = 84;
const ROW_GAP = 28;
const GRID_COLS = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

const KIND_LABEL: Record<TaskKind, string> = {
  spawn: "created",
  reuse: "reused",
  steer: "follow-up",
  peer: "message",
  read: "read results",
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const graphEl = $("graph");
const viewportEl = $("viewport");
const edgesEl = document.getElementById("edges") as unknown as SVGSVGElement;
const pulsesEl = document.getElementById("pulses") as unknown as SVGSVGElement;
const nodesEl = $("nodes");
const detailsEl = $("details");
const feedEl = $("feed");
const countsEl = $("counts");
const bannerEl = $("banner");
const emptyEl = $("empty");
const sessionEl = $<HTMLSelectElement>("session");
const followEl = $<HTMLInputElement>("follow");

let snapshot: SessionSnapshot | undefined;
let sessions: SessionOption[] = [];
let currentKey: string | undefined;
let selectedId = "main";
let view = { x: 40, y: 32, k: 1 };
let userMoved = false;
let lastBoundsKey = "";
let bounds = { w: NODE_W, h: NODE_H };
let seenTasks = new Set<string>();
let seenFeed = new Set<string>();
const nodeEls = new Map<string, HTMLElement>();
const nodeHtml = new WeakMap<HTMLElement, string>();
const edgeEls = new Map<string, SVGPathElement>();
const labelEls = new Map<string, HTMLElement>();
let positions = new Map<string, { x: number; y: number }>();

// ---------- messaging ----------

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const msg = ev.data;
  if (msg.type === "snapshot") {
    onSnapshot(msg.snapshot);
  } else if (msg.type === "sessions") {
    sessions = msg.sessions;
    currentKey = msg.currentKey;
    followEl.checked = msg.follow;
    renderSessions();
  }
});

sessionEl.addEventListener("change", () => vscode.postMessage({ type: "selectSession", key: sessionEl.value }));
followEl.addEventListener("change", () => vscode.postMessage({ type: "setFollow", follow: followEl.checked }));
$("reload").addEventListener("click", () => vscode.postMessage({ type: "reload" }));
$("fit").addEventListener("click", () => {
  userMoved = false;
  fit();
});
$("zoomIn").addEventListener("click", () => zoomAt(1.25));
$("zoomOut").addEventListener("click", () => zoomAt(0.8));

function onSnapshot(next: SessionSnapshot | undefined) {
  const prev = snapshot;
  const sessionChanged = !next || !prev || next.sessionId !== prev.sessionId || next.source !== prev.source;
  if (sessionChanged) {
    seenTasks = new Set();
    seenFeed = new Set();
    for (const el of nodeEls.values()) el.remove();
    for (const el of edgeEls.values()) el.remove();
    for (const el of labelEls.values()) el.remove();
    nodeEls.clear();
    edgeEls.clear();
    labelEls.clear();
    selectedId = "main";
    userMoved = false;
    lastBoundsKey = "";
  }
  const animate = !sessionChanged && !next?.loading && !prev?.loading;
  snapshot = next;
  render(animate);
}

// ---------- rendering ----------

function render(animate: boolean) {
  renderCounts();
  renderBanner();
  if (!snapshot) {
    emptyEl.hidden = false;
    emptyEl.textContent = "No Copilot sessions found yet. Start an agent session and it will appear here.";
    detailsEl.innerHTML = "";
    feedEl.innerHTML = "";
    return;
  }
  if (!snapshot.agents.some((a) => a.id === selectedId)) {
    selectedId = "main";
  }
  computeLayout(snapshot.agents);
  renderNodes();
  renderEdges();
  renderDetails();
  renderFeed(animate);
  const subCount = snapshot.agents.length - 1;
  emptyEl.hidden = subCount > 0 || !!snapshot.loading;
  emptyEl.textContent = snapshot.supportsReuse
    ? "No sub-agents yet. When the agent delegates work, new agents, reused agents and messages between them appear here."
    : "No sub-agents yet. When the agent delegates work, each sub-agent appears here (VS Code Local sub-agents are single-use).";

  if (animate) {
    for (const t of snapshot.tasks) {
      if (!seenTasks.has(t.id)) {
        animateTask(t);
      }
    }
  }
  for (const t of snapshot.tasks) seenTasks.add(t.id);

  const boundsKey = `${snapshot.sessionId}:${Math.round(bounds.w)}x${Math.round(bounds.h)}`;
  if (!userMoved && boundsKey !== lastBoundsKey) {
    fit();
  }
  lastBoundsKey = boundsKey;
}

function renderSessions() {
  sessionEl.innerHTML = "";
  if (sessions.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No sessions found";
    sessionEl.append(opt);
    sessionEl.disabled = true;
    return;
  }
  sessionEl.disabled = false;
  const now = Date.now();
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.key;
    const src = s.source === "copilot" ? "Copilot" : "VS Code";
    opt.textContent = `${s.title} — ${src}, ${formatAgo(now - s.mtimeMs)}`;
    opt.title = s.cwd ?? "";
    opt.selected = s.key === currentKey;
    sessionEl.append(opt);
  }
}

function renderCounts() {
  if (!snapshot) {
    countsEl.innerHTML = "";
    return;
  }
  const c = snapshot.counts;
  const chip = (cls: string, n: number, label: string, title: string) =>
    `<span class="chip ${cls}${n === 0 ? " zero" : ""}" title="${esc(title)}"><span class="dot"></span>${n} ${label}</span>`;
  const source = snapshot.source === "copilot"
    ? `<span class="chip source" title="Copilot CLI / SDK harness: finished multi-turn sub-agents stay alive and can be reused.">Copilot harness</span>`
    : `<span class="chip source" title="VS Code Local harness: every sub-agent call is new and single-use.">VS Code Local · single-use sub-agents</span>`;
  countsEl.innerHTML = [
    chip("running", c.running, "running", "Sub-agents currently working"),
    chip("idle", c.idle, "idle", "Finished, kept alive, can be reused for another task"),
    chip("done", c.done, "done", "Finished and discarded (single-use) or session ended"),
    chip("failed", c.failed, "failed", "Failed to start or failed while running"),
    snapshot.ended ? `<span class="chip ended">session ended</span>` : "",
    source,
  ].join("");
}

function renderBanner() {
  if (snapshot?.loading) {
    const { bytesRead, totalBytes } = snapshot.loading;
    const pct = totalBytes > 0 ? Math.floor((bytesRead / totalBytes) * 100) : 0;
    bannerEl.hidden = false;
    bannerEl.textContent = `Loading session history… ${pct}% (${(totalBytes / 1e6).toFixed(0)} MB)`;
  } else {
    bannerEl.hidden = true;
  }
}

function computeLayout(agents: AgentView[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const kids = new Map<string, AgentView[]>();
  const roots: AgentView[] = [];
  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId) && a.parentId !== a.id) {
      const list = kids.get(a.parentId) ?? [];
      list.push(a);
      kids.set(a.parentId, list);
    } else {
      roots.push(a);
    }
  }
  type Size = { w: number; h: number; cols?: number };
  const sizes = new Map<string, Size>();
  const visiting = new Set<string>();

  const measure = (a: AgentView): Size => {
    const cached = sizes.get(a.id);
    if (cached) return cached;
    if (visiting.has(a.id)) return { w: NODE_W, h: NODE_H };
    visiting.add(a.id);
    const ch = kids.get(a.id) ?? [];
    let size: Size;
    if (ch.length === 0) {
      size = { w: NODE_W, h: NODE_H };
    } else {
      const childSizes = ch.map(measure);
      const allLeaves = ch.every((c) => !(kids.get(c.id)?.length));
      if (allLeaves && ch.length > GRID_COLS) {
        const rows = Math.ceil(ch.length / GRID_COLS);
        const w = GRID_COLS * NODE_W + (GRID_COLS - 1) * H_GAP;
        size = { w, h: NODE_H + V_GAP + rows * NODE_H + (rows - 1) * ROW_GAP, cols: GRID_COLS };
      } else {
        const w = childSizes.reduce((s, c) => s + c.w, 0) + H_GAP * (ch.length - 1);
        size = { w: Math.max(NODE_W, w), h: NODE_H + V_GAP + Math.max(...childSizes.map((c) => c.h)) };
      }
    }
    sizes.set(a.id, size);
    return size;
  };

  const next = new Map<string, { x: number; y: number }>();
  const place = (a: AgentView, x0: number, y0: number) => {
    const s = sizes.get(a.id)!;
    next.set(a.id, { x: x0 + (s.w - NODE_W) / 2, y: y0 });
    const ch = kids.get(a.id) ?? [];
    const cy = y0 + NODE_H + V_GAP;
    if (s.cols) {
      const gridW = s.cols * NODE_W + (s.cols - 1) * H_GAP;
      const gx = x0 + (s.w - gridW) / 2;
      ch.forEach((c, i) =>
        next.set(c.id, { x: gx + (i % s.cols!) * (NODE_W + H_GAP), y: cy + Math.floor(i / s.cols!) * (NODE_H + ROW_GAP) }),
      );
      return;
    }
    const total = ch.reduce((sum, c) => sum + sizes.get(c.id)!.w, 0) + H_GAP * Math.max(0, ch.length - 1);
    let x = x0 + (s.w - total) / 2;
    for (const c of ch) {
      if (!next.has(c.id)) {
        place(c, x, cy);
      }
      x += sizes.get(c.id)!.w + H_GAP;
    }
  };

  let x = 0;
  let h = NODE_H;
  for (const r of roots) {
    const s = measure(r);
    place(r, x, 0);
    x += s.w + H_GAP * 2;
    h = Math.max(h, s.h);
  }
  positions = next;
  bounds = { w: Math.max(NODE_W, x - H_GAP * 2), h };
  edgesEl.setAttribute("width", String(bounds.w));
  edgesEl.setAttribute("height", String(bounds.h));
}

function renderNodes() {
  const now = Date.now();
  const live = new Set<string>();
  for (const a of snapshot!.agents) {
    const pos = positions.get(a.id);
    if (!pos) continue;
    live.add(a.id);
    let el = nodeEls.get(a.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = a.id;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        select(a.id, false);
      });
      nodesEl.append(el);
      nodeEls.set(a.id, el);
    }
    const classes = ["node", `status-${a.status}`];
    if (a.isMain) classes.push("main");
    if (a.id === selectedId) classes.push("selected");
    if (a.reuseCount > 0) classes.push("reused");
    if (a.couldHaveReused.length > 0) classes.push("replaced");
    for (const c of el.classList) if (c.startsWith("flash")) classes.push(c);
    el.className = classes.join(" ");
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    const html = renderNode(a, now);
    if (nodeHtml.get(el) !== html) {
      el.innerHTML = html;
      nodeHtml.set(el, html);
    }
  }
  for (const [id, el] of nodeEls) {
    if (!live.has(id)) {
      el.remove();
      nodeEls.delete(id);
    }
  }
}

function renderNode(a: AgentView, now: number): string {
  const badges: string[] = [];
  if (!a.isMain && now - a.createdAt < 15_000 && !snapshot!.loading) {
    badges.push(`<span class="badge new">new</span>`);
  }
  if (a.reuseCount > 0) {
    badges.push(`<span class="badge reuse" title="Received ${a.reuseCount} new task(s) after it had finished">↻ reused ×${a.reuseCount}</span>`);
  }
  if (a.couldHaveReused.length > 0) {
    const names = a.couldHaveReused.map(nameOf).join(", ");
    badges.push(`<span class="badge replaced" title="${esc(`Created while idle agent(s) of the same type could have been reused: ${names}`)}">new, not reused</span>`);
  }
  if (!a.isMain && !a.multiTurn && a.status === "done") {
    badges.push(`<span class="badge single" title="Single-use agent: it finished and was discarded">single-use</span>`);
  }
  const sub = [a.isMain ? "main" : a.agentType, a.model].filter(Boolean).join(" · ");
  const elapsed = a.durationMs ?? (a.status === "running" ? now - a.createdAt : a.lastActivityAt - a.createdAt);
  return `
    <div class="node-head"><span class="dot"></span><span class="name" title="${esc(a.name)}">${esc(a.name)}</span></div>
    <div class="node-sub" title="${esc(sub)}">${esc(sub || "agent")}</div>
    <div class="node-status">${esc(a.statusText)}</div>
    <div class="node-badges">${badges.join("")}</div>
    <div class="node-meta">
      <span title="Tool calls">⚒ ${a.toolCalls}</span>
      <span title="${a.isMain ? "Since session start" : "Active time"}">◷ ${formatDuration(elapsed)}</span>
      ${a.tokens !== undefined ? `<span title="Tokens">◈ ${formatTokens(a.tokens)}</span>` : ""}
      ${a.errors > 0 ? `<span class="errors" title="Failed tool calls">✕ ${a.errors}</span>` : ""}
    </div>`;
}

function renderEdges() {
  const live = new Set<string>();
  const liveLabels = new Set<string>();
  const byId = new Map(snapshot!.agents.map((a) => [a.id, a]));

  const upsertPath = (key: string, d: string, cls: string, title: string) => {
    live.add(key);
    let p = edgeEls.get(key);
    if (!p) {
      p = document.createElementNS(SVG_NS, "path");
      const t = document.createElementNS(SVG_NS, "title");
      p.append(t);
      edgesEl.append(p);
      edgeEls.set(key, p);
    }
    if (p.getAttribute("d") !== d) p.setAttribute("d", d);
    if (p.getAttribute("class") !== cls) p.setAttribute("class", cls);
    p.firstChild!.textContent = title;
  };
  const upsertLabel = (key: string, x: number, y: number, html: string, cls: string) => {
    liveLabels.add(key);
    let el = labelEls.get(key);
    if (!el) {
      el = document.createElement("div");
      nodesEl.append(el);
      labelEls.set(key, el);
    }
    el.className = `edge-label ${cls}`;
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    if (el.innerHTML !== html) el.innerHTML = html;
  };

  for (const a of snapshot!.agents) {
    if (!a.parentId) continue;
    const from = positions.get(a.parentId);
    const to = positions.get(a.id);
    if (!from || !to) continue;
    const d = treePath(from, to);
    const replaced = a.couldHaveReused.length > 0;
    upsertPath(
      `tree:${a.id}`,
      d,
      `edge tree status-${a.status}${replaced ? " replaced" : ""}${a.reuseCount ? " reused" : ""}`,
      `${nameOf(a.parentId)} created “${a.name}”`,
    );
    const chips: string[] = [];
    if (a.reuseCount) chips.push(`<span class="k-reuse" title="New tasks sent after it finished">↻ ${a.reuseCount}</span>`);
    if (a.steerCount) chips.push(`<span class="k-steer" title="Follow-ups sent while it was running">✉ ${a.steerCount}</span>`);
    if (chips.length) {
      // Place chips close to the child so they don't pile up under a busy parent.
      upsertLabel(`tree:${a.id}`, to.x + NODE_W / 2, to.y - 22, chips.join(""), "tree");
    }
  }

  const peers = new Map<string, { t: TaskView; n: number }>();
  for (const t of snapshot!.tasks) {
    if (t.kind !== "peer") continue;
    const key = `peer:${t.fromAgentId}>${t.toAgentId}`;
    const e = peers.get(key);
    if (e) e.n++;
    else peers.set(key, { t, n: 1 });
  }
  for (const [key, { t, n }] of peers) {
    const from = positions.get(t.fromAgentId);
    const to = positions.get(t.toAgentId);
    if (!from || !to || !byId.has(t.fromAgentId) || !byId.has(t.toAgentId)) continue;
    const { d, mid } = peerPath(from, to);
    upsertPath(key, d, "edge peer", `${nameOf(t.fromAgentId)} → ${nameOf(t.toAgentId)}: ${n} message(s)`);
    upsertLabel(key, mid.x, mid.y, `<span class="k-peer">⇄ ${n}</span>`, "peer");
  }

  for (const [key, el] of edgeEls) {
    if (!live.has(key)) {
      el.remove();
      edgeEls.delete(key);
    }
  }
  for (const [key, el] of labelEls) {
    if (!liveLabels.has(key)) {
      el.remove();
      labelEls.delete(key);
    }
  }
}

function treePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const ex = to.x + NODE_W / 2;
  const ey = to.y;
  const dy = Math.max(30, (ey - sy) / 2);
  return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
}

function peerPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const leftToRight = from.x <= to.x;
  const sx = from.x + NODE_W / 2 + (leftToRight ? 30 : -30);
  const ex = to.x + NODE_W / 2 + (leftToRight ? -30 : 30);
  const sy = from.y;
  const ey = to.y;
  const lift = Math.min(V_GAP * 1.6, 70 + Math.abs(ex - sx) / 10);
  const cx = (sx + ex) / 2;
  const cy = Math.min(sy, ey) - lift;
  // Point on the quadratic curve at t = 0.5.
  const mid = { x: (sx + 2 * cx + ex) / 4, y: (sy + 2 * cy + ey) / 4 };
  return { d: `M ${sx} ${sy} Q ${cx} ${cy}, ${ex} ${ey}`, mid };
}

function animateTask(t: TaskView) {
  const fromPos = positions.get(t.fromAgentId);
  const toPos = positions.get(t.toAgentId);
  if (!fromPos || !toPos) return;
  const target = snapshot!.agents.find((a) => a.id === t.toAgentId);
  let d: string;
  if (t.kind === "peer") {
    d = peerPath(fromPos, toPos).d;
  } else if (t.kind === "read") {
    d = target?.parentId === t.fromAgentId ? reversePath(fromPos, toPos) : centerPath(toPos, fromPos);
  } else {
    d = target?.parentId === t.fromAgentId ? treePath(fromPos, toPos) : centerPath(fromPos, toPos);
  }
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", t.kind === "read" ? "4" : "6");
  dot.setAttribute("class", `pulse k-${t.kind}`);
  const motion = document.createElementNS(SVG_NS, "animateMotion") as SVGAnimationElement;
  motion.setAttribute("dur", "1.1s");
  motion.setAttribute("fill", "freeze");
  motion.setAttribute("begin", "indefinite");
  motion.setAttribute("path", d);
  dot.append(motion);
  pulsesEl.append(dot);
  try {
    motion.beginElement();
  } catch {
    // SMIL unavailable; the node flash still signals the event.
  }
  setTimeout(() => dot.remove(), 1500);

  const flashId = t.kind === "read" ? t.fromAgentId : t.toAgentId;
  const el = nodeEls.get(flashId);
  if (el) {
    const cls = `flash-${t.kind}`;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 2200);
  }
}

function reversePath(parent: { x: number; y: number }, child: { x: number; y: number }): string {
  const sx = child.x + NODE_W / 2;
  const sy = child.y;
  const ex = parent.x + NODE_W / 2;
  const ey = parent.y + NODE_H;
  const dy = Math.max(30, (sy - ey) / 2);
  return `M ${sx} ${sy} C ${sx} ${sy - dy}, ${ex} ${ey + dy}, ${ex} ${ey}`;
}

function centerPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return `M ${from.x + NODE_W / 2} ${from.y + NODE_H / 2} L ${to.x + NODE_W / 2} ${to.y + NODE_H / 2}`;
}

function renderDetails() {
  const a = snapshot!.agents.find((x) => x.id === selectedId);
  if (!a) {
    detailsEl.innerHTML = "";
    return;
  }
  const now = Date.now();
  const rows: [string, string][] = [];
  if (!a.isMain) {
    rows.push(["Type", a.agentType ?? "–"]);
  }
  rows.push(["Model", a.model ?? "–"]);
  if (!a.isMain) {
    rows.push(["Mode", a.executionMode ?? "–"]);
    rows.push(["Reusable", a.multiTurn ? "yes — stays alive for follow-up tasks" : "no — single-use"]);
    rows.push(["Created by", a.parentId ? nameOf(a.parentId) : "–"]);
  }
  rows.push(["Started", `${new Date(a.createdAt).toLocaleTimeString()} (${formatAgo(now - a.createdAt)})`]);
  if (a.durationMs !== undefined) rows.push(["Duration", formatDuration(a.durationMs)]);
  rows.push(["Tool calls", String(a.toolCalls) + (a.errors ? ` (${a.errors} failed)` : "")]);
  if (a.tokens !== undefined) rows.push(["Tokens", formatTokens(a.tokens)]);
  if (!a.isMain) rows.push(["Tasks received", `${1 + a.reuseCount} (${a.reuseCount} reuse, ${a.steerCount} follow-ups)`]);

  const callouts: string[] = [];
  if (a.couldHaveReused.length > 0) {
    callouts.push(
      `<div class="callout replaced">Created as a <b>new</b> agent while ${a.couldHaveReused
        .map((id) => `<a data-agent="${esc(id)}">${esc(nameOf(id))}</a>`)
        .join(", ")} (same type) was idle and could have been reused.</div>`,
    );
  }
  if (a.reuseCount > 0) {
    callouts.push(`<div class="callout reuse">Reused ${a.reuseCount}× — it received new work after finishing instead of a fresh agent being created.</div>`);
  }
  if (a.isMain) {
    const c = snapshot!.counts;
    const total = snapshot!.agents.length - 1;
    callouts.push(
      `<div class="callout">${total} sub-agent${total === 1 ? "" : "s"} in this session · ${c.running} running · ${c.idle} idle · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}</div>`,
    );
  }

  const tasks = snapshot!.tasks
    .filter((t) => (a.isMain ? t.fromAgentId === a.id : t.toAgentId === a.id || t.fromAgentId === a.id))
    .slice(-40)
    .reverse();
  const taskHtml = tasks.length
    ? tasks
        .map(
          (t) => `<li>
            <span class="pill k-${t.kind}">${KIND_LABEL[t.kind]}</span>
            <span class="who">${esc(nameOf(t.fromAgentId))} → ${esc(nameOf(t.toAgentId))}</span>
            <span class="when">${new Date(t.at).toLocaleTimeString()}</span>
            ${t.summary ? `<div class="summary">${esc(t.summary)}</div>` : ""}
          </li>`,
        )
        .join("")
    : `<li class="muted">No tasks yet.</li>`;

  const toolsHtml = a.recentTools.length
    ? [...a.recentTools]
        .reverse()
        .map(
          (t) => `<li>
            <span class="tool-state ${t.success === false ? "fail" : t.success ? "ok" : "run"}"></span>
            <span class="tool-name">${esc(t.name)}</span>
            ${t.title ? `<span class="tool-title">${esc(t.title)}</span>` : ""}
            <span class="when">${t.durationMs !== undefined ? formatDuration(t.durationMs) : "…"}</span>
          </li>`,
        )
        .join("")
    : `<li class="muted">${snapshot!.source === "vscode" && !a.isMain ? "Not recorded for VS Code Local sub-agents." : "No tool calls yet."}</li>`;

  detailsEl.innerHTML = `
    <div class="details-head status-${a.status}">
      <span class="dot"></span>
      <h2 title="${esc(a.name)}">${esc(a.name)}</h2>
      <span class="status-pill">${esc(a.status)}</span>
    </div>
    <div class="status-text">${esc(a.statusText)}</div>
    ${a.description ? `<p class="description">${esc(a.description)}</p>` : ""}
    ${callouts.join("")}
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <h3>${a.isMain ? "Delegations" : "Tasks & messages"}</h3>
    <ul class="tasks">${taskHtml}</ul>
    <h3>Recent tools</h3>
    <ul class="tools">${toolsHtml}</ul>`;
  for (const link of detailsEl.querySelectorAll<HTMLElement>("a[data-agent]")) {
    link.addEventListener("click", () => select(link.dataset.agent!, true));
  }
}

function renderFeed(animate: boolean) {
  const items = snapshot!.feed.slice(-150).reverse();
  const frag = document.createDocumentFragment();
  for (const f of items) {
    frag.append(feedItem(f, animate && !seenFeed.has(f.id)));
  }
  feedEl.replaceChildren(frag);
  for (const f of snapshot!.feed) seenFeed.add(f.id);
}

function feedItem(f: FeedItem, fresh: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = `feed-item${fresh ? " fresh" : ""}${f.agentId ? " clickable" : ""}`;
  const time = document.createElement("span");
  time.className = "when";
  time.textContent = new Date(f.at).toLocaleTimeString();
  const pill = document.createElement("span");
  pill.className = `pill k-${f.kind}`;
  pill.textContent = f.kind in KIND_LABEL ? KIND_LABEL[f.kind as TaskKind] : f.kind === "complete" ? "finished" : f.kind;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = f.text;
  li.append(pill, time, text);
  if (f.agentId) {
    li.addEventListener("click", () => select(f.agentId!, true));
  }
  return li;
}

function select(id: string, reveal: boolean) {
  if (!snapshot?.agents.some((a) => a.id === id)) return;
  selectedId = id;
  for (const [nid, el] of nodeEls) el.classList.toggle("selected", nid === id);
  renderDetails();
  if (reveal) {
    const pos = positions.get(id);
    if (pos) {
      const r = graphEl.getBoundingClientRect();
      view.x = r.width / 2 - (pos.x + NODE_W / 2) * view.k;
      view.y = r.height / 2 - (pos.y + NODE_H / 2) * view.k;
      userMoved = true;
      applyView(true);
    }
  }
}

// ---------- pan & zoom ----------

function applyView(smooth = false) {
  viewportEl.classList.toggle("smooth", smooth);
  viewportEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
}

function fit() {
  const r = graphEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const pad = 32;
  const k = Math.min(1, (r.width - pad * 2) / bounds.w, (r.height - pad * 2) / bounds.h);
  view.k = Math.max(0.12, k);
  view.x = (r.width - bounds.w * view.k) / 2;
  view.y = pad;
  applyView(true);
}

function zoomAt(factor: number, cx?: number, cy?: number) {
  const r = graphEl.getBoundingClientRect();
  const px = cx ?? r.width / 2;
  const py = cy ?? r.height / 2;
  const k = Math.min(2, Math.max(0.1, view.k * factor));
  view.x = px - ((px - view.x) * k) / view.k;
  view.y = py - ((py - view.y) * k) / view.k;
  view.k = k;
  userMoved = true;
  applyView();
}

graphEl.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const r = graphEl.getBoundingClientRect();
    zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
  },
  { passive: false },
);

let drag: { x: number; y: number; vx: number; vy: number } | undefined;
graphEl.addEventListener("pointerdown", (ev) => {
  if ((ev.target as HTMLElement).closest(".node, .graph-controls, button")) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  graphEl.setPointerCapture(ev.pointerId);
  graphEl.classList.add("dragging");
});
graphEl.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  view.x = drag.vx + ev.clientX - drag.x;
  view.y = drag.vy + ev.clientY - drag.y;
  userMoved = true;
  applyView();
});
const endDrag = () => {
  drag = undefined;
  graphEl.classList.remove("dragging");
};
graphEl.addEventListener("pointerup", endDrag);
graphEl.addEventListener("pointercancel", endDrag);
new ResizeObserver(() => {
  if (!userMoved) fit();
}).observe(graphEl);

// Keep relative times and "new" badges fresh between snapshots.
setInterval(() => {
  if (snapshot) {
    renderNodes();
  }
}, 5000);

// ---------- helpers ----------

function nameOf(id: string): string {
  if (id === "main") return "Main agent";
  return snapshot?.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

vscode.postMessage({ type: "ready" });
