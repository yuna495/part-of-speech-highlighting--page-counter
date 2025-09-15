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

/**
 * 文書の見出しブロックを (# の連なりで) 粗く特定する。
 * 戻り値: [{ start: 見出し行, end: ブロック終端行(含む) }, ...]
 */
function _computeHeadingBlocks(document) {
  const blocks = [];
  const n = document.lineCount;
  const headingLines = [];
  for (let i = 0; i < n; i++) {
    const t = document.lineAt(i).text;
    if (/^\s*#{1,6}\s+/.test(t)) headingLines.push(i);
  }
  for (let idx = 0; idx < headingLines.length; idx++) {
    const start = headingLines[idx];
    const next = headingLines[idx + 1] ?? n; // 次の見出し or 末尾
    const end = Math.max(start, next - 1);
    blocks.push({ start, end });
  }
  return blocks;
}

/**
 * 「折りたたみ中の見出しブロック」を推定する。
 * 仕組み:
 *  - FoldingRangeProvider から折りたたみ可能範囲を取得
 *  - アクティブエディタの visibleRanges を boolean 配列に展開
 *  - 見出し行が visible かつ、直下の行が non-visible、かつ
 *    折りたたみ候補の範囲と heading ブロックが重なる → 折りたたみ中と判定
 *
 * 戻り値: 除外すべき行区間 [{ from, to } ...] （両端とも行番号・含む）
 */
async function _getCollapsedHeadingRanges(document) {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document === document
  );
  if (!editor) return [];

  // 1) 折りたたみ候補範囲
  /** @type {Array<{start: number, end: number, kind?: string}>} */
  const foldingRanges =
    (await vscode.commands.executeCommand(
      "vscode.executeFoldingRangeProvider",
      document.uri
    )) || [];

  // 2) 可視行配列
  const visible = new Array(document.lineCount).fill(false);
  for (const vr of editor.visibleRanges) {
    const s = Math.max(0, vr.start.line);
    const e = Math.min(document.lineCount - 1, vr.end.line);
    for (let ln = s; ln <= e; ln++) visible[ln] = true;
  }

  // 3) 見出しブロックを算出
  const headingBlocks = _computeHeadingBlocks(document);

  const collapsed = [];

  for (const hb of headingBlocks) {
    const h = hb.start;
    const blockFrom = h + 1; // 見出し直下
    const blockTo = hb.end; // 次の見出しの直前（または末尾）
    if (blockFrom > blockTo) continue; // 空ブロック

    // 見出し行は見えているか？（折りたたみ UI 上、ヘッダは見える想定）
    if (!visible[h]) continue;

    // 直下行が見えていなければ、折りたたみ“らしい”
    if (visible[blockFrom]) continue;

    // FoldingRange と重なっているか（保険）
    const overlapsFold = foldingRanges.some((fr) => {
      const frStart = Math.min(fr.start, fr.end ?? fr.start);
      const frEnd = Math.max(fr.start, fr.end ?? fr.start);
      // 見出しの直下まで含む範囲と重なれば OK
      return !(frEnd < blockFrom || blockTo < frStart);
    });

    if (!overlapsFold) continue;

    // 折りたたみ中とみなす
    collapsed.push({ from: blockFrom, to: blockTo });
  }

  return _mergeRanges(collapsed);
}

/** 区間配列をマージ（[{from,to}...] -> 非重複に） */
function _mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a.from - b.from);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.from <= prev.to + 1) {
      prev.to = Math.max(prev.to, cur.to);
    } else {
      out.push({ from: cur.from, to: cur.to });
    }
  }
  return out;
}

