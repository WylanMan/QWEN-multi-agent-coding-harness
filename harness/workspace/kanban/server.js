const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ─── Colour pool for user indicators ────────────────────────────────────────
const USER_COLORS = [
  '#FF6B6B', // red
  '#F9C74F', // yellow
  '#43AA8B', // green
  '#7B8CDE', // blue
  '#E8A0BF', // pink
  '#A8D8EA', // cyan
];

/** @typedef {{ id:string, name:string, color:string }} User */
/** @typedef {{ id:string, columnId:string, title:string, content:string, authorId:string, authorName:string, createdAt:string }} Card */
/** @typedef {{ id:string, name:string, cards:Card[] }} Column */
/** @typedef {{ columns:Column[] }} Board */

/**
 * Manages the Kanban board state — columns and cards.
 */
class Board {
  constructor() {
    /** @type {Column[]} */
    this.columns = [
      { id: 'todo', name: 'To Do', cards: [] },
      { id: 'inprogress', name: 'In Progress', cards: [] },
      { id: 'done', name: 'Done', cards: [] },
    ];
  }

  /**
   * Get a column by ID.
   * @param {string} id
   * @returns {Column|undefined}
   */
  getColumn(id) {
    return this.columns.find(c => c.id === id);
  }

  /**
   * Find the column that contains a card.
   * @param {string} cardId
   * @returns {{ column:Column, card:Card }|null}
   */
  findCard(cardId) {
    for (const col of this.columns) {
      const card = col.cards.find(c => c.id === cardId);
      if (card) return { column: col, card };
    }
    return null;
  }

  /**
   * Create a card in a column.
   * @param {string} columnId
   * @param {string} title
   * @param {string} content
   * @param {string} authorId
   * @param {string} authorName
   * @returns {Card|null} The created card, or null if column not found.
   */
  createCard(columnId, title, content, authorId, authorName) {
    const col = this.getColumn(columnId);
    if (!col) return null;

    const card = {
      id: uuidv4(),
      columnId,
      title: title || 'Untitled',
      content: content || '',
      authorId,
      authorName,
      createdAt: new Date().toISOString(),
    };
    col.cards.push(card);
    return card;
  }

  /**
   * Move a card from its current column to a target column.
   * @param {string} cardId
   * @param {string} toColumnId
   * @returns {{ card:Card, fromColumnId:string }|null}
   */
  moveCard(cardId, toColumnId) {
    const found = this.findCard(cardId);
    if (!found) return null;
    if (!this.getColumn(toColumnId)) return null;

    const { column: fromCol, card } = found;
    if (fromCol.id === toColumnId) return null; // no-op

    // Remove from source
    fromCol.cards = fromCol.cards.filter(c => c.id !== cardId);
    // Update card's columnId
    card.columnId = toColumnId;
    // Append to target
    const toCol = this.getColumn(toColumnId);
    toCol.cards.push(card);

    return { card, fromColumnId: fromCol.id };
  }

  /**
   * Delete a card from the board.
   * @param {string} cardId
   * @returns {{ card:Card, columnId:string }|null}
   */
  deleteCard(cardId) {
    const found = this.findCard(cardId);
    if (!found) return null;

    const { column, card } = found;
    column.cards = column.cards.filter(c => c.id !== cardId);
    return { card, columnId: column.id };
  }

  /**
   * Export the board state for serialisation.
   * @returns {Board}
   */
  toJSON() {
    return { columns: this.columns };
  }
}

/**
 * Tracks connected users and broadcasts presence events.
 */
class PresenceManager {
  constructor() {
    /** @type {Map<string, { ws:import('ws').WebSocket, user:User }>} */
    this.connections = new Map();
    this.colorIndex = 0;
  }

  /**
   * Generate a name entry for a new user. Reuses colour from pool.
   * @param {import('ws').WebSocket} ws
   * @param {string} name
   * @returns {User}
   */
  addUser(ws, name) {
    const id = uuidv4();
    const color = USER_COLORS[this.colorIndex % USER_COLORS.length];
    this.colorIndex++;
    /** @type {User} */
    const user = { id, name, color };
    this.connections.set(id, { ws, user });
    return user;
  }

