// convenient.js
// ======================================================
// 便利系自動整形（行末の全角/半角スペース削除）
// ======================================================
const vscode = require("vscode");

/**
 * 行末の全角・半角スペースを削除する
 * @param {vscode.TextDocument} doc
 * @returns {Promise<void>}
 */
async function trimTrailingSpaces(doc) {
  if (!doc || doc.isUntitled || doc.isDirty) return;

  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isTarget =
    lang === "plaintext" ||
    lang === "markdown" ||
    lang === "novel" ||
    fsPath.endsWith(".txt") ||
    fsPath.endsWith(".md");

  if (!isTarget) return;

  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const text = doc.getText();

  // 正規表現で行末スペースを削除
  const newText = text.replace(/[ \u3000]+$/gm, "");

  // 差分がなければ何もしない
  if (text === newText) return;

  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(text.length)
  );

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, newText);
  });

}

/**
 * 選択中の文字列がファイル内で何回出現するかを数え、ステータスバーに表示する。
 */
async function countSelectedString() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const selection = editor.selection;

  const selectedText = selection.isEmpty ? '' : doc.getText(selection);
  if (!selectedText) {
    vscode.window.showInformationMessage('文字列が選択されていません。');
    return;
  }

  const fullText = doc.getText();

  let count = 0;
  let index = 0;
  while (true) {
    index = fullText.indexOf(selectedText, index);
    if (index === -1) {
      break;
    }
    count++;
    index += selectedText.length;
  }

  let displayText = selectedText;
  if (displayText.length > 20) {
    displayText = displayText.slice(0, 20) + '…';
  }

  const message = `「${displayText}」は ${count} 件。`;
  vscode.window.setStatusBarMessage(message, 5000);
}

/**
 * 拡張機能の初期化
 * @param {vscode.ExtensionContext} context
 */
function registerConvenientFeatures(context) {
  // 保存時に行末スペースを削除（既存）
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      try {
        await trimTrailingSpaces(doc);
      } catch (err) {
        console.error("[POSNote:convenient] trim error:", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.convenient.countSelectedString", () =>
      countSelectedString()
    )
  );
}

module.exports = { registerConvenientFeatures };
