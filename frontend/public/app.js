// ── pi frontend app ──────────────────────────────────────────────────────────
// Single-user, flat independent-session interface for pi.
// Uses @chenglou/pretext via VChat for zero-DOM virtualized rendering + shrinkwrap.

const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
let ws;
let activeSessionId = null;

// Many providers don't assign an id field to messages, which causes collisions
// in the store (findIndex/find match on undefined) and in the DOM (msg-undefined).
// We assign a unique local id to the FIRST event for each logical message
// (message_start) and reuse it for subsequent message_update / message_end.
let _nextMsgId = 1;
function generateMsgId() {
  return `_local_${Date.now()}_${_nextMsgId++}`;
}

// Tracks the optimistic user message id so we can replace it when the real server message arrives
let pendingOptimisticId = null;

// sessionId → { id, name, model, isStreaming, messages, partialMessage, contentBlocks, toolCalls, queue }
const store = new Map();

// Active session metadata (for the header bar)
let currentSessionInfo = null; // { id, name, model, cwd }

// VirtualList instance for the active session
let vl = null;

// ── DOM refs ────────────────────────────────────────────────────────────────
const $tabs = document.getElementById("tabs");
const $messages = document.getElementById("messages");
const $promptInput = document.getElementById("prompt-input");
const $btnAbort = document.getElementById("btn-abort");
const $btnNewSession = document.getElementById("btn-new-session");
const $queueIndicator = document.getElementById("queue-indicator");
const $emptyState = document.getElementById("empty-state");
const $chatPanel = document.getElementById("chat-panel");
const $sessionFooter = document.getElementById("session-footer");
const $footerModel = document.getElementById("footer-model");
const $footerTokens = document.getElementById("footer-tokens");
const $footerCost = document.getElementById("footer-cost");
const $footerPercent = document.getElementById("footer-percent");
const $subagentIndicator = document.getElementById("subagent-indicator");

// Session header refs
const $sessionName = document.getElementById('session-name');
const $sessionIndicator = document.getElementById('session-indicator');
const $sessionModeBadge = document.getElementById('session-mode-badge');
const $btnTree = document.getElementById('btn-tree');

// Agent selector refs
var $agentSelector;
var $newSessionAgentType;

// Sidebar refs
const $sidebar = document.getElementById('sidebar');
const $sidebarSearch = document.getElementById('sidebar-search');
const $sidebarTree = document.getElementById('sidebar-tree');
const $sessionList = document.getElementById('sidebar-tree');
const $sidebarModelCount = document.getElementById('sidebar-model-count');
const $sidebarSessionCount = document.getElementById('sidebar-session-count');
const $sidebarTotalTokens = document.getElementById('sidebar-total-tokens');
const $btnSidebarCollapse = document.getElementById('btn-sidebar-collapse');

// New session dialog refs
const $newSessionOverlay = document.getElementById('new-session-overlay');
const $newSessionName = document.getElementById('new-session-name');
const $newSessionCwd = document.getElementById('new-session-cwd');
const $btnNewSessionCreate = document.getElementById('btn-new-session-create');
const $btnNewSessionCancel = document.getElementById('btn-new-session-cancel');
const $btnBrowseDirsNew = document.getElementById('btn-browse-dirs-new');
const $newSessionDirList = document.getElementById('new-session-dir-list');

// Dashboard refs
const $dashSessionCount = document.getElementById('dash-session-count');
const $dashTree = document.getElementById('dash-tree');
const $dashModelCount = document.getElementById('dash-model-count');
const $dashTotalTokens = document.getElementById('dash-total-tokens');
const $btnDashNewSession = document.getElementById('btn-dash-new-session');
const $btnDashModels = document.getElementById('btn-dash-models');

// ── Constants for measurement ───────────────────────────────────────────────
const BUBBLE_PAD = 28;      // 14px horizontal padding * 2
const BUBBLE_MIN_W = 60;    // minimum bubble width
const BUBBLE_MAX_RATIO = 0.78;

// ── Model context windows (tokens) ──────────────────────────────────────────
const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4': 32768,
  'gemini-2.0-flash': 1000000,
  'gemini-2.0-pro': 1000000,
  'command-a': 256000,
  'mistral-large': 128000,
  'deepseek-v4-pro': 128000,
  'deepseek-v4-flash': 128000,
  'deepseek-v4': 128000,
  'deepseek-v3': 128000,
  'deepseek-r1': 128000,
  'deepseek-chat': 128000,
};
/**
 * Get the model's context window size.
 * Uses the server-provided contextWindow first, falls back to a hardcoded table.
 * @param {string} modelId
 * @param {number} [serverProvided] - contextWindow from server's model info
 */
function getContextWindow(modelId, serverProvided) {
  if (serverProvided > 0) return serverProvided;
  if (!modelId) return 0;
  // Try exact match first, then check if modelId contains a known key
  if (MODEL_CONTEXT_WINDOWS[modelId]) return MODEL_CONTEXT_WINDOWS[modelId];
  const lower = modelId.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return val;
  }
  return 0;
}

// ── Dashboard tracking ──────────────────────────────────────────────────────
let _lastTreeData = null;
let _lastModelCount = 0;
const _dashServices = {};

// ── VirtualList + Stream area setup ─────────────────────────────────────────

function ensureVL() {
  if (vl && vl.container === $messages) return vl;
  if (!window.VChat) {
    console.warn("VChat not loaded — falling back to direct rendering");
    return null;
  }

  // Destroy old VL if container changed
  if (vl) {
    vl.destroy();
    vl = null;
  }

  vl = new window.VChat.VirtualList($messages, {
    renderItem: (item, index) => renderMessageItem(item, index),
    bufferPx: 500,
    padLeft: 24,   // match #messages horizontal padding
    padRight: 24,
  });

  return vl;
}

function destroyVL() {
  if (vl) {
    vl.destroy();
    vl = null;
  }
  const spacer = document.getElementById("vl-spacer");
  if (spacer) spacer.remove();
}

// ── Render a single message item (called by VirtualList) ────────────────────

function renderMessageItem(item, index) {
  if (item.role === "user") {
    return createUserBubbleEl(item, index);
  } else if (item.role === "toolResult") {
    // Tool results fold into the owning tool block; never render as a bubble.
    return null;
  } else if (item.role === "system") {
    // System messages (compaction notices) — small, italic, inline
    const el = document.createElement("div");
    el.className = "msg system vl-item";
    const content = document.createElement("div");
    content.className = "msg-content";
    content.style.cssText = "font-size:11px;color:var(--text-faint);font-style:italic;padding:8px 14px;";
    content.textContent = typeof item.content === "string" ? item.content : "";
    el.appendChild(content);
    return el;
  } else {
    return createAssistantMsgEl(item, store.get(activeSessionId));
  }
}

// ── Create user message element with shrinkwrap ─────────────────────────────

