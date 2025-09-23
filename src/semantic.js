// src/semantic.js
// セマンティックトークン周辺（エディタ）＋プレビュー用HTML生成（Webview）
// 依存: CommonJS（VS Code 拡張の Node ランタイム）

/* ========================================
 * 0) Imports
 * ====================================== */
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS
const { getHeadingLevel } = require("./utils");

/* ========================================
 * 1) Semantic 定数・Legend
 * ====================================== */
const tokenTypesArr = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "particle",
  "auxiliary",
  "prenoun",
  "conjunction",
  "interjection",
  "symbol",
  "other",
  "bracket",
  "character",
  "glossary",
  "fwspace",
  "heading",
  "fencecomment",
];
const tokenModsArr = ["proper", "prefix", "suffix"];

const semanticLegend = new vscode.SemanticTokensLegend(
  Array.from(tokenTypesArr),
  Array.from(tokenModsArr)
);
// ===== ローカル辞書（同じフォルダ限定）ユーティリティ =====
const fsPromises = fs.promises;

/* ========================================
 * 2) 全角括弧の対応表（検出用）
 * ====================================== */
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
]);
const FW_CLOSE_SET = new Set(Array.from(FW_BRACKET_MAP.values()));

/* ========================================
 * 3) Kuromoji Tokenizer
 * ====================================== */
let tokenizer = null;

/**
 * 拡張直下の dict/ を使って kuromoji を初期化
 * 見つからない場合はエラーメッセージを出して return（呼び側の try/catch でフォールバック）
 * @param {vscode.ExtensionContext} context
 */
async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict");
  if (!fs.existsSync(dictPath)) {
    vscode.window.showErrorMessage(
      "kuromoji の辞書が見つかりません。拡張直下の 'dict/' を配置してください。"
    );
    return;
  }
  tokenizer = await new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: dictPath }).build((err, tknz) => {
      if (err) reject(err);
      else resolve(tknz);
    });
  });
}

/* ========================================
 * 4) 汎用ヘルパ
 * ====================================== */

/** HTML エスケープ（最小限） */
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 括弧セグメント内判定 */
function isInsideAnySegment(start, end, segs) {
  if (!segs || segs.length === 0) return false;
  for (const [s, e] of segs) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

/**
 * ドキュメント全体から ``` ～ ``` のフェンス区間を収集（終端は行末まで）
 * - 囲みはネスト非対応（一般的な Markdown と同様の単純規則）
 * - フェンス行自体も「コメント扱い」に含める
 * 返値: vscode.Range[] （行単位だが文字オフセットも適切に付与）
 */
function computeFenceRanges(doc) {
  const ranges = [];
  let inFence = false;
  let fenceStartPos = null;

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    // 行頭/行中問わず ``` を検出（単純化：3連バッククォートが含まれたらフェンストグル）
    if (text.includes("```")) {
      if (!inFence) {
        inFence = true;
        fenceStartPos = new vscode.Position(i, 0);
      } else {
        // フェンス終端。終端行の末尾まで含める
        const endPos = new vscode.Position(i, text.length);
        ranges.push(new vscode.Range(fenceStartPos, endPos));
        inFence = false;
        fenceStartPos = null;
      }
    }
  }
  // 末尾まで閉じられなかった場合はファイル末尾までをフェンス扱い
  if (inFence && fenceStartPos) {
    const lastLine = doc.lineCount - 1;
    const endPos = new vscode.Position(
      lastLine,
      doc.lineAt(lastLine).text.length
    );
    ranges.push(new vscode.Range(fenceStartPos, endPos));
  }
  return ranges;
}

/** ドキュメント全体から全角括弧の Range を収集（エディタ用） */
function computeFullwidthQuoteRanges(doc) {
  const text = doc.getText();
  const ranges = [];
  const stack = []; // { expectedClose, openOffset }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const close = FW_BRACKET_MAP.get(ch);
    if (close) {
      stack.push({ expectedClose: close, openOffset: i });
      continue;
    }
    if (FW_CLOSE_SET.has(ch)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (ch === top.expectedClose) {
          stack.pop();
          const startPos = doc.positionAt(top.openOffset);
          const endPos = doc.positionAt(i + 1);
          ranges.push(new vscode.Range(startPos, endPos));
        }
      }
    }
  }
  return ranges;
}

