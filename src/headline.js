// 見出しの操作（全折/全展開トグル、FoldingRangeProvider、可視範囲変化に追随）

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const {
  getHeadingLevel,
  loadNoteSettingForDoc,
  getHeadingsCached,
  getHeadingMetricsCached,
  invalidateHeadingCache,
} = require("./utils");
const countDeco = vscode.window.createTextEditorDecorationType({
  after: { margin: "0 0 0 0.75em" },
});

let debounceTimer = null;

// アクティブエディタの見出し文字数装飾を更新する外部公開関数
// headings_folding_level を notesetting.json から読む。0 のときは設定値を使用。
async function resolveFoldMinLevel(doc, c) {
  const fallback = Math.max(1, Math.min(6, c.headingFoldMinLevel || 1));
  try {
    const { data } = await loadNoteSettingForDoc(doc);
    if (!data) return fallback;
    if (!Object.prototype.hasOwnProperty.call(data, "headings_folding_level"))
      return fallback;
    const v = Number(data.headings_folding_level);
    if (!Number.isFinite(v)) return fallback;
    const lv = Math.floor(v);
    if (lv === 0) return fallback;
    return Math.max(1, Math.min(6, lv));
  } catch {
    return fallback;
  }
}

function refreshHeadingCounts(ed, cfg) {
  updateHeadingCountDecorations(ed, cfg);
}

// ドキュメントごとの折りたたみ状態を保持
const foldToggledByDoc = new Map(); // key: uriString, value: boolean（true=折りたたみ中）
const foldDocVersionAtFold = new Map(); // key: uriString, value: document.version

// 現在行が「見出し level>=minLevel の本文」に含まれていれば、その見出し行番号を返す
// 折りたたみ復元時にカーソル位置を安全に戻すための計算
function findEnclosingHeadingLineFor(doc, line, minLevel) {
  const headings = getHeadingsCached(doc);
  const targetLevel = Math.max(1, Math.min(6, minLevel));

  // 直近の上位見出しを探す（逆順探索）
  let foundHeading = null;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.line <= line) {
      if (h.level >= targetLevel) {
        // 候補発見。ただし、これが「包含」しているか確認が必要
        // つまり、次の「同レベル以上の見出し」より前であること
        foundHeading = h;
        // チェック用に次の見出しを探す
        for (let j = i + 1; j < headings.length; j++) {
          const next = headings[j];
          if (next.level <= h.level) {
            // 次の同レベル以上の見出しが、現在行(line)より前（あるいは同じ）なら、
            // 現在行は foundHeading の範囲外（次のセクション）にある
            if (next.line <= line) {
              return -1;
            }
            break;
          }
        }
        return h.line;
      }
    }
  }
  return -1;
}

// 見出しレベルが minLevel 以上の見出し「行番号」リスト
// 全折/展開の対象行をまとめて選択するために使用
function collectHeadingLinesByMinLevel(document, minLevel) {
  const headings = getHeadingsCached(document);
  const targetLevel = Math.max(1, Math.min(6, minLevel));
  return headings
    .filter((h) => h.level >= targetLevel)
    .map((h) => h.line);
}

// 見出しジャンプ用ヘルパー（最適化版：キャッシュを利用）
function findPrevHeadingLine(document, fromLine) {
  const headings = getHeadingsCached(document);
  // 逆順で、現在行より前の見出しを探す
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].line < fromLine) {
      return headings[i].line;
    }
  }
  return -1;
}

function findNextHeadingLine(document, fromLine) {
  const headings = getHeadingsCached(document);
  // 順方向で、現在行より後の見出しを探す
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line > fromLine) {
      return headings[i].line;
    }
  }
  return -1;
}

// コマンド: 前/次の見出し行にカーソルを移動
async function cmdMoveToPrevHeading() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown")) return;

  const currentLine = ed.selection?.active?.line ?? 0;
  const target = findPrevHeadingLine(ed.document, currentLine);
  if (target < 0) {
    vscode.window.showInformationMessage("前方に見出し行がありません。");
    return;
  }
  const pos = new vscode.Position(target, 0);
  const sel = new vscode.Selection(pos, pos);
  ed.selections = [sel];
  ed.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.Default
  );
}

