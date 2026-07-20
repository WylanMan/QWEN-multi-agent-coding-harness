// ── SessionRouter ─────────────────────────────────────────────────────────
// Central routing authority for dispatching messages to sessions.
// Replaces the ad-hoc clientActiveSessions map in server.js and provides
// a single place to resolve which session a message should go to.
//
// Usage:
//   import { SessionRouter } from './session-router.js';
//   const router = new SessionRouter();
//
//   // On WebSocket connect:
//   const clientId = crypto.randomUUID();
//   router.setClientContext(ws, 'ws:' + clientId);
//
//   // On Discord bridge route creation:
//   router.registerRoute('g:guildId:channelId', sessionId);
//
//   // On message dispatch:
//   const sessionId = router.resolveWithFallback(ws.routeKey) || data.sessionId;

/**
 * Central router for mapping route keys to session IDs.
 *
 * Route keys are strings that identify where a message came from:
 * - `"ws:<uuid>"` — a WebSocket client (each browser tab gets its own)
 * - `"g:<guildId>:<channelId>"` — a Discord guild channel
 * - `"dm:<userId>"` — a Discord DM
 * - `"cli:<sessionId>"` — CLI / terminal
 */
export class SessionRouter {
  /** @type {Map<string, string>} */
  #routes;

  /** @type {string|null} */
  #defaultSession;

  constructor() {
    this.#routes = new Map();
    this.#defaultSession = null;
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Map a route key to a session ID.  If the key already exists, update the
   * mapping.
   *
   * @param {string} key       - Route key (e.g. "ws:abc-123")
   * @param {string} sessionId - Session ID to map to
   */
  registerRoute(key, sessionId) {
    this.#routes.set(key, sessionId);
  }

  /**
   * Remove a route mapping.
   *
   * @param   {string} key - Route key to remove
   * @returns {string|null} The sessionId that was mapped, or null if not found
   */
  unregisterRoute(key) {
    const sessionId = this.#routes.get(key) ?? null;
    this.#routes.delete(key);
    return sessionId;
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  /**
   * Given a route key, return the session ID it's mapped to.
   *
   * @param   {string} key - Route key
   * @returns {string|null} The mapped sessionId, or null
   */
  resolve(key) {
    return this.#routes.get(key) ?? null;
  }

  /**
   * Like resolve(key) but falls back to the default session if the key
   * isn't registered.
   *
   * @param   {string} key - Route key
   * @returns {string|null} Session ID or default, or null if neither exists
   */
  resolveWithFallback(key) {
    return this.#routes.get(key) ?? this.#defaultSession;
  }

  // ── Default session ─────────────────────────────────────────────────────

  /**
   * Set a fallback session ID for when no route matches.
   *
   * @param   {string} sessionId - Session ID to use as default
   * @returns {string|null} The previous default session ID
   */
  setDefaultSession(sessionId) {
    const previous = this.#defaultSession;
    this.#defaultSession = sessionId;
    return previous;
  }

  /**
   * Get the current default session ID.
   *
   * @returns {string|null}
   */
  getDefaultSession() {
    return this.#defaultSession;
  }

  // ── WebSocket helpers ──────────────────────────────────────────────────

  /**
   * Convenience: given a WebSocket object with `ws.routeKey` set, returns
   * resolveWithFallback(ws.routeKey).
   *
   * @param   {object} ws - WebSocket-like object with a `routeKey` property
   * @returns {string|null}
   */
  getActiveForClient(ws) {
    return this.resolveWithFallback(ws.routeKey);
  }

  /**
   * Sets `ws.routeKey = key` on the WebSocket object.
   *
   * @param {object} ws  - WebSocket-like object
   * @param {string} key - Route key to assign
   */
  setClientContext(ws, key) {
    ws.routeKey = key;
  }

  // ── Introspection & cleanup ────────────────────────────────────────────

  /**
   * Returns a shallow copy of the route map.
   *
   * @returns {Record<string, string>} { [key]: sessionId }
   */
  getAllRoutes() {
    return Object.fromEntries(this.#routes);
  }

  /**
   * Returns a reverse map: { [sessionId]: [key1, key2, ...] }.
   * Useful for cleaning up all routes pointing to a session when it's
   * disposed.
   *
   * @returns {Record<string, string[]>}
   */
  getReverseMap() {
    /** @type {Record<string, string[]>} */
    const reverse = {};
    for (const [key, sessionId] of this.#routes) {
      if (!reverse[sessionId]) {
        reverse[sessionId] = [];
      }
      reverse[sessionId].push(key);
    }
    return reverse;
  }

  /**
   * Remove all route keys that point to the given sessionId.  Useful for
   * cleanup when a session is deleted.
   *
   * @param   {string} sessionId - Session ID whose routes should be removed
   * @returns {number} Number of routes removed
   */
  removeSessionRoutes(sessionId) {
    let removed = 0;
    for (const [key, sid] of this.#routes) {
      if (sid === sessionId) {
        this.#routes.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
