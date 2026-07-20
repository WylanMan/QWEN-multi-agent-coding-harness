import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Pi SDK ──────────────────────────────────────────────────────────────────
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  buildContextEntries,
} from "@earendil-works/pi-coding-agent";
import { createDiscordSessionManager } from './src/discord-session.js';
import { DiscordBridge } from './src/discord-bridge.js';
import { createTokenTracker } from './src/token-tracker.js';
import { SessionRouter } from './src/session-router.js';
import { SessionSearch } from './src/session-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Write-queue for atomic saves ────────────────────────────────────────────
let _writeQueue = Promise.resolve();

// ── Globals ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const CWD = process.env.CWD || "/home";
let sessionsIndex;  // will be initialized in main()

let modelRuntime;
let settingsManager;
let resourceLoader;
let agentsMdContent;  // default AGENTS.md content, loaded at startup

// Active sessions: sessionId → { session, sessionManager, name, model, tabState }
const sessions = new Map();

// Discord bridge (optional — only initialized if config exists)
let discordBridge = null;
let tokenTracker = null;
let sessionSearch = null;

// Session router: maps routing keys (ws:, g:, dm:) to session IDs
const sessionRouter = new SessionRouter();

// ── SessionsIndex ───────────────────────────────────────────────────────────

/**
 * Flat independent-session index stored at ~/.pi/agent/sessions-index.json.
 *
 * Schema:
 *   {
 *     version: 1,
 *     activeSessionId: string|null,
 *     sessions: { [id]: { id, name, cwd, sessionFile, model|null,
 *                         createdAt, lastUsedAt, estimatedTokens, agentType } }
 *   }
 */
class SessionsIndex {
  static get PATH() {
    return path.join(getAgentDir(), 'sessions-index.json');
  }

  /**
   * Load the sessions index from disk.  Returns an empty instance if the
   * file is missing or corrupted.
   */
  static async load() {
    const filePath = this.PATH;
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return new SessionsIndex({ version: 1, activeSessionId: null, sessions: {} });
      }
      throw err;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_parseErr) {
      // Corrupted — backup and start fresh
      try {
        const bakPath = filePath + '.corrupted-' + Date.now();
        await fs.promises.rename(filePath, bakPath);
      } catch (_bakErr) { /* can't backup — proceed in-memory */ }
      return new SessionsIndex({ version: 1, activeSessionId: null, sessions: {} });
    }

    if (!data || !data.version) {
      return new SessionsIndex({ version: 1, activeSessionId: null, sessions: {} });
    }

    return new SessionsIndex(data);
  }

  constructor(data) {
    this._data = data;
  }

  /** Raw underlying data object. */
  get data() {
    return this._data;
  }

  /** Get a single session record by id, or undefined. */
  get(id) {
    return this._data.sessions[id];
  }

  /** Register or replace a session record (full replacement). */
  register(info) {
    this._data.sessions[info.id] = {
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      sessionFile: info.sessionFile,
      model: info.model ?? null,
      createdAt: info.createdAt,
      lastUsedAt: info.lastUsedAt,
      estimatedTokens: info.estimatedTokens ?? 0,
      agentType: info.agentType || 'manager',
    };
  }

  /** Remove a session from the index. */
  remove(id) {
    delete this._data.sessions[id];
    if (this._data.activeSessionId === id) {
      this._data.activeSessionId = null;
    }
  }

  /** Set the active session id. */
  setActive(id) {
    this._data.activeSessionId = id;
  }

  /** Get the currently active session id, or null. */
  getActiveSessionId() {
    return this._data.activeSessionId ?? null;
  }

  /** Update the lastUsedAt timestamp for a session. */
  updateLastUsed(id) {
    const session = this._data.sessions[id];
    if (!session) return;
    session.lastUsedAt = new Date().toISOString();
  }

  /** Update the estimatedTokens for a session. */
  updateTokenCount(id, tokens) {
    const session = this._data.sessions[id];
    if (!session) return;
    session.estimatedTokens = tokens;
  }

  /**
   * Atomically write the index to disk (queued behind any in-flight saves).
   */
  save() {
    _writeQueue = _writeQueue.then(async () => {
      const target = SessionsIndex.PATH;
      const tmp = target + '.tmp';

      await fs.promises.mkdir(path.dirname(target), { recursive: true });

      const json = JSON.stringify(this._data, null, 2);
      await fs.promises.writeFile(tmp, json, 'utf-8');
      await fs.promises.rename(tmp, target);
    }).catch(err => {
      console.error('[sessions-index] Save failed:', err.message);
    });
    return _writeQueue;
  }


}

