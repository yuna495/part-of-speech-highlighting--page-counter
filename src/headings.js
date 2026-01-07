// 見出し関連機能の統合モジュール
// Sidebar (TreeView), Minimap Highlight, Editor Decoration (Count), Folding, Symbols, Navigation
const vscode = require("vscode");
const path = require("path");
const {
  getHeadingLevel,
  getHeadingMetricsCached,
  getHeadingsCached,
  loadNoteSettingForDoc,
  invalidateHeadingCache,
} = require("./utils");

// ============================================================
//  Sidebar (TreeView) Implementation
// ============================================================

/** 1行から見出しテキスト本体を抽出（先頭 # と余分な空白を除去）。TreeView 表示用。 */
function stripHeadingMarkup(lineText) {
  return lineText.replace(/^ {0,3}#{1,6}\s+/, "").trim();
}

/** 見出しアイコン（レベル別）。media/ 以下の画像を使い分ける例。 */
function iconForLevel(level) {
  const mediaPath = path.join(__dirname, "image");
  switch (level) {
    case 1:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading1L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading1D.png")),
      }; // H1
    case 2:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading2L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading2D.png")),
      }; // H2
    case 3:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading3L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading3D.png")),
      }; // H3
    case 4:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading4L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading4D.png")),
      }; // H4
    case 5:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading5L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading5D.png")),
      }; // H5
    default:
      return {
        light: vscode.Uri.file(path.join(mediaPath, "heading6L.png")),
        dark: vscode.Uri.file(path.join(mediaPath, "heading6D.png")),
      }; // H6
  }
}

/** ツリーノード */
class HeadingNode extends vscode.TreeItem {
  constructor(label, uri, line, level, countText) {
    super(label);
    // this.resourceUri = uri; // Git差分装飾を避けるため設定しない
    this.line = line;
    this.level = level;
    this.iconPath = iconForLevel(level);
    this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    this.description = countText || "";
    this.command = {
      command: "posNote.headings.reveal",
      title: "Reveal Heading",
      arguments: [uri, line],
    };
    // レベルに応じてインデント風にパディング（任意）
    this.label = `${" ".repeat(Math.max(0, level - 1))}${label}`;
    this.contextValue = "headingNode";
  }
}

/** 見出しツリーのデータ提供（TreeDataProvider）。 */
class HeadingsProvider {
  constructor(helpers) {
    this._helpers = helpers;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._items = [];
  }

  // 外部から呼び出されると TreeView を再描画する
  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element) return []; // フラット表示
    return this._collectHeadingsOfActiveEditor();
  }

  /** アクティブエディタから見出しを抽出してノード配列にする。 */
  _collectHeadingsOfActiveEditor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return [];
    const { cfg, isTargetDoc } = this._helpers;
    const c = cfg();

    if (!isTargetDoc(ed.document, c)) return [];

    const doc = ed.document;
    // キャッシュ版を利用
    const metrics = getHeadingMetricsCached(doc, c, vscode)?.items || [];
    const countByLine = new Map();
    for (const { line, own, sub } of metrics) {
      const ownShow = own > 0;
      const subShow = sub > 0 && sub !== own;
      if (!ownShow && !subShow) continue;
      let text = "";
      if (ownShow) text += `${own.toLocaleString("ja-JP")}字`;
      if (subShow)
        text += `${ownShow ? " / " : "/ "}${sub.toLocaleString("ja-JP")}字`;
      countByLine.set(line, text);
    }

    const items = [];
    for (const m of metrics) {
      const label = stripHeadingMarkup(m.text);
      const countText = countByLine.get(m.line) || "";
      items.push(new HeadingNode(label, doc.uri, m.line, m.level, countText));
    }
    this._items = items;
    return items;
  }
}

/** コマンド：見出し位置へ移動し、行を表示 */
async function revealHeading(uri, line) {
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString()) {
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.AtTop
  );
}

