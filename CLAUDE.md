# CLAUDE.md — openclaw-resolver

## What This Is

Dynamic per-turn tool surface resolver for [OpenClaw](https://github.com/openclaw/openclaw). Ships as an npm package (`@openclaw/openclaw-resolver`) installed as an OpenClaw plugin.

**Plugin ID:** `openclaw-tool-resolver` (backward-compat with existing installs)

## Stack

- JavaScript (ES modules, no TypeScript)
- Node.js >= 18 (per package.json engines; 22+ recommended for development)
- OpenClaw plugin SDK (`openclaw.plugin.json` manifest)
- Benchmark suite in Python (`benchmark/`)

## Key Files

```
index.js                      ← Main plugin entry (all logic in one file)
openclaw.plugin.json          ← Plugin manifest (hooks, config schema)
default-catalog.json          ← Default tool catalog with descriptions
schemas/catalog.v1.json       ← JSON schema for catalog format
schemas/proposal.v1.json      ← JSON schema for classifier output
benchmark/                    ← Python benchmark suite (145 cases, 6 models)
  benchmark-v3.2-curated.json ← Ground truth dataset
  model-benchmark.py          ← Run benchmarks across models
  generate-cases.py           ← Generate new test cases
  replay-harness.py           ← Replay existing cases for regression testing
  monthly-benchmark.py        ← Scheduled monthly benchmark run
```

## How It Works

1. LLM classifier (fast, cheap model like gpt-5.4-mini) analyzes each user prompt
2. Selects which tools the primary model actually needs
3. Keyword cache validates (adds missed tools, never narrows)
4. Core tools always included (read, write, edit, exec, etc.)
5. Graceful fallback on error → full tool surface

## Development

```bash
npm install           # install deps
npm test              # run tests (if present)
npm run lint          # lint (if configured)
```

## Benchmark

```bash
cd benchmark
pip install -r requirements.txt  # if present
python model-benchmark.py        # run full model comparison
python replay-harness.py         # regression test against ground truth
```

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `benchmark:`)
- **No AI attribution:** Never add `Co-Authored-By` trailers
- **Single-file architecture:** All plugin logic lives in `index.js` — keep it that way unless there's a compelling reason to split
- **Catalog changes:** Update both `default-catalog.json` and `schemas/catalog.v1.json` together
- **Benchmark changes:** Re-run `replay-harness.py` to verify no regression before shipping

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — the agent runtime this plugin extends
- [ender-stack](https://github.com/stroupaloop/ender-stack) — infrastructure stack (LiteLLM config includes resolver telemetry endpoint)
- [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md) — full benchmark methodology, limitations, roadmap
- [PRODUCTION-METRICS.md](PRODUCTION-METRICS.md) — production performance metrics
- [PATCHING.md](PATCHING.md) — how to patch the plugin into an existing OpenClaw install
