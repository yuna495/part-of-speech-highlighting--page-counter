// ruby.js
const vscode = require("vscode");

/* =========================
   ヘルパー群
   ========================= */

/**
 * 入力ボックスでルビ文字列を取得
 * キャンセルや空は null
 */
async function askRubyText() {
  const ruby = await vscode.window.showInputBox({
    prompt: "《》の中に入れるルビを入力",
    placeHolder: "かな／カナ／注音など",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.includes("《") || v.includes("》"))
        return "《》は入力しないでください";
      return null;
    },
  });
  if (!ruby) return null;
  return ruby;
}

/**
 * 文書全文から needle の一致開始位置をすべて返す
 * 一致直前が '|' の箇所は除外（二重挿入防止）
 */
function findAllInsertableMatches(haystack, needle) {
  if (!needle) return [];
  const res = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    if (idx > 0 && haystack[idx - 1] === "|") {
      from = idx + needle.length;
      continue;
    }
    res.push(idx);
    from = idx + needle.length;
  }
  return res;
}

/**
 * 文字列を傍点書式へ変換
 * 非空白は `|{c}《・》` 空白や改行は温存
 */
function toBouten(text) {
  const chars = Array.from(text || "");
  return chars
    .map((c) => {
      if (c === "\r" || c === "\n") return c;
      if (c === " " || c === "　" || /\s/.test(c)) return c;
      return `|${c}《・》`;
    })
    .join("");
}

/**
 * 複数選択をまとめて置換し キャレットも移動
 * perSelection は {replaced, caretOffset} を返す
 * caretOffset は選択開始からの相対位置 null なら末尾
 */
async function replaceSelectionsWithCarets(editor, perSelection) {
  const doc = editor.document;
  const sels = editor.selections;
  if (!sels || sels.length === 0) return;

  const jobs = sels.map((sel) => {
    const text = doc.getText(sel);
    const { replaced, caretOffset } = perSelection(text);
    return { sel, text, replaced, caretOffset };
  });

  await editor.edit((edit) => {
    for (const j of jobs) edit.replace(j.sel, j.replaced);
  });

  const newSelections = [];
  for (const j of jobs) {
    const startOffset = doc.offsetAt(j.sel.start);
    const replacedLen = j.replaced.length;
    let targetOffset;
    if (typeof j.caretOffset === "number" && j.caretOffset >= 0) {
      targetOffset = startOffset + Math.min(j.caretOffset, replacedLen);
    } else {
      targetOffset = startOffset + replacedLen;
    }
    const pos = doc.positionAt(targetOffset);
    newSelections.push(new vscode.Selection(pos, pos));
  }
  editor.selections = newSelections;
}

// 共通補正関数
function caretAdjustLeft(doc, abs, ruby) {
  const correction = (ruby ?? "").length + 3; // ユーザー観測に基づく補正
  const fixed = Math.max(0, abs - correction);
  return doc.positionAt(fixed);
}

/* =========================
   コマンド群
   ========================= */
/**
 * ルビ挿入
 * 選択あり: 文書全体の同一文字列を `|{text}《{ruby}》` へ一括置換
 *           直前が '|' の一致はスキップ caret は 》 直後（内部で補正）
 * 選択なし: 何もせず警告を表示（※ ルビ入力は出さない）
 */
