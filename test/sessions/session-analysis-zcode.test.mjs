import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  ZCODE_ADAPTER_VERSION,
  ZcodeSessionAnalyzer,
  main as zcodeMain,
} from "../../scripts/session-analysis/platforms/zcode.mjs";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-"));
  const workspace = path.join(root, "workspace", "app");
  const zcodeHome = path.join(root, "zcode");
  const dbPath = path.join(zcodeHome, "cli", "db", "db.sqlite");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(dbPath), { recursive: true });

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table schema_migration (version text);
    insert into schema_migration (version) values ('1');

    create table session (
      id text primary key,
      directory text,
      title text,
      parent_id text,
      task_type text,
      time_created integer,
      time_updated integer,
      time_deleted integer,
      time_archived integer
    );

    create table message (
      id text primary key,
      session_id text,
      sequence integer,
      data text,
      time_created integer
    );

    create table part (
      id text primary key,
      session_id text,
      message_id text,
      data text,
      time_created integer
    );

    create table turn_usage (
      session_id text,
      turn_id text,
      started_at integer,
      completed_at integer,
      status text
    );

    create table model_usage (
      id text primary key,
      session_id text,
      logical_request_id text,
      attempt_index integer,
      assistant_message_id text,
      provider_id text,
      model_id text,
      input_tokens integer,
      output_tokens integer,
      cache_read_input_tokens integer,
      cache_creation_input_tokens integer,
      reasoning_tokens integer,
      provider_total_tokens integer,
      computed_total_tokens integer,
      status text,
      finish_reason text,
      query_source text,
      started_at integer,
      completed_at integer
    );

    create table tool_usage (
      session_id text,
      tool_call_id text,
      approval_status text,
      error_message text,
      duration_ms integer
    );

    create table session_input (
      id text primary key,
      session_id text,
      kind text,
      status text,
      payload text,
      time_created integer
    );
  `);

  const insertSession = db.prepare(
    "insert into session (id, directory, title, parent_id, task_type, time_created, time_updated, time_deleted, time_archived) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertSession.run("s-main", workspace, "demo session", null, null, BASE, BASE + 5000, null, null);
  insertSession.run("s-child", workspace, "child task", "s-main", "subagent_child", BASE + 1000, BASE + 6000, null, null);
  insertSession.run("s-other", path.join(root, "workspace", "other"), "other repo", null, null, BASE, BASE + 4000, null, null);
  insertSession.run("s-deleted", workspace, "deleted", null, null, BASE, BASE + 7000, BASE + 8000, null);
  insertSession.run("s-nodir", null, "no directory", null, null, BASE, BASE + 3000, null, null);

  const insertMessage = db.prepare(
    "insert into message (id, session_id, sequence, data, time_created) values (?, ?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "insert into part (id, session_id, message_id, data, time_created) values (?, ?, ?, ?, ?)",
  );

  insertMessage.run("m-user", "s-main", 1, JSON.stringify({
    role: "user",
    semantics: { origin: "real_user" },
    anchor: { turnId: "t1" },
  }), BASE + 1000);
  insertPart.run("p-user", "s-main", "m-user", JSON.stringify({
    type: "text",
    text: "please fix the bug",
  }), BASE + 1000);

  insertMessage.run("m-injected", "s-main", 2, JSON.stringify({
    role: "user",
    semantics: { origin: "system" },
    anchor: { turnId: "t1" },
  }), BASE + 1010);
  insertPart.run("p-injected", "s-main", "m-injected", JSON.stringify({
    type: "text",
    text: "injected reminder",
    metadata: { source: "runtime" },
  }), BASE + 1010);

  insertMessage.run("m-assistant", "s-main", 3, JSON.stringify({
    role: "assistant",
    anchor: { turnId: "t1" },
  }), BASE + 1100);
  insertPart.run("p-step-start", "s-main", "m-assistant", JSON.stringify({ type: "step-start" }), BASE + 1100);
  insertPart.run("p-assistant", "s-main", "m-assistant", JSON.stringify({
    type: "text",
    text: "assistant answer",
  }), BASE + 1110);
  insertPart.run("p-reasoning", "s-main", "m-assistant", JSON.stringify({
    type: "reasoning",
    text: "private reasoning",
  }), BASE + 1120);
  insertPart.run("p-tool-ok", "s-main", "m-assistant", JSON.stringify({
    type: "tool",
    tool: "Bash",
    callID: "call-ok",
    state: {
      status: "completed",
      input: { command: "npm test" },
      output: "secret output",
      time: { start: BASE + 1200, end: BASE + 1300 },
    },
  }), BASE + 1200);
  insertPart.run("p-tool-fail", "s-main", "m-assistant", JSON.stringify({
    type: "tool",
    tool: "Read",
    callID: "call-fail",
    state: {
      status: "error",
      input: { file_path: "src/index.js" },
      error: "read failed",
      time: { start: BASE + 1400, end: BASE + 1500 },
    },
  }), BASE + 1400);
  insertPart.run("p-tool-cancel", "s-main", "m-assistant", JSON.stringify({
    type: "tool",
    tool: "Edit",
    callID: "call-cancel",
    state: { status: "cancelled", time: { start: BASE + 1600 } },
  }), BASE + 1600);
  insertPart.run("p-step-finish", "s-main", "m-assistant", JSON.stringify({ type: "step-finish" }), BASE + 1700);
  insertPart.run("p-mystery", "s-main", "m-assistant", JSON.stringify({ type: "mystery" }), BASE + 1750);

  insertPart.run("p-compaction", "s-main", "m-assistant", JSON.stringify({
    type: "compaction",
    operationId: "compact-1",
    trigger: "auto",
    status: "completed",
    preCompactTokenCount: 1000,
    postCompactTokenCount: 200,
  }), BASE + 2000);
  insertPart.run("p-model-switch", "s-main", "m-assistant", JSON.stringify({
    type: "timeline",
    timelineType: "model_change",
    fromModelSelection: { label: "old-model" },
    toModelSelection: { label: "new-model" },
  }), BASE + 2100);
  insertPart.run("p-file", "s-main", "m-assistant", JSON.stringify({
    type: "file",
    mime: "image/png",
    metadata: { sizeBytes: 123, artifactUri: "asset://demo" },
  }), BASE + 2200);

  db.prepare("insert into turn_usage (session_id, turn_id, started_at, completed_at, status) values (?, ?, ?, ?, ?)")
    .run("s-main", "t1", BASE + 900, BASE + 2300, "completed");

  const insertUsage = db.prepare(`
    insert into model_usage (
      id, session_id, logical_request_id, attempt_index, assistant_message_id,
      provider_id, model_id, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, reasoning_tokens, provider_total_tokens,
      computed_total_tokens, status, finish_reason, query_source, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertUsage.run(
    "u-attempt-0", "s-main", "req-1", 0, "m-assistant",
    "provider-a", "model-a", 100, 20, 40, 10, null, 120, 120,
    "completed", "stop", "chat", BASE + 1150, BASE + 1350,
  );
  insertUsage.run(
    "u-attempt-1", "s-main", "req-1", 1, "m-assistant",
    "provider-a", "model-a", 90, 10, 0, 0, null, 100, 100,
    "completed", "stop", "chat", BASE + 1360, BASE + 1400,
  );

  db.prepare("insert into tool_usage (session_id, tool_call_id, approval_status, error_message, duration_ms) values (?, ?, ?, ?, ?)")
    .run("s-main", "call-ok", "approved", null, 25);

  db.prepare("insert into session_input (id, session_id, kind, status, payload, time_created) values (?, ?, ?, ?, ?, ?)")
    .run("input-compact", "s-main", "compact", "completed", JSON.stringify({ text: "compact summary" }), BASE + 2000);

  db.close();
  return { root, workspace, zcodeHome, dbPath };
}

