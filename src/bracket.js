// 括弧補完（VS Code ネイティブ委譲）＋ Backspace同時削除（軽量版）

const vscode = require("vscode");

// 全角の開き括弧 → 対応する閉じ括弧
const FW_BRACKET_MAP = new Map([
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["［", "］"],
  ["｛", "｝"],
  ["〈", "〉"],
  ["《", "》"],
  ["【", "】"],
  ["〔", "〕"],
  ["“", "”"],
  ["‘", "’"],
  ["[", "]"],
  ["{", "}"],
  ["(", ")"],
  ["<", ">"],
  ["'", "'"],
]);
const FW_CLOSE_SET = new Set(Array.from(FW_BRACKET_MAP.values()));

// カーソル直前・直後の1文字だけを保持（全文キャッシュは持たない）
const _caretCacheByUri = new Map(); // uri -> { pos, leftChar, rightChar }
let _deletingPair = false; // 再入防止

// --- Language Configuration（最軽量の本丸）---
// VS Code の言語設定に全角括弧の組み合わせを登録し、標準の自動補完へ委譲する
function registerAutoClosingPairs(context) {
  const pairs = Array.from(FW_BRACKET_MAP.entries()).map(([open, close]) => ({
    open,
    close,
  }));
  const bracketsArray = Array.from(FW_BRACKET_MAP.entries());
  const config = {
    autoClosingPairs: pairs,
    surroundingPairs: pairs,
    brackets: bracketsArray,
  };
  for (const lang of ["plaintext", "markdown", "novel", "Novel"]) {
    const disp = vscode.languages.setLanguageConfiguration(lang, config);
    context.subscriptions.push(disp);
  }
}

// --- Caret Cache Helper ---
// キャレット周辺の文字を記録して Backspace 処理時に参照できるようにする
function updateCaretCache(editor) {
  try {
    if (!editor) return;
    const doc = editor.document;
    if (!doc) return;
    const uriKey = doc.uri.toString();

    const sel = editor.selection;
    if (!sel || !sel.isEmpty) {
      _caretCacheByUri.delete(uriKey);
      return;
    }

    const pos = sel.active;
    // 左1文字
    let leftChar = "";
    if (pos.character > 0) {
      const leftRange = new vscode.Range(pos.translate(0, -1), pos);
      leftChar = doc.getText(leftRange);
    }

    // 右1文字
    const rightRange = new vscode.Range(pos, pos.translate(0, 1));
    const rightChar = doc.getText(rightRange);

    _caretCacheByUri.set(uriKey, { pos, leftChar, rightChar });
  } catch {
    // noop（安全側）
  }
}

// --- Backspace Pair-Delete（軽量版：全文キャッシュ不要）---
// Backspace で開き括弧を消したときに対応する閉じ括弧もまとめて削除する
function maybeDeleteClosingOnBackspaceLite(e, opts = {}) {
  const { cfg, isTargetDoc } = opts; // ← ここで安全に展開
  try {
    if (_deletingPair) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || e.document !== ed.document) return;

    // 拡張の設定で無効なら何もしない
    const c =
      typeof cfg === "function" ? cfg() : { bracketsBackspacePairDelete: true };
    if (!c.bracketsBackspacePairDelete) return;

    if (typeof isTargetDoc === "function" && !isTargetDoc(ed.document, c))
      return;

    if (!e.contentChanges || e.contentChanges.length !== 1) return;
    const chg = e.contentChanges[0];

    // Backspace（左削除）: 1文字削除 & 挿入なし
    if (!(chg.rangeLength === 1 && chg.text === "")) return;

    const uriKey = e.document.uri.toString();
    const cache = _caretCacheByUri.get(uriKey);
    if (!cache) return;

    // 削除された「左隣の1文字」
    const removed = cache.leftChar || "";
    const expectedClose = FW_BRACKET_MAP.get(removed); // removed が開き括弧なら対応閉じが返る
    if (!expectedClose) return;

    // 削除後のキャレット位置は chg.range.start
    const pos = chg.range.start;
    const nextRange = new vscode.Range(pos, pos.translate(0, 1));
    const nextChar = e.document.getText(nextRange);
    if (nextChar !== expectedClose) return;

    // 右隣が期待する閉じ括弧なら、同時削除を実行
    _deletingPair = true;
    const p = ed.edit((builder) => builder.delete(nextRange));
    // Thenable<boolean> なので finally は不可。then の成功/失敗ハンドラでフラグ解除
    p.then(
      () => {
        _deletingPair = false;
      },
      () => {
        _deletingPair = false;
      }
    );
  } catch {
    _deletingPair = false;
  }
}

/**
 * 括弧機能の初期化（イベント配線まで含む）
 * @param {vscode.ExtensionContext} context
 * @param {{ cfg?: Function, isTargetDoc?: Function }} [options]
 */
function registerBracketSupport(context, { cfg, isTargetDoc } = {}) {
  // VS Code への構成登録とイベントフックをまとめてセットアップする窓口
  // 1) VS Code の言語設定で補完を委譲（最軽量）
  registerAutoClosingPairs(context);

  // 2) Backspace 同時削除（軽量版）とカーソルキャッシュのイベント
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      maybeDeleteClosingOnBackspaceLite(e, { cfg, isTargetDoc }); // ← そのままでOK
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      const c = typeof cfg === "function" ? cfg() : {};
      if (typeof isTargetDoc === "function" && !isTargetDoc(ed.document, c))
        return;
      updateCaretCache(ed);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      const c = typeof cfg === "function" ? cfg() : {};
      if (
        typeof isTargetDoc === "function" &&
        !isTargetDoc(e.textEditor.document, c)
      )
        return;
      updateCaretCache(e.textEditor);
    })
  );
}

module.exports = {
  registerBracketSupport,
};
