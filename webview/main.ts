import { formatAgo, formatDuration, formatTokens } from "../src/model/format";
import type { AgentView, FeedItem, SessionSnapshot, TaskKind, TaskView } from "../src/model/snapshot";
import type { FromWebview, SessionOption, ToWebview } from "../src/webview/messages";

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const NODE_W = 200;
const NODE_H = 108;
const H_GAP = 28;
const V_GAP = 84;
const GRID_COLS = 4;
const MAX_ROW_W = GRID_COLS * NODE_W + (GRID_COLS - 1) * H_GAP;
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
const openChatEl = $<HTMLButtonElement>("openChat");

let snapshot: SessionSnapshot | undefined;
let sessions: SessionOption[] = [];
let currentKey: string | undefined;
/** Session keys whose conversation can be opened in this VS Code window. */
const openableKeys = new Set<string>();
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
type Pos = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
/** How a tree edge reaches a child below its parent's first row: down a trunk through a gap, then into the row. */
type Route = { trunkX: number; firstTop: number; prevBottom: number };
let positions = new Map<string, Pos>();
let routes = new Map<string, Route>();

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
    renderOpenChat();
  } else if (msg.type === "conversation") {
    if (msg.available) {
      openableKeys.add(msg.key);
    } else {
      openableKeys.delete(msg.key);
    }
    renderOpenChat();
  }
});

sessionEl.addEventListener("change", () => vscode.postMessage({ type: "selectSession", key: sessionEl.value }));
followEl.addEventListener("change", () => vscode.postMessage({ type: "setFollow", follow: followEl.checked }));
$("reload").addEventListener("click", () => vscode.postMessage({ type: "reload" }));
openChatEl.addEventListener("click", () => vscode.postMessage({ type: "openConversation" }));
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
  computeLayout(snapshot.agents, snapshot.tasks);
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