async function openAnalyzer(fixture, options = {}) {
  const analyzer = new ZcodeSessionAnalyzer();
  const scope = await analyzer.resolveScope({
    workspace: fixture.workspace,
    zcodeDb: fixture.dbPath,
    ...options,
  });
  const roots = await analyzer.discoverSourceRoots(scope);
  return { analyzer, scope, roots };
}

function byType(events, type) {
  return events.filter((event) => event.type === type);
}

test("ZCode scope resolves the default and explicit database locations", async () => {
  const fixture = await makeFixture();
  try {
    const analyzer = new ZcodeSessionAnalyzer();
    const defaultScope = await analyzer.resolveScope({
      workspace: fixture.workspace,
      zcodeHome: fixture.zcodeHome,
    });
    assert.equal(defaultScope.zcodeDb, fixture.dbPath);

    const explicitScope = await analyzer.resolveScope({
      workspace: fixture.workspace,
      zcodeHome: path.join(fixture.root, "ignored"),
      zcodeDb: fixture.dbPath,
    });
    assert.equal(explicitScope.zcodeDb, fixture.dbPath);
    assert.equal(explicitScope.platform, "zcode");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode source discovery reports one read-only SQLite session store", async () => {
  const fixture = await makeFixture();
  try {
    const { roots } = await openAnalyzer(fixture);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, "zcode-sessions");
    assert.equal(roots[0].kind, "zcode-sqlite");
    assert.equal(roots[0].role, "session-store");
    assert.equal(roots[0].exists, true);
    assert.equal(roots[0].enabled, true);
    assert.equal(roots[0].coverage, "primary");

    const analyzer = new ZcodeSessionAnalyzer();
    const missingScope = await analyzer.resolveScope({
      workspace: fixture.workspace,
      zcodeDb: path.join(fixture.root, "missing.sqlite"),
    });
    const missingRoots = await analyzer.discoverSourceRoots(missingScope);
    assert.equal(missingRoots[0].exists, false);
    assert.equal(missingRoots[0].warnings[0].code, "zcode-database-missing");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode discovery filters by workspace, skips soft-deleted sessions, and keeps subagent linkage", async () => {
  const fixture = await makeFixture();
  try {
    const { analyzer, scope, roots } = await openAnalyzer(fixture);
    const sessions = await analyzer.discoverSessions(scope, roots);
    const ids = sessions.map((session) => session.sessionId).sort();
    assert.deepEqual(ids, ["s-child", "s-main"]);

    const main = sessions.find((session) => session.sessionId === "s-main");
    assert.equal(main.cwd, fixture.workspace);
    assert.equal(main.workspace, fixture.workspace);
    assert.deepEqual(main.sourceKinds, ["zcode-sqlite"]);
    assert.equal(main.parentSessionId, null);
    assert.equal(main.isSubagent, false);
    assert.equal(main.coverage, "full");

    const child = sessions.find((session) => session.sessionId === "s-child");
    assert.equal(child.parentSessionId, "s-main");
    assert.equal(child.isSubagent, true);

    const warnings = analyzer.analysisWarnings();
    assert.equal(warnings.some((item) => item.code === "zcode-session-without-workspace" && item.count === 1), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode readSession normalizes user, injected, assistant, turn, tool, usage, compaction, and boundary events", async () => {
  const fixture = await makeFixture();
  try {
    const { analyzer, scope, roots } = await openAnalyzer(fixture);
    const [main] = (await analyzer.discoverSessions(scope, roots))
      .filter((session) => session.sessionId === "s-main");
    const events = await analyzer.readSession(main, scope, {});
    const typeCounts = events.reduce((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {});

    assert.equal(typeCounts.user, 1);
    assert.equal(typeCounts["metadata.injected_message"], 1);
    assert.equal(typeCounts.assistant, 1);
    assert.equal(typeCounts["tool.call"], 3);
    assert.equal(typeCounts["tool.result"], 3);
    assert.equal(typeCounts["model.response.completed"], 2);
    assert.equal(typeCounts["turn.start"], 1);
    assert.equal(typeCounts["turn.end"], 1);
    assert.equal(typeCounts["compaction.summary"], 1);
    assert.equal(typeCounts["metadata.compact_input"], 1);
    assert.equal(typeCounts["model.switch"], 1);
    assert.equal(typeCounts.attachment, 1);
    assert.equal(typeCounts["metadata.zcode_part"], 1);

    for (const event of events) {
      assert.equal(typeof event.timestamp, "string", `${event.type} timestamp`);
      assert.equal(Number.isInteger(event.sequence), true);
    }

    const user = byType(events, "user")[0];
    assert.equal(user.userPrompt, true);
    assert.equal(user.contentLength, "please fix the bug".length);
    assert.equal("userText" in user, false);

    const injected = byType(events, "metadata.injected_message")[0];
    assert.equal(injected.origin, "system");
    assert.equal(injected.contentLength, "injected reminder".length);

    const calls = new Map(byType(events, "tool.call").map((event) => [event.toolInvocationId, event]));
    const results = new Map(byType(events, "tool.result").map((event) => [event.toolInvocationId, event]));
    assert.deepEqual([...calls.keys()].sort(), ["call-cancel", "call-fail", "call-ok"]);
    assert.deepEqual([...results.keys()].sort(), ["call-cancel", "call-fail", "call-ok"]);
    assert.equal(calls.get("call-ok").permissionDecision, "approved");
    assert.equal(results.get("call-ok").success, true);
    assert.equal(results.get("call-ok").durationMs, 25);
    assert.equal(results.get("call-fail").success, false);
    assert.equal(results.get("call-fail").hasError, true);
    assert.equal(results.get("call-cancel").success, false);

    const responses = byType(events, "model.response.completed");
    assert.deepEqual(
      responses.map((event) => event.responseId).sort(),
      ["req-1@0", "req-1@1"],
    );
    const first = responses.find((event) => event.attemptIndex === 0);
    assert.equal(first.requestId, "req-1");
    assert.equal(first.modelUsage.inputTokens, 50);
    assert.equal(first.modelUsage.cacheReadInputTokens, 40);
    assert.equal(first.modelUsage.cacheCreationInputTokens, 10);
    assert.equal(first.modelUsage.outputTokens, 20);
    assert.equal(first.modelUsage.totalTokens, 120);
    assert.equal(first.modelUsage.cacheAccountingMode, "separate-input-lane");
    const retry = responses.find((event) => event.attemptIndex === 1);
    assert.equal(retry.modelUsage.inputTokens, 90);
    assert.equal(retry.modelUsage.totalTokens, 100);

    const turnEnd = byType(events, "turn.end")[0];
    assert.equal(turnEnd.turn, 1);
    assert.equal(turnEnd.stepCount, 1);

    const compaction = byType(events, "compaction.summary")[0];
    assert.equal(compaction.kind, "auto");
    assert.equal(compaction.triggerSource, "part");
    assert.equal(compaction.beforeTokens, 1000);
    assert.equal(compaction.afterTokens, 200);
    assert.equal(compaction.releasedTokens, 800);
    assert.equal(compaction.coverage, "full");

    assert.equal(byType(events, "model.switch")[0].to, "new-model");
    assert.equal(byType(events, "attachment")[0].mime, "image/png");
    assert.equal(byType(events, "metadata.zcode_part")[0].partType, "mystery");

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("please fix the bug"), false);
    assert.equal(serialized.includes("secret output"), false);
    assert.equal(serialized.includes("npm test"), false);
    assert.equal(serialized.includes("private reasoning"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode content include flags expose sanitized local-diagnosis text only when requested", async () => {
  const fixture = await makeFixture();
  try {
    const { analyzer, scope, roots } = await openAnalyzer(fixture);
    const [main] = (await analyzer.discoverSessions(scope, roots))
      .filter((session) => session.sessionId === "s-main");
    const events = await analyzer.readSession(main, scope, {
      "include-user-text": true,
      "include-content": true,
      "include-command-text": true,
    });

    const user = byType(events, "user")[0];
    assert.match(user.userText, /please fix the bug/u);
    assert.match(user.content, /please fix the bug/u);
    assert.match(byType(events, "assistant")[0].content, /assistant answer/u);
    assert.match(byType(events, "metadata.reasoning")[0].content, /private reasoning/u);
    const bash = byType(events, "tool.call").find((event) => event.toolName === "Bash");
    assert.equal(bash.commandText, "npm test");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode keeps missing tables and malformed rows visible without failing the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "better-harness-zcode-degraded-"));
  const workspace = path.join(root, "workspace", "app");
  const dbPath = path.join(root, "zcode", "cli", "db", "db.sqlite");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key, directory text, title text, parent_id text, task_type text, time_created integer, time_updated integer, time_deleted integer, time_archived integer);
    create table message (id text primary key, session_id text, sequence integer, data text, time_created integer);
    create table part (id text primary key, session_id text, message_id text, data text, time_created integer);
  `);
  db.prepare("insert into session values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("s-degraded", workspace, "degraded", null, null, BASE, BASE + 1000, null, null);
  db.prepare("insert into message values (?, ?, ?, ?, ?)")
    .run("m-degraded", "s-degraded", 1, JSON.stringify({ role: "assistant" }), BASE + 100);
  db.prepare("insert into part values (?, ?, ?, ?, ?)")
    .run("p-degraded", "s-degraded", "m-degraded", "{", BASE + 100);
  db.close();

  try {
    const { analyzer, scope, roots } = await openAnalyzer({
      workspace,
      zcodeHome: path.join(root, "zcode"),
      dbPath,
    });
    const [session] = await analyzer.discoverSessions(scope, roots);
    assert.equal(session.sessionId, "s-degraded");
    const events = await analyzer.readSession(session, scope, {});
    const codes = analyzer.analysisWarnings().map((item) => item.code);
    assert.ok(codes.includes("zcode-schema-version-missing"));
    assert.ok(codes.includes("zcode-table-missing:tool_usage"));
    assert.ok(codes.includes("zcode-table-missing:session_input"));
    assert.ok(codes.includes("zcode-malformed-row"));
    assert.equal(events.some((event) => event.type === "metadata.zcode_part"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZCode adapter reads the SQLite database without mutating it", async () => {
  const fixture = await makeFixture();
  try {
    const before = createHash("sha256").update(await readFile(fixture.dbPath)).digest("hex");
    const { analyzer, scope, roots } = await openAnalyzer(fixture);
    const sessions = await analyzer.discoverSessions(scope, roots);
    for (const session of sessions) {
      await analyzer.readSession(session, scope, {});
    }
    const after = createHash("sha256").update(await readFile(fixture.dbPath)).digest("hex");
    assert.equal(after, before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode CLI emits sources, sessions, and facts from the shared provider contract", async () => {
  const fixture = await makeFixture();
  try {
    const originalWrite = process.stdout.write;
    const outputs = [];
    process.stdout.write = (chunk) => {
      outputs.push(String(chunk));
      return true;
    };
    try {
      await zcodeMain(["sources", "--zcode-db", fixture.dbPath, "--workspace", fixture.workspace]);
      await zcodeMain([
        "sessions", "--zcode-db", fixture.dbPath, "--workspace", fixture.workspace, "--limit", "3",
      ]);
      await zcodeMain([
        "facts", "--zcode-db", fixture.dbPath, "--workspace", fixture.workspace,
        "--limit", "3", "--exclude-active-window-ms", "0",
      ]);
      await zcodeMain([
        "show", "--session-id", "s-main", "--zcode-db", fixture.dbPath,
        "--workspace", fixture.workspace, "--include-events",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const sources = JSON.parse(outputs[0]);
    assert.equal(sources.sources[0].kind, "zcode-sqlite");
    assert.equal(sources.sessions.length, 2);

    const sessions = JSON.parse(outputs[1]);
    assert.deepEqual(sessions.sessions.map((session) => session.sessionId).sort(), ["s-child", "s-main"]);

    const facts = JSON.parse(outputs[2]);
    assert.equal(facts.kind, "session-core-facts");
    assert.equal(facts.candidates.length >= 1, true);
    const factsText = JSON.stringify(facts);
    assert.equal(factsText.includes("secret output"), false);
    assert.equal(factsText.includes("npm test"), false);

    const shown = JSON.parse(outputs[3]);
    assert.equal(shown.sessions.length, 1);
    assert.equal(shown.sessions[0].sessionId, "s-main");
    assert.equal(shown.sessions[0].events.some((event) => event.type === "user"), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ZCode adapter declares provider metadata without a lifecycle claim", async () => {
  const fixture = await makeFixture();
  try {
    const analyzer = new ZcodeSessionAnalyzer();
    const result = await analyzer.analyze({
      command: "sessions",
      workspace: fixture.workspace,
      zcodeDb: fixture.dbPath,
    });
    assert.equal(result.scope.platform, "zcode");
    assert.equal(ZCODE_ADAPTER_VERSION, "zcode-v1");
    assert.equal(result.sessions.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
