#!/usr/bin/env python3
"""
Monthly Resolver Benchmark — Combined dataset curation + model comparison.

Runs on 1st of each month via cron. Steps:
1. Analyze telemetry for coverage gaps (profiles, keyword patterns, tool combos)
2. Flag dataset staleness / suggest new test cases
3. Run all candidate models against current benchmark
4. Compare vs incumbent, post leaderboard
5. Append to history for longitudinal tracking

Usage:
  python3 monthly-benchmark.py                           # Full run (curate + benchmark)
  python3 monthly-benchmark.py --benchmark-only          # Skip curation, just run models
  python3 monthly-benchmark.py --curate-only             # Skip benchmark, just analyze dataset
  python3 monthly-benchmark.py --models gpt-5.4-mini     # Override model list
"""

import argparse
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
WORKSPACE = SCRIPT_DIR.parent
BENCHMARK_FILE = SCRIPT_DIR / "benchmark-v3-curated.json"
TELEMETRY_FILE = WORKSPACE.parent / "resolver-telemetry.jsonl"
METRICS_DIR = WORKSPACE / "metrics"
HISTORY_FILE = METRICS_DIR / "model-benchmark-history.json"
CURATION_LOG = METRICS_DIR / "dataset-curation-log.json"
REPLAY_HARNESS = SCRIPT_DIR / "replay-harness.py"
METRICS_DIR.mkdir(exist_ok=True)

# Models to benchmark — the current candidate set
DEFAULT_MODELS = [
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "claude-haiku-4-5",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "grok-4.1-fast",
]

INCUMBENT_MODEL = "gpt-5.4-mini"


def load_telemetry(since_days=30):
    """Load telemetry entries from the last N days."""
    entries = []
    if not TELEMETRY_FILE.exists():
        return entries
    cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    with open(TELEMETRY_FILE) as f:
        for line in f:
            try:
                d = json.loads(line.strip())
                ts = d.get("ts", "")
                if ts:
                    entry_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    if entry_dt >= cutoff:
                        entries.append(d)
            except (json.JSONDecodeError, ValueError):
                continue
    return entries


def load_benchmark():
    """Load current benchmark cases."""
    with open(BENCHMARK_FILE) as f:
        return json.load(f)


def analyze_coverage(telemetry, benchmark):
    """Compare telemetry profile distribution vs benchmark category distribution."""
    # Telemetry profile distribution (what real traffic looks like)
    telem_profiles = Counter()
    telem_keywords = Counter()
    telem_tool_combos = Counter()
    unknown_count = 0
    low_confidence = []

    for entry in telemetry:
        profile = entry.get("profile") or "unknown"
        telem_profiles[profile] += 1
        if profile == "unknown":
            unknown_count += 1
        confidence = entry.get("confidence", 1.0)
        if confidence < 0.5:
            low_confidence.append(entry)
        for kw in entry.get("matchedKeywords", []):
            telem_keywords[kw] += 1
        tools = tuple(sorted(entry.get("toolsAllow") or []))
        telem_tool_combos[tools] += 1

    # Benchmark category distribution (what we test)
    bench_categories = Counter()
    bench_tools = set()
    for case in benchmark.get("cases", []):
        bench_categories[case.get("category", "unknown")] += 1
        for tool in case.get("expected_tools", []):
            bench_tools.add(tool)

    # Coverage gaps: profiles in production not well-represented in benchmark
    # Map profiles → benchmark categories (approximate mapping)
    profile_to_category = {
        "messaging": "messaging",
        "coding": "coding",
        "ops": "ops",
        "research": "research",
        "financial": "financial",
        "creative": "creative",
        "devices": "devices",
        "scheduling": "scheduling",
        "browser": "browser",
    }

    gaps = []
    for profile, count in telem_profiles.most_common():
        if profile in ("unknown", None):
            continue
        category = profile_to_category.get(profile)
        if category:
            bench_count = bench_categories.get(category, 0)
            traffic_pct = count / len(telemetry) * 100
            bench_pct = bench_count / benchmark.get("total_cases", 1) * 100
            # Flag if traffic share is 2x+ the benchmark share
            if traffic_pct > bench_pct * 2 and count >= 5:
                gaps.append({
                    "profile": profile,
                    "category": category,
                    "traffic_pct": round(traffic_pct, 1),
                    "benchmark_pct": round(bench_pct, 1),
                    "traffic_count": count,
                    "benchmark_count": bench_count,
                    "recommendation": f"Add {max(2, int(count / len(telemetry) * benchmark.get('total_cases', 100)) - bench_count)} more {category} cases"
                })

    return {
        "telemetry_entries": len(telemetry),
        "telemetry_period_days": 30,
        "profile_distribution": dict(telem_profiles.most_common()),
        "unknown_rate": round(unknown_count / max(len(telemetry), 1) * 100, 1),
        "low_confidence_count": len(low_confidence),
        "top_keywords": dict(telem_keywords.most_common(20)),
        "benchmark_categories": dict(bench_categories),
        "benchmark_total_cases": benchmark.get("total_cases", 0),
        "benchmark_version": benchmark.get("version", "unknown"),
        "coverage_gaps": gaps,
        "unique_tool_combos_in_production": len(telem_tool_combos),
    }


