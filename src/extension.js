// ===========================================
//  日本語 品詞ハイライト（Semantic）＋ページカウンタ 拡張メイン
//  - semantic.js: 形態素解析 → Semantic Tokens
//  - status_bar.js: 原稿用紙風ページ/文字数・禁則処理
//  - sidebar_headings.js / minimap_highlight.js: 見出しビュー/ミニマップ
//  - utils.js: 共通ユーティリティ（getHeadingLevel）
// ===========================================

// ===== 1) Imports =====
const vscode = require("vscode");
const { initStatusBar, getBannedStart } = require("./status_bar");
const { initHeadingSidebar } = require("./sidebar_headings");
const { initMinimapHighlight } = require("./minimap_highlight");
const { JapaneseSemanticProvider, semanticLegend } = require("./semantic");
const { getHeadingLevel } = require("./utils");

// ===== 2) Fixed Constants =====
// 全角の開き括弧 → 対応する閉じ括弧
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

// ===== 3) Module State =====
let _sb = null; // status_bar の公開API（activateで初期化）
let _insertingFwClose = false; // 再入防止（自動クローズ）
let _deletingPair = false; // 再入防止（Backspaceペア削除）
const _prevTextByUri = new Map(); // Backspace復元用の直前テキスト

// 見出しの全折/全展開トグル状態（doc単位管理）
const foldToggledByDoc = new Map(); // key: uriString, value: boolean（true=折りたたみ中）
const foldDocVersionAtFold = new Map(); // key: uriString, value: document.version

// ===== 4) Config Helper =====
function cfg() {
  const c = vscode.workspace.getConfiguration("posNote");
  return {
    // Semantic 有効範囲
    semanticEnabled: c.get("semantic.enabled", true),
    semanticEnabledMd: c.get("semantic.enabledMd", true),

    // 対象ファイル判定
    applyToTxtOnly: c.get("applyToTxtOnly", true),

    // ステータスバー更新（軽量/重い再計算の間隔）
    debounceMs: c.get("debounceMs", 500),
    recomputeIdleMs: c.get("recomputeIdleMs", 1000),

    // ステータスバー表示フラグ
    enabledNote: c.get("enabledNote", true),
    showSelectedChars: c.get("status.showSelectedChars", true),
    countSpaces: c.get("status.countSpaces", false),
    showDeltaFromHEAD: c.get("aggregate.showDeltaFromHEAD", true),

    // 原稿用紙風行×列
    rowsPerNote: c.get("Note.rowsPerNote", 20),
    colsPerRow: c.get("Note.colsPerRow", 20),

    // 禁則
    kinsokuEnabled: c.get("kinsoku.enabled", true),
    kinsokuBanned: getBannedStart(),

    // 見出し
    headingFoldEnabled: c.get("headings.folding.enabled", true),
    headingSemanticEnabled: c.get("headings.semantic.enabled", true),
    headingFoldMinLevel: c.get("headings.foldMinLevel", 2),

    // 括弧内ハイライトのトグル
    bracketsOverrideEnabled: c.get("semantic.bracketsOverride.enabled", true),
  };
}

// 対象ドキュメントか？
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

