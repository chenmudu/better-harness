import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { taskLoopSummaryFactsArtifact } from "./task-loop-report.mjs";

export const SUMMARY_FACTS_FILE = "summary-facts.json";

function outputError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function replaceAtomically(target, content) {
  const parentDir = path.dirname(target);
  const stageDir = await mkdtemp(path.join(parentDir, `.${path.basename(target)}.replace-`));
  const nextPath = path.join(stageDir, "next.json");
  const backupPath = path.join(stageDir, "previous.json");
  try {
    await writeFile(nextPath, content, { flag: "wx" });
    try {
      await rename(nextPath, target);
    } catch (error) {
      if (!new Set(["EACCES", "EEXIST", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
      await rename(target, backupPath);
      try {
        await rename(nextPath, target);
      } catch (replaceError) {
        try {
          await rename(backupPath, target);
        } catch (rollbackError) {
          throw outputError(
            "SUMMARY_FACTS_OUTPUT_REPLACE_ROLLBACK_FAILED",
            `Summary facts replacement failed and rollback failed: ${replaceError.message}; ${rollbackError.message}`,
          );
        }
        throw replaceError;
      }
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeSummaryFactsOutput(filePath, summaryFacts, { replace = false } = {}) {
  const target = path.resolve(String(filePath));
  if (path.basename(target) !== SUMMARY_FACTS_FILE) {
    throw outputError(
      "INVALID_SUMMARY_FACTS_OUTPUT",
      `--summary-out must target ${SUMMARY_FACTS_FILE}: ${target}`,
    );
  }
  const content = `${JSON.stringify(taskLoopSummaryFactsArtifact(summaryFacts), null, 2)}\n`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, content, { flag: "wx" });
    return false;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!replace) {
      throw outputError(
        "SUMMARY_FACTS_OUTPUT_EXISTS",
        `--summary-out refuses to replace an existing file: ${target}`,
      );
    }
  }
  await replaceAtomically(target, content);
  return true;
}