function createUserBubbleEl(msg, index) {
  // Content can be string or array of content blocks
  let content = "";
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content.map(c => c.text || c.content || "").join(" ").trim();
  }

  const el = document.createElement("div");
  el.className = "msg user vl-item";
  el.id = `msg-${msg.id || "u-" + (index != null ? index : Date.now())}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-content";
  bubble.textContent = content;

  el.appendChild(bubble);
  return el;
}

// ── Create assistant message element ────────────────────────────────────────

function createAssistantMsgEl(msg, s) {
  const el = document.createElement("div");
  el.className = "msg assistant vl-item";
  el.id = `msg-${msg.id || "a-" + Date.now()}`;

  const wrapper = document.createElement("div");
  wrapper.className = "msg-content";

  // Normalize content
  let content;
  if (Array.isArray(msg.content)) {
    content = msg.content;
  } else if (typeof msg.content === "string") {
    content = [{ type: "text", text: msg.content }];
  } else {
    content = [];
  }

  for (const block of content) {
    if (block.type === "text") {
      const text = block.text || "";
      if (text.trim()) {
        const div = document.createElement("div");
        div.className = "msg-text";
        div.innerHTML = renderMarkdown(text);
        wrapper.appendChild(div);
      }
    } else if (block.type === "thinking") {
      const thinkText = block.thinking || block.text || "";
      if (thinkText.trim()) {
        wrapper.appendChild(createThinkBlock(block._contentIndex || Math.random(), thinkText, true));
      }
    } else if (block.type === "toolCall") {
      // Render a full, persistent tool block (header + args + status + output)
      // attached to this assistant message. Tool execution events update it
      // in place via updateToolBlock(); tool results fold in on message_end.
      const base = { id: block.id, name: block.name, arguments: block.arguments };
      const stored = s && s.toolCalls ? s.toolCalls[block.id] : null;
      const tc = stored
        ? Object.assign({ status: stored.status || "running", output: stored.output || "", images: stored.images || [] }, base)
        : Object.assign({ status: "running", output: "", images: [] }, base);
      wrapper.appendChild(createToolBlock(block.id, tc));
    }
  }

  el.appendChild(wrapper);
  return el;
}

// ── Update streaming content in an already-rendered VL item ───────────────
// Instead of rendering to a separate #stream-area and then moving to the VL,
// we update the last assistant message's VL item DOM directly. This eliminates
// the 60ms race and the orphan tool-block problem entirely.

function updateStreamingContentInVL(s, idx) {
  if (!vl) return;
  const vlItem = vl.getRendered(idx);
  if (!vlItem) {
    // Item not in viewport — it'll render fresh when scrolled into view
    return;
  }

  let msgContent = vlItem.querySelector(".msg-content");
  if (!msgContent) {
    // Shouldn't happen if the item rendered, but guard anyway
    msgContent = document.createElement("div");
    msgContent.className = "msg-content";
    vlItem.appendChild(msgContent);
  }

  const blocks = s.contentBlocks || {};

  // Collect existing child elements by type
  const existingTexts = Array.from(msgContent.querySelectorAll(".msg-text"));
  const existingThinks = Array.from(msgContent.querySelectorAll(".think-block"));
  let tIdx = 0, thIdx = 0;

  for (const [ci, block] of Object.entries(blocks)) {
    const cIdx = parseInt(ci);
    if (block.type === "text") {
      if (tIdx < existingTexts.length) {
        existingTexts[tIdx].innerHTML = renderMarkdown(block.text || "");
      } else {
        const div = document.createElement("div");
        div.className = "msg-text streaming-cursor";
        div.innerHTML = renderMarkdown(block.text || "");
        msgContent.appendChild(div);
      }
      tIdx++;
    } else if (block.type === "thinking") {
      if (thIdx < existingThinks.length) {
        const body = existingThinks[thIdx].querySelector(".think-body");
        if (body) body.textContent = block.text || "";
      } else {
        msgContent.appendChild(createThinkBlock(cIdx, block.text || "", false));
      }
      thIdx++;
    }
  }

  // Ensure the last text block has the streaming cursor
  const allTextDivs = msgContent.querySelectorAll(".msg-text");
  allTextDivs.forEach(d => d.classList.remove("streaming-cursor"));
  if (allTextDivs.length > 0) {
    allTextDivs[allTextDivs.length - 1].classList.add("streaming-cursor");
  }

  // Tell VL to re-measure the item's height (content grew)
  vl.invalidateHeight(idx);
}

// ── Session state factory ───────────────────────────────────────────────────

function newSessionState(s) {
  return {
    id: s.id,
    name: s.name || "Session",
    model: s.model || null,
    isStreaming: s.isStreaming ?? false,
    messages: [],
    partialMessage: null,
    contentBlocks: {},
    toolCalls: {},
    subagentCalls: {},
    queue: { steering: [], followUp: [] },
    tree: null,
    usage: null,
    totalUsage: { input: 0, output: 0, cost: 0 },
    _streamingMsgId: null,
    _streamingMsgIndex: null,
  };
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected to pi server");
    send({ type: "list_sessions" });
    send({ type: "get_models" });
    $promptInput.disabled = false;
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    handleServerMessage(data);
  };

  ws.onclose = () => {
    console.log("Disconnected — reconnecting in 2s");
    setTimeout(connect, 2000);
  };

  ws.onerror = (e) => console.error("WebSocket error:", e);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Server message router ───────────────────────────────────────────────────

function handleServerMessage(data) {
  switch (data.type) {
    case 'session_switched':
      onSessionSwitched(data);
      break;
    case 'session_event':
      onSessionEvent(data.sessionId, data.event);
      break;
    case 'sessions_list':
      _lastTreeData = data.sessions;
      _dashServices['session-index'] = true;
      updateDashboard();
      renderSessionList(data.sessions);
      // Update session count in sidebar status
      if ($sidebarSessionCount) {
        var count = (data.sessions || []).length;
        $sidebarSessionCount.textContent = count + ' session' + (count !== 1 ? 's' : '');
      }
      break;
    case 'models_list':
      if (Array.isArray(data.models)) {
        _lastModelCount = data.models.length;
        if ($sidebarModelCount) {
          $sidebarModelCount.textContent = data.models.length + ' model' + (data.models.length !== 1 ? 's' : '');
        }
      }
      updateDashboard();
      break;
    case 'token_estimate': {
      const ts = store.get(data.sessionId);
      if (ts) {
        ts.estimatedTokens = data.tokens;
        if (data.sessionId === activeSessionId) updateFooter();
      }
      updateSidebarTokens();
      _dashServices['token-tracker'] = true;
      updateDashboard();
      break;
    }
    case 'session_history':
      onSessionHistory(data.sessionId, data.messages, data.toolCalls, data.usage);
      break;
    case 'tree_data':
      // Legacy — still forward to old tree panel if visible but we can ignore
      break;
    case 'dirs_list':
      // If the new session dialog is open, populate its dir browser
      if ($newSessionOverlay && !$newSessionOverlay.classList.contains('hidden')) {
        showNewSessionDirs(data.path, data.dirs || [], data.error);
      }
      break;
    case 'agent_type_changed':
      if (data.sessionId === (currentSessionInfo && currentSessionInfo.id)) {
        currentSessionInfo.agentType = data.agentType;
        if ($agentSelector) $agentSelector.value = data.agentType;
        updateSessionHeader();
      }
      break;
    case 'error':
      console.error('Server error:', data.message);
      // Re-enable agent selector on error
      if ($agentSelector) {
        $agentSelector.classList.remove('loading');
        $agentSelector.disabled = false;
        // Revert to previous value
        if ($agentSelector.dataset.previousValue) {
          $agentSelector.value = $agentSelector.dataset.previousValue;
        }
      }
      break;
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

function onSessionSwitched(data) {
  const { sessionId, history, toolCalls, usage, name, model, cwd } = data;

  activeSessionId = sessionId;
  currentSessionInfo = { id: sessionId, name, model, cwd, agentType: data.agentType || 'manager' };

  // Ensure session exists in store
  let s = store.get(sessionId);
  if (!s) {
    s = newSessionState({ id: sessionId, name, model });
    store.set(sessionId, s);
  }
  s.name = name || s.name;
  s.model = model || s.model;

  // Load history if first load
  if (s.messages.length === 0 && history) {
    s.messages = Array.isArray(history) ? history : [];
    s.toolCalls = toolCalls || {};
    if (usage) {
      s.usage = usage;
      s.lastContextTokens = usage.totalTokens || 0;
      s.totalUsage = {
        input: usage.input || 0,
        output: usage.output || 0,
        cost: usage.cost?.total || 0,
      };
    }
  }

  // Update UI
  if ($agentSelector && data.agentType) {
    $agentSelector.value = data.agentType;
    $agentSelector.dataset.previousValue = data.agentType;
  }
  // Re-enable agent selector after switch
  if ($agentSelector) {
    $agentSelector.classList.remove('loading');
    $agentSelector.disabled = false;
  }
  updateSessionHeader();
  renderFullChat(sessionId);
  updateFooter();
  $promptInput.disabled = false;
  $promptInput.focus();
  $btnAbort.classList.toggle('hidden', !s.isStreaming);
  renderQueue(s);
  renderSubagentIndicator(s);
  updateEmptyState();

  // Highlight active node in sidebar tree
  if (window.TreeView && typeof window.TreeView.highlightActive === 'function') {
    window.TreeView.highlightActive(sessionId);
  }
}

function updateSessionHeader() {
  if (!currentSessionInfo) {
    if ($sessionName) $sessionName.textContent = '(no session)';
    if ($sessionModeBadge) { $sessionModeBadge.style.display = 'none'; }
    if ($sessionIndicator) $sessionIndicator.className = '';
    if ($agentSelector) $agentSelector.value = 'manager';
    return;
  }

  if ($sessionName) $sessionName.textContent = currentSessionInfo.name || (currentSessionInfo.id ? currentSessionInfo.id.slice(0, 8) : '');
  if ($sessionModeBadge) { $sessionModeBadge.style.display = 'none'; }
  if ($agentSelector && currentSessionInfo.agentType) {
    $agentSelector.value = currentSessionInfo.agentType;
  }

  const s = store.get(activeSessionId);
  if ($sessionIndicator) $sessionIndicator.className = s && s.isStreaming ? 'streaming' : '';
}

function onSessionRenamed(sessionId, name) {
  const s = store.get(sessionId);
  if (s) { s.name = name; updateFooter(); }
  if (currentSessionInfo && currentSessionInfo.id === sessionId) {
    currentSessionInfo.name = name;
    updateSessionHeader();
  }
}

// ── New session dialog ───────────────────────────────────────────────────

function openNewSessionDialog() {
  if ($newSessionCwd && currentSessionInfo && currentSessionInfo.cwd) {
    $newSessionCwd.value = currentSessionInfo.cwd;
  }
  if ($newSessionAgentType) {
    $newSessionAgentType.value = currentSessionInfo && currentSessionInfo.agentType || 'manager';
  }
  $newSessionOverlay.classList.remove('hidden');
  $newSessionName.focus();
}

function closeNewSessionDialog() {
  $newSessionOverlay.classList.add('hidden');
  $newSessionName.value = '';
}

function submitNewSession() {
  var name = $newSessionName.value.trim() || undefined;
  var cwd = $newSessionCwd.value.trim() || undefined;
  var agentType = $newSessionAgentType ? $newSessionAgentType.value : 'manager';
  send({ type: 'new_session', name: name, cwd: cwd, agentType: agentType });
  closeNewSessionDialog();
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function toggleSidebar() {
  if (!$sidebar) return;
  $sidebar.classList.toggle('collapsed');
}

function countTreeNodes(tree) {
  if (!tree || !Array.isArray(tree)) return 0;
  var n = 0;
  function walk(node) {
    n++;
    if (node.children && Array.isArray(node.children)) {
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }
  for (var i = 0; i < tree.length; i++) walk(tree[i]);
  return n;
}

function updateSidebarTokens() {
  if (!$sidebarTotalTokens) return;
  var total = 0;
  store.forEach(function(s) {
    total += s.estimatedTokens || 0;
  });
  if (total >= 1000) {
    $sidebarTotalTokens.textContent = (total / 1000).toFixed(1) + 'k tokens';
  } else {
    $sidebarTotalTokens.textContent = total + ' tokens';
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

function switchToSession(sessionId) {
  send({ type: 'switch_session', sessionId });
}

function abortSession() {
  if (!activeSessionId) return;
  send({ type: "abort", sessionId: activeSessionId });
}

// ── Chat rendering (VirtualList-based) ──────────────────────────────────────

function renderFullChat(sessionId) {
  const s = store.get(sessionId);
  if (!s) { renderEmptyChat(); return; }

  if (!window.VChat) {
    renderFullChatFallback(s);
    return;
  }

  // Ensure VirtualList is set up (no innerHTML clearing!)
  const vv = ensureVL();
  if (!vv) { renderFullChatFallback(s); return; }

  // Purge any orphan children from previous sessions (banners, stray tool blocks)
  // that are NOT tracked by the VirtualList. Only #vl-spacer and .vl-item survive.
  $messages.querySelectorAll(":scope > :not(#vl-spacer):not(.vl-item)").forEach(el => el.remove());

  // Set items — VirtualList handles the rest
  vv.setItems(s.messages);
  scrollToBottom();
}

// ── Fallback: direct DOM rendering (when VChat isn't available) ────────────

function renderFullChatFallback(s) {
  $messages.innerHTML = "";
  const renderedToolCalls = new Set();

  for (const msg of s.messages) {
    if (msg.role === "user") {
      appendUserBubble(typeof msg.content === "string" ? msg.content : "");
    } else if (msg.role === "assistant") {
      appendAssistantMessage(msg, s, renderedToolCalls);
    } else if (msg.role === "system") {
      const banner = document.createElement("div");
      banner.className = "msg system";
      const content = document.createElement("div");
      content.className = "msg-content";
      content.style.cssText = "font-size:11px;color:var(--text-faint);font-style:italic;padding:8px 14px;";
      content.textContent = typeof msg.content === "string" ? msg.content : "";
      banner.appendChild(content);
      $messages.appendChild(banner);
    }
  }

  for (const [tcId, tc] of Object.entries(s.toolCalls)) {
    if (!renderedToolCalls.has(tcId)) {
      const el = createToolBlock(tcId, tc);
      $messages.appendChild(el);
      tc.el = el;
      renderedToolCalls.add(tcId);
    }
  }

  if (s.partialMessage) {
    const partialEl = createPartialEl();
    $messages.appendChild(partialEl);
    updatePartialEl(s);
  }

  scrollToBottom();
}

// ── Fallback functions (direct DOM, used when VChat unavailable) ────────────

function createPartialEl() {
  const el = document.createElement("div");
  el.id = "msg-partial";
  el.className = "msg assistant";
  const wrapper = document.createElement("div");
  wrapper.className = "msg-content";
  el.appendChild(wrapper);
  return el;
}

function updatePartialEl(s) {
  let el = document.getElementById("msg-partial");
  if (!el) {
    el = createPartialEl();
    $messages.appendChild(el);
  }
  const wrapper = el.querySelector(".msg-content");
  wrapper.innerHTML = "";

  for (const [ci, block] of Object.entries(s.contentBlocks || {})) {
    if (block.type === "text") {
      const div = document.createElement("div");
      div.className = "msg-text streaming-cursor";
      div.innerHTML = renderMarkdown(block.text || "");
      wrapper.appendChild(div);
    } else if (block.type === "thinking") {
      wrapper.appendChild(createThinkBlock(parseInt(ci), block.text || "", false));
    }
  }
}

function appendUserBubble(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "msg-content";
  bubble.textContent = text;
  el.appendChild(bubble);
  $messages.appendChild(el);
  scrollToBottom();
}

function appendAssistantMessage(message, s, renderedToolCalls) {
  if (document.getElementById(`msg-${message.id}`)) return null;

  const el = document.createElement("div");
  el.id = `msg-${message.id}`;
  el.className = "msg assistant";
  const wrapper = document.createElement("div");
  wrapper.className = "msg-content";

  let content;
  if (Array.isArray(message.content)) {
    content = message.content;
  } else if (typeof message.content === "string") {
    content = [{ type: "text", text: message.content }];
  } else {
    content = [];
  }

  let hasVisibleContent = false;

  for (const block of content) {
    if (block.type === "text") {
      const text = block.text || "";
      const html = renderMarkdown(text);
      if (text.trim()) hasVisibleContent = true;
      const div = document.createElement("div");
      div.className = "msg-text";
      div.innerHTML = html;
      wrapper.appendChild(div);
    } else if (block.type === "thinking") {
      const thinkText = block.thinking || block.text || "";
      if (thinkText.trim()) hasVisibleContent = true;
      wrapper.appendChild(createThinkBlock(block._contentIndex || Math.random(), thinkText, true));
    } else if (block.type === "toolCall") {
      hasVisibleContent = true;
      const base = { id: block.id, name: block.name, arguments: block.arguments };
      const stored = s.toolCalls?.[block.id];
      const tc = stored
        ? Object.assign({ status: stored.status || "running", output: stored.output || "" }, base)
        : Object.assign({ status: "running", output: "" }, base);
      const tb = createToolBlock(block.id, tc);
      wrapper.appendChild(tb);
      renderedToolCalls?.add(block.id);
    }
  }

  if (!hasVisibleContent) return null;

  el.appendChild(wrapper);
  $messages.appendChild(el);
  return el;
}

// ── Thinking blocks ─────────────────────────────────────────────────────────

// Tell the VL that the item containing `el` changed height (e.g. a think/tool
// block was expanded/collapsed) so it re-measures and repositions everything
// below. Without this, expanding overlaps the following messages.
function invalidateVLItemFromEl(el) {
  if (!vl) return;
  const item = el.closest(".vl-item");
  if (!item) return;
  const itemMsgId = item.id && item.id.startsWith("msg-") ? item.id.slice(4) : null;
  if (!itemMsgId || !Array.isArray(vl.items)) return;
  const idx = vl.items.findIndex(m => m && String(m.id) === itemMsgId);
  if (idx >= 0) vl.invalidateHeight(idx);
}

function createThinkBlock(index, text, collapsed) {
  const block = document.createElement("div");
  block.className = `think-block${collapsed ? "" : " open"}`;
  block.innerHTML = `
    <div class="think-header">
      <span class="think-caret">▶</span>
      <span>Thinking</span>
    </div>
    <div class="think-body">${escHtml(text || "")}</div>
  `;
  block.querySelector(".think-header").addEventListener("click", () => {
    block.classList.toggle("open");
    invalidateVLItemFromEl(block);
  });
  return block;
}

// ── Tool blocks ─────────────────────────────────────────────────────────────

const TOOL_ICONS = { bash: "›_", read: "📄", write: "✎", edit: "✂", grep: "⌕", find: "🔍", ls: "📂", subagent: "⚡", agent_browser: "🌐" };

// Extract screenshot/image content blocks from a tool result's content array.
// agent_browser screenshot calls return { type:"image", data: base64, mimeType } blocks.
function extractToolImages(result) {
  const content = result && Array.isArray(result.content) ? result.content : null;
  if (!content) return [];
  const imgs = [];
  for (const block of content) {
    if (block && block.type === "image" && block.data && block.mimeType) {
      imgs.push({ dataUrl: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType });
    }
  }
  return imgs;
}

// Render screenshot <img> elements into a tool body. Clears any previous images.
function renderToolImages(bodyEl, images) {
  if (!bodyEl) return;
  const existing = bodyEl.querySelector(".tool-screenshots");
  if (existing) existing.remove();
  if (!images || images.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "tool-screenshots";
  for (const img of images) {
    const el = document.createElement("img");
    el.className = "tool-screenshot";
    el.src = img.dataUrl;
    el.alt = "agent-browser screenshot";
    el.loading = "lazy";
    wrap.appendChild(el);
  }
  bodyEl.appendChild(wrap);
}

// Extract human-readable info from a subagent tool call's args.
// Returns null if args don't describe a real subagent invocation.
function getSubagentInfo(tc) {
  const args = tc.arguments != null ? tc.arguments : tc.args;
  if (!args || typeof args !== "object") return null;

  const scope = args.agentScope || "user";
  let mode = null;
  let agents = [];
  let preview = "";

  if (Array.isArray(args.chain) && args.chain.length > 0) {
    mode = "chain";
    agents = args.chain.map(s => s.agent || "?");
    preview = (args.chain[0]?.task || "").replace(/\{previous\}/g, "").trim();
  } else if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    mode = "parallel";
    agents = args.tasks.map(t => t.agent || "?");
    preview = args.tasks[0]?.task || "";
  } else if (args.agent && args.task) {
    mode = "single";
    agents = [args.agent];
    preview = args.task || "";
  }

  if (!mode) return null;
  if (preview.length > 60) preview = preview.slice(0, 60) + "…";

  return { mode, agents, preview, scope };
}

function subagentLabel(info) {
  if (info.mode === "parallel") {
    return `${info.agents.length} parallel · ${info.agents.join(", ")}`;
  } else if (info.mode === "chain") {
    return info.agents.join(" → ");
  }
  return info.agents.join(", ");
}

function createToolBlock(toolCallId, tc) {
  const block = document.createElement("div");
  block.className = "tool-block";
  block.id = `tool-${toolCallId}`;

  const icon = TOOL_ICONS[tc.name] || "⚙";
  const args = tc.arguments != null ? tc.arguments : tc.args;

  // Render subagent calls with a human-readable label + task preview
  let displayName = tc.name;
  let argsStr = args ? JSON.stringify(args).replace(/"/g, "").substring(0, 80) : "";
  if (tc.name === "subagent") {
    const info = getSubagentInfo(tc);
    if (info) {
      block.classList.add("tool-subagent");
      displayName = `subagent → ${subagentLabel(info)}`;
      argsStr = info.preview ? `${info.mode} · ${info.preview}` : info.mode;
    }
  }

  block.innerHTML = `
    <div class="tool-header">
      <span class="tool-caret">▶</span>
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${escHtml(displayName)}</span>
      <span class="tool-args">${escHtml(argsStr)}</span>
      <span class="tool-status ${tc.status || "running"}">${tc.status === "done" ? "✓" : tc.status === "error" ? "✗" : "…"}</span>
    </div>
    <div class="tool-body${tc.status === "running" ? " streaming" : ""}">${escHtml(tc.output || "")}</div>
  `;

  // Embed screenshots (e.g. agent_browser captures) so they appear when open.
  renderToolImages(block.querySelector(".tool-body"), tc.images);

  block.querySelector(".tool-header").addEventListener("click", () => {
    block.classList.toggle("open");
    invalidateVLItemFromEl(block);
  });

  return block;
}

function updateToolBlock(toolCallId, tc) {
  // Update every matching tool block (there can briefly be two: the transient
  // streaming element in #stream-area and the committed one inside the VL
  // assistant message). querySelectorAll avoids missing the committed block.
  const blocks = document.querySelectorAll(`#tool-${toolCallId}`);
  if (!blocks.length) return;
  for (const block of blocks) {
    const statusEl = block.querySelector(".tool-status");
    if (statusEl) {
      statusEl.textContent = tc.status === "done" ? "✓" : tc.status === "error" ? "✗" : "…";
      statusEl.className = `tool-status ${tc.status}`;
    }
    const bodyEl = block.querySelector(".tool-body");
    if (bodyEl) {
      bodyEl.textContent = tc.output || "";
      bodyEl.className = `tool-body${tc.status === "running" ? " streaming" : ""}`;
      renderToolImages(bodyEl, tc.images);
    }
  }
}

