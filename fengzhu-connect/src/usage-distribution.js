// Statistics only from native usage records. Never reads credentials or invokes a model.
const safe = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function dshDistribution(records, periods, truncated = false) {
  const seen = new Set();
  const result = { today: 0, month: 0, all: 0 };
  let earliest = Infinity, missingTime = false, missingUsage = false, observed = 0;
  for (const record of records || []) {
    const event = record?.event || record;
    const at = Number(event?.time);
    if (Number.isFinite(at) && at > 0) earliest = Math.min(earliest, at);
    if (event?.type !== 'assistant/message') continue;
    const id = event.seq;
    if (!Number.isSafeInteger(id) || seen.has(id)) { if (!Number.isSafeInteger(id)) missingUsage = true; continue; }
    seen.add(id);
    const usage = event.data?.usage;
    if (!usage || !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(key => usage[key] != null)) { missingUsage = true; continue; }
    const values = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => usage[key] == null ? 0 : safe(usage[key]));
    if (values.some(value => value == null)) { missingUsage = true; continue; }
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(total)) { missingUsage = true; continue; }
    observed++;
    result.all += total;
    if (!Number.isFinite(at) || at <= 0) { missingTime = true; continue; }
    if (at >= periods.todayFrom) result.today += total;
    if (at >= periods.monthFrom) result.month += total;
  }
  if (!observed) return { status: 'unavailable', reason: '此对话没有可读取的 Token 记录' };
  const part = from => Boolean(missingTime || missingUsage || (truncated && earliest >= from));
  return { status: 'ready', periods: { ...periods,
    today: { total: result.today, partial: part(periods.todayFrom) },
    month: { total: result.month, partial: part(periods.monthFrom) },
    all: { total: result.all, partial: Boolean(truncated || missingUsage) } } };
}

// The Host emits one usage record per model call. A user message opens a turn
// and turn/end closes it; a trailing or clipped turn has no completed speed.
function dshConversation(records, threadId, truncated) {
  const blank = () => ({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 });
  const totals = blank(), completedTurns = [], seen = new Set();
  let turn = null, latest = null, usageUpdatedAt = 0, updatedAt = 0, partial = truncated;
  for (const event of records.map(row => row?.event || row).filter(Boolean).sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || seen.has(event.seq)) continue;
    seen.add(event.seq);
    const at = safe(event.time) || 0;
    updatedAt = Math.max(updatedAt, at);
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      turn = { turnId: `${threadId}-${event.seq}`, startedAt: at, finalMessageAt: 0, usage: blank(), partial: false };
    } else if (event.type === 'assistant/message') {
      const data = event.data || {};
      const blocks = Array.isArray(data.message?.content) ? data.message.content.filter(block =>
        ['text', 'reasoning'].includes(block?.type) && typeof block.text === 'string' && block.text.trim()) : [];
      const lastText = blocks.findLastIndex(block => block.type === 'text');
      if (turn && lastText >= 0) {
        turn.finalMessageAt = at;
        turn.finalMessageId = `${threadId}-${event.seq}-t${lastText}`;
      }
      const u = data.usage;
      if (!u || safe(u.inputTokens) == null || safe(u.outputTokens) == null ||
          safe(u.cacheReadTokens ?? 0) == null || safe(u.cacheWriteTokens ?? 0) == null) {
        if (turn) turn.partial = true;
        partial = true;
        continue;
      }
      const cacheRead = u.cacheReadTokens || 0, cacheWrite = u.cacheWriteTokens || 0;
      const input = u.inputTokens + cacheRead + cacheWrite;
      latest = { input, output: u.outputTokens, total: input + u.outputTokens, cacheRead, cacheWrite };
      usageUpdatedAt = Math.max(usageUpdatedAt, at);
      for (const key of Object.keys(totals)) {
        totals[key] += latest[key];
        if (turn) turn.usage[key] += latest[key];
      }
    } else if (event.type === 'turn/end' && turn && !turn.completedAt) {
      turn.completedAt = at;
      if (turn.startedAt && turn.finalMessageAt >= turn.startedAt && at >= turn.finalMessageAt) completedTurns.push({ ...turn, usage: { ...turn.usage } });
    }
  }
  return { schemaVersion: 1, backend: 'dsh', status: latest ? 'ready' : 'unavailable',
    totals: latest ? totals : null, latest, turn: turn?.usage, turnId: turn?.turnId,
    turnActive: Boolean(turn && !turn.completedAt), usageUpdatedAt, updatedAt, partial, completedTurns: completedTurns.slice(-200) };
}

async function readDshDistribution(client, meta, periods, threadId) {
  if (!client || !meta?.sessionId) return { status: 'unavailable', reason: '暂时找不到 DSH 对话记录' };
  const page = await client.sessionPage(meta.sessionId, Math.max(0, Number(meta.syncedSeq) || 0), 800);
  const records = Array.isArray(page?.records) ? page.records : [];
  // Different DSH versions expose the page boundary differently. Treat a full
  // page as incomplete unless the Host explicitly proves otherwise.
  const truncated = page?.hasMore === true || (records.length >= 800 && page?.hasMore !== false);
  return periods ? dshDistribution(records, periods, truncated) : dshConversation(records, threadId, truncated);
}

module.exports = { dshDistribution, dshConversation, readDshDistribution };
