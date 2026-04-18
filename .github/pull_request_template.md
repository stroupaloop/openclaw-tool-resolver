## What

Brief description of the change.

## Why

Problem this solves or improvement it makes.

## Benchmark Results

<!-- Required: run the benchmark suite and paste results -->

```
Must-Include Accuracy: ___%
Avg Recall: ___%
Avg Precision: ___%
Latency p50: ___ms
```

**Compared to main branch baseline:**
- Accuracy: +/- ___%
- Latency: +/- ___ms

## Checklist

- [ ] Ran `replay-harness.py` against `benchmark-v3.2-curated.json` — no accuracy regression
- [ ] No external dependencies added
- [ ] Plugin remains single `index.js`
- [ ] Updated docs if behavior changed
