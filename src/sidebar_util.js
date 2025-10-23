// src/sidebar_util.js
// サイドバー
//
// 1) 最上段に「新しい小説を作成」ボタン風アイテム
// 2) アクティブエディタのファイルと「同じフォルダ」を簡易エクスプローラ表示
//    - 同フォルダ直下の *.json を列挙
//    - plot/ は展開可能（配下のファイル/フォルダを列挙）
// 3) 各項目クリックで当該リソースをエディタで開く
//
// 既存 NewNovel 雛形作成機能も維持

const vscode = require("vscode");
const path = require("path");
const { combineTxtInFolder, combineMdInFolder } = require("./combine");

// 直近に確定したベースフォルダ（テキスト以外を開いた時のフォールバック用）
let _lastPinnedBaseDirUri = null;

// ===== エントリーポイント =====
function initSidebarUtilities(context) {
  const provider = new UtilitiesProvider(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("novelUtilities", provider)
  );

  // === 追加: TreeViewタイトルを動的に変更 ===
  const treeView = vscode.window.createTreeView("novelUtilities", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  function updateViewTitle() {
    const base = getSidebarBaseDirUri();
    if (base) {
      const folderName = path.basename(base.fsPath);
      treeView.title = `- ${folderName} -`;
    } else {
      treeView.title = "各種操作・ファイル";
    }
  }

  // 起動時とエディタ切替時に更新
  updateViewTitle();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateViewTitle())
  );

  // --- コマンド: 新しい小説を作成
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.createNewNovel", async () => {
      await createNewNovelScaffold();
      vscode.window.showInformationMessage("NewNovel フォルダを作成しました");
      provider.refresh();
    })
  );

  // --- コマンド: ビューを前面に
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.revealView", async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.posNote"
        );
      } catch {}
    })
  );

  // --- コマンド: リソースを開く
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.openResource", async (uri) => {
      if (!uri) return;
      try {
        // どの拡張子でも VS Code 既定のビューアで開く
        await vscode.commands.executeCommand("vscode.open", uri, {
          preview: false,
        });
      } catch (e) {
        // フォルダなどは OS 側で見せる
        await vscode.commands.executeCommand("revealInExplorer", uri);
      }
    })
  );

  // 現在のフォルダに雛形を作成
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.createScaffoldHere", async () => {
      const base = getSidebarBaseDirUri();
      if (!base) {
        vscode.window.showWarningMessage(
          "アクティブなエディタのあるファイルを開いてください"
        );
        return;
      }
      await createScaffoldInFolder(base);
      provider.refresh();
      vscode.window.showInformationMessage(
        `雛形を作成しました: ${base.fsPath}`
      );
    })
  );

  // サイドバー用『このフォルダの .txt を結合』
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.combineTxtHere", async () => {
      const base = getSidebarBaseDirUri();
      if (!base) {
        vscode.window.showWarningMessage(
          "アクティブなエディタのあるファイルを開いてください"
        );
        return;
      }
      await combineTxtInFolder(base);
      provider.refresh();
    })
  );

  // サイドバー用『このフォルダの .md を結合』
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.combineMdHere", async () => {
      const base = getSidebarBaseDirUri();
      if (!base) {
        vscode.window.showWarningMessage(
          "アクティブなエディタのあるファイルを開いてください"
        );
        return;
      }
      await combineMdInFolder(base);
      provider.refresh();
    })
  );

  // アクティブエディタやワークスペースの変化で再描画
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidCreateFiles(() => provider.refresh()),
    vscode.workspace.onDidDeleteFiles(() => provider.refresh()),
    vscode.workspace.onDidRenameFiles(() => provider.refresh())
  );

  // 新規ファイル
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.newFileAt", async (arg) => {
      const base = await resolveBaseForSibling(arg);
      if (!base) return;
      const name = await vscode.window.showInputBox({
        prompt: "新規ファイル名",
        value: "untitled.txt",
      });
      if (!name) return;
      const target = vscode.Uri.joinPath(base, name);
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      vscode.window.showInformationMessage(`作成: ${target.fsPath}`);
      provider.refresh();
    })
  );

  // 新規フォルダ
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.newFolderAt", async (arg) => {
      const base = await resolveBaseForSibling(arg);
      if (!base) return;
      const name = await vscode.window.showInputBox({
        prompt: "新規フォルダ名",
        value: "NewFolder",
      });
      if (!name) return;
      const target = vscode.Uri.joinPath(base, name);
      await vscode.workspace.fs.createDirectory(target);
      vscode.window.showInformationMessage(`作成: ${target.fsPath}`);
      provider.refresh();
    })
  );

  // コピー
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.copyPath", async (arg) => {
      const uri = asUri(arg);
      if (!uri) return;
      await setClipboardEntry("copy", uri);
      vscode.window.showInformationMessage("コピーに追加しました");
    })
  );

  // 切り取り
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.cutPath", async (arg) => {
      const uri = asUri(arg);
      if (!uri) return;
      await setClipboardEntry("cut", uri);
      vscode.window.showInformationMessage("切り取りに追加しました");
    })
  );

  // 貼り付け
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.pasteHere", async (arg) => {
      const destDir = await resolveBaseForSibling(arg);
      if (!destDir) return;

      const entry = await getClipboardEntry();
      if (!entry || !entry.paths?.length) {
        vscode.window.showWarningMessage("貼り付け可能な内容がありません");
        return;
      }
      const fsapi = vscode.workspace.fs;
      for (const p of entry.paths) {
        const src = vscode.Uri.file(p);
        const baseName = path.basename(p);

        // 同じ場所に cut で貼るのは無意味 防止
        const sameDir = path.dirname(p) === destDir.fsPath;
        if (entry.op === "cut" && sameDir) {
          vscode.window.showWarningMessage("同一フォルダへの移動は不要です");
          continue;
        }

        // 既存衝突を避ける
        const dst = await uniqueChildPath(destDir, baseName);

        try {
          if (entry.op === "cut") {
            await fsapi.rename(src, dst, { overwrite: false });
          } else {
            await fsapi.copy(src, dst, { overwrite: false });
          }
        } catch (e) {
          vscode.window.showErrorMessage(`貼り付けに失敗: ${baseName}`);
        }
      }
      vscode.window.showInformationMessage("貼り付け完了");
      provider.refresh();
    })
  );

  // 削除
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.deleteResource", async (arg) => {
      const uri = asUri(arg);
      if (!uri) return;
      const pick = await vscode.window.showWarningMessage(
        `削除しますか？\n${uri.fsPath}`,
        { modal: true },
        "削除"
      );
      if (pick !== "削除") return;
      await vscode.workspace.fs.delete(uri, {
        recursive: true,
        useTrash: true,
      });
      vscode.window.showInformationMessage("削除しました");
      provider.refresh();
    })
  );

  // --- 追加: サイドバーのフォルダ右クリック用『このフォルダの .txt を結合』
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.combineTxtAt", async (arg) => {
      const base = await resolveBaseForSibling(arg); // フォルダならそのまま, ファイルなら親フォルダ
      if (!base) {
        vscode.window.showWarningMessage("対象フォルダを解決できませんでした");
        return;
      }
      await combineTxtInFolder(base); // 既存の結合ロジックを利用
    })
  );

  // --- 追加: サイドバーのフォルダ右クリック用『このフォルダの .md を結合』
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.combineMdAt", async (arg) => {
      const base = await resolveBaseForSibling(arg);
      if (!base) {
        vscode.window.showWarningMessage("対象フォルダを解決できませんでした");
        return;
      }
      await combineMdInFolder(base);
    })
  );

  // 外部エクスプローラー
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.revealInOS", async (arg) => {
      const uri = asUri(arg);
      if (!uri) return;
      try {
        await vscode.commands.executeCommand("revealFileInOS", uri);
      } catch {
        await vscode.env.openExternal(uri);
      }
    })
  );
}