// ===== 5) Bracket Auto-Close & Pair Delete =====
// (1) 開き入力 → 自動で閉じ補完し、キャレットを内側へ移動
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

    // Case 1: 1文字の挿入（開き→閉じを自動補完）
    if (chg.rangeLength === 0 && isSingleCharText) {
      const open = chg.text;
      const close = FW_BRACKET_MAP.get(open);
      if (!close) return;

      const posAfterOpen = chg.range.start.translate(0, 1);
      _insertingFwClose = true;

      const p = ed.edit((builder) => builder.insert(posAfterOpen, close));
      // 1) 成功時：キャレット内側へ
      p.then((ok) => {
        if (!ok) return;
        const sel = new vscode.Selection(posAfterOpen, posAfterOpen);
        ed.selections = [sel];
      });
      // 2) 成功/失敗に関わらずフラグ解除
      p.then(
        () => {
          _insertingFwClose = false;
        },
        () => {
          _insertingFwClose = false;
        }
      );
      return;
    }

    // Case 2: 1文字置換（IME変換で開きに変わった→隣の閉じも追従）
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
        const p2 = ed.edit((builder) =>
          builder.replace(nextCharRange, newClose)
        );
        p2.then(
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

// (2) Backspaceで開きを消した直後、直後の閉じが対応ペアなら同時削除
function maybeDeleteClosingOnBackspace(e) {
  try {
    if (_deletingPair) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || e.document !== ed.document) return;
    if (!e.contentChanges || e.contentChanges.length !== 1) return;

    const chg = e.contentChanges[0];
    // Backspace（左削除）判定：rangeLength=1 かつ text=""（挿入なし）
    if (!(chg.rangeLength === 1 && chg.text === "")) return;

    // 削除前テキストから、削除された1文字を復元
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
    const p = ed.edit((builder) => builder.delete(nextRange));
    p.then(
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

// ===== 6) Heading Utilities =====
// 現在行が「見出し level>=minLevel の本文」に含まれていれば、その見出し行番号を返す
function findEnclosingHeadingLineFor(doc, line, minLevel) {
  // 上へ遡って直近の見出しを探す
  let hLine = -1,
    hLevel = 0;
  for (let i = line; i >= 0; i--) {
    const lvl = getHeadingLevel(doc.lineAt(i).text);
    if (lvl > 0) {
      hLine = i;
      hLevel = lvl;
      break;
    }
  }
  if (hLine < 0 || hLevel < Math.max(1, Math.min(6, minLevel))) return -1;

  // 次の「同レベル以下」の見出し直前までが本文
  for (let j = hLine + 1; j < doc.lineCount; j++) {
    const lvl2 = getHeadingLevel(doc.lineAt(j).text);
    if (lvl2 > 0 && lvl2 <= hLevel) {
      return line > hLine && line < j ? hLine : -1;
    }
  }
  // 次の見出しが無い場合は末尾まで本文扱い
  return line > hLine ? hLine : -1;
}

// 見出しレベルが minLevel 以上の見出し「行番号」リスト
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

// ===== 7) Commands =====
// 見出しの “全折/全展開” トグル（.txt / novel）
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
      "見出しの折りたたみ機能が無効です（posNote.headings.folding.enabled）"
    );
    return;
  }

  const key = ed.document.uri.toString();
  const lastStateFolded = foldToggledByDoc.get(key) === true;
  const lastVer = foldDocVersionAtFold.get(key);
  const currVer = ed.document.version;

  // 前回「全折りたたみ」後に編集がなければ「全展開」
  const shouldUnfold = lastStateFolded && lastVer === currVer;

  if (shouldUnfold) {
    await vscode.commands.executeCommand("editor.unfoldAll");
    foldToggledByDoc.set(key, false);
    if (_sb) {
      _sb.recomputeAndCacheMetrics(ed);
      _sb.updateStatusBar(ed);
    }
    vscode.commands.executeCommand("posNote.refreshPos"); // 再解析
    return;
  }

  // 設定したレベル以上の見出しだけ折りたたむ
  const minLv = cfg().headingFoldMinLevel;
  const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
  if (lines.length === 0) {
    vscode.window.showInformationMessage(
      `折りたたみ対象の見出し（レベル${minLv}以上）は見つかりませんでした。`
    );
    return;
  }

  // いまのカーソルが対象見出しの本文内に居るなら、安全に見出し行末へ退避
  const caret = ed.selection?.active ?? new vscode.Position(0, 0);
  const enclosing = findEnclosingHeadingLineFor(ed.document, caret.line, minLv);
  const safeRestoreSelections =
    enclosing >= 0
      ? (() => {
          const endCh = ed.document.lineAt(enclosing).text.length;
          const pos = new vscode.Position(enclosing, endCh);
          return [new vscode.Selection(pos, pos)];
        })()
      : ed.selections;

  try {
    ed.selections = lines.map((ln) => new vscode.Selection(ln, 0, ln, 0));
    await vscode.commands.executeCommand("editor.fold");
    foldToggledByDoc.set(key, true);
    foldDocVersionAtFold.set(key, currVer);
  } finally {
    ed.selections = safeRestoreSelections;
    if (safeRestoreSelections.length === 1) {
      ed.revealRange(
        new vscode.Range(
          safeRestoreSelections[0].active,
          safeRestoreSelections[0].active
        ),
        vscode.TextEditorRevealType.Default
      );
    }
  }
}