// ============================================================
//  Minimap Highlight Implementation
// ============================================================

function makeDecorationTypes() {
  const colors = [
    "#ff14e0aa", // H1
    "#fd9bcccc", // H2
    "#4dd0e1cc", // H3
    "#11ff84aa", // H4
    "#ffe955aa", // H5
    "#f94446cc", // H6
  ];
  return colors.map((c) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // @ts-ignore minimap is available on DecorationRenderOptions at VS Code >= 1.103
      minimap: { color: c, position: "foreground" },
      overviewRulerColor: c,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    })
  );
}

function collectHeadingRanges(editor) {
  const doc = editor.document;
  const headings = getHeadingsCached(doc);
  const byLevel = [[], [], [], [], [], []];

  for (const h of headings) {
    const pos = new vscode.Position(h.line, 0);
    const lvIdx = Math.min(Math.max(h.level, 1), 6) - 1;
    byLevel[lvIdx].push(new vscode.Range(pos, pos));
  }
  return byLevel;
}

const _minimapCache = new Map();

function applyMinimapDecorations(editor, decoTypes, force = false) {
  const doc = editor.document;
  const uri = doc.uri.toString();
  const ver = doc.version;

  const cached = _minimapCache.get(uri);
  if (!force && cached && cached.version === ver) {
    return;
  }

  const byLevel = collectHeadingRanges(editor);
  for (let i = 0; i < decoTypes.length; i++) {
    editor.setDecorations(decoTypes[i], byLevel[i]);
  }

  _minimapCache.set(uri, { version: ver });
}

// ============================================================
//  Editor Decoration (Character Count) Implementation
// ============================================================
const countDeco = vscode.window.createTextEditorDecorationType({
  after: { margin: "0 0 0 0.75em" },
});

function updateHeadingCountDecorations(ed, cfg) {
  const c = cfg();
  const { items } = getHeadingMetricsCached(ed.document, c, vscode);

  if (!items.length) {
    ed.setDecorations(countDeco, []);
    return;
  }

  const decorations = items
    .map(({ line, own, sub, text: hText }) => {
      const ownShow = own > 0;
      const subShow = sub > 0 && sub !== own;
      if (!ownShow && !subShow) return null;

      let text = "- ";
      if (ownShow) text += `${own.toLocaleString("ja-JP")}字`;
      if (subShow)
        text += `${ownShow ? " / " : "/ "}${sub.toLocaleString("ja-JP")}字`;

      // Optimized: use hText.length instead of accessing document line
      const endCh = hText.length;
      const pos = new vscode.Position(line, endCh);
      return {
        range: new vscode.Range(pos, pos),
        renderOptions: { after: { contentText: text } },
      };
    })
    .filter(Boolean);

  ed.setDecorations(countDeco, decorations);
}

// ============================================================
//  Folding & Navigation Helper Implementation
// ============================================================

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

const foldToggledByDoc = new Map();
const foldDocVersionAtFold = new Map();

function findEnclosingHeadingLineFor(doc, line, minLevel) {
  const headings = getHeadingsCached(doc);
  const targetLevel = Math.max(1, Math.min(6, minLevel));

  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.line <= line) {
      if (h.level >= targetLevel) {
        for (let j = i + 1; j < headings.length; j++) {
          const next = headings[j];
          if (next.level <= h.level) {
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

function collectHeadingLinesByMinLevel(document, minLevel) {
  const headings = getHeadingsCached(document);
  const targetLevel = Math.max(1, Math.min(6, minLevel));
  return headings
    .filter((h) => h.level >= targetLevel)
    .map((h) => h.line);
}

function findPrevHeadingLine(document, fromLine) {
  const headings = getHeadingsCached(document);
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].line < fromLine) {
      return headings[i].line;
    }
  }
  return -1;
}

function findNextHeadingLine(document, fromLine) {
  const headings = getHeadingsCached(document);
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line > fromLine) {
      return headings[i].line;
    }
  }
  return -1;
}

