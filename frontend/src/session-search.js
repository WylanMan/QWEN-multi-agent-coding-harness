// ── SessionSearch: full-text search across session JSONL files ───────────
// Searches all session files stored in the pi agent sessions directory.
//
// Usage:
//   import { SessionSearch } from './session-search.js';
//   const search = new SessionSearch({ sessionsIndex });
//   const { results, totalMatches } = await search.search('some query');
//
//   // Regex search:
//   const { results } = await search.searchByRegex(/some pattern/i);

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return a snippet of text around a match position, with the match
 * wrapped in ** markers for highlighting.
 */
function _snippet(text, index, query, contextChars = 40) {
  const start = Math.max(0, index - contextChars);
  const end = Math.min(text.length, index + query.length + contextChars);

  let snippet = text.slice(start, end);

  // Insert highlight markers around the match within the snippet
  const matchIdx = index - start;
  const before = snippet.slice(0, matchIdx);
  const match = snippet.slice(matchIdx, matchIdx + query.length);
  const after = snippet.slice(matchIdx + query.length);

  return (start > 0 ? '…' : '') + before + '**' + match + '**' + after + (end < text.length ? '…' : '');
}

// ── SessionSearch ──────────────────────────────────────────────────────────

export class SessionSearch {
  /**
   * @param {object}   opts
   * @param {object}   opts.sessionsIndex - SessionsIndex instance for session name/id/cwd lookups
   * @param {string}  [opts.agentDir] - Agent directory (default: getAgentDir())
   */
  constructor({ sessionsIndex, agentDir }) {
    this._sessionsIndex = sessionsIndex;
    this._agentDir = agentDir ?? getAgentDir();
    this._sessionsDir = join(this._agentDir, 'sessions');

    // Simple timestamp-based cache for file scans
    this._lastFileScan = 0;
    this._cachedFiles = null;
    this._scanCacheMs = 30_000;

    // Reverse lookup: sessionFile path → session record
    this._fileToSession = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Search all session files for a plain-text query (case-insensitive).
   *
   * @param   {string}  query   - Search string
   * @param   {object}  [options]
   * @param   {number}  [options.limit=20]       - Max results to return
   * @param   {number}  [options.maxPerSession=5] - Max matches per session
   * @param   {string}  [options.sessionId]      - If provided, only search this session
   * @returns {Promise<{ results: Array, totalMatches: number }>}
   */
  async search(query, options = {}) {
    if (!query || query.trim().length === 0) {
      return { results: [], totalMatches: 0 };
    }

    const lowerQuery = query.toLowerCase();
    return this._executeSearch(lowerQuery, options, (entry, q) => this._matchEntry(entry, q));
  }

  /**
   * Search all session files using a RegExp pattern (case-insensitive).
   *
   * @param   {RegExp|string} pattern - RegExp or string pattern
   * @param   {object}        [options] - Same options as search()
   * @returns {Promise<{ results: Array, totalMatches: number }>}
   */
  async searchByRegex(pattern, options = {}) {
    const regex = pattern instanceof RegExp
      ? new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : pattern.flags + 'i')
      : new RegExp(pattern, 'i');

    return this._executeSearch(regex, options, (entry, re) => this._matchEntryRegex(entry, re));
  }

  // ── Core search engine ──────────────────────────────────────────────────