/** kuromoji の品詞 → semantic token type へ変換 */
function mapKuromojiToSemantic(tk) {
  const pos = tk.pos || "";
  const pos1 = tk.pos_detail_1 || "";
  let type = "other";
  if (pos === "名詞") type = "noun";
  else if (pos === "動詞") type = "verb";
  else if (pos === "形容詞") type = "adjective";
  else if (pos === "副詞") type = "adverb";
  else if (pos === "助詞") type = "particle";
  else if (pos === "助動詞") type = "auxiliary";
  else if (pos === "連体詞") type = "prenoun";
  else if (pos === "接続詞") type = "conjunction";
  else if (pos === "感動詞") type = "interjection";
  else if (pos === "記号") type = "symbol";

  let mods = 0;
  if (pos1 === "固有名詞") mods |= 1 << tokenModsArr.indexOf("proper");
  if (pos1 === "接頭") mods |= 1 << tokenModsArr.indexOf("prefix");
  if (pos1 === "接尾") mods |= 1 << tokenModsArr.indexOf("suffix");
  return { typeIdx: Math.max(0, tokenTypesArr.indexOf(type)), mods };
}

/** 1行テキストと kuromoji トークン列から、表層形のオフセットを列挙 */
function* enumerateTokenOffsets(lineText, tokens) {
  let cur = 0;
  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;
    const i = lineText.indexOf(s, cur);
    if (i === -1) continue;
    yield { start: i, end: i + s.length, tk };
    cur = i + s.length;
  }
}

/* ========================================
 * 5) 同一フォルダの characters.json / glossary.json を読むユーティリティ
 * ====================================== */

// JSON: 配列形式 / 連想形式 / 文字列配列の全対応で {words:Set<string>} を返す
async function loadWordsFromJsonFile(filePath, charMode /*true=characters*/) {
  try {
    const txt = await fs.promises.readFile(filePath, "utf8");
    const json = JSON.parse(txt);
    const words = new Set();

    const put = (s) => {
      const v = String(s || "").trim();
      if (v) words.add(v);
    };

    if (Array.isArray(json)) {
      // ① 文字列配列: ["奏音","未澪"] ← ★このケースを追加
      if (json.length && typeof json[0] === "string") {
        for (const s of json) put(s);
      } else {
        // ② オブジェクト配列: [{name, alias[]}, {term, variants[]}, …]
        for (const it of json) {
          if (!it) continue;
          if (charMode) {
            if (it.name) put(it.name);
            if (Array.isArray(it.alias)) it.alias.forEach(put);
          } else {
            if (it.term) put(it.term);
            if (Array.isArray(it.variants)) it.variants.forEach(put);
          }
        }
      }
    } else if (json && typeof json === "object") {
      // ③ 連想配列: { "奏音": {...}, "未澪": "説明" }
      for (const k of Object.keys(json)) {
        put(k);
        const v = json[k];
        if (charMode) {
          if (v && Array.isArray(v.alias)) v.alias.forEach(put);
        } else {
          if (v && Array.isArray(v.variants)) v.variants.forEach(put);
        }
      }
    }
    return words;
  } catch {
    return new Set();
  }
}

/**
 * 同じフォルダ限定で辞書をロード
 * - なければ空集合（= 一切適用しない）
 * キャッシュ: フォルダパス単位（軽量）
 */
const _localDictCache = new Map(); // key: dirPath -> {mtime?, chars:Set, glos:Set}
async function loadLocalDictForDoc(docUri) {
  try {
    const dir = path.dirname(docUri.fsPath);
    const cache = _localDictCache.get(dir);
    // 超単純キャッシュ：毎回読み直しても良いが、軽減のためファイル存在のみ見る
    const charPath = path.join(dir, "characters.json");
    const gloPath = path.join(dir, "glossary.json");

    // ファイル有無
    const [charStat, gloStat] = await Promise.all([
      fsPromises.stat(charPath).catch(() => null),
      fsPromises.stat(gloPath).catch(() => null),
    ]);

    // どちらも無ければ空
    if (!charStat && !gloStat) {
      _localDictCache.set(dir, {
        chars: new Set(),
        glos: new Set(),
        key: "none",
      });
      return { chars: new Set(), glos: new Set() };
    }

    // 簡易キー（更新検出）
    const key = `${charStat?.mtimeMs || 0}:${gloStat?.mtimeMs || 0}`;
    if (cache && cache.key === key)
      return { chars: cache.chars, glos: cache.glos };

    const [chars, glos] = await Promise.all([
      charStat
        ? loadWordsFromJsonFile(charPath, true)
        : Promise.resolve(new Set()),
      gloStat
        ? loadWordsFromJsonFile(gloPath, false)
        : Promise.resolve(new Set()),
    ]);
    const val = { chars, glos, key };
    _localDictCache.set(dir, val);
    return { chars, glos };
  } catch {
    return { chars: new Set(), glos: new Set() };
  }
}

