#!/usr/bin/env python3
"""
Resolver v3 Replay Harness
Sends benchmark prompts through the LLM classifier and scores accuracy.
Outputs: JSON metrics file + human-readable report.

Usage:
  python3 replay-harness.py                          # Run all 40 cases
  python3 replay-harness.py --category financial     # Run one category
  python3 replay-harness.py --ids 1,2,3              # Run specific cases
  python3 replay-harness.py --from-telemetry FILE    # Replay from telemetry log
"""

import json
import sys
import os
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

try:
    import httpx
except ImportError:
    print("Installing httpx...")
    os.system(f"{sys.executable} -m pip install httpx -q")
    import httpx

SCRIPT_DIR = Path(__file__).parent
BENCHMARK_FILE = SCRIPT_DIR / "benchmark-v3-curated.json"
METRICS_DIR = SCRIPT_DIR.parent / "metrics"
METRICS_DIR.mkdir(exist_ok=True)

# LLM config (same as plugin)
LLM_API_BASE = os.environ.get("LLM_API_BASE", "https://api.openai.com")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-5.4-mini")

# Core tools that are always included (same as plugin)
CORE_TOOLS = {"read", "write", "edit", "exec", "process", "memory_search", "memory_add", "session_status"}

# Full tool list (simulating what availableTools would contain)
ALL_TOOLS = [
    "read", "edit", "write", "exec", "process", "canvas", "nodes", "cron",
    "message", "tts", "image_generate", "video_generate", "gateway",
    "agents_list", "sessions_list", "sessions_history", "sessions_send",
    "subagents", "session_status", "image", "code_execution",
    "memory_add", "memory_delete", "memory_event_list", "memory_event_status",
    "memory_get", "memory_list", "memory_search", "memory_update",
    "monarch-money__get_accounts", "monarch-money__get_budgets",
    "monarch-money__get_cashflow", "monarch-money__get_transaction_categories",
    "monarch-money__get_transactions", "monarch-money__refresh_accounts",
    "pdf", "sessions_spawn", "sessions_yield", "tts", "web_search",
    "web_fetch", "browser", "x_search"
]

# Tool descriptions matching the plugin
TOOL_DESCRIPTIONS = {
    'web_search': 'Web search via Brave API',
    'web_fetch': 'Fetch/extract content from URLs',
    'x_search': 'Search X/Twitter posts and trends',
    'browser': 'Browser automation: navigate, click, screenshot, scrape web pages. Use when you need to interact with a live webpage (login, fill forms, click buttons) — NOT for analyzing already-uploaded screenshots (use image for that)',
    'canvas': 'Present data visualizations and interactive canvases',
    'nodes': 'Control paired devices: phone camera, notifications, screen recording, location, device status',
    'cron': 'Schedule cron jobs, reminders, recurring tasks, wake events',
    'message': 'Send messages, polls, reactions to Telegram/Slack/Discord channels. Also used for device/IoT commands when paired nodes are involved',
    'gateway': 'OpenClaw gateway: restart, update config, change models, apply settings. Also needed for cross-channel delivery (sending to both Slack AND email in one action)',
    'agents_list': 'List available agent IDs for spawning',
    'sessions_list': 'List active sessions and sub-agents, check agent status',
    'sessions_history': 'Fetch message history from another session',
    'sessions_send': 'Send a message into another session',
    'sessions_spawn': 'Spawn coding agents (Codex, Claude Code), sub-agents, or ACP sessions for complex/coding tasks',
    'sessions_yield': 'End current turn to receive sub-agent results. Use when spawning parallel agents and needing to wait for their output',
    'subagents': 'List, steer, or kill running sub-agents. Use alongside sessions_spawn when you need to manage, monitor, or coordinate spawned agents',
    'session_status': 'Session status: model, usage, cost, configuration',
    'image': 'Analyze/describe images with vision model',
    'image_generate': 'Generate new images from text prompts',
    'video_generate': 'Generate videos from prompts or reference images',
    'tts': 'Text-to-speech: convert text to spoken audio/voice. Use for voiceovers, audio clips, spoken briefings, narration, podcast-style content',
    'code_execution': 'Run sandboxed Python for calculations, data analysis, tabulation, forecasting, duplicate detection, anomaly detection, categorization analysis, filtering, grouping, pattern matching, and any computation beyond simple lookups. Use whenever the task implies comparing, deduplicating, cross-referencing, or programmatically analyzing data — even financial transactions',
    'pdf': 'Analyze PDF documents, extract text and data',
    'memory_search': 'Search memories',
    'memory_add': 'Store memories',
    'memory_delete': 'Delete memories',
    'memory_get': 'Get memory by ID',
    'memory_list': 'List all memories',
    'memory_update': 'Update memory',
    'memory_event_list': 'List memory events',
    'memory_event_status': 'Memory event status',
    'monarch-money__get_accounts': 'Get linked financial accounts (balances, institutions, account types)',
    'monarch-money__get_budgets': 'Get budget information (limits, spending vs budget by category)',
    'monarch-money__get_cashflow': 'Analyze cashflow data (income vs expenses over time)',
    'monarch-money__get_transaction_categories': 'List all transaction categories. REQUIRED when filtering, grouping, or breaking down transactions by category, or when checking which categories exist/have activity',
    'monarch-money__get_transactions': 'Fetch financial transactions (with optional filters by account, category, date range)',
    'monarch-money__refresh_accounts': 'Refresh all financial account data from institutions',
}

