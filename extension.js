// ===========================================
//  日本語 品詞ハイライト（Semantic）＋ページカウンタ
//  - kuromoji: 形態素解析（行単位）→ Semantic Tokens で着色
//  - ページカウンタ: 原稿用紙風（行×列 + 禁則）をステータスバー表示
//  - パフォーマンス: 入力中は UI だけ軽く更新、重い再計算はアイドル時/保存時
// ===========================================

// ===== 1) imports =====
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS

// ===== 1-1) セマンティック定義・固定定数 =====
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
  "fwspace",
  "heading",
];
const tokenModsArr = ["proper", "prefix", "suffix"];
const semanticLegend = new vscode.SemanticTokensLegend(
  Array.from(tokenTypesArr),
  Array.from(tokenModsArr)
);

const DEFAULT_BANNED_START = [
  "」",
  "）",
  "『",
  "』",
  "》",
  "】",
  "。",
  "、",
  "’",
  "”",
  "！",
  "？",
  "…",
  "—",
  "―",
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゃ",
  "ゅ",
  "ょ",
  "っ",
  "ー",
  "々",
  "ゞ",
  "ゝ",
  "ァ",
  "ィ",
  "ゥ",
  "ェ",
  "ォ",
  "ャ",
  "ュ",
  "ョ",
  "ッ",
];

// 全角の開き括弧 → 閉じ括弧
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

// 入力補助フラグ
let _insertingFwClose = false; // 再入防止（自動クローズ）
const _prevTextByUri = new Map(); // Backspace用、直前スナップショット
let _deletingPair = false; // 再入防止（Backspaceペア削除）

// ===== 2) state =====
let tokenizer = null; // kuromoji tokenizer
let debouncer = null; // 軽い UI 更新
let idleRecomputeTimer = null; // 重い再計算の遅延実行
let enabledPage = true; // ページカウンタ ON/OFF
let statusBarItem = null; // ステータスバー
let m = null; // メトリクスキャッシュ

// 合算文字数のキャッシュ（アクティブ文書の「ディレクトリ+拡張子」をキー）
let combinedCharsCache = {
  key: null, // 例: "/path/to/dir::.txt"
  value: null, // 数値（null は未計算/非対象）
};

// 全折/全展開のトグル状態（docごと）
let foldToggledByDoc = new Map(); // key: uriString, value: boolean（true=折りたたみ中）
let foldDocVersionAtFold = new Map(); // key: uri, value: document.version

// ===== 3) 設定ヘルパ =====
function getBannedStart() {
  const config = vscode.workspace.getConfiguration("posPage");
  const userValue = config.get("kinsoku.bannedStart");
  return Array.isArray(userValue) && userValue.length > 0
    ? userValue
    : DEFAULT_BANNED_START;
}

function cfg() {
  const c = vscode.workspace.getConfiguration("posPage");
  return {
    semanticEnabled: c.get("semantic.enabled", true),
    semanticEnabledMd: c.get("semantic.enabledMd", true),
    applyToTxtOnly: c.get("applyToTxtOnly", true),
    debounceMs: c.get("debounceMs", 500), // 軽いUI更新
    recomputeIdleMs: c.get("recomputeIdleMs", 1200), // 重い再計算
    enabledPage: c.get("enabledPage", true),
    rowsPerPage: c.get("page.rowsPerPage", 20),
    colsPerRow: c.get("page.colsPerRow", 20),
    kinsokuEnabled: c.get("kinsoku.enabled", true),
    kinsokuBanned: getBannedStart(), // settings.json 優先
    showCombined: c.get("aggregate.showCombinedChars", true),
    headingFoldEnabled: c.get("headings.folding.enabled", true),
    headingSemanticEnabled: c.get("headings.semantic.enabled", true),
    headingFoldMinLevel: c.get("headings.foldMinLevel", 2),
  };
}

// 対象ドキュメント判定
function isTargetDoc(doc, c) {
  if (!doc) return false;
  if (!c.applyToTxtOnly) return true;

  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isPlain = lang === "plaintext" || fsPath.endsWith(".txt");
  const isMd = lang === "markdown" || fsPath.endsWith(".md");
  const isNovel = lang === "novel"; // Novel拡張互換

  return isPlain || isMd || isNovel;
}

