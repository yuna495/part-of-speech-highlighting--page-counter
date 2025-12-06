const HEADING_RE = /^ {0,3}(#{1,6})\s+\S/;

/**
 * Markdown 風見出し検出（行頭 0〜3 スペースを許容）。
 * @param {string} lineText 行のテキスト
 * @returns {number} 見出しレベル（1〜6）／該当しなければ 0
 */
function getHeadingLevel(lineText) {
  const m = lineText.match(HEADING_RE);
  return m ? m[1].length : 0;
}

/**
 * ``` フェンスの閉じたペアに挟まれた行（フェンス行自体も）を除去する。
 * 文字数カウントやプレビューからコードブロックを除外する前処理。
 * @param {string} text 対象テキスト
 * @returns {string} フェンスを除いたテキスト
 */
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

/**
 * 見出し行（# …）を丸ごと除外する。
 * 字数カウントを本文に限定するための前処理。
 * @param {string} text 対象テキスト
 * @returns {string} 見出し行を除いたテキスト
 */
function stripHeadingLines(text) {
  const src = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const ln of src) if (getHeadingLevel(ln) === 0) kept.push(ln);
  return kept.join("\n");
}

/**
 * ステータス/見出し表示で共通の「字数」を求める。
 * スペースや記号の扱いを設定に合わせて調整する。
 * @param {string} text 対象テキスト
 * @param {object} c 設定オブジェクト（countSpaces など）
 * @returns {number} 文字数
 */
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

// notesetting.json をディレクトリ単位でキャッシュして取得
const _noteCache = new Map(); // dir -> { key, data, mtimeMs }

/**
 * アクティブ文書と同一フォルダの notesetting.json を読み込む（ディレクトリ単位キャッシュ付き）。
 * @param {import("vscode").TextDocument | { uri: { fsPath?: string }}} doc 対象ドキュメント
 * @returns {Promise<{ data: any|null, path: string|null, mtimeMs: number|null }>} 読み込んだ JSON とパス
 */
async function loadNoteSettingForDoc(doc) {
  try {
    const fsPath = doc?.uri?.fsPath;
    if (!fsPath) return { data: null, path: null, mtimeMs: null };
    const dir = require("path").dirname(fsPath);
    const notePath = require("path").join(dir, "notesetting.json");
    const fs = require("fs");
    let st;
    try {
      st = await fs.promises.stat(notePath);
    } catch {
      _noteCache.delete(dir);
      return { data: null, path: null, mtimeMs: null };
    }
    const key = `${dir}:${st.mtimeMs}`;
    const cached = _noteCache.get(dir);
    if (cached && cached.key === key) {
      return { data: cached.data, path: notePath, mtimeMs: cached.mtimeMs };
    }
    const txt = await fs.promises.readFile(notePath, "utf8");
    const json = JSON.parse(txt);
    _noteCache.set(dir, { key, data: json, mtimeMs: st.mtimeMs });
    return { data: json, path: notePath, mtimeMs: st.mtimeMs };
  } catch {
    return { data: null, path: null, mtimeMs: null };
  }
}

// ==== 統合キャッシュシステム ====
const _headingCache = new WeakMap();
// WeakMap<TextDocument, {
//   version: number,
//   headings: { line:number, level:number, text:string }[],
//   metrics: { items:..., total:number } | null
// }>

/**
 * 見出し構造キャッシュを取得（無ければ計算して保持）。
 * @param {import('vscode').TextDocument} doc 対象ドキュメント
 * @returns {{ line:number, level:number, text:string }[]} 見出し配列
 */
function getHeadingsCached(doc) {
  const ver = doc.version;
  let entry = _headingCache.get(doc);

  if (!entry || entry.version !== ver) {
    // 再計算
    const headings = [];
    // Optimized: Use Regex on full text instead of iterating all lines
    const text = doc.getText();
    // Match line start, 1-6 #s, space, then rest of line
    const regex = /^(#{1,6})\s+(.*)$/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const line = doc.positionAt(match.index).line;
      const level = match[1].length;
      // match[0] is the full matched string (the whole line effectively due to $)
      headings.push({ line, level, text: match[0] });
    }
    entry = { version: ver, headings, metrics: null };
    _headingCache.set(doc, entry);
  }
  return entry.headings;
}

