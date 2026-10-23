/**
 * The owned-lead answer, wired to the world — src/services/rehash-owned-answer-io.js
 * (Mark, 2026-10-23; Kim Turko review)
 *
 * The rules are pure (src/agentic/rehash-owned-answer.js); this module does the
 * reads and the model calls. Every I/O goes through `deps`.
 *
 *   classifyOwnedQuestion: the words first; only when they decide nothing, one
 *     small model call (fn owned_direct_question). A model that fails or says
 *     nothing usable is "no reply": John owns the lead, so this one fails closed.
 *   writeOwnedAnswer: a direct question gets 1-2 sentences from our approved
 *     FAQ answers (or "the rep will cover it on the call"); a move or cancel
 *     request gets "Got it, I'll let John know." and a #contact-rehash card.
 */
import {
  classifyOwnedInbound, readDirectQuestion, DIRECT_QUESTION_SYSTEM, directQuestionPrompt,
  ownedAnswerSystem, ownedAnswerPrompt, finishOwnedAnswer, changeRequestLine,
} from '../agentic/rehash-owned-answer.js';

async function defaults() {
  const [{ callLLM, callLLMJson }] = await Promise.all([import('../llm-client.js')]);
  return {
    callLLM,
    callLLMJson,
    // Our approved FAQ answers nearest the question (the same search the reply
    // writer's knowledge pack uses). A failed search is "no facts", never a throw.
    matchFaqs: async (text) => {
      const [{ embed }, { matchFaqsSemantic }] = await Promise.all([
        import('../knowledge/openai-embeddings.js'), import('../knowledge/tier1-semantic.js'),
      ]);
      const q = await embed(String(text || '').slice(0, 800), { fast: true, fn: 'embeddings:faq' });
      return matchFaqsSemantic(q, 'sms', 3);
    },
    notifyChange: async (args) => (await import('../notifications/rehash-call.js')).notifyRehashChangeRequest(args),
  };
}

/**
 * @returns {Promise<{ kind: 'question'|'change_request'|'none', reason: string, by: 'words'|'model' }>}
 */
export async function classifyOwnedQuestion(text, deps = {}) {
  const words = classifyOwnedInbound(text);
  if (words.kind !== 'ambiguous') return { ...words, by: 'words' };
  try {
    const d = { ...(await defaults()), ...deps };
    const out = await d.callLLMJson({ fn: 'owned_direct_question', system: DIRECT_QUESTION_SYSTEM, user: directQuestionPrompt(text), maxTokens: 100 });
    const yes = readDirectQuestion(out?.data);
    if (yes === true) return { kind: 'question', reason: 'model_direct_question', by: 'model' };
    return { kind: 'none', reason: yes === false ? 'model_not_a_question' : 'model_undecided', by: 'model' };
  } catch (err) {
    console.warn(`[RehashOwnedAnswer] classifier failed (${String(err?.message || err).slice(0, 120)}) — no reply`);
    return { kind: 'none', reason: 'model_failed', by: 'model' };
  }
}

/**
 * The reply for an owned lead's direct question or change request.
 * @param {{ contactId, text, kind: 'question'|'change_request', rep?: string|null, channel?: string,
 *           thread?: object[], contact?: object, nowMs?: number }} a
 * @returns {Promise<{ message: string, kind: string, used_fallback: boolean, reason: string|null, notified?: object }>}
 */
export async function writeOwnedAnswer(a = {}, deps = {}) {
  const d = { ...(await defaults()), ...deps };
  const rep = a.rep || null;
  if (a.kind === 'change_request') {
    const notified = await Promise.resolve(d.notifyChange({
      contactId: a.contactId, text: a.text, repName: rep, contact: a.contact || {},
    })).catch((err) => ({ posted: false, reason: `error: ${err.message}` }));
    return { message: changeRequestLine(rep), kind: 'change_request', used_fallback: false, reason: null, notified };
  }
  let faqs = [];
  try { faqs = (await d.matchFaqs(a.text)) || []; } catch (err) {
    console.warn(`[RehashOwnedAnswer] FAQ search failed for ${a.contactId}: ${String(err?.message || err).slice(0, 120)}`);
  }
  let draft = '';
  try {
    const out = await d.callLLM({
      fn: 'owned_answer', system: ownedAnswerSystem(rep),
      user: ownedAnswerPrompt({ question: a.text, faqs, thread: a.thread || [] }), maxTokens: 300,
    });
    draft = out?.text || '';
  } catch (err) {
    console.warn(`[RehashOwnedAnswer] model failed for ${a.contactId}: ${String(err?.message || err).slice(0, 120)} — the backup line`);
  }
  const done = finishOwnedAnswer(draft, { rep, channel: a.channel === 'email' ? 'email' : 'sms', thread: a.thread || [], inbound: a.text, nowMs: a.nowMs || Date.now() });
  return { message: done.text, kind: 'question', used_fallback: done.used_fallback, reason: done.reason, dropped: done.dropped, faq_count: faqs.length };
}

/**
 * The send handler's entry: reads the rep's first name, the thread and the
 * contact, then writes the reply. Never throws: any failure is the backup line
 * (a question) or the change line (a move or cancel), never silence after the
 * gate already decided to answer.
 */
export async function writeOwnedAnswerForSend({ contactId, channel = 'sms', kind, text }, deps = {}) {
  const read = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  const rep = await read(async () => (deps.resolveRep || (await import('../siro/f0-context.js')).resolveRehashRepFirst)(contactId), null);
  const contact = await read(async () => (deps.getContact || (async (id) => (await import('../actions/contact-cache.js')).getContactCached(id, null, { maxWaitMs: 2000 })))(contactId), null);
  const thread = await read(async () => {
    const { messages } = await (deps.fetchRecentMessages || (await import('../agentic/reply-sender.js')).fetchRecentMessages)(contactId);
    return (messages || [])
      .filter((m) => m && typeof m.body === 'string' && m.body.trim() && /^(inbound|outbound)$/i.test(String(m.direction || '')))
      .map((m) => ({ direction: String(m.direction).toLowerCase(), text: m.body, timestamp: m.dateAdded || null }))
      .sort((x, y) => (Date.parse(x.timestamp) || 0) - (Date.parse(y.timestamp) || 0));
  }, []);
  try {
    return await writeOwnedAnswer({
      contactId, text, kind, rep, channel, thread,
      contact: { firstName: contact?.firstName || null, phone: contact?.phone || null },
    }, deps);
  } catch (err) {
    console.warn(`[RehashOwnedAnswer] write failed for ${contactId}: ${String(err?.message || err).slice(0, 120)}`);
    const { ownedAnswerFallback } = await import('../agentic/rehash-owned-answer.js');
    return { message: kind === 'change_request' ? changeRequestLine(rep) : ownedAnswerFallback(rep), kind, used_fallback: true, reason: 'threw' };
  }
}