// ===== 4) tokenizer loader =====
async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict"); // 拡張直下の dict/
  console.log("[pos-page] dict path:", dictPath);
  if (!fs.existsSync(dictPath)) {
    vscode.window.showErrorMessage(
      "kuromoji の辞書が見つかりません。拡張直下の 'dict/' を配置してください。"
    );
    return;
  }
  tokenizer = await new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: dictPath }).build((err, tknz) => {
      if (err) reject(err);
      else resolve(tknz);
    });
  });
}

// ===== 5) ページカウンタ・コア =====

// 改行(LF)を除いたコードポイント数
function countCharsNoLF(text) {
  return Array.from(text.replace(/\r\n/g, "\n")).filter((ch) => ch !== "\n")
    .length;
}

// 複数選択に対応して合計文字数
function countSelectedChars(doc, selections) {
  let sum = 0;
  for (const sel of selections) {
    if (!sel.isEmpty) {
      const t = doc.getText(sel);
      sum += countCharsNoLF(t);
    }
  }
  return sum;
}

// 選択先頭までのテキスト（現在ページ算出用）
function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// テキストを原稿用紙風に折り返したときの行数（禁則対応）
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const banned = new Set(kinsokuEnabled ? bannedChars : []);
  let rows = 0;

  for (const line of lines) {
    const arr = Array.from(line);
    const n = arr.length;
    if (n === 0) {
      rows += 1; // 空行も1
      continue;
    }

    let pos = 0;
    while (pos < n) {
      let take = Math.min(cols, n - pos);
      if (kinsokuEnabled) {
        let ni = pos + take;
        while (ni < n && banned.has(arr[ni])) {
          take++;
          ni++;
        }
      }
      rows += 1;
      pos += take;
    }
  }
  return rows;
}

// メトリクス計算
function computePageMetrics(doc, c, selection) {
  const text = doc.getText();

  // 文字数: 改行(LF)を除くコードポイント数
  const totalChars = Array.from(text.replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;

  // 総行数（禁則込みの折返し）
  const totalWrappedRows = wrappedRowsForText(
    text,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalPages = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerPage));

  // 現在ページ
  const prefixText = editorPrefixText(doc, selection);
  const currRows = wrappedRowsForText(
    prefixText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const currentPage = Math.max(
    1,
    Math.min(totalPages, Math.ceil(currRows / c.rowsPerPage))
  );

  // 最終ページの最終文字が何行目か
  const rem = totalWrappedRows % c.rowsPerPage;
  const lastLineInLastPage = rem === 0 ? c.rowsPerPage : rem;

  return {
    totalChars,
    totalWrappedRows,
    totalPages,
    currentPage,
    lastLineInLastPage,
  };
}

// メトリクス計算→キャッシュ
function recomputeAndCacheMetrics(editor) {
  if (!editor) {
    m = null;
    return;
  }
  const c = cfg();
  if (!isTargetDoc(editor.document, c) || !enabledPage || !c.enabledPage) {
    m = null;
    return;
  }
  m = computePageMetrics(editor.document, c, editor.selection);
}

// ステータスバー更新
function updateStatusBar(editor) {
  const c = cfg();
  if (!statusBarItem) return;

  if (
    !editor ||
    !isTargetDoc(editor.document, c) ||
    !enabledPage ||
    !c.enabledPage
  ) {
    statusBarItem.hide();
    return;
  }

  const selections = editor.selections?.length
    ? editor.selections
    : [editor.selection];
  const selectedChars = countSelectedChars(editor.document, selections);

  const mm = m ?? {
    totalChars: 0,
    totalWrappedRows: 0,
    totalPages: 1,
    currentPage: 1,
    lastLineInLastPage: 1,
  };
  const displayChars = selectedChars > 0 ? selectedChars : mm.totalChars;

  // 合算文字数（保存時に更新されたキャッシュを表示）
  const combined = c.showCombined ? combinedCharsCache.value : null;
  const combinedPart = combined != null ? `（${combined}字）` : "";

  statusBarItem.text = `${mm.currentPage}/${mm.totalPages} -${mm.lastLineInLastPage}（${c.rowsPerPage}×${c.colsPerRow}）${displayChars}字${combinedPart}`;
  statusBarItem.tooltip =
    selectedChars > 0
      ? "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=選択範囲の文字数（改行除外）｜（ ）=同一フォルダ×同一拡張子の合算文字数"
      : "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=全体の文字数（改行除外）｜（ ）=同一フォルダ×同一拡張子の合算文字数";

  statusBarItem.command = "posPage.setPageSize";
  statusBarItem.show();
}

// ===== 6) 全角括弧ユーティリティ（レンジ検出 & 入力補助） =====

// ドキュメント全文を走査し、全角括弧の「開き」〜「対応する閉じ」までの Range[] を収集
function computeFullwidthQuoteRanges(doc) {
  const text = doc.getText(); // UTF-16
  const ranges = [];
  const stack = []; // { openChar, expectedClose, openOffset }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // 開き？
    const close = FW_BRACKET_MAP.get(ch);
    if (close) {
      stack.push({ openChar: ch, expectedClose: close, openOffset: i });
      continue;
    }
    // 閉じ？
    if (FW_CLOSE_SET.has(ch)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (ch === top.expectedClose) {
          // 対応 → 範囲確定
          stack.pop();
          const startPos = doc.positionAt(top.openOffset);
          const endPos = doc.positionAt(i + 1); // 閉じを含む
          ranges.push(new vscode.Range(startPos, endPos));
        }
      }
      // 孤立した閉じは無視
    }
  }
  // 未閉じは追加しない
  return ranges;
}