async function cmdMoveToPrevHeading() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown"))
    return;

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
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown"))
    return;

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

function findHeadingSection(editor) {
  const doc = editor.document;
  const currentLine = editor.selection.active.line;
  const headings = getHeadingsCached(doc);

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

  let endLine = doc.lineCount - 1;
  for (let i = startIndex + 1; i < headings.length; i++) {
    if (headings[i].level <= currentLevel) {
      // 次の見出しが見つかったら、その手前の「空行でない行」までを選択範囲とする
      let limitLine = headings[i].line - 1;
      while (limitLine > startLine) {
        const text = doc.lineAt(limitLine).text;
        if (text.trim().length > 0) {
          break;
        }
        limitLine--;
      }
      endLine = limitLine;
      break;
    }
  }

  const endLineText = doc.lineAt(endLine).text;
  const fullRange = new vscode.Range(startLine, 0, endLine, endLineText.length);



  let bodyRange = null;

  // bodyStartLine を探索（見出し行の次から、空行をスキップ）
  let realBodyStart = startLine + 1;
  while (realBodyStart <= endLine) {
    const text = doc.lineAt(realBodyStart).text;
    if (text.trim().length > 0) {
      break;
    }
    realBodyStart++;
  }

  if (realBodyStart <= endLine) {
    bodyRange = new vscode.Range(
      realBodyStart,
      0,
      endLine,
      endLineText.length
    );
  }

  return { fullRange, bodyRange };
}