SYSTEM_PROMPT = """You are a tool-routing classifier. Given a user prompt and the available tools, select ONLY the non-core tools needed for this turn.

Core tools (ALWAYS included, do NOT list these): read, write, edit, exec, process, memory_search, memory_add, session_status

Available non-core tools:
{tools}

Rules:
1. Return ONLY the non-core tool names the assistant would actually CALL for this prompt
2. If no non-core tools are needed, return an empty array
3. Include tools for the complete task (e.g., research needs web_search + web_fetch)
4. When uncertain or the task spans many domains, include all relevant tools
5. Short/ambiguous prompts (<20 chars) → return all non-core tools
6. For multi-step prompts ("do X, then Y"), include tools for ALL steps — especially `message` for any "notify", "tell", "send", "confirm with", "draft a message" component
7. For comparison, research, or evaluation tasks, include `web_search` — current information beats training data

Respond with ONLY valid JSON: {{"tools":["tool_name",...],"confidence":<0.0-1.0>,"reasoning":"<10 words max>"}}"""


def classify_prompt(prompt: str, tools: list[str] | None = None) -> dict:
    """Send a prompt through the LLM classifier and return the result."""
    if tools is None:
        tools = ALL_TOOLS

    non_core = [t for t in tools if t not in CORE_TOOLS]
    tool_list = "\n".join(f"- {t}: {TOOL_DESCRIPTIONS.get(t, 'specialized tool')}" for t in sorted(non_core))
    sys_prompt = SYSTEM_PROMPT.format(tools=tool_list)

    start = time.monotonic()
    try:
        body = {
            "model": LLM_MODEL,
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": prompt[:1500]},
            ],
            "temperature": 0.1,
            "max_tokens": 300,
        }
        # json_object mode: supported by OpenAI, may fail on other providers
        model_lower = LLM_MODEL.lower()
        if any(k in model_lower for k in ("gpt", "o4", "o3")):
            body["response_format"] = {"type": "json_object"}

        resp = httpx.post(
            f"{LLM_API_BASE}/v1/chat/completions",
            headers={"Authorization": f"Bearer {LLM_API_KEY}"},
            json=body,
            timeout=30.0,
        )
        resp.raise_for_status()
        latency_ms = int((time.monotonic() - start) * 1000)

        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
        # Strip markdown fencing if the model wraps JSON in ```
        content = content.strip()
        if content.startswith("```"):
            # Remove opening fence (```json or ```)
            content = content.split("\n", 1)[-1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3].strip()
        parsed = json.loads(content)
        usage = payload.get("usage", {})
        return {
            "tools": parsed.get("tools", []),
            "reasoning": parsed.get("reasoning", ""),
            "latency_ms": latency_ms,
            "error": None,
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
            "cost_usd": usage.get("total_cost") or usage.get("cost") or 0,
        }
    except Exception as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        return {
            "tools": [],
            "reasoning": "",
            "latency_ms": latency_ms,
            "error": str(e),
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0,
        }


