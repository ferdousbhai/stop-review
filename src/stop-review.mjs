#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod/mini";

const MAX_STDIN_BYTES = 1024 * 1024;
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024;
const CLASSIFIER_TIMEOUT_MS = 180_000;
// Continuations per user turn before the hook accepts the stop unconditionally.
// Ghost enforces its own cap (GHOST_SESSION_STOP_CONTINUATION_CAP); this covers Claude Code and Codex.
const CONTINUATION_CAP = 10;

const RUNTIMES = {
  codex: {
    reviewer: { provider: "codex", model: "gpt-5.6-luna" },
  },
  claude: {
    reviewer: { provider: "claude", model: "sonnet" },
  },
  ghost: {
    reviewer: { provider: "ghost" },
  },
};

// Validate the reviewer's tiny provider-independent protocol before translating
// it to the host-specific Stop-hook JSON.
const REVIEW_VERDICT_SCHEMA = z.enum(["CONTINUE", "CONSULT", "STOP"]);

const REVIEW_PROMPT = `Classify last_assistant_message:

CONTINUE — required work remains that the agent can perform now.
CONSULT — an unresolved question can be answered by the advisor.
STOP — work is complete, or progress requires the user or an external state change.

Do not default to any outcome or invent unstated work.

Reply with exactly one word: CONTINUE, CONSULT, or STOP.`;

function redactSensitive(value) {
  return value
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function compactText(value, limit = 6000) {
  if (typeof value !== "string") return "";
  const redacted = redactSensitive(value);
  if (redacted.length <= limit) return redacted;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${redacted.slice(0, head)}\n...[truncated]...\n${redacted.slice(-tail)}`;
}

function processFailureDetail(result) {
  return compactText(
    [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join("\n"),
    1200,
  );
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .filter((part) =>
      part &&
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function recordTurnId(record) {
  return (
    record?.payload?.turn_id ??
    record?.payload?.internal_chat_message_metadata_passthrough?.turn_id ??
    record?.payload?.item?.turn_id ??
    null
  );
}

function isInjectedContext(text) {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<recommended_plugins>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<permissions instructions>")
  );
}

function boundMessages(messages, maxMessages, maxChars) {
  const selected = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const item = messages[index];
    const text = compactText(item.text);
    if (!text || (selected.length > 0 && chars + text.length > maxChars)) continue;
    selected.push({ role: item.role, text });
    chars += text.length;
  }
  selected.reverse();

  const firstUser = messages.find((item) => item.role === "user");
  if (firstUser && !selected.some((item) => item.text === compactText(firstUser.text))) {
    selected.unshift({ role: "user", text: compactText(firstUser.text) });
  }
  return selected;
}

function commandText(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  return "";
}

function commandCategory(command) {
  const value = commandText(command).toLowerCase();
  if (/\b(test|pytest|vitest|jest|cargo test|go test|rspec)\b/.test(value)) return "test";
  if (/\b(lint|eslint|ruff|clippy|shellcheck|typecheck|tsc)\b/.test(value)) return "lint";
  if (/\b(build|compile|bundle)\b/.test(value)) return "build";
  if (/\b(git|gh)\b/.test(value)) return "version-control";
  if (/\b(rg|grep|find|jq|sed)\b/.test(value)) return "inspection";
  return "other";
}

function summarizeToolItem(item) {
  if (!item || typeof item !== "object") return null;
  if (["Reasoning", "AgentMessage", "UserMessage"].includes(item.type)) return null;

  if (item.type === "CommandExecution") {
    return {
      type: "command",
      status: item.status ?? "unknown",
      category: commandCategory(item.command),
      ...(Number.isInteger(item.exit_code)
        ? { exit_code: item.exit_code, outcome: item.exit_code === 0 ? "succeeded" : "failed" }
        : {}),
    };
  }

  if (item.type === "Extension") {
    return {
      type: item.kind ?? "extension",
      status: item.status ?? "completed",
    };
  }

  return {
    type: item.type ?? "tool",
    status: item.status ?? "completed",
  };
}

async function allowedTranscriptPath(transcriptPath, runner = "codex", roots) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    throw new Error("Stop input is missing transcript_path");
  }
  const candidate = await realpath(transcriptPath);
  const allowedRoots = roots ?? (runner === "claude"
    ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")]
    : [
        path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"),
        path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "archived_sessions"),
      ]);
  if (!allowedRoots.length) throw new Error(`no transcript roots are known for the ${runner} runtime`);

  for (const root of allowedRoots) {
    if (typeof root !== "string" || !root) continue;
    try {
      const resolvedRoot = await realpath(root);
      if (candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`)) return candidate;
    } catch {
      // A missing optional transcript root cannot contain the candidate.
    }
  }
  throw new Error(`transcript_path is outside the ${runner} transcript directories`);
}

