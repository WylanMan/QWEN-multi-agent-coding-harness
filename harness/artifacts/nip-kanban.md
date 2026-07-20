# Negotiated Implementation Plan

**Goal:** WebSocket-based collaborative Kanban board — real-time multi-user card management
**Complexity:** medium
**Budget:** 6h (Engineer estimate: 7.25h → requires 1.25h cuts)
**Timestamp:** 2026-07-20T17:45:00Z
**Status:** draft (Round 2 — pending objections)

## Scope (with Engineer-imposed cuts)

### IN SCOPE
- Single HTML frontend + Node.js backend (express + ws)
- 3 columns: To Do, In Progress, Done (hard-coded)
- Create, move (between columns), delete cards
- Real-time WebSocket sync — 4 client→server + 8 server→client message types
- User presence indicators (colored circles, join/leave animations)
- Undo last action (per-user, depth=1, Ctrl+Z)
- Drag-and-drop between columns (HTML5 DnD, desktop only)
- **Markdown card descriptions** (hand-rolled ~50 lines, no library)
- Optimistic UI with server error correction
- Last-write-wins conflict resolution
- Dark "Workshop Wall" visual design (per Architect)
- In-memory only (no persistence)
- Name-on-join (no auth)

### CUT (per Engineer — saves 2.75h out of needed 1.25h)
- ~~No within-column card reordering~~ (0.5h)
- ~~No multi-board/rooms~~ (0.75h)
- ~~No mobile/touch support~~ (0.5h)
- ~~No auth~~ (0.5h)
- ~~No automated tests~~ (0.5h)

### CONTENTIOUS (needs resolution)
- **Markdown descriptions** — Architect: essential for card richness. Engineer: cut to save 0.5h. 
  **Manager proposal:** Keep markdown. Engineer's cuts already save 2.75h against a 1.25h gap. Net: +1.5h buffer.

## Interface Contracts (Architect L3)

### WebSocket Protocol
```
Server→Client:
  init: {type:"init", board:{columns:[{id,name,cards:[...]}]}, users:[{id,name,color}]}
  cardCreated: {type:"cardCreated", card:{id,columnId,title,content,authorId,createdAt}}
  cardUpdated: {type:"cardUpdated", card:{id,title?,content?}}
  cardMoved: {type:"cardMoved", cardId,fromColumnId,toColumnId,index}
  cardDeleted: {type:"cardDeleted", cardId}
  undoApplied: {type:"undoApplied", action:{type:"create"|"move"|"delete", cardId,...}}
  userJoined: {type:"userJoined", user:{id,name,color}}
  userLeft: {type:"userLeft", userId}
  error: {type:"error", code:"CONFLICT"|"INVALID"|"RATE_LIMIT", message}

Client→Server:
  createCard: {type:"createCard", columnId, title, content}
  moveCard: {type:"moveCard", cardId, toColumnId}
  deleteCard: {type:"deleteCard", cardId}
  undo: {type:"undo"}
```

### Data Structures (Engineer L3)
```
Card: {id:string, columnId:string, title:string, content:string, authorId:string, authorName:string, createdAt:string}
User: {id:string, name:string, color:string, lastActiveAt:string}
Column: {id:string, name:string, cards:Card[]}
Board: {columns:Column[], users:User[]}
```

## Estimates (Engineer)

| Module | Estimate |
|---|---|
| WebSocket server | 0.75h |
| Board state + protocol | 0.75h |
| Frontend HTML/CSS | 1.0h |
| Frontend WS client + render | 0.75h |
| Drag-and-drop (HTML5 DnD) | 1.0h |
| User presence | 0.5h |
| Undo | 0.75h |
| Markdown (hand-rolled) | 0.5h |
| Integration + edge cases | 0.75h |
| **Total** | **7.25h → 6.0h after cuts** |

## Acceptance Criteria
1. Open in 2 browser tabs → both see same board
2. Create card in tab A → appears in tab B instantly
3. Drag card between columns → both tabs update
4. Delete card → undo via Ctrl+Z → restored
5. Presence: colored circles show active users
6. Disconnect → reconnect → board resyncs
7. Markdown renders: bold, italic, code, links
8. No page reload needed for any operation

## Signatures
- **Manager:** pending
- **Architect:** pending objections
- **Engineer:** pending objections