def classify_prompt_voting(prompt: str, tools: list[str] | None = None, votes: int = 3) -> dict:
    """Run classify_prompt N times and return majority-vote result."""
    results = []
    total_latency = 0
    for _ in range(votes):
        r = classify_prompt(prompt, tools)
        if r["error"]:
            return r  # Propagate errors immediately
        results.append(r)
        total_latency += r["latency_ms"]

    # Majority vote: a tool is included if it appears in >50% of results
    tool_counts: dict[str, int] = {}
    for r in results:
        for t in r["tools"]:
            tool_counts[t] = tool_counts.get(t, 0) + 1

    threshold = votes / 2
    voted_tools = sorted(t for t, c in tool_counts.items() if c > threshold)

    # Confidence: average of individual confidences (if present), penalized by disagreement
    agreement_ratio = sum(
        1 for r in results if set(r["tools"]) == set(voted_tools)
    ) / votes

    return {
        "tools": voted_tools,
        "reasoning": f"majority-vote ({votes}x, {agreement_ratio:.0%} agreement)",
        "latency_ms": total_latency,
        "latency_ms_avg": int(total_latency / votes),
        "error": None,
        "votes": votes,
        "agreement": round(agreement_ratio, 2),
        "individual_results": [r["tools"] for r in results],
        "input_tokens": sum(r.get("input_tokens", 0) for r in results),
        "output_tokens": sum(r.get("output_tokens", 0) for r in results),
        "total_tokens": sum(r.get("total_tokens", 0) for r in results),
        "cost_usd": sum(r.get("cost_usd", 0) for r in results),
    }


def score_case(case: dict, result: dict) -> dict:
    """Score a single benchmark case against the LLM result."""
    selected = set(result["tools"])
    # Normalize field names (generator uses expected_tools, hand-written uses expectedTools/mustInclude)
    raw_expected = case.get("expectedTools") or case.get("expected_tools") or []
    must_include = set(case.get("mustInclude", raw_expected))  # If no mustInclude, treat all expected as must-include
    expected = set(raw_expected)

    # Must-include: every tool in mustInclude MUST be in selected
    missing_critical = must_include - selected
    must_include_pass = len(missing_critical) == 0

    # Expected overlap: how many expected tools were selected
    if expected:
        recall = len(expected & selected) / len(expected)
    else:
        recall = 1.0 if len(selected) == 0 else 0.5  # Empty expected = core-only

    # False positives: tools selected that weren't expected
    false_positives = selected - expected - CORE_TOOLS
    precision = 1.0 if len(selected) == 0 else len(selected - false_positives) / max(len(selected), 1)

    return {
        "case_id": case["id"],
        "prompt": case["prompt"][:80],
        "category": case.get("category", "unknown"),
        "must_include_pass": must_include_pass,
        "missing_critical": sorted(missing_critical),
        "recall": round(recall, 2),
        "precision": round(precision, 2),
        "selected_tools": sorted(selected),
        "expected_tools": sorted(expected),
        "false_positives": sorted(false_positives),
        "latency_ms": result["latency_ms"],
        "reasoning": result["reasoning"],
        "error": result["error"],
        "input_tokens": result.get("input_tokens", 0),
        "output_tokens": result.get("output_tokens", 0),
        "total_tokens": result.get("total_tokens", 0),
        "cost_usd": result.get("cost_usd", 0),
    }


def run_benchmark(cases: list[dict], classifier=None) -> dict:
    """Run the full benchmark suite and return aggregate metrics."""
    if classifier is None:
        classifier = classify_prompt
    results = []
    for i, case in enumerate(cases):
        print(f"  [{i+1}/{len(cases)}] {case['prompt'][:60]}...", end=" ", flush=True)
        result = classifier(case["prompt"])
        scored = score_case(case, result)
        status = "✅" if scored["must_include_pass"] and not scored["error"] else "❌"
        print(f"{status} ({scored['latency_ms']}ms)")
        results.append(scored)
        time.sleep(0.2)  # Rate limit courtesy

    # Aggregate metrics
    total = len(results)
    must_include_passes = sum(1 for r in results if r["must_include_pass"])
    errors = sum(1 for r in results if r["error"])
    avg_recall = sum(r["recall"] for r in results) / total if total else 0
    avg_precision = sum(r["precision"] for r in results) / total if total else 0
    latencies = [r["latency_ms"] for r in results if not r["error"]]
    latencies.sort()

    # Per-category breakdown
    categories = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = {"total": 0, "pass": 0, "fail": 0, "avg_latency": 0, "latencies": []}
        categories[cat]["total"] += 1
        if r["must_include_pass"] and not r["error"]:
            categories[cat]["pass"] += 1
        else:
            categories[cat]["fail"] += 1
        categories[cat]["latencies"].append(r["latency_ms"])

    for cat in categories:
        lats = categories[cat]["latencies"]
        categories[cat]["avg_latency"] = int(sum(lats) / len(lats)) if lats else 0
        categories[cat]["accuracy"] = round(categories[cat]["pass"] / categories[cat]["total"], 2)
        del categories[cat]["latencies"]

    metrics = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": LLM_MODEL,
        "total_cases": total,
        "must_include_accuracy": round(must_include_passes / total, 3) if total else 0,
        "avg_recall": round(avg_recall, 3),
        "avg_precision": round(avg_precision, 3),
        "errors": errors,
        "latency_p50": latencies[len(latencies)//2] if latencies else 0,
        "latency_p95": latencies[int(len(latencies)*0.95)] if latencies else 0,
        "latency_mean": int(sum(latencies)/len(latencies)) if latencies else 0,
        "usage": {
            "input_tokens": sum(r.get("input_tokens", 0) for r in results),
            "output_tokens": sum(r.get("output_tokens", 0) for r in results),
            "total_tokens": sum(r.get("total_tokens", 0) for r in results),
            "cost_usd": round(sum(r.get("cost_usd", 0) for r in results), 6),
        },
        "categories": categories,
        "failures": [r for r in results if not r["must_include_pass"] or r["error"]],
        "all_results": results,
    }

    return metrics


