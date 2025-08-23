// ===========================================
//  日本語 品詞ハイライト（Semantic）＋ページカウンタ
//  - kuromoji: 形態素解析（行単位）→ Semantic Tokens で着色
//  - ページカウンタ: 原稿用紙風（行×列 + 禁則）をステータスバー表示
//  - パフォーマンス: 入力中は UI だけ軽く更新、重い再計算はアイドル時/保存時
// ===========================================

// ===== 1) imports =====
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS
const { initStatusBar } = require("./status_bar");
const { initHeadingSidebar } = require("./sidebar_headings"); // ★ 追加

// ===== 1-1) セマンティック定義・固定定数 =====
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

const DEFAULT_BANNED_START = [
  "」",
  "）",
  "『",
  "』",
  "》",
  "】",
  "。",
  "、",
  "’",
  "”",
  "！",
  "？",
  "…",
  "—",
  "―",
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゃ",
  "ゅ",
  "ょ",
  "っ",
  "ー",
  "々",
  "ゞ",
  "ゝ",
  "ァ",
  "ィ",
  "ゥ",
  "ェ",
  "ォ",
  "ャ",
  "ュ",
  "ョ",
  "ッ",
];

// 全角の開き括弧 → 閉じ括弧
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

// 入力補助フラグ
let _insertingFwClose = false; // 再入防止（自動クローズ）
const _prevTextByUri = new Map(); // Backspace用、直前スナップショット
let _deletingPair = false; // 再入防止（Backspaceペア削除）

// ===== 2) state =====
let tokenizer = null; // kuromoji tokenizer
// status_bar の公開APIを保持（activateでセット）
let _sb = null;

// 全折/全展開のトグル状態（docごと）
let foldToggledByDoc = new Map(); // key: uriString, value: boolean（true=折りたたみ中）
let foldDocVersionAtFold = new Map(); // key: uri, value: document.version

// ===== 3) 設定ヘルパ =====
function getBannedStart() {
  const config = vscode.workspace.getConfiguration("posNote");
  const userValue = config.get("kinsoku.bannedStart");
  return Array.isArray(userValue) && userValue.length > 0
    ? userValue
    : DEFAULT_BANNED_START;
}

function cfg() {
  const c = vscode.workspace.getConfiguration("posNote");
  return {
    semanticEnabled: c.get("semantic.enabled", true),
    semanticEnabledMd: c.get("semantic.enabledMd", true),
    applyToTxtOnly: c.get("applyToTxtOnly", true),
    debounceMs: c.get("debounceMs", 500), // 軽いUI更新
    recomputeIdleMs: c.get("recomputeIdleMs", 1000), // 重い再計算
    enabledNote: c.get("enabledNote", true),
    showSelectedChars: c.get("status.showSelectedChars", true),
    countSpaces: c.get("status.countSpaces", false),
    showDeltaFromHEAD: c.get("aggregate.showDeltaFromHEAD", true),
    rowsPerNote: c.get("Note.rowsPerNote", 20),
    colsPerRow: c.get("Note.colsPerRow", 20),
    kinsokuEnabled: c.get("kinsoku.enabled", true),
    kinsokuBanned: getBannedStart(), // settings.json 優先
    headingFoldEnabled: c.get("headings.folding.enabled", true),
    headingSemanticEnabled: c.get("headings.semantic.enabled", true),
    headingFoldMinLevel: c.get("headings.foldMinLevel", 2),
  };
}

// 対象ドキュメント判定
function isTargetDoc(doc, c) {
  if (!doc) return false;
  if (!c.applyToTxtOnly) return true;

  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isPlain = lang === "plaintext" || fsPath.endsWith(".txt");
  const isMd = lang === "markdown" || fsPath.endsWith(".md");
  const isNovel = lang === "novel"; // Novel拡張互換

  return isPlain || isMd || isNovel;
}