// ── Express + HTTP ──────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

function sendTo(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ── Session management ──────────────────────────────────────────────────────

async function bootstrapSessions() {
  sessionsIndex = await SessionsIndex.load();

  // If still empty, create a home session
  const updatedSessions = Object.keys(sessionsIndex.data.sessions);
  if (updatedSessions.length === 0) {
    const { id } = await createSession('/home', CWD, 'manager');
    sessionsIndex.setActive(id);
    await sessionsIndex.save();
    sendSessionsList();
    return { id };
  }

  // Set the last-used session as active (or first available)
  let activeId = sessionsIndex.data.activeSessionId;
  if (!activeId || !sessionsIndex.get(activeId)) {
    // Pick the most recently used session
    const all = Object.values(sessionsIndex.data.sessions);
    all.sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
    activeId = all[0]?.id ?? null;
    if (activeId) {
      sessionsIndex.setActive(activeId);
      await sessionsIndex.save();
    }
  }

  sendSessionsList();
  return { id: activeId };
}

async function createSession(name, cwd, agentType) {
  const effectiveCwd = cwd || CWD;
  const type = agentType || 'manager';
  const sessionManager = SessionManager.create(effectiveCwd);
  const nameStr = name || `Session ${sessions.size + 1}`;

  // Load agent-specific system prompt
  let agentSystemPrompt = agentsMdContent; // fallback to default AGENTS.md
  if (type === 'manager') {
    // Manager uses the default AGENTS.md (already loaded as agentsMdContent)
    agentSystemPrompt = agentsMdContent;
  } else {
    const agentMdPath = path.join(getAgentDir(), 'agents', `${type}.md`);
    if (fs.existsSync(agentMdPath)) {
      agentSystemPrompt = fs.readFileSync(agentMdPath, 'utf-8');
    }
  }

  // Create a resource loader with the agent's prompt
  const sessionResourceLoader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: agentSystemPrompt ? () => agentSystemPrompt : undefined,
    noContextFiles: true,
  });
  await sessionResourceLoader.reload();

  // Orchestrator mode: only read/bash for lightweight inline work.
  const { session, modelFallbackMessage } = await createAgentSession({
    sessionManager,
    settingsManager,
    resourceLoader: sessionResourceLoader,
    modelRuntime,
    excludeTools: ["write", "edit"],
  });

  if (modelFallbackMessage) {
    console.warn(`Model fallback for ${nameStr}: ${modelFallbackMessage}`);
  }

  const sessionState = {
    session,
    sessionManager,
    name: nameStr,
    model: session.model,
    isStreaming: false,
    messages: [],
    agentType: type,
    cwd: effectiveCwd,
  };

  sessions.set(session.sessionId, sessionState);

  // Subscribe to events and forward to client
  session.subscribe((event) => {
    handleSessionEvent(session.sessionId, event);
  });

  const now = new Date().toISOString();
  const info = {
    id: session.sessionId,
    name: nameStr,
    cwd: effectiveCwd,
    sessionFile: sessionManager.getSessionFile(),
    model: null,
    createdAt: now,
    lastUsedAt: now,
    estimatedTokens: 0,
    agentType: type,
  };

  sessionsIndex.register(info);
  await sessionsIndex.save();
  sendSessionsList();

  return {
    id: session.sessionId,
    name: nameStr,
    model: session.model
      ? { id: session.model.id, name: session.model.name, provider: session.model.provider, contextWindow: session.model.contextWindow || 0 }
      : null,
    thinkingLevel: session.thinkingLevel,
    sessionFile: session.sessionFile,
    agentType: type,
  };
}

