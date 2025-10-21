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

// ===== エントリーポイント =====
function initSidebarUtilities(context) {
  const provider = new UtilitiesProvider(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("novelUtilities", provider)
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
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch (e) {
        // フォルダの可能性 → エクスプローラ上で開く
        await vscode.commands.executeCommand("revealInExplorer", uri);
      }
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

    // 1) 最上段アクション
    const newNovel = new vscode.TreeItem(
      "新しい小説を作成",
      vscode.TreeItemCollapsibleState.None
    );
    newNovel.description = "雛形をワークスペースに作成";
    newNovel.command = {
      command: "posNote.createNewNovel",
      title: "新しい小説を作成",
    };
    newNovel.iconPath = new vscode.ThemeIcon("add");
    newNovel.contextValue = "noveltools.action";
    items.push(newNovel);

    // 連結ボタン（.txt）
    const concatTxt = new vscode.TreeItem(
      "親フォルダの .txt を結合",
      vscode.TreeItemCollapsibleState.None
    );
    concatTxt.description = "ファイル名順で連結し同フォルダへ出力";
    concatTxt.command = { command: "posNote.combineTxtHere", title: "結合" };
    concatTxt.iconPath = new vscode.ThemeIcon("merge");
    concatTxt.contextValue = "noveltools.action";
    items.push(concatTxt);

    // 連結ボタン（.md）
    const concatMd = new vscode.TreeItem(
      "親フォルダの .md を結合",
      vscode.TreeItemCollapsibleState.None
    );
    concatMd.description = "ファイル名順で連結し同フォルダへ出力";
    concatMd.command = { command: "posNote.combineMdHere", title: "結合" };
    concatMd.iconPath = new vscode.ThemeIcon("merge");
    concatMd.contextValue = "noveltools.action";
    items.push(concatMd);

    // 2) セクション見出し（表示だけ）
    const section = new vscode.TreeItem(
      "——現在のフォルダ——",
      vscode.TreeItemCollapsibleState.None
    );
    section.iconPath = new vscode.ThemeIcon("folder-library");
    section.contextValue = "noveltools.section";
    items.push(section);

    // 3) 現在フォルダの内容を列挙
    const base = getSidebarBaseDirUri();
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

  // フォルダ→先, ファイル→後, 名前昇順
  entries.sort((a, b) => {
    const [nameA, typeA] = a;
    const [nameB, typeB] = b;
    if (typeA !== typeB) return typeA === vscode.FileType.Directory ? -1 : 1;
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

// ====== 同階層の全ファイルを列挙（拡張子無制限） ======
async function listFilesAt(baseDirUri) {
  const fs = vscode.workspace.fs;
  let entries = [];
  try {
    entries = await fs.readDirectory(baseDirUri);
  } catch {
    return [];
  }

  // ファイルのみ抽出して名前昇順
  const files = entries
    .filter(([_, type]) => type === vscode.FileType.File)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, "ja"));

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

// ====== 現在アクティブファイルの親フォルダ ======
function getSidebarBaseDirUri() {
  const ed = vscode.window.activeTextEditor;
  const docUri = ed?.document?.uri;
  if (!docUri || docUri.scheme !== "file") return null;

  const fsPath = path.normalize(docUri.fsPath);
  let dir = path.dirname(fsPath);

  // パスを構成要素で解析し、最後に出現する "plot" の親まで遡る
  const parts = dir.split(path.sep);
  const lastPlotIdx = parts.lastIndexOf("plot");
  if (lastPlotIdx !== -1) {
    // plot の親 = parts.slice(0, lastPlotIdx)
    const parentParts = parts.slice(0, lastPlotIdx);
    const parentPath = parentParts.length
      ? parentParts.join(path.sep)
      : path.sep;
    return vscode.Uri.file(parentPath);
  }

  // それ以外は従来どおり “同じフォルダ”
  return vscode.Uri.file(dir);
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
    "## メイン",
    "",
    "### テンプレ",
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
    "## サブ",
    "",
    "### テンプレ",
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
