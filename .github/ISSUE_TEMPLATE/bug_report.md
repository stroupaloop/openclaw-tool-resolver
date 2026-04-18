---
name: Bug Report
about: Report a misclassification or other issue
title: "[Bug] "
labels: bug
assignees: ''
---

## Description

A clear description of the issue.

## Misclassification Details (if applicable)

**Prompt** (sanitized if needed):
```
Your prompt here
```

**Expected tools**: `[tool_a, tool_b]`
**Selected tools**: `[tool_c]`
**Missing tools**: `[tool_a, tool_b]`

## Telemetry Entry (if available)

```json
{
  "turn": 15,
  "source": "llm",
  "confidence": 0.85,
  "toolsAllow": ["..."]
}
```

## Environment

- OpenClaw version:
- Plugin version:
- Classification model:
- Node.js version:
