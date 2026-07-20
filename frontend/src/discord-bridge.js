// ── Discord Bridge ──────────────────────────────────────────────────────────
// Discord bot integration that runs within the Express/WebSocket server process.
//
// This module exports a `DiscordBridge` class that:
//   - Manages a discord.js client (login, slash commands, message handlers)
//   - Routes Discord messages to pi agent sessions via discordSessionManager
//   - Streams assistant responses by editing a single reply message
//   - Supports /pi ask and /pi status slash commands
//   - Enforces authorization (allowedGuildIds, adminUserIds, dmAllowlistUserIds)
//
// Usage:
//   import { DiscordBridge } from './discord-bridge.js';
//   const bridge = new DiscordBridge(config, {
//     discordSessionManager,
//     broadcast,
//   });
//   await bridge.start();

import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
} from 'discord.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum interval (ms) between successive Discord message edits while streaming. */
const STREAM_EDIT_INTERVAL = 600;

/** Maximum characters Discord allows in a single message. */
const MAX_MESSAGE_LENGTH = 2000;

// ── DiscordBridge ────────────────────────────────────────────────────────────

export class DiscordBridge {
  /**
   * @param {object} config
   * @param {string}   config.botToken             - Discord bot token (required)
   * @param {string[]} [config.allowedGuildIds]    - Guild IDs the bot may operate in
   * @param {string[]} [config.adminUserIds]       - User IDs with admin privileges
   * @param {string[]} [config.dmAllowlistUserIds] - User IDs allowed to DM the bot
   * @param {string}   [config.cwd]                - Working directory for sessions (default: '/home')
   * @param {object}   options
   * @param {object}   options.discordSessionManager - Return value of createDiscordSessionManager()
   * @param {Function} options.broadcast             - Shared broadcast function for WS clients
   */
  constructor(config = {}, options = {}) {
    if (!config.botToken) {
      throw new Error('DiscordBridge: botToken is required');
    }

    /** @private */
    this.config = {
      allowedGuildIds: config.allowedGuildIds || [],
      adminUserIds: config.adminUserIds || [],
      dmAllowlistUserIds: config.dmAllowlistUserIds || [],
      cwd: config.cwd || '/home',
      botToken: config.botToken,
    };

    /** @private */
    this.discordSessionManager = options.discordSessionManager;
    /** @private */
    this.broadcast = options.broadcast;

    /** @private @type {Client|null} */
    this.client = null;
    /** @private */
    this._ready = false;

    /**
     * Per-route streaming state.
     * Map<routeKey, { content, replyMessage, editTimer, done, cleanup, _lastEdited }>
     * @private
     */
    this._streams = new Map();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the Discord bot: create client, login, register commands, return when ready.
   */
  async start() {
    if (this.client) {
      throw new Error('DiscordBridge: already started');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this._setupHandlers();
    await this.client.login(this.config.botToken);

    // Wait for ready event
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('DiscordBridge: login timed out after 30s')),
        30_000,
      );
      this.client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await this._registerSlashCommands();

    this._ready = true;
    console.log(`[discord-bridge] Logged in as ${this.client.user?.tag}`);
  }

  /**
   * Stop the Discord bot: destroy client, clear state.
   */
  async stop() {
    this._ready = false;

    // Clean up streaming states
    for (const [, state] of this._streams) {
      if (state.editTimer) clearTimeout(state.editTimer);
      if (state.cleanup) state.cleanup();
    }
    this._streams.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    console.log('[discord-bridge] Stopped');
  }

  // ── Event handler setup ───────────────────────────────────────────────────

  /** @private */
  _setupHandlers() {
    const c = this.client;

    c.on(Events.MessageCreate, (msg) =>
      this._onMessage(msg).catch((e) =>
        console.error('[discord-bridge] message handler error:', e.message),
      ),
    );

    c.on(Events.InteractionCreate, (ix) =>
      this._onInteraction(ix).catch((e) =>
        console.error('[discord-bridge] interaction handler error:', e.message),
      ),
    );

    c.on(Events.Error, (err) =>
      console.error('[discord-bridge] client error:', err.message),
    );
  }

  // ── Slash command registration ────────────────────────────────────────────

