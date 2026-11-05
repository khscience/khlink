'use strict';

// Each instruction from the phone carries its request id, so the connector
// can match the turn Codex records to the request that sent it (receipts,
// duplicates, queued rows). It used to be a visible "[KH_LINK_REQUEST_ID:…]"
// line, which Codex Desktop showed under every message from the phone. It is
// now written in zero-width characters: Codex Desktop shows nothing, and the
// connector still matches it exactly. The old line is still read and removed.
const EDGE = '⁣';
const DIGITS = ['​', '‌', '‍', '⁠'];
const LEGACY_END_RE = /\n?\n?\[KH_LINK_REQUEST_ID:([0-9a-f-]{36})\]\s*$/i;
const LEGACY_ANY_RE = /\[KH_LINK_REQUEST_ID:([0-9a-f-]{36})\]/i;
const INVISIBLE_RE = /⁣([​‌‍⁠]{64})⁣/;
const INVISIBLE_ALL_RE = /⁣[​‌‍⁠]{64}⁣/g;

function encodeRequestMarker(requestId) {
  const hex = String(requestId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  let body = '';
  for (const digit of hex) { const value = parseInt(digit, 16); body += DIGITS[value >> 2] + DIGITS[value & 3]; }
  return EDGE + body + EDGE;
}

function decodeBody(body) {
  let hex = '';
  for (let index = 0; index < body.length; index += 2) {
    hex += ((DIGITS.indexOf(body[index]) << 2) | DIGITS.indexOf(body[index + 1])).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The text with the request id appended (invisibly for a UUID; ids of other shapes keep the old line). */
function withRequestMarker(text, requestId) {
  const id = String(requestId || '').trim();
  // An answer to a Codex question is sent exactly as Codex Desktop sends it,
  // so the app can read it as one; its question id already makes it unique.
  if (!id || /^\s*<send_user_message_question_reply>[\s\S]*<\/send_user_message_question_reply>\s*$/.test(String(text || ''))) return String(text || '');
  const marker = encodeRequestMarker(id);
  return marker ? `${String(text || '').trim()}${marker}` : `${String(text || '').trim()}\n\n[KH_LINK_REQUEST_ID:${id}]`;
}

/** The request id a text carries, in either form, or null. */
function requestMarkerId(text) {
  const value = String(text || '');
  const invisible = value.match(INVISIBLE_RE);
  if (invisible) return decodeBody(invisible[1]);
  return value.match(LEGACY_ANY_RE)?.[1] || null;
}

function stripRequestMarker(text) {
  return String(text || '').replace(INVISIBLE_ALL_RE, '').replace(LEGACY_END_RE, '').trim();
}

module.exports = { encodeRequestMarker, withRequestMarker, requestMarkerId, stripRequestMarker };
