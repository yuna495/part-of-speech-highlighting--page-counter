// POS/Note 本体。各モジュールを束ね、初期化とコマンド登録を行う。

// ===== 1) Imports =====
const vscode = require("vscode");
const { initStatusBar, getBannedStart } = require("./status_bar");
const { initWorkload } = require("./workload");
const { initHeadings } = require("./headings");
const { initSidebarUtilities } = require("./sidebar_util");
const { initKanbn } = require("./kanbn");
const { JapaneseSemanticProvider, semanticLegend, ensureTokenizer } = require("./semantic");
const PageViewPanel = require("./page_view");
const { registerBracketSupport } = require("./bracket");
const { combineTxtInFolder, combineMdInFolder } = require("./combine");
const { registerRubySupport } = require("./ruby");
const { registerConversionCommands } = require("./conversion");
const { registerConvenientFeatures } = require("./convenient");
const { registerWeblioSearch } = require("./weblio");
const { registerCursorCommands } = require("./cursor");

// ===== 3) Module State =====
let _sb = null; // status_bar の公開 API（activate で初期化）
let _workload = null;

// ===== 4) Config Helper =====
/**
 * 拡張設定を読み込み、機能フラグをまとめて返す。
 * @returns {object}
 */
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
    showFolderSum: c.get("aggregate.showFolderSum", true),

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
    headingsShowBodyCounts: c.get("headings.showBodyCounts", true),
    headingsBaseTruncationLimit: c.get("headings.baseTruncationLimit", 20),

    // 括弧内ハイライトのトグル
    bracketsOverrideEnabled: c.get("semantic.bracketsOverride.enabled", true),

    // 括弧補完の方式
    bracketsBackspacePairDelete: c.get("brackets.backspacePairDelete", true),

    // Linter
    linterEnabled: c.get("linter.enabled", false),
  };
}

/**
 * この拡張の対象とするドキュメントかを判定する。
 * @param {vscode.TextDocument} doc
 * @param {ReturnType<cfg>} c
 * @returns {boolean}
 */
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

