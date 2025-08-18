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
let savingGate = false; // 保存中の一時サスペンド抑止フラグ
let suppressUntil = 0; // 保存直後のサスペンド抑止（時刻）
let inputSuspended = false; // 入力中は kuromoji 装飾を全面停止（保存まで）
let cachedMetrics = null; // ステータスバー用メトリクスのキャッシュ（入力中はこれを使う）
let statusBarFrozen = false; // 入力中はステータスバーを更新しない（表示凍結）

// “保存時のみ”デコレーション（記号/括弧/接続詞/助詞）用
let tmDecorations = new Map(); // key: カテゴリ("記号","括弧","接続詞","助詞") -> DecorationType
let fwSpaceDecoration = null; // 全角スペース用

function disposeAllTmDecorations() {
  for (const d of tmDecorations.values()) {
    try {
      d.dispose();
    } catch {}
  }
  tmDecorations.clear();
}

function ensureFullWidthSpaceDecoration(color) {
  if (fwSpaceDecoration) {
    try {
      fwSpaceDecoration.dispose();
    } catch {}
    fwSpaceDecoration = null;
  }
  fwSpaceDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: color,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

function disposeFullWidthSpaceDecoration() {
  if (fwSpaceDecoration) {
    try {
      fwSpaceDecoration.dispose();
    } catch {}
    fwSpaceDecoration = null;
  }
}

// ===== config helper =====

function recomputeAndCacheMetrics(editor) {
  if (!editor) return;
  const c = cfg();
  if (!isTargetDoc(editor.document, c) || !enabledPage || !c.enabledPage) {
    cachedMetrics = null;
    return;
  }
  cachedMetrics = computePageMetrics(editor.document, c, editor.selection);
}
// 入力開始後、保存までのあいだは kuromoji 装飾を全面停止（TextMateはそのまま）
function suspendAllKuromojiOnce(editor) {
  if (!editor || inputSuspended) return;
  const c = cfg();

  const cursorLine = editor.selection?.active?.line ?? 0;
  const windowSize = Math.max(0, cfg().suspendWindowLines ?? 5); // ★設定でコントロール
  const startLine = Math.max(0, cursorLine - windowSize);
  const endLine = Math.min(
    editor.document.lineCount - 1,
    cursorLine + windowSize
  );

  // 全デコを dispose
  disposeAllDecorations();
  if (c.tmEnabled && c.tmSuspendDuringTyping) disposeAllTmDecorations();
  if (c.fullWidthSpaceEnabled && c.tmSuspendDuringTyping)
    disposeFullWidthSpaceDecoration();

  // ★ カーソル周辺だけ再着色（kuromoji + 括弧/記号）
  reapplyWindowDecorations(editor, startLine, endLine);

  inputSuspended = true;
  statusBarFrozen = true;
}

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

// settings の colors から「実際に着色する（= 解析する）」品詞のみを抽出
function enabledPosSetFromColors(colors) {
  const set = new Set();
  for (const [pos, color] of Object.entries(colors || {})) {
    if (!isInheritColor(color)) set.add(pos);
  }
  return set;
}

// カーソル周辺（startLine..endLine）のみ再着色
function reapplyWindowDecorations(editor, startLine, endLine) {
  if (!editor) return;
  const c = cfg();
  // kuromoji トークナイザが未初期化なら諦める（起動時の全文解析後なら初期化済み）
  if (!tokenizer) return;

  // DecorationType を再生成（色設定に基づく有効品詞のみ）
  ensureDecorationTypes(c.colors);
  const doc = editor.document;
  const startPos = new vscode.Position(startLine, 0);
  const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
  const startOffset = doc.offsetAt(startPos);
  const endOffset = doc.offsetAt(endPos);
  const full = doc.getText();
  const slice = full.slice(startOffset, endOffset);

  // TextMate 管轄の除外レンジ（括弧＋括弧内、記号）を先に構築
  const tmExcluded = buildTextMateExclusionRanges(doc);
  const enabledSet = enabledPosSetFromColors(c.colors);

  // スライスをトークン化し、フルテキスト上の位置にマップ
  const tokens = tokenizer.tokenize(slice) || [];
  let scan = startOffset;
  const buckets = new Map(); // pos -> Range[]
  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;
    const idx = full.indexOf(s, scan);
    if (idx < 0) continue;
    const sPos = doc.positionAt(idx);
    const ePos = doc.positionAt(idx + s.length);
    scan = idx + s.length;
    const pos = tk.pos || "その他";
    if (!enabledSet.has(pos)) continue; // 無効品詞はスキップ
    const rng = new vscode.Range(sPos, ePos);
    if (intersectsAny(rng, tmExcluded)) continue; // 括弧/記号は除外
    if (rng.start.line < startLine || rng.end.line > endLine) continue; // 念のため窓外を除外
    if (!buckets.has(pos)) buckets.set(pos, []);
    buckets.get(pos).push(rng);
  }

  // 反映：有効品詞だけウィンドウ内レンジをセット（全文はすでに dispose 済み）
  for (const [pos, deco] of decorationsByPos.entries()) {
    if (!enabledSet.has(pos)) {
      editor.setDecorations(deco, []);
      continue;
    }
    editor.setDecorations(deco, buckets.get(pos) || []);
  }

  // 括弧/記号（保存時デコ）もウィンドウ内だけ復帰
  if (c.tmEnabled) {
    ensureTmDecorationTypes(c.tmColors);
    const cats = buildTmCategoryRanges(doc); // 全文から拾って
    for (const [key, deco] of tmDecorations.entries()) {
      const all = cats.get(key) || [];
      const filtered = all.filter(
        (r) => r.start.line >= startLine && r.end.line <= endLine
      );
      editor.setDecorations(deco, filtered);
    }
  }
  // 全角スペースもウィンドウ内だけ復帰
  if (c.fullWidthSpaceEnabled) {
    ensureFullWidthSpaceDecoration(c.fullWidthSpaceColor);
    const spaceRanges = getFullWidthSpaceRangesWindow(doc, startLine, endLine);
    editor.setDecorations(fwSpaceDecoration, spaceRanges);
  }
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
    tmEnabled: c.get("tm.enabled", true),
    tmApplyOnSaveOnly: c.get("tm.applyOnSaveOnly", true),
    tmColors: c.get("tm.colors", {
      記号: "#fd9bcc",
      括弧: "#fd9bcc",
    }),
    tmSuspendDuringTyping: c.get("tm.suspendDuringTyping", true),
    suspendWindowLines: c.get("suspendWindowLines", 100),
    fullWidthSpaceEnabled: c.get("fullWidthSpace.enabled", true),
    fullWidthSpaceColor: c.get("fullWidthSpace.color", "#ff000055"),
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
  const enabledSet = enabledPosSetFromColors(colors);
  for (const [pos, color] of Object.entries(colors)) {
    // kuromoji 側では「記号」をレンジ生成しないためデコは作らない
    if (pos === "記号") continue;
    if (!enabledSet.has(pos)) continue; // inherit 等は作らない
    decorationsByPos.set(pos, decorationFor(color));
  }
  // 「その他」を使いたい場合のみ生成（色が有効指定のとき）
  if (colors["その他"] && !isInheritColor(colors["その他"])) {
    decorationsByPos.set("その他", decorationFor(colors["その他"]));
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
    ["【", "】"],
    ["〔", "〕"],
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

  // 交差判定で使いやすいように、開始位置でソート
  ranges.sort((a, b) => a.start.compareTo(b.start));
  return ranges;
}

// --- 全角スペースの範囲検出（ドキュメント全体） ---
function getFullWidthSpaceRangesDoc(doc) {
  const text = doc.getText();
  const ranges = [];
  const regex = /　/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const s = doc.positionAt(m.index);
    const e = doc.positionAt(m.index + 1);
    ranges.push(new vscode.Range(s, e));
  }
  return ranges;
}

