// セマンティックトークン周辺（エディタ）＋プレビュー用 HTML 生成（Webview）
// 依存: CommonJS（VS Code 拡張の Node ランタイム）

/* ========================================
 * 0) Imports
 * ====================================== */
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS (for Main Thread Cursor)
const { Worker } = require("worker_threads");
const { getHeadingLevel, loadNoteSettingForDoc } = require("./utils");

/* ========================================
 * 1) Semantic 定数・Legend
 * ====================================== */
const tokenTypesArr = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "particle",
  "auxiliary",
  "prenoun",
  "conjunction",
  "interjection",
  "symbol",
  "other",
  "bracket",
  "character",
  "glossary",
  "space",
  "heading",
  "fencecomment",
];
const tokenModsArr = ["proper", "prefix", "suffix"];

const semanticLegend = new vscode.SemanticTokensLegend(
  Array.from(tokenTypesArr),
  Array.from(tokenModsArr)
);
// ===== ローカル辞書（同じフォルダ限定）ユーティリティ =====
const fsPromises = fs.promises;

/* ========================================
 * 2) 全角括弧の対応表（検出用）
 * ====================================== */
const FW_BRACKET_MAP = new Map([
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["［", "］"],
  ["｛", "｝"],
  ["〈", "〉"],
  ["《", "》"],
  ["【", "】"],
  ["〔", "〕"],
  ["“", "”"],
  ["‘", "’"],
]);
const FW_CLOSE_SET = new Set(Array.from(FW_BRACKET_MAP.values()));

/* ========================================
 * 3) Kuromoji Tokenizer (For Cursor.js - Main Thread)
 * ====================================== */
let mainTokenizer = null;

async function ensureTokenizer(context) {
  if (mainTokenizer) return;
  try {
    let dictPath = path.join(
      context.extensionPath,
      "node_modules",
      "kuromoji",
      "dict"
    );

    if (!fs.existsSync(dictPath)) {
      dictPath = path.join(context.extensionPath, "dist", "dict");
    }

    if (!fs.existsSync(dictPath)) {
      console.warn("kuromoji dictionary not found at:", dictPath);
      return;
    }
    mainTokenizer = await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((err, tknz) => {
        if (err) reject(err);
        else resolve(tknz);
      });
    });
  } catch (err) {
    console.error("[POSNote] ensureTokenizer failed:", err);
  }
}

/* ========================================
 * 4) 汎用ヘルパ
 * ====================================== */

// notesetting.json 専用ローダ（同一フォルダのみ）に置換
const _noteSettingCache = new Map(); // key: dir -> { data, mtimeMs }
const _localDictCache = new Map(); // key: dir -> { key, chars:Set, glos:Set }

/** HTML エスケープ（最小限）。プレビュー/ツールチップの XSS 回避用。 */
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function _getSpaceColorFromSettings() {
  try {
    const editorCfg = vscode.workspace.getConfiguration("editor");
    const custom = editorCfg.get("semanticTokenColorCustomizations") || {};
    const rules = custom?.rules || {};
    const val = rules ? rules["space"] : null;
    if (!val) return null;
    if (typeof val === "string") return val;
    if (typeof val === "object") {
      if (val.highlight === true && typeof val.color === "string") {
        return val.color;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function _computeHeadingBlocks(document) {
  const blocks = [];
  const n = document.lineCount;
  const headingLines = [];
  for (let i = 0; i < n; i++) {
    const t = document.lineAt(i).text;
    if (/^\s*#{1,6}\s+/.test(t)) headingLines.push(i);
  }
  for (let idx = 0; idx < headingLines.length; idx++) {
    const start = headingLines[idx];
    const next = headingLines[idx + 1] ?? n;
    const end = Math.max(start, next - 1);
    blocks.push({ start, end });
  }
  return blocks;
}

async function _getCollapsedHeadingRanges(document) {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document === document
  );
  if (!editor) return [];

  /** @type {Array<{start: number, end: number, kind?: string}>} */
  const foldingRanges =
    (await vscode.commands.executeCommand(
      "vscode.executeFoldingRangeProvider",
      document.uri
    )) || [];

  const visible = new Array(document.lineCount).fill(false);
  for (const vr of editor.visibleRanges) {
    const s = Math.max(0, vr.start.line);
    const e = Math.min(document.lineCount - 1, vr.end.line);
    for (let ln = s; ln <= e; ln++) visible[ln] = true;
  }

  const headingBlocks = _computeHeadingBlocks(document);
  const collapsed = [];

  for (const hb of headingBlocks) {
    const h = hb.start;
    const blockFrom = h + 1;
    const blockTo = hb.end;
    if (blockFrom > blockTo) continue;

    if (!visible[h]) continue;
    if (visible[blockFrom]) continue;

    const overlapsFold = foldingRanges.some((fr) => {
      const frStart = Math.min(fr.start, fr.end ?? fr.start);
      const frEnd = Math.max(fr.start, fr.end ?? fr.start);
      return !(frEnd < blockFrom || blockTo < frStart);
    });

    if (!overlapsFold) continue;
    collapsed.push({ from: blockFrom, to: blockTo });
  }

  return _mergeRanges(collapsed);
}

function _mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a.from - b.from);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.from <= prev.to + 1) {
      prev.to = Math.max(prev.to, cur.to);
    } else {
      out.push({ from: cur.from, to: cur.to });
    }
  }
  return out;
}

