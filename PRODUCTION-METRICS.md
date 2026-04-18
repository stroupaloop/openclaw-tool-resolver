# Production Metrics — OpenClaw Tool Resolver v3.1

> Live telemetry from a production OpenClaw deployment (single agent, 42 tools)
> Period: April 17–18, 2026 (2 days, 444 classification events)

## Summary

| Metric | Value |
|--------|-------|
| Classification events | 444 |
| Avg events/day | 222 |
| Avg tool surface reduction | **67%** (38 → 12.5 tools) |
| Avg tokens saved/turn | **3,707** |
| Total tokens saved | **1,646,100** |
| Classification latency (p50) | **1,136ms** |
| Classification latency (p95) | **2,524ms** |
| Avg confidence | **0.82** |
| Resolver overhead | **$0.21 / 1K turns** |

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

This translates to ~3,700 fewer tokens in the system prompt per turn. For Opus-class models, that's **~$0.056 saved per turn** in input costs alone.

## Validation Layer

The keyword cache acts as a safety net, catching tools the LLM classifier may have missed:

| Validation Result | Description |
|-------------------|-------------|
| `pass` | LLM selection accepted as-is |
| `merged_cache_tools` | Cache identified additional tools, merged into final set |
| `llm_may_miss` | LLM returned minimal set, cache expanded conservatively |

The validation layer ensures **recall is prioritized over precision** — it's always better to include an unnecessary tool than to miss a needed one.

## Multi-Model Benchmark (v3.2)

145 curated test cases across 14 categories, 3 runs per model (April 18, 2026):

| Model | Accuracy | Recall | Precision | p50 | p95 |
|-------|----------|--------|-----------|-----|-----|
| **gpt-5.4-mini** | **99.1%** | 94.8% | 81.2% | **856ms** | 1,240ms |
| claude-sonnet-4-6 | 98.4% | 94.1% | 74.5% | 1,615ms | 3,081ms |
| gpt-5.4 | 94.3% | 91.9% | 81.3% | 1,190ms | 1,904ms |
| claude-haiku-4-5 | 92.6% | 89.3% | 76.1% | 1,070ms | 1,953ms |
| grok-4.1-fast | 91.0% | 91.2% | 80.2% | 4,089ms | 8,961ms |
| gemini-3-flash | 64.6% | 64.1% | 89.4% | 1,454ms | 2,068ms |

### Analysis

- **gpt-5.4-mini is the clear winner**: fastest, cheapest, highest accuracy. Confirms that tool classification is a structured routing task where smaller models outperform larger ones.
- **Claude Sonnet is a strong second** but at 2x the latency and lower precision (more false positives).
- **gpt-5.4 (full) underperforms mini**: larger model over-reasons on a classification task that benefits from decisiveness.
- **Gemini struggles** with domain-specific tool names (finance, memory management, session tools). High precision but terrible recall — it consistently under-selects.
- **Grok's latency is prohibitive** for a pre-filter use case: 4s p50, 9s p95.

## Methodology

- Token savings estimated at ~150 tokens per tool description (conservative; actual varies by tool)
- Cost calculations use published API pricing for each model
- Resolver overhead calculated at 800 input + 150 output tokens per gpt-5.4-mini call
- Monthly projections assume consistent daily usage patterns
- All production data from real telemetry (no synthetic benchmarks)
- Benchmark accuracy measured as must-include recall: all required tools must be present in the classifier output
