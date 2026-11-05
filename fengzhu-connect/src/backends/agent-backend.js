// AgentBackend — the neutral interface the connector uses to drive one coding
// agent (Codex today; Claude Code next). It exists so a second backend can be
// added without spreading agent-specific assumptions through connector.js.
//
// Security invariant for every backend: only ever launch the user's locally
// installed, already-logged-in agent binary. A backend must never read, copy or
// transmit any vendor credential (auth.json, OAuth tokens, API keys). Auth is
// entirely the agent binary's own concern.
//
// A backend exposes:
//   id            stable short id ('codex' | 'claude')
//   displayName   human label
//   client        the underlying transport client (kept as connector.codex for
//                 the Codex backend so existing code and tests are unaffected)
//   capabilities() -> BackendCapabilities (what the phone UI may offer)
//   start()/stop()/restart()   lifecycle (delegate to client)
//   on(event, handler)         subscribe to client events
//
// Turn/thread operations (listThreads, startTurn, steerTurn, interruptTurn, …)
// are added as backends need them; the Codex paths in connector.js currently
// call client.request(...) directly and are migrated incrementally.

/**
 * @typedef {Object} BackendCapabilities
 * @property {boolean} collaborationMode  plan/execute collaboration modes
 * @property {boolean} threadQueue        server-side turn queue (thread/queue/add)
 * @property {boolean} desktopAutomation  drives a desktop app window
 * @property {boolean} fork               fork a thread
 * @property {boolean} rollback           roll back a turn
 * @property {boolean} rateLimits         reports account rate limits
 * @property {boolean} compact            manual context compaction
 * @property {string[]} permissionModes   supported permission modes
 */

const DEFAULT_CAPABILITIES = Object.freeze({
  collaborationMode: false,
  threadQueue: false,
  desktopAutomation: false,
  fork: false,
  rollback: false,
  rateLimits: false,
  compact: false,
  permissionModes: [],
});

// Normalized events a backend emits (the connector forwards them as frames).
//   'item'        { threadId, item: { id, type, text?, tool?, input?, status?, at } }
//   'status'      { threadId, status: 'running'|'completed'|'failed'|'interrupted' }
//   'approval'    { threadId, requestId, tool, input, summary }
//   'question'    { threadId, requestId, questions }
//   'error'       { threadId, message, terminal }
//   'turnComplete'{ threadId, turnId, usage, sessionId }
// Item `type` reuses the connector's existing vocabulary so downstream rendering
// stays consistent across backends.
const ITEM_TYPES = Object.freeze([
  'userMessage', 'agentMessage', 'reasoning', 'plan',
  'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'error',
]);

module.exports = { DEFAULT_CAPABILITIES, ITEM_TYPES };