// ===== 4) tokenizer loader =====
async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict"); // 拡張直下の dict/
  console.log("[pos-Note] dict path:", dictPath);
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

// ===== 5) 全角括弧ユーティリティ（レンジ検出 & 入力補助） =====

// ドキュメント全文を走査し、全角括弧の「開き」〜「対応する閉じ」までの Range[] を収集
function computeFullwidthQuoteRanges(doc) {
  const text = doc.getText(); // UTF-16
  const ranges = [];
  const stack = []; // { openChar, expectedClose, openOffset }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // 開き？
    const close = FW_BRACKET_MAP.get(ch);
    if (close) {
      stack.push({ openChar: ch, expectedClose: close, openOffset: i });
      continue;
    }
    // 閉じ？
    if (FW_CLOSE_SET.has(ch)) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (ch === top.expectedClose) {
          // 対応 → 範囲確定
          stack.pop();
          const startPos = doc.positionAt(top.openOffset);
          const endPos = doc.positionAt(i + 1); // 閉じを含む
          ranges.push(new vscode.Range(startPos, endPos));
        }
      }
      // 孤立した閉じは無視
    }
  }
  // 未閉じは追加しない
  return ranges;
}

// 開き入力直後に閉じを補完し、キャレットを内側へ
function maybeAutoCloseFullwidthBracket(e) {
  try {
    if (_insertingFwClose) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const c = cfg();
    if (!isTargetDoc(ed.document, c)) return;
    if (e.document !== ed.document) return;
    if (!e.contentChanges || e.contentChanges.length !== 1) return;

    const chg = e.contentChanges[0];
    const isSingleCharText =
      typeof chg.text === "string" && chg.text.length === 1;

    // Case 1: 挿入
    if (chg.rangeLength === 0 && isSingleCharText) {
      const open = chg.text;
      const close = FW_BRACKET_MAP.get(open);
      if (!close) return;

      const posAfterOpen = chg.range.start.translate(0, 1);
      _insertingFwClose = true;
      ed.edit((builder) => {
        builder.insert(posAfterOpen, close);
      })
        .then((ok) => {
          if (!ok) return;
          const sel = new vscode.Selection(posAfterOpen, posAfterOpen);
          ed.selections = [sel];
        })
        .then(
          () => {
            _insertingFwClose = false;
          },
          () => {
            _insertingFwClose = false;
          }
        );
      return;
    }

    // Case 2: 1文字置換（例: 「 に変換）
    if (chg.rangeLength === 1 && isSingleCharText) {
      const newOpen = chg.text;
      const newClose = FW_BRACKET_MAP.get(newOpen);
      if (!newClose) return;

      const posAfterOpen = chg.range.start.translate(0, 1);
      const nextCharRange = new vscode.Range(
        posAfterOpen,
        posAfterOpen.translate(0, 1)
      );
      const nextChar = ed.document.getText(nextCharRange);

      if (FW_CLOSE_SET.has(nextChar) && nextChar !== newClose) {
        _insertingFwClose = true;
        ed.edit((builder) => {
          builder.replace(nextCharRange, newClose);
        }).then(
          () => {
            _insertingFwClose = false;
          },
          () => {
            _insertingFwClose = false;
          }
        );
      }
    }
  } catch {
    _insertingFwClose = false;
  }
}

// Backspaceで開きを消した直後、直後の閉じが対応ペアなら同時削除
function maybeDeleteClosingOnBackspace(e) {
  try {
    if (_deletingPair) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || e.document !== ed.document) return;
    if (!e.contentChanges || e.contentChanges.length !== 1) return;

    const chg = e.contentChanges[0];
    if (!(chg.rangeLength === 1 && chg.text === "")) return; // Backspace（左削除）のみ

    // 変更前全文から削除1文字を復元
    const uriKey = e.document.uri.toString();
    const prevText = _prevTextByUri.get(uriKey);
    if (typeof prevText !== "string") return;

    const off = chg.rangeOffset;
    const removed = prevText.substring(off, off + chg.rangeLength);
    if (!FW_BRACKET_MAP.has(removed)) return; // 開き以外は対象外

    const expectedClose = FW_BRACKET_MAP.get(removed);
    const pos = chg.range.start;
    const nextRange = new vscode.Range(pos, pos.translate(0, 1));
    const nextChar = e.document.getText(nextRange);

    if (nextChar !== expectedClose) return;

    _deletingPair = true;
    ed.edit((builder) => builder.delete(nextRange)).then(
      () => {
        _deletingPair = false;
      },
      () => {
        _deletingPair = false;
      }
    );
  } catch {
    _deletingPair = false;
  }
}

