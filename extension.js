// extension.js
// ===== imports =====
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS

// ===== state =====
let tokenizer = null;
let debouncer = null;
let decorationsByPos = new Map();

let enabledPos = true;
let enabledPage = true;
let statusBarItem = null;

// ===== config helper =====

// 指定色を「デフォルト（エディタ標準色）」として扱うかどうか
function isInheritColor(val) {
  if (val == null) return true;
  const v = String(val).trim().toLowerCase();
  return (
    v === "" ||
    v === "default" ||
    v === "inherit" ||
    v === "auto" ||
    v === "#46d2e8" // ← あなたの指定を“デフォルト扱い”にする
  );
}

function cfg() {
  const c = vscode.workspace.getConfiguration("posPage");
  return {
    applyToTxtOnly: c.get("applyToTxtOnly", true),
    debounceMs: c.get("debounceMs", 200),
    enabledPos: c.get("enabledPos", true),
    colors: c.get("colors", {}),
    maxDocLength: c.get("maxDocLength", 200000),
    enabledPage: c.get("enabledPage", true),
    rowsPerPage: c.get("page.rowsPerPage", 40),
    colsPerRow: c.get("page.colsPerRow", 40),
    // ★ 追加 ↓
    kinsokuEnabled: c.get("kinsoku.enabled", true),
    kinsokuBanned: c.get("kinsoku.bannedStart", [
      "」",
      "）",
      "『",
      "』",
      "》",
      "】",
      "。",
      "、",
    ]),
  };
}

// ===== tokenizer =====
async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict"); // プロジェクト直下の dict/
  console.log("[pos-page] dict path:", dictPath);
  if (!fs.existsSync(dictPath)) {
    vscode.window.showErrorMessage(
      "kuromoji の辞書が見つかりません。拡張直下の 'dict/' を確認してください。"
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

// ===== guards =====
function isTargetDoc(doc, c) {
  if (!doc) return false;
  if (!c.applyToTxtOnly) return true;
  const isPlain = doc.languageId === "plaintext";
  const isTxt = doc.uri.fsPath.toLowerCase().endsWith(".txt");
  return isPlain && isTxt;
}

// ===== decorations =====
function disposeAllDecorations() {
  for (const d of decorationsByPos.values()) d.dispose();
  decorationsByPos.clear();
}
function decorationFor(color) {
  const opts = {
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  };
  // デフォルト色にしたい場合は color等を指定しない（=テーマ標準のまま）
  if (!isInheritColor(color)) {
    opts.color = color;
    // 必要なら太字などをつける場合ここに。inheritのときは付けないで完全に“素の見た目”に。
    // opts.fontWeight = "700";
  }
  return vscode.window.createTextEditorDecorationType(opts);
}

function ensureDecorationTypes(colors) {
  disposeAllDecorations();
  for (const [pos, color] of Object.entries(colors)) {
    decorationsByPos.set(pos, decorationFor(color));
  }
  if (!decorationsByPos.has("その他")) {
    decorationsByPos.set("その他", decorationFor("#f5f5f5"));
  }
}

// ===== tokenize & build ranges =====
function tokenizeDocument(doc) {
  if (!tokenizer) return [];
  const text = doc.getText();
  return tokenizer.tokenize(text) || [];
}

function buildRangesByPos(doc, tokens) {
  const full = doc.getText();
  let offset = 0;
  const map = new Map(); // pos -> ranges[]

  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;

    const idx = full.indexOf(s, offset);
    if (idx < 0) continue; // ずれたらスキップ

    const start = doc.positionAt(idx);
    const end = doc.positionAt(idx + s.length);
    offset = idx + s.length;

    const pos = tk.pos || "その他";
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos).push(new vscode.Range(start, end));
  }
  return map;
}

// ===== apply highlights =====
async function analyzeAndDecorate(editor, context) {
  const c = cfg();
  if (
    !editor ||
    !isTargetDoc(editor.document, c) ||
    !enabledPos ||
    !c.enabledPos
  ) {
    disposeAllDecorations();
    return;
  }

  const len = editor.document.getText().length;
  if (len > c.maxDocLength) {
    vscode.window.setStatusBarMessage(
      "POS: 文書が大きいため解析を部分適用/スキップ（maxDocLength 変更可）",
      3000
    );
  }

  await ensureTokenizer(context);
  if (!tokenizer) return;

  ensureDecorationTypes(c.colors);

  const tokens = tokenizeDocument(editor.document);
  const buckets = buildRangesByPos(editor.document, tokens);

  // いったんクリア
  for (const deco of decorationsByPos.values()) editor.setDecorations(deco, []);
  // 再設定
  for (const [pos, ranges] of buckets.entries()) {
    const deco = decorationsByPos.get(pos) || decorationsByPos.get("その他");
    editor.setDecorations(deco, ranges);
  }
}