async function codexTranscriptEvidence(input) {
  const transcriptPath = await allowedTranscriptPath(input.transcript_path, "codex");
  const current = [];
  const previous = [];
  const tools = [];
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const turnId = recordTurnId(record);
    const payload = record?.payload;

    if (
      record?.type === "response_item" &&
      payload?.type === "message" &&
      (payload.role === "user" || payload.role === "assistant")
    ) {
      const text = messageText(payload);
      if (!text || isInjectedContext(text)) continue;
      const destination = turnId === input.turn_id ? current : previous;
      destination.push({ role: payload.role, text });
      if (destination === previous && previous.length > 30) previous.shift();
      continue;
    }

    if (turnId === input.turn_id && payload?.type === "item_completed") {
      const summary = summarizeToolItem(payload.item);
      if (summary) tools.push(summary);
    }
  }

  const currentMessages = boundMessages(current, 30, 42_000);
  const recentContext = boundMessages(previous, 12, 24_000);
  const currentUserMessages = currentMessages.filter((item) => item.role === "user");

  return {
    recent_context: recentContext,
    initial_user_request: currentUserMessages[0]?.text ?? null,
    continuation_prompts: currentUserMessages.slice(1).map((item) => item.text),
    current_turn_messages: currentMessages,
    tool_events: tools.slice(-50),
    assistant_stop_candidate: compactText(input.last_assistant_message ?? "", 12_000),
  };
}

function claudeMessage(record) {
  const role = record?.message?.role;
  if ((record?.type !== "user" && record?.type !== "assistant") || !["user", "assistant"].includes(role)) {
    return null;
  }

  if (typeof record.message.content === "string") {
    return {
      role,
      text: record.message.content,
      genuineUser:
        role === "user" &&
        record.origin?.kind !== "task-notification" &&
        record.promptSource !== "system" &&
        record.isMeta !== true,
    };
  }
  if (!Array.isArray(record.message.content)) return null;

  const text = record.message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (!text) return null;
  return {
    role,
    text,
    genuineUser:
      role === "user" &&
      record.origin?.kind !== "task-notification" &&
      record.promptSource !== "system" &&
      record.isMeta !== true,
  };
}

function claudeToolEvents(record) {
  if (!Array.isArray(record?.message?.content)) return [];
  const events = [];
  for (const part of record.message.content) {
    if (part?.type === "tool_use") {
      events.push({ type: compactText(part.name ?? "tool", 120), status: "requested" });
    } else if (part?.type === "tool_result") {
      events.push({ type: "tool_result", status: part.is_error ? "failed" : "completed" });
    }
  }
  return events;
}

function stopCandidateText(input) {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  return messageText(input.last_assistant_message);
}

async function claudeTranscriptEvidence(input, options = {}) {
  const transcriptPath = options.transcriptPath ?? await allowedTranscriptPath(input.transcript_path, "claude");
  const records = [];
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore incomplete or non-JSON transcript lines.
    }
  }

  // The current turn starts at the last genuine user message. A host that
  // re-prompts with plain user messages (ghost's Claude Code runtime) supplies
  // the owner prompt so those continuations stay inside the turn.
  const ownerPrompt = typeof options.ownerPrompt === "string" ? options.ownerPrompt.trim() : null;
  let turnStart = -1;
  for (const matchOwner of ownerPrompt ? [true, false] : [false]) {
    for (let index = records.length - 1; index >= 0 && turnStart < 0; index -= 1) {
      const message = claudeMessage(records[index]);
      if (!message?.genuineUser) continue;
      if (matchOwner && message.text.trim() !== ownerPrompt) continue;
      turnStart = index;
    }
    if (turnStart >= 0) break;
  }

  const previous = [];
  const current = [];
  const tools = [];
  records.forEach((record, index) => {
    const message = claudeMessage(record);
    if (message && !isInjectedContext(message.text)) {
      (index >= turnStart && turnStart >= 0 ? current : previous).push(message);
    }
    if (index >= turnStart && turnStart >= 0) tools.push(...claudeToolEvents(record));
  });

  const currentMessages = boundMessages(current, 30, 42_000);
  const recentContext = boundMessages(previous, 12, 24_000);
  const currentUserMessages = currentMessages.filter((item) => item.role === "user");
  return {
    recent_context: recentContext,
    initial_user_request: currentUserMessages[0]?.text ?? null,
    continuation_prompts: currentUserMessages.slice(1).map((item) => item.text),
    current_turn_messages: currentMessages,
    tool_events: tools.slice(-50),
    assistant_stop_candidate: compactText(stopCandidateText(input), 12_000),
    background_activity: {
      tasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : 0,
      scheduled_jobs: Array.isArray(input.session_crons) ? input.session_crons.length : 0,
    },
  };
}

