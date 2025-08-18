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
let lastBuckets = null; // 直近のkuromoji装飾レンジを保持（pos -> Range[]）

let enabledPos = true;
let enabledPage = true;
let statusBarItem = null;
let savingGate = false; // 保存中の一時サスペンド抑止フラグ

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

// ===== TextMate と同等ルールで「除外レンジ」を構築 =====
function buildTextMateExclusionRanges(doc) {
  const text = doc.getText();
  const ranges = [];
  const pushRange = (sIdx, eIdx) => {
    const s = doc.positionAt(sIdx);
    const e = doc.positionAt(eIdx);
    ranges.push(new vscode.Range(s, e));
  };

  // 1) 記号
  const reSymbols = /[、。・：；？！…‥—―ー〜～]/g;
  for (let m; (m = reSymbols.exec(text)); ) {
    pushRange(m.index, m.index + m[0].length);
  }

  // 2) 括弧ペア（中身ごと同色＝除外）
  const pairs = [
    ["「", "」"],
    ["『", "』"],
    ["（", "）"],
    ["［", "］"],
    ["｛", "｝"],
    ["〈", "〉"],
    ["《", "》"],
  ];
  for (const [open, close] of pairs) {
    let idx = 0;
    while (idx < text.length) {
      const s = text.indexOf(open, idx);
      if (s < 0) break;
      const e = text.indexOf(close, s + open.length);
      if (e < 0) {
        // 閉じ不足は開きのみ除外（視覚ズレ防止の簡易策）
        pushRange(s, s + open.length);
        idx = s + open.length;
      } else {
        pushRange(s, e + close.length);
        idx = e + close.length;
      }
    }
  }

  // 3) 接続詞（tmLanguageの境界条件を簡略化）
  const conjWords =
    "(そして|すると|そこで|したがって|それゆえに|ゆえに|しかし|けれど|だが|けれども|それなのに|それでも|にもかかわらず|ならびに|また|その上|しかも|おまけに|加えて|あるいは|もしくは|または|なぜなら|というのは|つまり|すなわち|さて|ところで|では|それでは|而して|然し|然して|然れど|然れども|並びに|故に|曰く|又|又は|即ち|或いは|従って|にも関わらず)";
  const reConj = new RegExp(
    `(?<![ぁ-んァ-ヶ一-龯A-Za-z0-9])${conjWords}(?![ぁ-んァ-ヶ一-龯A-Za-z0-9])`,
    "g"
  );
  for (let m; (m = reConj.exec(text)); ) {
    pushRange(m.index, m.index + m[0].length);
  }

  // 4) 助詞
  const partWords =
    "(が|を|に|で|と|へ|から|より|の|は|も|こそ|さえ|しか|だけ|ばかり|など|でも|くらい|ほど)";
  const rePart = new RegExp(
    `(?<=[ぁ-んァ-ヶ一-龯])${partWords}(?=(?:[ぁ-んァ-ヶ一-龯A-Za-z0-9]|[、。・：；？！…‥—―ー〜～]|\\s|$))`,
    "g"
  );
  for (let m; (m = rePart.exec(text)); ) {
    pushRange(m.index, m.index + m[0].length);
  }

  // 交差判定で使いやすいように、開始位置でソート
  ranges.sort((a, b) => a.start.compareTo(b.start));
  return ranges;
}

function intersectsAny(range, excludedRanges) {
  // excludedRanges は start 昇順。二分探索最適化も可だが、まずはシンプルに。
  for (const ex of excludedRanges) {
    if (range.end.isBeforeOrEqual(ex.start)) continue;
    if (ex.end.isBeforeOrEqual(range.start)) continue;
    return true;
  }
  return false;
}

// ===== tokenize & build ranges =====
function tokenizeDocument(doc) {
  if (!tokenizer) return [];
  const text = doc.getText();
  return tokenizer.tokenize(text) || [];
}

function buildRangesByPos(doc, tokens, excludedRanges) {
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
    const rng = new vscode.Range(start, end);
    // TextMate 管轄（記号・括弧・接続詞・助詞）に重なるレンジは除外
    if (!intersectsAny(rng, excludedRanges)) {
      if (!map.has(pos)) map.set(pos, []);
      map.get(pos).push(rng);
    }
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
  // TextMate 管轄の除外レンジを事前計算
  const tmExcluded = buildTextMateExclusionRanges(editor.document);

  const tokens = tokenizeDocument(editor.document);
  const buckets = buildRangesByPos(editor.document, tokens, tmExcluded);
  lastBuckets = buckets; // 保存

  // いったんクリア
  for (const deco of decorationsByPos.values()) editor.setDecorations(deco, []);
  // 再設定
  for (const [pos, ranges] of buckets.entries()) {
    const deco = decorationsByPos.get(pos) || decorationsByPos.get("その他");
    editor.setDecorations(deco, ranges);
  }
}

