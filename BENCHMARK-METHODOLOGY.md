# Benchmark Methodology — openclaw-resolver

> Version: v2 (April 2026) | Configurations: deterministic (T=0, n=1) and voted (T=0.3, n=5)

## 1. Intent

This benchmark is an **internal production-configuration benchmark**, not a generalized capability claim about the LLMs tested.

The goal is to answer one specific question: *which model should we ship as the default classifier for openclaw-resolver?* The answer is deployment-specific — it depends on the resolver's prompt structure, the tool surface it classifies against, and the scoring criteria we care about (must-include recall above precision). Results should not be interpreted as statements about model quality for other tasks.

If you are evaluating whether to use openclaw-resolver in your own deployment, this benchmark tells you what to expect *on this tool surface and prompt style*. If you run the same harness against your own tool set, you may see different relative model rankings.

---

## 2. Dataset

**145 cases** across **14 categories** (financial, research, messaging, coding, ops, creative, browser, scheduling, devices, memory, workspace, multi-domain, core-only, adversarial).

### Construction

Cases were hand-curated from two sources:
1. Production telemetry — real prompts captured from a live OpenClaw deployment (with PII removed)
2. Synthetic gap-fill — additional cases written to cover categories underrepresented in production traffic

All cases are English professional prompts. No multilingual, adversarial typo, or synthetic noise cases are included in the main set (10 adversarial prompt-injection cases are included but labeled separately).

### Distribution

| Category | n | Notes |
|----------|---|-------|
| financial | 12 | Financial-tool integration (generic) |
| research | 15 | Web search, PDF, X/Twitter |
| messaging | 10 | Single-tool (message), all passing |
| creative | 11 | Image, video, TTS generation |
| browser | 8 | Web fetch, live browser control |
| scheduling | 8 | Cron, message |
| ops | 17 | Sessions, subagents, gateway |
| devices | 8 | Nodes/IoT control |
| coding | 10 | Sessions spawn, subagents |
| core-only | 10 | No specialty tools needed |
| multi-domain | 10 | Cross-category prompts |
| memory | 11 | Memory tool disambiguation |
| workspace | 5 | File read/write/exec |
| adversarial | 10 | Prompt injection attempts |

**Total: 145 cases**