// Pi session files are trees: every entry carries id/parentId and the live
// conversation is the chain from the last written entry back to the root.
function piActiveBranch(records) {
  const byId = new Map();
  let leaf = null;
  for (const record of records) {
    if (typeof record?.id !== "string") continue;
    byId.set(record.id, record);
    leaf = record;
  }
  if (!leaf) return records;
  const branch = [];
  const seen = new Set();
  for (let cursor = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : null) {
    seen.add(cursor.id);
    branch.push(cursor);
  }
  return branch.reverse();
}

async function piTranscriptEvidence(input, transcriptPath) {
  const records = [];
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore incomplete or non-JSON transcript lines.
    }
  }

  // One timeline of owner prompts, hook continuations, assistant passes and tool events.
  const timeline = [];
  for (const entry of piActiveBranch(records)) {
    if (entry?.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message;
      if (message.role === "user") {
        const text = messageText(message);
        if (text) timeline.push({ kind: "message", role: "user", text, owner: true });
      } else if (message.role === "assistant") {
        const text = messageText(message);
        if (text) timeline.push({ kind: "message", role: "assistant", text });
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type === "toolCall") {
            timeline.push({ kind: "tool", event: { type: compactText(part.name ?? "tool", 120), status: "requested" } });
          }
        }
      } else if (message.role === "toolResult") {
        timeline.push({ kind: "tool", event: { type: "tool_result", status: message.isError ? "failed" : "completed" } });
      }
    } else if (
      entry?.type === "custom_message" &&
      entry.customType === "session-stop-continuation" &&
      typeof entry.content === "string" &&
      entry.content
    ) {
      timeline.push({ kind: "message", role: "user", text: entry.content, owner: false });
    }
  }

  const ownerPrompt = typeof input.owner_prompt === "string" ? input.owner_prompt.trim() : "";
  let turnStart = -1;
  for (const matchOwner of ownerPrompt ? [true, false] : [false]) {
    for (let index = timeline.length - 1; index >= 0 && turnStart < 0; index -= 1) {
      const item = timeline[index];
      if (item.kind !== "message" || !item.owner) continue;
      if (matchOwner && item.text.trim() !== ownerPrompt) continue;
      turnStart = index;
    }
    if (turnStart >= 0) break;
  }

  const previous = [];
  const current = [];
  const tools = [];
  timeline.forEach((item, index) => {
    const inTurn = turnStart >= 0 && index >= turnStart;
    if (item.kind === "message") (inTurn ? current : previous).push({ role: item.role, text: item.text });
    else if (inTurn) tools.push(item.event);
  });

  const currentMessages = boundMessages(current, 30, 42_000);
  const recentContext = boundMessages(previous, 12, 24_000);
  const currentUserMessages = currentMessages.filter((item) => item.role === "user");
  return {
    recent_context: recentContext,
    initial_user_request: currentUserMessages[0]?.text ?? (ownerPrompt || null),
    continuation_prompts: currentUserMessages.slice(1).map((item) => item.text),
    current_turn_messages: currentMessages,
    tool_events: tools.slice(-50),
    assistant_stop_candidate: compactText(stopCandidateText(input), 12_000),
    ghost_runtime: input.runtime ?? null,
  };
}

function ghostAssistantText(input) {
  const direct = messageText(input.last_assistant_message);
  if (direct) return direct;
  if (!Array.isArray(input.messages)) return "";
  return input.messages
    .filter((message) => message?.role === "assistant")
    .map((message) => messageText(message))
    .filter(Boolean)
    .join("\n");
}

function ghostPayloadEvidence(input) {
  const ownerPrompt = compactText(input.owner_prompt ?? "", 24_000);
  if (!ownerPrompt) throw new Error("Ghost stop input is missing owner_prompt");
  const assistant = compactText(ghostAssistantText(input), 12_000);
  return {
    recent_context: [],
    initial_user_request: ownerPrompt,
    continuation_prompts: [],
    current_turn_messages: [
      { role: "user", text: ownerPrompt },
      ...(assistant ? [{ role: "assistant", text: assistant }] : []),
    ],
    tool_events: [],
    assistant_stop_candidate: assistant,
    ghost_runtime: input.runtime ?? null,
  };
}

