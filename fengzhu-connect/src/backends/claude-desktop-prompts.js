const crypto = require('node:crypto');

const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// The permission log identifies the request, but its tool input may belong
// to a child agent rather than the main transcript. Show the actual dialog.
// Runtime ids change when a session is reopened, so bind the phone's choice
// to the session, log request and complete dialog content instead.
function desktopPermissionDetail(snapshot, prompt, desktopId) {
  if (!prompt?.requestId || snapshot?.desktopId !== desktopId
    || !/^Permission request\b/.test(snapshot?.name || '')
    || !Array.isArray(snapshot.texts) || !snapshot.texts.length
    || snapshot.texts.some((text) => typeof text !== 'string')) return null;
  const texts = snapshot.texts.slice();
  if (texts.join('').length > 64 * 1024) return null;
  const action = normalize(snapshot.name.replace(/^Permission request:\s*/, ''));
  const parts = [...new Set(texts.filter((text) => {
    const label = normalize(text);
    return label && label !== 'Allow Claude to' && label !== '?' && label !== action;
  }))];
  if (!parts.length) return null;
  const desktopPrompt = { desktopId, name: snapshot.name, texts };
  const hash = crypto.createHash('sha256').update(JSON.stringify([prompt.requestId, desktopPrompt])).digest('hex').slice(0, 32);
  return {
    kind: 'permission', source: 'desktop-ui', requestId: `desktop-ui-${hash}`, logRequestId: prompt.requestId,
    tool: ({ run: 'Bash', write: 'Write', edit: 'Edit', read: 'Read' })[action] || '电脑端操作',
    summary: parts.join('\n'), desktopPrompt,
    // The dialog has no "Allow and switch to Auto" (an MCP tool's request): the phone hides it.
    ...(snapshot.auto === false ? { autoOption: false } : {}),
  };
}

// A question card read from the window (the desktop's safeguard choice is
// asked this way and never written to the transcript). Answered like an
// AskUserQuestion: the card's text identifies it, each option by its label
// and description.
function desktopQuestionDetail(snapshot, prompt, desktopId) {
  const card = snapshot?.questionCard;
  if (!prompt?.requestId || prompt.tool !== 'AskUserQuestion' || snapshot?.desktopId !== desktopId || card?.desktopId !== desktopId) return null;
  const question = normalize(card.question);
  const options = (Array.isArray(card.options) ? card.options : [])
    .map((o) => ({ label: normalize(o?.label).slice(0, 80), description: normalize(o?.description).slice(0, 200), ...(o?.name ? { name: normalize(o.name).slice(0, 2000) } : {}) }))
    .filter((o) => o.label);
  if (!question || question.length > 2000 || options.length < 2 || options.length > 8) return null;
  return {
    kind: 'question', source: 'desktop-ui-question', tool: 'AskUserQuestion', requestId: prompt.requestId,
    // The card offers only its buttons: no free-text "Other" answer.
    questions: [{ question, header: '', multiSelect: !!card.multi, options, allowOther: false }],
  };
}

module.exports = { desktopPermissionDetail, desktopQuestionDetail };
