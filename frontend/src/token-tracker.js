// ── TokenTracker ──────────────────────────────────────────────────────────
// Keeps sessionsIndex.estimatedTokens accurate by debouncing recount calls
// on message updates and flushing immediately on agent_settled.
//
// Usage:
//   import { createTokenTracker } from './token-tracker.js';
//   const tracker = createTokenTracker({ sessionsIndex, sessions });
//   // Wire into event handlers:
//   tracker.onMessageUpdate(sessionId);  // on message_update
//   tracker.onSettled(sessionId);        // on agent_settled

/**
 * Rough token estimate based on character count.  ~4 chars per token is
 * a common rule-of-thumb for English text.
 */
function estimateTokens(entries) {
  return Math.ceil(JSON.stringify(entries).length / 4);
}

/**
 * Create a TokenTracker instance.
 *
 * @param {object} options
 * @param {object}   options.sessionsIndex - Shared SessionsIndex instance
 * @param {Map}      options.sessions      - Shared sessions Map (session id → { sessionManager, ... })
 * @returns {{
 *   onMessageUpdate: (sessionId: string) => void,
 *   onSettled:       (sessionId: string) => void,
 *   flushNow:        (sessionId: string) => void,
 * }}
 */
export function createTokenTracker({ sessionsIndex, sessions, onUpdate }) {
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const debounceTimers = new Map();

  // ── _recount ───────────────────────────────────────────────────────────

  /**
   * Perform an immediate recount for a given session.
   *
   * Retrieves the session manager from the shared sessions Map, fetches
   * entries, runs estimateTokens, and updates the fork registry.
   *
   * Failures are silently caught so that a misbehaving session never
   * crashes the caller.
   *
   * @param {string} sessionId
   */
  function _recount(sessionId) {
    try {
      const sessionState = sessions.get(sessionId);
      if (!sessionState) return;

      const sessionManager = sessionState.sessionManager;
      if (!sessionManager || typeof sessionManager.getEntries !== 'function') return;

      const entries = sessionManager.getEntries();
      if (!Array.isArray(entries)) return;

      const tokens = estimateTokens(entries);

      sessionsIndex.updateTokenCount(sessionId, tokens);
      if (onUpdate) {
        try { onUpdate(sessionId, tokens); } catch {}
      }
      sessionsIndex.save().catch(() => {
        // Non-fatal: persistence failure should not interrupt the caller
      });
    } catch {
      // Swallow any error during recount so the caller is never disrupted
    }
  }

  // ── _clearTimer ────────────────────────────────────────────────────────

  /**
   * Cancel any pending debounce timer for a session, if one exists.
   *
   * @param {string} sessionId
   */
  function _clearTimer(sessionId) {
    const timer = debounceTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.delete(sessionId);
    }
  }

  // ── onMessageUpdate ────────────────────────────────────────────────────

  /**
   * Called on message_update events.
   *
   * Resets the per-session debounce timer. The recount fires 3 seconds
   * after the last update for that session.
   *
   * @param {string} sessionId
   */
  function onMessageUpdate(sessionId) {
    // Cancel any pending timer so we start a fresh 3s window
    _clearTimer(sessionId);

    const timer = setTimeout(() => {
      debounceTimers.delete(sessionId);
      _recount(sessionId);
    }, 3000);

    debounceTimers.set(sessionId, timer);
  }

  // ── onSettled ──────────────────────────────────────────────────────────

  /**
   * Called on agent_settled events.
   *
   * Cancels any pending debounce and recounts immediately so the fork
   * registry reflects the final state right away.
   *
   * @param {string} sessionId
   */
  function onSettled(sessionId) {
    _clearTimer(sessionId);
    _recount(sessionId);
  }

  // ── flushNow ───────────────────────────────────────────────────────────

  /**
   * Force an immediate recount for a session, regardless of any pending
   * debounce timer.
   *
   * @param {string} sessionId
   */
  function flushNow(sessionId) {
    _clearTimer(sessionId);
    _recount(sessionId);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    onMessageUpdate,
    onSettled,
    flushNow,
  };
}

export default createTokenTracker;