// Ghost hands over its runtime's native transcript when one exists: the Pi
// session file (OMP conversations) or the Claude Code SDK session file
// (Claude Code conversations). Without one, only the current pass is known.
async function ghostTranscriptEvidence(input) {
  if (typeof input.owner_prompt !== "string" || !input.owner_prompt.trim()) {
    throw new Error("Ghost stop input is missing owner_prompt");
  }
  if (typeof input.transcript_path !== "string" || !input.transcript_path) {
    return ghostPayloadEvidence(input);
  }
  if (input.conversation_runtime === "claude-code") {
    const transcriptPath = await allowedTranscriptPath(input.transcript_path, "claude");
    const evidence = await claudeTranscriptEvidence(input, { transcriptPath, ownerPrompt: input.owner_prompt });
    delete evidence.background_activity;
    return { ...evidence, ghost_runtime: input.runtime ?? null };
  }
  const transcriptPath = await allowedTranscriptPath(input.transcript_path, "ghost", [input.ghost_home]);
  return piTranscriptEvidence(input, transcriptPath);
}

async function transcriptEvidence(input, runner = "codex") {
  if (runner === "claude") return claudeTranscriptEvidence(input);
  if (runner === "ghost") return ghostTranscriptEvidence(input);
  return codexTranscriptEvidence(input);
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > MAX_STDIN_BYTES) {
      throw new Error("Stop hook input exceeds 1 MB");
    }
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stop hook input must be a JSON object");
  }
  return parsed;
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next) > MODEL_OUTPUT_LIMIT) {
    throw new Error("child process output exceeded 2 MB");
  }
  return next;
}