  /**
   * Remove a user by ID.
   * @param {string} id
   * @returns {User|null}
   */
  removeUser(id) {
    const entry = this.connections.get(id);
    if (!entry) return null;
    this.connections.delete(id);
    return entry.user;
  }

  /**
   * Get a user by WebSocket.
   * @param {import('ws').WebSocket} ws
   * @returns {User|undefined}
   */
  getUserByWs(ws) {
    for (const entry of this.connections.values()) {
      if (entry.ws === ws) return entry.user;
    }
    return undefined;
  }

  /**
   * Get all connected users.
   * @returns {User[]}
   */
  getUsers() {
    return Array.from(this.connections.values()).map(e => e.user);
  }

  /**
   * Broadcast a message to all connected clients except an optional sender.
   * @param {object} message
   * @param {import('ws').WebSocket} [sender]
   */
  broadcast(message, sender) {
    const data = JSON.stringify(message);
    for (const entry of this.connections.values()) {
      if (entry.ws !== sender && entry.ws.readyState === 1) {
        entry.ws.send(data);
      }
    }
  }

  /**
   * Send a message to a specific client.
   * @param {import('ws').WebSocket} ws
   * @param {object} message
   */
  send(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
}

// ─── Application Setup ───────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const board = new Board();
const presence = new PresenceManager();
/** @type {Map<string, Array<{type:string, cardId:string, action:object}>>} */
const undoStacks = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket Connection Handling ───────────────────────────────────────────

wss.on('connection', (ws) => {
  let currentUser = null;
  /** @type {Array<object>} */
  const messageQueue = [];
  let processing = false;

  /**
   * Process messages in the queue one by one (FIFO per connection).
   */
  function processQueue() {
    if (processing || messageQueue.length === 0) return;
    processing = true;
    const msg = messageQueue.shift();
    try {
      handleMessage(msg);
    } catch (err) {
      console.error('Error handling message:', err);
    }
    processing = false;
    processQueue();
  }

  /**
   * Enqueue an incoming message for FIFO processing.
   * @param {object} msg
   */
  function enqueue(msg) {
    messageQueue.push(msg);
    processQueue();
  }

  /**
   * Handle a single parsed message.
   * @param {object} msg
   */
  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'identify': {
        // Client sends their display name from localStorage
        const name = (msg.name || 'Anonymous').trim().slice(0, 30);
        currentUser = presence.addUser(ws, name);
        undoStacks.set(currentUser.id, []);

        // Send init to this client
        presence.send(ws, {
          type: 'init',
          yourId: currentUser.id,
          board: board.toJSON(),
          users: presence.getUsers(),
        });

        // Broadcast join to others
        presence.broadcast({
          type: 'userJoined',
          user: { id: currentUser.id, name: currentUser.name, color: currentUser.color },
        }, ws);
        break;
      }

      case 'createCard': {
        if (!currentUser) return sendError('INVALID', 'Not identified');
        const title = (msg.title || '').trim();
        if (title.length > 200) return sendError('INVALID', 'Title too long');
        const content = (msg.content || '').slice(0, 5000);

        const card = board.createCard(
          msg.columnId,
          title,
          content,
          currentUser.id,
          currentUser.name
        );
        if (!card) return sendError('INVALID', 'Column not found');

        // Save undo record
        const undoStack = undoStacks.get(currentUser.id);
        if (undoStack) {
          undoStack.push({
            type: 'delete',
            cardId: card.id,
            action: { type: 'delete', cardId: card.id, columnId: msg.columnId, title, content, authorId: currentUser.id, authorName: currentUser.name, createdAt: card.createdAt },
          });
        }

        // Broadcast to ALL (including sender for optimistic UI sync)
        presence.broadcast({ type: 'cardCreated', card });
        break;
      }

      case 'moveCard': {
        if (!currentUser) return sendError('INVALID', 'Not identified');
        const result = board.moveCard(msg.cardId, msg.toColumnId);
        if (!result) return sendError('CONFLICT', 'Card not found or invalid move');

        // Save undo record
        const undoStack = undoStacks.get(currentUser.id);
        if (undoStack) {
          undoStack.push({
            type: 'move',
            cardId: msg.cardId,
            action: { type: 'move', cardId: msg.cardId, fromColumnId: result.fromColumnId, toColumnId: msg.toColumnId },
          });
        }

        const moveMsg = {
          type: 'cardMoved',
          cardId: msg.cardId,
          fromColumnId: result.fromColumnId,
          toColumnId: msg.toColumnId,
        };
        presence.broadcast(moveMsg);
        break;
      }

      case 'deleteCard': {
        if (!currentUser) return sendError('INVALID', 'Not identified');
        const deleted = board.deleteCard(msg.cardId);
        if (!deleted) return sendError('CONFLICT', 'Card no longer exists');

        // Save undo record
        const undoStack = undoStacks.get(currentUser.id);
        if (undoStack) {
          undoStack.push({
            type: 'create',
            cardId: msg.cardId,
            action: { type: 'create', cardId: msg.cardId, columnId: deleted.columnId, title: deleted.card.title, content: deleted.card.content, authorId: deleted.card.authorId, authorName: deleted.card.authorName, createdAt: deleted.card.createdAt },
          });
        }

        presence.broadcast({ type: 'cardDeleted', cardId: msg.cardId });
        break;
      }

      case 'undo': {
        if (!currentUser) return sendError('INVALID', 'Not identified');
        const undoStack = undoStacks.get(currentUser.id);
        if (!undoStack || undoStack.length === 0) return sendError('INVALID', 'Nothing to undo');

        const undoAction = undoStack.pop();
        const action = undoAction.action;
        let restoredCard = null;
        let previousColumnId = null;

        switch (action.type) {
          case 'delete': {
            // Reverse: re-create the card and broadcast cardCreated
            const card = board.createCard(action.columnId, action.title, action.content, action.authorId, action.authorName);
            if (card) {
              card.id = action.cardId;
              card.createdAt = action.createdAt;
              restoredCard = card;
              presence.broadcast({ type: 'cardCreated', card: restoredCard });
            }
            break;
          }
          case 'move': {
            // Reverse: move back and broadcast cardMoved
            const moveResult = board.moveCard(action.cardId, action.fromColumnId);
            if (moveResult) {
              previousColumnId = moveResult.fromColumnId;
              presence.broadcast({
                type: 'cardMoved',
                cardId: action.cardId,
                fromColumnId: action.toColumnId,
                toColumnId: action.fromColumnId,
              });
            }
            break;
          }
          case 'create': {
            // Reverse: delete the card and broadcast cardDeleted
            board.deleteCard(action.cardId);
            presence.broadcast({ type: 'cardDeleted', cardId: action.cardId });
            break;
          }
        }

        // undoApplied is now purely informational — all state changes are
        // handled by the cardCreated / cardMoved / cardDeleted broadcasts above.
        presence.broadcast({
          type: 'undoApplied',
          action: { type: action.type, cardId: action.cardId },
        });
        break;
      }

      default:
        sendError('INVALID', 'Unknown message type');
    }
  }

  /**
   * Send an error to the current client.
   * @param {string} code
   * @param {string} message
   */
  function sendError(code, message) {
    presence.send(ws, { type: 'error', code, message });
  }

  // Wire up incoming messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      enqueue(msg);
    } catch (e) {
      presence.send(ws, { type: 'error', code: 'INVALID', message: 'Invalid JSON' });
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      presence.removeUser(currentUser.id);
      undoStacks.delete(currentUser.id);
      presence.broadcast({ type: 'userLeft', userId: currentUser.id });
    }
  });

  ws.on('error', () => {
    // Cleanup handled by close
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Kanban server running on http://localhost:${PORT}`);
});

module.exports = { Board, PresenceManager, board, presence };
