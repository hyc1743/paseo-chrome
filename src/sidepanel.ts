import {
  createPaseoClient,
  type PaseoAgent,
  type PaseoClient,
  type PaseoClientConfig,
} from "@getpaseo/client";
import { parseConnectionOfferFromUrl, type ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import {
  buildRelayWebSocketUrl,
  parseRelayConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";

const DEFAULT_URL = "ws://127.0.0.1:6767/ws";

/**
 * Turns user input into client config. Accepts:
 *  - official pairing link: https://app.paseo.sh/#offer=<base64url>
 *  - relay URI: relay://host:port/<serverId>?key=...  (or ...#connect=<relay uri>)
 *  - direct WebSocket URL: ws(s)://host:port/ws
 */
function resolveTarget(input: string, password?: string): { config: PaseoClientConfig; label: string } {
  const trimmed = input.trim() || DEFAULT_URL;
  let offer: ConnectionOffer | null = null;
  let pw = password;
  if (trimmed.startsWith("relay://") || trimmed.includes("#connect=")) {
    const parsed = parseRelayConnectionUri(trimmed);
    offer = parsed.offer;
    pw = pw || parsed.password;
  } else if (trimmed.includes("#offer=")) {
    offer = parseConnectionOfferFromUrl(trimmed);
  }
  if (!offer) {
    if (!/^wss?:\/\//.test(trimmed)) throw new Error("无法识别：请输入配对链接或 ws:// 地址");
    return { config: { url: trimmed, password: pw }, label: trimmed };
  }
  const url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
    serverId: offer.serverId,
    role: "client",
  });
  // `minimumMode` is forwarded to the underlying DaemonClient (not yet in the public type).
  const e2ee = {
    enabled: true,
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
    ...(offer.minimumSecurityMode ? { minimumMode: offer.minimumSecurityMode } : {}),
  } as PaseoClientConfig["e2ee"];
  return {
    config: { url, password: pw, e2ee },
    label: `relay · ${offer.serverId}`,
  };
}

type TimelineEntry = Awaited<
  ReturnType<ReturnType<PaseoClient["agents"]["ref"]>["timeline"]["refetch"]>
>["entries"][number];
type PermissionRequest = PaseoAgent["pendingPermissions"][number];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  connectView: $("connect-view"),
  mainView: $("main-view"),
  url: $<HTMLInputElement>("url"),
  password: $<HTMLInputElement>("password"),
  connectBtn: $<HTMLButtonElement>("connect-btn"),
  connectError: $("connect-error"),
  originHint: $("origin-hint"),
  statusDot: $("status-dot"),
  hostLabel: $("host-label"),
  disconnectBtn: $("disconnect-btn"),
  listView: $("agent-list-view"),
  agents: $("agents"),
  refreshBtn: $("refresh-btn"),
  newBtn: $("new-btn"),
  newView: $<HTMLFormElement>("new-agent-view"),
  provider: $<HTMLSelectElement>("provider"),
  cwd: $<HTMLInputElement>("cwd"),
  prompt: $<HTMLTextAreaElement>("prompt"),
  cancelNewBtn: $("cancel-new-btn"),
  newError: $("new-error"),
  chatView: $("chat-view"),
  backBtn: $("back-btn"),
  chatTitle: $("chat-title"),
  chatStatus: $("chat-status"),
  permissions: $("permissions"),
  timeline: $("timeline"),
  sendForm: $<HTMLFormElement>("send-form"),
  message: $<HTMLTextAreaElement>("message"),
};

let client: PaseoClient | null = null;
let agents = new Map<string, PaseoAgent>();
let releaseAgentList: (() => void) | null = null;
let currentAgentId: string | null = null;
let closeChat: (() => void) | null = null;

// ---------- helpers ----------