async function cmdMoveToNextHeading() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown")) return;

  const currentLine = ed.selection?.active?.line ?? 0;
  const target = findNextHeadingLine(ed.document, currentLine);
  if (target < 0) {
    vscode.window.showInformationMessage("後方に見出し行がありません。");
    return;
  }
  const pos = new vscode.Position(target, 0);
  const sel = new vscode.Selection(pos, pos);
  ed.selections = [sel];
  ed.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.Default
  );
}

/**
 * カーソル位置（またはその上方向）で直近の見出しを起点に、
 * 次の同レベル見出し直前（またはファイル末尾）までを取得する。
 * @param {vscode.TextEditor} editor
 * @returns {{ fullRange: vscode.Range, bodyRange: vscode.Range | null } | null}
 */
function findHeadingSection(editor) {
  const doc = editor.document;
  const currentLine = editor.selection.active.line;
  const headings = getHeadingsCached(doc);

  // 現在行より上にある直近の見出しを探す（逆順探索）
  let startHeading = null;
  let startIndex = -1;

  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].line <= currentLine) {
      startHeading = headings[i];
      startIndex = i;
      break;
    }
  }

  if (!startHeading) {
    return null;
  }

  const startLine = startHeading.line;
  const currentLevel = startHeading.level;

  // 次の同レベル以上の見出しを探す（順方向探索）
  let endLine = doc.lineCount - 1;
  for (let i = startIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= currentLevel) {
      endLine = headings[i].line - 1;
      break;
    }
  }

  const endLineText = doc.lineAt(endLine).text;
  const fullRange = new vscode.Range(startLine, 0, endLine, endLineText.length);

  // 見出し行＋直後の1行を除外した本文
  let bodyRange = null;
  const bodyStartLine = startLine + 2;
  if (bodyStartLine <= endLine) {
    bodyRange = new vscode.Range(
      bodyStartLine,
      0,
      endLine,
      endLineText.length
    );
  }

  return { fullRange, bodyRange };
}

/**
 * 見出しセクション全体を選択（見出し行を含む）。
 */
function cmdSelectHeadingSection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      'カーソル行または上方向にMarkdownの見出しが見つかりません。'
    );
    return;
  }

  editor.selection = new vscode.Selection(
    section.fullRange.start,
    section.fullRange.end
  );
  vscode.window.setStatusBarMessage('見出しセクションを選択。', 2000);
}

/**
 * 見出し行＋直後の1行を除外した本文のみを選択。
 */
function cmdSelectHeadingSectionBody() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      'カーソル行または上方向にMarkdownの見出しが見つかりません。'
    );
    return;
  }

  if (!section.bodyRange) {
    vscode.window.showInformationMessage(
      '見出し行と直後の行のみで選択範囲がありません。'
    );
    return;
  }

  editor.selection = new vscode.Selection(
    section.bodyRange.start,
    section.bodyRange.end
  );
  vscode.window.setStatusBarMessage(
    '見出し行と直後の行を除いてセクションを選択。',
    2000
  );
}

