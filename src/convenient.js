// convenient.js
// ======================================================
// 便利系自動整形：行末の全角・半角スペース削除
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

  // 自動保存抑止 → ここで再保存
  await doc.save();
}

/**
 * 拡張機能の初期化
 * @param {vscode.ExtensionContext} context
 */
function registerConvenientFeatures(context) {
  // 保存時に行末スペースを削除
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      try {
        await trimTrailingSpaces(doc);
      } catch (err) {
        console.error("[POSNote:convenient] trim error:", err);
      }
    })
  );
}

module.exports = { registerConvenientFeatures };
