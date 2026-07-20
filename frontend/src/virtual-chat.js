// ── Virtual chat: pretext-powered measurement + virtualized rendering ─────
// This module provides:
//   1. VirtualList — a virtual scroller that only renders visible messages
//   2. Text measurement using @chenglou/pretext (zero DOM reflow)
//   3. Shrinkwrap — finds tightest bubble width via binary search
//
// Usage:
//   <script src="/virtual-chat.js"></script>
//   // window.VChat is available

import {
  prepare,
  layout,
  prepareWithSegments,
  walkLineRanges,
  measureNaturalWidth,
} from '@chenglou/pretext';

// ── Fonts (must match CSS) ─────────────────────────────────────────────────
// User messages render in Caveat (cursive, 1.25em ≈ 17.5px, line-height 1.3)
const FONT_USER   = `17.5px "Caveat", "Segoe Script", "Bradley Hand", "Comic Neue", cursive`;
const LINE_H_USER = 23; // 17.5 × 1.3 ≈ 22.75, round up to 23

// Assistant/UI text renders in Karla (14px, line-height 1.5)
const FONT_UI   = '14px Karla, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const LINE_H_UI = 21; // 14 × 1.5

const GAP        = 12; // gap between messages
const BUF_PX     = 800; // render buffer in px above/below viewport (larger = smoother scroll)

// ── Measurement cache ──────────────────────────────────────────────────────
const heightCache = new Map();

function cacheKey(text, font, maxWidth) {
  return `${font}|${text.length}|${maxWidth}`;
}

/**
 * Measure the exact height of text at a given width using pretext.
 */
export function measureTextHeight(text, font, maxWidth, lineHeight) {
  if (!text) return 0;
  const key = cacheKey(text, font, maxWidth);
  const cached = heightCache.get(key);
  if (cached !== undefined) return cached;

  const p = prepare(text, font);
  const { height: h } = layout(p, maxWidth, lineHeight);
  heightCache.set(key, h);
  return h;
}

/**
 * Binary search for the tightest width that fits the text without adding
 * more lines than `maxWidth` produces.
 * @param {string} text - The text to measure
 * @param {string} font - CSS font string matching the rendered font
 * @param {number} maxWidth - Maximum available width
 * @param {number} lineHeight - Line height for layout
 * @returns {number} The max line width in pixels
 */
export function findTightWidth(text, font, maxWidth, lineHeight) {
  if (!text) return 0;

  const p = prepare(text, font);
  const initialLines = layout(p, maxWidth, lineHeight).lineCount;

  // Single line — just measure natural width
  if (initialLines <= 1) {
    const pp = prepareWithSegments(text, font);
    return Math.ceil(measureNaturalWidth(pp));
  }

  // Binary search for the narrowest width that keeps the same line count
  let lo = 1;
  let hi = Math.floor(maxWidth);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const lines = layout(p, mid, lineHeight).lineCount;
    if (lines <= initialLines) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  // Measure the actual max line width at this tight width
  const pp = prepareWithSegments(text, font);
  let maxW = 0;
  walkLineRanges(pp, lo, (line) => {
    if (line.width > maxW) maxW = line.width;
  });
  return Math.ceil(maxW);
}

// ── VirtualList ────────────────────────────────────────────────────────────
// A virtual scroller that only creates DOM nodes for messages near the
// viewport. Items are positioned absolutely within the container.
//
// Key design choices for fluidity:
//   - Uses requestAnimationFrame coalescing to avoid layout thrashing
//   - On scroll, items slide in/out without flashes (fadeIn animation via CSS)
//   - Height measurement happens once via DOM on first render, then cached
//   - setItems() is REPLACED by a smarter syncItems() that avoids re-creating
//     already-rendered items when possible
//
// Container must have `position: relative; overflow-y: auto`.
//
// Lifecycle:
//   const vl = new VirtualList(container, { renderItem })
//   vl.setItems(items)           // full replace (use for initial or large changes)
//   vl.syncItems(items)          // smart update — reuses unchanged items (use for append)
//   vl.scrollToBottom()
//   vl.destroy()

export class VirtualList {
  constructor(container, opts = {}) {
    if (!container) throw new Error('VirtualList: container required');
    this.container = container;
    this.renderItem = opts.renderItem || (() => null);
    this.bufferPx = opts.bufferPx || BUF_PX;

    // Item data
    this.items = [];
    this._heights = [];
    this._positions = [];
    this._totalHeight = 0;
    this._rendered = new Map(); // index → { el }
    this._pendingMeasure = new Set();
    this._dirty = true;

    // Horizontal padding for absolute-positioned items
    // Allows aligning VL items with container padding
    this.padLeft = opts.padLeft || 0;
    this.padRight = opts.padRight || 0;

    // Spacer
    this._spacer = this._findOrCreateSpacer();

    // Ensure relative positioning
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }

    // Scroll listener (passive for performance)
    this._boundScroll = () => this._onScroll();
    this.container.addEventListener('scroll', this._boundScroll, { passive: true });

    // ResizeObserver
    this._ro = null;
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._scheduleUpdate());
      this._ro.observe(this.container);
    }

    this._rafId = null;
    this._pendingRaf = null;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Full replace — clears all rendered items and rebuilds.
   * Use for initial render or when items change dramatically.
   */
  setItems(items) {
    this.items = items;
    this._heights = new Array(items.length).fill(null);
    // Carry over known heights from old items by matching identity
    // (Relies on items being the same reference — true for s.messages)
    this._clearRendered();
    this._dirty = true;
    this._scheduleUpdate();
  }

  /**
   * Smart update — only adds/removes items that changed.
   * Items are compared by reference. If an item at index i is the same
   * reference as before, its height and DOM are preserved.
   */
  syncItems(items) {
    const newLen = items.length;
    // Use _heights.length instead of this.items.length because this.items
    // can be the SAME array reference as the source (e.g. s.messages).  When
    // the caller pushes to that array before calling syncItems, this.items
    // is already the new length — so oldLen === newLen and we miss the
    // addition entirely.  _heights is private to the list, so its length is
    // a reliable indicator of how many items the VL knows about.
    const oldLen = this._heights.length;

    // Detect removals (items removed from end)
    if (newLen < oldLen) {
      for (let i = newLen; i < oldLen; i++) {
        if (this._rendered.has(i)) {
          this._rendered.get(i).el.remove();
          this._rendered.delete(i);
        }
      }
      this._heights.length = newLen;
    }

    // Detect additions (items added at end)
    if (newLen > oldLen) {
      for (let i = oldLen; i < newLen; i++) {
        this._heights[i] = null;
      }
    }

    this.items = items;
    this._dirty = true;
    this._scheduleUpdate();
  }

  /**
   * Scroll to bottom smoothly.
   */
  scrollToBottom() {
    requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  /**
   * Mark an item as needing height re-measurement.
   */
  markDirty(index) {
    if (index < 0 || index >= this._heights.length) return;
    this._heights[index] = null;
    if (this._rendered.has(index)) {
      // Re-render this item
      const entry = this._rendered.get(index);
      entry.el.remove();
      this._rendered.delete(index);
    }
    this._dirty = true;
    this._scheduleUpdate();
  }

  /**
   * Get the rendered DOM element for an item, or null if not in view.
   */
  getRendered(index) {
    const entry = this._rendered.get(index);
    return entry ? entry.el : null;
  }

  /**
   * Mark an item's known height as invalid so it gets re-measured.
   * Unlike markDirty, this does NOT remove the DOM element — it just
   * schedules a re-measure. Use after mutating content in place.
   */
  invalidateHeight(index) {
    if (index < 0 || index >= this._heights.length) return;
    this._heights[index] = null;
    if (this._rendered.has(index)) {
      this._pendingMeasure.add(index);
      this._flushPendingMeasures();
    }
    this._dirty = true;
    this._scheduleUpdate();
  }

  /** Clean up */
  destroy() {
    this.container.removeEventListener('scroll', this._boundScroll);
    if (this._ro) this._ro.disconnect();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._pendingRaf) cancelAnimationFrame(this._pendingRaf);
    this._clearRendered();
    if (this._spacer && this._spacer.parentNode) this._spacer.remove();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _findOrCreateSpacer() {
    let el = document.getElementById('vl-spacer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vl-spacer';
      el.style.cssText = 'pointer-events:none;height:0;';
      this.container.insertBefore(el, this.container.firstChild);
    }
    return el;
  }

  _clearRendered() {
    for (const [, entry] of this._rendered) {
      if (entry.el.parentNode) entry.el.remove();
    }
    this._rendered.clear();
  }

  _scheduleUpdate() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._doUpdate();
    });
  }

  _doUpdate() {
    this._recalc();
    this._updateVisibleRange();
    this._flushPendingMeasures();
  }

  _onScroll() {
    this._recalc();
    this._updateVisibleRange();
    this._flushPendingMeasures();
  }

  _recalc() {
    const count = this.items.length;
    this._positions = new Array(count);
    let y = 0;
    for (let i = 0; i < count; i++) {
      this._positions[i] = y;
      const h = this._heights[i];
      y += (h !== null && h > 0 ? h : 80) + GAP;
    }
    this._totalHeight = count > 0 ? y - GAP : 0;

    if (this._spacer) {
      this._spacer.style.height = `${this._totalHeight}px`;
    }
    this._dirty = false;
  }

  _updateVisibleRange() {
    const count = this.items.length;
    if (count === 0) {
      this._clearRendered();
      return;
    }

    const container = this.container;
    const st = container.scrollTop;
    const vh = container.clientHeight || 400;
    const topBound = Math.max(0, st - this.bufferPx);
    const botBound = st + vh + this.bufferPx;

    // Binary search for start
    let start = 0, end = count;

    // start: first item with position >= topBound
    {
      let lo = 0, hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this._positions[mid] < topBound) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }

    // end: first item with position > botBound
    {
      let lo = 0, hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this._positions[mid] < botBound) lo = mid + 1;
        else hi = mid;
      }
      // lo is the first item whose position is >= botBound.
      // We want to include items whose top is before botBound, so end = lo + 1
      // But also include items that start before botBound and might extend past it.
      // Since we have the buffer, lo already includes partially visible items.
      // However, if the last visible item starts before botBound and extends past it,
      // we want to include it. lo includes this because positions[mid] < botBound.
      // So end = lo (which excludes items that start AT or AFTER botBound).
      // Wait, lo is the first with position >= botBound. So items [0, lo-1] start before botBound.
      // We want to include those. So end = lo.
      // But also include the item AT lo if it starts close to botBound (buffer handles this).
      // Since buffer adds to botBound, lo already accounts for it.
      end = Math.min(count, lo);
    }

    // Safety: ensure we don't narrow too aggressively
    if (start > 0) start = Math.max(0, start - 1); // one extra above for safety
    if (end < count) end = Math.min(count, end + 1); // one extra below for safety

    // Remove out-of-range items
    const toRemove = [];
    for (const [index] of this._rendered) {
      if (index < start || index >= end) {
        toRemove.push(index);
      }
    }
    for (const index of toRemove) {
      const entry = this._rendered.get(index);
      if (entry && entry.el.parentNode) {
        entry.el.remove();
      }
      this._rendered.delete(index);
    }

    // Add items in range
    for (let i = start; i < end && i < count; i++) {
      if (this._rendered.has(i)) continue;

      const el = this.renderItem(this.items[i], i);
      if (!el) continue;

      // Fluid: apply fadeIn animation for new items
      el.style.animation = 'fadeIn 0.2s ease';

      // Position absolutely, respecting container padding.
      // User bubbles are left-aligned: pin to left, right auto so
      // fit-content width honored on the right edge.
      el.style.position = 'absolute';
      el.style.top = `${this._positions[i]}px`;
      if (el.classList && el.classList.contains('user')) {
        el.style.left = `${this.padLeft}px`;
        el.style.right = 'auto';
      } else {
        el.style.left = `${this.padLeft}px`;
        el.style.right = `${this.padRight}px`;
      }

      this.container.appendChild(el);
      this._rendered.set(i, { el });

      // Queue height measurement if unknown
      if (this._heights[i] === null || this._heights[i] <= 0) {
        this._pendingMeasure.add(i);
      }
    }
  }

  _flushPendingMeasures() {
    if (this._pendingMeasure.size === 0) return;
    if (this._pendingRaf) return;

    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = null;
      this._doPendingMeasures();
    });
  }

  _doPendingMeasures() {
    let changed = false;

    for (const index of this._pendingMeasure) {
      const entry = this._rendered.get(index);
      if (!entry || !entry.el || !entry.el.parentNode) continue;

      const h = entry.el.offsetHeight;
      if (h > 0) {
        this._heights[index] = h;
        changed = true;
      }
    }
    this._pendingMeasure.clear();

    if (changed) {
      this._dirty = true;
      this._recalc();
      // Reposition all rendered items
      for (const [i, entry] of this._rendered) {
        if (this._positions[i] !== undefined) {
          entry.el.style.top = `${this._positions[i]}px`;
        }
      }
    }
  }
}

// ── Convenience helpers for app.js ────────────────────────────────────────

/**
 * Get the user message font string matching CSS --font-user.
 * Uses Caveat at 17.5px (1.25em).
 */
function getUserFont() {
  return FONT_USER;
}

function getUserLineHeight() {
  return LINE_H_USER;
}

function getUiFont() {
  return FONT_UI;
}

function getUiLineHeight() {
  return LINE_H_UI;
}

// ── Expose to window ───────────────────────────────────────────────────────
const VChat = {
  measureTextHeight,
  findTightWidth,
  VirtualList,
  getUserFont,
  getUserLineHeight,
  getUiFont,
  getUiLineHeight,
  FONT_USER,
  LINE_H_USER,
  FONT_UI,
  LINE_H_UI,
  GAP,
};

if (typeof window !== 'undefined') {
  window.VChat = VChat;
}

export default VChat;