function show(view: "list" | "new" | "chat") {
  els.listView.hidden = view !== "list";
  els.newView.hidden = view !== "new";
  els.chatView.hidden = view !== "chat";
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function el(tag: string, cls?: string, text?: string) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusBadge(node: HTMLElement, status: string) {
  node.textContent = status;
  node.className = "badge " + (status === "running" ? "running" : status === "error" ? "error" : "");
}

function agentName(a: PaseoAgent) {
  return a.title || a.cwd.split(/[\\/]/).filter(Boolean).pop() || a.id;
}

// ---------- connection ----------

async function connect() {
  const url = els.url.value.trim() || DEFAULT_URL;
  const password = els.password.value || undefined;
  els.connectError.textContent = "";
  els.connectBtn.disabled = true;
  els.connectBtn.textContent = "连接中…";
  try {
    const target = resolveTarget(url, password);
    const c = createPaseoClient({
      ...target.config,
      appVersion: chrome.runtime.getManifest().version,
      connectTimeoutMs: 10_000,
      reconnect: { enabled: true },
    });
    await c.connect();
    client = c;
    await chrome.storage.local.set({ url, password: password ?? "" });
    els.hostLabel.textContent = target.label;
    els.connectView.hidden = true;
    els.mainView.hidden = false;
    startStatusPolling();
    await loadAgents();
    show("list");
  } catch (e) {
    els.connectError.textContent = `连接失败：${errMsg(e)}`;
  } finally {
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = "连接";
  }
}

async function disconnect() {
  closeChat?.();
  releaseAgentList?.();
  releaseAgentList = null;
  const c = client;
  client = null;
  await c?.close().catch(() => {});
  els.mainView.hidden = true;
  els.connectView.hidden = false;
}

let statusTimer: number | undefined;
function startStatusPolling() {
  clearInterval(statusTimer);
  statusTimer = window.setInterval(() => {
    if (!client) return;
    const state = client.getConnectionState() as { status?: string } | string;
    const s = typeof state === "string" ? state : (state.status ?? "");
    els.statusDot.className = s === "connected" ? "connected" : s.includes("connect") ? "connecting" : "";
    els.statusDot.title = s;
  }, 1000);
}

// ---------- agent list ----------

async function loadAgents() {
  if (!client) return;
  releaseAgentList?.();
  const result = await client.agents.list({ subscribe: {} });
  agents = new Map(result.entries.map((entry) => [entry.agent.id, entry.agent]));
  const unsubscribe = client.agents.subscribe((update) => {
    if (update.kind === "upsert") agents.set(update.agent.id, update.agent);
    else if (update.kind === "remove") agents.delete(update.agentId);
    renderAgents();
    if (currentAgentId && agents.has(currentAgentId)) renderChatHeader(agents.get(currentAgentId)!);
  });
  releaseAgentList = () => {
    unsubscribe();
    void result.subscription.release().catch(() => {});
  };
  renderAgents();
}

function renderAgents() {
  els.agents.replaceChildren();
  const list = [...agents.values()]
    .filter((a) => !a.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (list.length === 0) {
    els.agents.append(el("li", "agent-meta", "暂无 agent，点击「新建」创建一个。"));
    return;
  }
  for (const a of list) {
    const li = el("li");
    const top = el("div", "row");
    top.style.marginBottom = "2px";
    const title = el("span", "agent-title", agentName(a));
    title.style.flex = "1";
    const badge = el("span");
    statusBadge(badge, a.requiresAttention ? `${a.status} •` : a.status);
    top.append(title, badge);
    li.append(top, el("div", "agent-meta", `${a.provider}${a.model ? "/" + a.model : ""} · ${a.cwd}`));
    li.onclick = () => void openChat(a.id);
    els.agents.append(li);
  }
}

// ---------- new agent ----------

async function openNewAgent() {
  if (!client) return;
  show("new");
  els.newError.textContent = "";
  const stored = await chrome.storage.local.get(["lastCwd", "lastProvider"]);
  if (stored.lastCwd && !els.cwd.value) els.cwd.value = String(stored.lastCwd);
  els.provider.replaceChildren(el("option", undefined, "加载中…"));
  try {
    const snapshot = await client.providers.snapshot();
    els.provider.replaceChildren();
    for (const entry of snapshot.entries) {
      if (entry.enabled === false || entry.status !== "ready") continue;
      const group = document.createElement("optgroup");
      group.label = entry.label ?? entry.provider;
      for (const m of entry.models ?? []) {
        const opt = el("option", undefined, m.label ?? m.id) as HTMLOptionElement;
        opt.value = `${entry.provider}/${m.id}`;
        group.append(opt);
      }
      if (!entry.models?.length) {
        const opt = el("option", undefined, `${entry.provider} (默认)`) as HTMLOptionElement;
        opt.value = entry.provider;
        group.append(opt);
      }
      els.provider.append(group);
    }
    if (stored.lastProvider) els.provider.value = String(stored.lastProvider);
  } catch (e) {
    els.newError.textContent = `获取 provider 失败：${errMsg(e)}`;
  }
}

async function createAgent(ev: SubmitEvent) {
  ev.preventDefault();
  if (!client) return;
  const submit = els.newView.querySelector<HTMLButtonElement>("button[type=submit]")!;
  submit.disabled = true;
  els.newError.textContent = "";
  try {
    const provider = els.provider.value;
    const cwd = els.cwd.value.trim();
    await chrome.storage.local.set({ lastCwd: cwd, lastProvider: provider });
    const handle = await client.agents.create({ config: { provider }, cwd, prompt: els.prompt.value });
    els.prompt.value = "";
    await openChat(handle.id);
  } catch (e) {
    els.newError.textContent = `创建失败：${errMsg(e)}`;
  } finally {
    submit.disabled = false;
  }
}

// ---------- chat ----------

function renderChatHeader(a: PaseoAgent) {
  els.chatTitle.textContent = agentName(a);
  statusBadge(els.chatStatus, a.status);
  renderPermissions(a.pendingPermissions ?? []);
}

function renderPermissions(perms: PermissionRequest[]) {
  els.permissions.replaceChildren();
  for (const p of perms) {
    const box = el("div", "permission");
    box.append(el("strong", undefined, p.title ?? p.name));
    if (p.description) box.append(el("div", undefined, p.description));
    if (p.input) box.append(el("pre", undefined, JSON.stringify(p.input, null, 2)));
    const row = el("div", "row");
    const respond = (behavior: "allow" | "deny") => async () => {
      if (!client || !currentAgentId) return;
      try {
        await client.agents.ref(currentAgentId).respondToPermission({
          requestId: p.id,
          response: behavior === "allow" ? { behavior } : { behavior, message: "Denied by user" },
        });
      } catch (e) {
        alert(errMsg(e));
      }
    };
    const allow = el("button", undefined, "允许");
    allow.onclick = respond("allow");
    const deny = el("button", "secondary", "拒绝");
    deny.onclick = respond("deny");
    row.append(allow, deny);
    box.append(row);
    els.permissions.append(box);
  }
}

function renderEntry(entry: TimelineEntry): HTMLElement {
  const item = entry.item as { type: string; [k: string]: unknown };
  switch (item.type) {
    case "user_message":
      return el("div", "item user", String(item.text));
    case "assistant_message":
      return el("div", "item assistant", String(item.text));
    case "reasoning":
      return el("div", "item reasoning", String(item.text));
    case "tool_call": {
      const status = String(item.status);
      return el("div", `item tool ${status}`, `🔧 ${item.name} · ${status}`);
    }
    case "error":
      return el("div", "item tool failed", `⚠ ${String(item.message ?? JSON.stringify(item))}`);
    default:
      return el("div", "item other", `[${item.type}] ${"text" in item ? String(item.text) : ""}`);
  }
}

async function refreshTimeline(agentId: string) {
  if (!client || currentAgentId !== agentId) return;
  const res = await client.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 200,
    projection: "projected",
  });
  if (currentAgentId !== agentId) return;
  if (res.agent) {
    agents.set(res.agent.id, res.agent);
    renderChatHeader(res.agent);
  }
  const atBottom =
    els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight < 40;
  els.timeline.replaceChildren(...res.entries.map(renderEntry));
  if (atBottom) els.timeline.scrollTop = els.timeline.scrollHeight;
}

