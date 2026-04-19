/**
 * OpenClaw Tool Resolver Plugin v3.1 — Dynamic Tool Introspection
 *
 * LLM ALWAYS classifies. Keyword cache is a validation layer, not a bypass.
 * When keyword cache and LLM disagree, flag for review. Cache never controls
 * the tool surface directly.
 *
 * Architecture:
 *   1. LLM classifies every turn (gpt-5.4-mini, ~1.3s, ~$0.00015/call)
 *   2. Keyword cache validates LLM output (flags disagreements)
 *   3. Legacy keyword fallback ONLY on LLM timeout/error
 *   4. Telemetry: append-only JSONL, auto-rotated at 30 days
 *
 * Requires: openclaw/openclaw#68608 or equivalent hook support.
 */

import { appendFile, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

function definePluginEntry({ id, name, description, kind, configSchema = {}, register }) {
  return { id, name, description, ...kind ? { kind } : {}, configSchema, register };
}

// ── Core Tool Groups (always included regardless of classification) ─────────

const CORE_TOOLS = new Set([
  'read', 'write', 'edit', 'exec', 'process',
  'memory_search', 'memory_add', 'session_status',
]);

// ── Catalog Loading (tool + skill descriptions) ─────────────────────────────
//
// Descriptions are loaded from default-catalog.json (shipped with package) and
// optionally merged with an operator-writable override file at plugin boot.
// Splits code from data: description tuning no longer requires code edits.
// See README "Description Overrides" for the full catalog schema + override flow.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _defaultCatalog = null;
function loadDefaultCatalog() {
  if (_defaultCatalog) return _defaultCatalog;
  const candidates = [
    join(__dirname, 'default-catalog.json'),
    join(process.cwd(), 'default-catalog.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        _defaultCatalog = {
          tools: (raw && typeof raw.tools === 'object') ? raw.tools : {},
          skills: (raw && typeof raw.skills === 'object') ? raw.skills : {},
        };
        return _defaultCatalog;
      } catch (_err) { /* fall through */ }
    }
  }
  _defaultCatalog = { tools: {}, skills: {} };
  return _defaultCatalog;
}

function loadOverrideCatalog(pathHint) {
  if (!pathHint || typeof pathHint !== 'string') return { tools: {}, skills: {} };
  // Expand ~ and resolve to absolute path
  const expanded = pathHint.startsWith('~')
    ? pathHint.replace(/^~/, process.env.HOME || '')
    : pathHint;
  const absolute = resolve(expanded);
  if (!existsSync(absolute)) return { tools: {}, skills: {} };
  try {
    const raw = JSON.parse(readFileSync(absolute, 'utf8'));
    return {
      tools: (raw && typeof raw.tools === 'object') ? raw.tools : {},
      skills: (raw && typeof raw.skills === 'object') ? raw.skills : {},
    };
  } catch (_err) {
    return { tools: {}, skills: {} };
  }
}

// Legacy accessor for backward-compat with any external code still reading these names
const TOOL_DESCRIPTIONS = new Proxy({}, { get: (_, k) => loadDefaultCatalog().tools[k] });
const SKILL_DESCRIPTIONS = new Proxy({}, { get: (_, k) => loadDefaultCatalog().skills[k] });



// ── Metadata Stripping ─────────────────────────────────────────────────────