// ── Queue ───────────────────────────────────────────────────────────────────

function renderQueue(s) {
  $queueIndicator.innerHTML = "";
  const all = [
    ...(s.queue.steering || []).map(m => ({ type: "steer", label: "⟳", msg: m })),
    ...(s.queue.followUp || []).map(m => ({ type: "followUp", label: "→", msg: m })),
  ];

  for (const item of all) {
    const badge = document.createElement("span");
    badge.className = "queue-badge";
    badge.innerHTML = `${item.label} ${escHtml(item.msg.substring(0, 40))}${item.msg.length > 40 ? "…" : ""}`;
    $queueIndicator.appendChild(badge);
  }
}

// ── Subagent indicator ─────────────────────────────────────────────────────
// Banner shown at the top of the chat panel while subagent tool calls are
// running. Tracks s.subagentCalls (toolCallId → info) and re-renders on
// any start/end event for the active session.
function renderSubagentIndicator(s) {
  if (!s || s.id !== activeSessionId) {
    if ($subagentIndicator) $subagentIndicator.classList.add("hidden");
    return;
  }

  const calls = Object.entries(s.subagentCalls || {})
    .filter(([, info]) => info.status === "running")
    .map(([, info]) => info);

  if (!$subagentIndicator) return;
  if (calls.length === 0) {
    $subagentIndicator.classList.add("hidden");
    $subagentIndicator.innerHTML = "";
    return;
  }

  $subagentIndicator.classList.remove("hidden");
  $subagentIndicator.innerHTML = "";

  for (const info of calls) {
    const row = document.createElement("div");
    row.className = "subagent-row";
    row.innerHTML =
      `<span class="subagent-spinner">⚡</span>` +
      `<span class="subagent-text">` +
      `Calling subagent <b>${escHtml(subagentLabel(info))}</b>` +
      (info.mode ? ` <span class="subagent-mode">${escHtml(info.mode)}</span>` : "") +
      `</span>` +
      (info.preview ? `<span class="subagent-preview">${escHtml(info.preview)}</span>` : "");
    $subagentIndicator.appendChild(row);
  }
}

