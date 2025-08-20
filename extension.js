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

// ===== 2) state =====
let tokenizer = null; // kuromoji tokenizer
let debouncer = null; // 軽い UI 更新用デバウンサ
let idleRecomputeTimer = null; // 重い再計算の遅延実行用
let enabledPage = true; // ページカウンタON/OFF（コマンドで切替）
let statusBarItem = null; // ステータスバー部品
let m = null; // ページカウンタ用メトリクスのキャッシュ
// 追加：合算文字数のキャッシュ（アクティブ文書の「ディレクトリ+拡張子」をキー）
let combinedCharsCache = {
  key: null, // 例: "/path/to/dir::.txt"
  value: null, // 数値（null は未計算/非対象）
};

// ===== 3) config helper =====
function cfg() {
  const c = vscode.workspace.getConfiguration("posPage");
  return {
    semanticEnabled: c.get("semantic.enabled", true),
    semanticEnabledMd: c.get("semantic.enabledMd", true),
    applyToTxtOnly: c.get("applyToTxtOnly", true),
    debounceMs: c.get("debounceMs", 500), // 軽いUI更新
    recomputeIdleMs: c.get("recomputeIdleMs", 1200), // 重い再計算
    enabledPage: c.get("enabledPage", true),
    maxDocLength: c.get("maxDocLength", 200000),
    rowsPerPage: c.get("page.rowsPerPage", 20),
    colsPerRow: c.get("page.colsPerRow", 20),
    kinsokuEnabled: c.get("kinsoku.enabled", true),
    kinsokuBanned: c.get("kinsoku.bannedStart", [
      "」",
      "）",
      "『",
      "』",
      "》",
      "】",
      "。",
      "、",
    ]),
    showCombined: c.get("aggregate.showCombinedChars", true),
  };
}

// 対象ドキュメントか判定（既定では plaintext + .txt）
function isTargetDoc(doc, c) {
  if (!doc) return false;
  // 既定では plaintext/.txt と markdown/.md を対象にする
  if (!c.applyToTxtOnly) return true;
  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isPlain = lang === "plaintext" || fsPath.endsWith(".txt");
  const isMd = lang === "markdown" || fsPath.endsWith(".md");
  // 他拡張「NOVEL-WRITER」等で言語モードが Novel になる場合も許可（id は通常 lowercase 化されるが保険）
  const isNovel = lang === "novel";
  return isPlain || isMd || isNovel;
}

// ===== 4) tokenizer loader =====
async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict"); // 拡張直下の dict/
  console.log("[pos-page] dict path:", dictPath);
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

// ===== 5) page counter core =====

// テキスト全体を原稿用紙風に折り返したときの行数を返す（行頭禁則対応）
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const banned = new Set(kinsokuEnabled ? bannedChars : []);
  let rows = 0;

  for (const line of lines) {
    const arr = Array.from(line);
    const n = arr.length;
    if (n === 0) {
      rows += 1;
      continue;
    } // 空行も1行

    let pos = 0;
    while (pos < n) {
      let take = Math.min(cols, n - pos);
      if (kinsokuEnabled) {
        let ni = pos + take;
        while (ni < n && banned.has(arr[ni])) {
          take++;
          ni++;
        }
      }
      rows += 1;
      pos += take;
    }
  }
  return rows;
}