// ===== 6) コマンド実装=====
// 見出しの“全折/全展開”トグル（.txt / novel）
async function cmdToggleFoldAllHeadings() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const c = cfg();
  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel")) {
    vscode.window.showInformationMessage(
      "このトグルは .txt / novel でのみ有効です"
    );
    return;
  }
  if (!c.headingFoldEnabled) {
    vscode.window.showInformationMessage(
      "見出しの折りたたみ機能が無効です（posNote.headings.folding.enabled）"
    );
    return;
  }

  const key = ed.document.uri.toString();
  const lastStateFolded = foldToggledByDoc.get(key) === true;
  const lastVer = foldDocVersionAtFold.get(key);
  const currVer = ed.document.version;

  // 前回「全折りたたみ」実行後、編集されていなければ「全展開」
  const shouldUnfold = lastStateFolded && lastVer === currVer;

  if (shouldUnfold) {
    await vscode.commands.executeCommand("editor.unfoldAll");
    foldToggledByDoc.set(key, false);
    if (_sb) {
      _sb.recomputeAndCacheMetrics(ed);
      _sb.updateStatusBar(ed);
    }
    vscode.commands.executeCommand("posNote.refreshPos"); // 再解析
  } else {
    // 設定したレベル以上の見出しだけ折りたたむ
    const minLv = cfg().headingFoldMinLevel;
    const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
    if (lines.length === 0) {
      vscode.window.showInformationMessage(
        `折りたたみ対象の見出し（レベル${minLv}以上）は見つかりませんでした。`
      );
    } else {
      // 1) いまのカーソルが「折りたたみ対象の見出しの本文内」に居るかを判定
      const caret = ed.selection?.active ?? new vscode.Position(0, 0);
      const enclosing = findEnclosingHeadingLineFor(
        ed.document,
        caret.line,
        minLv
      );
      // 退避先（デフォは元の選択のまま / 対象本文内なら見出し行末尾へ移動）
      const safeRestoreSelections = (() => {
        if (enclosing >= 0) {
          const endCh = ed.document.lineAt(enclosing).text.length;
          const pos = new vscode.Position(enclosing, endCh);
          return [new vscode.Selection(pos, pos)];
        }
        return ed.selections;
      })();

      try {
        // 2) 見出し行へ複数選択を張って一括 fold
        ed.selections = lines.map((ln) => new vscode.Selection(ln, 0, ln, 0));
        await vscode.commands.executeCommand("editor.fold");
        foldToggledByDoc.set(key, true);
        foldDocVersionAtFold.set(key, currVer);
      } finally {
        // 3) カーソルを安全な位置へ復帰（本文内→見出し行末尾 / それ以外→元の選択）
        ed.selections = safeRestoreSelections;
        // 4) 必要ならスクロールも合わせる
        if (safeRestoreSelections.length === 1) {
          ed.revealRange(
            new vscode.Range(
              safeRestoreSelections[0].active,
              safeRestoreSelections[0].active
            ),
            vscode.TextEditorRevealType.Default
          );
        }
      }
    }
  }
}

// ===== 7) Semantic Tokens（POS/括弧/ダッシュ/全角スペース） =====

// kuromoji → token type / modifiers
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

// 行内で kuromoji トークンの開始位置を素朴に探索
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

