// src/semantic.js
// セマンティックトークン周辺を集約（CommonJS）

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS
const { getHeadingLevel } = require("./utils");

// ===== セマンティック定義 =====
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
  "fwspace",
  "heading",
];
const tokenModsArr = ["proper", "prefix", "suffix"];
const semanticLegend = new vscode.SemanticTokensLegend(
  Array.from(tokenTypesArr),
  Array.from(tokenModsArr)
);

// ===== FW括弧（レンジ検出用の最低限）=====
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

// ===== Kuromoji tokenizer =====
let tokenizer = null;
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

// ===== ヘルパ =====
function isInsideAnySegment(start, end, segs) {
  if (!segs || segs.length === 0) return false;
  for (const [s, e] of segs) {
    if (start >= s && end <= e) return true;
  }
  return false;
}

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

// ===== Provider =====
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

    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;

    // 括弧セグメントを事前収集
    const idxBracket = tokenTypesArr.indexOf("bracket");
    const bracketSegsByLine = new Map();
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
            const arr = bracketSegsByLine.get(ln) || [];
            arr.push([sCh, eCh]);
            bracketSegsByLine.set(ln, arr);
          }
        }
      }
    })();

    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;
      const text = document.lineAt(line).text;

      // 見出し行は heading 一色
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

      // 全角スペース
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          builder.push(line, m.index, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // ダッシュ
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          const typeIdxForDash = bracketOverrideOn
            ? tokenTypesArr.indexOf("bracket")
            : tokenTypesArr.indexOf("symbol");
          builder.push(line, m.index, m[0].length, typeIdxForDash, 0);
        }
      }

      // 括弧セグメント塗り（ONの時だけ）
      if (bracketOverrideOn) {
        const segs = bracketSegsByLine.get(line);
        if (segs && segs.length) {
          for (const [sCh, eCh] of segs) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // 品詞ハイライト
      if (tokenizer && text.trim()) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const start = seg.start;
          const end = seg.end;
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          const length = end - start;

          if (bracketOverrideOn) {
            const segs = bracketSegsByLine.get(line);
            if (isInsideAnySegment(start, end, segs)) {
              continue; // 括弧色に任せる
            }
          }
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

// ---------- ここから semantic.js 末尾 追加/置換 ----------

// 重複しないよう、この _escapeHtml は “一度だけ” 残す
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * VS Code 側と同じ分類（tokenTypesArr）で <span class="pos-XXX"> を吐く（行ごと）
/**
* @param {string} text
* @param {import('vscode').ExtensionContext} context
* @param {{ maxLines?: number, headingDetector?: (line:string)=>number, classPrefix?: string, activeLine?: number }} [opts]
*/
async function toPosHtml(text, context, opts = {}) {
  const {
    maxLines = 1000,
    headingDetector,
    classPrefix = "pos-",
    activeLine = 0,
  } = opts || {};

  // 公式ルートのトークナイザを必ず使用
  await ensureTokenizer(context);

  // ===== 設定 =====
  const c = vscode.workspace.getConfiguration("posNote");
  const bracketOverrideOn = !!c.get("semantic.bracketsOverride.enabled", true);
  const headingSemanticOn = !!c.get("headings.semantic.enabled", true);

  // ===== 事前計算：全テキストを走査して括弧ペアの [startOff, endOff) を列挙 =====
  // （エディタ側の computeFullwidthQuoteRanges と同等のスタック走査をテキスト版で実装）
  const pairs = [];
  {
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
    const stack = []; // { expectedClose, openOffset }

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
          pairs.push([top.openOffset, i + 1]); // [open, close+1)
        }
      }
    }
  }

  // ===== 行配列 & 各行の開始オフセット =====
  const lines = String(text).split(/\r?\n/);
  const lineOffsets = new Array(lines.length);
  {
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = off;
      off += lines[i].length + 1; // "\n" を1文字として加算（split時に消えているため）
    }
  }

  // 行の一部文字列 s を、ダッシュだけ専用クラスで塗り分けしつつ、
  // それ以外は従来どおり品詞スパン化して連結する。
  const dashRe = /[—―]/g; // U+2014 EM DASH, U+2015 HORIZONTAL BAR
  const renderWithDash = (s) => {
    if (!s) return "";
    const out = [];
    let last = 0;
    dashRe.lastIndex = 0;
    let m;
    while ((m = dashRe.exec(s)) !== null) {
      const before = s.slice(last, m.index);
      if (before) out.push(tokenizedSpanHtml(before));
      const ch = _escapeHtml(m[0]);
      const dashClass = bracketOverrideOn ? "bracket" : "symbol";
      out.push(`<span class="${classPrefix}${dashClass}">${ch}</span>`);
      last = m.index + m[0].length;
    }
    const tail = s.slice(last);
    if (tail) out.push(tokenizedSpanHtml(tail));
    return out.join("");
  };

  // === 行ごとに HTML を構築（全行を出力。品詞解析はウィンドウ内だけ）===
  const out = [];
  const total = lines.length;
  const winStart = Math.max(0, activeLine - maxLines);
  const winEnd = Math.min(total - 1, activeLine + maxLines);
  // 互換：window 無効時は「先頭から maxLines-1 まで」を解析対象とする

  // 補助：指定文字列を品詞トークン化して <span class="pos-xxx">…</span> 羅列を返す
  const tokenizedSpanHtml = (s) => {
    if (!s) return "";
    const tokens = tokenizer.tokenize(s);
    return tokens
      .map((t) => {
        const { typeIdx } = mapKuromojiToSemantic(t);
        const typeName = tokenTypesArr[typeIdx] || "other";
        const surf = _escapeHtml(t.surface_form || "");
        return `<span class="${classPrefix}${typeName}" data-pos="${_escapeHtml(
          t.pos || ""
        )}">${surf}</span>`;
      })
      .join("");
  };

  for (let i = 0; i < total; i++) {
    const line = lines[i];

    // 空行もクリックターゲットにしたいので占位
    if (/^\s*$/.test(line)) {
      out.push(`<p class="blank" data-line="${i}">_</p>`);
      continue;
    }

    const lineStart = lineOffsets[i];
    const lineEnd = lineStart + line.length;

    // この行にかかる括弧区間を抽出（交差する分だけ切り出し）
    /** @type {[number, number][]} */ // 行内 [sCh,eCh)
    let segs = /** @type {[number, number][]} */ ([]);
    if (bracketOverrideOn && pairs.length) {
      for (const [s, e] of pairs) {
        const sCh = Math.max(0, s - lineStart);
        const eCh = Math.min(line.length, e - lineStart);
        if (eCh > 0 && sCh < line.length && eCh > sCh) {
          segs.push([sCh, eCh]);
        }
      }
      // 重なりマージ（安全のため）
      if (segs.length > 1) {
        segs.sort((a, b) => a[0] - b[0]);
        /** @type {[number, number][]} */
        const merged = [];
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

    // ★ 見出しが有効かつ見出し行なら、POS を行わず heading 一色で出す
    const isHeadingLevel =
      typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
    if (headingSemanticOn && isHeadingLevel > 0) {
      const safe = _escapeHtml(line);
      out.push(
        `<p data-line="${i}" class="heading"><span class="${classPrefix}heading">${safe}</span></p>`
      );
      continue;
    }

    // ★ ウィンドウ外：プレーン出力（括弧上書きも無視してプレーン）
    const inWindow = i >= winStart && i <= winEnd;
    if (!inWindow) {
      const safe = _escapeHtml(line);
      const isHeading =
        typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
      const pClass = isHeading ? ` class="heading"` : "";
      out.push(`<p data-line="${i}"${pClass}>${safe}</p>`);
      continue;
    }

    // 以降：ウィンドウ内は従来ロジック
    // 1) 括弧上書きが無ければ、ダッシュ分割＋品詞スパン化
    if (!(bracketOverrideOn && segs.length)) {
      const html = renderWithDash(line);
      const isHeading =
        typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
      const pClass = isHeading ? ` class="heading"` : "";
      out.push(`<p data-line="${i}"${pClass}>${html}</p>`);
      continue;
    }

    // 2) 括弧区間がある場合：区間外は品詞スパン、区間内は一括で pos-bracket にする
    let cur = 0;
    const chunks = [];
    for (const [sCh, eCh] of segs) {
      if (sCh > cur) {
        const plain = line.slice(cur, sCh);
        chunks.push(renderWithDash(plain));
      }
      const brText = _escapeHtml(line.slice(sCh, eCh));
      chunks.push(`<span class="${classPrefix}bracket">${brText}</span>`);
      cur = eCh;
    }
    if (cur < line.length) {
      chunks.push(renderWithDash(line.slice(cur)));
    }

    const isHeading =
      typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
    const pClass = isHeading ? ` class="heading"` : "";
    out.push(`<p data-line="${i}"${pClass}>${chunks.join("")}</p>`);
  }

  return out.join("");
}

// ★ exports は “一回だけ” ここでまとめる
module.exports = {
  JapaneseSemanticProvider,
  semanticLegend,
  toPosHtml,
};