/**
 * 行テキストから、辞書語の**非重複**マッチを抽出
 * - 最長一致優先 → 重複領域は先取で確定
 * - 返値: [{start, end, kind:"character"|"glossary"}]
 */
function matchDictRanges(lineText, charsSet, glosSet) {
  const res = [];
  if (!lineText) return res;

  // 検索語（長い順）
  const needles = [];
  for (const w of charsSet) needles.push({ w, k: "character" });
  for (const w of glosSet) needles.push({ w, k: "glossary" });
  needles.sort((a, b) => b.w.length - a.w.length);

  const used = new Array(lineText.length).fill(false);
  const canPlace = (s, e) => {
    for (let i = s; i < e; i++) {
      if (used[i]) return false;
    }
    return true;
  };
  const mark = (s, e) => {
    for (let i = s; i < e; i++) {
      used[i] = true;
    }
  };

  for (const { w, k } of needles) {
    let idx = 0;
    while (w && (idx = lineText.indexOf(w, idx)) !== -1) {
      const s = idx,
        e = idx + w.length;
      if (canPlace(s, e)) {
        mark(s, e);
        res.push({ start: s, end: e, kind: k });
      }
      idx = e;
    }
  }
  // 左→右に整列
  res.sort((a, b) => a.start - b.start);
  return res;
}

/**
 * 区間集合 A から B（辞書マスク）を引く（差分区間の列挙）
 * 入力: A=[ [s,e], ... ] / mask=[ {start,end}, ... ]
 * 出力: [ [s,e], ... ]（非重複・昇順）
 * @param {Array<[number, number]>} A
 * @param {{start:number, end:number}[]} mask
 * @returns {Array<[number, number]>}
 */
function subtractMaskedIntervals(A, mask) {
  if (!A || A.length === 0) return [];
  if (!mask || mask.length === 0) return A.slice();
  const out = [];
  for (const [as, ae] of A) {
    let cur = [[as, ae]];
    for (const m of mask) {
      const next = [];
      for (const [s, e] of cur) {
        if (e <= m.start || m.end <= s) {
          next.push([s, e]);
          continue;
        }
        if (s < m.start) next.push([s, Math.max(s, m.start)]);
        if (m.end < e) next.push([Math.min(e, m.end), e]);
      }
      cur = next;
      if (cur.length === 0) break;
    }
    out.push(...cur);
  }
  out.sort((a, b) => a[0] - b[0]);
  /** @type {Array<[number, number]>} */
  const merged = [];
  for (const seg of out) {
    if (!merged.length || merged[merged.length - 1][1] < seg[0])
      merged.push(/** @type {[number, number]} */ (seg));
    else
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        seg[1]
      );
  }
  return merged;
}

/* ========================================
 * 6) エディタ側 Semantic Provider
 * ====================================== */
class JapaneseSemanticProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{ cfg: () => any }} opt
   */
  constructor(context, opt) {
    this._context = context;
    this._cfg = opt?.cfg ?? (() => ({}));
    this._onDidChangeSemanticTokens = new vscode.EventEmitter();
    /** @type {vscode.Event<void>} */
    this.onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

    // 辞書ファイル変更を拾って再発行
    const w1 = vscode.workspace.createFileSystemWatcher("**/characters.json");
    const w2 = vscode.workspace.createFileSystemWatcher("**/glossary.json");
    const fire = () => this._onDidChangeSemanticTokens.fire();
    context.subscriptions.push(
      w1.onDidCreate(fire),
      w1.onDidChange(fire),
      w1.onDidDelete(fire),
      w2.onDidCreate(fire),
      w2.onDidChange(fire),
      w2.onDidDelete(fire)
    );
  }

  _legend() {
    return semanticLegend;
  }

  fireDidChange() {
    this._onDidChangeSemanticTokens.fire();
  }

  async _buildTokens(document, range, cancelToken) {
    const c = this._cfg();

    // 有効/無効
    const lang = (document.languageId || "").toLowerCase();
    if (lang === "markdown") {
      if (!c.semanticEnabledMd)
        return new vscode.SemanticTokens(new Uint32Array());
    } else {
      if (!c.semanticEnabled)
        return new vscode.SemanticTokens(new Uint32Array());
    }

    await ensureTokenizer(this._context);

    // ▼ 同一フォルダ限定のローカル辞書をロード
    const { chars: charWords, glos: gloWords } = await loadLocalDictForDoc(
      document.uri
    );

    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);

    // 括弧セグメント収集
    const idxBracket = tokenTypesArr.indexOf("bracket");
    const idxChar = tokenTypesArr.indexOf("character");
    const idxGlossary = tokenTypesArr.indexOf("glossary");
    const idxFence = tokenTypesArr.indexOf("fencecomment");
    /** @type {Map<number, Array<[number, number]>>} */
    const bracketSegsByLine = new Map();
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;

    // フェンスブロックの行ごとセグメント収集
    /** @type {Map<number, Array<[number, number]>>} */
    const fenceSegsByLine = new Map();
    (() => {
      const franges = computeFenceRanges(document); // ← 追加
      for (const r of franges) {
        const sL = r.start.line,
          eL = r.end.line;
        for (let ln = sL; ln <= eL; ln++) {
          const lineText = document.lineAt(ln).text;
          const sCh = ln === sL ? r.start.character : 0;
          const eCh = ln === eL ? r.end.character : lineText.length;
          if (eCh > sCh) {
            const arr = fenceSegsByLine.get(ln) || [];
            arr.push([sCh, eCh]);
            fenceSegsByLine.set(ln, arr);
          }
        }
      }
    })();

    // 括弧セグメント収集ブロック
    (() => {
      const pairs = computeFullwidthQuoteRanges(document);
      for (const r of pairs) {
        const sL = r.start.line,
          eL = r.end.line;
        for (let ln = sL; ln <= eL; ln++) {
          const lineText = document.lineAt(ln).text;
          const sCh = ln === sL ? r.start.character : 0;
          const eCh = ln === eL ? r.end.character : lineText.length;
          if (eCh > sCh) {
            const arr = /** @type {Array<[number, number]>} */ (
              bracketSegsByLine.get(ln) || []
            );
            arr.push(/** @type {[number, number]} */ ([sCh, eCh]));
            bracketSegsByLine.set(ln, arr);
          }
        }
      }
    })();

    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;
      const text = document.lineAt(line).text;

      // 見出し一色
      if (c.headingSemanticEnabled) {
        const l = (document.languageId || "").toLowerCase();
        if (l === "plaintext" || l === "novel" || l === "markdown") {
          const lvl = getHeadingLevel(text);
          if (lvl > 0) {
            builder.push(
              line,
              0,
              text.length,
              tokenTypesArr.indexOf("heading"),
              0
            );
            continue;
          }
        }
      }

      // ▼ (0) フェンスブロック：最優先で塗って、以降の処理を“その区間だけ”スキップ
      const fenceSegs = fenceSegsByLine.get(line) || [];
      // 辞書が存在しても、フェンス内は辞書やPOSを出さない（完全除外）
      for (const [sCh, eCh] of fenceSegs) {
        const len = eCh - sCh;
        if (len > 0) builder.push(line, sCh, len, idxFence, 0);
      }

      // 以降の処理は「フェンスに重ならない残り部分」だけに適用する
      const restForLine = (segments) =>
        subtractMaskedIntervals([[0, text.length]], segments);
      const nonFenceSpans = restForLine(fenceSegs);

      // ▼ (1) ローカル辞書マッチ（最優先）
      // 無い場合はスキップ（= 一切適用しない）
      const dictRanges =
        charWords.size || gloWords.size
          ? matchDictRanges(text, charWords, gloWords)
          : [];
      const dictRangesOutsideFence = [];
      for (const [s, e] of nonFenceSpans) {
        for (const r of dictRanges) {
          const ss = Math.max(s, r.start),
            ee = Math.min(e, r.end);
          if (ee > ss)
            dictRangesOutsideFence.push({ start: ss, end: ee, kind: r.kind });
        }
      }
      for (const r of dictRangesOutsideFence) {
        const typeIdx = r.kind === "character" ? idxChar : idxGlossary;
        builder.push(line, r.start, r.end - r.start, typeIdx, 0);
      }

      const mask = dictRangesOutsideFence;
      const spansAfterDict = subtractMaskedIntervals(nonFenceSpans, mask);

      // (fwspace)
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const s = m.index,
            e = s + 1;
          if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
            builder.push(line, s, 1, tokenTypesArr.indexOf("fwspace"), 0);
          }
        }
      }

      // (ダッシュ)
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          const s = m.index,
            e = s + m[0].length;
          if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
            const tIdx = bracketOverrideOn
              ? idxBracket
              : tokenTypesArr.indexOf("symbol");
            builder.push(line, s, e - s, tIdx, 0);
          }
        }
      }

      // (括弧上書き)
      if (bracketOverrideOn) {
        const segs = bracketSegsByLine.get(line);
        if (segs?.length) {
          // フェンス外＆辞書外だけ塗る
          const segsOutsideFence = subtractMaskedIntervals(
            segs,
            fenceSegs.map(([s, e]) => ({ start: s, end: e }))
          );
          const rest = subtractMaskedIntervals(
            segsOutsideFence,
            dictRangesOutsideFence
          );
          for (const [sCh, eCh] of rest) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // (kuromoji 品詞) — フェンス外＆辞書外＆（括弧上書きONなら）括弧外
      if (tokenizer && text.trim() && spansAfterDict.length) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const start = seg.start,
            end = seg.end,
            length = end - start;
          if (!spansAfterDict.some(([S, E]) => start >= S && end <= E))
            continue;
          if (bracketOverrideOn) {
            const segs = bracketSegsByLine.get(line);
            if (isInsideAnySegment(start, end, segs)) continue;
          }
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          builder.push(line, start, length, typeIdx, mods);
        }
      }
    }
    return builder.build();
  }

  async provideDocumentSemanticTokens(document, token) {
    if (token?.isCancellationRequested) {
      return new vscode.SemanticTokens(new Uint32Array());
    }
    const fullRange = new vscode.Range(
      0,
      0,
      document.lineCount - 1,
      document.lineAt(Math.max(0, document.lineCount - 1)).text.length
    );
    return this._buildTokens(document, fullRange, token);
  }

  async provideDocumentRangeSemanticTokens(document, range, token) {
    if (token?.isCancellationRequested) {
      return new vscode.SemanticTokens(new Uint32Array());
    }
    return this._buildTokens(document, range, token);
  }
}