async function openChat(agentId: string) {
  if (!client) return;
  closeChat?.();
  currentAgentId = agentId;
  show("chat");
  els.timeline.replaceChildren(el("div", "item other", "加载中…"));
  const a = agents.get(agentId);
  if (a) renderChatHeader(a);

  // Live events -> debounced refetch of the projected tail (simple & robust).
  let timer: number | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refreshTimeline(agentId).catch(console.error), 250);
  };
  const sub = client.agents.ref(agentId).timeline.subscribe(schedule);
  closeChat = () => {
    clearTimeout(timer);
    sub();
    currentAgentId = null;
    closeChat = null;
  };
  try {
    await sub.ready;
  } catch (e) {
    console.warn("timeline subscribe failed", e);
  }
  await refreshTimeline(agentId).catch((e) => {
    els.timeline.replaceChildren(el("div", "error", errMsg(e)));
  });
  els.timeline.scrollTop = els.timeline.scrollHeight;
  els.message.focus();
}

async function sendMessage(ev?: Event) {
  ev?.preventDefault();
  const text = els.message.value.trim();
  if (!client || !currentAgentId || !text) return;
  els.message.value = "";
  try {
    await client.agents.ref(currentAgentId).send(text);
  } catch (e) {
    els.message.value = text;
    alert(`发送失败：${errMsg(e)}`);
  }
}

// ---------- wiring ----------

els.connectBtn.onclick = () => void connect();
els.disconnectBtn.onclick = () => void disconnect();
els.refreshBtn.onclick = () => void loadAgents();
els.newBtn.onclick = () => void openNewAgent();
els.cancelNewBtn.onclick = () => show("list");
els.newView.onsubmit = (ev) => void createAgent(ev);
els.backBtn.onclick = () => {
  closeChat?.();
  show("list");
  renderAgents();
};
els.sendForm.onsubmit = (ev) => void sendMessage(ev);
els.message.onkeydown = (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) void sendMessage(ev);
};
els.password.onkeydown = els.url.onkeydown = (ev) => {
  if (ev.key === "Enter") void connect();
};

els.originHint.textContent = JSON.stringify(
  { daemon: { cors: { allowedOrigins: [location.origin] } } },
  null,
  2,
);

void chrome.storage.local.get(["url", "password"]).then((stored) => {
  els.url.value = String(stored.url ?? "");
  els.password.value = String(stored.password ?? "");
  if (stored.url) void connect();
});
