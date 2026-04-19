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

// ── Tool Descriptions (for LLM context) ────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  read: 'Read file contents',
  write: 'Create/overwrite files',
  edit: 'Precise file edits',
  exec: 'Shell commands',
  process: 'Manage background processes',
  web_search: 'Web search via Brave API — find current information, research topics, lookup articles, news, competitors, benchmarks',
  web_fetch: 'Fetch/extract content from URLs — pull docs, articles, pricing pages, status pages, postmortems, SEC filings, any page whose URL is known or implied',
  x_search: 'Search X/Twitter posts, trends, reactions, sentiment',
  browser: 'Browser automation: navigate, click, login, fill forms, screenshot — use when you need to interact with a live webpage, NOT for reading uploaded screenshots (use image)',
  canvas: 'Present data visualizations and interactive canvases',
  nodes: 'Control paired IoT/smart-home devices and physical hardware: speakers, lights, blinds, routers, cameras, phones, displays, notifications, screen recording, location. Use for any "turn on/off", "mute", "reboot", "play", "dim", "open/close", "adjust" on physical devices',
  cron: 'Schedule cron jobs, reminders, recurring tasks, wake events — use for ANY recurring/repeating/"every day/week/hour" or "remind me in/at" request, and for booking buffers/slots on a repeating schedule',
  message: 'Send messages, texts, emails, notifications, polls, reactions to Telegram/Slack/Discord/SMS. Use for ANY "tell X", "text X", "notify X", "let X know", "send X a note", "draft a message to X", "apology to X", "thank-you to X", "confirm with X" — anywhere a human recipient needs to be informed',
  gateway: 'OpenClaw gateway: restart, update config, change models, apply settings. Also for cross-channel delivery (e.g., send to both Slack AND email)',
  agents_list: 'List available agent IDs for spawning',
  sessions_list: 'List active sessions and sub-agents, check agent status',
  sessions_history: 'Fetch message history from another session — use for "what did I say about X yesterday", "pull up the earlier thread"',
  sessions_send: 'Send a message into another session/sub-agent',
  sessions_spawn: 'Spawn coding agents (Codex, Claude Code, Pi), sub-agents, parallel research agents, or ACP sessions. Use for "spin up X", "launch parallel agents", "kick off agents to", "delegate to"',
  sessions_yield: 'End current turn to receive sub-agent results — use after sessions_spawn when awaiting parallel output',
  subagents: 'Coordinate running sub-agents: list, steer, kill. Pair with sessions_spawn when you need to monitor/manage/cancel spawned agents',
  session_status: 'Session status: model, usage, cost, configuration',
  image: 'Analyze/describe images with vision model — use for screenshots, photos, diagrams ALREADY uploaded (not live webpages)',
  image_generate: 'Generate new images from text prompts',
  video_generate: 'Generate videos from prompts or reference images',
  tts: 'Text-to-speech: convert text to spoken audio/voice briefings, voiceovers, narration',
  code_execution: 'Run sandboxed Python for calculations, data analysis, tabulation, forecasting, dedup, anomaly detection, categorization, CSV/JSON analysis, pattern matching — use whenever the task implies comparing, aggregating, filtering, or programmatically analyzing data (even financial)',
  pdf: 'Analyze PDF documents, extract text/tables/data',
  memory_search: 'Fuzzy/semantic search across memories — default for "find memories about X", "what do I remember about Y"',
  memory_add: 'Store a NEW memory — use for "remember that X", "save this as a memory", "note that Y" (first-time storage)',
  memory_delete: 'Delete a memory by ID',
  memory_get: 'Retrieve a SPECIFIC memory by ID or verify it was stored — use for "check if my preference about X was saved", "pull up memory ID N"',
  memory_list: 'List all memories (browse/inventory) — use for "show me what you remember", "list my stored preferences", "what memories exist about X"',
  memory_update: 'Modify an EXISTING stored memory (not create new) — use for "update my preference from X to Y", "change my stored X", "revise the note about Y". Distinguish from memory_add (new) by the presence of an update/change verb',
  memory_event_list: 'List memory audit events',
  memory_event_status: 'Memory event status',
  'finance__get_accounts': 'Get linked financial accounts, balances, institutions — use for "cash position", "account balances", "which accounts", overdrafts, negative balances',
  'finance__get_budgets': 'Get budgets and category limits — use for "am I over budget", "budget status", "category limits"',
  'finance__get_cashflow': 'Cashflow analysis (income vs expenses over time) — use for "cash position" trend, cashflow forecast, burn rate, net income over a period',
  'finance__get_transaction_categories': 'List transaction categories — REQUIRED when filtering/grouping transactions by category, or when checking which categories exist',
  'finance__get_transactions': 'Fetch transactions with optional filters (account/category/date/amount) — use for "show transactions", "find duplicates", "transactions over $X", "uncategorized transactions"',
  'finance__refresh_accounts': 'Refresh/sync account data from institutions — use for "refresh my accounts", "update balances", "pull latest data"',
};

