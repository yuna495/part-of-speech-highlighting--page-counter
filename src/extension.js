// POS/Note 本体。各モジュールを束ね、初期化とコマンド登録を行う。

// ===== 1) Imports =====
const vscode = require("vscode");
const { initStatusBar, getBannedStart } = require("./status_bar");
const { initWorkload } = require("./workload");
const { initHeadings } = require("./headings");
const { initSidebarUtilities } = require("./sidebar_util");
const { initKanbn } = require("./kanbn");
const { JapaneseSemanticProvider, semanticLegend } = require("./semantic");
const { PreviewPanel } = require("./preview_panel");
const { registerBracketSupport } = require("./bracket");
const { registerHeadlineSupport, refreshHeadingCounts, registerHeadingSymbolProvider } = require("./headline");
const { combineTxtInFolder, combineMdInFolder } = require("./combine");
const { registerRubySupport } = require("./ruby");
const { registerConversionCommands } = require("./conversion");
const { registerConvenientFeatures } = require("./convenient");

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
  initHeadings(context, { cfg, isTargetDoc });
  initSidebarUtilities(context);
  initKanbn(context);

  // --- 5-2) Linter（任意）
  const linter = require("./linter");
  if (cfg().linterEnabled) {
    linter.activate(context);
  }

  // --- 5-3) Semantic Provider を先に用意（イベントから参照するため）
  const semProvider = new JapaneseSemanticProvider(context, { cfg });

  // 括弧補完＋Backspace同時削除は外部モジュールへ委譲
  registerBracketSupport(context, { cfg, isTargetDoc });

  // 見出し機能は外部モジュールへ委譲
  registerHeadlineSupport(context, { cfg, isTargetDoc, sb, semProvider });
  // 見出しシンボル（アウトライン／パンくず／Sticky Scroll）
  registerHeadingSymbolProvider(context);
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
    vscode.commands.registerCommand("posNote.Preview.open", () => {
      PreviewPanel.show(context.extensionUri, context);
    }),
    vscode.commands.registerCommand("posNote.Preview.refresh", () => {
      PreviewPanel.refresh({ forceFull: true, showSpinner: true });
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

  safeRegisterCommand(context, "posNote.headings.refresh", () => {
    const ed = vscode.window.activeTextEditor;
    if (ed) refreshHeadingCounts(ed, cfg);
  });

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
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      const c = cfg();

      // 1) テキストを一度だけ取得
      const txt = e.document.getText().replace(/\r\n/g, "\n");

      // 2) 作業量用の全文字数（改行は1字扱い）
      const rawLen = Array.from(txt).length;

      // IME らしい入力かの簡易判定
      const imeLike =
        e.contentChanges.length > 0 &&
        e.contentChanges.every(
          (ch) => ch.rangeLength > 0 && ch.text.length > 0
        ) &&
        e.contentChanges.some(
          (ch) => Math.abs(ch.text.length - ch.rangeLength) >= 2
        );

      // 3) ステータスバー用の表示文字数
      const { countCharsForDisplay } = require("./utils");
      const shownLen = countCharsForDisplay(txt, c);

      // 4) 作業量へフィード
      const { applyExternalLen } = require("./workload");
      applyExternalLen(e.document.uri.toString(), rawLen, { imeLike });

      // 5) ステータスバーへフィード
      sb.scheduleUpdateWithPrecount(ed, shownLen);
    }),

    // 保存：再計算とプレビュー更新
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        sb.recomputeOnSaveIfNeeded(doc);
        refreshHeadingCounts(ed, cfg);
        // プレビューの再描画（設定でONのとき）
        const previewCfg = vscode.workspace.getConfiguration("posNote.Preview");
        if (previewCfg.get("autoRefreshOnSave", true)) {
          const cp = PreviewPanel.currentPanel;
          const sameDoc =
            cp &&
            ((cp._docUri &&
              doc.uri.toString() === cp._docUri.toString()) ||
              (!cp._docUri && cp._editor?.document === doc));
          if (sameDoc) {
            PreviewPanel.refresh({ forceFull: true, showSpinner: true });
          }
        }
      }
    }),

    // アクティブエディタ切替：確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      sb.onActiveEditorChanged(ed);
      refreshHeadingCounts(ed, cfg);

      // 直参照で統一（再 require はしない）
      const cp = PreviewPanel.currentPanel;
      if (
        cp &&
        cp._docUri &&
        ed.document.uri.toString() === cp._docUri.toString()
      ) {
        PreviewPanel.highlight(ed.selection.active.line);
      }
    }),

    // 選択変更：選択文字数の即時反映
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      sb.onSelectionChanged(e.textEditor);

      // 直参照で統一（再 require はしない）
      const cp = PreviewPanel.currentPanel;
      if (
        cp &&
        cp._docUri &&
        e.textEditor.document.uri.toString() === cp._docUri.toString()
      ) {
        PreviewPanel.highlight(e.textEditor.selection.active.line);
      }
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
      refreshHeadingCounts(ed, cfg);
      if (ed) sb.onConfigChanged(ed);
      if (_workload && _workload.onConfigChanged) _workload.onConfigChanged(ed);
      if (semProvider && semProvider.fireDidChange) {
        semProvider.fireDidChange();
      }
    })
  );
  // 保存：自動整形（行末スペース削除）
  registerConvenientFeatures(context);
}

/**
 * プレビュー Webview が残らないように明示破棄する。
 */
function deactivate() {
  if (PreviewPanel.currentPanel) {
    PreviewPanel.currentPanel.dispose();
  }
}

module.exports = { activate, deactivate };