  /** @private */
  async _registerSlashCommands() {
    if (!this.client?.user) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('pi')
        .setDescription('Pi coding agent commands')
        .addSubcommand((sub) =>
          sub
            .setName('ask')
            .setDescription('Ask pi a question or give a task')
            .addStringOption((opt) =>
              opt
                .setName('text')
                .setDescription('Your question or task')
                .setRequired(true)
                .setMaxLength(1500),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('status')
            .setDescription('Show the current session status'),
        ),
    ];

    const rest = new REST({ version: '10' }).setToken(this.config.botToken);

    try {
      const { allowedGuildIds } = this.config;

      if (allowedGuildIds && allowedGuildIds.length === 1) {
        // Single guild → instant guild commands (no propagation delay)
        await rest.put(
          Routes.applicationGuildCommands(this.client.user.id, allowedGuildIds[0]),
          { body: commands },
        );
        console.log(`[discord-bridge] Guild commands registered for ${allowedGuildIds[0]}`);
      } else {
        // Global registration (may take up to an hour to propagate)
        await rest.put(Routes.applicationCommands(this.client.user.id), {
          body: commands,
        });
        console.log('[discord-bridge] Global commands registered');
      }
    } catch (e) {
      console.error('[discord-bridge] Failed to register slash commands:', e.message);
    }
  }

  // ── Authorization helpers ─────────────────────────────────────────────────

  /** @private */
  _isAllowedGuild(guildId) {
    const ids = this.config.allowedGuildIds;
    return !ids || ids.length === 0 || ids.includes(guildId);
  }

  /** @private */
  _isAdmin(userId) {
    return this.config.adminUserIds.includes(userId);
  }

  /** @private */
  _isDmAllowed(userId) {
    const ids = this.config.dmAllowlistUserIds;
    return ids && ids.length > 0 && ids.includes(userId);
  }

  /** @private */
  _isBotMentioned(msg) {
    return this.client?.user ? msg.mentions.has(this.client.user.id) : false;
  }

  // ── Route key ─────────────────────────────────────────────────────────────

  /**
   * Derive a stable route key from a message.
   * Uses thread id if present, else channel id.  DMs use 'dm-<userId>'.
   * @private
   */
  _routeKey(msg) {
    if (!msg.guildId) return `dm:${msg.author.id}`;
    const id = msg.threadId || msg.channelId;
    return `g:${msg.guildId}:${id}`;
  }

  // ── Message handler ───────────────────────────────────────────────────────

  /** @private */
  async _onMessage(msg) {
    // 1. Ignore bots (including ourselves)
    if (msg.author.bot) return;

    // 2. Authorization
    if (msg.guildId) {
      if (!this._isAllowedGuild(msg.guildId)) return;
    } else {
      if (!this._isDmAllowed(msg.author.id)) return;
    }

    const routeKey = this._routeKey(msg);
    const isDM = !msg.guildId;
    const isMention = this._isBotMentioned(msg);
    const hasSession = this.discordSessionManager.getSessionManager(routeKey) !== null;

    // 3. Determine if this message should be handled
    const shouldHandle = isDM || isMention || hasSession;
    if (!shouldHandle) return;

    // 4. Strip bot mention from text
    let text = msg.content;
    if (isMention && this.client?.user) {
      text = text
        .replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '')
        .trim();
    }
    if (!text && msg.attachments.size === 0) return;

    // 5. Get or create session
    let sessionData;
    try {
      sessionData = await this.discordSessionManager.getOrCreate(routeKey, this.config.cwd, {
        guildId: msg.guildId || null,
        channelId: msg.channelId,
        threadId: msg.threadId || null,
      });
    } catch (e) {
      console.error(`[discord-bridge] getOrCreate error for ${routeKey}:`, e.message);
      await this._sendReply(msg, '❌ Failed to create session. Try again later.');
      return;
    }

    const { session } = sessionData;

    // 6. Handle attachments
    const attachmentNote = await this._saveAttachments(msg, routeKey);
    const fullText = text + (attachmentNote ? `\n\n${attachmentNote}` : '');