// 開き入力直後に閉じを補完し、キャレットを内側へ
function maybeAutoCloseFullwidthBracket(e) {
  try {
    if (_insertingFwClose) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const c = cfg();
    if (!isTargetDoc(ed.document, c)) return;
    if (e.document !== ed.document) return;
    if (!e.contentChanges || e.contentChanges.length !== 1) return;

    const chg = e.contentChanges[0];
    const isSingleCharText =
      typeof chg.text === "string" && chg.text.length === 1;

    // Case 1: 挿入
    if (chg.rangeLength === 0 && isSingleCharText) {
      const open = chg.text;
      const close = FW_BRACKET_MAP.get(open);
      if (!close) return;

      const posAfterOpen = chg.range.start.translate(0, 1);
      _insertingFwClose = true;
      ed.edit((builder) => {
        builder.insert(posAfterOpen, close);
      })
        .then((ok) => {
          if (!ok) return;
          const sel = new vscode.Selection(posAfterOpen, posAfterOpen);
          ed.selections = [sel];
        })
        .then(
          () => {
            _insertingFwClose = false;
          },
          () => {
            _insertingFwClose = false;
          }
        );
      return;
    }

    // Case 2: 1文字置換（例: 「 に変換）
    if (chg.rangeLength === 1 && isSingleCharText) {
      const newOpen = chg.text;
      const newClose = FW_BRACKET_MAP.get(newOpen);
      if (!newClose) return;

      const posAfterOpen = chg.range.start.translate(0, 1);
      const nextCharRange = new vscode.Range(
        posAfterOpen,
        posAfterOpen.translate(0, 1)
      );
      const nextChar = ed.document.getText(nextCharRange);

      if (FW_CLOSE_SET.has(nextChar) && nextChar !== newClose) {
        _insertingFwClose = true;
        ed.edit((builder) => {
          builder.replace(nextCharRange, newClose);
        }).then(
          () => {
            _insertingFwClose = false;
          },
          () => {
            _insertingFwClose = false;
          }
        );
      }
    }
  } catch {
    _insertingFwClose = false;
  }
}