function stripMetadata(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  let cleaned = prompt;
  const metaKeys = ['message_id', 'sender_id', 'conversation_label', 'chat_id',
    'topic_id', 'is_forum', 'is_group_chat', 'has_reply_context'];
  cleaned = cleaned.replace(/```json\s*\{[^`]*?\}\s*```/gs, (block) => {
    return metaKeys.some(k => block.includes(k)) ? '' : block;
  });
  cleaned = cleaned.replace(/Conversation info \(untrusted metadata\):?\s*/g, '');
  cleaned = cleaned.replace(/Sender \(untrusted metadata\):?\s*/g, '');
  cleaned = cleaned.replace(/Replied message \(untrusted,? for context\):?\s*/g, '');
  cleaned = cleaned.replace(/<recalled-memories>[\s\S]*?<\/recalled-memories>/g, '');
  cleaned = cleaned.replace(/<read-files>[\s\S]*?<\/read-files>/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned || prompt;
}

// ── Dynamic LLM Classifier ────────────────────────────────────────────────

function buildClassificationPrompt(availableTools, availableSkills, toolOverrides, skillOverrides) {
  // Merge precedence (last wins): default catalog <- inline config overrides <- file overrides.
  // File overrides are passed in via toolOverrides/skillOverrides arg (resolved at boot from catalogOverridesFile).
  // Inline overrides (v0.5.0 back-compat) are already merged into those args by the caller.
  // See README "Description Overrides" for the full catalog schema + merge flow.
  const defaults = loadDefaultCatalog();
  const toolDesc = { ...defaults.tools, ...(toolOverrides || {}) };
  const skillDesc = { ...defaults.skills, ...(skillOverrides || {}) };

  const toolLines = availableTools
    .filter(t => !CORE_TOOLS.has(t))
    .map(t => `- ${t}: ${toolDesc[t] || 'specialized tool'}`)
    .join('\n');

  const skillSection = availableSkills && availableSkills.length > 0
    ? `\n\nAvailable skills (prompt instructions, not callable tools):\n${availableSkills.map(s => `- ${s}: ${skillDesc[s] || 'specialized skill'}`).join('\n')}\n\nSkill rules:\n1. Return ONLY skills whose SKILL.md the assistant would need to read for this prompt\n2. If no skills are relevant, return an empty array\n3. Match skill selection to the task domain — research/writing, GitHub/coding, email, etc.\n4. When in doubt, include skills that are semantically relevant; the caller decides whether to load them.`
    : '';

  return `You are a tool-and-skill routing classifier. Given a user prompt, select ONLY the non-core tools and skills needed for this turn.

Core tools (ALWAYS included, do NOT list these): ${[...CORE_TOOLS].join(', ')}

Available non-core tools:
${toolLines}${skillSection}

Rules:
1. Return ONLY the non-core tool names the assistant would actually CALL for this prompt
2. If no non-core tools are needed, return an empty tools array
3. Include tools for the complete task — trace every verb:
   - Any "notify", "tell", "send to", "text", "email", "draft a message", "let X know", "confirm with" → include \`message\`
   - Any "every", "recurring", "daily", "weekly", "remind me", "schedule" → include \`cron\`
   - Any "spin up", "launch agent", "delegate", "parallel" → include \`sessions_spawn\`
   - Any physical device verb ("mute", "turn on", "reboot", "dim", "play") → include \`nodes\`
   - Comparison, research, benchmarks, current info → include \`web_search\` + \`web_fetch\`
4. Memory tool disambiguation:
   - "remember X" / "save X" / "note that Y" (new) → \`memory_add\`
   - "update X" / "change my X" / "revise X" (modify existing) → \`memory_update\`
   - "find / search memories about X" → \`memory_search\`
   - "check if X was stored" / "verify memory Y" → \`memory_get\`
   - "list all memories" / "what do you remember" → \`memory_list\`
5. Finance tool selection:
   - "cash position" / "balances" / "which accounts" → \`finance__get_accounts\` (+ \`finance__get_cashflow\` if asking about drivers/trends)
   - "transactions" (any filter) → \`finance__get_transactions\` (+ \`finance__get_transaction_categories\` if grouping by category)
6. When uncertain or the task spans many domains, include all relevant tools (prefer over-inclusion to missing)
7. Short/ambiguous prompts (<20 chars) → return all non-core tools and all skills

Respond with ONLY valid JSON: {"tools":["tool_name",...],${availableSkills?.length ? '"skills":["skill_name",...],' : ''}"confidence":<0.0-1.0>,"reasoning":"<10 words max>"}`;
}

