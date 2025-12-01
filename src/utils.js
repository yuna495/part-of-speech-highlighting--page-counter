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

/** ``` フェンスの"閉じたペア"に挟まれた行（フェンス行自体も）を除去 */
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

/** ステータス/見出し表示で共通の"字数"カウント */
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

// notesetting.json をディレクトリ単位でキャッシュして取得
const _noteCache = new Map(); // dir -> { key, data, mtimeMs }

/**
 * アクティブ文書と同一フォルダの notesetting.json を読み込む（キャッシュ付き）
 * @param {import("vscode").TextDocument | { uri: { fsPath?: string }}} doc
 * @returns {Promise<{ data: any|null, path: string|null, mtimeMs: number|null }>}
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
 * 見出し構造キャッシュを取得（なければ計算）
 * @param {import('vscode').TextDocument} doc
 */
function getHeadingsCached(doc) {
  const ver = doc.version;
  let entry = _headingCache.get(doc);

  if (!entry || entry.version !== ver) {
    // 再計算
    const headings = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) {
        headings.push({ line: i, level: lvl, text });
      }
    }
    entry = { version: ver, headings, metrics: null };
    _headingCache.set(doc, entry);
  }
  return entry.headings;
}

/**
 * 見出しメトリクスキャッシュを取得（なければ計算）
 * @param {import('vscode').TextDocument} doc
 * @param {any} c 設定オブジェクト
 * @param {typeof import('vscode')} vscodeModule
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

  // 1. 基本情報と own/sub 計算用の範囲決定
  // headings は { line, level, text }
  const ranges = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    let end = max;
    // sub範囲: 次の同レベル以上の見出しまで
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].line;
        break;
      }
    }
    ranges.push({ start: h.line, end });
  }

  // 2. sub (自分+配下) の文字数を計算
  const subCounts = new Array(headings.length).fill(0);
  for (let i = 0; i < headings.length; i++) {
    const r = ranges[i];
    const range = new vscode.Range(r.start, 0, r.end, 0);
    subCounts[i] = countCharsForDisplay(doc.getText(range), c);
  }

  // 3. 親子関係を特定して own (自分のみ) と childSum (配下合計) を計算
  // childSum は headline_symbols.js 用（配下の count の合計）
  // own は sidebar_headings.js 用（sub - 直下の子の sub）

  const children = new Array(headings.length).fill(0).map(() => []);
  for (let i = 0; i < headings.length; i++) {
    const pi = headings[i];
    const pEnd = ranges[i].end;
    for (let j = i + 1; j < headings.length; j++) {
      const ch = headings[j];
      if (ch.line >= pEnd) break;
      if (ch.level === pi.level + 1) {
        children[i].push(j);
      } else if (ch.level <= pi.level) {
        break;
      }
    }
  }

  // 結果オブジェクト構築
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const sub = subCounts[i];

    // own = sub - Σ(直下の子のsub)
    const sumChildSub = children[i].reduce((acc, idx) => acc + subCounts[idx], 0);
    const own = Math.max(0, sub - sumChildSub);

    // childSum (headline_symbols.js用) = 配下の count の合計
    // ここでの count は "own" に相当する（本文の文字数）
    // 再帰的に計算する必要があるが、own があれば実は簡単
    // しかし headline_symbols.js の childSum は「配下の DocumentSymbol の文字数合計」なので
    // sub - own = 配下の合計、で良いはずだが、念のため定義を確認
    // headline_symbols.js: items[parentIdx].childSum += items[child.idx].count + items[child.idx].childSum;
    // つまり「配下全ての own の合計」である。
    // これは sub - own と等しいはず（sub は自分+配下全てなので）。
    const childSum = sub - own;

    // タイトル整形
    const title = h.text.replace(/^#+\s*/, "").trim() || `Heading L${h.level}`;

    // 範囲（本文）
    // headline_symbols.js では「次の任意レベルの見出し直前」までを本文としているが
    // ここでは ranges[i].end (次の同レベル以上) を使っている。
    // DocumentSymbol の range としては ranges[i] が正しい。
    // 文字数カウント用の range は... headline_symbols.js を見ると
    // 「次に現れる任意レベルの見出し直前」までを bodyText としている。
    // これは own の計算ロジックと一致する。

    // headline_symbols.js 互換の range 生成
    let bodyEnd = max - 1;
    if (i < headings.length - 1) {
      bodyEnd = headings[i+1].line - 1;
    }
    const range = new vscode.Range(h.line, 0, ranges[i].end, 0); // セクション全体

    items.push({
      line: h.line,
      level: h.level,
      text: h.text,
      title,
      own,      // = count (headline_symbols)
      sub,
      childSum,
      range     // セクション全体
    });
  }

  const total = countCharsForDisplay(doc.getText(), c);
  const result = { items, total };

  // キャッシュ更新
  currentEntry.metrics = result;
  return result;
}

/** キャッシュの手動無効化（閉じた時など） */
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