function handleSessionEvent(sessionId, event) {
  const state = sessions.get(sessionId);
  if (!state) return;

  switch (event.type) {
    case "agent_start":
      state.isStreaming = true;
      break;
    case "agent_end":
    case "agent_settled":
      state.isStreaming = false;
      // Final token count flush
      if (tokenTracker) tokenTracker.onSettled(sessionId);
      break;
    case "message_update":
      // Debounced token estimate update
      if (tokenTracker) tokenTracker.onMessageUpdate(sessionId);
      break;
  }

  // Forward to clients
  broadcast({ type: "session_event", sessionId, event });
}

async function closeSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return;

  try {
    await state.session.dispose();
  } catch (e) {
    console.error(`Error disposing session ${sessionId}:`, e.message);
  }

  sessions.delete(sessionId);

  broadcast({ type: "session_closed", sessionId });
}

async function getSessionTree(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return null;

  try {
    return state.sessionManager.getTree();
  } catch (e) {
    console.error(`Error getting tree for ${sessionId}:`, e.message);
    return null;
  }
}

// Build the chat history for a session from its persisted tree (active leaf
// path, compaction-aware). Returns the display messages, toolCalls map and the
// latest assistant usage — the same shape the client accumulates from live
// streaming events — so a page reload can restore the full transcript.
function getSessionHistory(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return null;

  try {
    const sm = state.sessionManager;
    const entries = sm.getEntries();
    if (!entries || entries.length === 0) {
      return { messages: [], toolCalls: {}, usage: null };
    }

    // Active path from root to current leaf, compaction-aware.
    const path = buildContextEntries(entries, sm.leafId, sm.byId);

    const messages = [];
    const toolCalls = {};
    let usage = null;

    for (const entry of path) {
      if (entry.type === "compaction") {
        messages.push({
          id: `compaction-${entry.id}`,
          role: "system",
          content: entry.summary
            ? `Context compacted (~${entry.tokensBefore ?? "?"} tokens → summary)`
            : "Context compacted",
        });
        continue;
      }

      if (entry.type !== "message") continue;

      const m = entry.message;
      if (!m) continue;
      const role = m.role;

      if (role === "user" || role === "assistant") {
        let content = m.content;
        if (typeof content === "string") content = [{ type: "text", text: content }];
        if (!Array.isArray(content)) content = [];

        const out = {
          id: m.id || `hist-${entry.id}`,
          role,
          content,
          timestamp: m.timestamp,
        };
        if (m.stopReason) out.stopReason = m.stopReason;
        if (m.model) out.model = m.model;
        if (m.provider) out.provider = m.provider;

        if (role === "assistant") {
          // Register any tool-call blocks so tool blocks render on reload.
          for (const block of content) {
            if (block && block.type === "toolCall" && block.id) {
              if (!toolCalls[block.id]) {
                toolCalls[block.id] = {
                  id: block.id,
                  name: block.name,
                  arguments: block.arguments,
                  output: "",
                  status: "running",
                  images: [],
                };
              }
            }
          }
          if (m.usage) {
            if (!usage) {
              usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
            }
            usage.input += m.usage.input || 0;
            usage.output += m.usage.output || 0;
            usage.cacheRead += m.usage.cacheRead || 0;
            usage.cacheWrite += m.usage.cacheWrite || 0;
            usage.totalTokens = m.usage.totalTokens || 0; // last message's total context
            if (m.usage.cost?.total) {
              usage.cost.total += m.usage.cost.total;
            }
          }
        }

        messages.push(out);
      } else if (role === "toolResult") {
        const tcId = m.toolCallId;
        if (tcId) {
          let tc = toolCalls[tcId];
          if (!tc) {
            tc = toolCalls[tcId] = {
              id: tcId,
              name: m.toolName || "tool",
              arguments: {},
              output: "",
              status: "done",
              images: [],
            };
          }
          tc.status = m.isError ? "error" : "done";
          const blocks = Array.isArray(m.content) ? m.content : [];
          const txt = blocks
            .filter((c) => c && c.type === "text")
            .map((c) => c.text || c.content || "")
            .join("");
          if (txt) tc.output = txt;
          const imgs = [];
          for (const c of blocks) {
            if (c && c.type === "image" && c.data && c.mimeType) {
              imgs.push({ dataUrl: `data:${c.mimeType};base64,${c.data}`, mimeType: c.mimeType });
            }
          }
          if (imgs.length) tc.images = imgs;
        }
        // Tool results fold into the owning tool block; not a chat message.
      }
      // Other roles (compactionSummary, branchSummary, bashExecution, custom)
      // are not rendered as transcript bubbles.
    }

    // Any tool call whose result never landed (e.g. aborted) → mark done.
    for (const id in toolCalls) {
      if (toolCalls[id].status === "running") toolCalls[id].status = "done";
    }

    return { messages, toolCalls, usage };
  } catch (e) {
    console.error(`Error getting history for ${sessionId}:`, e.message);
    return null;
  }
}