/**
 * 見出しメトリクスキャッシュを取得（無ければ計算）。
 * @param {import('vscode').TextDocument} doc 対象ドキュメント
 * @param {any} c 設定オブジェクト
 * @param {typeof import('vscode')} vscodeModule vscode モジュール参照
 * @returns {{ items: Array<{line:number,level:number,text:string,title:string,own:number,sub:number,childSum:number,range:any}>, total:number }}
 */
function getHeadingMetricsCached(doc, c, vscodeModule) {
  const entry = _headingCache.get(doc);
  // 構造キャッシュが最新かつメトリクスがあればそれを返す
  if (entry && entry.version === doc.version && entry.metrics) {
    return entry.metrics;
  }

  // 構造が無ければ先に作る（getHeadingsCached経由）
  const headings = getHeadingsCached(doc); // これで entry が作られる/更新される
  const currentEntry = _headingCache.get(doc); // 最新を取得

  // メトリクス計算（既存ロジックの流用・統合）
  // ここでは sidebar_headings.js と headline_symbols.js の両方の要求を満たすデータを作る
  // items: { line, level, text, own, sub, childSum, range }

  const vscode = vscodeModule;
  const items = [];
  const max = doc.lineCount;

  // New Logic:
  // 1. Calculate 'own' for each segment (Self to Next Heading of ANY level)
  // 2. Accumulate 'sub' from bottom to top (Reverse iteration)

  // A) Calculate Own Counts per Segment
  // items[i] needs initialized with basic info + own count
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];

    // Segment End is simply the next heading's line (or doc end)
    const nextLine = (i + 1 < headings.length) ? headings[i + 1].line : max;

    // range for 'own' text
    const range = new vscode.Range(h.line, 0, nextLine, 0);
    const text = doc.getText(range);
    const own = countCharsForDisplay(text, c);

    const title = h.text.replace(/^#+\s*/, "").trim() || `Heading L${h.level}`;

    // Initialize item
    // Note: range property in OLD logic was "Self+Descendants".
    // We can preserve that approximation or just give the segment range.
    // Given 'range' is barely used, we'll assign the segment range (or calculate full range if strictly needed).
    // Let's keep it simple: Segment range is safer for potential future "Select Section" features if they used this (but they don't, they find it themselves).
    // However, to be perfectly compatible with existing "sub" concept, let's try to mimic the "next sibling" logic for range ONLY if cheap.
    // Finding next sibling is relatively cheap structure scan. Let's do it to keep 'range' property robust.

    let siblingLine = max;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        siblingLine = headings[j].line;
        break;
      }
    }
    const fullRange = new vscode.Range(h.line, 0, siblingLine, 0);

    items.push({
      line: h.line,
      level: h.level,
      text: h.text,
      title,
      own,
      sub: own, // Initialize sub with own (will accumulate children later)
      childSum: 0,
      range: fullRange
    });
  }

  // B) Accumulate Sub Counts (Bottom-Up)
  // Iterate backwards. Add my sub count to my direct parent.
  for (let i = headings.length - 1; i >= 0; i--) {
    const current = items[i];
    // Find direct parent (closest previous heading with level < current.level)
    for (let j = i - 1; j >= 0; j--) {
      if (headings[j].level < headings[i].level) {
        items[j].sub += current.sub;
        break; // Found the direct parent, stop
      }
    }
    // Update childSum (sub - own)
    current.childSum = current.sub - current.own;
  }

  const total = countCharsForDisplay(doc.getText(), c);
  const result = { items, total };

  // キャッシュ更新
  currentEntry.metrics = result;
  return result;
}

/** 見出しキャッシュを手動で無効化する（ドキュメントクローズ時など）。 */
function invalidateHeadingCache(doc) {
  _headingCache.delete(doc);
}

module.exports = {
  getHeadingLevel,
  stripClosedCodeFences,
  stripHeadingLines,
  countCharsForDisplay,
  loadNoteSettingForDoc,
  // 新API
  getHeadingsCached,
  getHeadingMetricsCached,
  invalidateHeadingCache
};