// Helper to get ranges excluding code blocks
function getRangesExcludingCodeBlocks(document, startPos, endPos) {
  const fullRange = new vscode.Range(startPos, endPos);
  const text = document.getText(fullRange);

  // Count effective code block markers (```)
  const matches = [...text.matchAll(/```/g)];
  // If odd number of markers, block structure is broken/unclosed -> fallback to full selection
  if (matches.length % 2 !== 0) {
    return [new vscode.Selection(startPos, endPos)];
  }

  // If no code blocks or even number (closed), exclude them
  const ranges = [];
  let currentIndex = 0;

  // Regex to find code blocks: ```...``` (lazy match)
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match;

  const startOffset = document.offsetAt(startPos);

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Add text before the code block
    if (match.index > currentIndex) {
      const segStart = document.positionAt(startOffset + currentIndex);
      const segEnd = document.positionAt(startOffset + match.index);
      ranges.push(new vscode.Selection(segStart, segEnd));
    }
    currentIndex = match.index + match[0].length;
  }

  // Add remaining text after last code block
  if (currentIndex < text.length) {
    const segStart = document.positionAt(startOffset + currentIndex);
    const segEnd = document.positionAt(startOffset + text.length);
    ranges.push(new vscode.Selection(segStart, segEnd));
  }

  return ranges.length > 0 ? ranges : [new vscode.Selection(startPos, endPos)];
}

function cmdSelectHeadingSection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      "カーソル行または上方向にMarkdownの見出しが見つかりません。"
    );
    return;
  }

  editor.selections = getRangesExcludingCodeBlocks(
    editor.document,
    section.fullRange.start,
    section.fullRange.end
  );

  vscode.window.setStatusBarMessage("見出しセクションを選択（コードブロック除外）。", 2000);
}

function cmdSelectHeadingSectionBody() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      "カーソル行または上方向にMarkdownの見出しが見つかりません。"
    );
    return;
  }
  if (!section.bodyRange) {
    vscode.window.showInformationMessage(
      "見出し行と直後の行のみで選択範囲がありません。"
    );
    return;
  }

  editor.selections = getRangesExcludingCodeBlocks(
    editor.document,
    section.bodyRange.start,
    section.bodyRange.end
  );

  vscode.window.setStatusBarMessage(
    "見出し行と直後の行を除いてセクションを選択（コードブロック除外）。",
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

// FoldingRangeProvider
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

// DocumentSymbolProvider (Outline)
class HeadingSymbolProvider {
  provideDocumentSymbols(document, token) {
    if (token?.isCancellationRequested) return [];

    const lang = (document.languageId || "").toLowerCase();
    if (!(lang === "plaintext" || lang === "novel")) return [];

    const heads = getHeadingsCached(document);
    if (heads.length === 0) return [];

    const syms = [];
    const stack = [];

    for (let idx = 0; idx < heads.length; idx++) {
      const { line, level, text } = heads[idx];

      let endLine = document.lineCount - 1;
      for (let j = idx + 1; j < heads.length; j++) {
        if (heads[j].level <= level) {
          endLine = heads[j].line - 1;
          break;
        }
      }

      const title = text.replace(/^#+\s*/, "").trim() || `Heading L${level}`;
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
        "",
        vscode.SymbolKind.Namespace,
        range,
        selectionRange
      );

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

// ============================================================
//  Init & Registration
// ============================================================

/**
 * 見出し機能の初期化（コマンド／プロバイダ／イベントをまとめて登録）
 * @param {vscode.ExtensionContext} context
 * @param {{ cfg: ()=>any, isTargetDoc: (doc:any, c:any)=>boolean, sb?: any, semProvider?: any }} helpers
 */
function initHeadings(context, helpers) {
  const { cfg, isTargetDoc, sb } = helpers;

  // 1. Sidebar Provider
  const provider = new HeadingsProvider(helpers);
  const tree = vscode.window.createTreeView("posNoteHeadings", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(tree);

  // 2. Minimap Decorations
  const decoTypes = makeDecorationTypes();
  context.subscriptions.push({
    dispose: () => decoTypes.forEach((d) => d.dispose()),
  });

  // 3. Central Update Logic
  let debounceUpdate = null;

  function doUpdate(ed, forceMinimap) {
      const c = helpers.cfg();

      // 1. Editor Decoration (Priority High: User focus)
      if (c.headingsShowBodyCounts) {
        updateHeadingCountDecorations(ed, helpers.cfg);
      }

      // 2. Defer others to next tick to prioritize Editor rendering
      setTimeout(() => {
        // Minimap
        if (helpers.isTargetDoc(ed.document, c)) {
          applyMinimapDecorations(ed, decoTypes, forceMinimap);
        }
          // Sidebar update
        provider.refresh();
      }, 0);
  }

  function updateAll(ed, options = {}) {
    if (!ed) return;
    // Options handling (backward compatibility for boolean which was forceMinimap)
    const forceMinimap = (typeof options === 'boolean') ? options : (options.forceMinimap || false);
    const immediate = (typeof options === 'object') ? (options['immediate'] || false) : false;

    if (debounceUpdate) clearTimeout(debounceUpdate);

    if (immediate) {
      doUpdate(ed, forceMinimap);
      return;
    }

    debounceUpdate = setTimeout(() => {
      doUpdate(ed, forceMinimap);
    }, 200);
  }

  // 4. Register Commands (Navigation, Folding, Select, Refresh)
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.headings.refresh", () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand("posNote.headings.reveal", revealHeading),
    vscode.commands.registerCommand("posNote.headings.minimapRefresh", () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) updateAll(ed, true);
    }),
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings({ cfg, sb: helpers.sb })
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

  // 5. Register Providers (Folding, Symbols)
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" },
    { language: "Novel", scheme: "untitled" },
  ];
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      selector,
      new HeadingFoldingProvider(cfg)
    ),
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new HeadingSymbolProvider()
    )
  );

  // 6. Event Listeners
  updateAll(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => updateAll(ed, true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("posNote")) {
        updateAll(vscode.window.activeTextEditor, true);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      _minimapCache.delete(doc.uri.toString());
      invalidateHeadingCache(doc);
    }),
  );

  return {
    provider,
    refresh: (ed, opts) => updateAll(ed, opts),
  };
}

module.exports = { initHeadings, findHeadingSection };
