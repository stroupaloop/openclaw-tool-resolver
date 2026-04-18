#!/usr/bin/env python3
"""
Generate 100+ benchmark cases from real telemetry + synthetic expansion.
Mining existing telemetry for prompt patterns, then LLM-generating variations.
"""

import json
import os
import sys
from pathlib import Path

API_BASE = os.environ.get("LLM_API_BASE", "https://api.openai.com")
API_KEY = os.environ.get("LLM_API_KEY", "")
MODEL = "gpt-5.4-mini"

BENCHMARK_FILE = Path.home() / ".openclaw/workspace/resolver-v2/tests/benchmark-v3.json"

# Categories and their expected tool combinations
CATEGORIES = {
    "financial": {
        "tools": ["finance__get_accounts", "finance__get_budgets", "finance__get_cashflow",
                   "finance__get_transaction_categories", "finance__get_transactions",
                   "finance__refresh_accounts", "code_execution"],
        "count": 12,
    },
    "messaging": {
        "tools": ["message", "tts", "cron"],
        "count": 10,
    },
    "research": {
        "tools": ["web_search", "web_fetch", "x_search", "code_execution", "pdf",
                   "sessions_spawn", "sessions_yield", "subagents"],
        "count": 15,
    },
    "creative": {
        "tools": ["image_generate", "video_generate", "tts", "image", "web_fetch"],
        "count": 10,
    },
    "browser": {
        "tools": ["browser", "web_fetch", "image"],
        "count": 8,
    },
    "scheduling": {
        "tools": ["cron", "message"],
        "count": 8,
    },
    "ops": {
        "tools": ["gateway", "cron", "sessions_list", "sessions_history", "subagents"],
        "count": 10,
    },
    "devices": {
        "tools": ["nodes", "message"],
        "count": 8,
    },
    "coding": {
        "tools": ["sessions_spawn", "sessions_yield", "subagents", "sessions_list"],
        "count": 10,
    },
    "core-only": {
        "tools": [],
        "count": 10,
    },
    "multi-domain": {
        "tools": ["web_search", "web_fetch", "code_execution", "message", "sessions_spawn"],
        "count": 10,
    },
    "memory": {
        "tools": ["memory_search", "memory_add", "memory_delete", "memory_update", "memory_list", "memory_get"],
        "count": 5,
    },
}


def generate_cases_via_llm(category, category_tools, count):
    """Use LLM to generate realistic prompts for a category."""
    import urllib.request

    tool_list = ", ".join(category_tools) if category_tools else "(no special tools — core only)"

    sys_prompt = f"""Generate {count} realistic user prompts that would require these tools: {tool_list}

Context: This is for an AI personal assistant (Ender Wiggin, COS to a startup CEO). 
The assistant manages finances, research, scheduling, communications, device control, coding agents, and operations.

For each prompt:
1. Write a natural user message (10-50 words)
2. List the MINIMUM required non-core tools
3. Note the category

Core tools (always available, don't list): read, write, edit, exec, process, memory_search, memory_add, session_status

Respond with JSON array:
[{{"prompt": "...", "expected_tools": ["tool1"], "category": "{category}", "notes": "brief"}}]

Make prompts varied — some short, some detailed. Include edge cases.
Category: {category}"""

    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": f"Generate {count} benchmark prompts for the '{category}' category."},
        ],
        "max_tokens": 4000,
        "temperature": 0.7,
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            content = data["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = "\n".join(content.split("\n")[1:]).rstrip("`").strip()
            return json.loads(content)
    except Exception as e:
        print(f"  ❌ Error generating {category}: {e}")
        return []


def main():
    print(f"Generating 100+ benchmark cases across {len(CATEGORIES)} categories...")
    all_cases = []
    case_id = 1

    for category, spec in CATEGORIES.items():
        print(f"\n  [{category}] Generating {spec['count']} cases...")
        cases = generate_cases_via_llm(category, spec["tools"], spec["count"])
        for case in cases:
            case["id"] = case_id
            case["category"] = category
            case_id += 1
        all_cases.extend(cases)
        print(f"    ✅ Got {len(cases)} cases")

    # Deduplicate by prompt similarity
    seen = set()
    unique_cases = []
    for case in all_cases:
        key = case.get("prompt", "").lower().strip()[:50]
        if key not in seen:
            seen.add(key)
            unique_cases.append(case)

    # Re-number
    for i, case in enumerate(unique_cases, 1):
        case["id"] = i

    # Write
    output = {
        "version": "v3.1",
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "model": MODEL,
        "total_cases": len(unique_cases),
        "categories": {cat: sum(1 for c in unique_cases if c.get("category") == cat) for cat in CATEGORIES},
        "cases": unique_cases,
    }

    with open(BENCHMARK_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n{'='*60}")
    print(f"  Generated {len(unique_cases)} unique benchmark cases")
    print(f"  Saved to: {BENCHMARK_FILE}")
    print(f"{'='*60}")

    for cat, count in output["categories"].items():
        print(f"    {cat}: {count}")


if __name__ == "__main__":
    main()
