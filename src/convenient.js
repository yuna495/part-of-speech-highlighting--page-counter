// 便利系: 保存時の行末スペース削除と選択文字列の出現回数カウント。
const vscode = require("vscode");
const { checkDevPasscode } = require("./utils");

/**
 * 行末の全角・半角スペースを削除する。
 * @param {vscode.TextDocument} doc
 * @returns {Promise<void>}
 */
/**
 * 行末の全角・半角スペースを削除する（保存前イベント用）。
 * @param {vscode.TextDocumentWillSaveEvent} e
 */
function trimTrailingSpaces(e) {
  const doc = e.document;
  if (!doc || doc.isUntitled) return;

  // 変更理由が "Auto Save" の場合などは除外したい場合はここで check (e.reason)
  // ここではユーザー要望に合わせて無条件に近い形で適用するが、
  // 言語チェックは行う。

  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isTarget =
    lang === "plaintext" ||
    lang === "markdown" ||
    lang === "novel" ||
    fsPath.endsWith(".txt") ||
    fsPath.endsWith(".md");

  if (!isTarget) return;

  const text = doc.getText();
  const edits = [];

  // 行ごとにチェックして、末尾スペースがある行だけ Edit を作成
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i);
    const lineText = line.text;
    // 末尾の空白（半角・全角）をマッチ
    const match = lineText.match(/[ \u3000]+$/);
    if (match) {
      // マッチした部分（末尾空白）を削除する Edit
      const startChar = match.index;
      const endChar = lineText.length;
      edits.push(vscode.TextEdit.delete(new vscode.Range(i, startChar, i, endChar)));
    }
  }

  if (edits.length > 0) {
    e.waitUntil(Promise.resolve(edits));
  }
}

/**
 * .txt 保存時に1行目のタイムスタンプを更新する（開発者モードのみ）。
 * `# updated: YYYY-MM-DDTHH:mm+09:00` 形式
 * @param {vscode.TextDocumentWillSaveEvent} e
 */
function updateTimestampOnSave(e) {
  const doc = e.document;
  if (!doc || doc.isUntitled) return;

  // 1. 開発者パスコードチェック
  if (!checkDevPasscode()) return;

  // 2. .txt ファイルのみ対象
  if (!doc.fileName.toLowerCase().endsWith(".txt")) return;

  // 3. タイムスタンプ生成 (日本時間固定)
  const now = new Date();
  // JST offset is -540 minutes (UTC+9)
  // To get ISO string in JST, we can shift the time
  const jstOffset = 9 * 60;
  const localDate = new Date(now.getTime() + jstOffset * 60 * 1000);
  const iso = localDate.toISOString().replace("Z", "+09:00");
  // 秒以下を削る: 2026-01-07T06:53:12.345+09:00 -> 2026-01-07T06:53+09:00
  // T以降の :ss.ms 部分を除去
  // YYYY-MM-DDTHH:mm:ss.sss+09:00
  // 0123456789012345
  const formatted = iso.substring(0, 16) + "+09:00";
  const newLineText = `# updated: ${formatted}\n`;

  const firstLine = doc.lineAt(0);
  const text = firstLine.text;

  // 4. 1行目更新 or 挿入
  const edits = [];
  if (text.startsWith("# updated:")) {
    // 既存更新: 1行目を置換
    edits.push(vscode.TextEdit.replace(firstLine.range, `# updated: ${formatted}`));
  } else {
    // 新規挿入: 0行目の先頭に挿入
    edits.push(vscode.TextEdit.insert(new vscode.Position(0, 0), newLineText));
  }

  e.waitUntil(Promise.resolve(edits));
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
 * 行末に `<br>` をトグルする。
 * - 選択なし: 全行対象
 * - 選択あり: 選択行対象
 * - 全対象行に既にある場合: 一括削除
 * - それ以外: 一括付与（ない行に足す）
 */
async function toggleLineSuffix(editor) {
  const doc = editor.document;
  const lines = new Set();
  const suffix = "<br>";

  // 1. 対象行の収集
  if (editor.selections.length === 0 || (editor.selections.length === 1 && editor.selections[0].isEmpty)) {
    // 選択なし → 全行
    for (let i = 0; i < doc.lineCount; i++) {
      lines.add(i);
    }
  } else {
    // 選択あり → 含まれる全行
    for (const sel of editor.selections) {
      const start = sel.start.line;
      let end = sel.end.line;
      // 選択終了が行頭ちょうどの場合、その行は含めない
      if (sel.end.line > sel.start.line && sel.end.character === 0) {
        end--;
      }
      for (let i = start; i <= end; i++) {
        lines.add(i);
      }
    }
  }

  // 2. モード判定（削除 or 付与）
  let allHaveSuffix = true;
  for (const lineNum of lines) {
    const text = doc.lineAt(lineNum).text;
    if (!text.endsWith(suffix)) {
      allHaveSuffix = false;
      break;
    }
  }

  const isRemoveMode = allHaveSuffix;

  // 3. 編集適用
  await editor.edit(editBuilder => {
    for (const lineNum of lines) {
      const line = doc.lineAt(lineNum);
      const text = line.text;

      if (isRemoveMode) {
        // 削除: 末尾の suffix を消す
        if (text.endsWith(suffix)) {
          const startChar = text.length - suffix.length;
          const range = new vscode.Range(lineNum, startChar, lineNum, text.length);
          editBuilder.delete(range);
        }
      } else {
        // 付与: なければ足す
        if (!text.endsWith(suffix)) {
          editBuilder.insert(line.range.end, suffix);
        }
      }
    }
  });

  // 4. ハイライト状態の更新
  // 追加モードならON、削除モードならOFF
  vscode.commands.executeCommand("posNote.semantic.setBrHighlight", !isRemoveMode);
}

/**
 * 便利機能（行末スペース削除・選択文字列カウント）を登録する。
 * @param {vscode.ExtensionContext} context
 */
function registerConvenientFeatures(context) {
  // 保存時に行末スペースを削除
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      trimTrailingSpaces(e);
    })
  );

  // 保存時にタイムスタンプ更新（開発者限定）
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      updateTimestampOnSave(e);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.convenient.countSelectedString", () =>
      countSelectedString()
    ),
    vscode.commands.registerTextEditorCommand("posNote.convenient.toggleLineSuffix", (editor) =>
      toggleLineSuffix(editor)
    )
  );
}

module.exports = { registerConvenientFeatures };
