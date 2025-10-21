// ===========================================
//  日本語 品詞ハイライト（Semantic）＋ページカウンタ 拡張メイン
//  - semantic.js: 形態素解析 → Semantic Tokens
//  - status_bar.js: 原稿用紙風ページ/文字数・禁則処理
//  - sidebar_headings.js / minimap_highlight.js: 見出しビュー/ミニマップ
//  - utils.js: 共通ユーティリティ（getHeadingLevel）
//  - bracket.js: 括弧補完
//  - headline.js: 見出し操作
// ===========================================

// ===== 1) Imports =====
const vscode = require("vscode");
const { initStatusBar, getBannedStart } = require("./status_bar");
const { initWorkload } = require("./workload");
const { initHeadingSidebar } = require("./sidebar_headings");
const { initSidebarUtilities } = require("./sidebar_util");
const { initMinimapHighlight } = require("./minimap_highlight");
const { JapaneseSemanticProvider, semanticLegend } = require("./semantic");
const { PreviewPanel } = require("./preview_panel");
const { registerBracketSupport } = require("./bracket");
const { registerHeadlineSupport, refreshHeadingCounts } = require("./headline");

const { registerHeadingSymbolProvider } = require("./headline_symbols");
const { combineTxtInFolder, combineMdInFolder } = require("./combine");
const { registerRubySupport } = require("./ruby");
const { registerConversionCommands } = require("./conversion");

// ===== 3) Module State =====
let _sb = null; // status_bar の公開API（activateで初期化）
let _workload = null;

// ===== 4) Config Helper =====
// 拡張設定を都度読み込んで機能ごとのフラグや値をまとめて返す
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
    bracketsBackspacePairDelete: c.get("brackets.backspacePairDelete", true), // ← 追加：互換モードでのみ true 推奨
  };
}

// 対象ドキュメントか？
// この拡張の対象とするドキュメントかを判定する
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

// ===== 9) activate / deactivate =====
// 拡張機能のメイン初期化。各モジュールの登録とイベント配線を担う
function activate(context) {
  // --- 9-1) 初期化（StatusBar/Sidebar/Minimap）
  const sb = (_sb = initStatusBar(context, { cfg, isTargetDoc }));
  _workload = initWorkload(context);
  initHeadingSidebar(context, { cfg, isTargetDoc });
  initMinimapHighlight(context, { cfg, isTargetDoc });
  initSidebarUtilities(context);

  // --- 9-2) Semantic Provider を先に用意（イベントから参照するため）
  const semProvider = new JapaneseSemanticProvider(context, { cfg });

  // 括弧補完＋Backspace同時削除（外部モジュールへ委譲）
  registerBracketSupport(context, { cfg, isTargetDoc });

  // 見出し機能（外部モジュール）
  registerHeadlineSupport(context, { cfg, isTargetDoc, sb, semProvider });
  // 見出しシンボル（アウトライン／パンくず／Sticky Scroll 用）
  registerHeadingSymbolProvider(context);
  // ルビ/傍点 機能（外部モジュール）
  registerRubySupport(context);

  // 既存コマンドと衝突しないよう事前確認してから登録するヘルパー
  async function safeRegisterCommand(context, id, fn) {
    const cmds = await vscode.commands.getCommands(true); // すべてのコマンドID
    if (cmds.includes(id)) return; // 既に存在 → 登録しない
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

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
    vscode.commands.registerCommand("posNote.Preview.open", () => {
      PreviewPanel.show(context.extensionUri, context);
    }),
    vscode.commands.registerCommand("posNote.Preview.refresh", () => {
      PreviewPanel.update();
    }),
    vscode.commands.registerCommand("posNote.combineTxt", (resourceUri) => {
      // エクスプローラーで右クリックしたフォルダ URI が渡ってくる
      return combineTxtInFolder(resourceUri);
    }),
    vscode.commands.registerCommand("posNote.combineMd", (resourceUri) => {
      return combineMdInFolder(resourceUri);
    })
  );
  // 置換コマンド（かな↔漢字）
  registerConversionCommands(context, { isTargetDoc });

  safeRegisterCommand(context, "posNote.headings.refresh", () => {
    const ed = vscode.window.activeTextEditor;
    if (ed) refreshHeadingCounts(ed, cfg);
  });

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

  // --- 9-5) Events
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      const c = cfg();

      // 1) テキストを一度だけ取得
      const txt = e.document.getText().replace(/\r\n/g, "\n");

      // 2) 作業量用の「全文字長」（改行は1字扱い）
      const rawLen = Array.from(txt).length; // workload.js の countCharsWithNewline と整合

      // ★候補巡回らしさの軽量判定
      // 置換のみ ＋ 長さ純差が小さい変化が続いているかを見る
      const imeLike =
        e.contentChanges.length > 0 &&
        // 「置換」だけを見る（削除 or 追加単独は対象外）
        e.contentChanges.every(
          (ch) => ch.rangeLength > 0 && ch.text.length > 0
        ) &&
        // 一回の変更で長さの純差が ±2 以上なら IME らしいとみなす
        e.contentChanges.some(
          (ch) => Math.abs(ch.text.length - ch.rangeLength) >= 2
        );

      // 3) ステータスバー用の「表示ルール文字数」
      const { countCharsForDisplay } = require("./utils");
      const shownLen = countCharsForDisplay(txt, c);

      // 4) 作業量へフィード（doc.getText() させない）
      const { applyExternalLen } = require("./workload");
      applyExternalLen(e.document.uri.toString(), rawLen, { imeLike }); // ★IME中は1000ms待機へ

      // 5) ステータスバーへフィード（再計算させない）
      sb.scheduleUpdateWithPrecount(ed, shownLen);
    }),

    // 保存：即時確定計算（Git差分/見出しビュー）
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        sb.recomputeOnSaveIfNeeded(doc);
        refreshHeadingCounts(ed, cfg);
        // プレビューの再描画（保存時のみ）
        PreviewPanel.update();
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

    // 設定変更：確定計算＋軽い更新＋セマンティック再発行（MarkdownのON/OFF即時反映）
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
}

// プレビューWebviewが残らないよう終了時に明示破棄する
function deactivate() {
  if (PreviewPanel.currentPanel) {
    PreviewPanel.currentPanel.dispose();
  }
}

module.exports = { activate, deactivate };