// --- 全角スペースの範囲検出（行ウィンドウ内だけ） ---
function getFullWidthSpaceRangesWindow(doc, startLine, endLine) {
  const startPos = new vscode.Position(startLine, 0);
  const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
  const startOffset = doc.offsetAt(startPos);
  const endOffset = doc.offsetAt(endPos);
  const slice = doc.getText(new vscode.Range(startPos, endPos));
  const ranges = [];
  const regex = /　/g;
  let m;
  while ((m = regex.exec(slice)) !== null) {
    const absIdx = startOffset + m.index;
    const s = doc.positionAt(absIdx);
    const e = doc.positionAt(absIdx + 1);
    ranges.push(new vscode.Range(s, e));
  }
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

function buildRangesByPos(doc, tokens, excludedRanges, enabledSet) {
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
    // 設定で "default"/"inherit" などになっている品詞は解析スキップ
    if (enabledSet && !enabledSet.has(pos)) continue;
    const rng = new vscode.Range(start, end);
    // TextMate 管轄（記号・括弧・接続詞・助詞）に重なるレンジは除外
    if (!intersectsAny(rng, excludedRanges)) {
      if (!map.has(pos)) map.set(pos, []);
      map.get(pos).push(rng);
    }
  }
  return map;
}

// ===== “保存時のみ”の簡易TextMateデコ：カテゴリ別レンジを構築 =====
function buildTmCategoryRanges(doc) {
  const text = doc.getText();
  const map = new Map(); // key -> ranges[]
  const push = (key, sIdx, eIdx) => {
    const s = doc.positionAt(sIdx);
    const e = doc.positionAt(eIdx);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(new vscode.Range(s, e));
  };
  // 記号
  const reSymbols = /[、。・：；？！…‥—―ー〜～]/g;
  for (let m; (m = reSymbols.exec(text)); )
    push("記号", m.index, m.index + m[0].length);
  // 括弧（中身含む）
  const pairs = [
    ["「", "」"],
    ["『", "』"],
    ["（", "）"],
    ["［", "］"],
    ["｛", "｝"],
    ["〈", "〉"],
    ["《", "》"],
    ["【", "】"],
    ["〔", "〕"],
  ];
  for (const [open, close] of pairs) {
    let idx = 0;
    while (idx < text.length) {
      const s = text.indexOf(open, idx);
      if (s < 0) break;
      const e = text.indexOf(close, s + open.length);
      if (e < 0) {
        push("括弧", s, s + open.length);
        idx = s + open.length;
      } else {
        push("括弧", s, e + close.length);
        idx = e + close.length;
      }
    }
  }
  return map;
}

