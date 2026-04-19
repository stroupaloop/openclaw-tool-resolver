# openclaw-resolver

> Dynamic per-turn tool surface resolver for OpenClaw

> **Note on naming:** The npm package and GitHub repo are `openclaw-resolver`. The internal OpenClaw plugin ID is still `openclaw-tool-resolver` for backward-compat with existing installs — you'll see it in `openclaw.json` configs and extension paths.

Dynamic per-turn tool surface resolver for [OpenClaw](https://github.com/openclaw/openclaw). Intelligently narrows the tool list before each LLM call — reducing context pollution, improving tool selection accuracy, and cutting prompt tokens.

## The Problem

OpenClaw agents can have 30–50+ tools available. Every tool description is injected into the system prompt on every turn — consuming thousands of tokens regardless of whether the tools are relevant. This creates two problems:
1. **Wasted tokens** — tool definitions that will never be called still cost input tokens on every turn
2. **Context pollution** — the model sees irrelevant tools, increasing the chance of hallucinated or incorrect tool calls

## How It Works

```
User prompt → lightweight classifier LLM (~1s, parallel)
                    ↓
            Tool selection + confidence score
                    ↓
            Keyword cache validation (safety net)
                    ↓
            toolsAllow → OpenClaw before_prompt_build hook
                    ↓
            Primary model sees only relevant tools (67% fewer)
```

1. **LLM always classifies** — A fast, cheap classifier model analyzes each prompt and selects which tools the primary model actually needs. Any OpenAI-compatible LLM works; we tested 6 models and recommend `gpt-5.4-mini` (see [Benchmark Methodology & Roadmap](#benchmark-methodology--roadmap)).
2. **Keyword cache validates** — A learned cache cross-checks the LLM's selection, merging any tools the classifier may have missed. The cache never narrows — it only adds.
3. **Core tools always included** — `read`, `write`, `edit`, `exec`, `process`, `memory_search`, `memory_add`, `session_status` are always available regardless of classification.
4. **Graceful fallback** — On LLM timeout or error, falls back to keyword-based classification. On low confidence, returns the full tool surface.

## Benchmark Methodology & Roadmap

> **Full details:** [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md)

145-case benchmark across 14 categories, validated against 6 LLMs. Two configurations: deterministic (T=0, n=1, production-matched) and voted (T=0.3, n=5, ensemble reference). Primary metric is **must-include recall** — all required tools must appear in the classifier output. gpt-5.4-mini leads on the deterministic config (97.9% recall, 716ms p50); Claude Sonnet 4-6 achieves comparable recall at 2.2× latency and ~10× cost.

### Known Limitations (Short Form)

| Limitation | Why It Matters |
|------------|----------------|
| n=145 is small | Wide CIs for small categories; pairwise comparisons underpowered |
| Single-annotator ground truth | No inter-rater agreement; label quality unknown |
| Test data co-evolved with classifier prompt | Likely leakage; reported recall overstates OOD performance |
| No OOD coverage | Multilingual, typos, adversarial not tested |
| No human baseline | No ceiling reference |

See [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md) for the full limitations table, failure analysis, and roadmap. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Production Results

> 444 classification events over 2 days of production traffic (single agent, 42 tools)

### Measured Token Savings (Ground Truth)

Verified via LiteLLM `prompt_tokens` — actual tokens sent to the provider API. Production telemetry in this section was captured from a LiteLLM deployment; equivalent data can be collected from any proxy that logs prompt_tokens.

| Metric | Before Resolver | After Resolver | Delta |
|--------|---------------:|---------------:|------:|
| Avg prompt tokens/turn | 75,877 | 71,829 | **−4,048 (−5.3%)** |

This was measured on a heavy session (~76K tokens/turn) where tool definitions are a small fraction of total context. On lighter sessions where tools represent a larger share, the percentage reduction is proportionally higher.

### Classification Metrics

| Metric | Value |
|--------|-------|
| Tool surface reduction | **67%** (38 → 12.5 tools avg) |
| Estimated tokens saved per turn | **~3,700** (plugin estimate based on ~150 tokens/tool) |
| Measured tokens saved per turn | **4,048** (LiteLLM ground truth) |
| Classification latency (p50) | **1,136ms** |
| Avg confidence | **0.82** |
| Resolver cost | **$0.21 / 1K turns** |

> **Note:** The plugin's per-tool token estimate (~150 tokens/tool) is approximate. The LiteLLM measurement captures the actual difference including system prompt rebuilding with `setActiveToolsByName`, which removes tool descriptions, parameter schemas, and related prompt scaffolding.

### Cost Savings

Based on measured 4,048 tokens saved per turn:

| Primary Model | Savings / 1K turns | Monthly Net* | ROI |
|---------------|--------------------:|-------------:|----:|
| Claude Opus 4 ($15/M) | $60.72 | $403.00 | **288x** |
| Smart Router (blended) | $24.29 | $160.33 | **115x** |
| Claude Sonnet 4 ($3/M) | $12.14 | $79.47 | **57x** |
| GPT-5.4 ($2/M) | $8.10 | $52.58 | **38x** |

*Monthly projection: 6,660 turns/mo. Resolver overhead ($1.40/mo) subtracted.

**Even on the cheapest model, the resolver pays for itself 38x over.**

### Benchmark (v2 — Deterministic Config)

145 curated test cases, 14 categories. Primary metric: must-include recall (all required tools present). See [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md) for full results including voted config, CIs, and failure analysis.

| Model | Recall | CI₉₅ | Exact | p50/call | Errors |
|-------|-------:|------|------:|---------:|-------:|
| **gpt-5.4-mini** | **97.9%** | [94.1–99.3] | 64.1% | **716ms** | 0 |
| claude-sonnet-4-6 | 99.3% | [96.2–99.9] | 47.6% | 1,604ms | 0 |
| claude-haiku-4-5 | 95.9% | [91.3–98.1] | 53.1% | 959ms | 0 |
| gpt-5.4 | 93.8% | [88.6–96.7] | 61.4% | 1,024ms | 0 |
| grok-4.1-fast | 93.8% | [88.6–96.7] | 62.1% | 4,506ms | 0 |
| gemini-3-flash | 61.4% | [53.3–68.9] | 46.9% | 1,610ms | 83 ❌ |

**Key finding:** gpt-5.4-mini achieves 97.9% must-include recall at 716ms p50. Claude Sonnet 4-6 achieves statistically comparable recall (CIs overlap) at 2.2× the latency and ~10× the cost. Tool classification is a structured routing problem — over-reasoning hurts. Description quality, not model size, is the primary driver. The classifier model is configurable; we recommend `gpt-5.4-mini` based on these results.

## Installation

### As OpenClaw Extension (recommended)

```bash
# Clone into OpenClaw extensions directory
git clone https://github.com/stroupaloop/openclaw-resolver.git \
  ~/.openclaw/extensions/openclaw-tool-resolver
```

### Via npm

```bash
npm install openclaw-resolver
```

Then symlink or copy to `~/.openclaw/extensions/openclaw-tool-resolver/`.

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "openclaw-tool-resolver": {
      "enabled": true,
      "logDecisions": true,
      "telemetryFile": "~/.openclaw/workspace/resolver-telemetry.jsonl",
      "llmModel": "gpt-5.4-mini",
      "llmApiBase": "https://api.openai.com/v1",
      "llmApiKey": "YOUR_API_KEY"
    }
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the resolver |
| `logDecisions` | `true` | Log classification decisions to OpenClaw logs |
| `telemetryFile` | `""` | Path for JSONL telemetry (empty = disabled) |
| `llmModel` | `gpt-5.4-mini` | Classification model |
| `llmApiBase` | `https://api.openai.com/v1` | LLM API endpoint (LiteLLM, OpenAI, etc.) |
| `llmApiKey` | `""` | API key for the classification model |
| `capturePrompts` | `true` | Include prompt excerpts in telemetry |
| `promptExcerptLength` | `1500` | Max prompt chars in telemetry |

## Requirements

### OpenClaw Hook Support

This plugin requires the `before_prompt_build` hook to return `toolsAllow`, which narrows the tool surface before prompt assembly. This capability is proposed in [openclaw/openclaw#68734](https://github.com/openclaw/openclaw/pull/68734).

**Until the PR is merged**, you can apply a surgical patch to your local OpenClaw installation. See [PATCHING.md](PATCHING.md) for instructions.

### LLM API Access

The resolver needs access to a fast, cheap LLM for classification. Any OpenAI-compatible endpoint works. We benchmarked 6 models and recommend:
- **gpt-5.4-mini** — 97.9% must-include recall, fastest (716ms p50), cheapest
- **claude-sonnet-4-6** — statistically comparable recall with overlapping CI, at 2.2× latency
- See [Benchmark Methodology & Roadmap](#benchmark-methodology--roadmap) for the full comparison

## Architecture

### v3.1 Design Principles

1. **LLM always classifies** — The keyword cache is a validation layer, never a bypass. This ensures the classifier sees every prompt and improves over time.
2. **Recall over precision** — It's always better to include an unnecessary tool than to miss a needed one. The validation layer adds tools, never removes them.
3. **Zero external dependencies** — The plugin is a single `index.js` with no npm dependencies. Node.js built-ins only.
4. **Graceful degradation** — LLM failure → keyword fallback → full surface. The agent never loses tool access.

### Tool Groups

The resolver classifies prompts into functional categories and selects tools accordingly:

- **Core** (always included): `read`, `write`, `edit`, `exec`, `process`, `memory_search`, `memory_add`, `session_status`
- **Research**: `web_search`, `web_fetch`, `x_search`, `code_execution`, `pdf`
- **Coding**: `sessions_spawn`, `sessions_yield`, `subagents`
- **Financial**: `finance__*` tools, `code_execution`
- **Messaging**: `message`, `tts`
- **Media**: `image_generate`, `video_generate`, `tts`, `image`
- **Ops**: `browser`, `cron`, `gateway`
- **Browser**: `browser`, `web_fetch`, `image`

## Benchmark Suite

The repo includes a comprehensive benchmark framework:

```bash
cd benchmark

# Run single-model benchmark (default: gpt-5.4-mini)
LLM_MODEL=gpt-5.4-mini python3 replay-harness.py --file benchmark-v3.2-curated.json --verbose

# Specify different model
LLM_MODEL=claude-sonnet-4-6 python3 replay-harness.py --file benchmark-v3.2-curated.json

# Multi-model comparison
python3 model-benchmark.py

# Generate new test cases from production telemetry
python3 generate-cases.py --input ~/resolver-telemetry.jsonl
```

### Benchmark v3.2 — 145 Cases

| Stat | Value |
|------|-------|
| Total cases | 145 |
| Categories | 14 (financial, research, messaging, coding, ops, creative, browser, scheduling, devices, memory, workspace, multi-domain, core-only, adversarial) |
| Tool coverage | 93% (39/42 tools) |
| Single-tool cases | 72 |
| Multi-tool cases | 42 |
| Zero-tool (core-only) | 31 |
| Adversarial cases | 10 |

### Metrics

- **must_include_accuracy**: Required tools present in selection (primary metric)
- **avg_recall**: Proportion of expected tools selected
- **precision**: How many selected tools were actually needed
- **latency**: Classification response time (p50, p95)

## Description Overrides

The classifier's view of each tool/skill is driven by an internal description map (`TOOL_DESCRIPTIONS`, `SKILL_DESCRIPTIONS`). Different deployments need different phrasing — a research-heavy agent benefits from richer `web_search` triggers, an IoT-control agent needs more concrete `nodes` examples, and so on. Forking the plugin to edit descriptions doesn't scale.

Instead, plugin config accepts two override maps that merge on top of the defaults at boot:

```json
{
  "plugins": {
    "entries": {
      "openclaw-tool-resolver": {
        "enabled": true,
        "config": {
          "llmModel": "gpt-5.4-mini",
          "llmApiBase": "http://localhost:4000",
          "llmApiKey": "${LITELLM_KEY}",
          "telemetryFile": "~/.openclaw/workspace/resolver-telemetry.jsonl",
          "toolDescriptionOverrides": {
            "nodes": "Custom IoT description for THIS deployment: lab-bench instruments, pump controllers, sensor arrays",
            "web_search": "Use only for current pricing/competitive intel; default research goes through internal-kb tool"
          },
          "skillDescriptionOverrides": {
            "github": "Internal GitHub Enterprise instance only — repos prefixed acme/*"
          }
        }
      }
    }
  }
}
```

### Behavior

- **Per-key merge.** An override for `nodes` replaces just that one entry; every other tool keeps its baked-in description.
- **Unknown keys are tolerated.** If you override a tool that doesn't exist in your install, the override is simply unused (no error).
- **No restart required when MC writes overrides** — the plugin reads `config` on each plugin load. After OpenClaw reloads (or on next gateway restart), the overrides take effect on every classifier call.
- **Logged on activation.** When the plugin loads with overrides, you'll see:
  ```
  [tool-resolver] description overrides active: 2 tool(s), 1 skill(s)
  ```

### Use cases

- **Mission Control / orchestrator-driven tuning.** A control plane writes overrides into `openclaw.json` based on production telemetry (e.g., the daily resolver tuning loop — see `BENCHMARK-METHODOLOGY.md`). The plugin honors them without code changes.
- **Per-host customization across a fleet.** Different agents in a fleet can carry different override sets reflecting their actual tool mix.
- **A/B testing description changes** before promoting them upstream into the plugin's defaults.

### What overrides do NOT change

- The set of tools the classifier picks from — that's still `availableTools` from the OpenClaw runtime.
- Core-tool inclusion (always-on tools).
- The validation cache / classifier rules / fallback behavior.

Overrides ONLY change the description string the LLM sees for a given tool/skill ID.

## Telemetry

When `telemetryFile` is configured, the resolver logs one JSONL entry per turn:

```json
{
  "turn": 15,
  "toolsAllow": ["read", "write", "exec", "web_search", "web_fetch"],
  "source": "llm",
  "confidence": 0.98,
  "reasoning": "Research task requiring web access",
  "llmLatencyMs": 794,
  "llmTools": ["web_search", "web_fetch"],
  "validation": "agree",
  "availableTools": ["read", "write", "exec", "...42 tools..."],
  "tokensSaved": 3600,
  "sessionId": "sid_abc123",
  "agentId": "main",
  "ts": "2026-04-18T15:04:50.690Z"
}
```

`sessionId` and `agentId` are populated from the OpenClaw hook context when available (null otherwise). The classifier API call is tagged with `user: "openclaw-resolver"` and `x-openclaw-caller: tool-resolver` so LiteLLM proxies can filter resolver traffic by caller.

## Attribution & Cost Filtering

The resolver emits standard attribution metadata that any downstream LLM proxy or analytics layer can filter on:

- **OpenAI `user` field** — set to `"openclaw-resolver"` on every classifier request
- **HTTP header** — `x-openclaw-caller: tool-resolver` passed with every call
- **`metadata.tags` array** — always includes `["openclaw-resolver", "resolver:classify"]` plus any user-configured tags

LiteLLM is the tested reference implementation — its `LiteLLM_SpendLogs` schema exposes all three signals natively. Helicone, Portkey, LangSmith, or custom proxies should work similarly as they generally preserve pass-through fields.

### Default tags

Every request always includes:
```json
["openclaw-resolver", "resolver:classify"]
```

These two tags cannot be disabled — they are attribution infrastructure.

### Optional additional tags

Append extra tags via the `telemetry.tags` config option:

```json
{
  "plugins": {
    "openclaw-tool-resolver": {
      "telemetry": {
        "tags": ["my-agent", "production"]
      }
    }
  }
}
```

Configured tags are **appended** to the defaults:
```json
["openclaw-resolver", "resolver:classify", "my-agent", "production"]
```

### Example (LiteLLM-specific SQL)

Filter resolver calls from `LiteLLM_SpendLogs` using the tags JSONB column:

```sql
-- All resolver spend
SELECT SUM(spend), COUNT(*)
FROM "LiteLLM_SpendLogs"
WHERE metadata->'tags' @> '["openclaw-resolver"]'::jsonb;

-- By agent tag (if you configured telemetry.tags: ["my-agent"])
SELECT SUM(spend), COUNT(*)
FROM "LiteLLM_SpendLogs"
WHERE metadata->'tags' @> '["my-agent"]'::jsonb;
```

### Other proxies

The same attribution pattern works with any proxy that passes through OpenAI-compatible fields. Helicone, Portkey, and LangSmith all preserve the `user` field and custom headers by default. If your proxy supports metadata or tags, configure it to filter on `openclaw-resolver` or `resolver:classify`. Adapt the query above for your proxy's logging schema.

**Privacy**: Telemetry captures prompt excerpts by default for debugging. Set `capturePrompts: false` to disable. No telemetry is sent externally — all data stays local.

## Related Work

Several benchmarks evaluate LLM tool use, but none address the specific task of tool *pre-filtering* in production assistants:

- **[BFCL v4](https://gorilla.cs.berkeley.edu/leaderboard.html)** (Berkeley) — Measures function-calling accuracy (parameter extraction). Our task is upstream: tool *selection*, not invocation.
- **[RAG-MCP](https://arxiv.org/abs/2505.03275) / [ScaleMCP](https://arxiv.org/abs/2505.06416)** — Closest analogues; evaluate tool retrieval at scale using synthetic tool sets. Our work differs in using production-deployed tools with iteratively refined descriptions.
- **LiveToolBench, ToolSandbox** — End-to-end execution evaluation, architecturally downstream from our classification step.

No existing benchmark targets the pre-filter classification task in production AI assistants. We constructed a deployment-specific corpus of 145 cases across 14 categories and validated across 6 LLMs. We acknowledge this limits direct cross-benchmark comparison, though the methodology is reproducible and the harness is open-source.

## Roadmap

- [ ] Dynamic tool descriptions (generate per-turn instead of static map)
- [ ] Confidence-weighted caching (weight cache entries by LLM confidence)
- [ ] Multi-agent profile sharing (shared keyword cache across agents)
- [ ] Dashboard integration (real-time savings visualization)
- [ ] Automated monthly benchmark regression with CI

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