// ===== TreeDataProvider =====
class UtilitiesProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }
  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    // 子要素要求
    if (element && element instanceof FsTreeItem && element.isFolder) {
      return await listFolderChildren(element.resourceUri);
    }

    // ルート要素
    const items = [];
    // base定義
    const base = getSidebarBaseDirUri();

    // 現在フォルダの内容を列挙
    if (!base) {
      const warn = new vscode.TreeItem(
        "アクティブなエディタがありません",
        vscode.TreeItemCollapsibleState.None
      );
      warn.tooltip = "ファイルを開くと同じフォルダの内容が表示されます";
      warn.iconPath = new vscode.ThemeIcon("info");
      items.push(warn);
      return items;
    }

    // 同階層の全ファイル
    const fileItems = await listFilesAt(base);

    // plot/ フォルダ（存在すれば）
    const plotUri = vscode.Uri.joinPath(base, "plot");
    const plotItem = await makeFolderItemIfExists(plotUri, "plot");

    if (plotItem) {
      items.push(plotItem);
    }

    items.push(...fileItems);

    if (items.length <= 2) {
      const empty = new vscode.TreeItem(
        "このフォルダには表示対象がありません",
        vscode.TreeItemCollapsibleState.None
      );
      empty.iconPath = new vscode.ThemeIcon("warning");
      items.push(empty);
    }

    return items;
  }
}

