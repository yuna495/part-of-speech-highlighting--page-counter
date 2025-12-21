// cursor.js
// Kuromoji のトークン解析結果を利用して、日本語の単語単位でカーソル移動を行う

const vscode = require("vscode");
const { getTokenizer } = require("./semantic");

/**
 * カーソルを単語単位で移動させる
 * @param {'left'|'right'} direction
 */
async function moveCursorByWord(direction) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const tokenizer = getTokenizer(); // semantic.js で初期化済みのものを取得

  // まだ辞書ロード中などで tokenizer がない場合は何もしない（あるいは標準挙動に任せる？）
  // ここでは単純に return
  if (!tokenizer) {
    // フォールバック: 標準の cursorWordLeft / cursorWordRight を呼ぶ手もあるが
    // ユーザーが明示的にこのコマンドを叩いているので、何もしないか、メッセージ出す
    return;
  }

  const selection = editor.selection;
  const cursor = selection.active; // 現在のカーソル位置
  const lineIndex = cursor.line;
  const lineText = doc.lineAt(lineIndex).text;

  // 1. 行全体をトークナイズ
  // tokenize(text) は同期処理
  const tokens = tokenizer.tokenize(lineText);

  // 2. トークンの境界位置リストを作成

  // A) すべての境界候補と、助詞の開始位置を収集
  const boundaries = new Set();
  const particleStarts = new Set();

  boundaries.add(0);
  boundaries.add(lineText.length);

  for (const t of tokens) {
    if (t.word_position) {
      const start = t.word_position - 1;
      const end = start + t.surface_form.length;

      boundaries.add(start);
      boundaries.add(end);

      if (t.pos === "助詞") {
        particleStarts.add(start);
      }
    }
  }

  // B) 助詞の開始位置と重なる境界を除外する
  // これにより、「名詞」の終わり（＝助詞の始まり）で止まらなくなる
  particleStarts.forEach((p) => {
    boundaries.delete(p);
  });

  // 配列にしてソート
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);

  let newChar = cursor.character;
  let newLine = lineIndex;

  if (direction === "left") {
    // 現在位置より小さい最大の境界を探す
    let found = -1;
    for (let i = sortedBoundaries.length - 1; i >= 0; i--) {
      if (sortedBoundaries[i] < newChar) {
        found = sortedBoundaries[i];
        break;
      }
    }

    if (found !== -1) {
      newChar = found;
    } else {
      // 行頭にいる場合 -> 前の行の末尾へ
      if (lineIndex > 0) {
        newLine = lineIndex - 1;
        newChar = doc.lineAt(newLine).text.length;
      } else {
        // 文頭なので移動なし
        newChar = 0;
      }
    }
  } else {
    // direction === 'right'
    // 現在位置より大きい最小の境界を探す
    let found = -1;
    for (let i = 0; i < sortedBoundaries.length; i++) {
      if (sortedBoundaries[i] > newChar) {
        found = sortedBoundaries[i];
        break;
      }
    }

    if (found !== -1) {
      newChar = found;
    } else {
      // 行末にいる場合 -> 次の行の頭へ
      if (lineIndex < doc.lineCount - 1) {
        newLine = lineIndex + 1;
        newChar = 0;
      } else {
        // 文末
        newChar = lineText.length;
      }
    }
  }

  const newPos = new vscode.Position(newLine, newChar);
  editor.selection = new vscode.Selection(newPos, newPos);
  editor.revealRange(new vscode.Range(newPos, newPos));
}

/**
 * コマンド登録
 * @param {vscode.ExtensionContext} context
 */
function registerCursorCommands(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.cursorWordLeft", () =>
      moveCursorByWord("left")
    ),
    vscode.commands.registerCommand("posNote.cursorWordRight", () =>
      moveCursorByWord("right")
    )
  );
}

module.exports = { registerCursorCommands };