// ===== 5) activate / deactivate =====
/**
 * 拡張を初期化し、各モジュールとイベントを登録する。
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // --- 9-1) 初期化（StatusBar/Sidebar/Minimap）
  const sb = (_sb = initStatusBar(context, { cfg, isTargetDoc }));
  _workload = initWorkload(context);

  initSidebarUtilities(context);
  initKanbn(context);

  // --- 5-2) Linter（任意）
  // --- 5-2) Linter（任意）
  const linter = require("./linter");
  if (cfg().linterEnabled) {

    linter.activate(context);
  }

  // --- 5-3) Semantic Provider を先に用意（イベントから参照するため）
  const semProvider = new JapaneseSemanticProvider(context, { cfg });

  // Main Thread Tokenizer for Cursor (Async init)
  ensureTokenizer(context);

  // 括弧補完＋Backspace同時削除は外部モジュールへ委譲
  registerBracketSupport(context, { cfg, isTargetDoc });

  // 見出し機能は initHeadings で一括初期化されるため古い呼び出しは削除
  const headings = initHeadings(context, { cfg, isTargetDoc, sb }); // sb is needed now

  // ルビ/傍点 機能
  registerRubySupport(context);

  // 既存コマンドと衝突しない場合のみ登録するヘルパー
  async function safeRegisterCommand(context, id, fn) {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(id)) return;
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  // --- 5-4) Commands
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
    vscode.commands.registerCommand("posNote.showPageView", () => {
      PageViewPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("posNote.combineTxt", (resourceUri) => {
      // エクスプローラーで右クリックしたフォルダ URI が渡ってくる
      return combineTxtInFolder(resourceUri);
    }),
    vscode.commands.registerCommand("posNote.combineMd", (resourceUri) => {
      return combineMdInFolder(resourceUri);
    })
  );
  // 置換コマンド（かな<->漢字）
  registerConversionCommands(context, { isTargetDoc });



  // --- 5-5) Providers
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

  // --- 5-6) Events

  // Cache for accurate character counts (per document URI)
  const _accurateCountCache = new Map(); // uri -> number
  const _accurateCalcTimers = new Map(); // uri -> timeout

  // IME conversion detection (track change positions)
  const _lastChangePosition = new Map(); // uri -> {line, char, timestamp}
  const IME_SUCCESSION_WINDOW_MS = 500; // Time window to detect IME conversion (ms)

  context.subscriptions.push(
    // Input: Lightweight update with differential calculation
    vscode.workspace.onDidChangeTextDocument((e) => {
      try {
        const ed = vscode.window.activeTextEditor;
        if (!ed || e.document !== ed.document) return;
        const c = cfg();
        const docUri = e.document.uri.toString();

        // === 1. Lightweight Differential Calculation (Immediate) ===
        let addedChars = 0, deletedChars = 0;
        for (const change of e.contentChanges) {
          addedChars += change.text.length;
          deletedChars += change.rangeLength;
        }
        const rawDelta = addedChars - deletedChars;
        const timestamp = Date.now();

        // Enhanced IME detection: position-based tracking
        let isLikelyIME = false;
        if (e.contentChanges.length > 0) {
          const change = e.contentChanges[0];
          const hasReplacement = change.rangeLength > 0 && change.text.length > 0;

          if (hasReplacement) {
            const pos = change.range.start;
            const lastChange = _lastChangePosition.get(docUri);

            if (lastChange) {
              const samePosition =
                lastChange.line === pos.line &&
                Math.abs(lastChange.char - pos.character) <= 1;
              const quickSuccession = timestamp - lastChange.timestamp < IME_SUCCESSION_WINDOW_MS;

              if (samePosition && quickSuccession) {
                isLikelyIME = true;
              }
            }

            _lastChangePosition.set(docUri, {
              line: pos.line,
              char: pos.character,
              timestamp
            });
          }
        }

        // Workload: Use raw delta (includes newlines as characters)
        // Skip counting for bulk operations (2500+ chars change)
        const BULK_OPERATION_THRESHOLD = 2500;
        const isBulkOperation = Math.abs(rawDelta) >= BULK_OPERATION_THRESHOLD;

        if (!isBulkOperation) {
          const { applyExternalLen } = require("./workload");
          const previousRawLen = _accurateCountCache.get(docUri + ":raw") || Array.from(e.document.getText()).length;
          const estimatedRawLen = previousRawLen + rawDelta;
          applyExternalLen(docUri, estimatedRawLen, { imeLike: isLikelyIME });
        }

        // Status bar: Use display delta (estimate)
        const previousDisplayLen = _accurateCountCache.get(docUri) || 0;
        const estimatedDisplayLen = Math.max(0, previousDisplayLen + rawDelta);
        sb.scheduleUpdateWithPrecount(ed, estimatedDisplayLen);

        // === 2. Accurate Calculation (Debounced) ===
        // Clear previous timer for this document
        const existingTimer = _accurateCalcTimers.get(docUri);
        if (existingTimer) clearTimeout(existingTimer);

        // Schedule accurate calculation
        const timer = setTimeout(() => {
          try {
            const txt = e.document.getText().replace(/\r\n/g, "\n");

            // Accurate raw length (for workload)
            const accurateRawLen = Array.from(txt).length;
            _accurateCountCache.set(docUri + ":raw", accurateRawLen);
            applyExternalLen(docUri, accurateRawLen, { imeLike: false });

            // Accurate display length (for status bar)
            const { countCharsForDisplay } = require("./utils");
            const accurateDisplayLen = countCharsForDisplay(txt, c);
            _accurateCountCache.set(docUri, accurateDisplayLen);
            sb.scheduleUpdateWithPrecount(ed, accurateDisplayLen);

            _accurateCalcTimers.delete(docUri);
          } catch (err) {
            console.error("[POSNote] Accurate calculation error:", err);
          }
        }, c.debounceMs || 500);

        _accurateCalcTimers.set(docUri, timer);
      } catch (err) {
        console.error("[POSNote] onDidChangeTextDocument error:", err);
      }
    }),

    // 保存：再計算とプレビュー更新
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document === doc) {
          sb.recomputeOnSaveIfNeeded(doc);
          headings.refresh(ed, { immediate: true });
        }
      } catch (err) {
        console.error("[POSNote] onDidSaveTextDocument error:", err);
      }
    }),

    // アクティブエディタ切替：確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      sb.onActiveEditorChanged(ed);
      // headings update is handled by headings.js internal listener (or should be?)
      // headings.js HAS internal onDidChangeActiveTextEditor listener. So no need to call here.
    }),

    // 選択変更：選択文字数の即時反映
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      sb.onSelectionChanged(e.textEditor);
    }),

    // 設定変更：再計算＋セマンティック再発行
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !(
          e.affectsConfiguration("posNote") ||
          e.affectsConfiguration("posNote.Preview")
        )
      )
        return;
      const ed = vscode.window.activeTextEditor;
      // headings.js internally listens to config changes too.

      if (ed) sb.onConfigChanged(ed);
      if (_workload && _workload.onConfigChanged) _workload.onConfigChanged(ed);
      if (semProvider && semProvider.fireDidChange) {
        semProvider.fireDidChange();
      }

      // PageViewPanel 更新
      if (PageViewPanel.currentPanel) {
        PageViewPanel.currentPanel._update();
      }
    })
  );
  // 保存：自動整形（行末スペース削除）
  registerConvenientFeatures(context);
  // Weblio検索
  registerWeblioSearch(context);
  // カーソル移動
  registerCursorCommands(context);
}

/**
 * プレビュー Webview が残らないように明示破棄する。
 */
function deactivate() {
}

module.exports = { activate, deactivate };