Ground truth labels (expected tool sets) were assigned by a single annotator (the resolver author). See [Known Limitations](#8-known-limitations) for implications.

---

## 3. Scoring

### Primary metric: must-include recall

A case passes if every tool in `expected_tools` appears in the classifier's `selected_tools` output. The overall **must-include recall** is the fraction of cases that pass.

This is the right primary metric for a pre-filter: missing a required tool is a hard failure (the agent can't complete the task). Including an extra tool is wasteful but not catastrophic — the primary model simply has access to a tool it won't use.

> **Deprecation note:** Previous versions (v3.2) reported this metric as `must_include_accuracy` or `accuracy`. As of v2, the label is `must_include_recall` to clarify what is actually being measured. The computation is identical.

### Secondary metrics

- **Exact-match rate** — fraction of cases where `selected_tools == expected_tools` exactly (no extras, no misses). Useful for precision monitoring.
- **F1** — harmonic mean of per-case recall and precision. Summarizes the trade-off.
- **Precision** — proportion of selected tools that were in `expected_tools`. Lower precision = more unnecessary tools included.

### Latency

Two latency types are tracked and reported separately:

- **Per-call latency** — wall-clock time for a single LLM API call (relevant for synchronous deployments)
- **Wall-clock latency** — same in this harness since `n=1` for deterministic config. For `n>1` (voted config), wall-clock reflects the time to receive all `n` votes (parallel where the API supports it)

In production, the classifier runs in parallel with session setup, so user-facing impact is typically less than the raw p50 number.

---

## 4. Harness

### Uniform JSON extraction

All providers use the same extraction path: parse a JSON object from the model's text output. We do **not** use OpenAI's `response_format: json_object` or structured outputs mode — these are not universally available and would introduce provider-specific paths that could advantage OpenAI models.

The classifier prompt instructs the model to return a JSON object with a `tools` array. The harness extracts the first valid JSON object from the response text. Malformed responses are logged as errors.

### Configurations

Two configurations were benchmarked:

| Config | Temperature | Votes (n) | Label |
|--------|-------------|-----------|-------|
| `det` | 0.0 | 1 | Deterministic (production-matched) |
| `voted` | 0.3 | 5 | Ensemble reference |

For the voted config, the harness collects 5 independent completions and takes the union of tools that appear in ≥3/5 responses (majority vote). This reduces variance but adds latency and cost.

**We ship the deterministic config.** The voted config is reported as a reference to show the ceiling achievable with ensemble methods, not as a production recommendation.

---

## 5. Statistics

### Confidence intervals on rates

95% Wilson score intervals are used for must-include recall and exact-match rate. Wilson intervals are preferred over normal approximation (Wald) because they have better coverage at extreme rates (near 0% or 100%) — which is relevant here since some models approach 99%+ recall.

Formula: `(p̂ + z²/2n ± z√(p̂(1-p̂)/n + z²/4n²)) / (1 + z²/n)` where `z=1.96`, `n=145`.

### Bootstrap CIs on latency

Per-call latency confidence intervals use bootstrap resampling (1,000 iterations) on the empirical latency distribution. Reported as 95% bootstrap CI around p50.

### What we do NOT report

We do not report pairwise significance tests (e.g., McNemar's test) between models. With n=145, several pairs have overlapping Wilson CIs, and pairwise tests would be underpowered for fine-grained comparisons. The recommended interpretation: **treat models with overlapping CIs as statistically indistinguishable on this dataset.**

---

## 6. Configurations — Why Report Both?

The **deterministic config** (T=0, n=1) is what ships in production. It's fast, cheap, and reproducible. Results are fully deterministic given the same model and prompt.

The **voted config** (T=0.3, n=5) shows the ensemble upper bound — how much headroom exists if you're willing to pay 5× the per-call cost and wait for 5 completions. For most models, the gain is marginal (1-2 percentage points), confirming that the task is not significantly variance-limited at T=0.

**Exception:** gpt-5.4-mini gains ~1.4pp recall in voted config (97.9% → 99.3%), closing the gap with Claude Sonnet. Whether this is worth 5× cost depends on your deployment.

---

## 7. Failure Analysis

### Categorization

Failures (cases where must_include_recall = 0) were manually categorized using a **semantic-overlap heuristic**: if every missing tool is semantically close to a tool the model did select (e.g., `subagents` vs `sessions_spawn`, `memory_get` vs `memory_search`), the failure is marked `plausible_classifier_correct`.

This heuristic identifies cases where the ground truth label may be arguable — the model's selection might be functionally equivalent. These cases are logged in the consolidated JSON but are **not** excluded from the primary metrics. Reported recall numbers are conservative.

### gpt-5.4-mini failures (deterministic config, n=3)

All 3 failures involve fine-grained tool disambiguation:
- **Case 12** (financial): `code_execution` missing from a transaction analysis task — classifier correctly selected the financial tools but missed that estimation requires computation
- **Case 67** (ops): `subagents` expected; classifier selected `sessions_spawn`. Marked `plausible_classifier_correct` — semantic overlap is real.
- **Case 131** (memory): `memory_get` expected alongside `memory_list`; classifier selected `memory_search` instead. Partial recall (0.5).

### gemini-3-flash (det config: 83 errors)

83 of 145 cases returned malformed JSON that the harness could not parse. The model was frequently returning tool lists in non-JSON formats (natural language, code blocks without proper JSON structure). This is a **task-fit failure**, not a capability failure — gemini-3-flash is a capable model on other tasks. The resolver's prompt format does not suit its output style without additional prompt engineering.

---

## 8. Known Limitations

These limitations are documented here because honest framing matters. If you are making deployment decisions based on this benchmark, these are the caveats you should weight:

| Limitation | Implication |
|------------|-------------|
| **n=145 is small** | Wide CIs for categories with <15 cases; fine-grained pairwise comparisons are underpowered |
| **Single-annotator ground truth** | No inter-rater agreement measurement; label quality is unknown |
| **Test data co-evolved with classifier prompt** | The prompt was iteratively refined using feedback from failures on this test set — some leakage is likely. Reported recall overstates out-of-distribution performance. |
| **No OOD coverage** | Multilingual prompts, typos, code-switching, adversarial injection (beyond the 10 labeled cases) not tested |
| **No pairwise significance tests** | Models with overlapping CIs cannot be statistically distinguished; use CIs, not point estimates |
| **No Docker/seed reproducibility artifact** | Benchmark results are not reproducible to the bit without pinning API versions and using non-zero temperatures (det config is reproducible at T=0; voted is not) |
| **No human baseline** | We don't know how a human annotator would score on the same cases; no ceiling reference |
| **Not provider-normalized at native structured-output level** | Using uniform JSON extraction may disadvantage models that excel with their native structured-output mode |

---

## 9. Roadmap

Items below are under consideration. None are committed. Filed issues will be linked if/when opened.

| Item | Status | Notes |
|------|--------|-------|
| Expand to n≥500 cases | Planned | Current n=145 is too small for fine-grained pairwise comparison |
| Second annotator + IRR measurement | Planned | Cohen's κ on a 50-case sample would bound label quality |
| Docker reproducibility artifact | Planned | Pin API client versions, provide seed fixture for T=0 |
| OOD test split | Planned | Multilingual, typo, adversarial injection beyond current 10 |
| McNemar's / bootstrap pairwise tests | Planned | Requires larger n first |
| Human baseline | Exploratory | Recruit 2–3 annotators for 30-case human eval |
| Native structured-output per-provider | Exploratory | Separate harness paths per provider to normalize |
| Automated CI regression | Exploratory | Monthly re-run on gpt-5.4-mini to catch prompt/model drift |

**Contributions welcome** — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to add test cases, improve the harness, or run the benchmark against your own tool surface.

---

## Appendix: v2 vs v3.2 Comparison

The v2 benchmark (April 2026) differs from the v3.2 benchmark (April 2026, earlier) in the following ways:

| Aspect | v3.2 | v2 |
|--------|------|-----|
| Metric label | `accuracy` / `must_include_accuracy` | `must_include_recall` |
| Confidence intervals | Not reported | 95% Wilson CIs on rates |
| Configurations | Single (3 runs averaged) | Deterministic + voted, reported separately |
| Latency reporting | Per-call only | Per-call + wall-clock, with bootstrap CIs |
| Failure analysis | Not published | Semantic-overlap heuristic, logged in JSON |
| Error tracking | Not tracked | Per-model error count |

The underlying dataset (145 cases, 14 categories) is the same.