/** 括弧セグメント内判定 */
function isInsideAnySegment(start, end, segs) {
  if (!segs || segs.length === 0) return false;
  for (const [s, e] of segs) {
    if (start >= s && end <= e) return true;
  }
  return false;
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

    this._kuromojiCooldownUntil = 0;
    this._kuromojiCooldownTimer = null;

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

  // semantic.js 内 JapaneseSemanticProvider クラス
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

    // ★ 折りたたみ中の範囲（見出し由来のみ）を推定
    //   - 画面外は除外しない（＝従来通りトークン化）
    //   - 「折りたたみ中の行」だけ kuromoji をスキップする
    let foldedRanges = [];
    try {
      foldedRanges = await _getCollapsedHeadingRanges(document);
    } catch {
      foldedRanges = [];
    }
    const foldedLineFlags = new Uint8Array(document.lineCount);
    for (const r of foldedRanges) {
      const from = Math.max(0, r.from);
      const to = Math.min(document.lineCount - 1, r.to);
      for (let ln = from; ln <= to; ln++) foldedLineFlags[ln] = 1;
    }

    // 括弧セグメント収集
    const idxBracket = tokenTypesArr.indexOf("bracket");
    const idxChar = tokenTypesArr.indexOf("character");
    const idxGlossary = tokenTypesArr.indexOf("glossary");
    /** @type {Map<number, Array<[number, number]>>} */
    const bracketSegsByLine = new Map();
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;
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

    // ★ ループは一つに統一（ネストしていた二重ループを削除）
    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;

      // ループ冒頭で必ず行テキストを取得（これが無いと TS(2304) ）
      const text = document.lineAt(line).text;

      // 見出し一色（見出し行は折りたたまれない想定）
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
            continue; // 見出し行は他トークン不要で抜ける
          }
        }
      }

      // ▼ (1) ローカル辞書マッチ（最優先）
      const dictRanges =
        charWords.size || gloWords.size
          ? matchDictRanges(text, charWords, gloWords)
          : [];

      for (const r of dictRanges) {
        const typeIdx = r.kind === "character" ? idxChar : idxGlossary;
        builder.push(line, r.start, r.end - r.start, typeIdx, 0);
      }

      // 全角スペース（辞書優先のため、重なる位置は出力しない）
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const s = m.index,
            e = m.index + 1;
          if (dictRanges.some((R) => !(e <= R.start || R.end <= s))) continue;
          builder.push(line, s, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // ダッシュ（—, ―）も辞書優先でスキップ
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          const s = m.index,
            e = m.index + m[0].length;
          if (dictRanges.some((R) => !(e <= R.start || R.end <= s))) continue;
          const typeIdxForDash = bracketOverrideOn
            ? idxBracket
            : tokenTypesArr.indexOf("symbol");
          builder.push(line, s, e - s, typeIdxForDash, 0);
        }
      }

      // ▼ (2) 括弧セグメント（ON時）— ただし辞書マスクで“穴あき”にして塗る
      if (bracketOverrideOn) {
        const segs = bracketSegsByLine.get(line);
        if (segs && segs.length) {
          const rest = subtractMaskedIntervals(segs, dictRanges);
          for (const [sCh, eCh] of rest) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // ▼ (3) 品詞ハイライト（kuromoji）
      // ★ ここだけ折りたたみ行を除外する（= 他の装飾はそのまま）
      if (!foldedLineFlags[line] && tokenizer && text.trim()) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const start = seg.start,
            end = seg.end;
          const length = end - start;

          // 辞書マスクに重なる箇所は POS を出さない
          if (dictRanges.some((R) => !(end <= R.start || R.end <= start)))
            continue;

          // 括弧上書きがONなら、括弧区間は POS を出さない（辞書は既に出力済み）
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

  // 行配列と先頭オフセット
  const lines = String(text).split(/\r?\n/);
  const lineOffsets = new Array(lines.length);
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
function buildPreviewCssFromEditorRules() {
  try {
    const editorCfg = vscode.workspace.getConfiguration("editor");
    const custom = editorCfg.get("semanticTokenColorCustomizations") || {};
    const rules = custom.rules || {};
    if (!rules || typeof rules !== "object") return "";

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
    return "";
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
