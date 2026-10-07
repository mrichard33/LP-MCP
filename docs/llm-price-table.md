# LLM price table — the value for `LLM_PRICE_TABLE_JSON`

Copied **2026-10-07** from the provider pricing pages:
- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (Model pricing table)
- OpenAI: https://developers.openai.com/api/docs/pricing (Standard tier)

`src/llm-usage.js` reads this from the Railway variable `LLM_PRICE_TABLE_JSON`; nothing in code reads
this file. It is kept here so the rates in production are reproducible and dated. When a provider
changes a price, edit this file and the Railway variable together.

## Paste this as the Railway value (one line)

```
{"claude-fable-5-1":{"in":10,"out":50,"cache_read":0.25,"cache_write":12.5},"claude-mythos-5-1":{"in":10,"out":50,"cache_read":0.25,"cache_write":12.5},"claude-fable-5":{"in":10,"out":50,"cache_read":1,"cache_write":12.5},"claude-mythos-5":{"in":10,"out":50,"cache_read":1,"cache_write":12.5},"claude-opus-5-5":{"in":4,"out":20,"cache_read":0.2,"cache_write":5},"claude-opus-5":{"in":5,"out":25,"cache_read":0.5,"cache_write":6.25},"claude-opus-4-8":{"in":5,"out":25,"cache_read":0.5,"cache_write":6.25},"claude-opus-4-7":{"in":5,"out":25,"cache_read":0.5,"cache_write":6.25},"claude-opus-4-6":{"in":5,"out":25,"cache_read":0.5,"cache_write":6.25},"claude-opus-4-5":{"in":5,"out":25,"cache_read":0.5,"cache_write":6.25},"claude-opus-4-1":{"in":15,"out":75,"cache_read":1.5,"cache_write":18.75},"claude-opus-4":{"in":15,"out":75,"cache_read":1.5,"cache_write":18.75},"claude-sonnet-5-5":{"in":2,"out":10,"cache_read":0.2,"cache_write":2.5},"claude-sonnet-5":{"in":2,"out":10,"cache_read":0.2,"cache_write":2.5},"claude-sonnet-4-6":{"in":3,"out":15,"cache_read":0.3,"cache_write":3.75},"claude-sonnet-4-5":{"in":3,"out":15,"cache_read":0.3,"cache_write":3.75},"claude-sonnet-4":{"in":3,"out":15,"cache_read":0.3,"cache_write":3.75},"claude-haiku-4-5":{"in":1,"out":5,"cache_read":0.1,"cache_write":1.25},"claude-3-5-haiku":{"in":0.8,"out":4,"cache_read":0.08,"cache_write":1},"gpt-6-astra":{"in":10,"out":50,"cache_read":1,"cache_write":12.5},"gpt-6.1-sol":{"in":2,"out":10,"cache_read":0.1,"cache_write":2.5},"gpt-6-sol":{"in":2,"out":10,"cache_read":0.2,"cache_write":2.5},"gpt-6-luna":{"in":0.1,"out":0.5,"cache_read":0.01,"cache_write":0.125},"gpt-5.6-sol":{"in":4,"out":20,"cache_read":0.4,"cache_write":5},"gpt-5.6-terra":{"in":2,"out":12,"cache_read":0.2,"cache_write":2.5},"gpt-5.6-luna":{"in":0.2,"out":1.2,"cache_read":0.02,"cache_write":0.25},"gpt-5.5":{"in":5,"out":30,"cache_read":0.5},"gpt-5.5-pro":{"in":30,"out":180},"gpt-5.4":{"in":2.5,"out":15,"cache_read":0.25},"gpt-5.4-mini":{"in":0.75,"out":4.5,"cache_read":0.075},"gpt-5.4-nano":{"in":0.2,"out":1.25,"cache_read":0.02},"gpt-5.4-pro":{"in":30,"out":180},"gpt-5.3-codex":{"in":1.75,"out":14,"cache_read":0.175},"gpt-5.2":{"in":1.75,"out":14,"cache_read":0.175},"gpt-5.2-pro":{"in":21,"out":168},"gpt-5.1":{"in":1.25,"out":10,"cache_read":0.125},"gpt-5":{"in":1.25,"out":10,"cache_read":0.125},"gpt-5-mini":{"in":0.25,"out":2,"cache_read":0.025},"gpt-5-nano":{"in":0.05,"out":0.4,"cache_read":0.005},"gpt-5-pro":{"in":15,"out":120},"gpt-4.1":{"in":2,"out":8,"cache_read":0.5},"gpt-4.1-mini":{"in":0.4,"out":1.6,"cache_read":0.1},"gpt-4.1-nano":{"in":0.1,"out":0.4,"cache_read":0.025},"gpt-4o":{"in":2.5,"out":10,"cache_read":1.25},"gpt-4o-2024-05-13":{"in":5,"out":15},"gpt-4o-mini":{"in":0.15,"out":0.6,"cache_read":0.075},"o1":{"in":15,"out":60,"cache_read":7.5},"o1-pro":{"in":150,"out":600},"o3":{"in":2,"out":8,"cache_read":0.5},"o3-pro":{"in":20,"out":80},"o3-mini":{"in":1.1,"out":4.4,"cache_read":0.55},"o4-mini":{"in":1.1,"out":4.4,"cache_read":0.275},"chat-latest":{"in":5,"out":30,"cache_read":0.5}}
```

## How the rates were chosen

- **Per 1M tokens, USD.** `in` = uncached input, `out` = output (thinking/reasoning tokens bill as
  output on both providers), `cache_read` = cache hit, `cache_write` = cache write.
- **Anthropic `cache_write` is the 5-minute write.** `callLLM` sends `cache_control: { type: 'ephemeral' }`
  with no `ttl`, which is the 5-minute cache. If a call site ever asks for `ttl: '1h'`, its writes cost
  2x input, not 1.25x, and this table will under-count them.
- **OpenAI is the Standard tier, short context (≤272K input).** No call here comes near 272K. Batch,
  Flex and Fast tiers are not used by `callLLM`.
- **Not included:** data-residency uplifts (we use global routing), Anthropic Fast mode, OpenAI
  audio/image/embedding/transcription models (none go through `callLLM`), and legacy models.
- **gpt-5.6-sol** is at OpenAI's promotional price, "available at least through November 21, 2026".
  Re-check it after that date.

## Lookup rules worth knowing

`rateFor()` matches the exact model id first, then the **longest key that is a prefix** of it. So a
dated id (`claude-haiku-4-5-20251001`, `gpt-5.4-mini-2026-03-17`) gets its family's rate, which is
right. But a NEW model whose id starts with an older key gets the older key's rate until it is added
here: a hypothetical `claude-opus-5-9` would be priced as `claude-opus-5`. Add every new model the
day it is switched on. A model that matches no key at all is stored with `cost_usd` NULL and shows
as "unpriced" on the dashboard.
