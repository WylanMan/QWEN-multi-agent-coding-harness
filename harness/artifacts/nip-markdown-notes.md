# Negotiated Implementation Plan

**Goal:** Build a markdown note-taking app. Single HTML file, no build tools, no framework.
**Complexity:** small
**Budget:** 2h
**Timestamp:** 2026-07-20T16:00:00Z
**Status:** signed

## Scope
Single HTML file at `/home/cman/.pi/harness/workspace/markdown-notes.html` with:
- Create, edit, delete, view notes via localStorage persistence
- 5 internal modules: Store, Router, Renderer, Handlers, MarkdownParser
- Global `App` namespace (no IIFE, no modules)
- Event delegation via `data-action`/`data-id` attributes
- Three views: list, view, edit (create = edit with blank note)

**Applied scope trims (per Engineer):**
- Markdown: #/##/###, **bold**, *italic*, `code`, ```fenced```, [links](url), > blockquote, --- hr, - unordered lists only
- No animations/transitions (instant DOM swaps)
- No ordered lists, images, nested formatting
- Document known markdown limitations in comments

## Interface Contracts
Per Architect's design:
- **Store:** `Note{id, title, content, createdAt, updatedAt}`, `getAllNotes()`, `getNote(id)`, `saveNote(note)`, `deleteNote(id)`, `generateId()`, `createNote(title,content)`, `updateNote(id, updates)`
- **Router:** `navigate(view, noteId?)` → triggers re-render, states: "list", "view", "edit"
- **Renderer:** `render()`, `renderList(filter?)`, `renderView(id)`, `renderEdit(id?)`
- **Handlers:** event delegation on `#app`, 11 handlers via `data-action`
- **MarkdownParser:** `renderMarkdown(md): string` — HTML-safe, the 8 syntax elements above

## Acceptance Criteria
1. Open HTML file in browser → see empty list with "New Note" button
2. Create note → type title/content in markdown → save → see in list
3. Click note → view rendered markdown → edit → change content → save
4. Delete note → confirm → removed from list
5. Search/filter in list view
6. All error states handled (empty save, corrupted localStorage, quota exceeded)
7. Markdown renders correctly for all supported syntax
8. XSS: `<script>alert(1)</script>` in content must NOT execute

## Signatures
- **Manager:** ✓ (scope trimmed per Engineer feasibility)
- **Architect:** assent (no objections to scope trim — preserves UX intent)
- **Engineer:** assent (feasible within 2h with trims)
