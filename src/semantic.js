// セマンティックトークン周辺（エディタ）＋プレビュー用 HTML 生成（Webview）
// 依存: CommonJS（VS Code 拡張の Node ランタイム）

/* ========================================
 * 0) Imports
 * ====================================== */
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS
const { getHeadingLevel, loadNoteSettingForDoc } = require("./utils");

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
  "space",
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
 * Node 上で一度だけビルドし、以降はキャッシュされた tokenizer を使い回す
 */
/**
 * 拡張同梱の辞書を使って kuromoji を初期化する（1回だけ）。
 * 見つからなければエラーを出して null のまま返る。
 * @param {vscode.ExtensionContext} context
 */
async function ensureTokenizer(context) {
  if (tokenizer) return;
  try {
    // 1. まず node_modules 内の kuromoji 辞書を探す（パッケージサイズ削減のため）
    let dictPath = path.join(
      context.extensionPath,
      "node_modules",
      "kuromoji",
      "dict"
    );

    // 2. 見つからなければ従来のルート直下 dict を探す（開発環境やフォールバック用）
    if (!fs.existsSync(dictPath)) {
      dictPath = path.join(context.extensionPath, "dict");
    }

    if (!fs.existsSync(dictPath)) {
      console.warn("kuromoji dictionary not found at:", dictPath);
      return;
    }
    tokenizer = await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((err, tknz) => {
        if (err) reject(err);
        else resolve(tknz);
      });
    });
  } catch (err) {
    console.error("[POSNote] ensureTokenizer failed:", err);
  }
}

/* ========================================
 * 4) 汎用ヘルパ
 * ====================================== */

// notesetting.json 専用ローダ（同一フォルダのみ）に置換
const _localDictCache = new Map(); // key: dir -> { key, chars:Set, glos:Set }

/** HTML エスケープ（最小限）。プレビュー/ツールチップの XSS 回避用。 */
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * editor.semanticTokenColorCustomizations.rules.space から色を取得する。
 * - 文字列形式ならそのまま
 * - オブジェクト形式なら:
 *    highlight: true の場合のみ color を採用
 * - 取れなければ null
 */