/* ========================================
 * 7) Webview（プレビュー）用：HTML生成
 * ====================================== */

/**
 * VS Code 側と同じ分類（tokenTypesArr）で <span class="pos-XXX">…</span> を行ごと生成。
 * - docUri が与えられれば、同フォルダの characters.json / glossary.json を読み込み、
 *   行内で "最優先" で pos-character / pos-glossary を付与する。
 * - 括弧上書きが有効なら、辞書に“重ならない部分”だけ pos-bracket を塗る。
 * - 残りは kuromoji による品詞スパン（pos-<type>）。ダッシュは bracket/symbol として強制色。
 * @param {string} text
 * @param {import('vscode').ExtensionContext} context
 * @param {{
 *   maxLines?: number,
 *   headingDetector?: (line:string)=>number,
 *   classPrefix?: string,
 *   activeLine?: number,
 *   docUri?: import('vscode').Uri
 * }} [opts]
 */

/**
 * 与えられた素テキストを行単位に見て、^``` のペアで囲まれた行だけ true にするマスクを返す。
 * 未クローズの ``` は無視（＝誤爆で全部塗らない）。
 */
function buildFenceLineMaskFromText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const mask = new Array(lines.length).fill(false);
  const fenceRe = /^\s*```/;
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!fenceRe.test(lines[i])) continue;
    if (open < 0) {
      open = i; // 開始
    } else {
      // 開始〜終了まで true
      for (let j = open; j <= i; j++) mask[j] = true;
      open = -1;
    }
  }
  // 未クローズは無視（open>=0 でも何もしない）
  return mask;
}

/**
 * すでに品詞/見出し等でハイライト済みの HTML（<p>…</p> が行数ぶん並んでいる想定）
 * に対して、コードフェンス該当行だけ <span class="pos-fencecomment">…</span> を内側に巻く。
 * 他のハイライト span は**壊さない**。
 */
function applyFenceColorToParagraphHtml(html, text) {
  if (!html) return html;
  const blocks = html.match(/<p[\s\S]*?<\/p>/g);
  if (!blocks) return html;

  const mask = buildFenceLineMaskFromText(text);
  if (!mask.length) return html;
  // 行数不一致でも安全に：短い方に合わせる
  const n = Math.min(mask.length, blocks.length);

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    // <p>…</p> の内側だけ包む
    blocks[i] = blocks[i].replace(
      /^<p([^>]*)>([\s\S]*?)<\/p>$/i,
      (m, attrs, inner) =>
        `<p${attrs}><span class="pos-fencecomment">${inner}</span></p>`
    );
  }
  // 置換した配列を元の HTML に戻す
  // もとの html が <p>連結文字列</p>… の単純連結なら join('') で一致する
  return blocks.join("");
}

async function toPosHtml(text, context, opts = {}) {
  const {
    maxLines = 2000,
    headingDetector,
    classPrefix = "pos-",
    activeLine = 0,
    docUri,
  } = opts || {};

  // kuromoji が無くても辞書ハイライトは動作するようにする
  try {
    await ensureTokenizer(context);
  } catch {}

  // 設定
  const c = vscode.workspace.getConfiguration("posNote");
  const bracketOverrideOn = !!c.get("semantic.bracketsOverride.enabled", true);
  const headingSemanticOn = !!c.get("headings.semantic.enabled", true);

  // まず行配列とオフセットを用意（← ここを先に！）
  const lines = String(text).split(/\r?\n/);
  const lineOffsets = new Array(lines.length);
  {
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = off;
      off += lines[i].length + 1;
    }
  }

  // 2) テキスト全体のフェンス区間（絶対オフセット）
  /** @type {Array<[number, number]>} */
  const fencePairs = [];
  {
    let inFence = false,
      startOff = 0,
      off = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasFence = line.includes("```");
      if (hasFence && !inFence) {
        inFence = true;
        startOff = off;
      } else if (hasFence && inFence) {
        fencePairs.push([startOff, off + line.length]);
        inFence = false;
      }
      off += line.length + 1;
    }
    if (inFence) fencePairs.push([startOff, off]);
  }

  // 3) 各行にフェンスセグメントを割当（← lines/lineOffsets を使うブロックはここ）
  /** @type {Map<number, Array<[number, number]>>} */
  const fenceSegsByLine = new Map();
  for (const [sAbs, eAbs] of fencePairs) {
    for (let i = 0; i < lines.length; i++) {
      const sCh = Math.max(0, sAbs - lineOffsets[i]);
      const eCh = Math.min(lines[i].length, eAbs - lineOffsets[i]);
      if (eCh > 0 && sCh < lines[i].length && eCh > sCh) {
        const arr = fenceSegsByLine.get(i) || [];
        arr.push([sCh, eCh]);
        fenceSegsByLine.set(i, arr);
      }
    }
  }

  // 全テキストの全角括弧ペア（[open, close+1)）
  /** @type {Array<[number, number]>} */
  const pairs = [];
  {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const close = FW_BRACKET_MAP.get(ch);
      if (close) {
        stack.push({ expectedClose: close, openOffset: i });
        continue;
      }
      if (FW_CLOSE_SET.has(ch)) {
        const top = stack[stack.length - 1];
        if (top && ch === top.expectedClose) {
          stack.pop();
          pairs.push(/** @type {[number, number]} */ ([top.openOffset, i + 1]));
        }
      }
    }
  }

  {
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = off;
      off += lines[i].length + 1;
    }
  }

  // 同フォルダ辞書（無ければ空集合＝未適用）
  let charWords = new Set(),
    gloWords = new Set();
  if (docUri) {
    const got = await loadLocalDictForDoc(docUri).catch(() => ({
      chars: new Set(),
      glos: new Set(),
    }));
    charWords = got?.chars || new Set();
    gloWords = got?.glos || new Set();
  }

  // 補助レンダラ
  const escapeHtml = (s) => _escapeHtml(s);
  const tokenizedSpanHtml = (s) => {
    if (!s) return "";
    if (!tokenizer) return escapeHtml(s); // kuromoji 不在時は生テキスト
    const tokens = tokenizer.tokenize(s);
    return tokens
      .map((t) => {
        const { typeIdx } = mapKuromojiToSemantic(t);
        const typeName = tokenTypesArr[typeIdx] || "other";
        const surf = escapeHtml(t.surface_form || "");
        return `<span class="${classPrefix}${typeName}" data-pos="${escapeHtml(
          t.pos || ""
        )}">${surf}</span>`;
      })
      .join("");
  };
  const dashRe = /[—―]/g;
  const renderWithDash = (s) => {
    if (!s) return "";
    const out = [];
    let last = 0,
      m;
    dashRe.lastIndex = 0;
    while ((m = dashRe.exec(s)) !== null) {
      const before = s.slice(last, m.index);
      if (before) out.push(tokenizedSpanHtml(before));
      const ch = escapeHtml(m[0]);
      const dashClass = bracketOverrideOn ? "bracket" : "symbol";
      out.push(`<span class="${classPrefix}${dashClass}">${ch}</span>`);
      last = m.index + m[0].length;
    }
    const tail = s.slice(last);
    if (tail) out.push(tokenizedSpanHtml(tail));
    return out.join("");
  };

  // 行レンダリング（辞書→括弧→品詞）
  const out = [];
  const total = lines.length;
  const winStart = Math.max(0, activeLine - maxLines);
  const winEnd = Math.min(total - 1, activeLine + maxLines);

  for (let i = 0; i < total; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      out.push(`<p class="blank" data-line="${i}">_</p>`);
      continue;
    }

    // 見出し一色
    const headLv =
      typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
    if (headingSemanticOn && headLv > 0) {
      const safe = escapeHtml(line);
      out.push(
        `<p data-line="${i}" class="heading"><span class="${classPrefix}heading">${safe}</span></p>`
      );
      continue;
    }

    // ウィンドウ外はプレーン
    const inWindow = i >= winStart && i <= winEnd;
    if (!inWindow) {
      out.push(`<p data-line="${i}">${escapeHtml(line)}</p>`);
      continue;
    }

    const lineStart = lineOffsets[i];

    // 行ループ内：まずフェンスを描画（最優先）
    const fenceSegs = fenceSegsByLine.get(i) || [];
    if (fenceSegs.length) {
      // フェンスだけで構成されている行は、そのまま一気に作る
      let cur = 0;
      const chunks = [];
      for (const [s, e] of fenceSegs) {
        if (s > cur) chunks.push(escapeHtml(line.slice(cur, s))); // フェンス外(前)
        const inner = escapeHtml(line.slice(s, e));
        chunks.push(`<span class="${classPrefix}fencecomment">${inner}</span>`); // ← コメント色
        cur = e;
      }
      if (cur < line.length) {
        // 後続の残部には辞書/括弧/POS を適用（既存の処理を呼ぶ）— 以下の既存合成に自然合流
      }
      // この後の辞書/括弧/POS 生成では「フェンス外残部」だけに適用するよう
      // subtractMaskedIntervals を使って分割済みの spans を使う（既存の実装に合わせて適用）
    }

    // 行内 括弧区間
    /** @type {Array<[number, number]>} */ let segs = [];
    if (bracketOverrideOn && pairs.length) {
      for (const [s, e] of pairs) {
        const sCh = Math.max(0, s - lineStart);
        const eCh = Math.min(line.length, e - lineStart);
        if (eCh > 0 && sCh < line.length && eCh > sCh)
          segs.push(/** @type {[number, number]} */ ([sCh, eCh]));
      }
      if (segs.length > 1) {
        segs.sort((a, b) => a[0] - b[0]);
        const merged = /** @type {Array<[number, number]>} */ ([]);
        let [cs, ce] = segs[0];
        for (let k = 1; k < segs.length; k++) {
          const [ns, ne] = segs[k];
          if (ns <= ce) ce = Math.max(ce, ne);
          else {
            merged.push([cs, ce]);
            cs = ns;
            ce = ne;
          }
        }
        merged.push([cs, ce]);
        segs = merged;
      }
    }

    // ▼ (1) 同フォルダ辞書マッチ（最優先）
    const dictRanges =
      charWords.size || gloWords.size
        ? matchDictRanges(line, charWords, gloWords)
        : [];

    // ▼ (2) 括弧は、辞書に重ならない残部だけに適用
    const bracketRest = bracketOverrideOn
      ? subtractMaskedIntervals(segs, dictRanges)
      : /** @type {Array<[number, number]>} */ ([]);

    // ▼ (3) マークを結合して左→右へ生成
    const marks = [];
    for (const r of dictRanges)
      marks.push({
        s: r.start,
        e: r.end,
        cls: r.kind === "character" ? "character" : "glossary",
      });
    for (const [s, e] of bracketRest) marks.push({ s, e, cls: "bracket" });
    marks.sort((a, b) => a.s - b.s);

    let cur = 0;
    const chunks = [];
    for (const m of marks) {
      if (m.s > cur) {
        // “残り”はダッシュ分割＋品詞スパン
        chunks.push(renderWithDash(line.slice(cur, m.s)));
      }
      const inner = escapeHtml(line.slice(m.s, m.e));
      chunks.push(`<span class="${classPrefix}${m.cls}">${inner}</span>`);
      cur = m.e;
    }
    if (cur < line.length) chunks.push(renderWithDash(line.slice(cur)));

    out.push(`<p data-line="${i}">${chunks.join("")}</p>`);
  }

  return out.join("");
}

