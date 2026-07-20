// ── Discord Session Manager ────────────────────────────────────────────────
// Factory for Discord route sessions that reuses the frontend server's shared
// services (modelRuntime, settingsManager, resourceLoader, sessionsIndex,
// sessions Map, broadcast function).
//
// The returned manager maps Discord channel/thread keys to pi sessions, storing
// session state in the same shared `sessions` Map used by server.js so that
// frontend WebSocket clients receive session events via broadcast().
//
// Usage:
//   import { createDiscordSessionManager } from './discord-session.js';
//   const discordSM = createDiscordSessionManager({
//     modelRuntime, settingsManager, resourceLoader,
//     sessionsIndex, sessions, broadcast,
//   });
//   const { id } = await discordSM.getOrCreate('channel-123', '/home', {
//     guildId: '...', channelId: '...', threadId: '...',
//   });

import crypto from 'node:crypto';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * Generate a unique message/event ID (mirrors crypto.randomUUID usage elsewhere).
 * @returns {string}
 */
function generateMsgId() {
  return crypto.randomUUID();
}

/**
 * Create a Discord session manager.
 *
 * @param {object} options
 * @param {object}   options.modelRuntime    - Shared ModelRuntime instance from server.js
 * @param {object}   options.settingsManager - Shared SettingsManager instance from server.js
 * @param {object}   options.resourceLoader  - Shared DefaultResourceLoader instance from server.js
 * @param {object}   options.sessionsIndex   - Shared SessionsIndex instance from server.js
 * @param {Map}      options.sessions        - Shared sessions Map (server.js's active sessions)
 * @param {Function} options.broadcast       - Shared broadcast function (sends JSON to all WS clients)
 * @param {object}   options.sessionRouter   - Optional SessionRouter instance for registering Discord routes
 * @returns {{
 *   getOrCreate: (routeKey: string, cwd: string, discordInfo?: object) => Promise<{id: string, session: object, sessionManager: object}>,
 *   dispose: (routeKey: string) => Promise<void>,
 *   getSessionManager: (routeKey: string) => object | null,
 * }}
 */
export function createDiscordSessionManager({
  modelRuntime,
  settingsManager,
  resourceLoader,
  sessionsIndex,
  sessions,
  broadcast,
  sessionRouter,  // optional SessionRouter instance
}) {
  // ── Per-manager route cache ────────────────────────────────────────────
  // Maps routeKey → { id, session, sessionManager, sessionState }
  const discordSessions = new Map();

  // ── getOrCreate ────────────────────────────────────────────────────────

  /**
   * Get an existing Discord session for `routeKey` or create a new one.
   *
   * @param {string} routeKey    - Unique identifier for the Discord channel/thread
   * @param {string} cwd         - Working directory for the session
   * @param {object} [discordInfo={}] - Discord metadata { guildId, channelId, threadId }
   * @returns {Promise<{id: string, session: object, sessionManager: object}>}
   */
  async function getOrCreate(routeKey, cwd, discordInfo = {}) {
    // ── Cache hit ──────────────────────────────────────────────────────
    let discordEntry = discordSessions.get(routeKey);
    if (discordEntry) {
      // Touch last-used in the sessions index
      try {
        sessionsIndex.updateLastUsed(discordEntry.id);
        await sessionsIndex.save();
      } catch (_) {
        // non-fatal
      }
      return {
        id: discordEntry.id,
        session: discordEntry.session,
        sessionManager: discordEntry.sessionManager,
      };
    }

    // ── Create new session ─────────────────────────────────────────────
    const sessionManager = SessionManager.create(cwd);

    const { session } = await createAgentSession({
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime,
      excludeTools: ["write", "edit"],
    });

    const id = session.sessionId;
    const now = new Date().toISOString();

    const guildId   = discordInfo.guildId   || null;
    const channelId = discordInfo.channelId || null;
    const threadId  = discordInfo.threadId  || null;

    // ── Register in sessions index ────────────────────────────────────
    const sessionInfo = {
      id,
      name: `discord: ${routeKey}`,
      cwd,
      sessionFile: sessionManager.getSessionFile(),
      model: session.model
        ? { id: session.model.id, name: session.model.name, provider: session.model.provider }
        : { id: '', name: '', provider: '' },
      createdAt: now,
      lastUsedAt: now,
      estimatedTokens: 0,
    };

    sessionsIndex.register(sessionInfo);
    await sessionsIndex.save();

    // ── Build session state (same shape as server.js) ──────────────────
    const sessionState = {
      id,
      session,
      sessionManager,
      name: sessionInfo.name,
      model: session.model,
      isStreaming: false,
      messages: [],
    };

    sessions.set(id, sessionState);
    discordSessions.set(routeKey, {
      id,
      session,
      sessionManager,
      sessionState,
    });

    // ── Subscribe to agent events ──────────────────────────────────────
    session.subscribe((event) => {
      // Keep streaming flag in sync
      switch (event.type) {
        case 'agent_start':
          sessionState.isStreaming = true;
          break;
        case 'agent_end':
        case 'agent_settled':
          sessionState.isStreaming = false;
          break;
      }

      // Forward to all WS clients, decorated with Discord routing metadata
      // so the client (or a Discord bridge) can identify the origin channel.
      broadcast({
        type: 'discord_session_event',
        discordRouteKey: routeKey,
        discordInfo: { guildId, channelId, threadId },
        sessionId: id,
        event,
      });
    });

    // Register route in session router (if provided)
      if (sessionRouter) {
        try {
          sessionRouter.registerRoute(routeKey, id);
        } catch (_) {
          // non-fatal
        }
      }

    return { id, session, sessionManager };
  }

  // ── dispose ─────────────────────────────────────────────────────────────

  /**
   * Dispose and remove a Discord session, cleaning up all tracking structures.
   *
   * @param {string} routeKey - The Discord channel/thread key to remove
   */
  async function dispose(routeKey) {
    const discordEntry = discordSessions.get(routeKey);
    if (!discordEntry) return;

    const { id, session } = discordEntry;

    // Dispose the underlying agent session
    try {
      await session.dispose();
    } catch (e) {
      console.error(`[discord-session] Error disposing session ${id}:`, e.message);
    }

    // Remove from shared server sessions Map
    sessions.delete(id);

    // Remove from discord route cache
    discordSessions.delete(routeKey);

    // Remove from sessions index
    try {
      sessionsIndex.remove(id);
      await sessionsIndex.save();
    } catch (e) {
      console.error(`[discord-session] Error removing ${id} from sessions index:`, e.message);
    }

    // Notify frontend clients
    broadcast({
      type: 'discord_session_closed',
      discordRouteKey: routeKey,
      sessionId: id,
    });
  }

  // ── getSessionManager ───────────────────────────────────────────────────

  /**
   * Retrieve the full session state for a Discord route.
   *
   * Returns the same shape stored in the shared `sessions` Map
   * (i.e. { id, session, sessionManager, name, model, isStreaming, messages }),
   * or `null` if the route has no active session.
   *
   * @param {string} routeKey - The Discord channel/thread key
   * @returns {object|null}
   */
  function getSessionManager(routeKey) {
    const discordEntry = discordSessions.get(routeKey);
    if (!discordEntry) return null;

    // Return from the shared sessions Map so callers always see the
    // authoritative state (including any mutations from event handlers).
    return sessions.get(discordEntry.id) || null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  return {
    getOrCreate,
    dispose,
    getSessionManager,
  };
}
