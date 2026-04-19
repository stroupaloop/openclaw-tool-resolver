# Contributing to openclaw-resolver

Contributions that improve accuracy, reduce latency, expand benchmark coverage, or improve tool descriptions are welcome.

## Getting Started

1. Fork the repo
2. Clone and install OpenClaw with the plugin in `~/.openclaw/extensions/`
3. Run the benchmark suite to establish a baseline

## Development Setup

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/openclaw-resolver.git

# Link into OpenClaw extensions
ln -s $(pwd)/openclaw-resolver ~/.openclaw/extensions/openclaw-tool-resolver

# Run benchmarks
cd openclaw-resolver/benchmark
LLM_MODEL=gpt-5.4-mini python3 replay-harness.py --file benchmark-v3.2-curated.json --verbose
```

## Running Benchmarks

The benchmark suite validates tool classification accuracy against 145 curated test cases across 14 categories:

```bash
# Single model (default: gpt-5.4-mini)
cd benchmark
LLM_MODEL=gpt-5.4-mini python3 replay-harness.py --file benchmark-v3.2-curated.json

# Multi-model comparison
python3 model-benchmark.py

# Generate new test cases from telemetry
python3 generate-cases.py --input ~/resolver-telemetry.jsonl
```

## Pull Requests

1. Create a feature branch (`git checkout -b feature/your-feature`)
2. Make changes
3. Run the full benchmark suite — accuracy must not regress
4. Commit with a descriptive message
5. Push and open a PR

### Quality Bar

- **Accuracy**: Must maintain ≥99% must-include recall on the benchmark suite (gpt-5.4-mini baseline)
- **Latency**: Classification should complete in <2s p50
- **No regressions**: Run `replay-harness.py` before submitting
- **Zero external deps**: The plugin must remain a single `index.js` with Node.js built-ins only

## Reporting Issues

- Include the telemetry entry (if available) showing the misclassification
- Describe expected vs actual tool selection
- Include the prompt (or a sanitized version) that triggered the issue

## Adding Benchmark Cases

New cases should:
- Target a specific category (financial, research, messaging, coding, ops, creative, browser, scheduling, devices, memory, workspace, multi-domain, core-only, adversarial)
- Include realistic prompt text
- List only **non-core** tools in `expected_tools` (core tools are always loaded)
- Include a clear `category` field

```json
{
  "id": 146,
  "prompt": "Your realistic prompt here",
  "expected_tools": ["web_search", "web_fetch"],
  "category": "research"
}
```

## Code Style

- ES modules (`import`/`export`)
- No external dependencies (Node.js built-ins only)
- Keep the plugin self-contained — single `index.js`