function renderOpenChat() {
  openChatEl.hidden = currentKey === undefined || !openableKeys.has(currentKey);
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

function computeLayout(agents: AgentView[], tasks: TaskView[]) {
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
  type Size = { w: number; h: number };
  type Item = { agent: AgentView; size: Size };
  type Row = { items: Item[]; w: number; h: number };
  const sizes = new Map<string, Size>();
  const rowsOf = new Map<string, Row[]>();
  const visiting = new Set<string>();

  // Siblings that message each other form a team; a team shares a row so its message lines stay short.
  // Agents with their own sub-agents stay out of teams: their nested group keeps its own rows.
  const isLeaf = (id: string) => !kids.get(id)?.length;
  const peerLinks = new Map<string, Set<string>>();
  for (const t of tasks) {
    const a = byId.get(t.fromAgentId);
    const b = byId.get(t.toAgentId);
    if (t.kind !== "peer" || !a || !b || a.id === b.id || a.parentId !== b.parentId) continue;
    if (!isLeaf(a.id) || !isLeaf(b.id)) continue;
    for (const [p, q] of [[a.id, b.id], [b.id, a.id]]) {
      const set = peerLinks.get(p) ?? new Set<string>();
      set.add(q);
      peerLinks.set(p, set);
    }
  }
  const teamsOf = (ch: AgentView[]): AgentView[][] => {
    const index = new Map(ch.map((c, i) => [c.id, i]));
    const seen = new Set<string>();
    const teams: AgentView[][] = [];
    for (const c of ch) {
      if (seen.has(c.id)) continue;
      const team: AgentView[] = [];
      const queue = [c];
      seen.add(c.id);
      while (queue.length) {
        const cur = queue.shift()!;
        team.push(cur);
        for (const id of peerLinks.get(cur.id) ?? []) {
          if (!seen.has(id) && index.has(id)) {
            seen.add(id);
            queue.push(ch[index.get(id)!]);
          }
        }
      }
      teams.push(team.sort((x, y) => index.get(x.id)! - index.get(y.id)!));
    }
    return teams;
  };

  const measure = (a: AgentView): Size => {
    const cached = sizes.get(a.id);
    if (cached) return cached;
    if (visiting.has(a.id)) return { w: NODE_W, h: NODE_H };
    visiting.add(a.id);
    const ch = kids.get(a.id) ?? [];
    let size: Size = { w: NODE_W, h: NODE_H };
    if (ch.length > 0) {
      // Teams with nested groups go last (stable), so edges to later rows don't cut through a group.
      const teams = teamsOf(ch).map((team) => team.map((agent): Item => ({ agent, size: measure(agent) })));
      const teamH = (team: Item[]) => Math.max(...team.map((i) => i.size.h));
      teams.sort((x, y) => teamH(x) - teamH(y));
      // Pack children (with their nested groups) into rows no wider than MAX_ROW_W. A team that fits on
      // one row goes into the first row with room for all of it; later single agents may fill the gap it left.
      const rows: Row[] = [];
      const fits = (row: Row, w: number) => row.items.length === 0 || row.w + H_GAP + w <= MAX_ROW_W;
      const add = (row: Row, item: Item) => {
        row.w += (row.items.length ? H_GAP : 0) + item.size.w;
        row.h = Math.max(row.h, item.size.h);
        row.items.push(item);
      };
      const rowWithRoom = (w: number, from: number) => {
        const found = rows.slice(from).find((r) => fits(r, w));
        if (found) return found;
        const row: Row = { items: [], w: 0, h: 0 };
        rows.push(row);
        return row;
      };
      for (const team of teams) {
        const w = team.reduce((sum, i) => sum + i.size.w, 0) + H_GAP * (team.length - 1);
        if (w <= MAX_ROW_W) {
          const row = rowWithRoom(w, 0);
          for (const item of team) add(row, item);
        } else {
          for (const item of team) add(rowWithRoom(item.size.w, Math.max(0, rows.length - 1)), item);
        }
      }
      rowsOf.set(a.id, rows);
      const rowsH = rows.reduce((sum, r) => sum + r.h, 0) + V_GAP * (rows.length - 1);
      size = { w: Math.max(NODE_W, ...rows.map((r) => r.w)), h: NODE_H + V_GAP + rowsH };
    }
    sizes.set(a.id, size);
    return size;
  };

  const next = new Map<string, Pos>();
  const nextRoutes = new Map<string, Route>();
  const place = (a: AgentView, x0: number, y0: number) => {
    const s = sizes.get(a.id)!;
    const ax = x0 + (s.w - NODE_W) / 2;
    next.set(a.id, { x: ax, y: y0 });
    let cy = y0 + NODE_H + V_GAP;
    const placed: { top: number; bottom: number; spans: [number, number][]; ids: string[] }[] = [];
    for (const row of rowsOf.get(a.id) ?? []) {
      let x = x0 + (s.w - row.w) / 2;
      const spans: [number, number][] = [];
      const ids: string[] = [];
      for (const { agent, size } of row.items) {
        if (!next.has(agent.id)) {
          place(agent, x, cy);
          ids.push(agent.id);
        }
        spans.push([x, x + size.w]);
        x += size.w + H_GAP;
      }
      placed.push({ top: cy, bottom: cy + row.h, spans, ids });
      cy += row.h + V_GAP;
    }
    if (placed.length > 1) {
      const trunkX = pickTrunk(ax + NODE_W / 2, placed.slice(0, -1).flatMap((r) => r.spans));
      placed.forEach((row, i) => {
        if (i === 0) return;
        for (const id of row.ids) {
          nextRoutes.set(id, { trunkX, firstTop: placed[0].top, prevBottom: placed[i - 1].bottom });
        }
      });
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
  routes = nextRoutes;
  bounds = { w: Math.max(NODE_W, x - H_GAP * 2), h };
  edgesEl.setAttribute("width", String(bounds.w));
  edgesEl.setAttribute("height", String(bounds.h));
}

/** The x closest to `center` that runs clear of every card or group span (through a gap between them, or beside them). */
function pickTrunk(center: number, spans: [number, number][]): number {
  const clear = (x: number) => spans.every(([l, r]) => x < l - 6 || x > r + 6);
  const candidates = [center, ...spans.flatMap(([l, r]) => [l - H_GAP / 2, r + H_GAP / 2])];
  return candidates.filter(clear).sort((p, q) => Math.abs(p - center) - Math.abs(q - center))[0] ?? center;
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
  const upsertLabel = (key: string, html: string, cls: string): HTMLElement => {
    liveLabels.add(key);
    let el = labelEls.get(key);
    if (!el) {
      el = document.createElement("div");
      nodesEl.append(el);
      labelEls.set(key, el);
    }
    el.className = `edge-label ${cls}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    return el;
  };
  // Labels avoid cards and each other: each one takes the first spot along its edge that is still free.
  const taken: Rect[] = [...positions.values()].map((p) => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H }));
  const placeLabel = (el: HTMLElement, spots: Pos[]) => {
    const w = el.offsetWidth || 32;
    const h = el.offsetHeight || 18;
    const rectAt = (p: Pos): Rect => ({ x: p.x - w / 2 - 3, y: p.y - h / 2 - 3, w: w + 6, h: h + 6 });
    const spot = spots.find((p) => !taken.some((r) => overlaps(r, rectAt(p)))) ?? spots[0];
    taken.push(rectAt(spot));
    el.style.transform = `translate(${spot.x}px, ${spot.y}px) translate(-50%, -50%)`;
  };

  for (const a of snapshot!.agents) {
    if (!a.parentId) continue;
    const from = positions.get(a.parentId);
    const to = positions.get(a.id);
    if (!from || !to) continue;
    const d = treePath(a.id, from, to);
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
      const el = upsertLabel(`tree:${a.id}`, chips.join(""), "tree");
      const cx = to.x + NODE_W / 2;
      placeLabel(el, [{ x: cx, y: to.y - 22 }, { x: cx, y: to.y - 46 }]);
    }
  }

  // One line per pair of agents, whichever way the messages went.
  const peers = new Map<string, { a: string; b: string; ab: number; ba: number }>();
  for (const t of snapshot!.tasks) {
    if (t.kind !== "peer" || t.fromAgentId === t.toAgentId) continue;
    const [a, b] = t.fromAgentId < t.toAgentId ? [t.fromAgentId, t.toAgentId] : [t.toAgentId, t.fromAgentId];
    const key = `peer:${a}|${b}`;
    const e = peers.get(key) ?? { a, b, ab: 0, ba: 0 };
    if (t.fromAgentId === a) e.ab++;
    else e.ba++;
    peers.set(key, e);
  }
  for (const [key, { a, b, ab, ba }] of peers) {
    if (!byId.has(a) || !byId.has(b) || !positions.has(a) || !positions.has(b)) continue;
    const [p, q] = peerOrder(a, b);
    const { d, at } = peerPath(positions.get(p)!, positions.get(q)!);
    const title = [
      ab ? `${nameOf(a)} → ${nameOf(b)}: ${ab}` : "",
      ba ? `${nameOf(b)} → ${nameOf(a)}: ${ba}` : "",
    ].filter(Boolean).join("\n");
    upsertPath(key, d, "edge peer", `Messages between agents\n${title}`);
    const el = upsertLabel(key, `<span class="k-peer" title="${esc(title)}">⇄ ${ab + ba}</span>`, "peer");
    placeLabel(el, [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8].map(at));
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

function overlaps(r: Rect, s: Rect): boolean {
  return r.x < s.x + s.w && s.x < r.x + r.w && r.y < s.y + s.h && s.y < r.y + r.h;
}

/** Draw order for a peer line: upper card first, then left to right. */
function peerOrder(a: string, b: string): [string, string] {
  const pa = positions.get(a);
  const pb = positions.get(b);
  if (!pa || !pb) return [a, b];
  return pa.y < pb.y || (pa.y === pb.y && pa.x <= pb.x) ? [a, b] : [b, a];
}

function treePath(childId: string, from: Pos, to: Pos): string {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const ex = to.x + NODE_W / 2;
  const ey = to.y;
  const route = routes.get(childId);
  if (!route) {
    const dy = Math.max(30, (ey - sy) / 2);
    return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
  }
  // Later rows: down the trunk (a gap between the cards above), then curve into the gap above the child's row.
  const { trunkX: tx, firstTop, prevBottom } = route;
  const d0 = (firstTop - sy) / 2;
  const head = Math.abs(tx - sx) < 0.5
    ? `M ${sx} ${sy}`
    : `M ${sx} ${sy} C ${sx} ${sy + d0}, ${tx} ${firstTop - d0}, ${tx} ${firstTop}`;
  const dy = (ey - prevBottom) / 2;
  return `${head} L ${tx} ${prevBottom} C ${tx} ${prevBottom + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
}

function peerPath(from: Pos, to: Pos): { d: string; at: (t: number) => Pos } {
  const leftToRight = from.x <= to.x;
  const sx = from.x + NODE_W / 2 + (leftToRight ? 30 : -30);
  const ex = to.x + NODE_W / 2 + (leftToRight ? -30 : 30);
  if (from.y + NODE_H <= to.y || to.y + NODE_H <= from.y) {
    // Different rows: run between them, bottom of the upper card to top of the lower card, so the
    // line doesn't arc up behind the cards in the upper row.
    const down = from.y < to.y;
    const sy = down ? from.y + NODE_H : from.y;
    const ey = down ? to.y : to.y + NODE_H;
    const dy = (ey - sy) / 2;
    const p = [{ x: sx, y: sy }, { x: sx, y: sy + dy }, { x: ex, y: ey - dy }, { x: ex, y: ey }];
    const at = (t: number): Pos => {
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      return { x: w.reduce((s, k, i) => s + k * p[i].x, 0), y: w.reduce((s, k, i) => s + k * p[i].y, 0) };
    };
    return { d: `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`, at };
  }
  const sy = from.y;
  const ey = to.y;
  const lift = Math.min(V_GAP * 1.6, 70 + Math.abs(ex - sx) / 10);
  const cx = (sx + ex) / 2;
  const cy = Math.min(sy, ey) - lift;
  // Point on the quadratic curve at t.
  const at = (t: number): Pos => {
    const u = 1 - t;
    return { x: u * u * sx + 2 * u * t * cx + t * t * ex, y: u * u * sy + 2 * u * t * cy + t * t * ey };
  };
  return { d: `M ${sx} ${sy} Q ${cx} ${cy}, ${ex} ${ey}`, at };
}

function animateTask(t: TaskView) {
  const fromPos = positions.get(t.fromAgentId);
  const toPos = positions.get(t.toAgentId);
  if (!fromPos || !toPos) return;
  const target = snapshot!.agents.find((a) => a.id === t.toAgentId);
  const fromParent = target?.parentId === t.fromAgentId;
  let d: string;
  // Pulses travel along the drawn edge; `reverse` runs them from its end back to its start.
  let reverse = false;
  if (t.kind === "peer") {
    const [p, q] = peerOrder(t.fromAgentId, t.toAgentId);
    d = peerPath(positions.get(p)!, positions.get(q)!).d;
    reverse = p !== t.fromAgentId;
  } else if (t.kind === "read") {
    d = fromParent ? treePath(t.toAgentId, fromPos, toPos) : centerPath(toPos, fromPos);
    reverse = fromParent;
  } else {
    d = fromParent ? treePath(t.toAgentId, fromPos, toPos) : centerPath(fromPos, toPos);
  }
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", t.kind === "read" ? "4" : "6");
  dot.setAttribute("class", `pulse k-${t.kind}`);
  const motion = document.createElementNS(SVG_NS, "animateMotion") as SVGAnimationElement;
  motion.setAttribute("dur", "1.1s");
  motion.setAttribute("fill", "freeze");
  motion.setAttribute("begin", "indefinite");
  motion.setAttribute("path", d);
  if (reverse) {
    motion.setAttribute("keyPoints", "1;0");
    motion.setAttribute("keyTimes", "0;1");
    motion.setAttribute("calcMode", "linear");
  }
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

function centerPath(from: Pos, to: Pos): string {
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
