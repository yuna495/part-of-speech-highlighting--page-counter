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
  t = stripBlockComments(t);    // ブロックコメント除外 (/* ... */)
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

// notesetting.json をファイルパス単位でキャッシュ
const _fileCache = new Map(); // path -> { key: "path:mtime", data, mtimeMs }

/**
 * JSONファイルを読み込んでキャッシュする内部ヘルパ
 * @param {string} filePath
 * @returns {Promise<{ data: any|null, mtimeMs: number|null }>}
 */
async function _loadUniqueJson(filePath) {
  try {
    const fs = require("fs");
    let st;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      _fileCache.delete(filePath);
      return { data: null, mtimeMs: null };
    }
    const key = `${filePath}:${st.mtimeMs}`;
    const cached = _fileCache.get(filePath);
    if (cached && cached.key === key) {
      return { data: cached.data, mtimeMs: cached.mtimeMs };
    }

    const txt = await fs.promises.readFile(filePath, "utf8");
    const json = JSON.parse(txt);
    _fileCache.set(filePath, { key, data: json, mtimeMs: st.mtimeMs });
    return { data: json, mtimeMs: st.mtimeMs };
  } catch {
    return { data: null, mtimeMs: null };
  }
}

/**
 * 2つの設定オブジェクトをマージする
 * - 配列 (characters, glossary): Union (和集合)
 * - オブジェクト (conversion): Merge (後勝ち)
 * - その他: 後勝ち
 */
function _mergeSettings(base, override) {
  if (!base) return override || null;
  if (!override) return base;

  const merged = { ...base, ...override };

  // Array Union
  const unionArray = (k) => {
    const a = Array.isArray(base[k]) ? base[k] : [];
    const b = Array.isArray(override[k]) ? override[k] : [];
    if (a.length || b.length) {
      // Set で重複排除
      merged[k] = Array.from(new Set([...a, ...b]));
    }
  };
  unionArray("characters");
  unionArray("glossary");

  // Object Merge (conversion)
  if (base.conversion && typeof base.conversion === "object" && !Array.isArray(base.conversion)) {
    const overConv = (override.conversion && typeof override.conversion === "object" && !Array.isArray(override.conversion))
      ? override.conversion
      : {};

    // 単純マージではなく、逆定義の競合解決を行う
    // Base: { "A": "B" }, Override: { "B": "A" } -> Result: { "B": "A" } ("A": "B" must be removed)
    const mergedConv = { ...base.conversion };

    for (const [k, v] of Object.entries(overConv)) {
      // 1. 上書き (spreadで自動だが明示的に整合性を取るならここで扱う)
      mergedConv[k] = v;

      // 2. 逆定義の削除
      // もし Base に "v": "k" があれば、それは競合しているので削除する
      if (mergedConv[v] === k) {
        delete mergedConv[v];
      }
    }

    merged.conversion = mergedConv;
  }

  return merged;
}

/**
 * アクティブ文書のパスに基づき、以下の優先順位で notesetting.json をマージして返す。
 * 1. <WorkspaceRoot>/.vscode/notesetting.json
 * 2. <DocumentDir>/notesetting.json (優先)
 *
 * @param {import("vscode").TextDocument | { uri: { fsPath?: string }}} doc 対象ドキュメント
 * @returns {Promise<{ data: any|null, path: string|null, mtimeMs: number|null }>}
 *   path はローカル側を返す（代表パス）。mtimeMs は両者の最大値（変更検知用）。
 */
async function loadNoteSettingForDoc(doc) {
  try {
    const fsPath = doc?.uri?.fsPath;
    if (!fsPath) return { data: null, path: null, mtimeMs: null };

    const pathModule = require("path");
    const vscode = require("vscode");

    // 1. Workspace Setting
    let wsData = null;
    let wsMtime = 0;

    // uri が vscode.Uri かどうか判定し、そうでなければ fsPath から生成
    let uriForWs = null;
    if (doc.uri && doc.uri["scheme"]) {
      uriForWs = /** @type {vscode.Uri} */ (doc.uri);
    } else if (doc.uri && doc.uri.fsPath) {
      uriForWs = vscode.Uri.file(doc.uri.fsPath);
    }

    const wsFolder = uriForWs ? vscode.workspace.getWorkspaceFolder(uriForWs) : null;
    if (wsFolder) {
      const wsNotePath = pathModule.join(wsFolder.uri.fsPath, ".vscode", "notesetting.json");
      const res = await _loadUniqueJson(wsNotePath);
      if (res.data) {
        wsData = res.data;
        wsMtime = res.mtimeMs || 0;
      }
    }

    // 2. Local Setting
    let localData = null;
    let localMtime = 0;
    let localPath = null;
    const dir = pathModule.dirname(fsPath);
    localPath = pathModule.join(dir, "notesetting.json");

    // ワークスペース設定と同じファイルを指しているなら二重読み込みしない
    if (!wsFolder || !localPath.includes(".vscode")) {
      const res = await _loadUniqueJson(localPath);
      if (res.data) {
          localData = res.data;
          localMtime = res.mtimeMs || 0;
      }
    }

    if (!wsData && !localData) {
      return { data: null, path: null, mtimeMs: null };
    }

    // Merge: Workspace < Local
    const mergedData = _mergeSettings(wsData, localData);
    const maxMtime = Math.max(wsMtime, localMtime);

    return {
      data: mergedData,
      path: localPath, // 代表パス（監視登録用など、既存互換）
      mtimeMs: maxMtime
    };

  } catch (e) {
    console.warn("loadNoteSettingForDoc failed", e);
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

/**
 * 開発者用パスコードが正しいかチェックする
 * @returns {boolean}
 */
function checkDevPasscode() {
  const vscode = require("vscode");
  const cfg = vscode.workspace.getConfiguration("posNote");
  /** @type {string} */
  const code = cfg.get("developer.passcode", "");
  const SECRET = "1247"; // Shared Secret
  if (code !== SECRET) {
      console.log("[posNote] Dev mode not enabled or passcode incorrect.");
      return false;
  }
  return true;
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
  invalidateHeadingCache,
  checkDevPasscode,
  stripBlockComments
};

/**
 * C言語風ブロックコメント（/* ... * /）の除去。
 * 改行も除去されるため、行番号を維持したい場合は別途処理が必要だが、
 * 文字数カウント用途では単純除去でよい。
 * @param {string} text
 * @returns {string} Comments removed
 */
function stripBlockComments(text) {
  if (!text) return "";
  // 非貪欲マッチで除去
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}