// 現在の文書に対するメトリクス（総行/総ページ/現在ページ等）を計算
function computePageMetrics(doc, c, selection) {
  const text = doc.getText();

  // 文字数: 改行(LF)を除くコードポイント数
  const totalChars = Array.from(text.replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;

  // 総行数（原稿用紙の折返し + 禁則）
  const totalWrappedRows = wrappedRowsForText(
    text,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalPages = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerPage));

  // 現在ページ：先頭〜カーソルまでの行数から算出
  const prefixText = editorPrefixText(doc, selection);
  const currRows = wrappedRowsForText(
    prefixText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const currentPage = Math.max(
    1,
    Math.min(totalPages, Math.ceil(currRows / c.rowsPerPage))
  );

  // 最終ページの最終文字が何行目か
  const rem = totalWrappedRows % c.rowsPerPage;
  const lastLineInLastPage = rem === 0 ? c.rowsPerPage : rem;

  return {
    totalChars,
    totalWrappedRows,
    totalPages,
    currentPage,
    lastLineInLastPage,
  };
}

// 選択先頭までのテキストを取得（現在ページ算出用）
function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// 改行(LF)を除いたコードポイント数
function countCharsNoLF(text) {
  return Array.from(text.replace(/\r\n/g, "\n")).filter((ch) => ch !== "\n")
    .length;
}

// 複数選択に対応して合計文字数を返す（空選択は0）
function countSelectedChars(doc, selections) {
  let sum = 0;
  for (const sel of selections) {
    if (!sel.isEmpty) {
      const t = doc.getText(sel);
      sum += countCharsNoLF(t);
    }
  }
  return sum;
}

// メトリクスを計算→キャッシュ
function recomputeAndCacheMetrics(editor) {
  if (!editor) {
    m = null;
    return;
  }
  const c = cfg();
  if (!isTargetDoc(editor.document, c) || !enabledPage || !c.enabledPage) {
    m = null;
    return;
  }
  m = computePageMetrics(editor.document, c, editor.selection);
}

// ステータスバー表示
function updateStatusBar(editor) {
  const c = cfg();
  if (!statusBarItem) return;

  if (
    !editor ||
    !isTargetDoc(editor.document, c) ||
    !enabledPage ||
    !c.enabledPage
  ) {
    statusBarItem.hide();
    return;
  }

  const selections = editor.selections?.length
    ? editor.selections
    : [editor.selection];
  const selectedChars = countSelectedChars(editor.document, selections);

  const mm = m ?? {
    totalChars: 0,
    totalWrappedRows: 0,
    totalPages: 1,
    currentPage: 1,
    lastLineInLastPage: 1,
  };
  const displayChars = selectedChars > 0 ? selectedChars : mm.totalChars;

  // ★合算文字数（保存時に更新されたキャッシュを使う。設定OFFなら null ）
  const combined = c.showCombined ? combinedCharsCache.value : null;
  const combinedPart = combined != null ? `（${combined}字）` : "";

  statusBarItem.text = `${mm.currentPage}/${mm.totalPages} -${mm.lastLineInLastPage}（${c.rowsPerPage}×${c.colsPerRow}）${displayChars}字${combinedPart}`;

  statusBarItem.tooltip =
    selectedChars > 0
      ? "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=選択範囲の文字数（改行除外）｜（ ）=同一フォルダ×同一拡張子の合算文字数"
      : "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=全体の文字数（改行除外）｜（ ）=同一フォルダ×同一拡張子の合算文字数";

  statusBarItem.command = "posPage.setPageSize";
  statusBarItem.show();
}

// ===== 合算文字数（同一フォルダ×同一拡張子）ユーティリティ =====

// 改行(LF)を除いたコードポイント数をファイルから数える（同期読み込み）
function countFileCharsNoLF_FromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const text = raw.replace(/\r\n/g, "\n");
    return Array.from(text).filter((ch) => ch !== "\n").length;
  } catch (e) {
    console.warn("[pos-page] countFileChars error:", e?.message);
    return 0;
  }
}

// アクティブドキュメントと同じフォルダ内・同一拡張子の合算文字数を計算
function computeCombinedCharsForFolder(editor) {
  if (!editor) {
    combinedCharsCache = { key: null, value: null };
    return;
  }
  const c = cfg();
  if (!c.showCombined) {
    // 非表示設定時は「未計算」のままでよい
    combinedCharsCache = { key: null, value: null };
    return;
  }

  const doc = editor.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) {
    combinedCharsCache = { key: null, value: null };
    return;
  }

  // 拡張子判定（.txt or .md のみ対象）
  const lower = fsPath.toLowerCase();
  const isTxt = lower.endsWith(".txt");
  const isMd = lower.endsWith(".md");
  if (!isTxt && !isMd) {
    combinedCharsCache = { key: null, value: null };
    return;
  }

  const dir = path.dirname(fsPath);
  const ext = isTxt ? ".txt" : ".md";
  const cacheKey = `${dir}::${ext}`;

  // 同一キーなら再計算不要（保存トリガ等で更新する）
  if (combinedCharsCache.key === cacheKey && combinedCharsCache.value != null) {
    return;
  }

  let sum = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const nameLower = ent.name.toLowerCase();
      if (!nameLower.endsWith(ext)) continue;
      const childPath = path.join(dir, ent.name);
      sum += countFileCharsNoLF_FromFile(childPath);
    }
    combinedCharsCache = { key: cacheKey, value: sum };
  } catch (e) {
    console.warn("[pos-page] readdir error:", e?.message);
    combinedCharsCache = { key: cacheKey, value: null };
  }
}

