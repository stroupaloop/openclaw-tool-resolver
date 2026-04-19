# Production Metrics — OpenClaw Tool Resolver v3.1

> Live telemetry from a production OpenClaw deployment (single agent, 42 tools)
> Period: April 17–18, 2026 (2 days, 444 classification events)

## Summary

| Metric | Value | Source |
|--------|-------|--------|
| Classification events | 444 | Plugin telemetry |
| Avg events/day | 222 | Plugin telemetry |
| Avg tool surface reduction | **67%** (38 → 12.5 tools) | Plugin telemetry |
| Estimated tokens saved/turn | **~3,700** | Plugin estimate (~150 tokens/tool) |
| **Measured tokens saved/turn** | **4,048** | **LiteLLM `prompt_tokens` (ground truth)** |
| **Measured prompt token reduction** | **5.3%** | **LiteLLM (heavy session, ~76K tokens/turn)** |
| Classification latency (p50) | **1,136ms** | Plugin telemetry |
| Classification latency (p95) | **2,524ms** | Plugin telemetry |
| Avg confidence | **0.82** | Plugin telemetry |
| Resolver overhead | **$0.21 / 1K turns** | API pricing |

> **Measurement methodology:** Ground truth token counts from LiteLLM PostgreSQL `LiteLLM_SpendLogs.prompt_tokens`, which reflects the actual tokens sent to and reported by the provider API. The 5.3% reduction was measured on a heavy session (~76K tokens/turn) where system prompt, workspace files, and conversation history dominate. On lighter sessions where tool definitions represent a larger share of total context, the percentage reduction is proportionally higher.

## Cost Savings

The resolver uses `gpt-5.4-mini` for classification at ~$0.0002/turn. Net savings depend on the primary model:

| Primary Model | Rate (input) | Savings / 1K turns | Monthly Net* | ROI |
|---------------|-------------|--------------------:|-------------:|----:|
| Claude Opus 4 | $15/M tokens | $55.61 | $368.97 | **265x** |
| Blended / Smart Router | $6/M tokens | $22.25 | $146.75 | **106x** |
| Claude Sonnet 4 | $3/M tokens | $11.12 | $72.68 | **53x** |
| GPT-5.4 | $2/M tokens | $7.42 | $47.98 | **35x** |

*Monthly projection based on 6,660 turns/month (222/day). Resolver overhead ($1.40/mo) already subtracted.

**Even on the cheapest model (GPT-5.4 at $2/M tokens), the resolver pays for itself 35x over.**

## Classification Latency

| Percentile | Latency |
|-----------|---------|
| Min | 708ms |
| p50 | 1,136ms |
| Mean | 1,293ms |
| p95 | 2,524ms |
| Max | 4,190ms |

Classification runs in parallel with session setup. Effective user-facing latency impact is typically <500ms (hidden behind context assembly, memory retrieval, etc.).

## Confidence Distribution

```
≥0.9 :  149 (34.8%) █████████████████
0.8–0.9: 116 (27.1%) █████████████
0.7–0.8:  83 (19.4%) █████████
0.6–0.7:  80 (18.7%) █████████
<0.6  :   0 ( 0.0%)
```

Average confidence: **0.82**. Zero sub-0.6 events — the hybrid threshold (0.6) ensures fallback to full tool surface when the classifier isn't confident.

## Tool Surface Reduction

Average across all 444 events:
- **Before**: 37.9 tools available
- **After**: 12.5 tools selected
- **Removed**: 25.4 tools (67%)

### Plugin estimate vs ground truth

| Method | Tokens saved/turn | Notes |
|--------|------------------:|-------|
| Plugin estimate | ~3,700 | Based on ~150 tokens/tool × 25.4 tools removed |
| LiteLLM measured | **4,048** | Actual `prompt_tokens` delta, includes tool descriptions + parameter schemas + prompt scaffolding |

The measured savings are slightly higher than the plugin estimate because `setActiveToolsByName` also removes parameter schemas and related prompt scaffolding that the per-tool estimate doesn't capture.

## Validation Layer

The keyword cache acts as a safety net, catching tools the LLM classifier may have missed:

| Validation Result | Description |
|-------------------|-------------|
| `pass` | LLM selection accepted as-is |
| `merged_cache_tools` | Cache identified additional tools, merged into final set |
| `llm_may_miss` | LLM returned minimal set, cache expanded conservatively |

The validation layer ensures **recall is prioritized over precision** — it's always better to include an unnecessary tool than to miss a needed one.

## Multi-Model Benchmark (v2 — April 2026)

> **Full methodology, limitations, and roadmap:** [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md)

145 curated test cases across 14 categories. Two configurations measured:

- **Deterministic** (T=0, n=1) — production-matched; what ships
- **Voted** (T=0.3, n=5) — ensemble reference; shows the ceiling at 5× cost

> **Metric note:** Previous versions (v3.2) reported `accuracy` or `must_include_accuracy`. As of v2, this metric is labeled **must-include recall** — the computation is identical; only the label changed to clarify what is measured.

### Deterministic Config (T=0, n=1) — Production-Matched

| Model | Recall | CI₉₅ | Exact | F1 | Precision | p50/call | Errors |
|-------|-------:|------|------:|----:|---------:|---------:|-------:|
| **gpt-5.4-mini** | **97.9%** | [94.1–99.3] | **64.1%** | **0.85** | 82.2% | **716ms** | 0 |
| claude-sonnet-4-6 | 99.3% | [96.2–99.9] | 47.6% | 0.79 | 74.0% | 1,604ms | 0 |
| claude-haiku-4-5 | 95.9% | [91.3–98.1] | 53.1% | 0.80 | 77.8% | 959ms | 0 |
| gpt-5.4 | 93.8% | [88.6–96.7] | 61.4% | 0.82 | 81.9% | 1,024ms | 0 |
| grok-4.1-fast | 93.8% | [88.6–96.7] | 62.1% | 0.82 | 80.2% | 4,506ms | 0 |
| gemini-3-flash | 61.4% | [53.3–68.9] | 46.9% | 0.56 | 91.2% | 1,610ms | 83 ❌ |

95% Wilson confidence intervals on recall and exact-match rate; bootstrap CIs on latency. Gemini-3-flash produced 83 malformed JSON responses out of 145 — classified as task-fit failures (prompt format incompatibility), not capability failures.

### Voted Config (T=0.3, n=5) — Ensemble Reference

| Model | Recall | CI₉₅ | Exact | p50/call | Errors |
|-------|-------:|------|------:|---------:|-------:|
| gpt-5.4-mini | 99.3% | [96.2–99.9] | 66.2% | 710ms | 0 |
| claude-sonnet-4-6 | 99.3% | [96.2–99.9] | 48.3% | 1,598ms | 0 |
| claude-haiku-4-5 | 95.9% | [91.3–98.1] | 53.1% | 959ms | 0 |
| gpt-5.4 | 93.8% | [88.6–96.7] | 61.4% | 1,056ms | 0 |
| grok-4.1-fast | 91.0% | [85.3–94.7] | 66.2% | 4,160ms | 1 |
| gemini-3-flash | 63.4% | [55.4–70.9] | 45.5% | 1,683ms | 75 ❌ |

### Key Takeaway

gpt-5.4-mini achieves **97.9% must-include recall** (95% CI: 94.1–99.3%) at **716ms p50** on a 145-case benchmark. Claude Sonnet 4-6 achieves statistically comparable recall (CIs overlap) at 2.2× the latency and ~10× the cost. For production tool-routing classification, gpt-5.4-mini is the configuration we ship.

See [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md) for full methodology and known limitations.

## Production Telemetry Methodology

- Token savings estimated at ~150 tokens per tool description (conservative; actual varies by tool)
- Cost calculations use published API pricing for each model
- Resolver overhead calculated at 800 input + 150 output tokens per gpt-5.4-mini call
- Monthly projections assume consistent daily usage patterns
- All production data from real telemetry (no synthetic benchmarks)
- Production telemetry in this section was captured from a LiteLLM deployment; equivalent data can be collected from any proxy that logs prompt_tokens.
