// extension.js
// ===== imports =====
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji"); // CJS

// ===== state =====
let tokenizer = null;
let debouncer = null;
let enabledPos = true;
let enabledPage = true;
let statusBarItem = null;

let m = null;
let idleRecomputeTimer = null; // 入力が止まってから重い再計算を実行するためのタイマ

// ===== config helper =====

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
  // ドキュメントとカーソル位置から最新メトリクスを計算してキャッシュ
  m = computePageMetrics(editor.document, c, editor.selection);
}

function cfg() {
  const c = vscode.workspace.getConfiguration("posPage");
  return {
    semanticEnabled: c.get("semantic.enabled", true),
    applyToTxtOnly: c.get("applyToTxtOnly", true),
    debounceMs: c.get("debounceMs", 500),
    enabledPos: c.get("enabledPos", true),
    maxDocLength: c.get("maxDocLength", 200000),
    enabledPage: c.get("enabledPage", true),
    rowsPerPage: c.get("page.rowsPerPage", 40),
    colsPerRow: c.get("page.colsPerRow", 40),
    recomputeIdleMs: c.get("recomputeIdleMs", 1000),
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
  };
}

// ===== tokenizer =====

async function ensureTokenizer(context) {
  if (tokenizer) return;
  const dictPath = path.join(context.extensionPath, "dict"); // プロジェクト直下の dict/
  console.log("[pos-page] dict path:", dictPath);
  if (!fs.existsSync(dictPath)) {
    vscode.window.showErrorMessage(
      "kuromoji の辞書が見つかりません。拡張直下の 'dict/' を確認してください。"
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

// ===== guards =====
function isTargetDoc(doc, c) {
  if (!doc) return false;
  if (!c.applyToTxtOnly) return true;
  const isPlain = doc.languageId === "plaintext";
  const isTxt = doc.uri.fsPath.toLowerCase().endsWith(".txt");
  return isPlain && isTxt;
}

// ===== page counter =====
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  // CRLF → LF 正規化
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const banned = new Set(kinsokuEnabled ? bannedChars : []);
  let rows = 0;

  for (const line of lines) {
    // 文字数は code point 基準（サロゲート対策）
    const arr = Array.from(line);
    const n = arr.length;

    // 空行も1行としてカウント（原稿用紙の行空け）
    if (n === 0) {
      rows += 1;
      continue;
    }

    let pos = 0;
    while (pos < n) {
      // まず cols だけ取る
      let take = Math.min(cols, n - pos);

      if (kinsokuEnabled) {
        // 次文字が禁則文字なら、前行に“ぶら下げ”（= この行に食わせる）
        let ni = pos + take;
        while (ni < n && banned.has(arr[ni])) {
          take++;
          ni++;
        }
      }

      rows += 1;
      pos += take; // tateぶん＋禁則ぶんだけ進める
    }
  }

  return rows;
}

function computePageMetrics(doc, c, selection) {
  const text = doc.getText();

  // 文字数は改行を除いたコードポイント数（必要なければ text.length に戻してOK）
  const totalChars = Array.from(text.replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;

  const totalWrappedRows = wrappedRowsForText(
    text,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalPages = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerPage));

  // 現在ページ算出用：先頭〜カーソル位置のテキスト
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
  // ★追加：最終ページの何行目に最終文字があるか
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

  // 選択があれば選択文字数、無ければ全体文字数（mが未計算でも壊れないようにデフォルトを用意）
  const selections =
    editor.selections && editor.selections.length
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

  statusBarItem.text =
    `${mm.currentPage}/${mm.totalPages}（${c.rowsPerPage}×${c.colsPerRow}）` +
    `${mm.lastLineInLastPage}行｜${displayChars}字`;

  statusBarItem.tooltip =
    selectedChars > 0
      ? "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=選択範囲の文字数（改行除外）"
      : "選択位置/全体ページ｜行=最終文字が最後のページの何行目か｜字=全体の文字数（改行除外）";

  statusBarItem.command = "posPage.setPageSize";
  statusBarItem.show();
}

function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// 改行(LF)を除いてコードポイント数を数える
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

// ===== scheduling =====
function scheduleUpdate(editor, context) {
  const c = cfg();

  // まずは軽い UI 更新（キャッシュ m を使う）
  if (debouncer) clearTimeout(debouncer);
  debouncer = setTimeout(() => {
    updateStatusBar(editor); // ここでは recompute しない
  }, c.debounceMs);

  // 重い再計算は「入力が止まってから」実行（キャッシュ m を更新）
  if (idleRecomputeTimer) clearTimeout(idleRecomputeTimer);
  idleRecomputeTimer = setTimeout(() => {
    recomputeAndCacheMetrics(editor);
    updateStatusBar(editor); // 確定値を反映
  }, c.recomputeIdleMs);
}

// ===== commands =====
async function cmdTogglePos(context) {
  enabledPos = !enabledPos;
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  if (enabledPos) {
    vscode.window.showInformationMessage("品詞ハイライト: 有効化");
  } else {
    vscode.window.showInformationMessage("品詞ハイライト: 無効化");
  }
}
async function cmdRefreshPos(context) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
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

  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

// ===== activate/deactivate =====
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
    vscode.commands.registerCommand("posPage.togglePos", () =>
      cmdTogglePos(context)
    ),
    vscode.commands.registerCommand("posPage.refreshPos", () =>
      cmdRefreshPos(context)
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
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      // 入力ごとに（デバウンス付きで）再計算＋更新
      scheduleUpdate(ed, context);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === doc) {
        if (debouncer) {
          clearTimeout(debouncer);
          debouncer = null;
        }
        // 保存直後は即時に最新化
        recomputeAndCacheMetrics(ed);
        updateStatusBar(ed);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        // エディタ切替時に最新メトリクスをキャッシュ
        recomputeAndCacheMetrics(ed);
        scheduleUpdate(ed, context);
        // 切替時にも一度適用（入力開始後は止まる）
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      // 選択によってページ/文字数が変わるので即時反映
      recomputeAndCacheMetrics(e.textEditor);
      updateStatusBar(e.textEditor);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posPage")) {
        const ed = vscode.window.activeTextEditor;
        if (ed) {
          // 行×列や禁則の変更時はキャッシュを更新
          recomputeAndCacheMetrics(ed);
          scheduleUpdate(ed, context);
          // 色設定や有効/無効が変わった場合に備え適用
        }
      }
    })
  );
  // --- Semantic Tokens Provider の登録 ---
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
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

  // 初回
  if (vscode.window.activeTextEditor) {
    // 起動直後にメトリクスを確定→以降の入力中はキャッシュ表示
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
  }
}
function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };

// ===== Semantic Tokens for Japanese POS =====
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

// kuromoji 品詞 → semantic token type / modifiers
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
  return {
    typeIdx: Math.max(0, tokenTypesArr.indexOf(type)),
    mods,
  };
}

// 行テキスト内でトークンの位置を素朴に走査（曖昧一致ずれはスキップ）
function* enumerateTokenOffsets(lineText, tokens) {
  let cur = 0;
  for (const tk of tokens) {
    const s = tk.surface_form || "";
    if (!s) continue;
    const i = lineText.indexOf(s, cur);
    if (i === -1) continue; // ずれたら飛ばす
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
    if (!c.semanticEnabled || !enabledPos) {
      return new vscode.SemanticTokens(new Uint32Array());
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

      // --- 全角スペースを semantic で配る（背景色は不可なので下線などで表現） ---
      {
        const re = /　/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          builder.push(line, m.index, 1, tokenTypesArr.indexOf("fwspace"), 0);
        }
      }

      // --- EM DASH（—）/ HORIZONTAL BAR（―）を bracket と同じ扱いでハイライト ---
      {
        // 必要なら "―"（U+2015）も含める
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

      // --- 括弧（＋中身）を semantic で配る ---
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
              // 開きのみ
              builder.push(
                line,
                s,
                open.length,
                tokenTypesArr.indexOf("bracket"),
                0
              );
              idx = s + open.length;
            } else {
              // 中身ごと
              const len = e + close.length - s;
              builder.push(line, s, len, tokenTypesArr.indexOf("bracket"), 0);
              idx = e + close.length;
            }
          }
        }
      }

      // --- 品詞（kuromoji） ---
      if (text.trim()) {
        const tokens = tokenizer.tokenize(text);
        for (const seg of enumerateTokenOffsets(text, tokens)) {
          const { typeIdx, mods } = mapKuromojiToSemantic(seg.tk);
          const startChar = seg.start;
          const length = seg.end - seg.start;
          builder.push(line, startChar, length, typeIdx, mods);
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
