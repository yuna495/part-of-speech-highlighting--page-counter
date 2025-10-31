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

/* ===========================
 * 追加：見出しメトリクス（表示ルール準拠）
 *   - sub: 自身の階層にぶら下がる全文（子を含む）を countCharsForDisplay で計測
 *   - own: sub から直下の子の sub を差し引いた値
 *   - total: 文書全体を countCharsForDisplay
 * =========================== */

/** VS Code 互換の Range を最小限で表現（doc.getText(range) 用） */
function _mkRange(vscode, sLine, sCh, eLine, eCh) {
  return new vscode.Range(
    new vscode.Position(sLine, sCh),
    new vscode.Position(eLine, eCh)
  );
}

/** ドキュメント内の見出し（line/level）一覧を収集 */
function collectHeadings(document) {
  const heads = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const lvl = getHeadingLevel(text);
    if (lvl > 0) heads.push({ index: heads.length, line: i, level: lvl });
  }
  return heads;
}

/** 各見出しの範囲（startLine ～ endLineExclusive）を決定 */
function computeHeadingRanges(document, heads) {
  const n = heads.length;
  for (let i = 0; i < n; i++) {
    const me = heads[i];
    let end = document.lineCount; // exclusive
    for (let j = i + 1; j < n; j++) {
      if (heads[j].level <= me.level) {
        end = heads[j].line;
        break;
      }
    }
    me.start = me.line;
    me.end = end;
  }
  return heads;
}

/** head i の直下の子（最短の上位一致）インデックスを列挙 */
function computeChildrenIndices(heads) {
  const children = new Array(heads.length).fill(0).map(() => []);
  for (let i = 0; i < heads.length; i++) {
    const pi = heads[i];
    for (let j = i + 1; j < heads.length; j++) {
      const ch = heads[j];
      if (ch.line >= pi.end) break;
      if (ch.level === pi.level + 1) {
        children[i].push(j);
      } else if (ch.level <= pi.level) {
        break;
      }
    }
  }
  return children;
}

/**
 * 見出し字数メトリクス（コードブロック除外／表示ルール準拠）
 * @param {import('vscode').TextDocument} document - VSCode の TextDocument
 * @param {any} c 拡張の設定オブジェクト
 * @param {typeof import('vscode')} vscodeModule - Range/Position生成のための vscode モジュール
 * @returns {{ items: { line:number, own:number, sub:number }[], total:number }}
 */
function getHeadingCharMetricsForDisplay(document, c, vscodeModule) {
  const vscode = vscodeModule; // 明示
  const heads = computeHeadingRanges(document, collectHeadings(document));
  if (heads.length === 0) {
    return { items: [], total: countCharsForDisplay(document.getText(), c) };
  }
  const children = computeChildrenIndices(heads);

  // sub を先に全見出し分計測（doc.getText→countCharsForDisplay）
  const subArr = new Array(heads.length).fill(0);
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const range = _mkRange(vscode, h.start, 0, h.end, 0);
    const sub = countCharsForDisplay(document.getText(range), c);
    subArr[i] = sub;
  }

  // own = sub - Σ(直下子の sub)
  const items = heads.map((h, i) => {
    const sumChildSub = children[i].reduce((acc, j) => acc + subArr[j], 0);
    const own = Math.max(0, subArr[i] - sumChildSub);
    return { line: h.line, own, sub: subArr[i] };
  });

  const total = countCharsForDisplay(document.getText(), c);
  return { items, total };
}

module.exports = {
  getHeadingLevel,
  stripClosedCodeFences,
  stripHeadingLines,
  countCharsForDisplay,
  collectHeadings,
  getHeadingCharMetricsForDisplay,
};
