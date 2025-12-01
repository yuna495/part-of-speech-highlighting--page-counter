// sidebar_headings.js
const vscode = require("vscode");
const { getHeadingLevel, getHeadingMetricsCached } = require("./utils");
const path = require("path");

/** 1行から見出しテキスト本体を抽出（先頭 # と余分な空白を除去） */
// TreeView で表示しやすいように見出し記号を剥がす
function stripHeadingMarkup(lineText) {
  return lineText.replace(/^ {0,3}#{1,6}\s+/, "").trim();
}

/** 見出しアイコン（Codicon）。レベルに応じて変える例 */
// media/ 以下に用意した画像をレベル別に使い分ける
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
   */
  constructor(label, uri, line, level, countText) {
    super(label);
    this.resourceUri = uri;
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

/** 見出しツリーのデータ提供 */
// TreeDataProvider を実装してサイドバーへ見出し一覧を供給する
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

  /** アクティブエディタから見出しを抽出してノード配列にする */
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
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) {
        const label = stripHeadingMarkup(text);
        const countText = countByLine.get(i) || "";
        items.push(new HeadingNode(label, doc.uri, i, lvl, countText));
      }
    }
    this._items = items;
    return items;
  }
}

/** コマンド：見出し位置へ移動し、行を表示 */
// コマンド: TreeView から選択した見出しへジャンプする
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

/**
 * エントリポイント：サイドバーを登録
 * @param {vscode.ExtensionContext} context
 * @param {{cfg:()=>any, isTargetDoc:(doc:any,c:any)=>boolean}} helpers
 */
// サイドバー TreeView を初期化し、イベントやコマンドを登録する
function initHeadingSidebar(context, helpers) {
  const provider = new HeadingsProvider(helpers);

  // TreeView を登録（"posNoteHeadings" は自由に変更可）
  const tree = vscode.window.createTreeView("posNoteHeadings", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(tree);

  // コマンド登録
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.headings.refresh", () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand("posNote.headings.reveal", revealHeading)
  );

  // イベントで自動更新
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posNote")) provider.refresh();
    })
  );

  return provider;
}

module.exports = { initHeadingSidebar };
