// 見出しの操作（全折/全展開トグル、FoldingRangeProvider、可視範囲変化に追随）

const vscode = require("vscode");
const { getHeadingLevel } = require("./utils");

// ドキュメントごとの折りたたみ状態を保持
const foldToggledByDoc = new Map(); // key: uriString, value: boolean（true=折りたたみ中）
const foldDocVersionAtFold = new Map(); // key: uriString, value: document.version

// 現在行が「見出し level>=minLevel の本文」に含まれていれば、その見出し行番号を返す
function findEnclosingHeadingLineFor(doc, line, minLevel) {
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

  for (let j = hLine + 1; j < doc.lineCount; j++) {
    const lvl2 = getHeadingLevel(doc.lineAt(j).text);
    if (lvl2 > 0 && lvl2 <= hLevel) {
      return line > hLine && line < j ? hLine : -1;
    }
  }
  return line > hLine ? hLine : -1;
}

// 見出しレベルが minLevel 以上の見出し「行番号」リスト
function collectHeadingLinesByMinLevel(document, minLevel) {
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const lvl = getHeadingLevel(text);
    if (lvl > 0 && lvl >= Math.max(1, Math.min(6, minLevel))) lines.push(i);
  }
  return lines;
}

// 見出しの “全折/全展開” トグル（.txt / novel）
async function cmdToggleFoldAllHeadings({ cfg, sb }) {
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
  const shouldUnfold = lastStateFolded && lastVer === currVer;

  if (shouldUnfold) {
    await vscode.commands.executeCommand("editor.unfoldAll");
    foldToggledByDoc.set(key, false);
    if (sb) {
      sb.recomputeAndCacheMetrics(ed);
      sb.updateStatusBar(ed);
    }
    vscode.commands.executeCommand("posNote.refreshPos");
    return;
  }

  const minLv = c.headingFoldMinLevel;
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

    const heads = [];
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      const lvl = getHeadingLevel(text);
      if (lvl > 0) heads.push({ line: i, level: lvl });
    }
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
    return ranges;
  }
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
  // 1) コマンド
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings({ cfg, sb })
    )
  );

  // 2) FoldingRangeProvider
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

  // 3) 可視範囲変更に追随：再ハイライト＋ステータス更新
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const ed = e.textEditor;
      if (!ed) return;
      const c = cfg();
      const lang = (ed.document.languageId || "").toLowerCase();
      if (!(lang === "plaintext" || lang === "novel")) return;
      if (!c.headingFoldEnabled) return;

      if (semProvider?.fireDidChange) semProvider.fireDidChange();
      if (sb) {
        sb.recomputeAndCacheMetrics(ed);
        sb.updateStatusBar(ed);
      }
    })
  );
}

module.exports = {
  registerHeadlineSupport,
};