// Backspaceで開きを消した直後、直後の閉じが対応ペアなら同時削除
function maybeDeleteClosingOnBackspace(e) {
  try {
    if (_deletingPair) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || e.document !== ed.document) return;
    if (!e.contentChanges || e.contentChanges.length !== 1) return;

    const chg = e.contentChanges[0];
    if (!(chg.rangeLength === 1 && chg.text === "")) return; // Backspace（左削除）のみ

    // 変更前全文から削除1文字を復元
    const uriKey = e.document.uri.toString();
    const prevText = _prevTextByUri.get(uriKey);
    if (typeof prevText !== "string") return;

    const off = chg.rangeOffset;
    const removed = prevText.substring(off, off + chg.rangeLength);
    if (!FW_BRACKET_MAP.has(removed)) return; // 開き以外は対象外

    const expectedClose = FW_BRACKET_MAP.get(removed);
    const pos = chg.range.start;
    const nextRange = new vscode.Range(pos, pos.translate(0, 1));
    const nextChar = e.document.getText(nextRange);

    if (nextChar !== expectedClose) return;

    _deletingPair = true;
    ed.edit((builder) => builder.delete(nextRange)).then(
      () => {
        _deletingPair = false;
      },
      () => {
        _deletingPair = false;
      }
    );
  } catch {
    _deletingPair = false;
  }
}

// ===== 7) 合算文字数（同一フォルダ×同一拡張子） =====
function countFileCharsNoLF_FromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const text = raw.replace(/\r\n/g, "\n");
    return Array.from(text).filter((ch) => ch !== "\n").length;
  } catch (e) {
    console.warn("[pos-page] countFileChars error:", e?.message);
    return 0;
  }
}

function computeCombinedCharsForFolder(editor) {
  if (!editor) {
    combinedCharsCache = { key: null, value: null };
    return;
  }
  const c = cfg();
  if (!c.showCombined) {
    combinedCharsCache = { key: null, value: null };
    return;
  }

  const doc = editor.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) {
    combinedCharsCache = { key: null, value: null };
    return;
  }

  const lower = fsPath.toLowerCase();
  const isTxt = lower.endsWith(".txt");
  const isMd = lower.endsWith(".md");
  if (!isTxt && !isMd) {
    combinedCharsCache = { key: null, value: null };
    return;
  }

  const dir = path.dirname(fsPath);
  const ext = isTxt ? ".txt" : ".md";
  const cacheKey = `${dir}::${ext}`;

  if (combinedCharsCache.key === cacheKey && combinedCharsCache.value != null)
    return;

  let sum = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const nameLower = ent.name.toLowerCase();
      if (!nameLower.endsWith(ext)) continue;
      const childPath = path.join(dir, ent.name);
      sum += countFileCharsNoLF_FromFile(childPath);
    }
    combinedCharsCache = { key: cacheKey, value: sum };
  } catch (e) {
    console.warn("[pos-page] readdir error:", e?.message);
    combinedCharsCache = { key: cacheKey, value: null };
  }
}

function recomputeCombinedOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;
  combinedCharsCache = { key: null, value: null }; // 保存後に再計算
  computeCombinedCharsForFolder(ed);
}

// ===== 8) scheduler（入力中は軽い更新、手が止まってから重い再計算） =====
function scheduleUpdate(editor) {
  const c = cfg();

  // 軽いUI更新（キャッシュ m を反映）
  if (debouncer) clearTimeout(debouncer);
  debouncer = setTimeout(() => {
    updateStatusBar(editor);
  }, c.debounceMs);

  // 重い再計算はアイドル時
  if (idleRecomputeTimer) clearTimeout(idleRecomputeTimer);
  idleRecomputeTimer = setTimeout(() => {
    recomputeAndCacheMetrics(editor);
    updateStatusBar(editor);
  }, c.recomputeIdleMs);
}

// ===== 9) commands =====
async function cmdRefreshPos() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  updateStatusBar(ed);
}

async function cmdTogglePage() {
  enabledPage = !enabledPage;
  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `ページカウンタ: ${enabledPage ? "有効化" : "無効化"}`
  );
}