function _getSpaceColorFromSettings() {
  try {
    const editorCfg = vscode.workspace.getConfiguration("editor");
    const custom = editorCfg.get("semanticTokenColorCustomizations") || {};
    const rules = custom?.rules || {};
    const val = rules ? rules["space"] : null;
    if (!val) return null;
    if (typeof val === "string") return val;
    if (typeof val === "object") {
      // highlight: true の場合のみ color を返す
      if (val.highlight === true && typeof val.color === "string") {
        return val.color;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 文書の見出しブロックを (# の連なりで) 粗く特定する。
 * 戻り値: [{ start: 見出し行, end: ブロック終端行(含む) }, ...]
 * 折りたたみ推定などの基礎データに使う。
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
 *  - FoldingRangeProvider から折りたたみ候補を取得
 *  - 可視行情報 (visibleRanges) を配列化
 *  - 見出し行が visible、直下が non-visible で、候補範囲と重なるなら折りたたみ中と判定
 *
 * 戻り値: 除外すべき行区間 [{ from, to } ...]（両端含む）
 * Semantic Token の計算を省いて高速化する目的。
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
// 折りたたみ判定で重複した区間を1本にまとめる
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
// 指定した開始・終了がどれかの括弧区間に完全に含まれているか調べる
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
 * Semantic Token の除外対象を決めるために利用
 */
function computeFenceRanges(doc) {
  const ranges = [];
  let inFence = false;
  let fenceStartPos = null;
  let ignoringMarkmap = false;

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    // 行頭/行中問わず ``` を検出（単純化）
    if (text.includes("```")) {
      if (!inFence) {
        // 開始
        inFence = true;
        // markmap ならこのフェンス区間は「フェンス扱いしない（＝ハイライト有効）」
        // 言語判定: ```markmap ...
        const m = text.match(/```\s*([a-zA-Z0-9_\-\.]+)/);
        if (m && m[1] === "markmap") {
          ignoringMarkmap = true;
        } else {
          fenceStartPos = new vscode.Position(i, 0);
        }
      } else {
        // 終了
        if (!ignoringMarkmap && fenceStartPos) {
          const endPos = new vscode.Position(i, text.length);
          ranges.push(new vscode.Range(fenceStartPos, endPos));
        }
        inFence = false;
        fenceStartPos = null;
        ignoringMarkmap = false;
      }
    }
  }
  // 末尾まで閉じられなかった場合
  if (inFence && fenceStartPos && !ignoringMarkmap) {
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
// 括弧の開きと閉じを対応付け、ハイライト上書きに使う
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
// 品詞名からセマンティックトークン種別と修飾ビットを導く
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
// yield で (開始, 終了, トークン) を順に返すジェネレータ
/** 1行テキストと kuromoji トークン列から、表層形のオフセットを列挙 */
// yield で (開始, 終了, トークン) を順に返すジェネレータ
// word_position (1-based index) を使用して高速化
function* enumerateTokenOffsets(lineText, tokens) {
  for (const tk of tokens) {
    if (!tk.word_position) continue; // 念のため
    const start = tk.word_position - 1;
    const end = start + (tk.surface_form ? tk.surface_form.length : 0);
    yield { start, end, tk };
  }
}

/* ========================================
 * 5) 同一フォルダの notesetting.json を読むユーティリティ
 * ====================================== */
// 同フォルダ notesetting.json から characters/glossary を吸い上げる
async function loadWordsFromNoteSetting(source) {
  try {
    let json = null;
    if (typeof source === "string") {
      const txt = await fs.promises.readFile(source, "utf8");
      json = JSON.parse(txt);
    } else if (source && typeof source === "object") {
      json = source;
    }
    if (!json) return { chars: new Set(), glos: new Set() };

    const buildSet = (val, charMode) => {
      const put = (set, s) => {
        const v = String(s ?? "").trim();
        if (v) set.add(v);
      };
      /** @type {Set<string>} */ const out = new Set();
      if (!val) return out;

      if (Array.isArray(val)) {
        if (val.length && typeof val[0] === "string") {
          for (const s of val) put(out, s);
        } else {
          for (const it of val) {
            if (!it) continue;
            if (charMode) {
              if (it.name) put(out, it.name);
              if (Array.isArray(it.alias)) it.alias.forEach((x) => put(out, x));
            } else {
              if (it.term) put(out, it.term);
              if (Array.isArray(it.variants))
                it.variants.forEach((x) => put(out, x));
            }
          }
        }
      } else if (val && typeof val === "object") {
        for (const k of Object.keys(val)) {
          put(out, k);
          const v = val[k];
          if (charMode) {
            if (v && Array.isArray(v.alias))
              v.alias.forEach((x) => put(out, x));
          } else {
            if (v && Array.isArray(v.variants))
              v.variants.forEach((x) => put(out, x));
          }
        }
      }
      return out;
    };

    const chars = buildSet(json.characters, true);
    const glos = buildSet(json.glossary, false);
    return { chars, glos };
  } catch {
    return { chars: new Set(), glos: new Set() };
  }
}

async function loadLocalDictForDoc(docUri) {
  try {
    const dir = path.dirname(docUri.fsPath);
    const cache = _localDictCache.get(dir);

    const { data, mtimeMs } = await loadNoteSettingForDoc({ uri: docUri });
    const key = data ? `note:${mtimeMs}` : "none";

    if (cache && cache.key === key) {
      return cache.val;
    }

    // 辞書データ構築
    let chars = new Set();
    let glos = new Set();
    if (data) {
      const { chars: c, glos: g } = await loadWordsFromNoteSetting(data);
      chars = c;
      glos = g;
    }

    // 正規表現と種別マップを生成
    const needles = [];
    for (const w of chars) needles.push({ w, k: "character" });
    for (const w of glos) needles.push({ w, k: "glossary" });
    // 長い順にソート（最長一致）
    needles.sort((a, b) => b.w.length - a.w.length);

    // エスケープして結合
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = needles.map((n) => escapeRe(n.w)).join("|");
    const regex = pattern ? new RegExp(pattern, "g") : null;

    // 単語 -> 種別 のマップ（重複時は needles の順序＝chars優先）
    const kindMap = new Map();
    for (const { w, k } of needles) {
      if (!kindMap.has(w)) kindMap.set(w, k);
    }

    const val = { chars, glos, regex, kindMap };
    _localDictCache.set(dir, { key, val });
    return val;
  } catch {
    return { chars: new Set(), glos: new Set(), regex: null, kindMap: new Map() };
  }
}

/**
 * 行テキストから、辞書語の**非重複**マッチを抽出
 * - 最長一致優先 → 重複領域は先取で確定
 * - 返値: [{start, end, kind:"character"|"glossary"}]
 * 品詞ハイライトよりも優先して強調するための区間情報
 */
/**
 * 行テキストから、辞書語の**非重複**マッチを抽出
 * - RegExp を使用して高速化
 * - 返値: [{start, end, kind:"character"|"glossary"}]
 */
function matchDictRanges(lineText, regex, kindMap) {
  const res = [];
  if (!lineText || !regex) return res;

  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(lineText)) !== null) {
    const w = m[0];
    const kind = kindMap.get(w) || "other";
    res.push({ start: m.index, end: m.index + w.length, kind });
  }
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

  /** @type {Array<[number, number]>} */
  const out = [];

  for (const [as, ae] of A) {
    /** @type {Array<[number, number]>} */
    let cur = [[as, ae]];
    for (const m of mask) {
      /** @type {Array<[number, number]>} */
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
    if (!merged.length || merged[merged.length - 1][1] < seg[0]) {
      merged.push(seg);
    } else {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        seg[1]
      );
    }
  }
  return merged;
}

/* ========================================
 * 6) エディタ側 Semantic Provider
 * ====================================== */
// VS Code の SemanticTokensProvider を実装し、品詞ハイライトを供給する
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

    // JapaneseSemanticProvider constructor 内の監視登録
    const wNote = vscode.workspace.createFileSystemWatcher(
      "**/notesetting.json"
    );
    const fire = () => this._onDidChangeSemanticTokens.fire();
    context.subscriptions.push(
      wNote.onDidCreate(fire),
      wNote.onDidChange(fire),
      wNote.onDidDelete(fire)
    );

    // space 背景ハイライト用
    this._spaceDecoration = null;
    this._spaceColor = null;
    this._spaceRangesByDoc = new Map(); // key: docUri -> vscode.Range[]

    // <br> Highlight (Red)
    this._brDecoration = null;
    this._brRangesByDoc = new Map();
    this._brHighlightEnabled = false; // Default OFF

    // Command to toggle BR highlight
    context.subscriptions.push(
      vscode.commands.registerCommand("posNote.semantic.setBrHighlight", (enabled) => {
        this._brHighlightEnabled = !!enabled;
        this._onDidChangeSemanticTokens.fire();

        // If disabled, explicitly clear decorations for all visible editors
        if (!this._brHighlightEnabled) {
             for (const ed of vscode.window.visibleTextEditors) {
               const key = ed.document.uri.toString();
               this._brRangesByDoc.set(key, []);
               if (this._brDecoration) ed.setDecorations(this._brDecoration, []);
             }
        }
      })
    );

    // トークンキャッシュ (行単位)
    this._tokenCache = new Map(); // key: docUri -> Map<lineIndex, { text: string, tokens: any[] }>

    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this._spaceRangesByDoc.delete(doc.uri.toString());
        this._tokenCache.delete(doc.uri.toString());
        this._brRangesByDoc.delete(doc.uri.toString());
      })
    );
  }

  // space 用の背景ハイライトを、設定色に合わせて生成・更新する
  _ensureSpaceDecoration() {
    const color = _getSpaceColorFromSettings();
    if (!color) {
      if (this._spaceDecoration) {
        this._spaceDecoration.dispose(); // dispose で既存描画も消す
      }
      this._spaceDecoration = null;
      this._spaceColor = null;
      this._spaceRangesByDoc.clear();
      return null;
    }

    if (this._spaceDecoration && this._spaceColor === color) {
      return this._spaceDecoration;
    }

    if (this._spaceDecoration) {
      this._spaceDecoration.dispose();
    }

    this._spaceDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color,
      borderRadius: "2px",
    });
    this._spaceColor = color;
    return this._spaceDecoration;
  }

  /**
   * space の背景ハイライトを適用する（部分更新対応）
   * @param {import("vscode").TextDocument} document
   * @param {number} fromLine
   * @param {number} toLine
   * @param {import("vscode").Range[]} rangesForWindow
   */
  _applySpaceDecorations(document, fromLine, toLine, rangesForWindow) {
    const deco = this._ensureSpaceDecoration();
    if (!deco) return;

    const key = document.uri.toString();
    const prev = this._spaceRangesByDoc.get(key) || [];
    const kept = prev.filter(
      (r) => r.start.line < fromLine || r.start.line > toLine
    );
    const next = kept.concat(rangesForWindow);
    this._spaceRangesByDoc.set(key, next);

    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document === document) {
        ed.setDecorations(deco, next);
      }
    }
  }

  // <br> 用の赤色ハイライト
  _ensureBrDecoration() {
    if (this._brDecoration) return this._brDecoration;
    this._brDecoration = vscode.window.createTextEditorDecorationType({
      color: "#ff0000", // 文字色を赤に固定
      fontWeight: "bold"
      // backgroundColor: ... 必要なら
    });
    return this._brDecoration;
  }

  _applyBrDecorations(document, fromLine, toLine, rangesForWindow) {
    const deco = this._ensureBrDecoration();
    const key = document.uri.toString();
    const prev = this._brRangesByDoc.get(key) || [];
    const kept = prev.filter(
      (r) => r.start.line < fromLine || r.start.line > toLine
    );
    const next = kept.concat(rangesForWindow);
    this._brRangesByDoc.set(key, next);

    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document === document) {
        ed.setDecorations(deco, next);
      }
    }
  }

  // VS Code に渡す SemanticTokensLegend を返す
  _legend() {
    return semanticLegend;
  }

  // 外部から呼び出し、セマンティックトークンの再発行を促す
  fireDidChange() {
    this._onDidChangeSemanticTokens.fire();
  }

  /**
   * ドキュメントごとの計算結果キャッシュを取得または生成する
   * @param {import("vscode").TextDocument} document
   * @returns {{ fenceRanges: import("vscode").Range[], bracketSegsByLine: Map<number, Array<[number, number]>> }}
   */
  _getOrComputeRanges(document) {
    // キャッシュ初期化
    if (!this._cache) {
      /** @type {Map<string, { version: number, data: any }>} */
      this._cache = new Map();
    }

    const key = document.uri.toString();
    const cached = this._cache.get(key);

    // バージョンが一致すればキャッシュを返す
    if (cached && cached.version === document.version) {
      return cached.data;
    }

    // 計算実行（全文スキャン）
    const fenceRanges = computeFenceRanges(document);

    /** @type {Map<number, Array<[number, number]>>} */
    const bracketSegsByLine = new Map();

    // 括弧計算
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

    const data = { fenceRanges, bracketSegsByLine };

    // キャッシュ保存
    this._cache.set(key, { version: document.version, data });

    // 古いキャッシュの掃除（簡易的：エントリ数が多すぎたらクリア）
    if (this._cache.size > 20) {
      this._cache.clear();
      this._cache.set(key, { version: document.version, data });
    }

    return data;
  }

  // semantic.js 内 JapaneseSemanticProvider クラス
  // 指定範囲のテキストを解析し、セマンティックトークンデータを構築する本体
  async _buildTokens(document, range, cancelToken) {
    const c = this._cfg();

    /** @type {RegExp|null} */
    let dictRegex = null;
    /** @type {Map<string, string>} */
    let dictKindMap = new Map();

    const noteLoaded = await loadLocalDictForDoc(document.uri);
    if (noteLoaded) {
      dictRegex = noteLoaded.regex;
      dictKindMap = noteLoaded.kindMap;
    }

    // 以降、既存の有効/無効判定やトークン生成ロジックはそのまま
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
    const idxFence = tokenTypesArr.indexOf("fencecomment");

    // ★ キャッシュを利用して取得
    const { fenceRanges, bracketSegsByLine } = this._getOrComputeRanges(document);

    /** @type {Map<number, Array<[number, number]>>} */
    const fenceSegsByLine = new Map();
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;

    try {
      // fenceRanges はキャッシュ済みだが、行ごとのセグメントマップはここで作る（軽量）
      // ※ ここもキャッシュに含めても良いが、fenceRanges自体が軽量なのでこのままでもOK
      //    ただし、fenceSegsByLine もキャッシュした方がより高速。
      //    今回は _getOrComputeRanges で bracketSegsByLine は作ったが、
      //    fenceSegsByLine は作っていないのでここで作る。

      for (const r of fenceRanges) {
        const sL = r.start.line,
          eL = r.end.line;
        // 画面内（range）に関係ある部分だけ処理すればさらに高速だが、
        // fenceRanges の数が少なければループしても問題ない。
        // ここでは単純化のため全フェンスを処理するが、
        // 将来的には range と重なるものだけフィルタしてもよい。

        for (let ln = sL; ln <= eL; ln++) {
          // 範囲外の行はスキップ（これが重要）
          if (ln < startLine || ln > endLine) continue;

          const lineText = document.lineAt(ln).text;
          const sCh = ln === sL ? r.start.character : 0;
          const eCh = ln === eL ? r.end.character : lineText.length;
          if (eCh > sCh) {
            const arr = fenceSegsByLine.get(ln) || [];
            arr.push([sCh, eCh]); // [開始, 終了)
            fenceSegsByLine.set(ln, arr);
          }
        }
      }
    } catch {
      // 失敗時は空のままで続行
    }

    // ★ ループは一つに統一（ネストしていた二重ループを削除）
    /** @type {import("vscode").Range[]} */
    const spaceDecoRanges = [];
    /** @type {import("vscode").Range[]} */
    const brDecoRanges = [];
    let processedFrom = null;
    let processedTo = null;

    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;

      if (processedFrom === null) processedFrom = line;
      processedTo = line;

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

      // <br> highlight (Simple string match, override everything logic implicitly because it's a decoration)
      if (this._brHighlightEnabled) {
        const brRe = /<br>/gi;
        let mBr;
        while ((mBr = brRe.exec(text)) !== null) {
          brDecoRanges.push(
            new vscode.Range(line, mBr.index, line, mBr.index + mBr[0].length)
          );
        }
      }

      // ▼ (0) フェンスブロック：最優先で塗って、以降の処理を“その区間だけ”スキップ
      const fenceSegs = /** @type {Array<[number, number]>} */ (
        fenceSegsByLine.get(line) || []
      );
      // 辞書が存在しても、フェンス内は辞書やPOSを出さない（完全除外）
      const isMd = (document.languageId || "").toLowerCase() === "markdown";
      for (const [sCh, eCh] of fenceSegs) {
        const len = eCh - sCh;
        if (len > 0 && !isMd) builder.push(line, sCh, len, idxFence, 0);
      }

      // 以降の処理は「フェンスに重ならない残り部分」だけに適用する
      const restForLine = (segments) =>
        subtractMaskedIntervals(
          [[0, text.length]],
          segments.map(([s, e]) => ({ start: s, end: e }))
        );
      const nonFenceSpans = restForLine(fenceSegs);

      // ▼ (1) ローカル辞書マッチ（最優先）
      // ▼ (1) ローカル辞書マッチ（最優先）
      const dictRanges = matchDictRanges(text, dictRegex, dictKindMap);

      // (B) 「辞書マスク」もフェンス外に限定して作成
      const dictRangesOutsideFence = subtractMaskedIntervals(
        dictRanges.map((r) => [r.start, r.end]),
        fenceSegs.map(([s, e]) => ({ start: s, end: e }))
      ).map(([s, e]) => ({ start: s, end: e }));

      // push: character/glossary（フェンス内は除外）
      for (const r of dictRanges) {
        if (isInsideAnySegment(r.start, r.end, fenceSegs)) continue;
        const typeIdx = r.kind === "character" ? idxChar : idxGlossary;
        builder.push(line, r.start, r.end - r.start, typeIdx, 0);
      }

      const mask = dictRangesOutsideFence;
      const spansAfterDict = subtractMaskedIntervals(nonFenceSpans, mask);

      // (space)
      /** @type {Array<[number, number]>} */
      const spaceRanges = [];
      {
        // 半角スペース：2つセットはインデント扱いで非ハイライト。奇数個の余りだけ塗る。
        const reHalf = / +/g;
        let mHalf;
        while ((mHalf = reHalf.exec(text)) !== null) {
          const runStart = mHalf.index;
          const runLen = mHalf[0].length;
          // 余りが1のときだけ最後の1文字をハイライト対象にする
          if (runLen % 2 === 1) {
            const s = runStart + runLen - 1;
            const e = s + 1;
            if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
              spaceRanges.push([s, e]); // 括弧上書きから外すためのマスク
              spaceDecoRanges.push(
                new vscode.Range(
                  new vscode.Position(line, s),
                  new vscode.Position(line, e)
                )
              );
            }
          }
        }

        // 全角スペース：従来通り1文字ごとにハイライト
        const reFull = /　/g;
        let mFull;
        while ((mFull = reFull.exec(text)) !== null) {
          const s = mFull.index;
          const e = s + 1;
          if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
            spaceRanges.push([s, e]); // 括弧上書きから外すためのマスク
            spaceDecoRanges.push(
              new vscode.Range(
                new vscode.Position(line, s),
                new vscode.Position(line, e)
              )
            );
          }
        }
      }

      // (ダッシュ) ※括弧優先: 括弧内では強制色を出さない
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          const s = m.index,
            e = s + m[0].length;
          if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
            // ▲ 括弧内はスキップ（括弧色で統一したい）
            const segs = /** @type {Array<[number, number]>} */ (
              bracketSegsByLine.get(line) || []
            );
            const inBracket = isInsideAnySegment(s, e, segs);
            if (inBracket) continue;
            const tIdx = bracketOverrideOn
              ? idxBracket
              : tokenTypesArr.indexOf("symbol");
            builder.push(line, s, e - s, tIdx, 0);
          }
        }
      }

      // (括弧上書き)：辞書 + fwspace を差し引く
      if (bracketOverrideOn) {
        const segs = bracketSegsByLine.get(line);
        if (segs?.length) {
          const segsOutsideFence = subtractMaskedIntervals(
            segs,
            fenceSegs.map(([s, e]) => ({ start: s, end: e }))
          );
          // ★追加：space も括弧上書きから除外
          const maskForBracket = dictRangesOutsideFence.concat(
            spaceRanges.map(([s, e]) => ({ start: s, end: e }))
          );
          const rest = subtractMaskedIntervals(
            segsOutsideFence,
            maskForBracket
          );
          for (const [sCh, eCh] of rest) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // ▼ (3) 品詞ハイライト（辞書マスクに重なるトークンは出さない）
      if (tokenizer && text.trim()) {
        // キャッシュ確認
        const docKey = document.uri.toString();
        let docCache = this._tokenCache.get(docKey);
        if (!docCache) {
          docCache = new Map();
          this._tokenCache.set(docKey, docCache);
        }

        let tokens;
        const cachedLine = docCache.get(line);
        if (cachedLine && cachedLine.text === text) {
          tokens = cachedLine.tokens;
        } else {
          tokens = tokenizer.tokenize(text);
          docCache.set(line, { text, tokens });
          // 簡易的なキャッシュサイズ制限（行数が多すぎたらクリア）
          if (docCache.size > 5000) docCache.clear();
        }

        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const start = seg.start,
            end = seg.end;
          const length = end - start;

          // フェンス内ならスキップ
          if (fenceSegs && fenceSegs.length > 0) {
            let inFence = false;
            for (const [fs, fe] of fenceSegs) {
              if (start >= fs && end <= fe) {
                inFence = true;
                break;
              }
            }
            if (inFence) continue;
          }

          // 辞書マスクとの重なりチェック
          if (dictRanges.some((R) => !(end <= R.start || R.end <= start)))
            continue;

          // 括弧上書きがONなら、括弧区間はPOSを出さない（ただし辞書は既に出している）
          if (bracketOverrideOn) {
            const segs = bracketSegsByLine.get(line);
            if (isInsideAnySegment(start, end, segs)) continue;
          }
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          builder.push(line, start, length, typeIdx, mods);
        }
      }
    }

    if (processedFrom !== null && processedTo !== null) {
      this._applySpaceDecorations(
        document,
        processedFrom,
        processedTo,
        spaceDecoRanges
      );
      this._applyBrDecorations(
        document,
        processedFrom,
        processedTo,
        brDecoRanges
      );
    }

    return builder.build();
  }

  // ドキュメント全体のセマンティックトークンを生成
  async provideDocumentSemanticTokens(document, token) {
    try {
      if (token?.isCancellationRequested) {
        return new vscode.SemanticTokens(new Uint32Array());
      }
      const fullRange = new vscode.Range(
        0,
        0,
        document.lineCount - 1,
        document.lineAt(Math.max(0, document.lineCount - 1)).text.length
      );
      return await this._buildTokens(document, fullRange, token);
    } catch (err) {
      console.error("[POSNote] provideDocumentSemanticTokens error:", err);
      return new vscode.SemanticTokens(new Uint32Array());
    }
  }

  // ドキュメントの一部範囲のみセマンティックトークンを生成
  async provideDocumentRangeSemanticTokens(document, range, token) {
    try {
      if (token?.isCancellationRequested) {
        return new vscode.SemanticTokens(new Uint32Array());
      }
      return await this._buildTokens(document, range, token);
    } catch (err) {
      console.error("[POSNote] provideDocumentRangeSemanticTokens error:", err);
      return new vscode.SemanticTokens(new Uint32Array());
    }
  }
}

/* ========================================
 * 9) Exports
 * ====================================== */
module.exports = {
  JapaneseSemanticProvider,
  semanticLegend,
  tokenTypesArr,
};
