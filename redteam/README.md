# Red team (IT review 2026-09-23 · AI OS CANON.SEC.010)

Three layers, cheapest first:

| Layer | What | When | Cost |
|---|---|---|---|
| 1. Regression (CI) | `scripts/test-redteam-injection.js` runs the attack + benign corpus (`scripts/fixtures/redteam-corpus.js`) through the injection guard and the call-transcript path. Offline, deterministic. | Every PR (`npm test`; CI blocks on red). | Free |
| 2. Promptfoo | `redteam/promptfooconfig.yaml`: a fixed attack suite and generated attacks (prompt extraction, hijacking, excessive agency, PII, jailbreak/crescendo/base64) against the **real bots** through `/admin/bot-simulate`. Nothing is sent or written. | Before any prompt or model change, and monthly. | Real model calls |
| 3. Garak | NVIDIA garak probes (`promptinject`, `dan`, `encoding`, `latentinjection`, `leakreplay`) against the same simulator, through `redteam/sync-proxy.mjs`. | Quarterly, or after a major change. | Real model calls |

## Run Promptfoo
```bash
export LP_MCP_URL=https://<lp-mcp>.up.railway.app ADMIN_API_TOKEN=<from Railway>
npx promptfoo@latest eval -c redteam/promptfooconfig.yaml
npx promptfoo@latest redteam run -c redteam/promptfooconfig.yaml
```

## Run Garak
```bash
node redteam/sync-proxy.mjs &          # localhost:8787, wraps the async simulator
pip install garak
python -m garak --model_type rest -G redteam/garak-rest.json \
  --probes promptinject,dan,encoding,latentinjection,leakreplay
```

## After a run
1. Add the date, pass rate and every failure to `docs/redteam-runs.md`.
2. A failure that reached a reply goes into `scripts/test-golden-replay.js` (CLAUDE.md), and a new attack shape goes into the corpus. **The suite only grows.**
3. Run `run_bot_eval` after any fix. Ship only if it does not read worse than the last run.
