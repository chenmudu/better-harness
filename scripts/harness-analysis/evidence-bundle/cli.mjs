#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatHostList,
  HOST_CAPABILITIES,
  hostHomeOptionKeys,
  hostIdsFor,
} from "../../host-support/index.mjs";
import { parseArgs, parseBooleanFlag } from "../../session-analysis/index.mjs";
import { writeSummaryFactsOutput } from "../summary-facts-output.mjs";
import { collectEvidenceBundle } from "./index.mjs";

const EVIDENCE_HOSTS = hostIdsFor(HOST_CAPABILITIES.EVIDENCE_BUNDLE);

export const EVIDENCE_BUNDLE_HELP = `Usage: better-harness harness evidence-bundle --workspace <target> [options]

Collect one frozen-context JSON bundle for the Session Evidence, Project
Harness, and Agent Customize specialists plus the lead analyzer.

Options:
  --workspace <path>       Target workspace (required)
  --cwd <path>             Configured-practice cwd (default: workspace)
  --platform <name>        ${formatHostList(EVIDENCE_HOSTS)} (default: qoder)
  --language <locale>      Evidence language (default: en)
  --depth <quick|normal>   7-day/3-item or 30-day/5-item review (default: normal)
  --since <ISO timestamp>  Override the frozen window start
  --until <ISO timestamp>  Override the frozen window end
  --evidence-limit <1-5>   Override the specialist evidence limit
  --include-user-home      Include authorized user/global asset metadata
  --include-memories       Include authorized Memory title metadata
  --claude-home <dir>      Claude config root override
  --claude-state <file>    Claude state-file override
  --kimi-home <dir>        Kimi Code data root override
  --workbuddy-home <dir>   WorkBuddy data root override
  --grok-home <dir>        Grok CLI data root override
  --dsh-home <dir>         DeepSeek Harness config root override
  --canvas-out <file>      With Qoder or Cursor, initialize canvas.json from lead facts
  --replace-canvas         Replace that canvas.json when explicitly authorized
  --summary-out <file>     Write summary-facts.json from the lead summary facts
  --replace-summary        Replace that summary-facts.json when explicitly authorized
  --format json            JSON only
  --json                   Emit JSON
`;

const ALLOWED = new Set([
  "workspace", "cwd", "platform", "provider", "language", "depth", "since", "until",
  "evidence-limit", "include-user-home", "include-memories", "canvas-out",
  "replace-canvas", "summary-out", "replace-summary", "format", "json",
  ...hostHomeOptionKeys(EVIDENCE_HOSTS),
  "claude-state", "help", "h",
]);

function assertOptions(command, options) {
  const unknown = Object.keys(options).filter((key) => key !== "_" && !ALLOWED.has(key));
  if (command || options._.length > 0 || unknown.length > 0) {
    const token = command ?? options._[0] ?? `--${unknown[0]}`;
    throw Object.assign(new Error(`unknown evidence-bundle argument: ${token}`), {
      code: "UNKNOWN_ARGUMENT",
    });
  }
  if ((options.format ?? "json") !== "json") {
    throw Object.assign(new Error("evidence-bundle supports only --format json"), {
      code: "UNSUPPORTED_EVIDENCE_BUNDLE_FORMAT",
    });
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  if (options.help || options.h) {
    process.stdout.write(EVIDENCE_BUNDLE_HELP);
    return 0;
  }
  try {
    assertOptions(command, options);
    const result = await collectEvidenceBundle(options, dependencies);
    const summaryOut = options["summary-out"];
    if (summaryOut !== undefined) {
      const summaryFacts = result?.lead?.data?.summaryFacts;
      if (!summaryFacts) {
        throw Object.assign(new Error("evidence bundle has no lead summary facts"), {
          code: "MISSING_LEAD_SUMMARY_FACTS",
        });
      }
      const summaryReplaced = await writeSummaryFactsOutput(summaryOut, summaryFacts, {
        replace: parseBooleanFlag(options["replace-summary"]),
      });
      result.summaryPath = path.resolve(String(summaryOut));
      result.summaryReplaced = summaryReplaced;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "failed" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`harness evidence-bundle failed: ${error.message}\n`);
    return 1;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exitCode = await main();