// ── Footer ──────────────────────────────────────────────────────────────────

function updateFooter() {
  const s = store.get(activeSessionId);
  if (!s || !s.model) {
    $sessionFooter.classList.add("hidden");
    return;
  }
  $sessionFooter.classList.remove("hidden");
  $footerModel.textContent = s.model.name || s.model.id || "";

  // Accumulated totals (input + output across all turns)
  const totalUsage = s.totalUsage;
  let accInput = 0, accOutput = 0, cost = 0;
  if (totalUsage) {
    accInput = totalUsage.input || 0;
    accOutput = totalUsage.output || 0;
    cost = totalUsage.cost || 0;
  }

  // Token display with breakdown
  if (accInput > 0 || accOutput > 0) {
    const inK = (accInput / 1000).toFixed(1);
    const outK = (accOutput / 1000).toFixed(1);
    const totalK = ((accInput + accOutput) / 1000).toFixed(1);
    $footerTokens.innerHTML = `
      <span class="breakdown">
        <span title="Input tokens">↓${inK}k</span>
        <span title="Output tokens">↑${outK}k</span>
        <span title="Total">${totalK}k</span>
      </span>`;
  } else if (s.estimatedTokens > 0) {
    const totalK = (s.estimatedTokens / 1000).toFixed(1);
    $footerTokens.innerHTML = `<span class="breakdown"><span title="Estimated session tokens">~${totalK}k</span></span>`;
  } else {
    $footerTokens.textContent = "";
  }

  // Context window percentage — uses last message's totalTokens (actual context sent)
  const lastCtx = s.lastContextTokens || s.estimatedTokens || 0;
  const modelId = s.model.id || "";
  const contextWindow = getContextWindow(modelId, s.model.contextWindow);
  if (contextWindow > 0 && lastCtx > 0) {
    const pct = Math.min(100, Math.round((lastCtx / contextWindow) * 100));
    $footerPercent.innerHTML = `
      <span title="Context: ${(lastCtx / 1000).toFixed(0)}k / ${(contextWindow / 1000).toFixed(0)}k tokens">
        <span class="progress-bar"><span class="fill" style="width:${pct}%"></span></span>
        <span class="footer-detail">${pct}%</span>
      </span>`;
  } else {
    $footerPercent.textContent = "";
  }

  // Cost
  $footerCost.textContent = cost > 0 ? `$${cost.toFixed(4)}` : "";
}

