"use strict";

const { parentPort } = require("worker_threads");
const { TextlintKernel } = require("@textlint/kernel");
// Import rules helper (packaged alongside worker)
const { buildKernelOptions } = require("../linter_rules");

const kernel = new TextlintKernel();

// Track active jobs for cancellation
const activeJobs = new Set();

parentPort.on("message", async (msg) => {
  try {
    if (msg.command === "lint") {
      const { reqId, text, ext, filePath, userRules } = msg;

      // Mark job as active
      activeJobs.add(reqId);

      // Mock channel for logging
      const mockChannel = {
        appendLine: (m) => parentPort.postMessage({ command: "log", message: `[WorkerLog] ${m}` })
      };

      try {
        // Check if job was aborted before starting
        if (!activeJobs.has(reqId)) {
          return;
        }

        // Build options using user config
        const options = buildKernelOptions(userRules, mockChannel);

        if (options.rules.length === 0) {
          parentPort.postMessage({ command: "log", message: "[Worker] WARNING: No rules enabled!" });
        }

        const runStart = Date.now();
        const result = await kernel.lintText(text, {
          filePath,
          ext,
          plugins: options.plugins,
          rules: options.rules,
        });
        const runEnd = Date.now();

        // Check if job was aborted after completion
        if (!activeJobs.has(reqId)) {
          return;
        }

        parentPort.postMessage({
          command: "lint_result",
          reqId,
          result,
        });

        // Remove from active jobs
        activeJobs.delete(reqId);
      } catch (e) {
        if (activeJobs.has(reqId)) {
          parentPort.postMessage({ command: "error", error: `Lint Error: ${e.message} stack=${e.stack}`, reqId });
          activeJobs.delete(reqId);
        }
      }
    } else if (msg.command === "abort") {
      const { reqId } = msg;
      activeJobs.delete(reqId);
      // Note: kernel.lintText cannot be cancelled mid-execution, but we prevent result from being sent
    }
  } catch (err) {
    parentPort.postMessage({
      command: "error",
      error: String(err),
      reqId: msg.reqId
    });
  }
});
