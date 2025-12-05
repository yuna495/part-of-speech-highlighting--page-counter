// フォルダ直下の .txt / .md を1本に結合する。
// - 改行コードを「\n」に統一し、ファイル間に空行1行を挿入する。
// - 全ファイルを同時に読み込まない。逐次読み込み・逐次書き出しでメモリを抑える。
// - BOM なしの UTF-8 で出力する。

const vscode = require("vscode");
const fs = require("fs");

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * 指定拡張子に一致する直下のファイル名を列挙する（大文字小文字を無視）。
 * @returns {Promise<string[]>}
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
 * 結合用にテキストを正規化する。
 * - CRLF/CR を LF に統一
 * - 末尾に改行を必ず付与
 */
function normalizeTextForConcat(text) {
  const unified = text.replace(/\r\n?/g, "\n");
  return unified.endsWith("\n") ? unified : unified + "\n";
}

/**
 * 出力ファイル名が重複する場合は自動採番して解決する。
 */
async function resolveCollisionFilename(folderUri, baseName /* "combined" */, ext) {
  let candidate = vscode.Uri.joinPath(folderUri, `${baseName}${ext}`);
  try {
    await vscode.workspace.fs.stat(candidate);
    // Exists: find an unused numbered variant
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
    return candidate; // not exists
  }
}

/**
 * 結合の中核処理。順次読み出し→正規化→ストリーム書き出しでメモリ使用を抑える。
 * @param {vscode.Uri} folderUri 出力元フォルダ
 * @param {string} ext 対象拡張子（例: ".txt"）
 * @param {string} outBaseName 出力ファイル名のベース（拡張子なし）
 */
async function combineByExtension(folderUri, ext, outBaseName) {
  if (!folderUri) {
    vscode.window.showErrorMessage(
      "フォルダ URI が渡されていません。エクスプローラーでフォルダを右クリックして実行してください。"
    );
    return;
  }

  const files = await listFilesByExt(folderUri, ext);
  if (files.length === 0) {
    vscode.window.showWarningMessage(`このフォルダ直下に ${ext} ファイルが見つかりません。`);
    return;
  }

  const outUri = await resolveCollisionFilename(folderUri, outBaseName, ext);

  let stream;
  try {
    stream = fs.createWriteStream(outUri.fsPath, { encoding: "utf8" });
  } catch (e) {
    vscode.window.showErrorMessage(`出力ファイルを開けませんでした: ${String(e)}`);
    return;
  }

  let wroteAny = false;
  for (const name of files) {
    const fileUri = vscode.Uri.joinPath(folderUri, name);
    try {
      const bin = await vscode.workspace.fs.readFile(fileUri);
      const text = decoder.decode(bin);
      const normalized = normalizeTextForConcat(text);
      if (wroteAny) stream.write("\n"); // ファイル間に空行を挿入
      stream.write(normalized);
      wroteAny = true;
    } catch (e) {
      vscode.window.showWarningMessage(`読み込み失敗: ${name} (${String(e)})`);
    }
  }

  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });

  if (!wroteAny) {
    vscode.window.showWarningMessage("結合できる対象がありませんでした。");
    try {
      await vscode.workspace.fs.delete(outUri);
    } catch {}
    return;
  }

  vscode.window.showInformationMessage(`結合完了: ${outUri.fsPath}`);
  try {
    await vscode.commands.executeCommand("vscode.open", outUri);
  } catch {}
}

/**
 * Public APIs for context menu commands
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
