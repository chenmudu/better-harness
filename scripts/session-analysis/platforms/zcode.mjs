#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SessionAnalyzer } from "../analyzer.mjs";
import { parseArgs, parseBooleanFlag } from "../cli.mjs";
import { expandHome, normalizeWorkspace } from "../paths.mjs";
import { privacySafeUserInputText, sanitizePrivateReviewText } from "../privacy-safe-text.mjs";
import {
  bindSessionWorkspaceCwds,
  emitProviderResult,
  markSessionReadCoverage,
  runProviderAnalysis,
  runProviderCommand,
  workspaceMatchScopeFromOptions,
} from "../provider-runner.mjs";
import { parseResultFacts } from "../result-facts.mjs";
import { mergeTimeRange, normalizeCliDate, normalizeTimestamp, timestampMillis, withinTimeRange } from "../time.mjs";
import { WORKSPACE_CWD_MATCH, classifyWorkspaceCwd } from "../workspace-match.mjs";

export const ZCODE_ADAPTER_VERSION = "zcode-v1";

const SESSION_KIND = "zcode-sqlite";
const DEFAULT_ZCODE_HOME = "~/.zcode";
const DEFAULT_DB_SEGMENTS = ["cli", "db", "db.sqlite"];
const PREVIEW_CHARS = 240;
const RESULT_FACT_LIMIT = 8_192;
const COMPACTION_TRIGGER_WINDOW_MS = 60_000;

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function bool(value) {
  return typeof value === "boolean" ? value : null;
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "string") text += block;
    else if (asRecord(block)?.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

function absolutePathFlavor(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)) return "win32";
  if (value.startsWith("/")) return "posix";
  return null;
}

function pathApiFor(value) {
  return absolutePathFlavor(value) === "win32" ? path.win32 : path.posix;
}