// ===== TreeItem ヘルパ =====
class FsTreeItem extends vscode.TreeItem {
  constructor(label, collapsibleState, resourceUri, { isFolder = false } = {}) {
    super(label, collapsibleState);
    this.resourceUri = resourceUri;
    this.isFolder = isFolder;
    if (isFolder) this.iconPath = new vscode.ThemeIcon("folder");
    else this.iconPath = vscode.ThemeIcon.File;
    this.command = !isFolder
      ? {
          command: "posNote.openResource",
          title: "開く",
          arguments: [resourceUri],
        }
      : undefined;
    this.contextValue = isFolder ? "noveltools.folder" : "noveltools.file";
    if (resourceUri) this.tooltip = resourceUri.fsPath;
  }
}

// 拡張子ごとのソート優先度
function extPriority(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".txt") return 1;
  if (ext === ".md") return 2;
  if (ext === ".json") return 3;
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") return 4;
  return 9; // その他
}

// ===== クリップボード I/O =====
const CLIP_PREFIX = "NOVELTOOLS_CLIP:";

// TreeItem / Uri どちらでも Uri へ
function asUri(arg) {
  if (!arg) return null;
  if (arg instanceof vscode.Uri) return arg;
  if (arg.resourceUri instanceof vscode.Uri) return arg.resourceUri;
  if (arg.uri instanceof vscode.Uri) return arg.uri;
  return null;
}

// フォルダならそのまま それ以外は親フォルダ
async function resolveBaseForSibling(arg) {
  const uri = asUri(arg);
  if (!uri) return null;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) return uri;
    if (stat.type === vscode.FileType.File) {
      return vscode.Uri.file(path.dirname(uri.fsPath));
    }
  } catch {}
  return null;
}

async function setClipboardEntry(op, uri) {
  const payload = { op, paths: [uri.fsPath] };
  await vscode.env.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload));
}

async function getClipboardEntry() {
  const text = await vscode.env.clipboard.readText();
  if (!text) return null;

  // 新方式
  if (text.startsWith(CLIP_PREFIX)) {
    try {
      return JSON.parse(text.slice(CLIP_PREFIX.length));
    } catch {
      return null;
    }
  }
  // 旧方式（互換）
  if (text.startsWith("[cut] ")) {
    return { op: "cut", paths: [text.replace("[cut] ", "")] };
  }
  // 生のパスは copy とみなす
  return { op: "copy", paths: [text] };
}

// 衝突しないファイル名を作る
async function uniqueChildPath(dirUri, baseName) {
  const fsapi = vscode.workspace.fs;
  let name = baseName;
  let i = 1;
  while (true) {
    const target = vscode.Uri.joinPath(dirUri, name);
    try {
      await fsapi.stat(target);
      const ext = path.extname(baseName);
      const stem = path.basename(baseName, ext);
      i++;
      name = ext ? `${stem} (${i})${ext}` : `${stem} (${i})`;
    } catch {
      return vscode.Uri.joinPath(dirUri, name);
    }
  }
}

// ====== フォルダ列挙 ======
async function listFolderChildren(folderUri) {
  const fs = vscode.workspace.fs;
  let entries = [];
  try {
    entries = await fs.readDirectory(folderUri);
  } catch {
    return [];
  }

  // 優先度: フォルダ(0) → .txt(1) → .md(2) → .json(3) → その他(9)
  entries.sort((a, b) => {
    const [nameA, typeA] = a;
    const [nameB, typeB] = b;

    // フォルダ優先
    const priA = typeA === vscode.FileType.Directory ? 0 : extPriority(nameA);
    const priB = typeB === vscode.FileType.Directory ? 0 : extPriority(nameB);

    if (priA !== priB) return priA - priB;
    return nameA.localeCompare(nameB, "ja");
  });

  const items = entries.map(([name, type]) => {
    const uri = vscode.Uri.joinPath(folderUri, name);
    if (type === vscode.FileType.Directory) {
      return new FsTreeItem(
        name,
        vscode.TreeItemCollapsibleState.Collapsed,
        uri,
        { isFolder: true }
      );
    }
    return new FsTreeItem(name, vscode.TreeItemCollapsibleState.None, uri, {
      isFolder: false,
    });
  });

  return items;
}