// ── Session events ──────────────────────────────────────────────────────────

function onSessionEvent(sessionId, event) {
  const s = store.get(sessionId);
  if (!s) return;
  const isActive = sessionId === activeSessionId;

  switch (event.type) {

    // ── Agent ─────────────────────────────────────────────────────────
    case "agent_start":
      s.isStreaming = true;
      if (isActive) {
        $btnAbort.classList.remove("hidden");
        updateSessionHeader();
      }
      break;

    case "agent_end":
    case "agent_settled":
      s.isStreaming = false;
      s.partialMessage = null;
      s.contentBlocks = {};
      s._streamingMsgId = null;
      s._streamingMsgIndex = null;
      if (isActive) {
        $btnAbort.classList.add("hidden");
        // Remove streaming cursor from rendered VL items
        document.querySelectorAll(".streaming-cursor").forEach(c => c.classList.remove("streaming-cursor"));
        // Mark all running tools as done
        for (const [, tc] of Object.entries(s.toolCalls)) {
          if (tc.status === "running") {
            tc.status = "done";
            updateToolBlock(tc.id, tc);
          }
        }
        updateFooter();
        updateSessionHeader();
      }
      // Clear any lingering subagent indicators once the agent settles
      s.subagentCalls = {};
      if (isActive) renderSubagentIndicator(s);
      break;

    // ── Turn ──────────────────────────────────────────────────────────
    case "turn_end":
      if (event.toolResults) {
        for (const tr of event.toolResults) {
          const tc = s.toolCalls[tr.toolCallId];
          if (tc) {
            tc.status = tr.isError ? "error" : "done";
            tc.output = tr.content?.map(c => c.text || "").join("") || "";
            if (s.subagentCalls[tr.toolCallId]) {
              s.subagentCalls[tr.toolCallId].status = tr.isError ? "error" : "done";
              if (isActive) renderSubagentIndicator(s);
            }
            if (isActive) updateToolBlock(tr.toolCallId, tc);
          }
        }
      }
      break;

    // ── Messages ──────────────────────────────────────────────────────
    case "message_start":
      if (!event.message.id) event.message.id = generateMsgId();
      if (event.message.role === "toolResult") {
        break;
      }
      s._streamingMsgId = event.message.id;

      if (event.message.role === "assistant") {
        // Track index of streaming assistant message for in-place VL updates
        s._streamingMsgIndex = s.messages.length;
      }

      if (event.message.role === "user" && pendingOptimisticId) {
        const idx = s.messages.findIndex(m => m.id === pendingOptimisticId);
        if (idx >= 0) {
          s.messages[idx] = event.message;
          if (vl && isActive) vl.markDirty(idx);
        } else {
          s.messages.push(event.message);
          if (vl && isActive) {
            vl.syncItems(s.messages);
            vl.scrollToBottom();
          }
        }
        pendingOptimisticId = null;
      } else if (!s.messages.find(m => m.id === event.message.id)) {
        s.messages.push(event.message);
        if (isActive && event.message.role === "user") {
          if (vl) {
            vl.syncItems(s.messages);
            vl.scrollToBottom();
          } else {
            const content = typeof event.message.content === "string"
              ? event.message.content
              : (Array.isArray(event.message.content) ? event.message.content.map(c => c.text || "").join("") : "");
            appendUserBubble(content);
          }
        } else if (isActive && event.message.role === "assistant" && vl) {
          // Sync VL so the new assistant item is ready for in-place streaming updates
          vl.syncItems(s.messages);
        }
      }
      break;

    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (!delta) break;

      if (!event.message.id && s._streamingMsgId) event.message.id = s._streamingMsgId;

      const mIdx = s.messages.findIndex(m => m.id === event.message.id);
      if (mIdx >= 0) s.messages[mIdx] = event.message;
      else if (event.message.role === "assistant") s.messages.push(event.message);

      // Track the index of the streaming assistant message
      if (event.message.role === "assistant") {
        s._streamingMsgIndex = mIdx >= 0 ? mIdx : s.messages.length - 1;
      }

      if (!isActive) break;

      // Track content blocks and stream into the VL item directly
      if (delta.type === "text_start" || delta.type === "thinking_start") {
        s.contentBlocks[delta.contentIndex] = {
          type: delta.type === "text_start" ? "text" : "thinking",
          text: "",
        };
        s.partialMessage = event.message;
        if (!window.VChat) updatePartialEl(s);
      } else if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        const block = s.contentBlocks[delta.contentIndex];
        if (block) {
          block.text += delta.delta || "";
        } else {
          s.contentBlocks[delta.contentIndex] = {
            type: delta.type === "text_delta" ? "text" : "thinking",
            text: delta.delta || "",
          };
        }
        s.partialMessage = event.message;
        // Update the VL item in-place (no #stream-area)
        if (window.VChat) {
          if (s._streamingMsgIndex != null) {
            updateStreamingContentInVL(s, s._streamingMsgIndex);
          }
        } else {
          updatePartialEl(s);
        }
      } else if (delta.type === "text_end" || delta.type === "thinking_end") {
        const block = s.contentBlocks[delta.contentIndex];
        if (block) block.text = delta.content || block.text;
        s.partialMessage = event.message;
        if (window.VChat) {
          if (s._streamingMsgIndex != null) {
            updateStreamingContentInVL(s, s._streamingMsgIndex);
          }
        } else {
          updatePartialEl(s);
        }
      }
      scrollToBottom();
      break;
    }

    case "message_end": {
      if (!event.message) {
        console.warn("message_end: missing event.message");
        break;
      }

      if (!event.message.id && s._streamingMsgId) event.message.id = s._streamingMsgId;

      // Tool results fold into the owning tool block, not the chat transcript
      if (event.message.role === "toolResult") {
        const tcId = event.message.toolCallId;
        let tc = s.toolCalls[tcId];
        if (!tc) tc = s.toolCalls[tcId] = { id: tcId, status: "running", output: "" };
        tc.status = event.message.isError ? "error" : "done";
        const txt = (event.message.content || []).map(c => c.text || c.content || "").join("");
        if (txt) tc.output = txt;
        const finalImgs = extractToolImages(event.message);
        if (finalImgs.length) tc.images = finalImgs;
        if (!isActive) break;
        if (vl) {
          const idx = s.messages.findIndex(m =>
            Array.isArray(m.content) && m.content.some(b => b.type === "toolCall" && b.id === tcId));
          if (idx >= 0) vl.markDirty(idx);
        } else {
          updateToolBlock(tcId, tc);
        }
        break;
      }

      {
        const mIdx = s.messages.findIndex(m => m.id === event.message.id);
        if (mIdx >= 0) s.messages[mIdx] = event.message;
        else if (event.message.role === "assistant") s.messages.push(event.message);
      }

      if (event.message.role === "assistant" && isActive) {
        const streamingBlocks = { ...s.contentBlocks };

        if (event.message.usage) {
          s.usage = event.message.usage;
          // Track the total context size for this turn (includes cache reads)
          s.lastContextTokens = event.message.usage.totalTokens || 0;
          // Accumulate per-turn input/output/cost
          if (!s.totalUsage) s.totalUsage = { input: 0, output: 0, cost: 0 };
          s.totalUsage.input += event.message.usage.input || 0;
          s.totalUsage.output += event.message.usage.output || 0;
          if (event.message.usage.cost?.total) {
            s.totalUsage.cost += event.message.usage.cost.total;
          }
        }

        // Fill empty streaming text/thinking blocks with accumulated content
        const msgForRender = { ...event.message };
        if (Array.isArray(msgForRender.content)) {
          msgForRender.content = msgForRender.content.map((block, ci) => {
            if (block.type === "text" && !block.text) {
              const streamingBlock = streamingBlocks[ci];
              return { ...block, text: streamingBlock?.text || "" };
            }
            if (block.type === "thinking" && !block.thinking) {
              const streamingBlock = streamingBlocks[ci];
              return { ...block, thinking: streamingBlock?.text || block.text || "" };
            }
            return block;
          });
        }

        // Replace the message with finalized content
        const mIdx = s.messages.findIndex(m => m.id === event.message.id);
        if (mIdx >= 0) {
          s.messages[mIdx] = msgForRender;
        }

        if (window.VChat && vl) {
          // Force re-render the finalized assistant message via markDirty.
          // This renders the full content (text + toolCall blocks) in the VL,
          // eliminating the old "syncItems + clearStreamArea" race entirely.
          const dirtyIdx = s._streamingMsgIndex != null ? s._streamingMsgIndex : mIdx;
          if (dirtyIdx >= 0) {
            vl.markDirty(dirtyIdx);
            // Re-measure spacer height after content finalizes
            vl.scrollToBottom();
          }
          s.partialMessage = null;
          s.contentBlocks = {};
          s._streamingMsgIndex = null;
        } else {
          const rendered = appendAssistantMessage(msgForRender, s, new Set());
          if (rendered) {
            const partial = document.getElementById("msg-partial");
            if (partial) partial.remove();
            s.partialMessage = null;
            s.contentBlocks = {};
            s._streamingMsgIndex = null;
            scrollToBottom();
          } else {
            console.warn("message_end: final message had no visible content, keeping streaming partial");
          }
        }

        updateFooter();
      }
      break;
    }

    // ── Tools ─────────────────────────────────────────────────────────
    case "tool_execution_start": {
      const tc = {
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        args: event.args,
        output: "",
        status: "running",
        el: null,
      };
      s.toolCalls[event.toolCallId] = tc;

      // Track subagent invocations for the top-of-chat indicator banner
      if (event.toolName === "subagent") {
        const info = getSubagentInfo(tc);
        if (info) {
          info.status = "running";
          s.subagentCalls[event.toolCallId] = info;
          if (isActive) renderSubagentIndicator(s);
        }
      }

      if (isActive) {
        if (window.VChat && vl) {
          // Try to find an existing tool block inside a committed VL item
          let tb = document.getElementById(`tool-${event.toolCallId}`);
          if (tb && tb.closest(".vl-item")) {
            // Found inside a VL item — reuse and update in place
            tc.el = tb;
            updateToolBlock(event.toolCallId, tc);
            tb.classList.add("open");
            scrollToBottom();
            break;
          }

          // Not rendered yet — find the owning assistant message and force re-render
          // so the toolCall block (from message.content) appears in the VL item.
          const ownerIdx = s.messages.findIndex(m =>
            m.role === "assistant" && Array.isArray(m.content) &&
            m.content.some(b => b.type === "toolCall" && b.id === event.toolCallId)
          );
          if (ownerIdx >= 0) {
            vl.markDirty(ownerIdx);
            scrollToBottom();
            break;
          }

          // Last resort: if some other tool block element exists, update it
          if (tb) {
            updateToolBlock(event.toolCallId, tc);
            tb.classList.add("open");
            scrollToBottom();
          }
        } else {
          // Fallback path (no VL or no VChat)
          tc.el = createToolBlock(event.toolCallId, tc);
          const partial = document.getElementById("msg-partial");
          if (partial) {
            $messages.insertBefore(tc.el, partial);
          } else {
            $messages.appendChild(tc.el);
          }
          tc.el.classList.add("open");
          scrollToBottom();
        }
      }
      break;
    }

    case "tool_execution_update": {
      const tc = s.toolCalls[event.toolCallId];
      if (tc) {
        tc.output = event.partialResult?.content?.map(c => c.text || "").join("") || "";
        const imgs = extractToolImages(event.partialResult);
        if (imgs.length) tc.images = imgs;
        if (isActive) { updateToolBlock(event.toolCallId, tc); scrollToBottom(); }
      }
      break;
    }

    case "tool_execution_end": {
      const tc = s.toolCalls[event.toolCallId];
      if (tc) {
        tc.status = event.isError ? "error" : "done";
        tc.output = event.result?.content?.map(c => c.text || "").join("") || "";
        const imgs = extractToolImages(event.result);
        if (imgs.length) tc.images = imgs;
        if (s.subagentCalls[event.toolCallId]) {
          s.subagentCalls[event.toolCallId].status = tc.status;
          if (isActive) renderSubagentIndicator(s);
        }
        if (isActive) { updateToolBlock(event.toolCallId, tc); scrollToBottom(); }
      }
      break;
    }

    // ── Queue ─────────────────────────────────────────────────────────
    case "queue_update":
      s.queue = { steering: event.steering || [], followUp: event.followUp || [] };
      if (isActive) renderQueue(s);
      break;

    // ── Compaction ────────────────────────────────────────────────────
    case "compaction_start":
      if (isActive) {
        s.messages.push({
          id: `compaction-start-${Date.now()}`,
          role: "system",
          content: "Compacting context…",
        });
        if (vl) {
          vl.syncItems(s.messages);
          vl.scrollToBottom();
        } else {
          scrollToBottom();
        }
      }
      break;

    case "compaction_end":
      if (isActive && event.result) {
        s.messages.push({
          id: `compaction-end-${Date.now()}`,
          role: "system",
          content: `Context compacted (~${event.result.estimatedTokensAfter} tokens)`,
        });
        if (vl) {
          vl.syncItems(s.messages);
          vl.scrollToBottom();
        } else {
          scrollToBottom();
        }
      }
      break;
  }
}