// ▼ 保存時に使う：カーソル行以降のみ kuromoji を再適用する
async function analyzeAndDecoratePartial(editor, context, startLine) {
  const c = cfg();
  if (
    !editor ||
    !isTargetDoc(editor.document, c) ||
    !enabledPos ||
    !c.enabledPos
  ) {
    return;
  }
  await ensureTokenizer(context);
  if (!tokenizer) return;

  // ★ TextMate 管轄の除外レンジ（全文で一度だけ取得）
  const doc = editor.document;
  const tmExcluded = buildTextMateExclusionRanges(doc);

  // ★ カーソル行の先頭オフセットを基準に、直前の改行までさかのぼって安全に切り出す
  const full = doc.getText();
  const lineStartPos = new vscode.Position(startLine, 0);
  const startOffset = doc.offsetAt(lineStartPos);
  let safeStartOffset = startOffset;
  while (safeStartOffset > 0 && full[safeStartOffset - 1] !== "\n") {
    safeStartOffset--;
  }
  const slice = full.slice(safeStartOffset); // 後方のみ

  // ★ 後方テキストだけをトークン化
  const tokens = tokenizer.tokenize(slice) || [];

  // ★ 後方のみの新規レンジを構築（行>= startLine のみ採用）
  let offset = safeStartOffset;
  const newBuckets = new Map(); // pos -> ranges(>= startLine)
  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;
    const idx = full.indexOf(s, offset);
    if (idx < 0) continue;
    const start = doc.positionAt(idx);
    const end = doc.positionAt(idx + s.length);
    offset = idx + s.length;
    if (start.line < startLine) continue; // ← 前方は無視
    const rng = new vscode.Range(start, end);
    if (intersectsAny(rng, tmExcluded)) continue; // TextMate 管轄を除外
    const pos = tk.pos || "その他";
    if (!newBuckets.has(pos)) newBuckets.set(pos, []);
    newBuckets.get(pos).push(rng);
  }

  // ★ 「前方keep＋後方add」で union を作り反映（DecorationType は再生成しない）
  const merged = new Map();
  const allPos = new Set([
    ...Array.from(newBuckets.keys()),
    ...(lastBuckets ? Array.from(lastBuckets.keys()) : []),
  ]);
  for (const pos of allPos) {
    const prev = (lastBuckets && lastBuckets.get(pos)) || [];
    const keep = prev.filter((r) => r.start.line < startLine); // 前方そのまま
    const add = newBuckets.get(pos) || []; // 後方のみ新規
    merged.set(pos, keep.concat(add));
  }

  for (const pos of allPos) {
    let deco = decorationsByPos.get(pos);
    if (!deco) {
      // 必要なものだけ都度生成（全消ししない）
      deco = decorationFor((c.colors || {})[pos]);
      decorationsByPos.set(pos, deco);
    }
    editor.setDecorations(deco, merged.get(pos) || []);
  }
  lastBuckets = merged;
}

// カーソル行以降の kuromoji 装飾のみを一時的に外す
function suspendFromLine(editor, line) {
  if (!lastBuckets || decorationsByPos.size === 0) return;
  for (const [pos, ranges] of lastBuckets.entries()) {
    const deco = decorationsByPos.get(pos) || decorationsByPos.get("その他");
    const kept = ranges.filter((r) => r.start.line < line); // 「その行**未満**」は残す
    editor.setDecorations(deco, kept);
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
    // 入力中は重い再解析を回避。カーソル行以降だけkuromoji装飾を外す。
    // ただし保存直後の処理中は割り込まない（savingGate）。
    if (!savingGate && editor && editor.selection) {
      suspendFromLine(editor, editor.selection.active.line);
    }
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
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        // 保存時は「カーソル行以降のみ」kuromoji 再着色
        savingGate = true;
        const line = ed.selection?.active?.line ?? 0;
        analyzeAndDecoratePartial(ed, context, line).finally(() => {
          savingGate = false;
          updateStatusBar(ed);
        });
      }
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
  if (vscode.window.activeTextEditor) {
    analyzeAndDecorate(vscode.window.activeTextEditor, context);
    updateStatusBar(vscode.window.activeTextEditor);
  }
}
function deactivate() {
  disposeAllDecorations();
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