/* ========================================
 * 8) Webview（プレビュー）用：設定色 → CSS 生成
 * ====================================== */
/**
 * エディタ設定（editor.semanticTokenColorCustomizations.rules）を
 * プレビュー用の CSS 文字列に変換。
 * 未設定のトークンは出力しない（= 既定の style.css が効く）
 * @returns {string} CSS text
 */
/**
 * エディタ設定（editor.semanticTokenColorCustomizations.rules）を
 * プレビュー用の CSS に反映。未指定トークンは出力しないが、
 * fencecomment については未設定時に既定色 #f0f0c0 を適用する。
 * @returns {string} CSS text
 */
function buildPreviewCssFromEditorRules() {
  try {
    const editorCfg = vscode.workspace.getConfiguration("editor");
    const custom = editorCfg.get("semanticTokenColorCustomizations") || {};
    const rules = custom.rules || {};
    if (!rules || typeof rules !== "object") {
      // ルール自体が無い場合でも fencecomment の既定は出す
      return `.pos-fencecomment{color:#f0f0c0;}\n`;
    }

    const mapSimple = (key, cls) => {
      const val = rules[key];
      if (!val) return "";
      if (typeof val === "string") return `.${cls}{color:${val};}\n`;
      if (typeof val === "object" && typeof val.foreground === "string")
        return `.${cls}{color:${val.foreground};}\n`;
      return "";
    };

    let css = "";
    css += mapSimple("noun", "pos-noun");
    css += mapSimple("verb", "pos-verb");
    css += mapSimple("adjective", "pos-adjective");
    css += mapSimple("adverb", "pos-adverb");
    css += mapSimple("particle", "pos-particle");
    css += mapSimple("auxiliary", "pos-auxiliary");
    css += mapSimple("prenoun", "pos-prenoun");
    css += mapSimple("conjunction", "pos-conjunction");
    css += mapSimple("interjection", "pos-interjection");
    css += mapSimple("symbol", "pos-symbol");
    css += mapSimple("other", "pos-other");
    css += mapSimple("character", "pos-character");
    css += mapSimple("glossary", "pos-glossary");
    css += mapSimple("bracket", "pos-bracket");
    css += mapSimple("heading", "pos-heading");

    // fencecomment: ユーザー設定があればそれを、無ければ規定色を入れる
    const fenceCss = mapSimple("fencecomment", "pos-fencecomment");
    if (fenceCss) {
      css += fenceCss;
    } else {
      css += `.pos-fencecomment{color:#f0f0c0;}\n`;
    }

    // fwspace（オブジェクト形式のみ対応）
    const fw = rules["fwspace"];
    if (fw && typeof fw === "object") {
      const parts = [];
      if (fw.foreground) parts.push(`color:${fw.foreground}`);
      if (fw.underline) parts.push(`text-decoration:underline`);
      if (parts.length) css += `.pos-fwspace{${parts.join(";")}}` + "\n";
    }

    return css;
  } catch (e) {
    console.error("buildPreviewCssFromEditorRules failed:", e);
    // エラー時でも fencecomment の規定色は入れておく
    return `.pos-fencecomment{color:#f0f0c0;}\n`;
  }
}

/* ========================================
 * 9) Exports
 * ====================================== */
module.exports = {
  JapaneseSemanticProvider,
  semanticLegend,
  toPosHtml,
  buildPreviewCssFromEditorRules,
};