// ── Skill Descriptions (example catalog) ──────────────────────────────────
//
// This is an example skill catalog for the classifier's system prompt.
// Callers should override via plugin config (config.skillDescriptions) to
// match their actual skill set. Names must match skill IDs available in
// the caller's OpenClaw installation.

const SKILL_DESCRIPTIONS = {
  '1password': '1Password CLI: secrets, vaults, desktop integration',
  'coding-agent': 'Delegate coding tasks to external coding agents (Codex, Claude Code, etc.)',
  'gh-issues': 'Fetch GitHub issues, spawn agents to fix and open PRs',
  'github': 'GitHub operations: issues, PRs, CI, code review via gh CLI',
  'healthcheck': 'Host security hardening, firewall/SSH audit, deployment checks',
  'himalaya': 'CLI email: list, read, write, reply, search via IMAP/SMTP',
  'openai-whisper-api': 'Transcribe audio via OpenAI Whisper API',
  'skill-creator': 'Create, edit, improve, or audit skills and SKILL.md files',
  'slack': 'Slack operations: reactions, pins, channel actions',
  'tmux': 'Remote-control tmux sessions: send keystrokes, scrape pane output',
  'video-frames': 'Extract frames or clips from videos using ffmpeg',
  'weather': 'Current weather and forecasts via wttr.in or Open-Meteo',
  'research-qa': 'Pre-delivery QA checklist for research output',
  'gmail-oauth': 'Gmail OAuth2 token lifecycle: refresh, validate, escalate',
};

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

function buildClassificationPrompt(availableTools, availableSkills) {
  const toolLines = availableTools
    .filter(t => !CORE_TOOLS.has(t))
    .map(t => `- ${t}: ${TOOL_DESCRIPTIONS[t] || 'specialized tool'}`)
    .join('\n');

  const skillSection = availableSkills && availableSkills.length > 0
    ? `\n\nAvailable skills (prompt instructions, not callable tools):\n${availableSkills.map(s => `- ${s}: ${SKILL_DESCRIPTIONS[s] || 'specialized skill'}`).join('\n')}\n\nSkill rules:\n1. Return ONLY skills whose SKILL.md the assistant would need to read for this prompt\n2. If no skills are relevant, return an empty array\n3. Match skill selection to the task domain — research/writing, GitHub/coding, email, etc.\n4. When in doubt, include skills that are semantically relevant; the caller decides whether to load them.`
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

async function classifyLLMDynamic(prompt, availableTools, model, apiBase, apiKey, availableSkills, sessionId, agentId, extraTags) {
  const t0 = Date.now();
  try {
    const systemPrompt = buildClassificationPrompt(availableTools, availableSkills);
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
        const llmResult = await classifyLLMDynamic(prompt, nonCoreTools, llmModel, llmApiBase, llmApiKey, availableSkills, sessionId, agentId, extraTags);
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
