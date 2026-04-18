# Temporary Patching Guide

> **This is a temporary workaround.** Once [openclaw/openclaw#68608](https://github.com/openclaw/openclaw/pull/68608) is merged, install the latest OpenClaw and this patch is no longer needed.

The resolver plugin uses the `before_prompt_build` hook to return `toolsAllow`, which tells OpenClaw to narrow the tool surface. Current OpenClaw (2026.4.15+) fires the hook but doesn't extract `toolsAllow` from the result. Three small patches fix this.

## What the Patches Do

1. **Hook merger** — Pass `toolsAllow` through when merging multiple hook results
2. **Hook resolver** — Include `availableTools` in the hook event and extract `toolsAllow` from the result
3. **Tool filtering** — Apply `hookResult.toolsAllow` to filter `effectiveTools`

## Finding the Files

```bash
# Find your OpenClaw dist directory
OPENCLAW_DIST=$(dirname $(readlink -f $(which openclaw)))/../lib/node_modules/openclaw/dist

# On macOS (no readlink -f):
OPENCLAW_DIST=$(node -e "console.log(require('path').dirname(require('fs').realpathSync(process.argv[1])))" $(which openclaw))/../lib/node_modules/openclaw/dist

ls $OPENCLAW_DIST/*.js | head -5
```

You need to find two files (names include build hashes):
- `hook-runner-global-*.js` — contains `mergeBeforePromptBuild`
- `pi-embedded-runner-*.js` — contains `resolvePromptBuildHookResult` and `effectiveTools`

## Patch 1: Hook Merger (`hook-runner-global-*.js`)

Find the `mergeBeforePromptBuild` function. Look for the `return` statement that merges results:

```bash
grep -n "mergeBeforePromptBuild" $OPENCLAW_DIST/hook-runner-global-*.js
```

Add `toolsAllow` to the merge:

```javascript
// BEFORE:
return {
  prependContext: firstDefined(acc?.prependContext, next.prependContext),
  // ... other fields
};

// AFTER:
return {
  prependContext: firstDefined(acc?.prependContext, next.prependContext),
  toolsAllow: firstDefined(acc?.toolsAllow, next.toolsAllow),
  // ... other fields
};
```

## Patch 2: Hook Resolver (`pi-embedded-runner-*.js`)

Find `resolvePromptBuildHookResult`. Add `availableTools` to the hook event and extract `toolsAllow` from the result:

```bash
grep -n "resolvePromptBuildHookResult" $OPENCLAW_DIST/pi-embedded-runner-*.js
```

In the function, find where it builds the event object and add:

```javascript
// Add to the event passed to hooks:
availableTools: Array.from(/* the available tools set or array */)

// Add to the return value:
toolsAllow: merged?.toolsAllow
```

## Patch 3: Apply toolsAllow (`pi-embedded-runner-*.js`)

Find where `hookResult` is consumed (after `resolvePromptBuildHookResult` is called). Add filtering:

```bash
grep -n "effectiveTools" $OPENCLAW_DIST/pi-embedded-runner-*.js
```

Change `effectiveTools` from `const` to `let`, then add after the hookResult processing:

```javascript
// After hookResult is applied:
if (hookResult?.toolsAllow?.length > 0) {
  const allowed = new Set(hookResult.toolsAllow);
  effectiveTools = effectiveTools.filter(t => allowed.has(t.function?.name ?? t.name));
  log.debug(`hooks: toolsAllow narrowed tools ${originalLength} → ${effectiveTools.length}`);
}
```

## Verifying the Patch

After patching, restart OpenClaw and check the logs:

```bash
openclaw gateway restart
# Look for:
# hooks: toolsAllow narrowed tools 42 → 18
# [tool-resolver] v3.1 active | llm=gpt-5.4-mini | keyword=validation-only
```

If you see `toolsAllow narrowed tools`, the patch is working.

## Reverting

```bash
npm install -g openclaw@latest
```

This overwrites the dist files with the unpatched versions.
