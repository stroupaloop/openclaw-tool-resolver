# Contributing to openclaw-tool-resolver

Thank you for considering contributing! This plugin optimizes OpenClaw agent performance by dynamically narrowing the tool surface, and contributions that improve accuracy, reduce latency, or expand benchmark coverage are welcome.

## Getting Started

1. Fork the repo
2. Clone and install OpenClaw with the plugin in `~/.openclaw/extensions/`
3. Run the benchmark suite to establish a baseline

## Development Setup

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/openclaw-tool-resolver.git

# Link into OpenClaw extensions
ln -s $(pwd)/openclaw-tool-resolver ~/.openclaw/extensions/openclaw-tool-resolver

# Run benchmarks
cd openclaw-tool-resolver/benchmark
python3 replay-harness.py --file benchmark-v3-curated.json --verbose
```

## Running Benchmarks

The benchmark suite validates tool classification accuracy against 116 curated test cases:

```bash
# Single model (default: gpt-5.4-mini)
python3 benchmark/replay-harness.py --file benchmark/benchmark-v3-curated.json

# Multi-model comparison
python3 benchmark/model-benchmark.py

# Generate new test cases from telemetry
python3 benchmark/generate-cases.py
```

## Pull Requests

1. Create a feature branch (`git checkout -b feature/your-feature`)
2. Make changes
3. Run the full benchmark suite — accuracy must not regress
4. Commit with a descriptive message
5. Push and open a PR

### Quality Bar

- **Accuracy**: Must maintain ≥99% must-include recall on the benchmark suite
- **Latency**: Classification should complete in <2s p50
- **No regressions**: Run `replay-harness.py` before submitting

## Reporting Issues

- Include the telemetry entry (if available) showing the misclassification
- Describe expected vs actual tool selection
- Include the prompt (or a sanitized version) that triggered the issue

## Code Style

- ES modules (`import`/`export`)
- No external dependencies (Node.js built-ins only)
- Keep the plugin self-contained — single `index.js`