async function cmdSetPageSize() {
  const c = cfg();
  const rows = await vscode.window.showInputBox({
    prompt: "1ページの行数",
    value: String(c.rowsPerPage),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!rows) return;
  const cols = await vscode.window.showInputBox({
    prompt: "1行の文字数",
    value: String(c.colsPerRow),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!cols) return;

  const conf = vscode.workspace.getConfiguration("posPage");
  await conf.update(
    "page.rowsPerPage",
    parseInt(rows, 10),
    vscode.ConfigurationTarget.Global
  );
  await conf.update(
    "page.colsPerRow",
    parseInt(cols, 10),
    vscode.ConfigurationTarget.Global
  );

  const ed = vscode.window.activeTextEditor;
  if (ed) {
    recomputeAndCacheMetrics(ed);
    updateStatusBar(ed);
  }
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

// 見出しの“全折/全展開”トグル（.txt / novel）
async function cmdToggleFoldAllHeadings() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const c = cfg();
  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel")) {
    vscode.window.showInformationMessage(
      "このトグルは .txt / novel でのみ有効です"
    );
    return;
  }
  if (!c.headingFoldEnabled) {
    vscode.window.showInformationMessage(
      "見出しの折りたたみ機能が無効です（posPage.headings.folding.enabled）"
    );
    return;
  }

  const key = ed.document.uri.toString();
  const lastStateFolded = foldToggledByDoc.get(key) === true;
  const lastVer = foldDocVersionAtFold.get(key);
  const currVer = ed.document.version;

  // 前回「全折りたたみ」実行後、編集されていなければ「全展開」
  const shouldUnfold = lastStateFolded && lastVer === currVer;

  if (shouldUnfold) {
    await vscode.commands.executeCommand("editor.unfoldAll");
    foldToggledByDoc.set(key, false);
    recomputeAndCacheMetrics(ed);
    updateStatusBar(ed);
    vscode.commands.executeCommand("posPage.refreshPos"); // 再解析
  } else {
    // 設定したレベル以上の見出しだけ折りたたむ
    const minLv = cfg().headingFoldMinLevel;
    const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
    if (lines.length === 0) {
      vscode.window.showInformationMessage(
        `折りたたみ対象の見出し（レベル${minLv}以上）は見つかりませんでした。`
      );
    } else {
      const origSelections = ed.selections;
      try {
        // 見出し行へ複数選択を張って一括 fold
        ed.selections = lines.map((ln) => new vscode.Selection(ln, 0, ln, 0));
        await vscode.commands.executeCommand("editor.fold");
        foldToggledByDoc.set(key, true);
        foldDocVersionAtFold.set(key, currVer);
      } finally {
        // ユーザーの選択を復元
        ed.selections = origSelections;
      }
    }
  }
}

// ===== 10) Semantic Tokens（POS/括弧/ダッシュ/全角スペース） =====

// kuromoji → token type / modifiers
function mapKuromojiToSemantic(tk) {
  const pos = tk.pos || "";
  const pos1 = tk.pos_detail_1 || "";
  let type = "other";
  if (pos === "名詞") type = "noun";
  else if (pos === "動詞") type = "verb";
  else if (pos === "形容詞") type = "adjective";
  else if (pos === "副詞") type = "adverb";
  else if (pos === "助詞") type = "particle";
  else if (pos === "助動詞") type = "auxiliary";
  else if (pos === "連体詞") type = "prenoun";
  else if (pos === "接続詞") type = "conjunction";
  else if (pos === "感動詞") type = "interjection";
  else if (pos === "記号") type = "symbol";

  let mods = 0;
  if (pos1 === "固有名詞") mods |= 1 << tokenModsArr.indexOf("proper");
  if (pos1 === "接頭") mods |= 1 << tokenModsArr.indexOf("prefix");
  if (pos1 === "接尾") mods |= 1 << tokenModsArr.indexOf("suffix");
  return { typeIdx: Math.max(0, tokenTypesArr.indexOf(type)), mods };
}

// 行内で kuromoji トークンの開始位置を素朴に探索
function* enumerateTokenOffsets(lineText, tokens) {
  let cur = 0;
  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;
    const i = lineText.indexOf(s, cur);
    if (i === -1) continue;
    yield { start: i, end: i + s.length, tk };
    cur = i + s.length;
  }
}

