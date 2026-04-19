# Changelog

All notable changes to `openclaw-resolver` (formerly `openclaw-tool-resolver`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-04-19

### Fixed

- **Parse error in v0.4.0 system-prompt template literal.** v0.4.0 introduced unescaped inner backticks (e.g. `` `message` ``) inside the outer template literal that builds the classifier system prompt. JavaScript parsed the first inner backtick as closing the outer template, causing the plugin to fail loading with a `ParseError` at `index.js:144:114`. Fixed by escaping all 30 inner backticks in the template.

### Added

- Pre-commit syntax guard (`.husky/pre-commit`) running `node --check index.js` before every commit.
- GitHub Actions syntax-check workflow as backstop for pushes/PRs to `main`.

### Known opportunities for improvement (tracked, not resolved here)

- **Cache validation layer is over-broad on conversational prompts** — when the LLM correctly returns an empty selection on status/meta turns ("why did you do X?", system event notifications), the keyword-cache merges ~10 tools based on surface matching. The LLM’s conservative judgment gets overridden unnecessarily. Telemetry shows 53% of classifications hit this path post-v0.4.1. Tracked in [#17](https://github.com/stroupaloop/openclaw-resolver/issues/17).
- **Description-tuning returns diminishing** — v0.4.0 description edits were net-neutral against the 145-case benchmark (±5pp CI noise). Remaining classifier failures are at the model’s capability ceiling, not description ambiguity. Future gains likely require few-shot examples or post-hoc validation, not more description edits. Tracked in [#13 (weekly tuning cron)](https://github.com/stroupaloop/openclaw-resolver/issues/13).
- **Benchmark n=145 is underpowered for fine-grained pairwise claims.** Pairwise differences inside ~5pp are within confidence-interval overlap. Roadmap in [BENCHMARK-METHODOLOGY.md](BENCHMARK-METHODOLOGY.md).

## [0.4.0] — 2026-04-19 — ⚠️ BROKEN (use 0.4.1)

### Tool/skill description tuning pass

**Net: statistically neutral** on 145-case benchmark (inside ±5pp 95% Wilson CI noise).

- ✅ Fixed: `memory_get` for "check if stored" prompts; `web_fetch` for non-URL-explicit source pulls (status pages, postmortems)
- ❌ Regressed: finance-tool selection on research-comparison prompts (`web_fetch` broadening cannibalized `finance__get_transactions`)
- 🚧 Learning: description tuning hits diminishing returns quickly. Remaining classifier failures (missed `message` on multi-step prompts, missed `subagents` on coordination prompts) are **classifier capability ceiling**, not description ambiguity. Future gains require few-shot examples in the system prompt or post-hoc validation via the keyword cache. Continuous adaptation is tracked in [#13 (weekly tuning cron)](https://github.com/stroupaloop/openclaw-resolver/issues/13).

### Changed

- Expanded tool descriptions with explicit verb triggers:
  - `message` — added "notify, tell, let X know, draft message, text, confirm with, apology, thank-you"
  - `nodes` — added concrete IoT examples (speakers, lights, blinds, routers) + physical-device verbs
  - `cron` — added "every, recurring, remind me, daily, weekly" triggers
  - `sessions_spawn` — added "spin up, launch, delegate, parallel"
  - `memory_get` / `memory_list` / `memory_update` / `memory_search` — explicit disambiguation by verb semantics
  - `finance__*` — expanded trigger phrases ("cash position", "overdraft", "duplicates", "uncategorized")
  - `web_fetch` — broadened beyond URL-centric to include docs/articles/status pages
- Added explicit classifier rules (Rules 3–6) forcing verb-to-tool tracing on multi-step prompts

## [0.3.3] — 2026-04-19

### Added

- `BENCHMARK-METHODOLOGY.md` — full methodology, known limitations, roadmap
- README: new "Benchmark Methodology & Roadmap" section with honest framing

### Changed

- `PRODUCTION-METRICS.md`: replaced synthetic single-run benchmark numbers with v2 results (145 cases × 6 models × 2 configs, 95% Wilson CIs)
- Renamed `must_include_accuracy` → `must_include_recall` (computation identical; label honest)
- Reframed LiteLLM as tested reference implementation, not requirement (opens path for Helicone/Portkey/LangSmith/custom proxies)

## [0.3.2] — 2026-04-19

### Changed

- Repo renamed: `openclaw-tool-resolver` → `openclaw-resolver`
- `package.json` `name` + URLs updated
- README title + npm install references updated
- Internal plugin ID unchanged (`openclaw-tool-resolver`) for backward-compat with existing OpenClaw configs

## [0.3.1] — 2026-04-19

### Added

- LiteLLM `metadata.tags` field on classifier request bodies for native cost attribution (closes [#6](https://github.com/stroupaloop/openclaw-resolver/issues/6))
  - Default tags: `["openclaw-resolver", "resolver:classify"]`
  - Optional `telemetry.tags` plugin config to append additional tags per install
  - `metadata.caller`, `session_id`, `agent_id` also carried in the metadata block

## [0.3.0] — 2026-04-19

### Added

- `sessionId` / `agentId` fields in telemetry JSONL rows (null-safe when hook context doesn't expose them)
- `user: "openclaw-resolver"` parameter on classifier request body
- `x-openclaw-caller: tool-resolver` HTTP header on classifier fetch
- Closes [#4 requests 1–2](https://github.com/stroupaloop/openclaw-resolver/issues/4)

## [0.2.0] — 2026-04-18

### Added

- Expanded benchmark to 145 cases across 14 categories
- 6-model comparison (gpt-5.4-mini, gpt-5.4, claude-sonnet-4-6, claude-haiku-4-5, grok-4.1-fast, gemini-3-flash)
- GitHub Actions CI workflow
- Issue + PR templates
- Code of Conduct
- NPM publish guide

## [0.1.0] — 2026-04-17

### Initial release

- v3.1 resolver: LLM always classifies, keyword cache is validation-only
- JSONL telemetry logging with 5MB rotation
- 67% average tool surface reduction in production
- ~4,048 tokens saved per turn (LiteLLM ground truth, heavy sessions)

[0.4.0]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.4.0
[0.3.3]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.3.3
[0.3.2]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.3.2
[0.3.1]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.3.1
[0.3.0]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.3.0
[0.2.0]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.2.0
[0.1.0]: https://github.com/stroupaloop/openclaw-resolver/releases/tag/v0.1.0