async function classifyLLMDynamic(prompt, availableTools, model, apiBase, apiKey, availableSkills, sessionId, agentId, extraTags, toolOverrides, skillOverrides) {
  const t0 = Date.now();
  try {
    const systemPrompt = buildClassificationPrompt(availableTools, availableSkills, toolOverrides, skillOverrides);
    const tags = ['openclaw-resolver', 'resolver:classify', ...(extraTags || [])];
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt.slice(0, 800) },
      ],
      max_tokens: 200,
      temperature: 0,
      user: 'openclaw-resolver',
      metadata: {
        tags,
        caller: 'openclaw-resolver',
        session_id: sessionId || null,
        agent_id: agentId || null,
      },
    });

    const resp = await fetch(`${apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-openclaw-caller': 'tool-resolver',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}`, latencyMs: Date.now() - t0 };
    }

    const data = await resp.json();
    const latencyMs = Date.now() - t0;
    let content = data.choices?.[0]?.message?.content?.trim() || '';

    if (content.startsWith('```')) {
      content = content.split('\n').slice(1).join('\n').replace(/```\s*$/, '').trim();
    }

    const parsed = JSON.parse(content);
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const validTools = tools.filter(t => availableTools.includes(t));
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    const validSkills = availableSkills ? skills.filter(s => availableSkills.includes(s)) : [];

    return {
      tools: validTools,
      skills: validSkills,
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning || '',
      latencyMs,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    };
  } catch (err) {
    return { error: String(err), latencyMs: Date.now() - t0 };
  }
}

// ── Keyword Cache (VALIDATION layer — never bypasses LLM) ──────────────────

const KEYWORD_CACHE_FILE = resolve(process.env.HOME || '/tmp', '.openclaw/workspace/resolver-keyword-cache.json');

let keywordCache = {};
let keywordCacheDirty = false;

async function loadKeywordCache() {
  try {
    const data = await readFile(KEYWORD_CACHE_FILE, 'utf-8');
    keywordCache = JSON.parse(data);
  } catch {
    keywordCache = {};
  }
}

async function saveKeywordCache() {
  if (!keywordCacheDirty) return;
  try {
    await writeFile(KEYWORD_CACHE_FILE, JSON.stringify(keywordCache, null, 2));
    keywordCacheDirty = false;
  } catch { /* best-effort */ }
}

function extractKeyPhrases(prompt) {
  const lower = prompt.toLowerCase().trim();
  const stopwords = new Set(['this', 'that', 'with', 'from', 'what', 'when', 'where', 'which', 'have', 'been', 'will', 'would', 'could', 'should', 'there', 'their', 'about', 'them', 'then', 'than', 'these', 'those', 'your', 'into', 'some', 'very', 'just', 'also']);
  const words = lower.replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !stopwords.has(w));
  return [...new Set(words.slice(0, 8))];
}

function validateAgainstCache(prompt, llmTools) {
  const phrases = extractKeyPhrases(prompt);
  if (phrases.length === 0) return { match: 'no_cache', cachedTools: [] };

  const toolScores = {};
  let matchCount = 0;

  for (const phrase of phrases) {
    const entry = keywordCache[phrase];
    if (!entry || entry.count < 3) continue; // Need 3+ observations to validate
    matchCount++;
    for (const tool of entry.tools) {
      toolScores[tool] = (toolScores[tool] || 0) + entry.count;
    }
  }

  if (matchCount < 2) return { match: 'insufficient_data', cachedTools: [] };

  const cachedTools = Object.entries(toolScores)
    .sort((a, b) => b[1] - a[1])
    .map(([tool]) => tool);

  // Check if LLM and cache agree
  const llmSet = new Set(llmTools);
  const cacheSet = new Set(cachedTools);

  // Cache has tools the LLM missed?
  const llmMissing = cachedTools.filter(t => !llmSet.has(t));
  // LLM has tools the cache doesn't know about?
  const cacheNew = llmTools.filter(t => !cacheSet.has(t));

  if (llmMissing.length === 0 && cacheNew.length === 0) {
    return { match: 'agree', cachedTools };
  } else if (llmMissing.length > 0) {
    return { match: 'llm_may_miss', cachedTools, llmMissing, cacheNew };
  } else {
    return { match: 'llm_broader', cachedTools, cacheNew };
  }
}

function updateKeywordCache(prompt, tools) {
  const phrases = extractKeyPhrases(prompt);
  for (const phrase of phrases) {
    if (!keywordCache[phrase]) {
      keywordCache[phrase] = { tools: [], count: 0 };
    }
    const entry = keywordCache[phrase];
    for (const tool of tools) {
      if (!entry.tools.includes(tool)) {
        entry.tools.push(tool);
      }
    }
    entry.count++;
    entry.lastSeen = new Date().toISOString();
    keywordCacheDirty = true;
  }
}

// ── Legacy Keyword Classifier (fallback ONLY on LLM failure) ───────────────

const LEGACY_PROFILES = {
  coding: {
    tools: ['sessions_spawn', 'sessions_yield', 'sessions_list', 'sessions_history', 'sessions_send', 'subagents'],
    keywords: ['build', 'code', 'implement', 'refactor', 'PR', 'deploy', 'fix bug', 'commit', 'push', 'branch', 'merge', 'test', 'lint', 'compile', 'git ', 'npm ', 'script', 'debug'],
  },
  research: {
    tools: ['web_search', 'web_fetch', 'x_search', 'code_execution', 'sessions_spawn', 'sessions_yield', 'sessions_list', 'sessions_history', 'sessions_send', 'subagents', 'pdf', 'image'],
    keywords: ['research', 'analyze', 'investigate', 'compare', 'evaluate', 'market', 'report', 'search', 'find', 'look up', 'xllm', 'deep dive', 'brief', 'arxiv', 's-1'],
  },
  financial: {
    tools: ['finance__get_accounts', 'finance__get_budgets', 'finance__get_cashflow', 'finance__get_transaction_categories', 'finance__get_transactions', 'finance__refresh_accounts', 'code_execution'],
    keywords: ['budget', 'expense', 'transaction', 'financial', 'spending', 'cashflow', 'cost', 'revenue'],
  },
  messaging: {
    tools: ['message', 'tts'],
    keywords: ['send message', 'post to', 'deliver', 'notify', 'telegram', 'slack', 'email', 'announce'],
  },
  media: {
    tools: ['image_generate', 'video_generate', 'tts', 'image', 'web_fetch'],
    keywords: ['generate image', 'create image', 'generate video', 'voice', 'audio', 'narrate', 'tts', 'thumbnail'],
  },
  ops: {
    tools: ['browser', 'sessions_list', 'cron', 'gateway'],
    keywords: ['status', 'health', 'restart', 'cron', 'config', 'update', 'docker', 'container', 'tailscale', 'ssh'],
  },
  browser_automation: {
    tools: ['browser', 'web_fetch', 'image'],
    keywords: ['open browser', 'navigate to', 'click', 'screenshot', 'fill form', 'scrape', 'dashboard'],
  },
};

function classifyLegacyKeyword(prompt) {
  const lower = prompt.toLowerCase();
  let bestProfile = null;
  let bestScore = 0;
  let bestMatches = [];

  for (const [name, profile] of Object.entries(LEGACY_PROFILES)) {
    const matches = profile.keywords.filter(kw => lower.includes(kw.toLowerCase()));
    const score = matches.reduce((sum, kw) => sum + kw.length, 0);
    if (matches.length > 0 && score > bestScore) {
      bestProfile = name;
      bestScore = score;
      bestMatches = matches;
    }
  }

  if (!bestProfile) return null;
  return { profile: bestProfile, tools: LEGACY_PROFILES[bestProfile].tools, matchedKeywords: bestMatches };
}

// ── Telemetry (with rotation) ──────────────────────────────────────────────

const counters = { total: 0, narrowed: 0, fullSurface: 0, tokensSaved: 0, llmCalls: 0, llmErrors: 0, validationFlags: 0 };

async function logTelemetry(filePath, entry) {
  if (!filePath) return;
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    await appendFile(resolve(filePath), line);
  } catch { /* best-effort */ }
}

async function rotateTelemetry(filePath) {
  if (!filePath) return;
  try {
    const resolved = resolve(filePath);
    const stats = await stat(resolved);
    // Rotate if > 5MB
    if (stats.size > 5 * 1024 * 1024) {
      const archivePath = resolved.replace('.jsonl', `-archive-${Date.now()}.jsonl`);
      await rename(resolved, archivePath);
    }
  } catch { /* file doesn't exist yet, fine */ }
}

// ── Plugin Entry ───────────────────────────────────────────────────────────

export default definePluginEntry({
  id: 'openclaw-tool-resolver',
  name: 'Tool Resolver v3.1',
  description: 'Dynamic per-turn tool narrowing — LLM always classifies, keyword cache validates',
  kind: 'agents',

  register(api) {
    const config = api.pluginConfig ?? api.config ?? {};
    const enabled = config.enabled !== false;
    const logDecisions = config.logDecisions !== false;
    const telemetryFile = config.telemetryFile || '';

    const llmModel = config.llmModel || 'gpt-5.4-mini';
    const llmApiBase = config.llmApiBase || 'https://api.openai.com/v1';
    const llmApiKey = config.llmApiKey || '';
    const capturePrompts = config.capturePrompts !== false;
    const promptExcerptLength = config.promptExcerptLength || 1500;
    const extraTags = Array.isArray(config.telemetry?.tags) ? config.telemetry.tags : [];

    // Description overrides — three merge layers (last wins):
    //   1. Defaults from default-catalog.json (shipped with package)
    //   2. Inline config overrides (v0.5.0 back-compat): config.toolDescriptionOverrides + config.skillDescriptionOverrides
    //   3. External override file: config.catalogOverridesFile (default ~/.openclaw/resolver-catalog.json)
    // Mission Control or any orchestrator writes to the override file; operator-edits may use inline config.
    // See README "Description Overrides" for full flow.
    const inlineToolOverrides = (config.toolDescriptionOverrides && typeof config.toolDescriptionOverrides === 'object') ? config.toolDescriptionOverrides : {};
    const inlineSkillOverrides = (config.skillDescriptionOverrides && typeof config.skillDescriptionOverrides === 'object') ? config.skillDescriptionOverrides : {};

    const catalogOverridesPath = config.catalogOverridesFile || `${process.env.HOME || ''}/.openclaw/resolver-catalog.json`;
    const fileOverrides = loadOverrideCatalog(catalogOverridesPath);

    // Merge order: inline config ← file overrides (file wins per-key)
    const toolOverrides = { ...inlineToolOverrides, ...fileOverrides.tools };
    const skillOverrides = { ...inlineSkillOverrides, ...fileOverrides.skills };

    if (Object.keys(toolOverrides).length > 0 || Object.keys(skillOverrides).length > 0) {
      const inlineCount = Object.keys(inlineToolOverrides).length + Object.keys(inlineSkillOverrides).length;
      const fileCount = Object.keys(fileOverrides.tools).length + Object.keys(fileOverrides.skills).length;
      api.logger.info?.(
        `[tool-resolver] description overrides active: ` +
        `${Object.keys(toolOverrides).length} tool(s), ${Object.keys(skillOverrides).length} skill(s) ` +
        `(inline: ${inlineCount}, file: ${fileCount} from ${fileCount > 0 ? catalogOverridesPath : 'n/a'})`
      );
    }

    if (!enabled) {
      api.logger.info?.('[tool-resolver] disabled');
      return;
    }

    // Load keyword cache + rotate telemetry on startup
    loadKeywordCache().then(() => {
      const cacheSize = Object.keys(keywordCache).length;
      if (cacheSize > 0) api.logger.info?.(`[tool-resolver] loaded ${cacheSize} keyword cache entries`);
    });
    rotateTelemetry(telemetryFile);

    api.logger.info?.(
      `[tool-resolver] v3.1 active | llm=${llmModel} | keyword=validation-only | dynamic introspection`
    );

    api.on('before_prompt_build', async (event, hookCtx) => {
      const rawPrompt = event.prompt;
      const availableTools = event.availableTools;
      const availableSkills = event.availableSkills;
      const sessionId = hookCtx?.sessionId ?? null;
      const agentId = hookCtx?.agentId ?? null;

      // Debug: log skill availability
      api.logger.info?.(`[tool-resolver] event keys: ${Object.keys(event).join(',')} | availableSkills: ${availableSkills ? availableSkills.length + ' skills' : 'undefined'}`);

      // Skip if no prompt or no available tools (early/pre-assembly call)
      if (!rawPrompt || typeof rawPrompt !== 'string' || rawPrompt.length < 10) return undefined;
      if (!availableTools || availableTools.length === 0) return undefined;

      const prompt = stripMetadata(rawPrompt);
      if (!prompt || prompt.length < 5) return undefined;

      counters.total++;

      const nonCoreTools = availableTools.filter(t => !CORE_TOOLS.has(t));
      if (nonCoreTools.length <= 3) {
        counters.fullSurface++;
        return undefined;
      }

      // ── LLM ALWAYS classifies (no bypass) ──

      if (!llmApiKey) {
        // No API key — degrade to legacy keyword (last resort)
        const kw = classifyLegacyKeyword(prompt);
        if (!kw) { counters.fullSurface++; return undefined; }
        const toolsAllow = [...CORE_TOOLS, ...kw.tools].filter(t => availableTools.includes(t));
        counters.narrowed++;
        return { toolsAllow };
      }

      try {
        const llmResult = await classifyLLMDynamic(prompt, nonCoreTools, llmModel, llmApiBase, llmApiKey, availableSkills, sessionId, agentId, extraTags, toolOverrides, skillOverrides);
        counters.llmCalls++;

        if (llmResult.error) {
          counters.llmErrors++;
          api.logger.warn?.(`[tool-resolver] LLM error: ${llmResult.error} (${llmResult.latencyMs}ms) — falling back to keyword`);

          // Fallback to legacy keyword ONLY on LLM failure
          const kw = classifyLegacyKeyword(prompt);
          if (!kw) { counters.fullSurface++; return undefined; }
          const toolsAllow = [...CORE_TOOLS, ...kw.tools].filter(t => availableTools.includes(t));
          counters.narrowed++;
          logTelemetry(telemetryFile, {
            turn: counters.total, toolsAllow, source: 'keyword-fallback',
            llmError: llmResult.error, availableTools,
            sessionId,
            agentId,
            promptExcerpt: capturePrompts ? prompt.slice(0, promptExcerptLength) : undefined,
          });
          return { toolsAllow };
        }

        // ── LLM succeeded — validate against keyword cache ──

        const validation = validateAgainstCache(prompt, llmResult.tools);
        let finalTools = llmResult.tools;
        let validationAction = 'none';

        if (validation.match === 'llm_may_miss' && validation.llmMissing.length > 0) {
          // Cache thinks LLM missed tools — MERGE them in (safe: adds tools, never removes)
          finalTools = [...new Set([...llmResult.tools, ...validation.llmMissing])];
          validationAction = 'merged_cache_tools';
          counters.validationFlags++;
          api.logger.info?.(
            `[tool-resolver] turn=${counters.total} VALIDATION: cache suggests LLM missed [${validation.llmMissing.join(',')}] — merged`
          );
        }

        const toolsAllow = [...CORE_TOOLS, ...finalTools].filter(t => availableTools.includes(t));
        const savings = Math.max(0, availableTools.length - toolsAllow.length) * 150;

        if (toolsAllow.length < availableTools.length) {
          counters.narrowed++;
          counters.tokensSaved += savings;

          if (logDecisions) {
            const toolLabel = finalTools.length === 0 ? 'core-only' : `[${finalTools.join(',')}]`;
            api.logger.info?.(
              `[tool-resolver] turn=${counters.total} → LLM ${toolLabel} ` +
              `(${toolsAllow.length}/${availableTools.length} tools, ~${savings} saved, ` +
              `conf=${llmResult.confidence?.toFixed(2)}, ${llmResult.latencyMs}ms` +
              (validationAction !== 'none' ? `, validation=${validationAction}` : '') + `)`
            );
          }
        } else {
          counters.fullSurface++;
        }

        // Train keyword cache from LLM decision (learn over time)
        if (llmResult.tools.length > 0) {
          updateKeywordCache(prompt, llmResult.tools);
          if (counters.total % 5 === 0) saveKeywordCache();
        }

        // Log telemetry
        logTelemetry(telemetryFile, {
          turn: counters.total,
          toolsAllow,
          source: 'llm',
          confidence: llmResult.confidence,
          reasoning: llmResult.reasoning,
          llmLatencyMs: llmResult.latencyMs,
          llmTools: llmResult.tools,
          finalTools,
          validation: validation.match,
          validationAction,
          llmMissing: validation.llmMissing || [],
          availableTools,
          availableSkills,
          skillsAllow: llmResult.skills,
          tokensSaved: savings,
          sessionId,
          agentId,
          promptExcerpt: capturePrompts ? prompt.slice(0, promptExcerptLength) : undefined,
        });

        // Build skillsAllow from LLM classification.
        // When availableSkills exist and LLM classified (even to empty), narrow skills.
        // Empty array means "no skills needed" — filters out all skill descriptions.
        const skillsAllow = (availableSkills && availableSkills.length > 0 && llmResult.skills)
          ? llmResult.skills
          : undefined;

        if (skillsAllow && logDecisions) {
          api.logger.info?.(
            `[tool-resolver] turn=${counters.total} → skills [${skillsAllow.join(',')}] ` +
            `(${skillsAllow.length}/${availableSkills?.length || 0} skills)`
          );
        }

        const noToolNarrowing = toolsAllow.length >= availableTools.length;
        const noSkillNarrowing = !skillsAllow;
        if (noToolNarrowing && noSkillNarrowing) return undefined;

        const result = {};
        if (!noToolNarrowing) result.toolsAllow = toolsAllow;
        if (skillsAllow) result.skillsAllow = skillsAllow;
        return result;

      } catch (err) {
        counters.llmErrors++;
        api.logger.warn?.(`[tool-resolver] LLM exception: ${String(err)}`);
        counters.fullSurface++;
        return undefined;
      }
    });

    // Periodic stats
    api.on('agent_end', () => {
      if (counters.total > 0 && counters.total % 10 === 0) {
        const pct = counters.total > 0 ? ((counters.narrowed / counters.total) * 100).toFixed(1) : '0';
        api.logger.info?.(
          `[tool-resolver] v3.1 stats: ${counters.total} turns | ` +
          `${counters.narrowed} narrowed (${pct}%) | ` +
          `${counters.llmCalls} LLM calls | ${counters.llmErrors} errors | ` +
          `${counters.validationFlags} validation flags | ~${(counters.tokensSaved / 1000).toFixed(1)}K saved`
        );
      }
    });

    // Periodic cache save
    setInterval(() => saveKeywordCache(), 60000);
  },
});
