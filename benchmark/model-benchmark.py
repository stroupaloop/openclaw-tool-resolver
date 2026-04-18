#!/usr/bin/env python3
"""
Resolver v3 model benchmark runner.

Runs the curated tool-classification corpus against one or more candidate LLMs,
using best-of-N voting, then writes a comparable history artifact.

Usage:
  python3 model-benchmark.py --models gpt-5.4-mini sonnet --votes 3
  python3 model-benchmark.py --models gpt-5.4-mini gpt-5.4 gemini-2.5-pro --votes 3 --output ../metrics/model-benchmark-history.json
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPLAY_HARNESS = SCRIPT_DIR / "replay-harness.py"
DEFAULT_OUTPUT = SCRIPT_DIR.parent / "metrics" / "model-benchmark-history.json"
TMP_DIR = SCRIPT_DIR.parent / "metrics"
TMP_DIR.mkdir(exist_ok=True)


def run_model(model: str, votes: int) -> dict:
    safe = model.replace("/", "_")
    tmp_output = TMP_DIR / f"tmp-benchmark-{safe}.json"
    env = os.environ.copy()
    env["LLM_MODEL"] = model

    cmd = [
        sys.executable,
        str(REPLAY_HARNESS),
        "--votes",
        str(votes),
        "--output",
        str(tmp_output),
    ]

    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        return {
            "model": model,
            "ok": False,
            "error": proc.stderr or proc.stdout or f"exit {proc.returncode}",
        }

    with open(tmp_output) as f:
        metrics = json.load(f)

    usage = metrics.get("usage", {})
    total_cases = metrics.get("total_cases", 0)
    input_tokens = usage.get("input_tokens", 0)
    output_tokens = usage.get("output_tokens", 0)
    total_cost = usage.get("cost_usd", 0)

    return {
        "model": model,
        "ok": True,
        "votes": votes,
        "must_include_accuracy": metrics.get("must_include_accuracy", 0),
        "avg_recall": metrics.get("avg_recall", 0),
        "avg_precision": metrics.get("avg_precision", 0),
        "latency_p50": metrics.get("latency_p50", 0),
        "latency_p95": metrics.get("latency_p95", 0),
        "latency_mean": metrics.get("latency_mean", 0),
        "errors": metrics.get("errors", 0),
        "failures": len(metrics.get("failures", [])),
        "total_cases": total_cases,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": total_cost,
        "cost_per_1k_classifications": round((total_cost / total_cases * 1000), 4) if total_cases and total_cost else None,
        "disagreement_rate_vs_perfect": round(len(metrics.get("failures", [])) / total_cases, 4) if total_cases else None,
        "categories": metrics.get("categories", {}),
        "timestamp": metrics.get("timestamp"),
    }


def load_history(path: Path) -> dict:
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {
        "version": 1,
        "updated_at": None,
        "runs": []
    }


def main():
    parser = argparse.ArgumentParser(description="Resolver model benchmark runner")
    parser.add_argument("--models", nargs="+", required=True, help="Candidate models to evaluate")
    parser.add_argument("--votes", type=int, default=3, help="Best-of-N voting for benchmark stability")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="History JSON output path")
    args = parser.parse_args()

    results = []
    for model in args.models:
        print(f"Running benchmark for {model}...", flush=True)
        results.append(run_model(model, args.votes))

    successful = [r for r in results if r.get("ok")]
    successful.sort(key=lambda r: (-r["must_include_accuracy"], -r["avg_recall"], r["latency_mean"] or 10**9, r["cost_per_1k_classifications"] or 10**9))

    best_model = successful[0]["model"] if successful else None
    snapshot = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "votes": args.votes,
        "models": results,
        "winner": best_model,
    }

    output_path = Path(args.output)
    history = load_history(output_path)
    history["updated_at"] = snapshot["timestamp"]
    history["runs"].append(snapshot)

    with open(output_path, "w") as f:
        json.dump(history, f, indent=2)

    print("\nMODEL BENCHMARK SUMMARY")
    print("=" * 72)
    for r in successful:
        print(
            f"{r['model']}: acc={r['must_include_accuracy']*100:.1f}% recall={r['avg_recall']*100:.1f}% "
            f"p50={r['latency_p50']}ms p95={r['latency_p95']}ms cost/1k={r['cost_per_1k_classifications']}"
        )
    failed = [r for r in results if not r.get("ok")]
    for r in failed:
        print(f"{r['model']}: FAILED {r['error']}")
    print(f"\nWinner: {best_model}")
    print(f"History written to: {output_path}")


if __name__ == "__main__":
    main()