def run_model_benchmark(model, votes=3):
    """Run a single model through the replay harness."""
    safe = model.replace("/", "_")
    tmp_output = METRICS_DIR / f"tmp-benchmark-{safe}.json"
    env = os.environ.copy()
    env["LLM_MODEL"] = model

    cmd = [
        sys.executable,
        str(REPLAY_HARNESS),
        "--votes", str(votes),
        "--output", str(tmp_output),
    ]

    print(f"  Running {model}...", flush=True)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=1800)

    if proc.returncode != 0:
        return {"model": model, "ok": False, "error": (proc.stderr or proc.stdout or f"exit {proc.returncode}")[:500]}

    try:
        with open(tmp_output) as f:
            metrics = json.load(f)
    except Exception as e:
        return {"model": model, "ok": False, "error": str(e)}

    usage = metrics.get("usage", {})
    total_cases = metrics.get("total_cases", 0)

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
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cost_usd": usage.get("cost_usd", 0),
        "cost_per_1k": round((usage.get("cost_usd", 0) / total_cases * 1000), 4) if total_cases and usage.get("cost_usd") else None,
    }


def format_leaderboard(results, incumbent=INCUMBENT_MODEL):
    """Format results as a text leaderboard."""
    ok = [r for r in results if r.get("ok")]
    failed = [r for r in results if not r.get("ok")]

    ok.sort(key=lambda r: (-r["must_include_accuracy"], -r["avg_recall"], r.get("latency_mean", 10**9)))

    lines = []
    lines.append("🏆 RESOLVER MODEL BENCHMARK")
    lines.append(f"Date: {datetime.now().strftime('%Y-%m-%d')}")
    lines.append(f"Cases: {ok[0]['total_cases'] if ok else '?'} | Votes: {ok[0]['votes'] if ok else '?'}")
    lines.append("")
    lines.append(f"{'#':<3} {'Model':<25} {'Acc':>7} {'Recall':>8} {'Prec':>7} {'p50':>7} {'p95':>7} {'Errs':>5}")
    lines.append("-" * 75)

    for i, r in enumerate(ok, 1):
        flag = " 👑" if r["model"] == incumbent else ""
        challenger = ""
        if r["model"] != incumbent and i == 1:
            inc_result = next((x for x in ok if x["model"] == incumbent), None)
            if inc_result and r["must_include_accuracy"] > inc_result["must_include_accuracy"]:
                challenger = " ⚠️ BEATS INCUMBENT"
        lines.append(
            f"{i:<3} {r['model']:<25} {r['must_include_accuracy']*100:>6.1f}% "
            f"{r['avg_recall']*100:>6.1f}% {r['avg_precision']*100:>6.1f}% "
            f"{r['latency_p50']:>6}ms {r['latency_p95']:>6}ms {r['errors']:>5}"
            f"{flag}{challenger}"
        )

    if failed:
        lines.append("")
        lines.append("❌ Failed:")
        for r in failed:
            lines.append(f"   {r['model']}: {r['error'][:100]}")

    return "\n".join(lines)


