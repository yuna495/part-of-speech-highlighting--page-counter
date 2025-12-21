"use strict";

const { parentPort } = require("worker_threads");
const { TextlintKernel } = require("@textlint/kernel");
// Import rules helper (packaged alongside worker)
const { buildKernelOptions } = require("../linter_rules");

const kernel = new TextlintKernel();

parentPort.on("message", async (msg) => {
  try {
    if (msg.command === "lint") {
      const { reqId, text, ext, filePath, userRules } = msg;

      // Mock channel for logging
      const mockChannel = {
          appendLine: (m) => parentPort.postMessage({ command: "log", message: `[WorkerLog] ${m}` })
      };

      try {
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

        parentPort.postMessage({
            command: "lint_result",
            reqId,
            result,
        });
      } catch (e) {
         parentPort.postMessage({ command: "error", error: `Lint Error: ${e.message} stack=${e.stack}`, reqId });
      }
    }
  } catch (err) {
    parentPort.postMessage({
      command: "error",
      error: String(err),
      reqId: msg.reqId
    });
  }
});
