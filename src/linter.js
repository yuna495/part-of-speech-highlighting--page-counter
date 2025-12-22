// textlint kernel と VS Code をつなぎ、差分リントと診断表示を行う。
// VSCode API
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { Worker } = require("worker_threads");

const {
  maskCodeBlocks,
  fenceStateBefore,
} = require("./linter_rules");

// ===== 0) グローバル状態 / ログ / 保存理由 =====
const channel = vscode.window.createOutputChannel("textlint-kernel-linter");

const lastSaveReason = new Map();
const docCache = new Map();
let lintStatusItem = null;
let lintRunning = 0;

// Worker State
let linterWorker = null;
let nextReqId = 1;
const workerPending = new Map();
const currentLintReq = new Map(); // docUri -> reqId (for abort)

// ===== 独自診断（Main Thread） =====
const RE_PUNCT_RUN = /(。。|、、|、。|。、)/g;
function findRepeatedPunctDiagnostics(uri, text, baseLine = 0) {
  const diags = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i];
    RE_PUNCT_RUN.lastIndex = 0;
    let m;
    while ((m = RE_PUNCT_RUN.exec(lineStr)) !== null) {
        const startCol = m.index;
        const endCol = m.index + m[0].length;
        const range = new vscode.Range(
            baseLine + i,
            startCol,
            baseLine + i,
            endCol
        );
        const diag = new vscode.Diagnostic(
            range,
            "句読点が連続しています。",
            vscode.DiagnosticSeverity.Error
        );
        diag.source = "textlint-kernel-linter";
        diag.code = "punctuation-run";
        diags.push(diag);
    }
  }
  return diags;
}