def print_report(metrics: dict):
    """Print a human-readable report."""
    print("\n" + "="*70)
    print(f"  RESOLVER v3 BENCHMARK REPORT — {metrics['timestamp'][:10]}")
    print(f"  Model: {metrics['model']}")
    print("="*70)
    print(f"\n  Must-Include Accuracy: {metrics['must_include_accuracy']*100:.1f}% ({int(metrics['must_include_accuracy']*metrics['total_cases'])}/{metrics['total_cases']})")
    print(f"  Average Recall:       {metrics['avg_recall']*100:.1f}%")
    print(f"  Average Precision:    {metrics['avg_precision']*100:.1f}%")
    print(f"  Errors:               {metrics['errors']}")
    print(f"  Latency (p50/p95):    {metrics['latency_p50']}ms / {metrics['latency_p95']}ms")

    print(f"\n  Category Breakdown:")
    print(f"  {'Category':<15} {'Accuracy':>10} {'Pass/Total':>12} {'Avg Latency':>12}")
    print(f"  {'-'*15} {'-'*10} {'-'*12} {'-'*12}")
    for cat, data in sorted(metrics["categories"].items()):
        acc = f"{data['accuracy']*100:.0f}%"
        pt = f"{data['pass']}/{data['total']}"
        lat = f"{data['avg_latency']}ms"
        print(f"  {cat:<15} {acc:>10} {pt:>12} {lat:>12}")

    if metrics["failures"]:
        print(f"\n  ❌ Failures:")
        for f in metrics["failures"]:
            print(f"    Case {f['case_id']}: {f['prompt']}")
            if f["missing_critical"]:
                print(f"      Missing: {f['missing_critical']}")
            if f["error"]:
                print(f"      Error: {f['error']}")


def main():
    parser = argparse.ArgumentParser(description="Resolver v3 Replay Harness")
    parser.add_argument("--category", help="Run only cases in this category")
    parser.add_argument("--ids", help="Comma-separated case IDs to run")
    parser.add_argument("--from-telemetry", help="Replay from telemetry JSONL file")
    parser.add_argument("--output", help="Output metrics file path")
    parser.add_argument("--votes", type=int, default=1, help="Best-of-N voting (1=single pass, 3=majority vote)")
    args = parser.parse_args()

    if args.from_telemetry:
        # Build cases from telemetry entries
        cases = []
        with open(args.from_telemetry) as f:
            for i, line in enumerate(f):
                entry = json.loads(line)
                if "promptExcerpt" in entry:
                    cases.append({
                        "id": i + 1,
                        "prompt": entry["promptExcerpt"],
                        "expectedTools": entry.get("toolsAllow", []),
                        "mustInclude": [],  # Can't infer must-include from telemetry
                        "category": entry.get("profile", "telemetry"),
                    })
        print(f"Loaded {len(cases)} cases from telemetry")
    else:
        with open(BENCHMARK_FILE) as f:
            data = json.load(f)
        # Handle both formats: plain list or {"cases": [...]}
        cases = data if isinstance(data, list) else data.get("cases", data)

        if args.category:
            cases = [c for c in cases if c.get("category") == args.category]
        if args.ids:
            ids = set(int(x) for x in args.ids.split(","))
            cases = [c for c in cases if c["id"] in ids]

    classifier = classify_prompt if args.votes == 1 else lambda p, t=None: classify_prompt_voting(p, t, votes=args.votes)
    print(f"Running {len(cases)} benchmark cases against {LLM_MODEL} (votes={args.votes})...")
    metrics = run_benchmark(cases, classifier=classifier)
    metrics["votes"] = args.votes
    print_report(metrics)

    # Save metrics
    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = args.output or str(METRICS_DIR / f"{date_str}-benchmark.json")
    with open(output_path, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"\n  Metrics saved to: {output_path}")


if __name__ == "__main__":
    main()