// ===== page counter =====
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  // CRLF → LF 正規化
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const banned = new Set(kinsokuEnabled ? bannedChars : []);
  let rows = 0;

  for (const line of lines) {
    // 文字数は code point 基準（サロゲート対策）
    const arr = Array.from(line);
    const n = arr.length;

    // 空行も1行としてカウント（原稿用紙の行空け）
    if (n === 0) {
      rows += 1;
      continue;
    }

    let pos = 0;
    while (pos < n) {
      // まず cols だけ取る
      let take = Math.min(cols, n - pos);

      if (kinsokuEnabled) {
        // 次文字が禁則文字なら、前行に“ぶら下げ”（= この行に食わせる）
        let ni = pos + take;
        while (ni < n && banned.has(arr[ni])) {
          take++;
          ni++;
        }
      }

      rows += 1;
      pos += take; // tateぶん＋禁則ぶんだけ進める
    }
  }

  return rows;
}

function computePageMetrics(doc, c, selection) {
  const text = doc.getText();

  // 文字数は改行を除いたコードポイント数（必要なければ text.length に戻してOK）
  const totalChars = Array.from(text.replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;

  const totalWrappedRows = wrappedRowsForText(
    text,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalPages = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerPage));

  // 現在ページ算出用：先頭〜カーソル位置のテキスト
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
  // ★追加：最終ページの何行目に最終文字があるか
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

  const m = computePageMetrics(editor.document, c, editor.selection);

  // ★追加：選択があれば選択文字数、なければ全体文字数
  const selections =
    editor.selections && editor.selections.length
      ? editor.selections
      : [editor.selection];
  const selectedChars = countSelectedChars(editor.document, selections);
  const displayChars = selectedChars > 0 ? selectedChars : m.totalChars;

  statusBarItem.text = `${m.currentPage}/${m.totalPages}｜${m.lastLineInLastPage}行｜${displayChars}字（${c.rowsPerPage}×${c.colsPerRow}）`;

  statusBarItem.tooltip =
    selectedChars > 0
      ? "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=選択範囲の文字数（改行除外）"
      : "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=全体の文字数（改行除外）";

  statusBarItem.command = "posPage.setPageSize";
  statusBarItem.show();
}

function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// 改行(LF)を除いてコードポイント数を数える
function countCharsNoLF(text) {
  return Array.from(text.replace(/\r\n/g, "\n")).filter((ch) => ch !== "\n")
    .length;
}

// 複数選択に対応して合計文字数を返す（空選択は0）
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

// ===== scheduling =====
function scheduleUpdate(editor, context) {
  const c = cfg();
  if (debouncer) clearTimeout(debouncer);
  debouncer = setTimeout(async () => {
    await analyzeAndDecorate(editor, context);
    updateStatusBar(editor);
  }, c.debounceMs);
}

// ===== commands =====
async function cmdTogglePos(context) {
  enabledPos = !enabledPos;
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  if (enabledPos) {
    await analyzeAndDecorate(ed, context);
    vscode.window.showInformationMessage("品詞ハイライト: 有効化");
  } else {
    disposeAllDecorations();
    vscode.window.showInformationMessage("品詞ハイライト: 無効化");
  }
}
async function cmdRefreshPos(context) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  await analyzeAndDecorate(ed, context);
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

  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

// ===== activate/deactivate =====
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
    vscode.commands.registerCommand("posPage.togglePos", () =>
      cmdTogglePos(context)
    ),
    vscode.commands.registerCommand("posPage.refreshPos", () =>
      cmdRefreshPos(context)
    ),
    vscode.commands.registerCommand("posPage.togglePageCounter", () =>
      cmdTogglePage()
    ),
    vscode.commands.registerCommand("posPage.setPageSize", () =>
      cmdSetPageSize()
    )
  );

  // events
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      scheduleUpdate(ed, context);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) scheduleUpdate(ed, context);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor)
        updateStatusBar(e.textEditor);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posPage")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) scheduleUpdate(ed, context);
      }
    })
  );

  // 初回
  if (vscode.window.activeTextEditor)
    scheduleUpdate(vscode.window.activeTextEditor, context);
}

function deactivate() {
  disposeAllDecorations();
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