// ===== 8) Providers =====
class HeadingFoldingProvider {
  provideFoldingRanges(document, context, token) {
    void context; // eslint用
    if (token?.isCancellationRequested) return [];
    const c = cfg();
    if (!c.headingFoldEnabled) return [];

    const lang = (document.languageId || "").toLowerCase();
    // 対象は plaintext / novel（Markdownは VSCode 既定に任せる）
    if (!(lang === "plaintext" || lang === "novel")) return [];

    const heads = [];
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) heads.push({ line: i, level: lvl });
    }
    if (heads.length === 0) return [];

    const ranges = [];
    for (let i = 0; i < heads.length; i++) {
      const { line: start, level } = heads[i];
      // 次の「同レベル以下」の見出し直前まで
      let end = document.lineCount - 1;
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

// ===== 9) activate / deactivate =====
function activate(context) {
  // --- 9-1) 初期化（StatusBar/Sidebar/Minimap）
  const sb = (_sb = initStatusBar(context, { cfg, isTargetDoc }));
  initHeadingSidebar(context, { cfg, isTargetDoc });
  initMinimapHighlight(context, { cfg, isTargetDoc });

  // --- 9-2) Semantic Provider を先に用意（イベントから参照するため）
  const semProvider = new JapaneseSemanticProvider(context, { cfg });

  // --- 9-3) Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.refreshPos", () =>
      sb.cmdRefreshPos()
    ),
    vscode.commands.registerCommand("posNote.toggleNoteCounter", () =>
      sb.cmdToggleNote()
    ),
    vscode.commands.registerCommand("posNote.setNoteSize", () =>
      sb.cmdSetNoteSize()
    ),
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings()
    )
  );

  // --- 9-4) Providers
  const semanticSelector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "untitled" },
  ];
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      semanticSelector,
      semProvider,
      semanticLegend
    ),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(
      semanticSelector,
      semProvider,
      semanticLegend
    )
  );

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

  // --- 9-5) Events
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;

      // 括弧補完/削除
      maybeAutoCloseFullwidthBracket(e);
      maybeDeleteClosingOnBackspace(e);

      // ステータスバー更新
      sb.scheduleUpdate(ed);

      // Backspace 復元用に変更後テキストを保持
      _prevTextByUri.set(e.document.uri.toString(), e.document.getText());
    }),

    // 保存：即時確定計算（Git差分/見出しビュー）
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        sb.recomputeOnSaveIfNeeded(doc);
        vscode.commands.executeCommand("posNote.headings.refresh");
      }
    }),

    // アクティブエディタ切替：確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      sb.onActiveEditorChanged(ed);
      _prevTextByUri.set(ed.document.uri.toString(), ed.document.getText());
    }),

    // 選択変更：選択文字数の即時反映
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      sb.onSelectionChanged(e.textEditor);
    }),

    // 設定変更：確定計算＋軽い更新＋セマンティック再発行（MarkdownのON/OFF即時反映）
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("posNote")) return;
      const ed = vscode.window.activeTextEditor;
      if (ed) sb.onConfigChanged(ed);
      if (semProvider && semProvider.fireDidChange) {
        semProvider.fireDidChange();
      }
    }),

    // 可視範囲変更：見出し操作に追随して再ハイライト＆ステータス更新
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const ed = e.textEditor;
      if (!ed) return;
      const c = cfg();
      const lang = (ed.document.languageId || "").toLowerCase();

      // .txt / novel の見出し操作のみ拾う（Markdownは VSCode 標準へ委譲）
      if (!(lang === "plaintext" || lang === "novel")) return;
      if (!c.headingFoldEnabled) return;

      if (semProvider && semProvider.fireDidChange) {
        semProvider.fireDidChange();
      }
      sb.recomputeAndCacheMetrics(ed);
      sb.updateStatusBar(ed);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