// ── Tree ────────────────────────────────────────────────────────────────────

// (Tree/List rendering is handled by tree-view.js; sidebar status is updated
//  from sessions_list, models_list, and token_estimate messages.)

// Restore the full transcript for a session after a page reload. Only applies
// when we don't already have messages, so live streaming isn't clobbered.
function onSessionHistory(sessionId, messages, toolCalls, usage) {
  const s = store.get(sessionId);
  if (!s) return;
  if (s.messages.length > 0) return;
  s.messages = Array.isArray(messages) ? messages : [];
  s.toolCalls = toolCalls || {};
  if (usage) {
    s.usage = usage;
    s.lastContextTokens = usage.totalTokens || 0;
    s.totalUsage = {
      input: usage.input || 0,
      output: usage.output || 0,
      cost: usage.cost?.total || 0,
    };
  }
  if (sessionId === activeSessionId) {
    renderFullChat(sessionId);
    updateFooter();
  }
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function updateDashboard() {
  if (!$dashModelCount && !$dashTotalTokens && !$dashSessionCount && !$dashTree) return;

  // Update model count
  if ($dashModelCount) {
    $dashModelCount.textContent = _lastModelCount + ' model' + (_lastModelCount !== 1 ? 's' : '');
  }

  // Update total tokens from accumulated estimates
  if ($dashTotalTokens) {
    var total = 0;
    store.forEach(function(s) { total += s.estimatedTokens || 0; });
    $dashTotalTokens.textContent = total >= 1000 ? (total / 1000).toFixed(1) + 'k tokens' : total + ' tokens';
  }

  // Update session count and tree (flat list)
  if (_lastTreeData && $dashTree) {
    var count = Array.isArray(_lastTreeData) ? _lastTreeData.length : 0;
    if ($dashSessionCount) $dashSessionCount.textContent = count;
    if (window.TreeView && typeof window.TreeView.renderFlatList === 'function') {
      window.TreeView.renderFlatList(_lastTreeData, {
        container: $dashTree,
        activeSessionId: activeSessionId,
        onSessionClick: function(id) {
          send({ type: 'switch_session', sessionId: id });
        }
      });
    }
  }

  // Update service dots based on received data
  var dotIdx = document.querySelector('.service-card[data-service="session-index"] .service-dot');
  if (dotIdx) dotIdx.classList.toggle('online', !!_dashServices['session-index']);
  var dotToken = document.querySelector('.service-card[data-service="token-tracker"] .service-dot');
  if (dotToken) dotToken.classList.toggle('online', !!_dashServices['token-tracker']);
}

// ── Empty state ─────────────────────────────────────────────────────────────

function renderEmptyChat() {
  destroyVL();
  $messages.innerHTML = "";
  $btnAbort.classList.add("hidden");
}

function updateEmptyState() {
  // In single-session mode, we show chat if we have at least one session
  if (store.size === 0 && !activeSessionId) {
    if ($emptyState) $emptyState.classList.remove("hidden");
    if ($chatPanel) $chatPanel.style.display = "none";
    if ($sessionFooter) $sessionFooter.classList.add("hidden");
    updateDashboard();
  } else {
    if ($emptyState) $emptyState.classList.add("hidden");
    if ($chatPanel) $chatPanel.style.display = "flex";
  }
  updateSessionHeader();
}

// ── Utilities ───────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  if (!text) return "";

  // Pull fenced code blocks out of the text BEFORE escaping so their contents
  // are escaped exactly once. (Escaping the whole string first and then again
  // here used to double-escape code, rendering &lt; / &quot; literally.)
  const codeBlocks = [];
  let html = (text || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${escHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${codeBlocks.length - 1}\u0000`;
  });

  // Escape the remaining text (placeholders contain only NUL/digits and survive).
  html = escHtml(html);

  // Inline code — contents are already escaped above, so do not re-escape.
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold (**)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic (*)
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Paragraphs (blank line separation). Placeholders are single-line tokens,
  // so they won't be split across paragraphs.
  const paras = html.split(/\n\n+/);
  html = paras.map(p => {
    const t = p.trim();
    if (!t) return "";
    if (/^\u0000B\d+\u0000$/.test(t)) return t; // standalone code block — unwrapped
    return `<p>${t.split("\n").join("<br>")}</p>`;
  }).join("");

  // Restore fenced code blocks (already escaped once) into their placeholders.
  html = html.replace(/\u0000B(\d+)\u0000/g, (_, i) => codeBlocks[+i]);

  return html;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

// ── Session list rendering ───────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncatePath(p, maxLen) {
  if (maxLen === undefined) maxLen = 30;
  if (!p) return '';
  return p.length > maxLen ? '…' + p.slice(p.length - maxLen + 1) : p;
}

function renderSessionList(sessions) {
  if (!$sessionList) return;
  $sessionList.innerHTML = '';
  const activeId = currentSessionInfo?.id;
  for (const s of (sessions || [])) {
    const div = document.createElement('div');
    div.className = 'session-list-item' + (s.id === activeId ? ' active' : '');
    div.id = 'tree-node-' + s.id;
    div.dataset.sessionId = s.id;
    // Add agent type emoji
    var emoji = '\u{1F916}'; // 🤖 default robot
    if (s.agentType === 'manager') emoji = '\u{1F3AF}';   // 🎯
    else if (s.agentType === 'architect') emoji = '\u{1F3DB}\u{FE0F}'; // 🏛️
    else if (s.agentType === 'engineer') emoji = '\u{1F527}'; // 🔧

    div.innerHTML =
      '<span class="session-emoji">' + emoji + '</span>' +
      '<span class="session-name">' + escapeHtml(s.name || 'Untitled') + '</span>' +
      '<span class="session-cwd">' + escapeHtml(truncatePath(s.cwd || '')) + '</span>' +
      (s.estimatedTokens ? '<span class="session-tokens">' + Math.round(s.estimatedTokens / 1000) + 'k</span>' : '');
    div.addEventListener('click', function () {
      if (s.id !== currentSessionInfo?.id) {
        send({ type: 'switch_session', sessionId: s.id });
      }
    });
    $sessionList.appendChild(div);
  }
}

// ── New session directory browser ─────────────────────────────────────────

var _newSessionBrowsePath = '/';

function showNewSessionDirs(path, dirs, error) {
  if (!$newSessionDirList) return;
  if (path !== _newSessionBrowsePath) return;
  $newSessionDirList.innerHTML = '';
  $newSessionDirList.classList.remove('hidden');

  if (error) {
    $newSessionDirList.innerHTML = '<div class="dir-empty" style="color:var(--danger)">' + escapeHtml(error) + '</div>';
    return;
  }

  if (!dirs || dirs.length === 0) {
    $newSessionDirList.innerHTML = '<div class="dir-empty">(no subdirectories)</div>';
    return;
  }

  if (path && path !== '/') {
    var parentItem = document.createElement('div');
    parentItem.className = 'dir-item';
    parentItem.innerHTML = '<span class="dir-icon">📁</span><span class="dir-name">..</span>';
    parentItem.addEventListener('click', function () {
      var parent = path.replace(/\/+[^/]*$/, '') || '/';
      _newSessionBrowsePath = parent;
      send({ type: 'list_dirs', path: parent });
    });
    $newSessionDirList.appendChild(parentItem);
  }

  for (var i = 0; i < dirs.length; i++) {
    var name = dirs[i];
    var item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = '<span class="dir-icon">📁</span><span class="dir-name">' + escapeHtml(name) + '</span>';
    item.addEventListener('click', (function (dirName) {
      return function () {
        var fullPath = (path === '/' ? '' : path) + '/' + dirName;
        if ($newSessionCwd) $newSessionCwd.value = fullPath;
        $newSessionDirList.classList.add('hidden');
      };
    })(name));
    $newSessionDirList.appendChild(item);
  }
}

// ── Event listeners ─────────────────────────────────────────────────────────

// Prompt input — send on Enter, auto-resize
$promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!activeSessionId) return;
    const text = $promptInput.value.trim();
    if (!text) return;

    const s = store.get(activeSessionId);
    if (s && s.isStreaming) {
      send({ type: "steer", sessionId: activeSessionId, message: text });
    } else {
      send({ type: "prompt", sessionId: activeSessionId, message: text });
    }

    $promptInput.value = "";
    $promptInput.style.height = "auto";

    // Optimistic bubble
    if (s) {
      pendingOptimisticId = "u-" + Date.now();
      const msg = { id: pendingOptimisticId, role: "user", content: text };
      s.messages.push(msg);
      if (vl) {
        vl.syncItems(s.messages);
        vl.scrollToBottom();
      }
    }
  }
});

$promptInput.addEventListener("input", () => {
  $promptInput.style.height = "auto";
  $promptInput.style.height = Math.min($promptInput.scrollHeight, 160) + "px";
});

// Agent selector change handler
if ($agentSelector) {
  $agentSelector.addEventListener('change', function() {
    var sessionId = currentSessionInfo && currentSessionInfo.id;
    if (!sessionId) return;

    // Prevent double-clicks
    if ($agentSelector.classList.contains('loading')) return;

    // Show loading state
    $agentSelector.classList.add('loading');
    $agentSelector.disabled = true;

    // Remember previous value for error recovery
    var previousValue = $agentSelector.dataset.previousValue || 'manager';
    $agentSelector.dataset.previousValue = $agentSelector.value;

    send({ type: 'set_agent_type', sessionId: sessionId, agentType: $agentSelector.value });
  });
}

// Abort button
$btnAbort.addEventListener("click", abortSession);

// Fork button
$btnNewSession?.addEventListener("click", openNewSessionDialog);

// Sidebar toggle
$btnTree?.addEventListener("click", toggleSidebar);
$btnSidebarCollapse?.addEventListener("click", toggleSidebar);

// Sidebar search filter
if ($sidebarSearch) {
  $sidebarSearch.addEventListener('input', function() {
    if (window.TreeView && typeof window.TreeView.filter === 'function') {
      window.TreeView.filter($sidebarSearch.value);
    }
  });
  $sidebarSearch.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      $sidebarSearch.value = '';
      if (window.TreeView && typeof window.TreeView.filter === 'function') {
        window.TreeView.filter('');
      }
      $sidebarSearch.blur();
    }
  });
}

// Init new session dialog event handlers
if ($btnNewSessionCreate) $btnNewSessionCreate.addEventListener('click', submitNewSession);
if ($btnNewSessionCancel) $btnNewSessionCancel.addEventListener('click', closeNewSessionDialog);
if ($btnBrowseDirsNew) $btnBrowseDirsNew.addEventListener('click', function() {
  send({ type: 'list_dirs', path: ($newSessionCwd && $newSessionCwd.value) || '/' });
});

// Close new session overlay on background click
if ($newSessionOverlay) {
  $newSessionOverlay.addEventListener('click', function(e) {
    if (e.target === $newSessionOverlay) closeNewSessionDialog();
  });
}

// Dashboard actions
if ($btnDashNewSession) $btnDashNewSession.addEventListener('click', openNewSessionDialog);
if ($btnDashModels) $btnDashModels.addEventListener('click', function() {
  send({ type: 'get_models' });
});


// Ctrl+T → toggle sidebar; Ctrl+Shift+F → new session; Escape → close dialogs
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "t") {
    e.preventDefault();
    toggleSidebar();
  }
  if (e.ctrlKey && e.shiftKey && e.key === "F") {
    e.preventDefault();
    openNewSessionDialog();
  }
  if (e.key === "Escape" && $newSessionOverlay && !$newSessionOverlay.classList.contains('hidden')) {
    closeNewSessionDialog();
  }
});

// ── Screenshot lightbox ─────────────────────────────────────────────────────
// Clicking an embedded tool screenshot opens a full-page overlay. Delegated
// so it works for screenshots rendered later by the virtual list.
document.addEventListener("click", (e) => {
  const img = e.target.closest(".tool-screenshot");
  if (!img) return;
  const overlay = document.createElement("div");
  overlay.className = "screenshot-lightbox";
  const full = document.createElement("img");
  full.src = img.src;
  overlay.appendChild(full);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
});

// ── Init ────────────────────────────────────────────────────────────────────

$agentSelector = document.getElementById('agent-selector');
$newSessionAgentType = document.getElementById('new-session-agent-type');

connect();
updateEmptyState();