// Markdown風見出し検出（0〜3スペース許容）
function getHeadingLevel(lineText) {
  const m = lineText.match(/^ {0,3}(#{1,6})\s+\S/);
  return m ? m[1].length : 0;
}

// 見出しレベルが minLevel 以上の見出し「行番号」リストを返す
function collectHeadingLinesByMinLevel(document, minLevel) {
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const lvl = getHeadingLevel(text);
    if (lvl > 0 && lvl >= Math.max(1, Math.min(6, minLevel))) {
      lines.push(i);
    }
  }
  return lines;
}

// ===== 11) Providers =====
class JapaneseSemanticProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeSemanticTokens = new vscode.EventEmitter(); // ← 追加
    /** @type {vscode.Event<void>} */
    this.onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event; // ← 追加
  }

  async _buildTokens(document, range, cancelToken) {
    const c = cfg();

    // 言語別の有効/無効
    const lang = (document.languageId || "").toLowerCase();
    if (lang === "markdown") {
      if (!c.semanticEnabledMd)
        return new vscode.SemanticTokens(new Uint32Array());
    } else {
      if (!c.semanticEnabled)
        return new vscode.SemanticTokens(new Uint32Array());
    }

    await ensureTokenizer(this._context);

    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);

    // 全角括弧＋中身のセグメントを先に集計（改行対応）
    const idxBracket = tokenTypesArr.indexOf("bracket");
    const bracketSegsByLine = new Map();
    (() => {
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
    })();

    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;
      const text = document.lineAt(line).text;

      // 見出し行は heading で全面着色（plaintext/novel）
      if (c.headingSemanticEnabled) {
        const l = (document.languageId || "").toLowerCase();
        if (l === "plaintext" || l === "novel") {
          const lvl = getHeadingLevel(text);
          if (lvl > 0) {
            builder.push(
              line,
              0,
              text.length,
              tokenTypesArr.indexOf("heading"),
              0
            );
            continue; // 見出しは品詞解析対象外
          }
        }
      }

      const skipKuromojiHere = false; // 常に解析（見出し行は下でcontinue）

      // 全角スペース
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          builder.push(line, m.index, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // ダッシュ（—/―） → bracket 色で
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          builder.push(
            line,
            m.index,
            m[0].length,
            tokenTypesArr.indexOf("bracket"),
            0
          );
        }
      }

      // 括弧＋中身（改行対応セグメント）
      {
        const segs = bracketSegsByLine.get(line);
        if (segs && segs.length) {
          for (const [sCh, eCh] of segs) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // 品詞ハイライト（必要時のみ）
      if (!skipKuromojiHere && tokenizer && text.trim()) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          const length = seg.end - seg.start;
          builder.push(line, seg.start, length, typeIdx, mods);
        }
      }
    }
    return builder.build();
  }

  async provideDocumentSemanticTokens(document, token) {
    if (token?.isCancellationRequested) {
      return new vscode.SemanticTokens(new Uint32Array());
    }
    const fullRange = new vscode.Range(
      0,
      0,
      document.lineCount - 1,
      document.lineAt(Math.max(0, document.lineCount - 1)).text.length
    );
    return this._buildTokens(document, fullRange, token);
  }

  async provideDocumentRangeSemanticTokens(document, range, token) {
    if (token?.isCancellationRequested) {
      return new vscode.SemanticTokens(new Uint32Array());
    }
    return this._buildTokens(document, range, token);
  }
}

class HeadingFoldingProvider {
  provideFoldingRanges(document, context, token) {
    // 意図的に未使用。ESLint対策と、将来の拡張余地のため残す
    void context;
    if (token?.isCancellationRequested) return [];
    const c = cfg();
    if (!c.headingFoldEnabled) return [];

    const lang = (document.languageId || "").toLowerCase();
    // 対象は plaintext / novel（Markdownは VSCode 既定に任せる）
    if (!(lang === "plaintext" || lang === "novel")) return [];

    const lines = document.lineCount;
    const heads = [];

    for (let i = 0; i < lines; i++) {
      const text = document.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) heads.push({ line: i, level: lvl });
    }
    if (heads.length === 0) return [];