function isInsideAnySegment(start, end, segs) {
  if (!segs || segs.length === 0) return false;
  for (const [s, e] of segs) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

function computeFenceRanges(doc) {
  const ranges = [];
  let inFence = false;
  let fenceStartPos = null;
  let ignoringMarkmap = false;

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (text.includes("```")) {
      if (!inFence) {
        inFence = true;
        const m = text.match(/```\s*([a-zA-Z0-9_\-\.]+)/);
        if (m && m[1] === "markmap") {
          ignoringMarkmap = true;
        } else {
          fenceStartPos = new vscode.Position(i, 0);
        }
      } else {
        if (!ignoringMarkmap && fenceStartPos) {
          const endPos = new vscode.Position(i, text.length);
          ranges.push(new vscode.Range(fenceStartPos, endPos));
        }
        inFence = false;
        fenceStartPos = null;
        ignoringMarkmap = false;
      }
    }
  }
  if (inFence && fenceStartPos && !ignoringMarkmap) {
    const lastLine = doc.lineCount - 1;
    const endPos = new vscode.Position(
      lastLine,
      doc.lineAt(lastLine).text.length
    );
    ranges.push(new vscode.Range(fenceStartPos, endPos));
  }
  return ranges;
}

function computeFullwidthQuoteRanges(doc) {
  const text = doc.getText();
  const ranges = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const close = FW_BRACKET_MAP.get(ch);
    if (close) {
      stack.push({ expectedClose: close, openOffset: i });
      continue;
    }
    if (FW_CLOSE_SET.has(ch)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (ch === top.expectedClose) {
          stack.pop();
          const startPos = doc.positionAt(top.openOffset);
          const endPos = doc.positionAt(i + 1);
          ranges.push(new vscode.Range(startPos, endPos));
        }
      }
    }
  }
  return ranges;
}

/* ========================================
 * 5) 同一フォルダの notesetting.json を読むユーティリティ
 * ====================================== */
async function loadWordsFromNoteSetting(source) {
  try {
    let json = null;
    if (typeof source === "string") {
      const txt = await fs.promises.readFile(source, "utf8");
      json = JSON.parse(txt);
    } else if (source && typeof source === "object") {
      json = source;
    }
    if (!json) return { chars: new Set(), glos: new Set() };

    const buildSet = (val, charMode) => {
      const put = (set, s) => {
        const v = String(s ?? "").trim();
        if (v) set.add(v);
      };
      /** @type {Set<string>} */ const out = new Set();
      if (!val) return out;

      if (Array.isArray(val)) {
        if (val.length && typeof val[0] === "string") {
          for (const s of val) put(out, s);
        } else {
          for (const it of val) {
            if (!it) continue;
            if (charMode) {
              if (it.name) put(out, it.name);
              if (Array.isArray(it.alias)) it.alias.forEach((x) => put(out, x));
            } else {
              if (it.term) put(out, it.term);
              if (Array.isArray(it.variants))
                it.variants.forEach((x) => put(out, x));
            }
          }
        }
      } else if (val && typeof val === "object") {
        for (const k of Object.keys(val)) {
          put(out, k);
          const v = val[k];
          if (charMode) {
            if (v && Array.isArray(v.alias))
              v.alias.forEach((x) => put(out, x));
          } else {
            if (v && Array.isArray(v.variants))
              v.variants.forEach((x) => put(out, x));
          }
        }
      }
      return out;
    };

    const chars = buildSet(json.characters, true);
    const glos = buildSet(json.glossary, false);
    return { chars, glos };
  } catch {
    return { chars: new Set(), glos: new Set() };
  }
}

async function loadLocalDictForDoc(docUri) {
  try {
    const dir = path.dirname(docUri.fsPath);
    const cache = _localDictCache.get(dir);

    // Check notesetting cache first
    let data, mtimeMs;
    if (_noteSettingCache.has(dir)) {
      ({ data, mtimeMs } = _noteSettingCache.get(dir));
    } else {
      // Cache miss - load from disk
      ({ data, mtimeMs } = await loadNoteSettingForDoc({ uri: docUri }));
      _noteSettingCache.set(dir, { data, mtimeMs });
    }

    const key = data ? `note:${mtimeMs}` : "none";

    if (cache && cache.key === key) {
      return cache.val;
    }

    let chars = new Set();
    let glos = new Set();
    if (data) {
      const { chars: c, glos: g } = await loadWordsFromNoteSetting(data);
      chars = c;
      glos = g;
    }

    const needles = [];
    for (const w of chars) needles.push({ w, k: "character" });
    for (const w of glos) needles.push({ w, k: "glossary" });
    needles.sort((a, b) => b.w.length - a.w.length);

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = needles.map((n) => escapeRe(n.w)).join("|");
    const regex = pattern ? new RegExp(pattern, "g") : null;

    const kindMap = new Map();
    for (const { w, k } of needles) {
      if (!kindMap.has(w)) kindMap.set(w, k);
    }

    const val = { chars, glos, regex, kindMap };
    _localDictCache.set(dir, { key, val });
    return val;
  } catch {
    return { chars: new Set(), glos: new Set(), regex: null, kindMap: new Map() };
  }
}

function matchDictRanges(lineText, regex, kindMap) {
  const res = [];
  if (!lineText || !regex) return res;

  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(lineText)) !== null) {
    const w = m[0];
    const kind = kindMap.get(w) || "other";
    res.push({ start: m.index, end: m.index + w.length, kind });
  }
  return res;
}

function subtractMaskedIntervals(A, mask) {
  if (!A || A.length === 0) return [];
  if (!mask || mask.length === 0) return A.slice();

  const out = [];

  for (const [as, ae] of A) {
    let cur = [[as, ae]];
    for (const m of mask) {
      const next = [];
      for (const [s, e] of cur) {
        if (e <= m.start || m.end <= s) {
          next.push([s, e]);
          continue;
        }
        if (s < m.start) next.push([s, Math.max(s, m.start)]);
        if (m.end < e) next.push([Math.min(e, m.end), e]);
      }
      cur = next;
      if (cur.length === 0) break;
    }
    out.push(...cur);
  }

  out.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const seg of out) {
    if (!merged.length || merged[merged.length - 1][1] < seg[0]) {
      merged.push(seg);
    } else {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        seg[1]
      );
    }
  }
  return merged;
}

/* ========================================
 * 6) エディタ側 Semantic Provider (Workerized)
 * ====================================== */

// Worker State
let semanticWorker = null;
let nextReqId = 1;
const workerPending = new Map();

function ensureWorker(context) {
  if (semanticWorker) return;
  let scriptPath = path.join(context.extensionPath, "dist", "worker", "semanticWorker.js");
  if (!fs.existsSync(scriptPath)) {
      scriptPath = path.join(context.extensionPath, "src", "worker", "semanticWorker.js");
  }
  semanticWorker = new Worker(scriptPath);

  semanticWorker.on("message", (msg) => {
    if (msg.command === "init_complete") {
      console.log("[SemanticWorker Main] Worker init complete");
    } else if (msg.command === "tokenize_result") {
      const p = workerPending.get(msg.reqId);
      if (p) {
        workerPending.delete(msg.reqId);
        p.resolve(msg.data); // data is Uint32Array
      }
    } else if (msg.command === "error") {
      console.error("[SemanticWorker Main] worker error:", msg.error);
    }
  });

  semanticWorker.on("error", (err) => {
      console.error("[SemanticWorker Main] FATAL:", err);
  });

  // Calculate reliable dict path
  let dictPath = path.join(context.extensionPath, "dist", "dict");
  if (!fs.existsSync(dictPath)) {
      dictPath = path.join(context.extensionPath, "node_modules", "kuromoji", "dict");
  }

  console.log("[SemanticWorker Main] Spawning worker at:", scriptPath);
  console.log("[SemanticWorker Main] Using dict path:", dictPath);
  semanticWorker.postMessage({ command: "init", dictPath });
}

function tokenizeWithWorker(lines, cancelToken) {
  if (!semanticWorker) {
      console.warn("[SemanticWorker Main] Worker not ready");
      return Promise.resolve(new Uint32Array());
  }
  return new Promise((resolve, reject) => {
    const reqId = nextReqId++;
    workerPending.set(reqId, { resolve, reject });

    // Cleanup if cancelled
    if (cancelToken) {
        cancelToken.onCancellationRequested(() => {
            if (workerPending.has(reqId)) {
                workerPending.delete(reqId);
                semanticWorker.postMessage({ command: "abort", reqId });
                resolve(new Uint32Array()); // Resolve empty on cancel
            }
        });
    }

    semanticWorker.postMessage({ command: "tokenize", reqId, lines });
  });
}


class JapaneseSemanticProvider {
  constructor(context, opt) {
    this._context = context;
    this._cfg = opt?.cfg ?? (() => ({}));
    this._onDidChangeSemanticTokens = new vscode.EventEmitter();
    this.onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

    ensureWorker(context);

    const wNote = vscode.workspace.createFileSystemWatcher(
      "**/notesetting.json"
    );
    const fireAndInvalidateDict = (uri) => {
      const dir = path.dirname(uri.fsPath);
      // Invalidate both notesetting cache and dictionary cache
      _noteSettingCache.delete(dir);
      _localDictCache.delete(dir);
      this._onDidChangeSemanticTokens.fire();
    };
    context.subscriptions.push(
      wNote.onDidCreate(fireAndInvalidateDict),
      wNote.onDidChange(fireAndInvalidateDict),
      wNote.onDidDelete(fireAndInvalidateDict)
    );

    this._spaceDecoration = null;
    this._spaceColor = null;
    this._spaceRangesByDoc = new Map();

    this._brDecoration = null;
    this._brRangesByDoc = new Map();
    this._brHighlightEnabled = false;

    context.subscriptions.push(
      vscode.commands.registerCommand("posNote.semantic.setBrHighlight", (enabled) => {
        this._brHighlightEnabled = !!enabled;
        this._onDidChangeSemanticTokens.fire();

        if (!this._brHighlightEnabled) {
             for (const ed of vscode.window.visibleTextEditors) {
               const key = ed.document.uri.toString();
               this._brRangesByDoc.set(key, []);
               if (this._brDecoration) ed.setDecorations(this._brDecoration, []);
             }
        }
      })
    );

    // Cache: docUri -> { map: Map<line, Uint32Array>, version: number, pendingBg: boolean }
    this._docCache = new Map();
    this._bgScanCts = new Map(); // uri -> CancellationTokenSource

    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const docKey = doc.uri.toString();
        this._spaceRangesByDoc.delete(docKey);
        this._docCache.delete(docKey);
        this._brRangesByDoc.delete(docKey);

        // Cancel background scan if running
        if (this._bgScanCts.has(docKey)) {
            this._bgScanCts.get(docKey).cancel();
            this._bgScanCts.delete(docKey);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
          // Incremental Cache Invalidation
          const docKey = e.document.uri.toString();
          if (!this._docCache.has(docKey)) return;
          const entry = this._docCache.get(docKey);

          // If line count changed (insert/delete lines), full invalidation is safest for now
          // (To support accurate shift, we'd need to shift Map keys which is expensive)
          if (e.contentChanges.some(c => c.range.start.line !== c.range.end.line || c.text.includes('\n'))) {
              entry.map.clear();
              entry.decorationCache.clear();
          } else {
              // Just single line edits
              for (const c of e.contentChanges) {
                  for (let ln = c.range.start.line; ln <= c.range.end.line; ln++) {
                      entry.map.delete(ln);
                      entry.decorationCache.delete(ln);
                  }
              }
          }
          entry.version = e.document.version;
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
          // Cancel background scans for all documents except the newly active one
          if (!editor) return;
          const activeDocKey = editor.document.uri.toString();
          for (const [docKey, cts] of this._bgScanCts.entries()) {
              if (docKey !== activeDocKey) {
                  cts.cancel();
                  this._bgScanCts.delete(docKey);
              }
          }
      })
    );
  }

  _ensureSpaceDecoration() {
    const color = _getSpaceColorFromSettings();
    if (!color) {
      if (this._spaceDecoration) {
        this._spaceDecoration.dispose();
      }
      this._spaceDecoration = null;
      this._spaceColor = null;
      this._spaceRangesByDoc.clear();
      return null;
    }

    if (this._spaceDecoration && this._spaceColor === color) {
      return this._spaceDecoration;
    }

    if (this._spaceDecoration) {
      this._spaceDecoration.dispose();
    }

    this._spaceDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color,
      borderRadius: "2px",
    });
    this._spaceColor = color;
    return this._spaceDecoration;
  }

  _applySpaceDecorations(document, fromLine, toLine, rangesForWindow) {
    const deco = this._ensureSpaceDecoration();
    if (!deco) return;

    const key = document.uri.toString();
    const prev = this._spaceRangesByDoc.get(key) || [];
    const kept = prev.filter(
      (r) => r.start.line < fromLine || r.start.line > toLine
    );
    const next = kept.concat(rangesForWindow);
    this._spaceRangesByDoc.set(key, next);

    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document === document) {
        ed.setDecorations(deco, next);
      }
    }
  }

  _ensureBrDecoration() {
    if (this._brDecoration) return this._brDecoration;
    this._brDecoration = vscode.window.createTextEditorDecorationType({
      color: "#ff0000",
      fontWeight: "bold"
    });
    return this._brDecoration;
  }

  _applyBrDecorations(document, fromLine, toLine, rangesForWindow) {
    const deco = this._ensureBrDecoration();
    const key = document.uri.toString();
    const prev = this._brRangesByDoc.get(key) || [];
    const kept = prev.filter(
      (r) => r.start.line < fromLine || r.start.line > toLine
    );
    const next = kept.concat(rangesForWindow);
    this._brRangesByDoc.set(key, next);

    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document === document) {
        ed.setDecorations(deco, next);
      }
    }
  }

  _legend() {
    return semanticLegend;
  }

  fireDidChange() {
    this._onDidChangeSemanticTokens.fire();
  }

  _getOrComputeRanges(document) {
    if (!this._rangeCache) {
      this._rangeCache = new Map();
    }

    const key = document.uri.toString();
    const cached = this._rangeCache.get(key);

    if (cached && cached.version === document.version) {
      return cached.data;
    }

    const fenceRanges = computeFenceRanges(document);
    const bracketSegsByLine = new Map();

    const pairs = computeFullwidthQuoteRanges(document);
    for (const r of pairs) {
      const sL = r.start.line,
        eL = r.end.line;
      for (let ln = sL; ln <= eL; ln++) {
        const lineText = document.lineAt(ln).text;
        const sCh = ln === sL ? r.start.character : 0;
        const eCh = ln === eL ? r.end.character : lineText.length;
        if (eCh > sCh) {
          const arr = bracketSegsByLine.get(ln) || [];
          arr.push([sCh, eCh]);
          bracketSegsByLine.set(ln, arr);
        }
      }
    }

    const data = { fenceRanges, bracketSegsByLine };
    this._rangeCache.set(key, { version: document.version, data });

    if (this._rangeCache.size > 20) {
      this._rangeCache.clear();
      this._rangeCache.set(key, { version: document.version, data });
    }

    return data;
  }

  async _buildTokens(document, range, cancelToken) {
    const c = this._cfg();
    if (cancelToken?.isCancellationRequested) {
        return new vscode.SemanticTokens(new Uint32Array());
    }

    // 0. Pre-calculate keys
    const docKey = document.uri.toString();
    const lang = (document.languageId || "").toLowerCase();

    // Debounce: Wait for typing to settle (using posNote.debounceMs)
    // BUT skip debounce if this is the first load (no cache) to ensure instant open
    if (this._docCache.has(docKey)) {
        const debounceMs = c.debounceMs || 500;
        await new Promise(resolve => setTimeout(resolve, debounceMs));
        if (cancelToken?.isCancellationRequested) {
            return new vscode.SemanticTokens(new Uint32Array());
        }
    }

    if (lang === "markdown" && !c.semanticEnabledMd) return new vscode.SemanticTokens(new Uint32Array());
    if (lang !== "markdown" && !c.semanticEnabled) return new vscode.SemanticTokens(new Uint32Array());

    // 1. Prepare Doc Cache
    if (!this._docCache.has(docKey)) {
        this._docCache.set(docKey, {
            map: new Map(),
            decorationCache: new Map(),  // Per-line decoration cache
            version: document.version,
            pendingBg: false
        });

        // Cancel any stale background scan for this doc (new initial load overrides old bg)
        if (this._bgScanCts.has(docKey)) {
            this._bgScanCts.get(docKey).cancel();
            this._bgScanCts.delete(docKey);
        }
    }
    const cacheEntry = this._docCache.get(docKey);
    // Explicitly update version, but DO NOT clear map here since invalidation is handled by onDidChangeTextDocument
    cacheEntry.version = document.version;
    const tokenMap = cacheEntry.map;
    const decorationCache = cacheEntry.decorationCache;

    // 2. Identify all lines that need tokenization (Priority + Background)
    const linesToRequest = [];
    const bgLinesToRequest = [];

    // Priority Range: Cursor +/- 100 lines
    const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
    const cursorLine = editor ? editor.selection.active.line : 0;
    const priorityStart = Math.max(0, cursorLine - 100);
    const priorityEnd = Math.min(document.lineCount - 1, cursorLine + 100);

    for (let ln = 0; ln < document.lineCount; ln++) {
        // Check cache validity (only checks existence in map, version diff handled by clearing map)
        if (!tokenMap.has(ln)) {
             const text = document.lineAt(ln).text;
             const item = { lineIndex: ln, text };

             // If we are in the priority range, request immediately
             if (ln >= priorityStart && ln <= priorityEnd) {
                 linesToRequest.push(item);
             } else {
                 bgLinesToRequest.push(item);
             }
        }
    }

    // 3. Request Worker (Priority) - Await this immediately
    if (linesToRequest.length > 0) {
        // console.log(`[Semantic] Requesting Priority ${linesToRequest.length} lines`);
        const buffer = await tokenizeWithWorker(linesToRequest, cancelToken);
        if (cancelToken?.isCancellationRequested) return new vscode.SemanticTokens(new Uint32Array());

        // decode buffer
        for (let i = 0; i < buffer.length; i += 5) {
            const ln = buffer[i];
            const data = buffer.slice(i + 1, i + 5);
            if (!tokenMap.has(ln)) tokenMap.set(ln, []);
            tokenMap.get(ln).push(data);
        }
        // Mark checked lines
        for (const item of linesToRequest) {
            if (!tokenMap.has(item.lineIndex)) tokenMap.set(item.lineIndex, []);
        }
    }

    // 4. Request Worker (Background) - Do NOT await. Fire and forget.
    if (bgLinesToRequest.length > 0) {
         // If a BG scan is already running for this doc, cancel and start new one
         if (this._bgScanCts.has(docKey)) {
             this._bgScanCts.get(docKey).cancel();
             this._bgScanCts.delete(docKey);
         }

         const bgCts = new vscode.CancellationTokenSource();
         this._bgScanCts.set(docKey, bgCts);

         // console.log(`[Semantic] Requesting Background ${bgLinesToRequest.length} lines`);

         tokenizeWithWorker(bgLinesToRequest, bgCts.token).then(buffer => {
             if (bgCts.token.isCancellationRequested) return;

             // Apply tokens
             for (let i = 0; i < buffer.length; i += 5) {
                 const ln = buffer[i];
                 const data = buffer.slice(i + 1, i + 5);
                 if (!tokenMap.has(ln)) tokenMap.set(ln, []);

                 // Safety: Check if doc entry still exists (might be closed)
                 if (!this._docCache.has(docKey)) return;

                 tokenMap.get(ln)?.push(data);
             }

             // Mark empty
             for (const item of bgLinesToRequest) {
                  if (this._docCache.has(docKey) && !tokenMap.has(item.lineIndex)) {
                       tokenMap.set(item.lineIndex, []);
                  }
             }

             // Cleanup CTS
             if (this._bgScanCts.get(docKey) === bgCts) {
                 this._bgScanCts.delete(docKey);
             }

             // Trigger refresh to render background tokens
             this._onDidChangeSemanticTokens.fire();
         });
    }

    // Now build tokens from Cache + Main Logic (Fences/Dicts)
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);

    // Now build tokens from Cache + Main Logic (Fences/Dicts)
    const builder = new vscode.SemanticTokensBuilder(semanticLegend);

    // Helpers
    let dictRegex = null;
    let dictKindMap = new Map();
    const noteLoaded = await loadLocalDictForDoc(document.uri);
    if (noteLoaded) {
      dictRegex = noteLoaded.regex;
      dictKindMap = noteLoaded.kindMap;
    }

    let foldedLineFlags = new Uint8Array(document.lineCount);
    try {
      const foldedRanges = await _getCollapsedHeadingRanges(document);
      for (const r of foldedRanges) {
         for (let ln = r.from; ln <= r.to; ln++) foldedLineFlags[ln] = 1;
      }
    } catch {}

    const idxBracket = tokenTypesArr.indexOf("bracket");
    const idxChar = tokenTypesArr.indexOf("character");
    const idxGlossary = tokenTypesArr.indexOf("glossary");
    const idxFence = tokenTypesArr.indexOf("fencecomment");

    const { fenceRanges, bracketSegsByLine } = this._getOrComputeRanges(document);
    const fenceSegsByLine = new Map();
    for (const r of fenceRanges) {
         for (let ln = r.start.line; ln <= r.end.line; ln++) {
            if (ln < startLine || ln > endLine) continue;
            const lineText = document.lineAt(ln).text;
            const sCh = ln === r.start.line ? r.start.character : 0;
            const eCh = ln === r.end.line ? r.end.character : lineText.length;
            if (eCh > sCh) {
                 const arr = fenceSegsByLine.get(ln) || [];
                 arr.push([sCh, eCh]);
                 fenceSegsByLine.set(ln, arr);
            }
         }
    }

    const spaceDecoRanges = [];
    const brDecoRanges = [];
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;

    for (let line = startLine; line <= endLine; line++) {
       if (cancelToken?.isCancellationRequested) break;

       // Check decoration cache first
       let text, dictRanges, spaceRanges, brRanges, dashRanges;
       const cached = decorationCache.get(line);

       if (cached) {
           // Use cached decorations
           text = cached.text;
           dictRanges = cached.dictRanges || [];
           spaceRanges = cached.spaceRanges || [];
           brRanges = cached.brRanges || [];
           dashRanges = cached.dashRanges || [];
       } else {
           // Compute decorations (cache miss or invalidated)
           text = document.lineAt(line).text;

           // Dictionary matching
           dictRanges = matchDictRanges(text, dictRegex, dictKindMap);

           // Space detection
           spaceRanges = [];
           const fenceSegs = fenceSegsByLine.get(line) || [];
           const restForLine = (segments) => subtractMaskedIntervals([[0, text.length]], segments.map(([s, e]) => ({ start: s, end: e })));
           const nonFenceSpans = restForLine(fenceSegs);
           const dictRangesOutsideFence = subtractMaskedIntervals(
               dictRanges.map((r) => [r.start, r.end]),
               fenceSegs.map(([s, e]) => ({ start: s, end: e }))
           ).map(([s, e]) => ({ start: s, end: e }));
           const mask = dictRangesOutsideFence;
           const spansAfterDict = subtractMaskedIntervals(nonFenceSpans, mask);

           // Half-width spaces
           const reHalf = / +/g;
           let mHalf;
           while ((mHalf = reHalf.exec(text)) !== null) {
               if (mHalf[0].length % 2 === 1) {
                   const s = mHalf.index + mHalf[0].length - 1;
                   const e = s + 1;
                   if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
                       spaceRanges.push([s, e]);
                   }
               }
           }
           // Full-width spaces
           const reFull = /　/g;
           let mFull;
           while ((mFull = reFull.exec(text)) !== null) {
               const s = mFull.index;
               const e = s + 1;
               if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
                   spaceRanges.push([s, e]);
               }
           }

           // BR tags
           brRanges = [];
           if (this._brHighlightEnabled) {
               const brRe = /<br>/gi;
               let mBr;
               while ((mBr = brRe.exec(text)) !== null) {
                   brRanges.push([mBr.index, mBr.index + mBr[0].length]);
               }
           }

           // Dash symbols
           dashRanges = [];
           const reDash = /[—―]/g;
           let m;
           while ((m = reDash.exec(text)) !== null) {
               const s = m.index;
               const e = s + m[0].length;
               if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
                   const segs = bracketSegsByLine.get(line) || [];
                   if (!isInsideAnySegment(s, e, segs)) {
                       dashRanges.push([s, e]);
                   }
               }
           }

           // Store in cache
           decorationCache.set(line, {
               text,
               dictRanges,
               spaceRanges,
               brRanges,
               dashRanges
           });
       }

       // Apply decorations using cached or computed values
       if (c.headingSemanticEnabled && (lang === "plaintext" || lang === "novel" || lang === "markdown")) {
           const lvl = getHeadingLevel(text);
           if (lvl > 0) {
               builder.push(line, 0, text.length, tokenTypesArr.indexOf("heading"), 0);
               continue;
           }
       }

       // BR decorations
       for (const [s, e] of brRanges) {
           brDecoRanges.push(new vscode.Range(line, s, line, e));
       }

       const fenceSegs = fenceSegsByLine.get(line) || [];
       const isMd = lang === "markdown";
       for (const [sCh, eCh] of fenceSegs) {
           const len = eCh - sCh;
           if (len > 0 && !isMd) builder.push(line, sCh, len, idxFence, 0);
       }

       // Dictionary ranges
       for (const r of dictRanges) {
           if (isInsideAnySegment(r.start, r.end, fenceSegs)) continue;
           const typeIdx = r.kind === "character" ? idxChar : idxGlossary;
           builder.push(line, r.start, r.end - r.start, typeIdx, 0);
       }

       // Space decorations
       for (const [s, e] of spaceRanges) {
           spaceDecoRanges.push(new vscode.Range(new vscode.Position(line, s), new vscode.Position(line, e)));
       }

       // Dash ranges
       for (const [s, e] of dashRanges) {
           const tIdx = bracketOverrideOn ? idxBracket : tokenTypesArr.indexOf("symbol");
           builder.push(line, s, e - s, tIdx, 0);
       }

       if (bracketOverrideOn) {
           const segs = bracketSegsByLine.get(line);
           if (segs?.length) {
                const segsOutsideFence = subtractMaskedIntervals(segs, fenceSegs.map(([s,e])=>({start:s,end:e})));
                // Recompute dictRangesOutsideFence for bracket masking
                const dictRangesOutsideFence = subtractMaskedIntervals(
                    dictRanges.map((r) => [r.start, r.end]),
                    fenceSegs.map(([s, e]) => ({ start: s, end: e }))
                ).map(([s, e]) => ({ start: s, end: e }));
                const maskForBracket = dictRangesOutsideFence.concat(spaceRanges.map(([s, e]) => ({ start: s, end: e })));
                const rest = subtractMaskedIntervals(segsOutsideFence, maskForBracket);
                for (const [sCh, eCh] of rest) {
                    builder.push(line, sCh, eCh - sCh, idxBracket, 0);
                }
           }
       }

       // POS from Worker
       const workerTokens = tokenMap.get(line);
       if (workerTokens && text.trim()) {
          // Flattened tokens: [Uint32Array(4), ...]
          for (const tData of workerTokens) {
             const start = tData[0];
             const length = tData[1];
             const typeIdx = tData[2];
             const mods = tData[3];
             const end = start + length;

             // Fence Check
             if (fenceSegs && fenceSegs.length > 0) {
                 let inFence = false;
                 for (const [fs, fe] of fenceSegs) {
                     if (start >= fs && end <= fe) { inFence = true; break; }
                 }
                 if (inFence) continue;
             }

             // Dict Mask Check
             if (dictRanges.some(R => !(end <= R.start || R.end <= start))) continue;

             // Bracket Override Check
             if (bracketOverrideOn) {
                 const segs = bracketSegsByLine.get(line);
                 if (isInsideAnySegment(start, end, segs)) continue;
             }

             builder.push(line, start, length, typeIdx, mods);
          }
       }
    }

    this._applySpaceDecorations(document, startLine, endLine, spaceDecoRanges);
    this._applyBrDecorations(document, startLine, endLine, brDecoRanges);

    return builder.build();
  }

  async provideDocumentSemanticTokens(document, token) {
     return this._buildTokens(document, new vscode.Range(0, 0, document.lineCount, 0), token);
  }

  async provideDocumentRangeSemanticTokens(document, range, token) {
      // Context Expansion (+/- 5 lines) logic can be applied here,
      // but _buildTokens does the heavy lifting of cache checking.
      // If we ask for range + context, _buildTokens will fetch missing context lines.
      // So checking context is just widening the range passed to _buildTokens?
      // No, `provideDocumentRangeSemanticTokens` expects result for `range` ONLY.
      // But we can trigger fetching for context in background?
      // Or just ensuring context is loaded in cache?
      // Since `_buildTokens` logic already checks all lines in range against cache,
      // we can simply pre-fetch context lines if we wanted.
      // But the User wants "Edit -> Re-scan surrounding +/- 5 lines".
      // When edit happens, VSCode invalidates tokens and asks again.
      // It might ask for the whole doc or range.
      // If it asks for range, we should make sure we re-tokenize the context.

      // WAIT: `onDidChangeSemanticTokens` fires -> VSCode asks for tokens.
      // If we want to FORCE update of neighbors, we should have invalidated them in cache or fired event.
      // Since we clear cache on version change, we naturally re-scan everything requested.
      // The issue is: Does VS Code request *only* the edited line?
      // Usually yes.
      // If we want to guarantee neighbors are re-scanned (for Context-aware POS),
      // we need to make sure `semanticWorker` gets the neighbor lines text to enable "Context" logic (later).
      // BUT current `semanticWorker` treats line-by-line independently (tokenize(text)).
      // So expanding range doesn't help POS accuracy *unless* `semanticWorker` joins lines.
      // User said: "変更時周辺再スキャン" (Re-scan surroundings on change).
      // If `semanticWorker` is line-independent, this is just for making sure neighbors are valid?
      // Ah, User might assume future context-aware logic or just wants to be safe from broken tokens at boundary.
      // Let's expand the range passed to _buildTokens to include context,
      // BUT we must filter the builder output to only return what VS Code asked?
      // Actually VS Code accepts tokens outside range usually, or we can clamp.

      const start = Math.max(0, range.start.line - 5);
      const end = Math.min(document.lineCount - 1, range.end.line + 5);
      // We process the expanded range to ensure cache is hot for neighbors.
      // But we strictly return builder for the requested range?
      // Let's just return the expanded range. VS Code usually handles it fine.

      return this._buildTokens(document, new vscode.Range(start, 0, end, 0), token);
  }
}

/* ========================================
 * 9) Exports
 * ====================================== */
module.exports = {
  JapaneseSemanticProvider,
  semanticLegend,
  tokenTypesArr,
  getTokenizer: () => mainTokenizer, // Main thread tokenizer for cursor
  ensureTokenizer, // Exported so extension can call it
};