function isWithinWorkspace(candidate, workspace) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const api = pathApiFor(candidate);
  if (pathApiFor(workspace) !== api) return false;
  const normalizedCandidate = api.normalize(candidate);
  const normalizedWorkspace = api.normalize(workspace);
  const relative = api.relative(normalizedWorkspace, normalizedCandidate);
  return relative === "" || (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`));
}

function matchesWorkspace(candidate, scope) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (scope._workspaceMatchScope) {
    const match = classifyWorkspaceCwd(candidate, scope._workspaceMatchScope);
    return match === WORKSPACE_CWD_MATCH.DIRECT || match === WORKSPACE_CWD_MATCH.ROOT_CANDIDATE;
  }
  return isWithinWorkspace(candidate, scope.workspace);
}

function warning(code, message, details = {}) {
  return { code, message, ...details };
}

function sourceRef(dbPath, sessionId) {
  return {
    kind: SESSION_KIND,
    role: "session-store",
    path: dbPath,
    sessionId,
    table: "session",
    rowId: sessionId,
  };
}

function evidenceRef(ref, type, seq, table, rowId) {
  return {
    kind: SESSION_KIND,
    path: ref.path,
    line: null,
    seq,
    type,
    ...(table ? { table } : {}),
    ...(rowId !== undefined && rowId !== null ? { rowId: String(rowId) } : {}),
  };
}

function tableExists(db, name) {
  const row = db.prepare("select 1 as hit from sqlite_master where type = 'table' and name = ?").get(name);
  return row !== undefined;
}

function selectAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    return { error };
  }
}

async function openDatabase(dbPath) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (cause) {
    const error = new Error("node:sqlite is unavailable");
    error.code = "ZCODE_SQLITE_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

function chunked(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function rowTime(value) {
  return normalizeTimestamp(value);
}

function earliest(...values) {
  let selected = null;
  for (const value of values) {
    const normalized = normalizeTimestamp(value);
    if (
      normalized !== null
      && (selected === null || (timestampMillis(normalized) ?? Number.POSITIVE_INFINITY) < (timestampMillis(selected) ?? Number.POSITIVE_INFINITY))
    ) {
      selected = normalized;
    }
  }
  return selected;
}

function latest(...values) {
  let selected = null;
  for (const value of values) {
    const normalized = normalizeTimestamp(value);
    if (normalized !== null && (selected === null || (timestampMillis(normalized) ?? -Infinity) > (timestampMillis(selected) ?? -Infinity))) {
      selected = normalized;
    }
  }
  return selected;
}

function loadSessionBounds(db, ids) {
  const bounds = new Map();
  if (ids.length === 0) return bounds;
  for (const chunk of chunked(ids, 400)) {
    const marks = placeholders(chunk.length);
    const sources = [];
    if (tableExists(db, "message")) {
      sources.push(`select session_id, time_created as at from message where session_id in (${marks})`);
    }
    if (tableExists(db, "part")) {
      sources.push(`select session_id, time_created as at from part where session_id in (${marks})`);
    }
    if (tableExists(db, "turn_usage")) {
      sources.push(`select session_id, started_at as at from turn_usage where session_id in (${marks}) and started_at is not null`);
      sources.push(`select session_id, completed_at as at from turn_usage where session_id in (${marks}) and completed_at is not null`);
    }
    if (sources.length === 0) continue;
    const union = sources.join(" union all ");
    const params = sources.flatMap(() => chunk);
    const rows = selectAll(db, `select session_id, min(at) as first, max(at) as last from (${union}) group by session_id`, params);
    if (rows.error) continue;
    for (const row of rows) {
      bounds.set(row.session_id, { first: row.first, last: row.last });
    }
  }
  return bounds;
}

function sessionSummary(row, scope, dbPath, bounds) {
  const sessionId = str(row.id);
  if (!sessionId) return null;
  const directory = str(row.directory);
  if (!matchesWorkspace(directory, scope)) return null;
  const bound = bounds.get(sessionId);
  const firstSeen = earliest(row.time_created, bound?.first);
  const lastSeen = latest(row.time_updated, bound?.last);
  return bindSessionWorkspaceCwds({
    platform: "zcode",
    sessionId,
    workspace: scope.workspace,
    firstSeen,
    lastSeen,
    sourceKinds: [SESSION_KIND],
    sourceRefs: [sourceRef(dbPath, sessionId)],
    cwd: directory,
    title: str(row.title),
    parentSessionId: str(row.parent_id),
    isSubagent: str(row.task_type) === "subagent_child" || str(row.parent_id) !== null,
    archived: num(row.time_archived) !== null,
    taskType: str(row.task_type),
    coverage: directory === null ? "partial" : "full",
  }, [directory].filter(Boolean));
}

function turnOrder(turns, stepStarts, sessionMessages) {
  const order = new Map();
  const seen = [];
  const register = (value) => {
    const turnId = str(value);
    if (!turnId || order.has(turnId)) return;
    order.set(turnId, seen.length + 1);
    seen.push(turnId);
  };
  const starts = new Map();
  for (const turn of turns) {
    if (turn.started_at !== null && turn.started_at !== undefined) starts.set(turn.turn_id, turn.started_at);
  }
  for (const [turnId, at] of stepStarts) {
    if (!starts.has(turnId) || (num(at) ?? Number.POSITIVE_INFINITY) < starts.get(turnId)) starts.set(turnId, at);
  }
  const ids = [...new Set([
    ...turns.map((turn) => turn.turn_id),
    ...stepStarts.keys(),
    ...sessionMessages.map((message) => message.turnId).filter(Boolean),
  ])];
  ids.sort((left, right) => {
    const leftAt = num(starts.get(left)) ?? Number.POSITIVE_INFINITY;
    const rightAt = num(starts.get(right)) ?? Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return String(left).localeCompare(String(right));
  });
  ids.forEach(register);
  return order;
}

function executionEvent(base, type, category, fields = {}) {
  return { ...base, type, category, ...fields };
}

function inferFilePath(toolName, input) {
  if (!asRecord(input) || !/(?:read|edit|write|file|notebook|delete|move|copy)/iu.test(String(toolName ?? ""))) return null;
  return str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? str(input.notebook_path);
}

function inferCommandText(toolName, input) {
  if (!asRecord(input) || !/(?:bash|shell|exec|terminal|run|command)/iu.test(String(toolName ?? ""))) return null;
  return str(input.command) ?? str(input.cmd) ?? str(input.script);
}

function toolState(part) {
  const state = asRecord(part.state);
  return state ?? {};
}

function toolStatus(part) {
  return str(toolState(part).status);
}

function toolSuccess(status) {
  if (status === null) return null;
  if (["completed", "success", "succeeded", "done"].includes(status)) return true;
  if (["error", "failed", "failure", "cancelled", "canceled", "aborted", "rejected"].includes(status)) return false;
  return null;
}

function toolOutput(part) {
  const output = toolState(part).output;
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function toolError(part) {
  const state = toolState(part);
  const error = state.error;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return null;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizedUsage(row) {
  const input = nonnegative(row.input_tokens);
  const output = nonnegative(row.output_tokens);
  const cacheRead = nonnegative(row.cache_read_input_tokens);
  const cacheCreation = nonnegative(row.cache_creation_input_tokens);
  const reasoning = nonnegative(row.reasoning_tokens);
  const providerTotal = nonnegative(row.provider_total_tokens);
  const computedTotal = nonnegative(row.computed_total_tokens);
  const uncached = input === null
    ? null
    : Math.max(0, input - (cacheRead ?? 0) - (cacheCreation ?? 0));
  const promptSide = uncached === null ? null : uncached + (cacheRead ?? 0) + (cacheCreation ?? 0);
  const derivedTotal = promptSide === null || output === null ? null : promptSide + output;
  const total = providerTotal ?? computedTotal ?? derivedTotal;
  const usage = {};
  if (uncached !== null) usage.inputTokens = uncached;
  if (output !== null) usage.outputTokens = output;
  if (cacheRead !== null) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreation !== null) usage.cacheCreationInputTokens = cacheCreation;
  if (reasoning !== null) usage.reasoningOutputTokens = reasoning;
  if (total !== null) usage.totalTokens = total;
  if (Object.keys(usage).length > 0) usage.cacheAccountingMode = "separate-input-lane";
  return {
    usage: Object.keys(usage).length > 0 ? usage : null,
    totalDerived: providerTotal !== null && derivedTotal !== null && providerTotal !== derivedTotal,
  };
}

function compactionKind(trigger, auto) {
  if (trigger === "manual") return "manual";
  if (trigger === "auto") return "auto";
  if (auto === true) return "auto";
  return "unknown";
}

function compactionGroupKey(data, fallback) {
  const boundary = asRecord(data.compactBoundary);
  return str(data.operationId) ?? str(data.boundaryId) ?? (boundary ? str(boundary.boundaryId) : null) ?? fallback;
}

function compactMerge(target, data, at) {
  const boundary = asRecord(data.compactBoundary);
  target.at = earliest(target.at, at);
  target.trigger ??= str(data.trigger);
  target.auto ??= bool(data.auto);
  target.status ??= str(data.status) ?? str(data.timelineStatus);
  target.phase ??= str(data.phase);
  target.reason ??= str(data.compactReason);
  target.attempt ??= num(data.attempt);
  target.maxAttempts ??= num(data.maxAttempts);
  target.summaryRef ??= str(data.summaryMessageId);
  target.beforeTokens ??= num(data.preCompactTokenCount);
  target.afterTokens ??= num(data.postCompactTokenCount);
  target.trueAfterTokens ??= num(data.truePostCompactTokenCount);
  target.boundaryTurnId ??= boundary ? str(boundary.turnId) : null;
  target.summarizedMessages ??= boundary ? num(boundary.summarizedMessageCount) : null;
  target.keptMessages ??= boundary ? num(boundary.keptMessageCount) : null;
  target.threshold ??= boundary ? num(boundary.autoCompactThreshold) : null;
  target.trigger ??= boundary ? str(boundary.trigger) : null;
  target.phase ??= boundary ? str(boundary.phase) : null;
  target.reason ??= boundary ? str(boundary.compactReason) : null;
}

export class ZcodeSessionAnalyzer extends SessionAnalyzer {
  constructor() {
    super();
    this.sessionWarnings = [];
  }

  currentSessionId() {
    return null;
  }

  warnOnce(code, message, details = {}) {
    if (this.sessionWarnings.some((item) => item.code === code)) return;
    this.sessionWarnings.push(warning(code, message, details));
  }

  async resolveScope(options = {}) {
    const workspace = normalizeWorkspace(options.workspace);
    const zcodeHome = path.resolve(expandHome(
      options.home ?? options.zcodeHome ?? options["zcode-home"] ?? DEFAULT_ZCODE_HOME,
    ));
    const explicitDb = options.zcodeDb ?? options["zcode-db"];
    const zcodeDb = explicitDb
      ? path.resolve(expandHome(String(explicitDb)))
      : path.join(zcodeHome, ...DEFAULT_DB_SEGMENTS);
    const since = normalizeCliDate(options.since, false);
    const until = normalizeCliDate(options.until, true);
    return {
      platform: "zcode",
      workspace,
      zcodeHome,
      zcodeDb,
      since: since.label,
      sinceTime: since.time,
      until: until.label,
      untilTime: until.time,
      sessionId: options["session-id"] ?? options.sessionId ?? options._?.[0] ?? null,
      includeUserText: parseBooleanFlag(options["include-user-text"] ?? options.includeUserText ?? false),
      includeContent: parseBooleanFlag(options["include-content"] ?? options.includeContent ?? false),
      includeCommandText: parseBooleanFlag(options["include-command-text"] ?? options.includeCommandText ?? false),
      _workspaceMatchScope: workspaceMatchScopeFromOptions(options),
    };
  }

  async discoverSourceRoots(scope) {
    let exists = false;
    try {
      exists = (await stat(scope.zcodeDb)).isFile();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const warnings = exists ? [] : [
      warning("zcode-database-missing", `ZCode session database does not exist: ${scope.zcodeDb}`, { source: "zcode-sessions" }),
    ];
    return [{
      id: "zcode-sessions",
      kind: SESSION_KIND,
      role: "session-store",
      path: scope.zcodeDb,
      exists,
      enabled: true,
      optional: false,
      workspaceScoped: true,
      coverage: "primary",
      warnings,
    }];
  }

  async discoverSessions(scope, roots) {
    this.sessionWarnings = [];
    const root = roots.find((item) => item.kind === SESSION_KIND);
    if (!root?.exists) return [];
    let db;
    try {
      db = await openDatabase(scope.zcodeDb);
    } catch (error) {
      this.sessionWarnings.push(warning(
        error?.code === "ZCODE_SQLITE_UNAVAILABLE" ? "zcode-sqlite-unavailable" : "zcode-database-open-failed",
        error?.message ?? "cannot open ZCode session database",
        { source: "zcode-sessions" },
      ));
      return [];
    }
    try {
      if (!tableExists(db, "session")) {
        this.sessionWarnings.push(warning(
          "zcode-schema-incompatible",
          "ZCode session database has no session table",
          { source: "zcode-sessions" },
        ));
        return [];
      }
      if (!tableExists(db, "schema_migration")) {
        this.sessionWarnings.push(warning(
          "zcode-schema-version-missing",
          "ZCode session database has no schema_migration table",
          { source: "zcode-sessions" },
        ));
      }
      const rows = selectAll(db, "select * from session where time_deleted is null order by time_updated desc, id desc");
      if (rows.error) {
        this.sessionWarnings.push(warning("zcode-schema-incompatible", rows.error.message, { source: "zcode-sessions" }));
        return [];
      }
      const selected = scope.sessionId === null
        ? rows
        : rows.filter((row) => String(row.id) === String(scope.sessionId));
      const bounds = loadSessionBounds(db, selected.map((row) => String(row.id)).filter(Boolean));
      const sessions = [];
      let withoutWorkspace = 0;
      let outsideWindow = 0;
      for (const row of selected) {
        if (!str(row.directory)) {
          withoutWorkspace += 1;
          continue;
        }
        if (!matchesWorkspace(str(row.directory), scope)) continue;
        const session = sessionSummary(row, scope, scope.zcodeDb, bounds);
        if (!session) continue;
        if (!withinTimeRange(session.lastSeen ?? session.firstSeen, scope)) {
          outsideWindow += 1;
          continue;
        }
        sessions.push(session);
      }
      if (withoutWorkspace > 0) {
        this.sessionWarnings.push(warning(
          "zcode-session-without-workspace",
          `${withoutWorkspace} ZCode session(s) have no workspace directory`,
          { source: "zcode-sessions", count: withoutWorkspace },
        ));
      }
      if (outsideWindow > 0) {
        this.sessionWarnings.push(warning(
          "zcode-session-outside-window",
          `${outsideWindow} ZCode session(s) fall outside the requested time window`,
          { source: "zcode-sessions", count: outsideWindow },
        ));
      }
      return sessions;
    } finally {
      db.close();
    }
  }

  async readSession(session, scope, options = {}) {
    let db;
    try {
      db = await openDatabase(scope.zcodeDb);
    } catch (error) {
      this.sessionWarnings.push(warning(
        error?.code === "ZCODE_SQLITE_UNAVAILABLE" ? "zcode-sqlite-unavailable" : "zcode-database-open-failed",
        error?.message ?? "cannot open ZCode session database",
        { source: "zcode-sessions" },
      ));
      return markSessionReadCoverage([], { truncated: true });
    }
    try {
      const includeUserText = parseBooleanFlag(options.includeUserText ?? options["include-user-text"] ?? scope.includeUserText ?? false);
      const includeContent = parseBooleanFlag(options.includeContent ?? options["include-content"] ?? scope.includeContent ?? false);
      const includeCommandText = parseBooleanFlag(options.includeCommandText ?? options["include-command-text"] ?? scope.includeCommandText ?? false);
      const ref = sourceRef(scope.zcodeDb, session.sessionId);
      const draft = [];
      let truncated = false;
      const sessionRow = selectAll(db, "select * from session where id = ? limit 1", [session.sessionId]);
      const storedSession = Array.isArray(sessionRow) ? sessionRow[0] : null;
      const cwd = session.cwd ?? str(storedSession?.directory) ?? null;
      const base = {
        sessionId: session.sessionId,
        sourceKind: SESSION_KIND,
        planningScope: "workspace",
        cwd,
        isSubagent: session.isSubagent === true,
      };
      const push = (at, sequence, tier, event) => {
        draft.push({ at, sequence, tier, event });
      };

      if (storedSession) {
        push(
          rowTime(storedSession.time_created),
          0,
          0,
          executionEvent(base, "metadata.session", "metadata", {
            evidenceRef: evidenceRef(ref, "metadata.session", 0, "session", storedSession.id),
            summary: str(storedSession.title) ? `ZCode session: ${sanitizePrivateReviewText(storedSession.title) ?? "untitled"}` : "ZCode session",
            title: str(storedSession.title) ? sanitizePrivateReviewText(storedSession.title) : null,
            taskType: str(storedSession.task_type),
            parentSessionId: str(storedSession.parent_id),
            coverage: "full",
          }),
        );
      }

      for (const table of ["message", "part", "turn_usage", "model_usage", "tool_usage", "session_input"]) {
        if (!tableExists(db, table)) {
          this.warnOnce(
            `zcode-table-missing:${table}`,
            `ZCode session database has no ${table} table`,
            { source: "zcode-sessions", table },
          );
        }
      }
      const messages = tableExists(db, "message")
        ? selectAll(db, "select rowid as row_id, * from message where session_id = ? order by sequence asc, id asc", [session.sessionId])
        : [];
      if (messages.error) throw messages.error;
      const parts = tableExists(db, "part")
        ? selectAll(db, "select rowid as row_id, * from part where session_id = ? order by time_created asc, rowid asc", [session.sessionId])
        : [];
      if (parts.error) throw parts.error;
      const turns = tableExists(db, "turn_usage")
        ? selectAll(db, "select * from turn_usage where session_id = ? order by started_at asc, turn_id asc", [session.sessionId])
        : [];
      if (turns.error) throw turns.error;
      const usageRows = tableExists(db, "model_usage")
        ? selectAll(db, "select rowid as row_id, * from model_usage where session_id = ? order by started_at asc, attempt_index asc, id asc", [session.sessionId])
        : [];
      if (usageRows.error) throw usageRows.error;
      const toolRows = tableExists(db, "tool_usage")
        ? selectAll(db, "select * from tool_usage where session_id = ?", [session.sessionId])
        : [];
      if (toolRows.error) throw toolRows.error;
      const inputs = tableExists(db, "session_input")
        ? selectAll(db, "select * from session_input where session_id = ? and kind = 'compact' order by time_created asc, id asc", [session.sessionId])
        : [];
      if (inputs.error) throw inputs.error;

      const parsedMessages = messages.map((row) => {
        const data = parseJson(row.data);
        if (!data) {
          this.sessionWarnings.push(warning("zcode-malformed-row", `malformed message ${String(row.id)}`, { source: "zcode-sessions" }));
          truncated = true;
        }
        return {
          ...row,
          data: data ?? {},
          role: str(data?.role),
          turnId: str(asRecord(data?.anchor)?.turnId),
          origin: str(asRecord(data?.semantics)?.origin),
          kind: str(asRecord(data?.semantics)?.kind),
          uiVisibility: str(asRecord(data?.semantics)?.uiVisibility),
        };
      });
      const parsedParts = parts.map((row) => {
        const data = parseJson(row.data);
        if (!data) {
          this.sessionWarnings.push(warning("zcode-malformed-row", `malformed part ${String(row.id)}`, { source: "zcode-sessions" }));
          truncated = true;
        }
        return { ...row, data: data ?? {} };
      });

      const messageById = new Map(parsedMessages.map((message) => [message.id, message]));
      const partsByMessage = new Map();
      for (const part of parsedParts) {
        if (!part.message_id) continue;
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
      }
      const stepMessageIds = new Set(parsedParts
        .filter((part) => ["step-start", "step-finish"].includes(str(part.data.type)))
        .map((part) => part.message_id));
      const stepStarts = new Map();
      for (const part of parsedParts) {
        if (str(part.data.type) !== "step-start") continue;
        const message = messageById.get(part.message_id);
        const turnId = message?.turnId;
        if (!turnId) continue;
        const current = stepStarts.get(turnId);
        const at = num(part.time_created);
        if (current === undefined || (at !== null && at < current)) stepStarts.set(turnId, at);
      }
      const orderedTurns = turnOrder(turns, stepStarts, parsedMessages);
      const stepsByTurn = new Map();
      for (const message of [...parsedMessages].sort((left, right) => (num(left.sequence) ?? 0) - (num(right.sequence) ?? 0) || String(left.id).localeCompare(String(right.id)))) {
        if (message.role !== "assistant" || !stepMessageIds.has(message.id) || !message.turnId) continue;
        const steps = stepsByTurn.get(message.turnId) ?? [];
        steps.push(message);
        stepsByTurn.set(message.turnId, steps);
      }
      const stepIndexByMessage = new Map();
      for (const steps of stepsByTurn.values()) {
        steps.forEach((message, index) => stepIndexByMessage.set(message.id, index + 1));
      }
      const coordinates = (messageId) => {
        const message = messageId ? messageById.get(messageId) : null;
        const turnId = message?.turnId ?? null;
        return {
          ...(turnId ? { turnId, turn: orderedTurns.get(turnId) ?? null } : {}),
          ...(messageId && stepIndexByMessage.has(messageId) ? { step: stepIndexByMessage.get(messageId) } : {}),
        };
      };

      for (const turn of turns) {
        const turnIndex = orderedTurns.get(turn.turn_id) ?? null;
        const startedAt = rowTime(turn.started_at);
        const completedAt = rowTime(turn.completed_at);
        if (startedAt === null) continue;
        push(startedAt, 0, 1, executionEvent(base, "turn.start", "lifecycle", {
          ...(turnIndex ? { turn: turnIndex } : {}),
          evidenceRef: evidenceRef(ref, "turn.start", 0, "turn_usage", turn.turn_id),
          summary: turnIndex ? `turn ${turnIndex} started` : "turn started",
          status: str(turn.status),
          coverage: "full",
        }));
        if (completedAt !== null) {
          push(completedAt, 0, 6, executionEvent(base, "turn.end", "lifecycle", {
            ...(turnIndex ? { turn: turnIndex } : {}),
            evidenceRef: evidenceRef(ref, "turn.end", 0, "turn_usage", turn.turn_id),
            summary: str(turn.status) ? `turn ended: ${turn.status}` : "turn ended",
            status: str(turn.status),
            stepCount: stepsByTurn.get(turn.turn_id)?.length ?? 0,
            coverage: "full",
          }));
        }
      }

      for (const message of parsedMessages) {
        const at = rowTime(message.time_created);
        const coords = coordinates(message.id);
        const messageParts = partsByMessage.get(message.id) ?? [];
        const textParts = messageParts.filter((part) => str(part.data.type) === "text");
        const plainText = textParts
          .filter((part) => !str(asRecord(part.data.metadata)?.source))
          .map((part) => textFromContent(part.data.text ?? part.data.content))
          .join("");
        const injectedText = textParts
          .filter((part) => str(asRecord(part.data.metadata)?.source))
          .map((part) => textFromContent(part.data.text ?? part.data.content))
          .join("");
        const injectedSource = str(asRecord(message.data.metadata)?.source)
          ?? str(asRecord(message.data.metadata)?.runtimeMessage?.source)
          ?? null;
        const synthetic = messageParts.some((part) => bool(part.data.synthetic) === true);
        const isRealUser = message.role === "user"
          && message.origin === "real_user"
          && !injectedSource
          && !synthetic;
        if (message.role === "user" && plainText.length > 0 && isRealUser) {
          const event = executionEvent(base, "user", "user", {
            ...coords,
            evidenceRef: evidenceRef(ref, "user", 0, "message", message.id),
            summary: `user message (${plainText.length} chars)`,
            contentLength: plainText.length,
            userPrompt: true,
            coverage: "full",
          });
          if (includeUserText) {
            const safe = privacySafeUserInputText(plainText);
            if (safe) event.userText = safe;
          }
          if (includeContent) {
            const safe = sanitizePrivateReviewText(plainText);
            if (safe) event.content = safe;
          }
          push(at, num(message.sequence) ?? 0, 2, event);
        }
        const nonUserText = isRealUser ? injectedText : plainText + injectedText;
        if (message.role === "user" && nonUserText.length > 0) {
          const origin = message.origin ?? injectedSource ?? "runtime";
          push(at, num(message.sequence) ?? 0, 2, executionEvent(base, "metadata.injected_message", "metadata", {
            ...coords,
            evidenceRef: evidenceRef(ref, "metadata.injected_message", 0, "message", message.id),
            summary: `injected message (${nonUserText.length} chars)`,
            contentLength: nonUserText.length,
            origin,
            semanticKind: message.kind,
            coverage: "full",
          }));
        }

        for (const part of messageParts) {
          const partType = str(part.data.type) ?? "unknown";
          if (partType === "text") {
            if (message.role !== "assistant") continue;
            const partText = textFromContent(part.data.text ?? part.data.content);
            push(at, num(message.sequence) ?? 0, 3, executionEvent(base, "assistant", "assistant", {
              ...coords,
              evidenceRef: evidenceRef(ref, "assistant", 0, "part", part.id),
              summary: partText.length > 0 ? `assistant message (${partText.length} chars)` : "assistant",
              contentLength: partText.length,
              ...(partText.length > 0 ? { userVisibleAssistantMessage: true } : {}),
              ...(includeContent && partText ? { content: sanitizePrivateReviewText(partText) } : {}),
              coverage: "full",
            }));
          } else if (partType === "reasoning") {
            const reasoning = textFromContent(part.data.text);
            push(at, num(message.sequence) ?? 0, 3, executionEvent(base, "metadata.reasoning", "metadata", {
              ...coords,
              evidenceRef: evidenceRef(ref, "metadata.reasoning", 0, "part", part.id),
              summary: reasoning.length > 0 ? `reasoning (${reasoning.length} chars)` : "reasoning",
              contentLength: reasoning.length,
              ...(includeContent && reasoning ? { content: sanitizePrivateReviewText(reasoning) } : {}),
              coverage: "full",
            }));
          } else if (partType === "tool") {
            const callID = str(part.data.callID) ?? str(part.data.callId) ?? `zcode-tool-${message.id}-${part.id}`;
            const toolName = str(part.data.tool) ?? "unknown-tool";
            const state = toolState(part.data);
            const status = toolStatus(part.data);
            const startedAt = rowTime(asRecord(state.time)?.start) ?? at;
            const completedAt = rowTime(asRecord(state.time)?.end);
            const input = asRecord(state.input);
            const filePath = inferFilePath(toolName, input);
            const commandText = inferCommandText(toolName, input);
            const toolUsage = toolRows.find((row) => String(row.tool_call_id ?? "") === callID) ?? null;
            const call = executionEvent(base, "tool.call", "tool", {
              ...coords,
              evidenceRef: evidenceRef(ref, "tool.call", 0, "part", part.id),
              summary: `${toolName} request`,
              lifecyclePhase: "request",
              toolName,
              toolInvocationId: callID,
              ...(filePath ? { filePath } : {}),
              ...(includeCommandText && commandText ? { commandText } : {}),
              ...(toolUsage?.approval_status ? { permissionDecision: str(toolUsage.approval_status) } : {}),
              coverage: toolUsage ? "full" : "partial",
            });
            push(startedAt, num(message.sequence) ?? 0, 4, call);
            if (["completed", "success", "succeeded", "done", "error", "failed", "failure", "cancelled", "canceled", "aborted", "rejected"].includes(status ?? "")) {
              const success = toolSuccess(status);
              const output = toolOutput(part.data);
              const resultFacts = parseResultFacts(output.slice(-RESULT_FACT_LIMIT));
              const errorText = toolError(part.data) ?? str(toolUsage?.error_message);
              const result = executionEvent(base, "tool.result", "tool", {
                ...coords,
                evidenceRef: evidenceRef(ref, "tool.result", 0, "part", part.id),
                summary: success === false ? "tool result failed" : "tool result",
                lifecyclePhase: "result",
                toolName,
                toolInvocationId: callID,
                ...(success !== null ? { success, hasError: success === false } : {}),
                ...(output ? { outputBytes: Buffer.byteLength(output, "utf8") } : {}),
                ...(resultFacts ? { resultFacts } : {}),
                ...(errorText ? { error: sanitizePrivateReviewText(errorText, { limit: PREVIEW_CHARS }) } : {}),
                ...(toolUsage ? { durationMs: num(toolUsage.duration_ms) } : {}),
                coverage: toolUsage ? "full" : "partial",
              });
              push(completedAt ?? at, num(message.sequence) ?? 0, 5, result);
            } else if (status === null) {
              this.sessionWarnings.push(warning("zcode-tool-status-missing", `tool ${toolName} has no status`, { source: "zcode-sessions" }));
            }
          } else if (["step-start", "step-finish", "file", "timeline", "compaction"].includes(partType)) {
            continue;
          } else {
            push(at, num(message.sequence) ?? 0, 3, executionEvent(base, "metadata.zcode_part", "metadata", {
              ...coords,
              evidenceRef: evidenceRef(ref, "metadata.zcode_part", 0, "part", part.id),
              summary: `part type ${partType}`,
              partType,
              coverage: "full",
            }));
          }
        }
      }

      for (const row of usageRows) {
        const at = rowTime(row.started_at) ?? rowTime(row.completed_at);
        const normalized = normalizedUsage(row);
        const logicalId = str(row.logical_request_id) ?? str(row.id) ?? "unknown-request";
        const attempt = nonnegative(row.attempt_index) ?? 0;
        const coords = coordinates(str(row.assistant_message_id));
        const model = [str(row.provider_id), str(row.model_id)].filter(Boolean).join("/") || null;
        if (normalized.usage === null) {
          push(at, 0, 7, executionEvent(base, "metadata.model_request", "model", {
            ...coords,
            evidenceRef: evidenceRef(ref, "metadata.model_request", 0, "model_usage", row.id),
            summary: "model request without observed usage",
            requestId: logicalId,
            attemptIndex: attempt,
            status: str(row.status),
            finishReason: str(row.finish_reason),
            ...(model ? { model } : {}),
            coverage: "partial",
          }));
          continue;
        }
        push(at, 0, 7, executionEvent(base, "model.response.completed", "model", {
          ...coords,
          evidenceRef: evidenceRef(ref, "model.response.completed", 0, "model_usage", row.id),
          summary: model ? `${model} response completed` : "ZCode model response completed",
          responseId: `${logicalId}@${attempt}`,
          requestId: logicalId,
          attemptIndex: attempt,
          ...(model ? { model } : {}),
          modelUsage: normalized.usage,
          usageFieldsObserved: true,
          status: str(row.status),
          finishReason: str(row.finish_reason),
          querySource: str(row.query_source),
          totalDerived: normalized.totalDerived,
          coverage: str(row.status) === "completed" ? "full" : "partial",
        }));
      }

      const compactionGroups = new Map();
      for (const part of parsedParts) {
        const type = str(part.data.type);
        const timelineType = str(part.data.timelineType);
        if (type !== "compaction" && !(type === "timeline" && timelineType === "context_compaction")) continue;
        const key = compactionGroupKey(part.data, part.id);
        const group = compactionGroups.get(key) ?? {
          key,
          at: null,
          trigger: null,
          auto: null,
          status: null,
          phase: null,
          reason: null,
          attempt: null,
          maxAttempts: null,
          summaryRef: null,
          beforeTokens: null,
          afterTokens: null,
          trueAfterTokens: null,
          boundaryTurnId: null,
          summarizedMessages: null,
          keptMessages: null,
          threshold: null,
          sourceRow: null,
        };
        compactMerge(group, part.data, part.time_created);
        group.sourceRow ??= part;
        compactionGroups.set(key, group);
      }
      for (const group of compactionGroups.values()) {
        const nearInput = inputs.find((input) => Math.abs((num(input.time_created) ?? 0) - (num(group.at) ?? 0)) <= COMPACTION_TRIGGER_WINDOW_MS);
        const trigger = group.trigger ?? (nearInput ? "manual" : null);
        const kind = compactionKind(trigger, group.auto);
        const triggerSource = group.trigger ? "part" : nearInput ? "session_input" : "missing";
        const before = group.beforeTokens;
        const after = group.afterTokens;
        const trueAfter = group.trueAfterTokens;
        const afterValue = trueAfter ?? after;
        const released = before === null || afterValue === null ? null : before - afterValue;
        const coverage = before !== null && afterValue !== null ? "full" : before !== null || after !== null || trueAfter !== null ? "partial" : "missing";
        const turnIndex = group.boundaryTurnId ? orderedTurns.get(group.boundaryTurnId) ?? null : null;
        push(group.at, 0, 8, executionEvent(base, "compaction.summary", "lifecycle", {
          ...(group.boundaryTurnId ? { turnId: group.boundaryTurnId } : {}),
          ...(turnIndex ? { turn: turnIndex } : {}),
          evidenceRef: evidenceRef(ref, "compaction.summary", 0, "part", group.sourceRow?.id),
          summary: `context compaction (${kind})`,
          compactionId: group.key,
          kind,
          trigger,
          triggerSource,
          status: group.status,
          phase: group.phase,
          reason: group.reason,
          attempt: group.attempt,
          maxAttempts: group.maxAttempts,
          beforeTokens: before,
          afterTokens: after,
          trueAfterTokens: trueAfter,
          releasedTokens: released,
          summaryRef: group.summaryRef,
          summarizedMessages: group.summarizedMessages,
          keptMessages: group.keptMessages,
          autoCompactThreshold: group.threshold,
          coverage,
        }));
        if (coverage === "missing") {
          this.sessionWarnings.push(warning("zcode-compaction-tokens-missing", `compaction ${group.key} has no token counts`, { source: "zcode-sessions" }));
        }
      }

      for (const input of inputs) {
        const payload = parseJson(input.payload);
        const text = str(payload?.text);
        push(rowTime(input.time_created), 0, 8, executionEvent(base, "metadata.compact_input", "metadata", {
          evidenceRef: evidenceRef(ref, "metadata.compact_input", 0, "session_input", input.id),
          summary: text ? `compact input (${text.length} chars)` : "compact input",
          inputId: input.id,
          status: str(input.status),
          contentLength: text?.length ?? null,
          coverage: "full",
        }));
      }

      for (const part of parsedParts) {
        const type = str(part.data.type);
        const timelineType = str(part.data.timelineType);
        if (type === "timeline" && timelineType === "model_change") {
          const from = asRecord(part.data.fromModelSelection)?.label ?? asRecord(part.data.fromModel)?.label ?? null;
          const to = asRecord(part.data.toModelSelection)?.label ?? asRecord(part.data.toModel)?.label ?? null;
          push(rowTime(part.time_created), 0, 8, executionEvent(base, "model.switch", "metadata", {
            ...coordinates(part.message_id),
            evidenceRef: evidenceRef(ref, "model.switch", 0, "part", part.id),
            summary: "model switched",
            from: str(from),
            to: str(to),
            status: str(part.data.status),
            coverage: "full",
          }));
        }
        if (type === "file") {
          const metadata = asRecord(part.data.metadata);
          push(rowTime(part.time_created), 0, 8, executionEvent(base, "attachment", "metadata", {
            ...coordinates(part.message_id),
            evidenceRef: evidenceRef(ref, "attachment", 0, "part", part.id),
            summary: "attachment",
            mime: str(part.data.mime),
            bytes: metadata ? num(metadata.sizeBytes) : null,
            artifact: (metadata ? str(metadata.artifactUri) : null) ?? str(part.data.url),
            coverage: "full",
          }));
        }
      }

      draft.sort((left, right) => {
        const leftTime = timestampMillis(left.at) ?? Number.POSITIVE_INFINITY;
        const rightTime = timestampMillis(right.at) ?? Number.POSITIVE_INFINITY;
        if (leftTime !== rightTime) return leftTime - rightTime;
        if (left.tier !== right.tier) return left.tier - right.tier;
        if (left.sequence !== right.sequence) return left.sequence - right.sequence;
        return String(left.event.type).localeCompare(String(right.event.type));
      });
      const events = draft
        .map((item, index) => ({
          ...item.event,
          timestamp: normalizeTimestamp(item.at),
          sequence: index + 1,
          index: index + 1,
        }))
        .filter((event) => withinTimeRange(event.timestamp, scope));
      return markSessionReadCoverage(events, { truncated });
    } catch (error) {
      this.sessionWarnings.push(warning("zcode-session-read-failed", error?.message ?? "cannot read ZCode session", { source: "zcode-sessions" }));
      return markSessionReadCoverage([], { truncated: true });
    } finally {
      db.close();
    }
  }

  normalizeEvent(raw) {
    return raw ?? null;
  }

  normalizeEvents(raw) {
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  }

  analysisWarnings() {
    return this.sessionWarnings;
  }

  async analyze(options = {}) {
    return runProviderAnalysis(this, options, { platform: "zcode", adapterVersion: ZCODE_ADAPTER_VERSION });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command = "sessions", options } = parseArgs(argv);
  const analyzer = new ZcodeSessionAnalyzer();
  const result = await runProviderCommand(analyzer, command, options);
  await emitProviderResult({ provider: "ZCode", command, options, result });
  return result;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`zcode session-analysis failed: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