// ====== 同階層の全ファイルを列挙（拡張子優先→名前順） ======
async function listFilesAt(baseDirUri) {
  const fs = vscode.workspace.fs;
  let entries = [];
  try {
    entries = await fs.readDirectory(baseDirUri);
  } catch {
    return [];
  }

  // ファイルのみ抽出
  const files = entries
    .filter(([_, type]) => type === vscode.FileType.File)
    .map(([name]) => name);

  // 優先度: .txt → .md → .json → その他、同一拡張子内は名前昇順
  files.sort((a, b) => {
    const pa = extPriority(a);
    const pb = extPriority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b, "ja");
  });

  return files.map((name) => {
    const uri = vscode.Uri.joinPath(baseDirUri, name);
    return new FsTreeItem(name, vscode.TreeItemCollapsibleState.None, uri, {
      isFolder: false,
    });
  });
}

async function makeFolderItemIfExists(folderUri, label) {
  const fs = vscode.workspace.fs;
  try {
    const stat = await fs.stat(folderUri);
    if (stat.type === vscode.FileType.Directory) {
      return new FsTreeItem(
        label,
        vscode.TreeItemCollapsibleState.Collapsed,
        folderUri,
        { isFolder: true }
      );
    }
  } catch {}
  return null;
}

// 現在のフォルダに雛形を作成
async function createScaffoldInFolder(baseUri) {
  const fs = vscode.workspace.fs;

  // plot/ を用意（既存でも OK）
  const plotUri = vscode.Uri.joinPath(baseUri, "plot");
  try {
    await fs.createDirectory(plotUri);
  } catch {
    // 既にあれば無視
  }

  // 既存ユーティリティで「無ければ書く」
  await writeFileIfNotExists(
    vscode.Uri.joinPath(plotUri, "characters.md"),
    toUint8(defaultPlotCharactersMd())
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(plotUri, "plot.md"),
    toUint8(defaultPlotMd())
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(baseUri, "characters.json"),
    toUint8(JSON.stringify(defaultCharacters(), null, 2))
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(baseUri, "conversion.json"),
    toUint8(JSON.stringify(defaultConversion(), null, 2))
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(baseUri, "glossary.json"),
    toUint8(JSON.stringify(defaultGlossary(), null, 2))
  );
}

// ====== 現在アクティブファイルの親フォルダ ======
function getSidebarBaseDirUri() {
  const ed = vscode.window.activeTextEditor;
  const docUri = ed?.document?.uri;

  // アクティブエディタがファイルなら従来どおり算出して更新
  if (docUri && docUri.scheme === "file") {
    const fsPath = path.normalize(docUri.fsPath);
    let dir = path.dirname(fsPath);

    // 最後の "plot" の親まで遡る既存仕様
    const parts = dir.split(path.sep);
    const lastPlotIdx = parts.lastIndexOf("plot");
    if (lastPlotIdx !== -1) {
      const parentParts = parts.slice(0, lastPlotIdx);
      const parentPath = parentParts.length
        ? parentParts.join(path.sep)
        : path.sep;
      _lastPinnedBaseDirUri = vscode.Uri.file(parentPath);
      return _lastPinnedBaseDirUri;
    }

    _lastPinnedBaseDirUri = vscode.Uri.file(dir);
    return _lastPinnedBaseDirUri;
  }

  // 画像プレビューなどテキスト以外に切り替わった場合は直近のベースを維持
  return _lastPinnedBaseDirUri;
}