  /**
   * Shared search engine. Walks session files, matches entries using the
   * provided matcher function, and collects results.
   *
   * @param   {string|RegExp} query
   * @param   {object}        options
   * @param   {Function}      matcherFn - (entry, query) => Array<{field, index, context}>
   * @returns {Promise<{ results: Array, totalMatches: number }>}
   */
  async _executeSearch(query, options, matcherFn) {
    const limit = options.limit ?? 20;
    const maxPerSession = options.maxPerSession ?? 5;
    const targetSessionId = options.sessionId ?? null;

    // Get all session files
    const allFiles = await this._scanSessionFiles();

    // Build reverse lookup from sessionFile → session record
    this._buildFileToSessionMap();

    let totalMatches = 0;
    /** @type {Array<{ sessionFile: string, sessionName: string, sessionId: string, cwd: string, matchCount: number, matches: Array }>} */
    const results = [];

    for (const { filePath } of allFiles) {
      // Resolve session info for this file
      const sessionInfo = this._fileToSession.get(filePath);
      const sessionId = sessionInfo?.id ?? null;
      const sessionName = sessionInfo?.name ?? relative(this._sessionsDir, filePath);
      const cwd = sessionInfo?.cwd ?? '';

      // If a specific sessionId was requested, skip others
      if (targetSessionId && sessionId !== targetSessionId) continue;

      const fileMatches = [];
      let fileMatchCount = 0;

      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        // Defense: cap total matches per file for very large files
        const MAX_FILE_MATCHES = 500;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum].trim();
          if (!line) continue;

          let entry;
          try {
            entry = JSON.parse(line);
          } catch (_parseErr) {
            // Corrupted line — skip silently
            continue;
          }

          // Only search message-type entries
          if (entry.type !== 'message') continue;
          if (!entry.message) continue;

          // Skip entries without a useful role
          const role = entry.message.role;
          if (!role) continue;

          const matchFields = matcherFn(entry, query);
          if (matchFields.length === 0) continue;

          // Build match objects for this entry
          for (const mf of matchFields) {
            if (fileMatchCount >= MAX_FILE_MATCHES) break;

            fileMatchCount++;
            totalMatches++;

            fileMatches.push({
              entryId: entry.id,
              timestamp: entry.timestamp,
              role,
              snippet: mf.snippet,
              line: lineNum + 1,
            });

            // Stop adding matches for this session if we hit maxPerSession
            if (fileMatches.length >= maxPerSession) break;
          }

          if (fileMatchCount >= MAX_FILE_MATCHES) break;
          if (fileMatches.length >= maxPerSession) break;
        }
      } catch (_err) {
        // Missing or unreadable file — skip silently
        continue;
      }

      if (fileMatches.length > 0) {
        results.push({
          sessionFile: filePath,
          sessionName,
          sessionId: sessionId ?? '',
          cwd,
          matchCount: fileMatchCount,
          matches: fileMatches,
        });
      }
    }

    // Sort results by match count descending
    results.sort((a, b) => b.matchCount - a.matchCount);

    // Apply global limit
    const limitedResults = results.slice(0, limit);

    return { results: limitedResults, totalMatches };
  }

  // ── Entry matching ──────────────────────────────────────────────────────

  /**
   * Check if any text field in the entry contains the query string (case-insensitive).
   *
   * @param   {object} entry - Parsed JSON entry from a session file
   * @param   {string} query - Lowercased query string
   * @returns {Array<{ field: string, index: number, snippet: string }>}
   */
  _matchEntry(entry, query) {
    /** @type {Array<{ field: string, index: number, snippet: string }>} */
    const matches = [];

    // Walk all content blocks in the message
    const content = entry.message.content;
    if (!Array.isArray(content)) return matches;

    for (const block of content) {
      // Skip binary/image blocks
      if (block.type === 'image' || block.type === 'binary' || block.type === 'image_url') {
        continue;
      }

      // Check text field
      if (block.text && typeof block.text === 'string') {
        const idx = _findIndex(block.text, query);
        if (idx >= 0) {
          matches.push({
            field: 'text',
            index: idx,
            snippet: _snippet(block.text, idx, query),
          });
        }
      }

      // Check thinking field
      if (block.thinking && typeof block.thinking === 'string') {
        const idx = _findIndex(block.thinking, query);
        if (idx >= 0) {
          matches.push({
            field: 'thinking',
            index: idx,
            snippet: _snippet(block.thinking, idx, query),
          });
        }
      }

      // Check generic content field (string)
      if (block.content && typeof block.content === 'string') {
        const idx = _findIndex(block.content, query);
        if (idx >= 0) {
          matches.push({
            field: 'content',
            index: idx,
            snippet: _snippet(block.content, idx, query),
          });
        }
      }
    }

    return matches;
  }

  /**
   * Check if any text field matches a RegExp.
   *
   * @param   {object} entry
   * @param   {RegExp} regex
   * @returns {Array<{ field: string, index: number, snippet: string }>}
   */
  _matchEntryRegex(entry, regex) {
    /** @type {Array<{ field: string, index: number, snippet: string }>} */
    const matches = [];

    const content = entry.message.content;
    if (!Array.isArray(content)) return matches;

    for (const block of content) {
      if (block.type === 'image' || block.type === 'binary' || block.type === 'image_url') {
        continue;
      }

      if (block.text && typeof block.text === 'string') {
        const m = regex.exec(block.text);
        if (m) {
          matches.push({
            field: 'text',
            index: m.index,
            snippet: _snippet(block.text, m.index, m[0]),
          });
        }
      }

      if (block.thinking && typeof block.thinking === 'string') {
        const m = regex.exec(block.thinking);
        if (m) {
          matches.push({
            field: 'thinking',
            index: m.index,
            snippet: _snippet(block.thinking, m.index, m[0]),
          });
        }
      }

      if (block.content && typeof block.content === 'string') {
        const m = regex.exec(block.content);
        if (m) {
          matches.push({
            field: 'content',
            index: m.index,
            snippet: _snippet(block.content, m.index, m[0]),
          });
        }
      }
    }

    return matches;
  }

  // ── File scanning ───────────────────────────────────────────────────────

  /**
   * Walk sessionsDir recursively (max depth 2), return array of
   * `{ filePath, stat }` for all `.jsonl` files.
   * Results are cached for 30 seconds.
   *
   * @returns {Promise<Array<{ filePath: string, stat: import('fs').Stats }>>}
   */
  async _scanSessionFiles() {
    const now = Date.now();

    // Return cached result if still fresh
    if (this._cachedFiles && (now - this._lastFileScan) < this._scanCacheMs) {
      return this._cachedFiles;
    }

    /** @type {Array<{ filePath: string, stat: import('fs').Stats }>} */
    const results = [];

    try {
      const sessionDirs = await readdir(this._sessionsDir, { withFileTypes: true });

      for (const dirent of sessionDirs) {
        if (!dirent.isDirectory()) continue;

        const dirPath = join(this._sessionsDir, dirent.name);
        let files;
        try {
          files = await readdir(dirPath, { withFileTypes: true });
        } catch (_err) {
          // Skip unreadable directories
          continue;
        }

        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.jsonl')) continue;

          const filePath = join(dirPath, file.name);
          try {
            const fileStat = await stat(filePath);
            results.push({ filePath, stat: fileStat });
          } catch (_err) {
            // Skip unreadable files
            continue;
          }
        }
      }
    } catch (_err) {
      // sessionsDir might not exist yet
    }

    // Sort by modification time descending (most recent first)
    results.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    // Update cache
    this._cachedFiles = results;
    this._lastFileScan = now;

    return results;
  }

  // ── Registry reverse lookup ─────────────────────────────────────────────

  /**
   * Build a Map from absolute sessionFile path → session record.
   * Called lazily before each search.
   */
  _buildFileToSessionMap() {
    this._fileToSession = new Map();

    if (!this._sessionsIndex || !this._sessionsIndex.data) return;

    const sessions = this._sessionsIndex.data.sessions;
    if (!sessions) return;

    for (const [_id, record] of Object.entries(sessions)) {
      if (record.sessionFile) {
        this._fileToSession.set(record.sessionFile, record);
      }
    }
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Case-insensitive indexOf for a string.
 *
 * @param   {string} text
 * @param   {string} query - Lowercased query
 * @returns {number} Index of match, or -1
 */
function _findIndex(text, query) {
  const lowerText = text.toLowerCase();
  return lowerText.indexOf(query);
}

export default SessionSearch;