async function cmdToggleFoldAllHeadings({ cfg, sb }) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const c = cfg();
  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown")) {
    vscode.window.showInformationMessage(
      "このトグルは .txt / novel / .md でのみ有効です"
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
  const shouldUnfold = lastStateFolded && lastVer === currVer;

  if (shouldUnfold) {
    const minLv = await resolveFoldMinLevel(ed.document, c);
    const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
    if (lines.length === 0) {
      vscode.window.showInformationMessage(
        `展開対象の見出し（レベル${minLv}以上）は見つかりませんでした。`
      );
      return;
    }

    const caret = ed.selection?.active ?? new vscode.Position(0, 0);
    const enclosing = findEnclosingHeadingLineFor(
      ed.document,
      caret.line,
      minLv
    );
    const safeRestoreSelections =
      enclosing >= 0
        ? (() => {
            const endCh = ed.document.lineAt(enclosing).text.length;
            const pos = new vscode.Position(enclosing, endCh);
            return [new vscode.Selection(pos, pos)];
          })()
        : ed.selections;

    try {
      ed.selections = lines.map((ln) => new vscode.Selection(ln, 0, ln, 0));
      await vscode.commands.executeCommand("editor.unfold");
      foldToggledByDoc.set(key, false);
      foldDocVersionAtFold.set(key, currVer);
      if (sb) {
        sb.recomputeAndCacheMetrics(ed);
        sb.updateStatusBar(ed);
      }
      vscode.commands.executeCommand("posNote.refreshPos");
    } finally {
      ed.selections = safeRestoreSelections;
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
    return;
  }

  const minLv = await resolveFoldMinLevel(ed.document, c);
  const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
  if (lines.length === 0) {
    vscode.window.showInformationMessage(
      `折りたたみ対象の見出し（レベル${minLv}以上）は見つかりませんでした。`
    );
    return;
  }

  const caret = ed.selection?.active ?? new vscode.Position(0, 0);
  const enclosing = findEnclosingHeadingLineFor(ed.document, caret.line, minLv);
  const safeRestoreSelections =
    enclosing >= 0
      ? (() => {
          const endCh = ed.document.lineAt(enclosing).text.length;
          const pos = new vscode.Position(enclosing, endCh);
          return [new vscode.Selection(pos, pos)];
        })()
      : ed.selections;

  try {
    ed.selections = lines.map((ln) => new vscode.Selection(ln, 0, ln, 0));
    await vscode.commands.executeCommand("editor.fold");
    foldToggledByDoc.set(key, true);
    foldDocVersionAtFold.set(key, currVer);
  } finally {
    ed.selections = safeRestoreSelections;
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

// FoldingRangeProvider（対象：plaintext / novel。Markdown は VS Code 既定に委譲）
class HeadingFoldingProvider {
  constructor(cfg) {
    this._cfg = cfg;
  }
  provideFoldingRanges(document, context, token) {
    void context;
    if (token?.isCancellationRequested) return [];
    const c = this._cfg();
    if (!c.headingFoldEnabled) return [];

    const lang = (document.languageId || "").toLowerCase();
    if (!(lang === "plaintext" || lang === "novel")) return [];

    const heads = getHeadingsCached(document);
    if (heads.length === 0) return [];

    const ranges = [];
    for (let i = 0; i < heads.length; i++) {
      const { line: start, level } = heads[i];
      let end = document.lineCount - 1;
      for (let j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= level) {
          end = heads[j].line - 1;
          break;
        }
      }
      if (end > start)
        ranges.push(
          new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region)
        );
    }

    // ``` フェンス折りたたみ
    let fenceStart = -1;
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (text.includes("```")) {
        if (fenceStart < 0) {
          fenceStart = i;
        } else {
          if (i > fenceStart) {
            ranges.push(
              new vscode.FoldingRange(
                fenceStart,
                i,
                vscode.FoldingRangeKind.Region
              )
            );
          }
          fenceStart = -1;
        }
      }
    }
    if (fenceStart >= 0) {
      ranges.push(
        new vscode.FoldingRange(
          fenceStart,
          document.lineCount - 1,
          vscode.FoldingRangeKind.Region
        )
      );
    }
    return ranges;
  }
}

/**
 * # をシンボル化する Provider
 * - レベル1..6を階層化して DocumentSymbol ツリーを返す
 * - Markdown は VS Code 既定があるため対象外（衝突回避）
 */
class HeadingSymbolProvider {
  // DocumentSymbolProvider インターフェースの実装本体
  provideDocumentSymbols(document, token) {
    if (token?.isCancellationRequested) return [];

    // 言語フィルタ（.txt / novel のみ）
    const lang = (document.languageId || "").toLowerCase();
    if (!(lang === "plaintext" || lang === "novel")) {
      return [];
    }

    // 見出し行の収集（キャッシュ利用）
    const heads = getHeadingsCached(document);
    if (heads.length === 0) return [];

    // 行→範囲→DocumentSymbol を生成し、レベルでネストさせる
    const syms = [];
    const stack = []; // { level, sym }

    for (let idx = 0; idx < heads.length; idx++) {
      const { line, level, text } = heads[idx];

      // endLine の計算（次の同レベル以上の見出し直前まで）
      let endLine = document.lineCount - 1;
      for (let j = idx + 1; j < heads.length; j++) {
        if (heads[j].level <= level) {
          endLine = heads[j].line - 1;
          break;
        }
      }

      // タイトル文字列を整形（先頭 # を除去して trim）
      const title = text.replace(/^#+\s*/, "").trim() || `Heading L${level}`;

      // 表示に使う kind は Section が最も自然（Namespace でも可）
      const range = new vscode.Range(
        line,
        0,
        endLine,
        document.lineAt(endLine).text.length
      );
      const selectionRange = new vscode.Range(
        line,
        0,
        line,
        document.lineAt(line).text.length
      );
      const sym = new vscode.DocumentSymbol(
        title,
        "", // detail は空に（必要なら文字数など入れても可）
        vscode.SymbolKind.Namespace,
        range,
        selectionRange
      );

      // スタックを使って親子関係を形成
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) {
        syms.push(sym);
      } else {
        stack[stack.length - 1].sym.children.push(sym);
      }
      stack.push({ level, sym });
    }

    return syms;
  }
}