def format_curation_report(analysis):
    """Format dataset curation analysis."""
    lines = []
    lines.append("📊 DATASET HEALTH REPORT")
    lines.append(f"Telemetry: {analysis['telemetry_entries']} entries (last {analysis['telemetry_period_days']} days)")
    lines.append(f"Benchmark: {analysis['benchmark_total_cases']} cases (v{analysis['benchmark_version']})")
    lines.append(f"Unknown classifier rate: {analysis['unknown_rate']}%")
    lines.append(f"Low confidence events: {analysis['low_confidence_count']}")
    lines.append("")

    lines.append("Traffic vs Benchmark distribution:")
    all_profiles = set(analysis["profile_distribution"].keys()) | set(analysis["benchmark_categories"].keys())
    for p in sorted(all_profiles):
        t_count = analysis["profile_distribution"].get(p, 0)
        b_count = analysis["benchmark_categories"].get(p, 0)
        t_pct = t_count / max(analysis["telemetry_entries"], 1) * 100
        lines.append(f"  {p:<15} traffic={t_count:>4} ({t_pct:>5.1f}%)  benchmark={b_count:>3}")

    if analysis["coverage_gaps"]:
        lines.append("")
        lines.append("⚠️ Coverage gaps detected:")
        for gap in analysis["coverage_gaps"]:
            lines.append(f"  {gap['category']}: {gap['traffic_pct']}% of traffic but {gap['benchmark_pct']}% of tests → {gap['recommendation']}")
    else:
        lines.append("")
        lines.append("✅ No significant coverage gaps detected")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Monthly resolver benchmark + dataset curation")
    parser.add_argument("--benchmark-only", action="store_true", help="Skip dataset curation")
    parser.add_argument("--curate-only", action="store_true", help="Skip model benchmark")
    parser.add_argument("--models", nargs="+", default=DEFAULT_MODELS, help="Models to benchmark")
    parser.add_argument("--votes", type=int, default=3, help="Best-of-N voting")
    parser.add_argument("--telemetry-days", type=int, default=30, help="Days of telemetry to analyze")
    args = parser.parse_args()

    report_sections = []
    run_meta = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "args": vars(args),
    }

    # --- Step 1: Dataset curation ---
    if not args.benchmark_only:
        print("=== DATASET CURATION ===", flush=True)
        telemetry = load_telemetry(since_days=args.telemetry_days)
        benchmark = load_benchmark()
        analysis = analyze_coverage(telemetry, benchmark)

        curation_report = format_curation_report(analysis)
        print(curation_report)
        report_sections.append(curation_report)
        run_meta["curation"] = analysis

        # Save curation log
        curation_history = []
        if CURATION_LOG.exists():
            try:
                curation_history = json.load(open(CURATION_LOG))
            except json.JSONDecodeError:
                pass
        curation_history.append({"timestamp": run_meta["timestamp"], **analysis})
        with open(CURATION_LOG, "w") as f:
            json.dump(curation_history, f, indent=2)
        print(f"\nCuration log: {CURATION_LOG}")

    # --- Step 2: Model benchmark ---
    if not args.curate_only:
        print("\n=== MODEL BENCHMARK ===", flush=True)
        results = []
        for model in args.models:
            result = run_model_benchmark(model, args.votes)
            results.append(result)
            if result.get("ok"):
                print(f"  ✅ {model}: acc={result['must_include_accuracy']*100:.1f}%", flush=True)
            else:
                print(f"  ❌ {model}: {result['error'][:80]}", flush=True)

        leaderboard = format_leaderboard(results)
        print(f"\n{leaderboard}")
        report_sections.append(leaderboard)

        # Check for incumbent upset
        ok_results = [r for r in results if r.get("ok")]
        ok_results.sort(key=lambda r: (-r["must_include_accuracy"], -r["avg_recall"]))
        if ok_results:
            winner = ok_results[0]
            incumbent_result = next((r for r in ok_results if r["model"] == INCUMBENT_MODEL), None)
            upset = False
            if winner["model"] != INCUMBENT_MODEL and incumbent_result:
                if winner["must_include_accuracy"] > incumbent_result["must_include_accuracy"]:
                    upset = True
                elif (winner["must_include_accuracy"] == incumbent_result["must_include_accuracy"]
                      and winner["avg_recall"] > incumbent_result["avg_recall"]):
                    upset = True

            run_meta["benchmark"] = {
                "winner": winner["model"],
                "incumbent": INCUMBENT_MODEL,
                "upset": upset,
                "results": results,
            }

            if upset:
                report_sections.append(
                    f"\n🚨 INCUMBENT UPSET: {winner['model']} beats {INCUMBENT_MODEL}!\n"
                    f"   Accuracy: {winner['must_include_accuracy']*100:.1f}% vs {incumbent_result['must_include_accuracy']*100:.1f}%\n"
                    f"   Recall: {winner['avg_recall']*100:.1f}% vs {incumbent_result['avg_recall']*100:.1f}%\n"
                    f"   → Review recommended before switching production model"
                )

        # Append to history
        history = {"version": 1, "updated_at": None, "runs": []}
        if HISTORY_FILE.exists():
            try:
                history = json.load(open(HISTORY_FILE))
            except json.JSONDecodeError:
                pass
        history["updated_at"] = run_meta["timestamp"]
        history["runs"].append({
            "timestamp": run_meta["timestamp"],
            "votes": args.votes,
            "models": results,
            "winner": ok_results[0]["model"] if ok_results else None,
        })
        with open(HISTORY_FILE, "w") as f:
            json.dump(history, f, indent=2)
        print(f"\nHistory: {HISTORY_FILE}")

    # --- Final report ---
    full_report = "\n\n".join(report_sections)
    report_file = METRICS_DIR / f"monthly-benchmark-{datetime.now().strftime('%Y-%m')}.txt"
    with open(report_file, "w") as f:
        f.write(full_report)
    print(f"\nFull report: {report_file}")

    # Print summary for cron delivery
    print("\n=== SUMMARY FOR DELIVERY ===")
    print(full_report)


if __name__ == "__main__":
    main()
