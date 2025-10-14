// ruby.js
const vscode = require("vscode");

/**
 * 文字列を「傍点」書式へ変換する。
 * 仕様:
 *   - 非空白文字: `|{c}《・》`
 *   - 空白（半/全角・改行など）はそのまま温存
 *   - サロゲート/絵文字なども Array.from により「1字」として扱う
 * @returns {string} 変換後のテキスト
 */
function toBouten(text) {
  const chars = Array.from(text || "");
  return chars
    .map((c) => {
      // 改行はそのまま保つ（行構造を壊さない）
      if (c === "\r" || c === "\n") return c;
      // 空白は傍点を付けない
      if (c === " " || c === "　" || /\s/.test(c)) return c;
      return `|${c}《・》`;
    })
    .join("");
}

/**
 * 複数選択に対応した置換と、置換後のカーソル移動。
 * @param {vscode.TextEditor} editor
 * @param {(text:string)=>{ replaced:string, caretOffset:number|null }} perSelection
  *  - perSelection は各選択テキストに対する置換結果と、
  *    選択開始位置からの「キャレットを置く相対オフセット」（nullなら末尾）を返す。
 * 選択範囲ごとに置換とカーソル移動をまとめて実行するユーティリティ
 */
async function replaceSelectionsWithCarets(editor, perSelection) {
  const doc = editor.document;
  const sels = editor.selections;
  if (!sels || sels.length === 0) return;

  // 置換内容を事前に計算
  const jobs = sels.map((sel) => {
    const text = doc.getText(sel);
    const { replaced, caretOffset } = perSelection(text);
    return { sel, text, replaced, caretOffset };
  });

  await editor.edit((edit) => {
    for (const j of jobs) {
      edit.replace(j.sel, j.replaced);
    }
  });

  // 置換後のキャレット位置を計算して反映
  const newSelections = [];
  for (const j of jobs) {
    // 置換開始のオフセット
    const startOffset = doc.offsetAt(j.sel.start);
    // 実際に置換されたテキスト長
    const replacedLen = j.replaced.length;

    let targetOffset;
    if (typeof j.caretOffset === "number" && j.caretOffset >= 0) {
      // 選択開始 + 相対オフセット
      targetOffset = startOffset + Math.min(j.caretOffset, replacedLen);
    } else {
      // 末尾（選択開始 + 置換長）
      targetOffset = startOffset + replacedLen;
    }
    const pos = doc.positionAt(targetOffset);
    newSelections.push(new vscode.Selection(pos, pos));
  }
  editor.selections = newSelections;
}

/**
 * ルビ挿入:
 *   選択:       "これ" -> "|これ《》"（《》の中へキャレット）
 *   選択なし:   カーソル位置に "|《》" を挿入（《》の中へキャレット）
 */
async function insertRuby(editor) {
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    // 選択がない場合は |《》 の雛形を挿入し、括弧内へフォーカス
    await editor.edit((edit) => {
      for (const s of editor.selections) {
        edit.insert(s.active, "|《》");
      }
    });
    const doc = editor.document;
    const sels = editor.selections.map((s) => {
      const base = doc.offsetAt(s.active);
      // "|《》" のうち、"|"=1, "《"=1 → 内部位置は +2
      const pos = doc.positionAt(base + 2);
      return new vscode.Selection(pos, pos);
    });
    editor.selections = sels;
    return;
  }

  await replaceSelectionsWithCarets(editor, (text) => {
    const base = `|${text}《》`;
    // caretOffset: 先頭から 1（|） + text.length（基文字列） + 1（《） = 中括弧内の開始
    const caretOffset = 1 + Array.from(text).length + 1;
    return { replaced: base, caretOffset };
  });
}

/**
 * 傍点挿入:
 *   選択:       "これ" -> "|こ《・》|れ《・》"
 *   選択なし:   カーソル位置に "|《・》" を挿入（末尾にキャレット）
 */
async function insertBouten(editor) {
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    await editor.edit((edit) => {
      for (const s of editor.selections) {
        edit.insert(s.active, "|《・》");
      }
    });
    // 末尾へキャレット（入力継続しやすいように）
    const doc = editor.document;
    const sels = editor.selections.map((s) => {
      const base = doc.offsetAt(s.active);
      const pos = doc.positionAt(base + "|《・》".length);
      return new vscode.Selection(pos, pos);
    });
    editor.selections = sels;
    return;
  }

  await replaceSelectionsWithCarets(editor, (text) => {
    const replaced = toBouten(text);
    // caret は置換末尾
    return { replaced, caretOffset: null };
  });
}

// ルビ／傍点関連のコマンドを VS Code に登録する
function registerRubySupport(context) {
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.insertRuby",
      (editor) => insertRuby(editor)
    ),
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.insertBouten",
      (editor) => insertBouten(editor)
    )
  );
}

module.exports = { registerRubySupport };