async function runProcess(command, args, input, timeoutMs, env = process.env, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendLimited(stdout, chunk.toString());
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendLimited(stderr, chunk.toString());
      } catch (error) {
        fail(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function runCodexModel({ model, prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-stop-review-"));
  const outputPath = path.join(directory, "result.txt");
  try {
    const codex = process.env.STOP_REVIEW_CODEX_BIN ||
      process.env.CODEX_STOP_REVIEW_CODEX_BIN ||
      "codex";
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "hooks",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      directory,
      "--model",
      model,
      "--config",
      'approval_policy="never"',
      "--output-last-message",
      outputPath,
      "-",
    ];
    const result = await runProcess(codex, args, prompt, timeoutMs);
    if (result.code !== 0) {
      const detail = processFailureDetail(result);
      throw new Error(`codex exec exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runClaudeModel({ model, prompt, timeoutMs }) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-stop-review-"));
  try {
    const claude = process.env.STOP_REVIEW_CLAUDE_BIN ||
      process.env.CODEX_STOP_REVIEW_CLAUDE_BIN ||
      "claude";
    // No tools and no --json-schema: a plain-text verdict completes in one turn,
    // whereas the StructuredOutput tool call was fumbled often enough to exhaust
    // --max-turns.
    const args = [
      "--print",
      "--safe-mode",
      "--tools",
      "",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--model",
      model,
      "--output-format",
      "json",
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const result = await runProcess(claude, args, prompt, timeoutMs, env, directory);
    if (result.code !== 0) {
      const detail = processFailureDetail(result);
      throw new Error(`claude exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    let parsed;
    for (const line of result.stdout.trim().split("\n").reverse()) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        // Version managers may emit a status line before Claude's JSON result.
      }
    }
    if (!parsed) throw new Error("claude returned invalid JSON");
    if (parsed.is_error) {
      throw new Error(`claude reported an error: ${compactText(String(parsed.result ?? ""), 500)}`);
    }
    if (typeof parsed.result !== "string") throw new Error("claude returned no result text");
    return parsed.result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runGhostModel({ prompt, timeoutMs, ghostHome }) {
  if (typeof ghostHome !== "string" || !ghostHome) {
    throw new Error("Ghost stop input is missing ghost_home");
  }
  const ghostd = process.env.STOP_REVIEW_GHOST_BIN ||
    process.env.CODEX_STOP_REVIEW_GHOST_BIN ||
    "ghostd";
  const result = await runProcess(
    ghostd,
    ["hook-smol-complete"],
    JSON.stringify({ ghost_home: ghostHome, prompt }),
    timeoutMs,
  );
  if (result.code !== 0) {
    const detail = processFailureDetail(result);
    throw new Error(`ghostd exited ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  const envelope = JSON.parse(result.stdout);
  if (typeof envelope?.text !== "string") throw new Error("ghostd returned no completion text");
  return envelope.text;
}

async function runReviewModel(options) {
  if (options.provider === "claude") return runClaudeModel(options);
  if (options.provider === "ghost") return runGhostModel(options);
  return runCodexModel(options);
}

function parseReviewVerdict(text) {
  const parsed = REVIEW_VERDICT_SCHEMA.safeParse(String(text ?? "").trim());
  if (!parsed.success) {
    throw new Error("Reviewer output must be exactly CONTINUE, CONSULT, or STOP");
  }
  return parsed.data;
}

function hookOutputForVerdict(verdict) {
  if (verdict === "CONTINUE") return { decision: "block", reason: "Please continue." };
  if (verdict === "CONSULT") {
    return { decision: "block", reason: "Please consult the advisor, then continue." };
  }
  return {};
}

// Prompts the host injected on behalf of this hook. Claude Code records them as
// "Stop hook feedback: ..." meta user messages and Codex as <hook_prompt ...>
// user messages; ghost's transcripts hold nothing but hook continuations
// between owner prompts, so every one of them counts.
function countHookContinuations(prompts, runner = "codex") {
  if (!Array.isArray(prompts)) return 0;
  if (runner === "ghost") return prompts.length;
  return prompts.filter((text) =>
    typeof text === "string" && /^\s*(?:Stop hook feedback\b|<hook_prompt\b)/.test(text),
  ).length;
}

async function recordReviewAudit(input, runner, verdict, error) {
  const auditPath = process.env.STOP_REVIEW_AUDIT_LOG;
  if (!auditPath) return;
  const entry = {
    timestamp: new Date().toISOString(),
    runner,
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    cwd: typeof input?.cwd === "string" ? input.cwd : null,
    verdict: error ? "ERROR" : verdict,
    rationale: error
      ? compactText(String(error), 2_000)
      : hookOutputForVerdict(verdict).reason ?? "",
  };
  try {
    await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging is best-effort and must never change the hook decision.
  }
}

async function handleStop(input, runner = "codex") {
  const runtime = RUNTIMES[runner];
  if (!runtime) throw new Error(`Unsupported stop-review runtime: ${runner}`);
  if (runner === "codex" && (typeof input.turn_id !== "string" || !input.turn_id)) {
    throw new Error("Stop input is missing turn_id");
  }
  if (typeof input.session_id !== "string" || !input.session_id) {
    throw new Error("Stop input is missing session_id");
  }
  const lastAssistantMessage = compactText(stopCandidateText(input), 12_000);
  if (!lastAssistantMessage) return {};

  let verdict;
  try {
    // The transcript is used only to enforce the continuation cap. Its content
    // is never supplied to the reviewer.
    if (typeof input.transcript_path === "string" && input.transcript_path) {
      const evidence = await transcriptEvidence(input, runner);
      const continuations = countHookContinuations(evidence.continuation_prompts, runner);
      if (continuations >= CONTINUATION_CAP) {
        return {
          systemMessage: `Stop review: continuation cap (${CONTINUATION_CAP}) reached for this turn; accepting the stop.`,
        };
      }
    }

    verdict = parseReviewVerdict(
      await runReviewModel({
        ...runtime.reviewer,
        model: runner === "codex"
          ? process.env.STOP_REVIEW_CODEX_MODEL || runtime.reviewer.model
          : runner === "claude"
            ? process.env.STOP_REVIEW_CLAUDE_MODEL || runtime.reviewer.model
            : undefined,
        prompt: `${REVIEW_PROMPT}\n\n${JSON.stringify({ last_assistant_message: lastAssistantMessage })}`,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        ghostHome: runner === "ghost" ? input.ghost_home : undefined,
      }),
    );
  } catch (error) {
    await recordReviewAudit(input, runner, undefined, error.message);
    return { systemMessage: `Stop review was skipped: ${compactText(error.message, 500)}` };
  }

  await recordReviewAudit(input, runner, verdict);
  return hookOutputForVerdict(verdict);
}

async function main() {
  try {
    const runner = process.argv[2] || "codex";
    const input = await readStdin();
    const output = await handleStop(input, runner);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `Stop review failed open: ${compactText(error.message, 500)}` })}\n`,
    );
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) await main();

export {
  CONTINUATION_CAP,
  REVIEW_PROMPT,
  REVIEW_VERDICT_SCHEMA,
  countHookContinuations,
  handleStop,
  hookOutputForVerdict,
  parseReviewVerdict,
  runClaudeModel,
  runCodexModel,
  transcriptEvidence,
};
