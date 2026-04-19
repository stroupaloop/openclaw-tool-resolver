# Proposal: Unified Tool + Skill Resolver

## Status: DRAFT — For Andrew's Review

## Problem

Every OpenClaw turn injects **two categories** of context into the system prompt regardless of relevance:

| Category | Count (Ender) | Est. Tokens | Injected When |
|----------|-------------:|------------:|---------------|
| Tool definitions | 42 | ~6,300 | Every turn |
| Skill descriptions | 19 | ~1,200 | Every turn |
| **Total addressable** | **61** | **~7,500** | |

The tool resolver already narrows tools (42 → ~18 avg, saving ~4,048 tokens/turn measured). Skills are untouched.

## Current Architecture

### Tools (resolved today)
```
User prompt → classifier LLM → toolsAllow → before_prompt_build hook → model sees fewer tools
```

### Skills (not resolved)
```
Skills loaded at attempt start → skillsPrompt built → injected into system prompt unconditionally
```

**Key finding in the code:** OpenClaw already has a `skillsAllow`-like mechanism. Line 809 of `attempt.ts`:

```typescript
const effectiveSkillsPrompt = params.toolsAllow?.length ? undefined : skillsPrompt;
```

When `params.toolsAllow` is set (the static config, not hook-derived), it **strips the entire skills catalog** and uses minimal prompt mode. This is the nuclear option — all or nothing. No per-skill filtering exists today.

## Proposal

### Option 1: Single Repo — Unified Resolver (Recommended)

Extend `openclaw-resolver` to classify both tools AND skills in a single LLM call.

**How it works:**
```
User prompt → classifier LLM classifies tools + skills in one call (~1s)
                    ↓
            { toolsAllow: [...], skillsAllow: [...] }
                    ↓
            before_prompt_build hook returns both
                    ↓
            OpenClaw narrows tools AND skills
```

**Pros:**
- Single classifier call (no additional latency or cost)
- Single config, single telemetry stream, single benchmark
- Tools and skills are both "capabilities" — classifying them together gives the LLM better signal
- The classifier prompt already lists all available capabilities; adding skill names + descriptions is trivial

**Cons:**
- Requires OpenClaw core change: `before_prompt_build` must accept `skillsAllow` return and filter `skillsPrompt` accordingly
- Slightly larger classifier prompt (19 more items)
- New PR needed for OpenClaw core (or extend #68734)

**OpenClaw core change needed:**
```typescript
// In attempt.ts, after hook fires:
if (hookResult?.skillsAllow?.length > 0) {
  // Rebuild skillsPrompt with only allowed skills
  effectiveSkillsPrompt = resolveSkillsPromptForRun({
    ...params,
    entries: skillEntries.filter(e => hookResult.skillsAllow.includes(e.name)),
  });
}
```

### Option 2: Separate Repos

- `openclaw-resolver` — tools + skills (v3.1+)
- `openclaw-skill-resolver` — skills only (new)

**Pros:**
- No changes to existing plugin
- Each can iterate independently

**Cons:**
- Two classifier LLM calls per turn (2x latency, 2x cost)
- Two configs, two telemetry streams, two benchmarks
- They're solving the same problem on the same input (user prompt → which capabilities are needed)
- Skill classification alone saves ~1,200 tokens — not enough to justify a separate LLM call at $0.0002/call

### Recommendation: Option 1 — Single Repo

The classification task is identical: "given this prompt, which capabilities are relevant?" Tools and skills are both capabilities. One call, one plugin, one benchmark.

Repo was renamed to `openclaw-resolver` (2026-04-19) to reflect the broader scope — tools, skills, and any future resolved resources. The internal OpenClaw plugin ID remains `openclaw-tool-resolver` for backward-compat with existing installs.

## Token Budget Impact

| Scenario | Tokens/Turn | Savings vs Baseline |
|----------|------------:|--------------------:|
| Baseline (no resolver) | ~76,000 | — |
| Tool resolver only (current) | ~72,000 | −4,048 (5.3%) |
| Tool + skill resolver | ~70,500 | −5,500 (7.2%) est. |

**Estimated additional savings from skill filtering:** ~1,200-1,500 tokens/turn. Not as large as tools because skill descriptions are shorter, but it's essentially free — same classifier call, same latency, marginal cost increase from a slightly longer classifier prompt.

## Implementation Plan

### Phase 1: Plugin changes (openclaw-resolver)
1. Add skill names + descriptions to classifier prompt
2. Classifier returns `{ toolsAllow: [...], skillsAllow: [...] }`
3. Hook returns both in `before_prompt_build` result
4. Extend benchmark to cover skill classification
5. Update `tool-descriptions.json` to include skill descriptions (or separate `skill-descriptions.json`)

### Phase 2: OpenClaw core changes (new PR or extend #68734)
1. `mergeBeforePromptBuild` passes through `skillsAllow`
2. `resolvePromptBuildHookResult` extracts `skillsAllow`
3. `attempt.ts` filters `skillEntries` based on `hookResult.skillsAllow` and rebuilds `skillsPrompt`
4. Fallback: if no `skillsAllow` returned, inject all skills (current behavior)

### Phase 3: Validation
1. Re-run benchmark with skill classification added
2. Measure token savings via LiteLLM postgres
3. Verify no skill loading regressions (agent can still `read` SKILL.md when needed)

## Open Questions

1. ~~**Repo naming:** Keep `openclaw-tool-resolver` or rename to `openclaw-context-resolver`?~~ — Resolved: renamed to `openclaw-resolver` on 2026-04-19.
2. **Skill descriptions:** Ship defaults for built-in OpenClaw skills in the plugin? Or user-only config?
3. **SKILL.md loading:** When a skill is filtered out of the prompt but the agent encounters a relevant task mid-turn, it loses the "read SKILL.md" instruction. Mitigation: always include skill names in a minimal list even when full descriptions are filtered, so the agent knows the skill exists but doesn't get the full description.
4. **Extend #68734 or new PR?** Adding `skillsAllow` to #68734 keeps it cohesive but increases scope.