// ── Switch session handler ──────────────────────────────────────────────────

async function handleSwitchSession(sessionId, ws) {
  // Check if already active for this client
  const currentActive = sessionRouter.getActiveForClient(ws);
  if (currentActive === sessionId) return;

  // Validate session exists in index
  const info = sessionsIndex.get(sessionId);
  if (!info) throw new Error(`Session "${sessionId}" not found in index`);

  // Load session into memory if not already loaded
  let state = sessions.get(sessionId);
  if (!state) {
    state = await loadSessionFromIndex(sessionId);
  }

  // Update route mapping for this client
  if (ws && ws.routeKey) {
    sessionRouter.registerRoute(ws.routeKey, sessionId);
  }
  sessionsIndex.setActive(sessionId);
  sessionsIndex.updateLastUsed(sessionId);
  await sessionsIndex.save();
  sendSessionsList();

  // Build history
  const history = getSessionHistory(sessionId);

  sendTo(ws, {
    type: "session_switched",
    sessionId,
    history: history ? history.messages : [],
    toolCalls: history ? history.toolCalls : {},
    usage: history ? history.usage : null,
    name: info.name,
    model: info.model ? { ...info.model, contextWindow: state.model?.contextWindow || 0 } : null,
    cwd: info.cwd,
    agentType: state.agentType || 'manager',
  });
}

// ── Load session from index into memory ─────────────────────────────────────

async function loadSessionFromIndex(sessionId) {
  const info = sessionsIndex.get(sessionId);
  if (!info) throw new Error(`Session "${sessionId}" not found in index`);

  // Create SessionManager from existing file if it exists, or create new
  let sm;
  const sessionFilePath = info.sessionFile ? info.sessionFile.replace('~', os.homedir()) : null;

  if (sessionFilePath && fs.existsSync(sessionFilePath)) {
    try {
      sm = SessionManager.open(sessionFilePath);
    } catch (_) {
      sm = SessionManager.create(info.cwd);
    }
  } else {
    sm = SessionManager.create(info.cwd);
  }

  const type = info.agentType || 'manager';
  let systemPrompt = agentsMdContent;
  if (type === 'manager') {
    // Manager uses the default AGENTS.md (already loaded as agentsMdContent)
    systemPrompt = agentsMdContent;
  } else {
    const agentMdPath = path.join(getAgentDir(), 'agents', `${type}.md`);
    if (fs.existsSync(agentMdPath)) {
      systemPrompt = fs.readFileSync(agentMdPath, 'utf-8');
    }
  }
  const rl = new DefaultResourceLoader({
    cwd: info.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: systemPrompt ? () => systemPrompt : undefined,
    noContextFiles: true,
  });
  await rl.reload();

  const { session } = await createAgentSession({
    sessionManager: sm,
    settingsManager,
    resourceLoader: rl,
    modelRuntime,
    excludeTools: ["write", "edit"],
  });

  const state = {
    session,
    sessionManager: sm,
    name: info.name,
    model: session.model,
    isStreaming: false,
    messages: [],
    agentType: info.agentType || 'manager',
    resourceLoader: rl,
  };

  sessions.set(session.sessionId, state);

  session.subscribe((event) => {
    handleSessionEvent(session.sessionId, event);
  });

  // Update session file path in index
  info.sessionFile = sm.getSessionFile();
  sessionsIndex.register(info);
  await sessionsIndex.save();

  return state;
}

