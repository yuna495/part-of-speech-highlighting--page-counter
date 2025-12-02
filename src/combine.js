// src/combine.js
// Combine .txt / .md files under a folder into one file.
// - Normalize line endings to "\n" and insert one blank line between files.
// - Avoid loading all files at once; stream sequentially to reduce memory use.
// - Avoid BOM; write UTF-8 text.

const vscode = require("vscode");
const fs = require("fs");

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * List direct children that match an extension (case-insensitive).
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
 * Normalize text for concatenation:
 * - unify CRLF/CR to LF
 * - ensure trailing LF
 */
function normalizeTextForConcat(text) {
  const unified = text.replace(/\r\n?/g, "\n");
  return unified.endsWith("\n") ? unified : unified + "\n";
}

/**
 * Resolve duplicate output name by auto-numbering.
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
 * Core: sequentially read, normalize, and stream-write to reduce peak memory.
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
      if (wroteAny) stream.write("\n"); // blank line between files
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