const RE_NEED_FW_SPACE = /[！？](?![！？　」』〉》）】`'”*~]|$)/g;
function findExclamQuestionSpaceDiagnostics(uri, text, baseLine = 0) {
  const diags = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i];
    RE_NEED_FW_SPACE.lastIndex = 0;
    let m;
    while ((m = RE_NEED_FW_SPACE.exec(lineStr)) !== null) {
        const startCol = m.index;
        const endCol = m.index + 1;
        const range = new vscode.Range(
            baseLine + i,
            startCol,
            baseLine + i,
            endCol
        );
        const diag = new vscode.Diagnostic(
            range,
            "「！」と「？」の後にはスペースが必要です。",
            vscode.DiagnosticSeverity.Error
        );
        diag.source = "textlint-kernel-linter";
        diag.code = "exclam-question-needs-fullwidth-space";
        diags.push(diag);
    }
  }
  return diags;
}

function ensureWorker(context) {
  if (linterWorker) return;

  let scriptPath = path.join(context.extensionPath, "dist", "worker", "linterWorker.js");
  if (!fs.existsSync(scriptPath)) {
      scriptPath = path.join(context.extensionPath, "src", "worker", "linterWorker.js");
  }

  try {
      linterWorker = new Worker(scriptPath);
      channel.appendLine(`[LinterWorker] Created at ${scriptPath}`);

      linterWorker.on("message", (msg) => {
        if (msg.command === "lint_result") {
          const p = workerPending.get(msg.reqId);
          if (p) {
            workerPending.delete(msg.reqId);
            p.resolve(msg.result);
          }
        } else if (msg.command === "log") {
             channel.appendLine(msg.message);
        } else if (msg.command === "error") {
           const p = workerPending.get(msg.reqId);
           if (p) {
             workerPending.delete(msg.reqId);
             p.reject(new Error(msg.error));
           } else {
             channel.appendLine(`[LinterWorker] Error: ${msg.error}`);
           }
        }
      });

      linterWorker.on("error", (err) => {
          channel.appendLine(`[LinterWorker] FATAL: ${err}`);
          console.error(`[LinterWorker] FATAL:`, err);
      });

      linterWorker.on("exit", (code) => {
          channel.appendLine(`[LinterWorker] Worker exited with code ${code}`);
          console.log(`[LinterWorker] Worker exited with code ${code}`);
          linterWorker = null; // Prepare for restart?
      });
  } catch(e) {
      channel.appendLine(`[LinterWorker] Failed to create: ${e}`);
      console.error(e);
  }
}

function lintTextWithWorker(text, options) {
    if (!linterWorker) {
        console.warn("[Linter] Worker not initialized");
        return Promise.reject(new Error("Linter Worker not initialized"));
    }
    return new Promise((resolve, reject) => {
        const reqId = nextReqId++;
        workerPending.set(reqId, { resolve, reject });

        // Retrieve user rules form config (Active Window Context)
        let userRules = {};
        try {
            const cfg = vscode.workspace.getConfiguration("posNote.linter");
            userRules = cfg.get("rules") || {};
        } catch(e) {
            channel.appendLine(`[Linter] config error: ${e}`);
        }

        linterWorker.postMessage({ command: "lint", reqId, text, ext: options.ext, filePath: options.filePath, userRules });

        // Track this request for abortion
        const docUri = options.docUri;
        if (docUri) {
            currentLintReq.set(docUri, reqId);
        }
    });
}

function invalidateKernelCache() {
  channel.appendLine("[cache] (Worker-side) Cache invalidation not fully implemented yet");
}

function ensureStatusBar(context) {
  if (lintStatusItem) return lintStatusItem;
  lintStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10000
  );
  lintStatusItem.name = "textlint-kernel-linter";
  lintStatusItem.tooltip =
    "クリックでこのファイルを lint（保存不要） / Linter result";
  lintStatusItem.command = "linter.lintActiveFile";
  context.subscriptions.push(lintStatusItem);
  return lintStatusItem;
}

function updateIdleUIForDoc(doc) {
  if (!lintStatusItem) return;
  let count = 0;
  if (doc && doc.uri) {
    const cached = docCache.get(doc.uri.toString());
    if (cached && Array.isArray(cached.diagnostics)) {
      count = cached.diagnostics.length;
    }
  }
  lintStatusItem.text = `$(check) ${count} iss`;
  lintStatusItem.show();
}

function startLintUI(text = "Linting...") {
  lintRunning++;
  if (lintStatusItem) {
    lintStatusItem.text = `$(sync~spin) ${text}`;
    lintStatusItem.show();
  }
}

function finishLintUI(resultText = "0 iss") {
  lintRunning = Math.max(0, lintRunning - 1);
  if (!lintStatusItem) return;
  if (lintRunning === 0) {
    lintStatusItem.text = `$(check) ${resultText}`;
    lintStatusItem.show();
  }
}

function finishWithCachedCount(doc) {
  try {
    const key = doc?.uri?.toString();
    let count = 0;
    if (key && docCache.has(key)) {
      const cached = docCache.get(key);
      if (cached && Array.isArray(cached.diagnostics))
        count = cached.diagnostics.length;
    }
    finishLintUI(`${count} iss`);
  } catch {
    finishLintUI("0 iss");
  }
}

function shouldLintOnSave(docUriString, reason) {
  const cfg = vscode.workspace.getConfiguration("posNote.linter");
  const lintOnAutoSave = cfg.get("lintOnAutoSave", false);

  if (
    !lintOnAutoSave &&
    (reason === vscode.TextDocumentSaveReason.AfterDelay ||
      reason === vscode.TextDocumentSaveReason.FocusOut)
  ) {
    return false;
  }

  const active = vscode.window.activeTextEditor?.document;
  return !!(active && active.uri.toString() === docUriString);
}

function canLint(doc) {
  if (!doc) return false;
  if (doc.isUntitled) return false;
  const fsPath = doc.uri?.fsPath?.toLowerCase() || "";
  const isTxt = fsPath.endsWith(".txt");
  const isMd = fsPath.endsWith(".md") || fsPath.endsWith(".markdown");
  const isPlain = doc.languageId === "plaintext";
  const isMarkdown = doc.languageId === "markdown";
  return isPlain || isTxt || isMd || isMarkdown;
}

async function triggerLint(
  doc,
  collection,
  { mode = "command", reason = undefined } = {}
) {
  const enabled = vscode.workspace.getConfiguration("posNote.linter").get("enabled", false);
  if (!enabled) {
      collection.clear();
      updateIdleUIForDoc(doc);
      return;
  }

  try {
    if (mode === "save") {
      if (!shouldLintOnSave(doc.uri.toString(), reason)) {
        updateIdleUIForDoc(vscode.window.activeTextEditor?.document);
        return;
      }
    } else {
      if (!canLint(doc)) {
        vscode.window.showInformationMessage(
          "このファイルは lint 対象ではありません（.txt / plaintext / markdown）。"
        );
        updateIdleUIForDoc(doc);
        return;
      }
    }

    // Debounce: Abort ALL existing lint requests (ensure only latest request runs)
    for (const [oldDocUri, oldReqId] of currentLintReq.entries()) {
      if (linterWorker) {
        linterWorker.postMessage({ command: "abort", reqId: oldReqId });
        workerPending.delete(oldReqId);
        finishLintUI("Cancelled");
      }
    }
    currentLintReq.clear();

    // Start new lint (always increment counter)
    startLintUI("Linting...");

    // Track this request for potential abortion
    const docUri = doc.uri.toString();
    const newReqId = nextReqId; // Capture the reqId that will be used
    currentLintReq.set(docUri, newReqId);

    // Worker-based linting doesn't block main thread, so no delay needed
    if (vscode.window.activeTextEditor?.document !== doc) {
        channel.appendLine(`[lint] Cancelled: Active editor changed`);
        finishWithCachedCount(doc);
        return;
    }

    await lintActiveOnly(collection, doc);
  } catch (err) {
    channel.appendLine(`[error] triggerLint failed: ${err}`);
    vscode.window.showErrorMessage(`PosNote Linter Error (trigger): ${err}`);
    finishLintUI("Error");
  }
}

function toDiagnostics(uri, messages) {
  const diags = [];
  for (const m of messages) {
    const line = Math.max((m.loc?.start?.line || 1) - 1, 0);
    const colStart = Math.max((m.loc?.start?.column || 1) - 1, 0);
    const lineEnd = Math.max((m.loc?.end?.line || line + 1) - 1, line);
    const colEnd = Math.max(
      (m.loc?.end?.column || colStart + 1) - 1,
      colStart + 1
    );

    const range = new vscode.Range(line, colStart, lineEnd, colEnd);
    const severity =
      m.severity === 2
        ? vscode.DiagnosticSeverity.Error
        : m.severity === 1
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Information;

    const diag = new vscode.Diagnostic(range, m.message, severity);
    diag.source = "textlint";
    diag.code = m.ruleId || "textlint";
    diags.push(diag);
  }
  return diags;
}

function splitLines(s) {
  return s.replace(/\r/g, "").split("\n");
}

function computeChangedRanges(prevLines, nextLines) {
  let a = 0;
  const aMax = prevLines.length;
  const bMax = nextLines.length;

  while (a < aMax && a < bMax && prevLines[a] === nextLines[a]) a++;

  let ta = aMax - 1;
  let tb = bMax - 1;
  while (ta >= a && tb >= a && prevLines[ta] === nextLines[tb]) {
    ta--;
    tb--;
  }

  if (a > ta && a > tb) return [];
  const start = a;
  const end = tb;
  return [{ start, end }];
}

function expandToParagraphRanges(lines, ranges, context = 0) {
  const res = [];
  const n = lines.length;
  for (const r of ranges) {
    let s = Math.max(0, Math.min(n - 1, r.start));
    let e = Math.min(n - 1, r.end);
    while (s > 0 && lines[s - 1].trim() !== "") s--;
    while (e < n - 1 && lines[e + 1].trim() !== "") e++;
    s = Math.max(0, s - context);
    e = Math.min(n - 1, e + context);
    res.push({ start: s, end: e });
  }
  res.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const cur of res) {
    if (!merged.length || merged[merged.length - 1].end + 1 < cur.start) {
      merged.push({ ...cur });
    } else {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        cur.end
      );
    }
  }
  return merged;
}

function rangesFromPrevDiagnostics(lines, diagnostics) {
  if (!diagnostics || diagnostics.length === 0) return [];
  const ranges = diagnostics.map((d) => ({
    start: d.range.start.line,
    end: Math.max(d.range.end.line, d.range.start.line),
  }));
  return expandToParagraphRanges(lines, ranges, 0);
}

function mergeDiagnostics(oldDiags, newDiags, replacedRanges) {
  if (!oldDiags || oldDiags.length === 0) return newDiags;
  const keep = [];
  for (const d of oldDiags) {
    const s = d.range.start.line;
    const e = d.range.end.line;
    const hit = replacedRanges.some((r) => !(e < r.start || s > r.end));
    if (!hit) keep.push(d);
  }
  return keep.concat(newDiags).sort((a, b) => {
    if (a.range.start.line !== b.range.start.line)
      return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
}

// ===== 6) 実行本体（差分リント） =====
async function lintActiveOnly(collection, doc) {
  if (!doc) return;
  collection.clear();
  await lintDocumentIncremental(doc, collection);
}

async function lintDocumentIncremental(doc, collection) {
  try {
    if (!doc) return;
    const fsPath = doc.uri?.fsPath?.toLowerCase() || "";
    const isTxt = fsPath.endsWith(".txt");
    const isMd = fsPath.endsWith(".md") || fsPath.endsWith(".markdown");
    const isPlain = doc.languageId === "plaintext";
    const isMarkdown = doc.languageId === "markdown";
    if (!isPlain && !isTxt && !isMd && !isMarkdown) {
      finishWithCachedCount(doc);
      return;
    }
    if (doc.isUntitled) {
      finishWithCachedCount(doc);
      return;
    }

    // Note: UI update is handled by triggerLint, not here
    channel.appendLine(
      `[lint:start] ${doc.uri.fsPath} lang=${doc.languageId} isTxt=${isTxt}`
    );

    const fullText = doc.getText();
    const uri = doc.uri;
    const nextLines = splitLines(fullText);

    if (!fullText || fullText.trim().length === 0) {
      collection.set(uri, []);
      docCache.set(uri.toString(), { textLines: nextLines, diagnostics: [] });
      finishLintUI("0 iss");
      return;
    }

    const ext = doc.languageId === "markdown" || isMd ? ".md" : ".txt";
    const cacheKey = uri.toString();
    const cached = docCache.get(cacheKey);

    // Using WORKER for linting

    // 初回（キャッシュなし）→ 全文リント
    if (!cached) {
      const maskedText = maskCodeBlocks(fullText);
      const result = await lintTextWithWorker(maskedText, { filePath: uri.fsPath, ext });

      if (vscode.window.activeTextEditor?.document !== doc) {
          channel.appendLine(`[lint:skip] Result discarded (active editor changed)`);
          return;
      }

      const diagnostics = toDiagnostics(uri, result.messages || []);
      diagnostics.push(...findRepeatedPunctDiagnostics(uri, maskedText, 0));
      diagnostics.push(
        ...findExclamQuestionSpaceDiagnostics(uri, maskedText, 0)
      );
      collection.set(uri, diagnostics);
      docCache.set(cacheKey, { textLines: nextLines, diagnostics });
      channel.appendLine(
        `[lint:done] ${uri.fsPath} → ${diagnostics.length} 件 (full)`
      );
      finishLintUI(`${diagnostics.length} iss`);
      return;
    }

    // 差分レンジ（変更行）＋ 前回エラー行レンジ
    const changed = computeChangedRanges(cached.textLines, nextLines);
    const prevErr = rangesFromPrevDiagnostics(nextLines, cached.diagnostics);
    const contextLines = vscode.workspace
      .getConfiguration("posNote.linter")
      .get("incrementalContext", 2);

    let targetRanges = [];
    if (changed.length > 0) {
      const changedPara = expandToParagraphRanges(
        nextLines,
        changed,
        contextLines
      );
      targetRanges = changedPara;
    }
    if (prevErr.length > 0) {
      targetRanges = targetRanges.concat(prevErr);
    }

    targetRanges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const cur of targetRanges) {
      if (!merged.length || merged[merged.length - 1].end + 1 < cur.start) {
        merged.push({ ...cur });
      } else {
        merged[merged.length - 1].end = Math.max(
          merged[merged.length - 1].end,
          cur.end
        );
      }
    }

    if (merged.length === 0) {
      channel.appendLine(`[lint:skip] 差分が無いのでスキップ`);
      docCache.set(cacheKey, {
        textLines: nextLines,
        diagnostics: cached.diagnostics,
      });
      collection.set(uri, cached.diagnostics);
      finishLintUI(`${cached.diagnostics.length} iss`);
      return;
    }

    const newPartialDiagnostics = [];
    for (const r of merged) {
      if (vscode.window.activeTextEditor?.document !== doc) {
           break;
      }

      const sliceText = nextLines.slice(r.start, r.end + 1).join("\n");
      const initialFence = fenceStateBefore(nextLines, r.start);
      const maskedSlice = maskCodeBlocks(sliceText, initialFence);

      const res = await lintTextWithWorker(maskedSlice, { filePath: uri.fsPath, ext, docUri: uri.toString() });

      const adjusted = (res.messages || []).map((m) => {
        const msg = {
          ...m,
          loc: m.loc ? JSON.parse(JSON.stringify(m.loc)) : undefined,
        };
        if (msg.loc?.start) msg.loc.start.line += r.start;
        if (msg.loc?.end) msg.loc.end.line += r.start;
        return msg;
      });

      const diags = toDiagnostics(uri, adjusted);
      diags.push(...findRepeatedPunctDiagnostics(uri, maskedSlice, r.start));
      diags.push(
        ...findExclamQuestionSpaceDiagnostics(uri, maskedSlice, r.start)
      );

      newPartialDiagnostics.push(...diags);
    }

    if (vscode.window.activeTextEditor?.document !== doc) {
         channel.appendLine(`[lint:skip] Result discarded (active editor changed)`);
         finishWithCachedCount(doc);
         return;
    }

    const mergedDiagnostics = mergeDiagnostics(
      cached.diagnostics,
      newPartialDiagnostics,
      merged
    );

    channel.appendLine(
      `[lint:done] ${uri.fsPath} → ${mergedDiagnostics.length} 件 (partial ×${merged.length})`
    );

    collection.set(uri, mergedDiagnostics);
    docCache.set(cacheKey, {
      textLines: nextLines,
      diagnostics: mergedDiagnostics,
    });

    finishLintUI(`${mergedDiagnostics.length} iss`);
  } catch (err) {
    channel.appendLine(
      `[error] lintDocument 失敗: ${err && err.stack ? err.stack : String(err)}`
    );
    vscode.window.showErrorMessage(`PosNote Linter Error (doc): ${err}`);
    finishLintUI("Error");
  }
}

// ===== 7) エントリポイント =====
function activate(context) {
  ensureWorker(context);
  ensureStatusBar(context);
  updateIdleUIForDoc(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Abort any pending lint for non-active documents
      const activeDocUri = editor?.document.uri.toString();
      for (const [docUri, reqId] of currentLintReq.entries()) {
        if (docUri !== activeDocUri && linterWorker) {
          linterWorker.postMessage({ command: "abort", reqId });
          currentLintReq.delete(docUri);
          // Clean up workerPending to prevent stale results from being processed
          workerPending.delete(reqId);
          // Decrement lintRunning counter for aborted lint
          finishLintUI("Aborted");
        }
      }

      updateIdleUIForDoc(editor?.document);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("linter.showOutput", () => {
      try {
        channel.show(true);
      } catch {}
    })
  );

  const collection = vscode.languages.createDiagnosticCollection(
    "textlint-kernel-linter"
  );
  context.subscriptions.push(collection);

  context.subscriptions.push(
    vscode.commands.registerCommand("linter.lintActiveFile", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) {
        vscode.window.showInformationMessage(
          "アクティブなエディタがありません。"
        );
        return;
      }
      try {
        await triggerLint(doc, collection, { mode: "command" });
      } catch (e) {
        finishLintUI("Error");
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      lastSaveReason.set(e.document.uri.toString(), e.reason);
      // Note: UI update is handled by triggerLint, not here
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posNote.linter")) {
        invalidateKernelCache();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        const reason = lastSaveReason.get(doc.uri.toString());
        lastSaveReason.delete(doc.uri.toString());
        channel.appendLine(`[evt] onDidSaveTextDocument: ${doc.uri.fsPath}`);
        triggerLint(doc, collection, { mode: "save", reason }).catch((err) => {
          channel.appendLine(`[error] onDidSaveTextDocument async: ${err}`);
        });
      } catch (err) {
        channel.appendLine(`[error] onDidSaveTextDocument sync: ${err}`);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