// アクティブ文書が保存されたタイミングで合算文字数を再計算
function recomputeCombinedOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;

  // 保存後のみ再計算：同一フォルダ×同一拡張子
  combinedCharsCache = { key: null, value: null }; // キーを崩して再計算させる
  computeCombinedCharsForFolder(ed);
}

// ===== 6) scheduler（入力中は軽い更新、手が止まってから重い再計算） =====
function scheduleUpdate(editor) {
  const c = cfg();

  // 軽いUI更新（キャッシュmを反映）
  if (debouncer) clearTimeout(debouncer);
  debouncer = setTimeout(() => {
    updateStatusBar(editor);
  }, c.debounceMs);

  // 重い再計算はアイドル時にまとめて実行
  if (idleRecomputeTimer) clearTimeout(idleRecomputeTimer);
  idleRecomputeTimer = setTimeout(() => {
    recomputeAndCacheMetrics(editor);
    updateStatusBar(editor);
  }, c.recomputeIdleMs);
}

// ===== 7) commands =====
async function cmdRefreshPos() {
  // 手動で「いまの状態」を確定したいとき用：ページ計算を即再計算し、ステータスバーを即反映
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  updateStatusBar(ed);
  vscode.window.showInformationMessage("POS/Page: 解析を再適用しました");
}
async function cmdTogglePage() {
  enabledPage = !enabledPage;
  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `ページカウンタ: ${enabledPage ? "有効化" : "無効化"}`
  );
}
async function cmdSetPageSize() {
  const c = cfg();
  const rows = await vscode.window.showInputBox({
    prompt: "1ページの行数",
    value: String(c.rowsPerPage),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!rows) return;
  const cols = await vscode.window.showInputBox({
    prompt: "1行の文字数",
    value: String(c.colsPerRow),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!cols) return;

  const conf = vscode.workspace.getConfiguration("posPage");
  await conf.update(
    "page.rowsPerPage",
    parseInt(rows, 10),
    vscode.ConfigurationTarget.Global
  );
  await conf.update(
    "page.colsPerRow",
    parseInt(cols, 10),
    vscode.ConfigurationTarget.Global
  );

  const ed = vscode.window.activeTextEditor;
  if (ed) {
    recomputeAndCacheMetrics(ed);
    updateStatusBar(ed);
  }
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

// ===== 8) activate/deactivate =====
function activate(context) {
  console.log("[pos-page] activate called");
  vscode.window.showInformationMessage("POS/Page: activate");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    2
  );
  context.subscriptions.push(statusBarItem);

  // commands
  context.subscriptions.push(
    vscode.commands.registerCommand("posPage.refreshPos", () =>
      cmdRefreshPos()
    ),
    vscode.commands.registerCommand("posPage.togglePageCounter", () =>
      cmdTogglePage()
    ),
    vscode.commands.registerCommand("posPage.setPageSize", () =>
      cmdSetPageSize()
    )
  );

  // events
  context.subscriptions.push(
    // 入力：軽い更新＋アイドル時に重い再計算
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      scheduleUpdate(ed);
    }),
    // 保存：即時に確定計算
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        if (debouncer) {
          clearTimeout(debouncer);
          debouncer = null;
        }
        //  保存時のみ、合算文字数を再計算
        recomputeCombinedOnSaveIfNeeded(doc);
        recomputeAndCacheMetrics(ed);
        updateStatusBar(ed);
      }
    }),
    // エディタ切替：即時に確定計算＋軽い更新
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        // 切替時に（入力中ではないので）初期の合算を計算
        computeCombinedCharsForFolder(ed);
        recomputeAndCacheMetrics(ed);
        scheduleUpdate(ed);
      }
    }),
    // 選択変更：選択文字数を即時反映（軽い）
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      recomputeAndCacheMetrics(e.textEditor);
      updateStatusBar(e.textEditor);
    }),
    // 設定変更：確定計算＋軽い更新
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posPage")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          recomputeAndCacheMetrics(ed);
          scheduleUpdate(ed);
        }
      }
    })
  );

  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    // 保険：表示名が「Novel」となるケースにも対応（通常は小文字 id に正規化される）
    { language: "Novel", scheme: "file" },
    { language: "Novel", scheme: "untitled" },
    // Markdown にも対応
    { language: "markdown", scheme: "file" },
    { language: "markdown", scheme: "untitled" },
  ];

  const semProvider = new JapaneseSemanticProvider(context);
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

  // 初回：確定計算→UI反映
  if (vscode.window.activeTextEditor) {
    // 起動直後に合算を計算（入力操作ではない）
    computeCombinedCharsForFolder(vscode.window.activeTextEditor);
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
  }
}
function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}
module.exports = { activate, deactivate };

