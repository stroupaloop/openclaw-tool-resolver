# openclaw-tool-resolver

Dynamic per-turn tool surface resolver for [OpenClaw](https://github.com/openclaw/openclaw). Reduces token usage by 67% by intelligently narrowing the tool list before each LLM call.

## The Problem

OpenClaw agents can have 30–50+ tools available. Every tool description is injected into the system prompt on every turn — consuming thousands of tokens regardless of whether the tools are relevant. For premium models like Claude Opus, this costs **$0.05+ per turn** in wasted input tokens.

## How It Works

```
User prompt → gpt-5.4-mini classifier (~1.1s, parallel)
                    ↓
            Tool selection + confidence score
                    ↓
            Keyword cache validation (safety net)
                    ↓
            toolsAllow → OpenClaw before_prompt_build hook
                    ↓
            Primary model sees only relevant tools (67% fewer)
```

1. **LLM always classifies** — A fast, cheap model (`gpt-5.4-mini`) analyzes each prompt and selects which tools the primary model actually needs
2. **Keyword cache validates** — A learned cache cross-checks the LLM's selection, merging any tools the classifier may have missed. The cache never narrows — it only adds.
3. **Core tools always included** — `read`, `write`, `edit`, `exec`, `process`, `memory_search`, `memory_add`, `session_status` are always available regardless of classification
4. **Graceful fallback** — On LLM timeout or error, falls back to keyword-based classification. On low confidence, returns the full tool surface.

## Production Results

> 444 classification events over 2 days of production traffic (single agent, 42 tools)

| Metric | Value |
|--------|-------|
| Tool surface reduction | **67%** (38 → 12.5 tools avg) |
| Tokens saved per turn | **3,707** |
| Classification latency (p50) | **1,136ms** |
| Avg confidence | **0.82** |
| Resolver cost | **$0.21 / 1K turns** |

### Cost Savings

| Primary Model | Savings / 1K turns | Monthly Net* | ROI |
|---------------|--------------------:|-------------:|----:|
| Claude Opus 4 ($15/M) | $55.61 | $368.97 | **265x** |
| Smart Router (blended) | $22.25 | $146.75 | **106x** |
| Claude Sonnet 4 ($3/M) | $11.12 | $72.68 | **53x** |
| GPT-5.4 ($2/M) | $7.42 | $47.98 | **35x** |

*Monthly projection: 6,660 turns/mo. Resolver overhead ($1.40/mo) subtracted.

**Even on the cheapest model, the resolver pays for itself 35x over.**

### Benchmark Accuracy

116 curated test cases across 7 tool categories:

| Model | Accuracy | Recall | p50 Latency |
|-------|----------|--------|-------------|
| gpt-5.4-mini | **100%** | 97% | 2,663ms |
| gpt-5.4-nano | 98.3% | 94% | 1,841ms |
| claude-haiku-4-5 | 97.4% | 93% | 2,105ms |
| grok-4.1-fast | 95.7% | 91% | 1,950ms |

## Installation

### As OpenClaw Extension (recommended)

```bash
# Clone into OpenClaw extensions directory
git clone https://github.com/stroupaloop/openclaw-tool-resolver.git \
  ~/.openclaw/extensions/openclaw-tool-resolver
```

### Via npm

```bash
npm install openclaw-tool-resolver
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

This plugin requires the `before_prompt_build` hook to return `toolsAllow`, which narrows the tool surface before prompt assembly. This capability is proposed in [openclaw/openclaw#68608](https://github.com/openclaw/openclaw/pull/68608).

**Until the PR is merged**, you can apply a surgical patch to your local OpenClaw installation. See [PATCHING.md](PATCHING.md) for instructions.

### LLM API Access

The resolver needs access to a fast, cheap LLM for classification. Recommended:
- **gpt-5.4-mini** via OpenAI API or LiteLLM proxy (best accuracy)
- **gpt-5.4-nano** for lowest cost with slightly lower accuracy
- Any OpenAI-compatible API endpoint

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

The repo includes a comprehensive benchmark framework with 116 curated test cases:

```bash
cd benchmark

# Run single-model benchmark
python3 replay-harness.py --file benchmark-v3-curated.json --verbose

# Compare multiple models
python3 model-benchmark.py

# Generate new test cases from production telemetry
python3 generate-cases.py --input ~/resolver-telemetry.jsonl

# Monthly benchmark + report
python3 monthly-benchmark.py
```

### Benchmark Metrics

- **must_include_accuracy**: Required tools present in selection (primary metric)
- **avg_recall**: Proportion of expected tools selected
- **precision**: How many selected tools were actually needed
- **latency**: Classification response time (p50, p95)
- **cost_per_1k**: API cost per 1,000 classifications

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
  "ts": "2026-04-18T15:04:50.690Z"
}
```

**Privacy**: Telemetry captures prompt excerpts by default for debugging. Set `capturePrompts: false` to disable. No telemetry is sent externally — all data stays local.

## Roadmap

- [ ] Dynamic tool descriptions (generate per-turn instead of static map)
- [ ] Confidence-weighted caching (weight cache entries by LLM confidence)
- [ ] Multi-agent profile sharing (shared keyword cache across agents)
- [ ] Dashboard integration (real-time savings visualization)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
