// weblio.js
// 選択文字列（またはカーソル位置の単語）を Weblio 類語辞典で検索する機能

const vscode = require("vscode");

/**
 * 選択範囲または単語を取得して Weblio 類語辞典を開く
 */
async function searchWeblio() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  let text = "";

  // 1. 選択範囲がある場合
  if (!editor.selection.isEmpty) {
    text = doc.getText(editor.selection).trim();
  }
  // 選択範囲がない場合は単語取得を行わず、後続のチェックでメッセージを表示する

  if (!text) {
    vscode.window.showInformationMessage("検索する単語が選択されていません。");
    return;
  }

  // URLエンコードしてブラウザを開く
  // Weblio類語辞典: https://thesaurus.weblio.jp/content/【単語】
  const encoded = encodeURIComponent(text);
  const url = `https://thesaurus.weblio.jp/content/${encoded}`;

  try {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (e) {
    console.error(`[POSNote] Failed to open Weblio: ${e}`);
  }
}

/**
 * コマンド登録
 * @param {vscode.ExtensionContext} context
 */
function registerWeblioSearch(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.searchWeblio", () => {
      searchWeblio();
    })
  );
}

module.exports = { registerWeblioSearch };
