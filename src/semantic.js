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
 * Node 上で一度だけビルドし、以降はキャッシュされた tokenizer を使い回す
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

// ★ notesetting.json 専用ローダ（同一フォルダのみ）に置換
const _localDictCache = new Map(); // key: dir -> { key, chars:Set, glos:Set }

/** HTML エスケープ（最小限） */
// プレビューやツールチップ内での XSS を避けるため最低限の文字を置換する
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * editor.semanticTokenColorCustomizations.rules.fwspace から色を取得する。
 * - 文字列形式ならそのまま
 * - オブジェクト形式なら foreground を採用
 * - 取れなければ null
 */
function _getFwspaceColorFromSettings() {
  try {
    const editorCfg = vscode.workspace.getConfiguration("editor");
    const custom = editorCfg.get("semanticTokenColorCustomizations") || {};
    const rules = custom?.rules || {};
    const val = rules ? rules["fwspace"] : null;
    if (!val) return null;
    if (typeof val === "string") return val;
    if (typeof val === "object" && typeof val.foreground === "string") {
      return val.foreground;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 文書の見出しブロックを (# の連なりで) 粗く特定する。
 * 戻り値: [{ start: 見出し行, end: ブロック終端行(含む) }, ...]
 * 折りたたみ推定などで基礎データとして使用
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
 * Semantic Token の計算を省いて高速化する目的
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
      return { chars: cache.chars, glos: cache.glos };
    }

    if (!data) {
      const val = { key, chars: new Set(), glos: new Set() };
      _localDictCache.set(dir, val);
      return { chars: val.chars, glos: val.glos };
    }

    const { chars, glos } = await loadWordsFromNoteSetting(data);
    const val = { key, chars, glos };
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
 * 品詞ハイライトよりも優先して強調するための区間情報
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

    // fwspace 背景ハイライト用
    this._fwspaceDecoration = null;
    this._fwspaceColor = null;
    this._fwspaceRangesByDoc = new Map(); // key: docUri -> vscode.Range[]
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this._fwspaceRangesByDoc.delete(doc.uri.toString());
      })
    );
  }

  // fwspace 用の背景ハイライトを、設定色に合わせて生成・更新する
  _ensureFwspaceDecoration() {
    const color = _getFwspaceColorFromSettings();
    if (!color) {
      if (this._fwspaceDecoration) {
        this._fwspaceDecoration.dispose(); // dispose で既存描画も消す
      }
      this._fwspaceDecoration = null;
      this._fwspaceColor = null;
      this._fwspaceRangesByDoc.clear();
      return null;
    }

    if (this._fwspaceDecoration && this._fwspaceColor === color) {
      return this._fwspaceDecoration;
    }

    if (this._fwspaceDecoration) {
      this._fwspaceDecoration.dispose();
    }

    this._fwspaceDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color,
      borderRadius: "2px",
    });
    this._fwspaceColor = color;
    return this._fwspaceDecoration;
  }

  /**
   * fwspace の背景ハイライトを適用する（部分更新対応）
   * @param {import("vscode").TextDocument} document
   * @param {number} fromLine
   * @param {number} toLine
   * @param {import("vscode").Range[]} rangesForWindow
   */
  _applyFwspaceDecorations(document, fromLine, toLine, rangesForWindow) {
    const deco = this._ensureFwspaceDecoration();
    if (!deco) return;

    const key = document.uri.toString();
    const prev = this._fwspaceRangesByDoc.get(key) || [];
    const kept = prev.filter(
      (r) => r.start.line < fromLine || r.start.line > toLine
    );
    const next = kept.concat(rangesForWindow);
    this._fwspaceRangesByDoc.set(key, next);

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

  // semantic.js 内 JapaneseSemanticProvider クラス
  // 指定範囲のテキストを解析し、セマンティックトークンデータを構築する本体
  async _buildTokens(document, range, cancelToken) {
    const c = this._cfg();

    /** @type {Set<string>} */
    let charWords = new Set();
    /** @type {Set<string>} */
    let gloWords = new Set();

    const noteLoaded = await loadNoteSettingForDoc(document);
    if (noteLoaded?.data) {
      const r = await loadWordsFromNoteSetting(noteLoaded.data);
      charWords = r.chars;
      gloWords = r.glos;
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
    /** @type {Map<number, Array<[number, number]>>} */
    const fenceSegsByLine = new Map();

    /** @type {Map<number, Array<[number, number]>>} */
    const bracketSegsByLine = new Map();
    const bracketOverrideOn = !!c.bracketsOverrideEnabled;

    try {
      const fenceRanges = computeFenceRanges(document); // vscode.Range[]
      for (const r of fenceRanges) {
        const sL = r.start.line,
          eL = r.end.line;
        for (let ln = sL; ln <= eL; ln++) {
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
    /** @type {import("vscode").Range[]} */
    const fwspaceDecoRanges = [];
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

      // ▼ (0) フェンスブロック：最優先で塗って、以降の処理を“その区間だけ”スキップ
      const fenceSegs = /** @type {Array<[number, number]>} */ (
        fenceSegsByLine.get(line) || []
      );
      // 辞書が存在しても、フェンス内は辞書やPOSを出さない（完全除外）
      for (const [sCh, eCh] of fenceSegs) {
        const len = eCh - sCh;
        if (len > 0) builder.push(line, sCh, len, idxFence, 0);
      }

      // 以降の処理は「フェンスに重ならない残り部分」だけに適用する
      const restForLine = (segments) =>
        subtractMaskedIntervals(
          [[0, text.length]],
          segments.map(([s, e]) => ({ start: s, end: e }))
        );
      const nonFenceSpans = restForLine(fenceSegs);

      // ▼ (1) ローカル辞書マッチ（最優先）
      const dictRanges =
        charWords.size || gloWords.size
          ? matchDictRanges(text, charWords, gloWords)
          : [];

      // (B) 「辞書マスク」もフェンス外に限定して作成
      const dictRangesOutsideFence = subtractMaskedIntervals(
        dictRanges.map((r) => [r.start, r.end]),
        fenceSegs.map(([s, e]) => ({ start: s, end: e }))
      ).map(([s, e]) => ({ start: s, end: e }));

      // push: character/glossary（既存のまま）
      for (const r of dictRanges) {
        const typeIdx = r.kind === "character" ? idxChar : idxGlossary;
        builder.push(line, r.start, r.end - r.start, typeIdx, 0);
      }

      const mask = dictRangesOutsideFence;
      const spansAfterDict = subtractMaskedIntervals(nonFenceSpans, mask);

      // (fwspace)
      /** @type {Array<[number, number]>} */
      const fwspaceRanges = [];
      {
        const re = /[ 　]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const s = m.index,
            e = s + 1;
          if (spansAfterDict.some(([S, E]) => s >= S && e <= E)) {
            fwspaceRanges.push([s, e]); //括弧上書きから外すためのマスク
            fwspaceDecoRanges.push(
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
          // ★追加：fwspace も括弧上書きから除外
          const maskForBracket = dictRangesOutsideFence.concat(
            fwspaceRanges.map(([s, e]) => ({ start: s, end: e }))
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
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const start = seg.start,
            end = seg.end;
          const length = end - start;

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
      this._applyFwspaceDecorations(
        document,
        processedFrom,
        processedTo,
        fwspaceDecoRanges
      );
    }

    return builder.build();
  }

  // ドキュメント全体のセマンティックトークンを生成
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

  // ドキュメントの一部範囲のみセマンティックトークンを生成
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
 * プレビュー側でコードフェンスをまとめて別色に塗るための下準備
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
 * 既存の行単位 HTML を尊重しながらフェンス色だけ追加する
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
    const html = out.join("");
    return applyFenceColorToParagraphHtml(html, text);
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

    // 見出し一色（既存）
    const headLv =
      typeof headingDetector === "function" ? headingDetector(line) || 0 : 0;
    if (headingSemanticOn && headLv > 0) {
      const safe = escapeHtml(line);
      out.push(
        `<p data-line="${i}" class="heading"><span class="${classPrefix}heading">${safe}</span></p>`
      );
      continue;
    }

    // ウィンドウ外はプレーン（既存）
    const inWindow = i >= winStart && i <= winEnd;
    if (!inWindow) {
      out.push(`<p data-line="${i}">${escapeHtml(line)}</p>`);
      continue;
    }

    const lineStart = lineOffsets[i];

    // === ここからフェンス分割を厳密運用 ===
    const fenceSegs = /** @type {Array<[number, number]>} */ (
      fenceSegsByLine.get(i) || []
    )
      .slice()
      .sort((a, b) => a[0] - b[0]);

    // 行を [非フェンス] と [フェンス] に分割した配列を作る
    /** @type {Array<{s:number,e:number,isFence:boolean}>} */
    const segments = [];
    {
      let cur = 0;
      for (const [s, e] of fenceSegs) {
        if (cur < s) segments.push({ s: cur, e: s, isFence: false });
        segments.push({ s, e, isFence: true });
        cur = e;
      }
      if (cur < line.length)
        segments.push({ s: cur, e: line.length, isFence: false });
    }

    // 行内 括弧セグメント（既存ロジック）
    /** @type {Array<[number, number]>} */ let parenSegs = [];
    if (bracketOverrideOn && pairs.length) {
      for (const [s, e] of pairs) {
        const sCh = Math.max(0, s - lineStart);
        const eCh = Math.min(line.length, e - lineStart);
        if (eCh > 0 && sCh < line.length && eCh > sCh)
          parenSegs.push([sCh, eCh]);
      }
      if (parenSegs.length > 1) {
        parenSegs.sort((a, b) => a[0] - b[0]);
        const merged = /** @type {Array<[number, number]>} */ ([]);
        let [cs, ce] = parenSegs[0];
        for (let k = 1; k < parenSegs.length; k++) {
          const [ns, ne] = parenSegs[k];
          if (ns <= ce) ce = Math.max(ce, ne);
          else {
            merged.push([cs, ce]);
            cs = ns;
            ce = ne;
          }
        }
        merged.push([cs, ce]);
        parenSegs = merged;
      }
    }

    // 同フォルダ辞書マッチ（既存）
    const dictRanges =
      charWords.size || gloWords.size
        ? matchDictRanges(line, charWords, gloWords)
        : [];

    // === ここから描画 ===
    const chunks = [];

    for (const seg of segments) {
      const segText = line.slice(seg.s, seg.e);

      if (seg.isFence) {
        // フェンス部分：コメント色のみ。辞書・括弧・POS は適用しない
        const inner = escapeHtml(segText);
        chunks.push(`<span class="${classPrefix}fencecomment">${inner}</span>`);
        continue;
      }

      // 非フェンス部分：辞書→括弧→POS の順で「この区間に限って」適用
      // 1) この区間に入っている辞書マークを抽出
      const dictMarks = [];
      for (const r of dictRanges) {
        const s = Math.max(seg.s, r.start);
        const e = Math.min(seg.e, r.end);
        if (e > s) {
          dictMarks.push({
            s,
            e,
            cls: r.kind === "character" ? "character" : "glossary",
          });
        }
      }

      // 2) 括弧（上書きON時）は辞書に重ならない残りだけ
      let bracketMarks = [];
      if (bracketOverrideOn && parenSegs.length) {
        /** @type {Array<[number, number]>} */
        const parenInSeg = parenSegs
          .map(
            ([s, e]) =>
              /** @type {[number, number]} */ ([
                Math.max(seg.s, s),
                Math.min(seg.e, e),
              ])
          )
          .filter(([s, e]) => e > s);

        const dictMaskInSeg = dictMarks.map((m) => ({ start: m.s, end: m.e }));
        const rest = subtractMaskedIntervals(parenInSeg, dictMaskInSeg);

        bracketMarks = rest.map(([s, e]) => ({ s, e, cls: "bracket" }));
      }

      // 3) マーク（辞書 + 括弧）を左→右に統合
      const marks = dictMarks.concat(bracketMarks).sort((a, b) => a.s - b.s);

      // 4) マークの“間”を POS で塗る（既存関数を活用）
      let cur = seg.s;
      for (const m of marks) {
        if (m.s > cur) {
          const before = line.slice(cur, m.s);
          chunks.push(renderWithDash(before)); // ← tokenizedSpanHtml 内で kuromoji 適用
        }
        const inner = escapeHtml(line.slice(m.s, m.e));
        chunks.push(`<span class="${classPrefix}${m.cls}">${inner}</span>`);
        cur = m.e;
      }
      if (cur < seg.e) {
        chunks.push(renderWithDash(line.slice(cur, seg.e)));
      }
    }

    out.push(`<p data-line="${i}">${chunks.join("")}</p>`);
  }

  const html = out.join("");
  return html;
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
// エディタのセマンティックトークン配色設定をプレビュー CSS に落とし込む
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