    const ranges = [];
    for (let i = 0; i < heads.length; i++) {
      const { line: start, level } = heads[i];
      // 次の「同レベル以下」の見出し直前まで
      let end = lines - 1;
      for (let j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= level) {
          end = heads[j].line - 1;
          break;
        }
      }
      if (end > start) {
        ranges.push(
          new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region)
        );
      }
    }
    return ranges;
  }
}

// ===== 12) activate/deactivate =====
function activate(context) {
  console.log("[pos-page] activate called");
  vscode.window.showInformationMessage("POS/Page: activate");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    2
  );
  context.subscriptions.push(statusBarItem);

  // commands
  context.subscriptions.push(
    vscode.commands.registerCommand("posPage.refreshPos", () =>
      cmdRefreshPos()
    ),
    vscode.commands.registerCommand("posPage.togglePageCounter", () =>
      cmdTogglePage()
    ),
    vscode.commands.registerCommand("posPage.setPageSize", () =>
      cmdSetPageSize()
    ),
    vscode.commands.registerCommand("posPage.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings()
    )
  );

  // events
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      // 先に括弧補完系
      maybeAutoCloseFullwidthBracket(e);
      maybeDeleteClosingOnBackspace(e);
      scheduleUpdate(ed);
      // 変更後テキストをスナップショットに反映（Backspace復元用）
      _prevTextByUri.set(e.document.uri.toString(), e.document.getText());
    }),

    // 保存：即時確定計算
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        if (debouncer) {
          clearTimeout(debouncer);
          debouncer = null;
        }
        // 保存時のみ合算文字数を再計算
        recomputeCombinedOnSaveIfNeeded(doc);
        recomputeAndCacheMetrics(ed);
        updateStatusBar(ed);
      }
    }),

    // アクティブエディタ切替：確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        // 切替時は入力中ではないので初期の合算を計算
        computeCombinedCharsForFolder(ed);
        recomputeAndCacheMetrics(ed);
        scheduleUpdate(ed);
        _prevTextByUri.set(ed.document.uri.toString(), ed.document.getText());
      }
    }),

    // 選択変更：選択文字数を即反映
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      recomputeAndCacheMetrics(e.textEditor);
      updateStatusBar(e.textEditor);
    }),

    // 設定変更：確定計算＋軽い更新
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posPage")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          recomputeAndCacheMetrics(ed);
          scheduleUpdate(ed);
        }
      }
    })
  );

  // Provider登録
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "untitled" },
  ];
  const semProvider = new JapaneseSemanticProvider(context); // ← これを下のイベントで参照(context);
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector,
      semProvider,
      semanticLegend
    ),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(
      selector,
      semProvider,
      semanticLegend
    )
  );

  // FoldingRangeProvider（.txt / novel）
  const foldSelector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
  ];
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      foldSelector,
      new HeadingFoldingProvider()
    )
  );

  // 初回：確定計算→UI反映
  if (vscode.window.activeTextEditor) {
    computeCombinedCharsForFolder(vscode.window.activeTextEditor);
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
    _prevTextByUri.set(
      vscode.window.activeTextEditor.document.uri.toString(),
      vscode.window.activeTextEditor.document.getText()
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const ed = e.textEditor;
      if (!ed) return;
      const c = cfg();
      const lang = (ed.document.languageId || "").toLowerCase();
      // 対象は .txt / novel（MarkdownはVSCode標準）
      if (!(lang === "plaintext" || lang === "novel")) return;
      if (!c.headingFoldEnabled) return;

      // 見出しの手動展開/全展開などで可視範囲が変わったら、全文を再ハイライト
      // （Provider に再発行を通知）
      if (semProvider && semProvider._onDidChangeSemanticTokens) {
        semProvider._onDidChangeSemanticTokens.fire();
      }
      // ついでにページ情報も同期
      recomputeAndCacheMetrics(ed);
      updateStatusBar(ed);
    })
  );
}

function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
