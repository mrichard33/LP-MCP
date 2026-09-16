/**
 * text-sanitize.js — strip invisible characters from text before it reaches a
 * model's context.
 *
 * WHY (2026-09-16). Unicode TAG characters (U+E0000–U+E007F) render as nothing
 * in a terminal, a chat window and a dashboard, but arrive at a model fully
 * visible. That makes them a prompt-injection smuggling channel: a block of
 * instructions can sit inside a contact's name or a text message and be
 * invisible to every human who reviews it.
 *
 * This matters here specifically because the MCP tools return customer-authored
 * text — message bodies, contact names, note content — straight from GHL and
 * LP into an agent's context. Anyone who can text the business can put
 * characters in that text.
 *
 * Valid emoji tag sequences are PRESERVED. The subdivision flags (Scotland,
 * Wales, England) are built from a base flag followed by tag characters and a
 * terminator; stripping tag characters blindly breaks them. Only tag characters
 * that are not part of such a sequence are removed.
 *
 * The idea is borrowed from Hermes Agent's `tools/ansi_strip.py` (MIT), which
 * in turn credits block/goose#10746.
 */

/** Cheap pre-check: the overwhelming majority of strings contain no tag chars. */
const HAS_UNICODE_TAG = /[\u{E0000}-\u{E007F}]/u;

/**
 * Group 1 is a whole valid emoji tag sequence (waving black flag, one or more
 * tag-spec characters, cancel-tag terminator) and is kept verbatim. Everything
 * else in the tag block is dropped.
 */
const UNICODE_TAG_SUB =
  /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

export function stripUnicodeTags(text) {
  if (!text || !HAS_UNICODE_TAG.test(text)) return text;
  return text.replace(UNICODE_TAG_SUB, (_m, keep) => keep || '');
}

/**
 * Sanitize an MCP tool result in place of its text parts.
 *
 * Returns the SAME object when nothing changed, so the common path allocates
 * nothing. A result that is not the standard `{ content: [...] }` shape is
 * returned untouched rather than reshaped — this must never change what a tool
 * returns beyond removing invisible characters.
 */
export function sanitizeToolResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((part) => {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      const clean = stripUnicodeTags(part.text);
      if (clean !== part.text) {
        changed = true;
        return { ...part, text: clean };
      }
    }
    return part;
  });
  return changed ? { ...result, content } : result;
}

/**
 * Wrap an MCP server so every tool registered through it has its text results
 * sanitized.
 *
 * Registration is the single choke point: all 126 tools register through
 * `server.tool(name, description, schema, handler)` with the handler last, so
 * one wrapper here covers every tool, including ones added later. Doing it at
 * each `return { content: [...] }` would mean touching ~126 sites and missing
 * the 127th.
 *
 * A registration whose last argument is not a function is passed through
 * unchanged rather than guessed at.
 */
export function withSanitizedResults(server) {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'tool') return Reflect.get(target, prop, receiver);
      return (...args) => {
        const handler = args[args.length - 1];
        if (typeof handler !== 'function') return target.tool(...args);
        const wrapped = async (...handlerArgs) => sanitizeToolResult(await handler(...handlerArgs));
        return target.tool(...args.slice(0, -1), wrapped);
      };
    },
  });
}
