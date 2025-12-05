// 見出し関連機能の統合モジュール（サイドバー表示 + ミニマップ強調）
const vscode = require("vscode");
const { getHeadingLevel, getHeadingMetricsCached, getHeadingsCached } = require("./utils");
const path = require("path");

// ============================================================
//  Sidebar (TreeView) Implementation
// ============================================================

/** 1行から見出しテキスト本体を抽出（先頭 # と余分な空白を除去）。TreeView 表示用。 */
function stripHeadingMarkup(lineText) {
  return lineText.replace(/^ {0,3}#{1,6}\s+/, "").trim();
}

/** 見出しアイコン（レベル別）。media/ 以下の画像を使い分ける例。 */
function iconForLevel(level) {
  const mediaPath = path.join(__dirname, "image");
  switch (level) {
    case 1:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading1L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading1D.png")),
      }; // H1
    case 2:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading2L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading2D.png")),
      }; // H2
    case 3:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading3L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading3D.png")),
      }; // H3
    case 4:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading4L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading4D.png")),
      }; // H4
    case 5:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading5L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading5D.png")),
      }; // H5
    default:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading6L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading6D.png")),
      }; // H6
  }
}

/** ツリーノード */
class HeadingNode extends vscode.TreeItem {
  /**
   * @param {string} label 表示ラベル
   * @param {vscode.Uri} uri 対象ドキュメント
   * @param {number} line 行番号（0-based）
   * @param {number} level 見出しレベル(1-6)
   * @param {string} countText 文字数情報
   */
  constructor(label, uri, line, level, countText) {
    super(label);

    // this.resourceUri = uri; // Git差分装飾を避けるため設定しない
    this.line = line;
    this.level = level;
    this.iconPath = iconForLevel(level);
    this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    this.description = countText || "";
    this.command = {
      command: "posNote.headings.reveal",
      title: "Reveal Heading",
      arguments: [uri, line],
    };
    // レベルに応じてインデント風にパディング（任意）
    this.label = `${" ".repeat(Math.max(0, level - 1))}${label}`;
    this.contextValue = "headingNode";
  }
}

/** 見出しツリーのデータ提供（TreeDataProvider）。 */
class HeadingsProvider {
  /**
   * @param {{cfg:()=>any, isTargetDoc:(doc:any,c:any)=>boolean}} helpers
   */
  constructor(helpers) {
    this._helpers = helpers;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._items = [];
  }

  // 外部から呼び出されると TreeView を再描画する
  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** @param {HeadingNode} element */
  getChildren(element) {
    if (element) return []; // フラット表示
    return this._collectHeadingsOfActiveEditor();
  }

  // VS Code に渡す TreeItem をそのまま返す
  getTreeItem(element) {
    return element;
  }

  /** アクティブエディタから見出しを抽出してノード配列にする。 */
  _collectHeadingsOfActiveEditor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return [];
    const { cfg, isTargetDoc } = this._helpers;
    const c = cfg();

    if (!isTargetDoc(ed.document, c)) return [];

    const doc = ed.document;
    // キャッシュ版を利用
    const metrics = getHeadingMetricsCached(doc, c, vscode)?.items || [];
    const countByLine = new Map();
    for (const { line, own, sub } of metrics) {
      const ownShow = own > 0;
      const subShow = sub > 0 && sub !== own;
      if (!ownShow && !subShow) continue;
      let text = "";
      if (ownShow) text += `${own.toLocaleString("ja-JP")}字`;
      if (subShow) text += `${ownShow ? " / " : "/ "}${sub.toLocaleString("ja-JP")}字`;
      countByLine.set(line, text);
    }

    const items = [];
    // metrics.items は既に見出し行のみのリストなので、これを回すだけで良い
    for (const m of metrics) {
      const label = stripHeadingMarkup(m.text);
      const countText = countByLine.get(m.line) || "";
      items.push(new HeadingNode(label, doc.uri, m.line, m.level, countText));
    }
    this._items = items;
    return items;
  }
}

/** コマンド：見出し位置へ移動し、行を表示 */
async function revealHeading(uri, line) {
  // アクティブエディタが同一文書でない場合は開く
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString()) {
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.AtTop
  );
}

// ============================================================
//  Minimap Highlight Implementation
// ============================================================

/** 見出しレベルごとに別デコレーション（ミニマップ前景色） */
function makeDecorationTypes() {
  // テーマに馴染みやすい無彩色寄りのコントラスト配色（必要なら自由に差し替え）
  const colors = [
    "#ff14e0aa", // H1
    "#fd9bcccc", // H2
    "#4dd0e1cc", // H3
    "#11ff84aa", // H4
    "#ffe955aa", // H5
    "#f94446cc", // H6
  ];
  return colors.map((c) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // ミニマップに強調を出す（foreground に塗る）
      // @ts-ignore minimap is available on DecorationRenderOptions at VS Code >= 1.103
      minimap: { color: c, position: "foreground" },
      // ついでに overviewRuler にも痕跡を出す（お好みで）
      overviewRulerColor: c,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    })
  );
}

/** 現在のエディタから見出し行の Range を抽出（レベル別） */
function collectHeadingRanges(editor) {
  const doc = editor.document;
  const headings = getHeadingsCached(doc);
  const byLevel = [[], [], [], [], [], []]; // H1..H6

  for (const h of headings) {
    // isWholeLine:true なので 0〜0 でも行全体に効く
    const pos = new vscode.Position(h.line, 0);
    // h.level は 1〜6 が保証されているはずだが念のため clamp
    const lvIdx = Math.min(Math.max(h.level, 1), 6) - 1;
    byLevel[lvIdx].push(new vscode.Range(pos, pos));
  }
  return byLevel;
}

/** ミニマップ反映 */
function applyMinimapDecorations(editor, decoTypes) {
  const byLevel = collectHeadingRanges(editor);
  for (let i = 0; i < decoTypes.length; i++) {
    editor.setDecorations(decoTypes[i], byLevel[i]);
  }
}

// ============================================================
//  Entry Point
// ============================================================

/**
 * エントリポイント：サイドバーとミニマップハイライトを初期化
 * @param {vscode.ExtensionContext} context
 * @param {{cfg:()=>any, isTargetDoc:(doc:any,c:any)=>boolean}} helpers
 */
function initHeadings(context, helpers) {
  // --- Sidebar Init ---
  const provider = new HeadingsProvider(helpers);
  const tree = vscode.window.createTreeView("posNoteHeadings", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(tree);

  // --- Minimap Init ---
  const decoTypes = makeDecorationTypes();
  context.subscriptions.push({
    dispose: () => decoTypes.forEach((d) => d.dispose()),
  });

  // --- Common Logic ---
  function updateAll(ed) {
    // Sidebar update
    provider.refresh();

    // Minimap update
    if (ed) {
      const c = helpers.cfg();
      if (helpers.isTargetDoc(ed.document, c)) {
        applyMinimapDecorations(ed, decoTypes);
      }
    }
  }

  // --- Register Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.headings.refresh", () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand("posNote.headings.reveal", revealHeading),
    // ミニマップ手動更新（必要なら）
    vscode.commands.registerCommand("posNote.headings.minimapRefresh", () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) updateAll(ed);
    })
  );

  // --- Event Listeners ---
  // 起動直後
  updateAll(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => updateAll(ed)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        updateAll(ed);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posNote")) {
        updateAll(vscode.window.activeTextEditor);
      }
    })
  );

  return provider;
}

module.exports = { initHeadings };