async function insertRuby(editor) {
  // 先に選択有無を判定
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    vscode.window.showWarningMessage("文字列が選択されていません。");
    return;
  }

  const doc = editor.document;
  const full = doc.getText();

  // 選択テキストのユニーク化（空は除外）
  const uniqTexts = Array.from(
    new Set(
      editor.selections
        .map((sel) => doc.getText(sel))
        .filter((t) => t && t.length > 0)
    )
  );

  // 範囲はあるが実体が空ならここで終了し ダイアログも出さない
  if (uniqTexts.length === 0) {
    vscode.window.showWarningMessage("文字列が選択されていません。");
    return;
  }

  // ここで初めてルビ入力を要求
  const ruby = await askRubyText();
  if (ruby === null) return;

  // 文書内一致（直前が '|' の一致は除外）
  const matches = [];
  for (const t of uniqTexts) {
    const idxs = findAllInsertableMatches(full, t);
    for (const start of idxs) {
      matches.push({ start, end: start + t.length, text: t });
    }
  }

  // 文書内一致が無い → 選択範囲だけ置換（キャレットは補正込み）
  if (matches.length === 0) {
    await replaceSelectionsWithCarets(editor, (text) => {
      const replaced = `|${text}《${ruby}》`;
      const caretOffset = Math.max(0, replaced.length - (ruby.length + 3));
      return { replaced, caretOffset };
    });
    return;
  }

  // 末尾から一括置換（オフセット崩壊防止）
  matches.sort((a, b) => a.start - b.start);
  await editor.edit((edit) => {
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const range = new vscode.Range(
        doc.positionAt(m.start),
        doc.positionAt(m.end)
      );
      edit.replace(range, `|${m.text}《${ruby}》`);
    }
  });

  // 一括置換が実行された件数をステータスバーへ表示（4秒）
  vscode.window.setStatusBarMessage(`ルビ適用: ${matches.length} 件`, 4000);

  // 置換で増える長さ（UTF-16）= 3（"|" "《" "》"）+ ruby.length
  const addLen = 3 + ruby.length;

  // 置換前の選択開始オフセット → 一致インデックスへ対応づけ
  const startToIndex = new Map();
  for (let i = 0; i < matches.length; i++)
    startToIndex.set(matches[i].start, i);

  // キャレット位置を「》直後」からルビ長+3 左へ補正して確定
  editor.selections = editor.selections.map((sel) => {
    const selStart = doc.offsetAt(sel.start);
    const selText = doc.getText(sel);
    const mIdx = startToIndex.get(selStart);

    if (typeof mIdx === "number") {
      const priorCount = mIdx;
      const replacedLen = 1 + selText.length + 1 + ruby.length + 1;
      const rawAbs = selStart + priorCount * addLen + replacedLen;
      const pos = caretAdjustLeft(doc, rawAbs, ruby);
      return new vscode.Selection(pos, pos);
    }

    // 近傍一致フォールバック
    let nearIdx = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < matches.length; i++) {
      const d = Math.abs(matches[i].start - selStart);
      if (d < bestDist) {
        bestDist = d;
        nearIdx = i;
      }
    }
    if (nearIdx >= 0) {
      const m = matches[nearIdx];
      const priorCount = nearIdx;
      const replacedLen = 1 + m.text.length + 1 + ruby.length + 1;
      const rawAbs = m.start + priorCount * addLen + replacedLen;
      const pos = caretAdjustLeft(doc, rawAbs, ruby);
      return new vscode.Selection(pos, pos);
    }

    // 最終フォールバック
    const rawAbs = selStart + `|${selText}《${ruby}》`.length;
    const pos = caretAdjustLeft(doc, rawAbs, ruby);
    return new vscode.Selection(pos, pos);
  });
}

// 選択範囲のみにルビを付ける
async function insertRubySelection(editor) {
  // 選択が無ければ注意のみ
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    vscode.window.showWarningMessage("文字列が選択されていません。");
    return;
  }

  // ルビ入力
  const ruby = await askRubyText();
  if (ruby === null) return;

  // 各選択を |text《ruby》 に置換
  // caretOffset は選択開始から text 長へ置く → 「《」直前で止まる挙動（既存のフォールバックと整合）
  await replaceSelectionsWithCarets(editor, (text) => {
    const replaced = `|${text}《${ruby}》`;
    const caretOffset = Math.max(0, replaced.length - (ruby.length + 3)); // = text.length
    return { replaced, caretOffset };
  });
}

/**
 * 傍点挿入
 * 選択あり: 各文字へ `|c《・》` を付与
 * 選択なし: 何もせず警告を表示
 */
async function insertBouten(editor) {
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    vscode.window.showWarningMessage("文字列が選択されていません。");
    return;
  }

  await replaceSelectionsWithCarets(editor, (text) => {
    const replaced = toBouten(text);
    return { replaced, caretOffset: null }; // 末尾
  });
}

/**
 * スマート引用符で括る
 * 選択あり: 各選択を “{text}” に置換
 * 選択なし: 警告のみ
 */
async function wrapWithSmartQuotes(editor) {
  const noSelection = editor.selections.every((s) => s.isEmpty);
  if (noSelection) {
    vscode.window.showWarningMessage("文字列が選択されていません。");
    return;
  }

  await replaceSelectionsWithCarets(editor, (text) => {
    const replaced = `“${text}”`;
    // キャレットは末尾に置く（編集直後の連続入力がしやすい）
    return { replaced, caretOffset: null };
  });
}

/* =========================
   登録とエクスポート
   ========================= */

function registerRubySupport(context) {
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.insertRuby",
      (editor) => insertRuby(editor)
    ),
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.insertBouten",
      (editor) => insertBouten(editor)
    ),
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.insertRubySelection",
      (editor) => insertRubySelection(editor)
    ),
    vscode.commands.registerTextEditorCommand(
      "posNote.ruby.wrapSmartQuotes",
      (editor) => wrapWithSmartQuotes(editor)
    )
  );
}

module.exports = { registerRubySupport };