    // 7. Stream the response
    await this._streamReply(msg, session, fullText, routeKey, isDM || isMention);
  }

  // ── Attachment handling ───────────────────────────────────────────────────

  /**
   * Download message attachments to a local directory.
   * Returns a textual note for the session context, or empty string.
   * @private
   */
  async _saveAttachments(msg, routeKey) {
    if (msg.attachments.size === 0) return '';

    const dir = path.join(this.config.cwd, '.discord-attachments', routeKey);
    fs.mkdirSync(dir, { recursive: true });

    const paths = [];
    for (const [, att] of msg.attachments) {
      try {
        const ext = path.extname(att.name) || '';
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        const fp = path.join(dir, filename);

        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(fp, buf);

        paths.push(fp);
      } catch (e) {
        console.error(`[discord-bridge] Failed to download ${att.name}:`, e.message);
      }
    }

    if (paths.length === 0) return '';
    return `[Attachments saved: ${paths.join(', ')}]`;
  }

  // ── Streaming reply ───────────────────────────────────────────────────────

  /**
   * Send a prompt to the session and stream the response by editing a
   * single Discord reply message.
   * @private
   */
  async _streamReply(msg, session, text, routeKey, triggerTurn) {
    // Discard any stale stream for this route
    this._cleanupStream(routeKey);

    // ── Create reply placeholder ──────────────────────────────────────
    let reply;
    try {
      reply = await msg.reply('🤔 *Thinking…*');
    } catch (e) {
      console.error('[discord-bridge] Failed to send initial reply:', e.message);
      return;
    }

    const state = {
      content: '',
      reply,
      editTimer: null,
      done: false,
      _lastEdited: '',
      _lastEditTime: 0,
      _unsub: null,
    };
    this._streams.set(routeKey, state);

    // ── Subscribe to session events ───────────────────────────────────
    const unsub = session.subscribe((ev) => {
      switch (ev.type) {
        case 'message_update': {
          const sub = ev.assistantMessageEvent;
          if (sub && sub.type === 'text_delta') {
            state.content += sub.delta;
            this._debounceEdit(state, routeKey);
          }
          break;
        }
        case 'agent_settled':
        case 'agent_end': {
          state.done = true;
          this._finalizeEdit(state, routeKey);
          break;
        }
      }
    });
    state._unsub = unsub;

    // Cleanup helper
    state.cleanup = () => {
      if (state.editTimer) clearTimeout(state.editTimer);
      this._streams.delete(routeKey);
      if (state._unsub) state._unsub();
    };

    // ── Send prompt ───────────────────────────────────────────────────
    try {
      if (triggerTurn && session.isStreaming) {
        await session.followUp(text);
      } else {
        await session.prompt(text, {
          streamingBehavior: triggerTurn ? undefined : 'followUp',
        });
      }
    } catch (e) {
      console.error('[discord-bridge] prompt error:', e.message);
      state.done = true;
      await this._editReply(state, '❌ Error: ' + e.message);
      if (state.cleanup) state.cleanup();
    }
  }

  // ── Edit scheduling ───────────────────────────────────────────────────────

  /** @private */
  _debounceEdit(state, routeKey) {
    if (state.done) return;
    if (state.editTimer) return;

    const now = Date.now();
    const elapsed = now - state._lastEditTime;

    if (elapsed >= STREAM_EDIT_INTERVAL) {
      state.editTimer = setTimeout(() => {
        state.editTimer = null;
        state._lastEditTime = Date.now();
        this._editReply(state, state.content);
      }, 0);
    } else {
      const delay = STREAM_EDIT_INTERVAL - elapsed;
      state.editTimer = setTimeout(() => {
        state.editTimer = null;
        state._lastEditTime = Date.now();
        this._editReply(state, state.content);
      }, delay);
    }
  }

  /** @private */
  async _finalizeEdit(state, routeKey) {
    // Let any in-flight edit settle
    await new Promise((r) => setTimeout(r, 150));

    if (state.editTimer) {
      clearTimeout(state.editTimer);
      state.editTimer = null;
    }

    const final =
      state.content || '✅ *Done (no text response)*';
    await this._editReply(state, final);

    if (state.cleanup) state.cleanup();
  }

  /** @private */
  async _editReply(state, content) {
    if (!state.reply) return;
    const display = this._truncate(content);
    if (display === state._lastEdited) return;

    try {
      await state.reply.edit(display);
      state._lastEdited = display;
    } catch (e) {
      // 404 = message deleted, 429 = rate-limited → stop streaming
      if (e.status === 404 || e.status === 10008) {
        state.done = true;
        if (state.cleanup) state.cleanup();
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** @private */
  _cleanupStream(routeKey) {
    const existing = this._streams.get(routeKey);
    if (existing) {
      if (existing.editTimer) clearTimeout(existing.editTimer);
      if (existing.cleanup) existing.cleanup();
      this._streams.delete(routeKey);
    }
  }

  // ── Slash command handler ─────────────────────────────────────────────────

  /** @private */
  async _onInteraction(ix) {
    if (!ix.isChatInputCommand() || ix.commandName !== 'pi') return;

    // Authorization
    if (ix.guildId) {
      if (!this._isAllowedGuild(ix.guildId)) {
        await ix.reply({ content: '❌ Guild not authorised.', ephemeral: true });
        return;
      }
    } else if (!this._isDmAllowed(ix.user.id)) {
      await ix.reply({ content: '❌ Not authorised.', ephemeral: true });
      return;
    }

    const sub = ix.options.getSubcommand();

    switch (sub) {
      case 'ask':
        await this._handleSlashAsk(ix);
        break;
      case 'status':
        await this._handleSlashStatus(ix);
        break;
    }
  }

  /** @private */
  async _handleSlashAsk(ix) {
    const text = ix.options.getString('text', true);
    const routeKey = `slash:${ix.channelId || ix.user.id}`;

    // Initial ephemeral reply
    await ix.reply({ content: '🤔 *Processing…*', ephemeral: true });

    // Get/create session
    let sessionData;
    try {
      sessionData = await this.discordSessionManager.getOrCreate(routeKey, this.config.cwd, {
        guildId: ix.guildId || null,
        channelId: ix.channelId,
      });
    } catch (e) {
      await ix.editReply('❌ Failed to create session.');
      return;
    }

    const { session } = sessionData;
    this._cleanupStream(routeKey);

    const state = {
      content: '',
      reply: ix,
      editTimer: null,
      done: false,
      _lastEdited: '',
      _lastEditTime: 0,
      _unsub: null,
    };
    this._streams.set(routeKey, state);

    const unsub = session.subscribe((ev) => {
      switch (ev.type) {
        case 'message_update': {
          const sub = ev.assistantMessageEvent;
          if (sub && sub.type === 'text_delta') {
            state.content += sub.delta;
            this._debounceEdit(state, routeKey);
          }
          break;
        }
        case 'agent_settled':
        case 'agent_end': {
          state.done = true;
          this._finalizeEdit(state, routeKey);
          break;
        }
      }
    });
    state._unsub = unsub;

    state.cleanup = () => {
      if (state.editTimer) clearTimeout(state.editTimer);
      this._streams.delete(routeKey);
      if (state._unsub) state._unsub();
    };

    try {
      await session.prompt(text);
    } catch (e) {
      console.error('[discord-bridge] slash ask error:', e.message);
      state.done = true;
      try {
        await ix.editReply('❌ Error: ' + e.message);
      } catch (_) {}
      if (state.cleanup) state.cleanup();
    }
  }

  /** @private */
  async _handleSlashStatus(ix) {
    const routeKey = `slash:${ix.channelId || ix.user.id}`;
    const sm = this.discordSessionManager.getSessionManager(routeKey);

    if (!sm) {
      await ix.reply({
        content: '📭 No active session in this channel.',
        ephemeral: true,
      });
      return;
    }

    const { session } = sm;
    const status = session.isStreaming ? '🟢 Active' : '⏸️ Idle';
    const model = session.model?.name || session.model?.id || 'None';
    const msgs = session.messages?.length || 0;

    await ix.reply({
      content: [
        '**🤖 Pi Session**',
        `Status: ${status}`,
        `Model: ${model}`,
        `Messages: ${msgs}`,
      ].join('\n'),
      ephemeral: true,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Truncate text to Discord's message limit with a notice.
   * @private
   */
  _truncate(content) {
    if (!content) return '…';
    if (content.length <= MAX_MESSAGE_LENGTH) return content;
    return content.slice(0, MAX_MESSAGE_LENGTH - 100) + '\n\n*(… truncated)*';
  }

  /**
   * Simple non-streaming reply fallback.
   * @private
   */
  async _sendReply(msg, content) {
    try {
      return await msg.reply(content);
    } catch (e) {
      console.error('[discord-bridge] sendReply failed:', e.message);
      return null;
    }
  }
}
