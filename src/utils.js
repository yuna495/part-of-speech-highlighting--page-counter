// 共通ユーティリティ関数

/**
 * Markdown風見出し検出（0〜3スペース許容）
 * @param {string} lineText - 行のテキスト
 * @returns {number} 見出しレベル（1〜6）／見出しでなければ 0
 */
function getHeadingLevel(lineText) {
  const m = lineText.match(/^ {0,3}(#{1,6})\s+\S/);
  return m ? m[1].length : 0;
}

/** ``` フェンスの“閉じたペア”に挟まれた行（フェンス行自体も）を除去 */
// 文字数カウントやプレビューの対象からコードブロックを外すための前処理
function stripClosedCodeFences(text) {
  const src = String(text || "").split(/\r?\n/);
  const fenceRe = /^\s*```/;
  const fenceLines = [];
  for (let i = 0; i < src.length; i++) {
    if (fenceRe.test(src[i])) fenceLines.push(i);
  }
  if (fenceLines.length < 2) return src.join("\n");
  if (fenceLines.length % 2 === 1) fenceLines.pop();

  const mask = new Array(src.length).fill(false);
  for (let k = 0; k < fenceLines.length; k += 2) {
    const s = fenceLines[k],
      e = fenceLines[k + 1];
    for (let i = s; i <= e; i++) mask[i] = true;
  }
  const out = [];
  for (let i = 0; i < src.length; i++) if (!mask[i]) out.push(src[i]);
  return out.join("\n");
}

/** 見出し行（#…）を丸ごと除外 */
// 字数カウントに本文のみを反映させる
function stripHeadingLines(text) {
  const src = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const ln of src) if (getHeadingLevel(ln) === 0) kept.push(ln);
  return kept.join("\n");
}

/** ステータス/見出し表示で共通の“字数”カウント */
// スペースの扱いなど設定に合わせて文字数を求める
function countCharsForDisplay(text, c) {
  let t = (text || "").replace(/\r\n/g, "\n");
  t = stripClosedCodeFences(t); // フェンス除外
  t = stripHeadingLines(t); // 見出し行除外
  t = t.replace(/《.*?》/g, ""); // 《…》除去

  const arr = Array.from(t);
  if (c?.countSpaces) {
    // スペースは数えるが # | ｜ は除外
    return arr.filter(
      (ch) => ch !== "\n" && ch !== "#" && ch !== "|" && ch !== "｜"
    ).length;
  } else {
    // 半角/全角スペースは除外、# | ｜ も除外
    return arr.filter(
      (ch) =>
        ch !== "\n" &&
        ch !== " " &&
        ch !== "　" &&
        ch !== "#" &&
        ch !== "|" &&
        ch !== "｜"
    ).length;
  }
}

module.exports = {
  getHeadingLevel,
  stripClosedCodeFences,
  stripHeadingLines,
  countCharsForDisplay,
};