// Markdown風見出し検出（0〜3スペース許容）
function getHeadingLevel(lineText) {
  const m = lineText.match(/^ {0,3}(#{1,6})\s+\S/);
  return m ? m[1].length : 0;
}
// 現在行が「見出し level>=minLevel の本文」に含まれていれば、その見出し行番号を返す
function findEnclosingHeadingLineFor(doc, line, minLevel) {
  // 上へ遡って直近の見出しを探す
  let hLine = -1,
    hLevel = 0;
  for (let i = line; i >= 0; i--) {
    const lvl = getHeadingLevel(doc.lineAt(i).text);
    if (lvl > 0) {
      hLine = i;
      hLevel = lvl;
      break;
    }
  }
  if (hLine < 0 || hLevel < Math.max(1, Math.min(6, minLevel))) return -1;

  // 直近見出しの「本文」に居るか判定（次の同レベル以下の見出しまでが本文）
  // 次の heading（level <= hLevel）の直前までが本文
  for (let j = hLine + 1; j < doc.lineCount; j++) {
    const lvl2 = getHeadingLevel(doc.lineAt(j).text);
    if (lvl2 > 0 && lvl2 <= hLevel) {
      // 次の見出しが line より後ろなら本文内
      return line > hLine && line < j ? hLine : -1;
    }
  }
  // 次の見出しが無い＝末尾まで本文
  return line > hLine ? hLine : -1;
}
// 見出しレベルが minLevel 以上の見出し「行番号」リストを返す
function collectHeadingLinesByMinLevel(document, minLevel) {
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const lvl = getHeadingLevel(text);
    if (lvl > 0 && lvl >= Math.max(1, Math.min(6, minLevel))) {
      lines.push(i);
    }
  }
  return lines;
}

// ===== 8) Providers =====
class JapaneseSemanticProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeSemanticTokens = new vscode.EventEmitter(); // ← 追加
    /** @type {vscode.Event<void>} */
    this.onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event; // ← 追加
  }

  async _buildTokens(document, range, cancelToken) {
    const c = cfg();

    // 言語別の有効/無効
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

    // 全角括弧＋中身のセグメントを先に集計（改行対応）
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

      // 見出し行は heading で全面着色（plaintext/novel）
      if (c.headingSemanticEnabled) {
        const l = (document.languageId || "").toLowerCase();
        if (l === "plaintext" || l === "novel") {
          const lvl = getHeadingLevel(text);
          if (lvl > 0) {
            builder.push(
              line,
              0,
              text.length,
              tokenTypesArr.indexOf("heading"),
              0
            );
            continue; // 見出しは品詞解析対象外
          }
        }
      }

      const skipKuromojiHere = false; // 常に解析（見出し行は下でcontinue）

      // 全角スペース
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          builder.push(line, m.index, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // ダッシュ（—/―） → bracket 色で
      {
        const reDash = /[—―]/g;
        let m;
        while ((m = reDash.exec(text)) !== null) {
          builder.push(
            line,
            m.index,
            m[0].length,
            tokenTypesArr.indexOf("bracket"),
            0
          );
        }
      }

      // 括弧＋中身（改行対応セグメント）
      {
        const segs = bracketSegsByLine.get(line);
        if (segs && segs.length) {
          for (const [sCh, eCh] of segs) {
            const len = eCh - sCh;
            if (len > 0) builder.push(line, sCh, len, idxBracket, 0);
          }
        }
      }

      // 品詞ハイライト（必要時のみ）
      if (!skipKuromojiHere && tokenizer && text.trim()) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          const length = seg.end - seg.start;
          builder.push(line, seg.start, length, typeIdx, mods);
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

class HeadingFoldingProvider {
  provideFoldingRanges(document, context, token) {
    // 意図的に未使用。ESLint対策と、将来の拡張余地のため残す
    void context;
    if (token?.isCancellationRequested) return [];
    const c = cfg();
    if (!c.headingFoldEnabled) return [];

    const lang = (document.languageId || "").toLowerCase();
    // 対象は plaintext / novel（Markdownは VSCode 既定に任せる）
    if (!(lang === "plaintext" || lang === "novel")) return [];

    const lines = document.lineCount;
    const heads = [];

    for (let i = 0; i < lines; i++) {
      const text = document.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) heads.push({ line: i, level: lvl });
    }
    if (heads.length === 0) return [];

    const ranges = [];
    for (let i = 0; i < heads.length; i++) {
      const { line: start, level } = heads[i];
      // 次の「同レベル以下」の見出し直前まで
      let end = lines - 1;
      for (let j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= level) {
          end = heads[j].line - 1;
          break;
        }
      }
      if (end > start) {
        ranges.push(
          new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region)
        );
      }
    }
    return ranges;
  }
}