// ===== 9) Semantic Tokens（POS/括弧/ダッシュ/全角スペース） =====
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
];
const tokenModsArr = ["proper", "prefix", "suffix"];
const semanticLegend = new vscode.SemanticTokensLegend(
  Array.from(tokenTypesArr),
  Array.from(tokenModsArr)
);

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

// 行内で kuromoji トークンの開始位置を素朴に探索（ズレたらスキップ）
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

class JapaneseSemanticProvider {
  constructor(context) {
    this._context = context;
  }

  async _buildTokens(document, range, cancelToken) {
    const c = cfg();
    // 言語別に品詞ハイライトの有効/無効を判定
    const lang = (document.languageId || "").toLowerCase();
    if (lang === "markdown") {
      if (!c.semanticEnabledMd) {
        return new vscode.SemanticTokens(new Uint32Array());
      }
    } else {
      // plaintext / novel（他拡張NOVEL-WRITER）など
      // ※ VSCode の languageId は通常 lowercase だが保険として toLowerCase 済
      if (!c.semanticEnabled) {
        return new vscode.SemanticTokens(new Uint32Array());
      }
    }
    await ensureTokenizer(this._context);
    if (!tokenizer) {
      return new vscode.SemanticTokens(new Uint32Array());
    }

    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);

    for (let line = startLine; line <= endLine; line++) {
      if (cancelToken?.isCancellationRequested) break;
      const text = document.lineAt(line).text;

      // 全角スペース → fwspace（※背景はSemantic不可、既定は赤＋下線）
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          builder.push(line, m.index, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // ダッシュ（—/―） → bracket と同じ色で強調
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

      // 括弧＋その中身 → bracket
      {
        const pairs = [
          ["「", "」"],
          ["『", "』"],
          ["（", "）"],
          ["［", "］"],
          ["｛", "｝"],
          ["〈", "〉"],
          ["《", "》"],
          ["【", "】"],
          ["〔", "〕"],
        ];
        for (const [open, close] of pairs) {
          let idx = 0;
          while (idx < text.length) {
            const s = text.indexOf(open, idx);
            if (s < 0) break;
            const e = text.indexOf(close, s + open.length);
            if (e < 0) {
              builder.push(
                line,
                s,
                open.length,
                tokenTypesArr.indexOf("bracket"),
                0
              );
              idx = s + open.length;
            } else {
              const len = e + close.length - s;
              builder.push(line, s, len, tokenTypesArr.indexOf("bracket"), 0);
              idx = e + close.length;
            }
          }
        }
      }

      // 品詞 → kuromoji で行単位トークン化
      if (text.trim()) {
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
    const fullRange = new vscode.Range(
      0,
      0,
      document.lineCount - 1,
      document.lineAt(Math.max(0, document.lineCount - 1)).text.length
    );
    return this._buildTokens(document, fullRange, token);
  }
  async provideDocumentRangeSemanticTokens(document, range, token) {
    return this._buildTokens(document, range, token);
  }
}
