// 見出しの操作（全折/全展開トグル、FoldingRangeProvider、可視範囲変化に追随）

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const {
  getHeadingLevel,
  getHeadingCharMetricsForDisplay,
  loadNoteSettingForDoc,
} = require("./utils");
const countDeco = vscode.window.createTextEditorDecorationType({
  after: { margin: "0 0 0 0.75em" },
});

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
// 全折/展開の対象行をまとめて選択するために使用
function collectHeadingLinesByMinLevel(document, minLevel) {
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const lvl = getHeadingLevel(text);
    if (lvl > 0 && lvl >= Math.max(1, Math.min(6, minLevel))) lines.push(i);
  }
  return lines;
}

// 見出しの “全折/全展開” トグル
// （中略：このあたりは既存のまま）
// ※ 以降のコードは元ファイルと同一です（折りたたみ関係は変更なし）

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

  // ★ ここを差し替え：utils 側の「表示ルール準拠メトリクス」を使用
  const { items } = getHeadingCharMetricsForDisplay(ed.document, c, vscode);

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
  refreshHeadingCounts,
};