// ====== NewNovel 雛形 ======
async function createNewNovelScaffold() {
  const ws = vscode.workspace.workspaceFolders;
  let baseUri;

  if (!ws || ws.length === 0) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "ここに NewNovel を作成",
    });
    if (!picked || picked.length === 0) {
      vscode.window.showWarningMessage("フォルダが選択されませんでした");
      return;
    }
    baseUri = picked[0];
  } else {
    baseUri = ws[0].uri;
  }

  const fs = vscode.workspace.fs;
  const targetUri = await uniqueFolder(baseUri, "NewNovel");

  const plotUri = vscode.Uri.joinPath(targetUri, "plot");
  await fs.createDirectory(plotUri);

  await writeFileIfNotExists(
    vscode.Uri.joinPath(plotUri, "characters.md"),
    toUint8(defaultPlotCharactersMd())
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(plotUri, "plot.md"),
    toUint8(defaultPlotMd())
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(targetUri, "characters.json"),
    toUint8(JSON.stringify(defaultCharacters(), null, 2))
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(targetUri, "conversion.json"),
    toUint8(JSON.stringify(defaultConversion(), null, 2))
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(targetUri, "glossary.json"),
    toUint8(JSON.stringify(defaultGlossary(), null, 2))
  );
  await writeFileIfNotExists(
    vscode.Uri.joinPath(targetUri, "novel.txt"),
    toUint8(defaultNovelTxt())
  );

  await vscode.commands.executeCommand("revealInExplorer", targetUri);
}

async function uniqueFolder(parentUri, baseName) {
  const fs = vscode.workspace.fs;
  let n = 1;
  while (true) {
    const name = n === 1 ? baseName : `${baseName}-${n}`;
    const candidate = vscode.Uri.joinPath(parentUri, name);
    try {
      await fs.stat(candidate);
      n++;
    } catch {
      await fs.createDirectory(candidate);
      return candidate;
    }
  }
}

async function writeFileIfNotExists(uri, contentUint8) {
  const fs = vscode.workspace.fs;
  try {
    await fs.stat(uri);
  } catch {
    await fs.writeFile(uri, contentUint8);
  }
}

function toUint8(str) {
  return new TextEncoder().encode(str);
}

// ---- デフォルト雛形（ユーザー指定の成形） ----
function defaultPlotCharactersMd() {
  return [
    "# 相関",
    "",
    "```graphviz",
    "digraph G {",
    '  graph [bgcolor="#000000"];',
    "  node  [",
    "    fontsize=18,",
    '    fontcolor="#46d2e8",',
    '    color="#00ff66",',
    "    penwidth=2,",
    "  ];",
    "  edge  [",
    '    color="#ff14e0",',
    '    fontcolor="#ff9bd6",',
    "    fontsize=14",
    "  ];",
    "",
    '  1 -> 2 [label="a"];',
    '  2 -> 3 [label="b"];',
    '  3 -> 1 [label="c"];',
    "}",
    "```",
    "",
    "## main",
    "",
    "### 1",
    "",
    "- 性別:",
    "- 年齢:",
    "- 見た目",
    "",
    "- 特徴",
    "",
    "- 性格",
    "",
    "- 口調",
    "",
    "- 追記",
    "",
    "## sub",
    "",
    "### 1",
    "",
    "- 性別:",
    "- 年齢:",
    "- 見た目",
    "",
    "- 特徴",
    "",
    "- 性格",
    "",
    "- 口調",
    "",
    "- 追記",
    "",
  ].join("\n");
}

function defaultPlotMd() {
  return [
    "# 『』",
    "",
    "## テーマ",
    "",
    "## 舞台・背景",
    "",
    "### 時代背景",
    "",
    "### 舞台",
    "",
    "### その他",
    "",
    "## その他設定",
    "",
    "## 構成",
    "",
    "### 起承転結",
    "",
    "- 起",
    "",
    "- 承",
    "",
    "- 転",
    "",
    "- 結",
    "",
    "### 章立て",
    "",
    "1. a",
    "",
    "2. b",
    "",
    "3. c",
    "",
    "4. d",
    "",
    "## 作品紹介",
    "",
    "- キャッチコピー",
    "",
    "- 紹介文",
    "",
  ].join("\n");
}
function defaultCharacters() {
  return ["character"];
}
function defaultGlossary() {
  return ["glossary"];
}
function defaultConversion() {
  return { "alt + .": "ctrl + ." };
}
function defaultNovelTxt() {
  return [
    "# タイトル",
    "",
    "　——ここから本文を開始してください。",
    "　章見出しは `# `、節は `## ` のように Markdown 形式。",
  ].join("\n");
}

module.exports = { initSidebarUtilities };