function ensureTmDecorationTypes(tmColors) {
  // 既存を破棄
  for (const d of tmDecorations.values()) d.dispose();
  tmDecorations.clear();
  const mk = (color) => {
    const opts = { rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
    if (!isInheritColor(color)) opts.color = color;
    return vscode.window.createTextEditorDecorationType(opts);
  };
  // ★ 記号は括弧と同色に（記号側がinherit/未設定なら括弧色を使用）
  const bracketColor = tmColors["括弧"];
  const symbolColor = isInheritColor(tmColors["記号"])
    ? bracketColor
    : tmColors["記号"];
  tmDecorations.set("括弧", mk(bracketColor));
  tmDecorations.set("記号", mk(symbolColor));
}

function applyTmDecorations(editor) {
  const c = cfg();
  if (!editor || !c.tmEnabled) return;
  if (c.tmApplyOnSaveOnly !== true) return; // 将来拡張用（今はsaveのみ）
  ensureTmDecorationTypes(c.tmColors);
  const cats = buildTmCategoryRanges(editor.document);
  // まず全消去（カテゴリごと）
  for (const deco of tmDecorations.values()) editor.setDecorations(deco, []);
  // 反映
  for (const [key, ranges] of cats.entries()) {
    const deco = tmDecorations.get(key);
    if (deco) editor.setDecorations(deco, ranges);
  }
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
  const enabledSet = enabledPosSetFromColors(c.colors);

  const tokens = tokenizeDocument(editor.document);
  const buckets = buildRangesByPos(
    editor.document,
    tokens,
    tmExcluded,
    enabledSet
  );

  // いったんクリア
  for (const deco of decorationsByPos.values()) editor.setDecorations(deco, []);
  // 再設定
  for (const [pos, ranges] of buckets.entries()) {
    const deco = decorationsByPos.get(pos) || decorationsByPos.get("その他");
    editor.setDecorations(deco, ranges);
  }
  // 起動時／手動再解析時：TM相当デコも適用（入力中は動かない）
  applyTmDecorations(editor);
  // 全角スペース（全文）
  const c2 = cfg();
  if (c2.fullWidthSpaceEnabled) {
    ensureFullWidthSpaceDecoration(c2.fullWidthSpaceColor);
    const spaceRanges = getFullWidthSpaceRangesDoc(editor.document);
    editor.setDecorations(fwSpaceDecoration, spaceRanges);
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

  // ★ 入力中は表示凍結。cachedMetrics が無いときは「表示を更新しない」
  if (statusBarFrozen) return;

  // 入力中でなければ再計算、またはキャッシュがなければ一度だけ計算
  let m = cachedMetrics;
  if (!inputSuspended || !m) {
    m = computePageMetrics(editor.document, c, editor.selection);
    cachedMetrics = m;
  }

  // ★追加：選択があれば選択文字数、なければ全体文字数
  const selections =
    editor.selections && editor.selections.length
      ? editor.selections
      : [editor.selection];
  const selectedChars = countSelectedChars(editor.document, selections);
  // 入力中は totalChars もキャッシュ値を使用（全文走査を避ける）
  const displayChars = selectedChars > 0 ? selectedChars : m?.totalChars ?? 0;

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
  // 入力中の凍結フェーズでは、そもそも何もしない
  if (inputSuspended && statusBarFrozen) return;
  if (debouncer) clearTimeout(debouncer);
  debouncer = setTimeout(async () => {
    // 入力中は kuromoji 装飾を全面停止（最初の一回だけ全デコをクリア）
    // TextMate の着色は残る／ステータスバーのみ更新
    if (!savingGate && Date.now() >= suppressUntil && editor) {
      suspendAllKuromojiOnce(editor);
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
      // 入力中の凍結フェーズならスキップ
      if (!(inputSuspended && statusBarFrozen)) {
        scheduleUpdate(ed, context);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        // 保存時は「カーソル行以降のみ」kuromoji 再着色
        // まず、入力由来の保留デバウンスを無効化
        if (debouncer) {
          clearTimeout(debouncer);
          debouncer = null;
        }
        savingGate = true;
        // ★ 保存時は全文を kuromoji で再解析・再着色
        analyzeAndDecorate(ed, context).finally(() => {
          savingGate = false;
          // 保存直後は一定時間、サスペンドを抑止（フォーマッタ等の追随イベント対策）
          const c = cfg();
          suppressUntil = Date.now() + Math.max(2 * c.debounceMs, 300);

          // 入力全面停止を解除（= 次の入力でまた一度だけ全クリア）
          inputSuspended = false;
          // 保存時はメトリクスを正式再計算（以降の入力中はこのキャッシュを表示）
          statusBarFrozen = false; // ← 凍結解除：保存後は最新に更新
          recomputeAndCacheMetrics(ed);
          // ★ 保存（＝確定）時のみ、TM相当デコを適用
          applyTmDecorations(ed);
          updateStatusBar(ed);
        });
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        // エディタ切替時に最新メトリクスをキャッシュ
        recomputeAndCacheMetrics(ed);
        scheduleUpdate(ed, context);
        // 切替時にも一度適用（入力開始後は止まる）
        applyTmDecorations(ed);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        // 入力中の凍結フェーズでは何もしない（キー毎に2回呼ばれる負荷を抑止）
        if (!statusBarFrozen) {
          updateStatusBar(e.textEditor); // ステータスバーのみ
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posPage")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          // 行×列や禁則の変更時はキャッシュを更新
          recomputeAndCacheMetrics(ed);
          scheduleUpdate(ed, context);
          // 色設定や有効/無効が変わった場合に備え適用
          applyTmDecorations(ed);
        }
      }
    })
  );

  // 初回
  if (vscode.window.activeTextEditor) {
    analyzeAndDecorate(vscode.window.activeTextEditor, context);
    // 起動直後にメトリクスを確定→以降の入力中はキャッシュ表示
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
    inputSuspended = false;
  }
}
function deactivate() {
  disposeAllDecorations();
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