// ── WebSocket message handler ───────────────────────────────────────────────

function handleMessage(ws, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    sendTo(ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  const { type } = data;

  switch (type) {
    // ── New session ──────────────────────────────────────────────────
    case "new_session": {
      (async () => {
        try {
          const info = await createSession(data.name, data.cwd, data.agentType);
          sendTo(ws, {
            type: "session_created",
            session: {
              id: info.id,
              name: info.name,
              model: info.model,
              sessionFile: info.sessionFile,
              cwd: data.cwd || CWD,
              agentType: info.agentType || 'manager',
            },
          });
        } catch (e) {
          sendTo(ws, { type: "error", message: `Failed to create session: ${e.message}` });
        }
      })();
      break;
    }

    // ── Prompt ───────────────────────────────────────────────────────
    case "prompt": {
      const targetSessionId = data.sessionId || sessionRouter.getActiveForClient(ws);
      const state = sessions.get(targetSessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      (async () => {
        state.session.prompt(data.message).catch((e) => {
          console.error(`Prompt error in ${targetSessionId}:`, e.message);
        });
      })();
      break;
    }

    // ── Abort ────────────────────────────────────────────────────────
    case "abort": {
      const targetSessionId = data.sessionId || sessionRouter.getActiveForClient(ws);
      const state = sessions.get(targetSessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      state.session.abort().catch((e) => {
        console.error(`Abort error in ${data.sessionId}:`, e.message);
      });
      break;
    }

    // ── Steer ────────────────────────────────────────────────────────
    case "steer": {
      const targetSessionId = data.sessionId || sessionRouter.getActiveForClient(ws);
      const state = sessions.get(targetSessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      state.session.steer(data.message).catch((e) => {
        console.error(`Steer error in ${data.sessionId}:`, e.message);
      });
      break;
    }

    // ── Follow-up ────────────────────────────────────────────────────
    case "follow_up": {
      const targetSessionId = data.sessionId || sessionRouter.getActiveForClient(ws);
      const state = sessions.get(targetSessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      (async () => {
        state.session.followUp(data.message).catch((e) => {
          console.error(`FollowUp error in ${targetSessionId}:`, e.message);
        });
      })();
      break;
    }

    // ── Close session ────────────────────────────────────────────────
    case "close_session": {
      closeSession(data.sessionId);
      sendSessionsList(ws);
      break;
    }

    // ── Get tree ─────────────────────────────────────────────────────
    case "get_tree": {
      (async () => {
        const tree = await getSessionTree(data.sessionId);
        sendTo(ws, { type: "tree_data", sessionId: data.sessionId, tree });
      })();
      break;
    }

    // ── Get chat history (for page reload) ─────────────────────────
    case "get_history": {
      (async () => {
        if (!sessions.has(data.sessionId)) {
          sendTo(ws, { type: "error", message: "Session not found" });
          return;
        }
        const history = getSessionHistory(data.sessionId);
        sendTo(ws, {
          type: "session_history",
          sessionId: data.sessionId,
          messages: history ? history.messages : [],
          toolCalls: history ? history.toolCalls : {},
          usage: history ? history.usage : null,
        });
      })();
      break;
    }

    // ── List sessions ────────────────────────────────────────────────
    case "list_sessions": {
      sendSessionsList(ws);
      break;
    }

    // ── Get available models ─────────────────────────────────────────
    case "get_models": {
      (async () => {
        try {
          const available = await modelRuntime.getAvailable();
          sendTo(ws, {
            type: "models_list",
            models: available.map((m) => ({
              id: m.id,
              name: m.name,
              provider: m.provider,
            })),
          });
        } catch (e) {
          sendTo(ws, { type: "error", message: `Failed to list models: ${e.message}` });
        }
      })();
      break;
    }

    // ── Set session name ─────────────────────────────────────────────
    case "set_name": {
      const state = sessions.get(data.sessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      state.name = data.name;
      // Also update the index
      const info = sessionsIndex.get(data.sessionId);
      if (info) {
        info.name = data.name;
        sessionsIndex.updateLastUsed(data.sessionId);
        sessionsIndex.save().then(() => sendSessionsList());
      }
      broadcast({ type: "session_renamed", sessionId: data.sessionId, name: data.name });
      break;
    }

    // ── Set agent type ───────────────────────────────────────────────
    case "set_agent_type": {
      const targetSessionId = data.sessionId || sessionRouter.getActiveForClient(ws);
      const state = sessions.get(targetSessionId);
      if (!state) {
        sendTo(ws, { type: "error", message: "Session not found" });
        return;
      }
      
      const validTypes = ['manager', 'architect', 'engineer'];
      const newType = validTypes.includes(data.agentType) ? data.agentType : 'manager';
      
      // No-op if already the requested type
      if (state.agentType === newType) {
        sendTo(ws, { type: "agent_type_changed", sessionId: targetSessionId, agentType: newType });
        return;
      }

      // Guard against concurrent agent switches
      if (state._switchingAgent) {
        sendTo(ws, { type: "error", message: "Agent switch already in progress" });
        return;
      }
      state._switchingAgent = true;

      // Update in-memory state
      state.agentType = newType;

      // Update sessionsIndex
      const idxInfo = sessionsIndex.get(targetSessionId);
      if (idxInfo) {
        idxInfo.agentType = newType;
        sessionsIndex.updateLastUsed(targetSessionId);
        sessionsIndex.save().then(() => sendSessionsList());
      }

      // Reload session with new agent system prompt
      (async () => {
        try {
          // Read cwd from sessionsIndex (not state.cwd — it's undefined)
          const sessionCwd = (idxInfo && idxInfo.cwd) || CWD;

          // Load the new agent's system prompt
          let systemPrompt = agentsMdContent;
          if (newType !== 'manager') {
            const agentMdPath = path.join(getAgentDir(), 'agents', `${newType}.md`);
            if (fs.existsSync(agentMdPath)) {
              systemPrompt = fs.readFileSync(agentMdPath, 'utf-8');
            }
          }

          // Create new resource loader with the agent's prompt
          const rl = new DefaultResourceLoader({
            cwd: sessionCwd,
            agentDir: getAgentDir(),
            settingsManager,
            systemPromptOverride: systemPrompt ? () => systemPrompt : undefined,
            noContextFiles: true,
          });
          await rl.reload();

          // Dispose old session but KEEP the SessionManager (preserves history)
          await state.session.dispose();

          // Create new session with the EXISTING SessionManager
          const { session: newSession } = await createAgentSession({
            sessionManager: state.sessionManager,
            settingsManager,
            resourceLoader: rl,
            modelRuntime,
            model: state.model,
            excludeTools: ["write", "edit"],
          });

          // Wire up events
          newSession.subscribe(event => handleSessionEvent(targetSessionId, event));

          // Update state
          state.session = newSession;
          state.resourceLoader = rl;
          state._switchingAgent = false;

          // Send full history to the requesting client
          const history = getSessionHistory(targetSessionId);
          sendTo(ws, {
            type: "session_switched",
            sessionId: targetSessionId,
            history: history ? history.messages : [],
            toolCalls: history ? history.toolCalls : {},
            usage: history ? history.usage : null,
            name: state.name,
            model: state.model,
            cwd: sessionCwd,
            agentType: newType,
          });

          // Broadcast lightweight change to other clients
          broadcast({ type: "agent_type_changed", sessionId: targetSessionId, agentType: newType });
        } catch (e) {
          console.error(`Failed to change agent type for ${targetSessionId}:`, e.message);
          state._switchingAgent = false;

          // Revert agentType in sessionsIndex on failure
          if (idxInfo) {
            idxInfo.agentType = state.agentType;
            try { await sessionsIndex.save(); } catch {}
          }

          sendTo(ws, { type: "error", message: `Failed to change agent type: ${e.message}` });
        }
      })();
      break;
    }

    // ── Switch session ──────────────────────────────────────────────────
    case "switch_session": {
      (async () => {
        try {
          await handleSwitchSession(data.sessionId, ws);
        } catch (e) {
          sendTo(ws, { type: "error", message: `Switch failed: ${e.message}` });
        }
      })();
      break;
    }

    // ── Search sessions ────────────────────────────────────────────────
    case "search_sessions": {
      (async () => {
        try {
          if (!sessionSearch || !data.query) {
            sendTo(ws, { type: "search_results", results: [], totalMatches: 0 });
            return;
          }
          const result = await sessionSearch.search(data.query, {
            limit: data.limit || 20,
            maxPerSession: data.maxPerSession || 5,
            sessionId: data.sessionId || undefined,
          });
          sendTo(ws, { type: "search_results", ...result });
        } catch (e) {
          sendTo(ws, { type: "error", message: `Search failed: ${e.message}` });
        }
      })();
      break;
    }

    // ── List directories ────────────────────────────────────────────
    case "list_dirs": {
      (async () => {
        try {
          const dirs = await listDirs(data.path || '/home');
          sendTo(ws, { type: "dirs_list", path: data.path || '/home', dirs });
        } catch (e) {
          sendTo(ws, { type: "dirs_list", path: data.path || '/home', dirs: [], error: e.message });
        }
      })();
      break;
    }

    // ── Unknown ──────────────────────────────────────────────────────
    default:
      sendTo(ws, { type: "error", message: `Unknown command: ${type}` });
  }
}

function sendSessionsList(ws) {
  const list = [];
  const indexSessions = sessionsIndex.data.sessions || {};

  for (const [id, info] of Object.entries(indexSessions)) {
    const memState = sessions.get(id);
    list.push({
      id,
      name: info.name,
      cwd: info.cwd,
      model: info.model || null,
      agentType: info.agentType || 'manager',
      createdAt: info.createdAt,
      lastUsedAt: info.lastUsedAt,
      estimatedTokens: info.estimatedTokens || 0,
      isStreaming: memState?.isStreaming || false,
    });
  }

  if (ws) {
    sendTo(ws, { type: "sessions_list", sessions: list });
  } else {
    broadcast({ type: "sessions_list", sessions: list });
  }
}

// ── WebSocket connection handler ─────────────────────────────────────────────

wss.on("connection", (ws) => {
  // Assign a unique route key for this WebSocket client
  const clientId = crypto.randomUUID();
  sessionRouter.setClientContext(ws, 'ws:' + clientId);
  console.log("Client connected:", ws.routeKey);

  // Send sessions list
  sendTo(ws, { type: "sessions_list", sessions: Object.values(sessionsIndex.data.sessions).map(info => {
    const memState = sessions.get(info.id);
    return {
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      model: info.model || null,
      agentType: info.agentType || 'manager',
      createdAt: info.createdAt,
      lastUsedAt: info.lastUsedAt,
      estimatedTokens: info.estimatedTokens || 0,
      isStreaming: memState?.isStreaming || false,
    };
  }) });

  // Auto-switch to active session
  const activeId = sessionsIndex.getActiveSessionId();
  if (activeId) {
    handleSwitchSession(activeId, ws).catch(e => {
      console.error("Error auto-switching on connect:", e.message);
    });
  }

  ws.on("message", (raw) => {
    handleMessage(ws, raw.toString());
  });

  ws.on("close", () => {
    if (ws.routeKey) {
      sessionRouter.unregisterRoute(ws.routeKey);
    }
    console.log("Client disconnected:", ws.routeKey);
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Starting pi frontend server...");

  // Initialize shared pi services
  modelRuntime = await ModelRuntime.create({});
  settingsManager = SettingsManager.create(CWD);
  // Use AGENTS.md as the primary system prompt so the orchestrator
  // identity takes precedence over the default "coding assistant" role.
  const agentsMdPath = path.join(getAgentDir(), "AGENTS.md");
  agentsMdContent = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, "utf-8")
    : undefined;

  resourceLoader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: agentsMdContent ? () => agentsMdContent : undefined,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  // Auto-boot home session (sets sessionsIndex)
  const { id } = await bootstrapSessions();
  if (id) {
    sessionRouter.setDefaultSession(id);
    console.log(`Active session: ${id}`);
  }

  // Initialize services that depend on sessionsIndex
  tokenTracker = createTokenTracker({ 
    sessionsIndex,
    sessions,
    onUpdate: (sessionId, tokens) => {
      broadcast({ type: 'token_estimate', sessionId, tokens });
    }
  });

  sessionSearch = new SessionSearch({ sessionsIndex, agentDir: getAgentDir() });

  // ── Initialize Discord bridge (optional) ───────────────────────────
  const discordConfigPath = path.join(os.homedir(), '.pi', 'services', 'discord', 'config.json');
  if (fs.existsSync(discordConfigPath)) {
    try {
      const discordConfig = JSON.parse(fs.readFileSync(discordConfigPath, 'utf-8'));
      if (discordConfig.botToken) {
        const discordSessionManager = createDiscordSessionManager({
          modelRuntime,
          settingsManager,
          resourceLoader,
          sessionsIndex,
          sessions,
          broadcast,
          sessionRouter,
        });
        discordBridge = new DiscordBridge(discordConfig, { discordSessionManager, broadcast });
        await discordBridge.start();
        console.log(`  🤖 Discord bridge online — logged in as ${discordBridge.client.user?.tag || 'unknown'}`);
      } else {
        console.log('  ⏭ Discord config found but no botToken — skipping');
      }
    } catch (e) {
      console.warn('  ⚠ Discord bridge init failed:', e.message);
      console.warn('    (non-fatal — server continues without Discord)');
    }
  } else {
    console.log('  ⏭ No Discord config at ' + discordConfigPath + ' — skipping');
  }

  // Check for available models
  let availableCount = 0;
  try {
    const available = await modelRuntime.getAvailable();
    availableCount = available.length;
    console.log(`Found ${availableCount} available models`);
    for (const m of available.slice(0, 5)) {
      console.log(`  • ${m.provider}/${m.id} — ${m.name}`);
    }
    if (available.length > 5) console.log(`  ... and ${available.length - 5} more`);
  } catch (e) {
    console.warn("Could not check available models:", e.message);
  }

  if (availableCount === 0) {
    console.warn("⚠ No API keys configured. Set ANTHROPIC_API_KEY or run `pi /login` first.");
  }

  server.listen(PORT, () => {
    console.log(`\n  🎨 pi frontend → http://localhost:${PORT}\n`);
  });
}

// ── Directory listing helper ───────────────────────────────────────────────

async function listDirs(basePath) {
  const dirs = [];
  try {
    const entries = await fs.promises.readdir(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        dirs.push(entry.name);
      }
    }
  } catch (e) {
    throw new Error(`Cannot read directory ${basePath}: ${e.message}`);
  }
  return dirs.sort();
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  // Stop Discord bridge first
  if (discordBridge) {
    try { await discordBridge.stop(); } catch (_) {}
  }
  for (const [, state] of sessions) {
    try {
      await state.session.dispose();
    } catch (_) {}
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  // Stop Discord bridge first
  if (discordBridge) {
    try { await discordBridge.stop(); } catch (_) {}
  }
  for (const [, state] of sessions) {
    try {
      await state.session.dispose();
    } catch (_) {}
  }
  process.exit(0);
});

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
