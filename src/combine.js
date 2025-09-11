// src/combine.js
// フォルダ直下の .txt / .md をファイル名順に結合し、同フォルダへ出力
// - 右クリックされたフォルダの URI を受け取り、拡張子別に動作
// - 連結時は OS 依存改行を '\n' に正規化、ファイル間に空行1つを挿入
// - 既存の出力ファイルがあれば衝突回避（combined(1).ext, (2)...）
// - 先頭/末尾の BOM は付与しない（UTF-8）

const vscode = require("vscode");

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * 指定フォルダ直下の指定拡張子ファイルをファイル名昇順で取得
 */
async function listFilesByExt(folderUri, ext /* ".txt" など */) {
  const entries = await vscode.workspace.fs.readDirectory(folderUri);
  return entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File && name.toLowerCase().endsWith(ext)
    )
    .map(([name]) => name)
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
}

/**
 * テキストを結合用に正規化:
 * - 改行コードを \n に統一
 * - 末尾に改行が無ければ付与
 */
function normalizeTextForConcat(text) {
  const unified = text.replace(/\r\n?/g, "\n");
  return unified.endsWith("\n") ? unified : unified + "\n";
}

/**
 * フォルダにファイルを書き出す際、重複したら (1), (2)... を付けて回避
 */
async function resolveCollisionFilename(
  folderUri,
  baseName /* "combined" */,
  ext /* ".txt" */
) {
  let candidate = vscode.Uri.joinPath(folderUri, `${baseName}${ext}`);
  try {
    await vscode.workspace.fs.stat(candidate);
    // 存在したら連番
    let i = 1;
    while (true) {
      const c = vscode.Uri.joinPath(folderUri, `${baseName}(${i})${ext}`);
      try {
        await vscode.workspace.fs.stat(c);
        i++;
      } catch {
        return c;
      }
    }
  } catch {
    // 無ければそのまま
    return candidate;
  }
}

/**
 * 中核: 結合処理
 */
async function combineByExtension(folderUri, ext, outBaseName) {
  if (!folderUri) {
    vscode.window.showErrorMessage(
      "フォルダ URI が渡されていません。エクスプローラーでフォルダを右クリックして実行してください。"
    );
    return;
  }

  // 直下ファイルを列挙
  const files = await listFilesByExt(folderUri, ext);
  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `このフォルダ直下に ${ext} ファイルが見つかりません。`
    );
    return;
  }

  // 読み込み & 結合
  const parts = [];
  for (const name of files) {
    const fileUri = vscode.Uri.joinPath(folderUri, name);
    try {
      const bin = await vscode.workspace.fs.readFile(fileUri);
      const text = decoder.decode(bin);
      parts.push(normalizeTextForConcat(text));
    } catch (e) {
      vscode.window.showWarningMessage(`読み込み失敗: ${name} (${String(e)})`);
    }
  }

  if (parts.length === 0) {
    vscode.window.showWarningMessage("結合できる内容がありませんでした。");
    return;
  }

  // ファイル間に空行1つ（= \n 1行）を挿入
  const joined = parts.join("\n");

  // 出力ファイル名決定
  const outUri = await resolveCollisionFilename(folderUri, outBaseName, ext);

  // 書き出し
  await vscode.workspace.fs.writeFile(outUri, encoder.encode(joined));

  // 完了通知 & 開く
  vscode.window.showInformationMessage(`結合完了: ${outUri.fsPath}`);
  try {
    await vscode.commands.executeCommand("vscode.open", outUri);
  } catch {}
}

/**
 * 公開 API: .txt / .md 専用
 */
async function combineTxtInFolder(folderUri) {
  return combineByExtension(folderUri, ".txt", "combined");
}

async function combineMdInFolder(folderUri) {
  return combineByExtension(folderUri, ".md", "combined");
}

module.exports = {
  combineTxtInFolder,
  combineMdInFolder,
};
