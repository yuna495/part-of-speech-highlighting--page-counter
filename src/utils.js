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

module.exports = {
  getHeadingLevel,
};