/**
 * Provider 登録
 * アウトライン・パンくず・Sticky Scroll などに見出しを供給する
 */
function registerHeadingSymbolProvider(context) {
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new HeadingSymbolProvider()
    )
  );
}

/**
 * 見出し機能の初期化（コマンド／プロバイダ／イベントをまとめて登録）
 * @param {vscode.ExtensionContext} context
 * @param {{ cfg: () => any, isTargetDoc: (doc:any, c:any)=>boolean, sb: any, semProvider?: { fireDidChange?: ()=>void } }} opt
 */
function registerHeadlineSupport(
  context,
  { cfg, isTargetDoc, sb, semProvider }
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings({ cfg, sb })
    ),
    vscode.commands.registerCommand("posNote.headings.gotoPrev", () =>
      cmdMoveToPrevHeading()
    ),
    vscode.commands.registerCommand("posNote.headings.gotoNext", () =>
      cmdMoveToNextHeading()
    ),
    vscode.commands.registerCommand("posNote.headline.selectSection", () =>
      cmdSelectHeadingSection()
    ),
    vscode.commands.registerCommand("posNote.headline.selectSectionBody", () =>
      cmdSelectHeadingSectionBody()
    )
  );

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
      new HeadingFoldingProvider(cfg)
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const ed = e.textEditor;
      if (!ed) return;
      const c = cfg();
      const lang = (ed.document.languageId || "").toLowerCase();
      if (!(lang === "plaintext" || lang === "novel" || lang === "markdown"))
        return;
      if (!c.headingFoldEnabled) return;

      if (semProvider?.fireDidChange) semProvider.fireDidChange();
      if (sb) {
        sb.recomputeAndCacheMetrics(ed);
        sb.updateStatusBar(ed);
      }
      // 可視範囲変化で見出し行末の字数デコレーションを更新
      updateHeadingCountDecorations(ed, cfg);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("posNote")) return;
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      updateHeadingCountDecorations(ed, cfg);
    }),

    // バックグラウンドで見出しキャッシュを更新
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // キャッシュ更新（getHeadingsCachedを呼ぶだけ）
        getHeadingsCached(e.document);
      }, 500);
    }),

    // 閉じたドキュメントのキャッシュを削除
    vscode.workspace.onDidCloseTextDocument((doc) => {
      invalidateHeadingCache(doc);
    })
  );

  const initEd = vscode.window.activeTextEditor;
  if (initEd) {
    updateHeadingCountDecorations(initEd, cfg);
  }
}

// 見出し末尾に表示する字数デコレーションを算出して適用する
function updateHeadingCountDecorations(ed, cfg) {
  // ...前段の言語・設定チェックは既存のまま...
  const c = cfg();

  // ★ ここを差し替え：utils 側の「統合キャッシュ版」を使用
  const { items } = getHeadingMetricsCached(ed.document, c, vscode);

  if (!items.length) {
    ed.setDecorations(countDeco, []);
    return;
  }

  const decorations = items
    .map(({ line, own, sub }) => {
      // 表示テキストの構築（own / sub）
      const ownShow = own > 0;
      const subShow = sub > 0 && sub !== own;

      if (!ownShow && !subShow) return null;

      let text = "- ";
      if (ownShow) text += `${own.toLocaleString("ja-JP")}字`;
      if (subShow)
        text += `${ownShow ? " / " : "/ "}${sub.toLocaleString("ja-JP")}字`;

      const endCh = ed.document.lineAt(line).text.length;
      const pos = new vscode.Position(line, endCh);
      return {
        range: new vscode.Range(pos, pos),
        renderOptions: { after: { contentText: text } },
      };
    })
    .filter(Boolean);

  ed.setDecorations(countDeco, decorations);
}

module.exports = {
  registerHeadlineSupport,
  registerHeadingSymbolProvider,
  refreshHeadingCounts,
};