// ===== 9) activate/deactivate =====
function activate(context) {
  console.log("[pos-Note] activate called");
  vscode.window.showInformationMessage("POS/Note: activate");

  // ステータスバー管理の初期化（cfg/isTargetDoc を渡す）
  const sb = (_sb = initStatusBar(context, { cfg, isTargetDoc }));

  // 見出しサイドバーの初期化
  initHeadingSidebar(context, { cfg, isTargetDoc });
  // commands
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.refreshPos", () =>
      sb.cmdRefreshPos()
    ),
    vscode.commands.registerCommand("posNote.toggleNoteCounter", () =>
      sb.cmdToggleNote()
    ),
    vscode.commands.registerCommand("posNote.setNoteSize", () =>
      sb.cmdSetNoteSize()
    ),
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings()
    )
  );

  // events
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      // 先に括弧補完系
      maybeAutoCloseFullwidthBracket(e);
      maybeDeleteClosingOnBackspace(e);
      sb.scheduleUpdate(ed);
      // 変更後テキストをスナップショットに反映（Backspace復元用）
      _prevTextByUri.set(e.document.uri.toString(), e.document.getText());
    }),

    // 保存：即時確定計算
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        // 保存時のみGit差分を再計算
        sb.recomputeOnSaveIfNeeded(doc);
        // 見出しビューも更新
        vscode.commands.executeCommand("posNote.headings.refresh");
      }
    }),

    // アクティブエディタ切替：確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        sb.onActiveEditorChanged(ed);
        _prevTextByUri.set(ed.document.uri.toString(), ed.document.getText());
      }
    }),

    // 選択変更：選択文字数を即反映
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      sb.onSelectionChanged(e.textEditor);
    }),

    // 設定変更：確定計算＋軽い更新
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posNote")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          sb.onConfigChanged(ed);
        }
      }
    })
  );

  // Provider登録
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "untitled" },
  ];
  const semProvider = new JapaneseSemanticProvider(context); // ← これを下のイベントで参照(context);
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector,
      semProvider,
      semanticLegend
    ),
    vscode.languages.registerDocumentRangeSemanticTokensProvider(
      selector,
      semProvider,
      semanticLegend
    )
  );

  // FoldingRangeProvider（.txt / novel）
  const foldSelector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
  ];
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      foldSelector,
      new HeadingFoldingProvider()
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const ed = e.textEditor;
      if (!ed) return;
      const c = cfg();
      const lang = (ed.document.languageId || "").toLowerCase();
      // 対象は .txt / novel（MarkdownはVSCode標準）
      if (!(lang === "plaintext" || lang === "novel")) return;
      if (!c.headingFoldEnabled) return;

      // 見出しの手動展開/全展開などで可視範囲が変わったら、全文を再ハイライト
      // （Provider に再発行を通知）
      if (semProvider && semProvider._onDidChangeSemanticTokens) {
        semProvider._onDidChangeSemanticTokens.fire();
      }
      sb.recomputeAndCacheMetrics(ed);
      sb.updateStatusBar(ed);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
