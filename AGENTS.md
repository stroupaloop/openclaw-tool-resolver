# AGENTS.md — openclaw-resolver

## For Coding Agents

This is a single-file JavaScript plugin for OpenClaw. The architecture is intentionally simple.

### Before writing code:
1. Read `CLAUDE.md` — stack, structure, conventions
2. Read `README.md` — how the resolver works, benchmark results
3. Read `CONTRIBUTING.md` — contribution guidelines

### Key constraints:
- **All plugin logic lives in `index.js`** — this is a design decision, not laziness
- **`openclaw.plugin.json` is the plugin manifest** — defines hooks, config schema, metadata
- **`default-catalog.json` is the tool catalog** — descriptions used by the classifier
- **Schemas are contracts** — `schemas/catalog.v1.json` and `schemas/proposal.v1.json` define the wire format between the classifier LLM and the resolver

### Testing changes:
1. Run `benchmark/replay-harness.py` before shipping any logic changes
2. If modifying the classifier prompt (in `index.js`), run the full `model-benchmark.py`
3. Primary metric: **must-include recall** — all required tools must appear in output

### Do NOT:
- Split `index.js` into multiple files without explicit approval
- Modify schemas without updating both the schema file and the code that validates against it
- Ship classifier prompt changes without benchmark verification
- Modify `benchmark/benchmark-v3.2-curated.json` (ground truth) without documenting why

### Publishing:
See `NPM-PUBLISH.md` for the npm publish workflow. Version bumps follow semver.
