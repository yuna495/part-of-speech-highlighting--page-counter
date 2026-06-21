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

/** 見出しビューのWebviewViewプロバイダー。 */
class HeadingsWebviewProvider {
  constructor(helpers, context) {
    this._helpers = helpers;
    this._context = context;
    this._view = undefined;
  }

  resolveWebviewView(webviewView, context, token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    const initialHeadings = this._collectHeadingsOfActiveEditor();
    webviewView.webview.html = this._getHtmlForWebview(
      webviewView.webview,
      initialHeadings,
    );

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case "reveal":
          vscode.commands.executeCommand(
            "posNote.headings.reveal",
            vscode.Uri.parse(data.uri),
            data.line,
          );
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });
  }

  refresh() {
    if (!this._view) return;
    const headings = this._collectHeadingsOfActiveEditor();
    this._view.webview.postMessage({ type: "update", headings });
  }

  _collectHeadingsOfActiveEditor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return [];
    const { cfg, isTargetDoc } = this._helpers;
    const c = cfg();

    if (!isTargetDoc(ed.document, c)) return [];

    const doc = ed.document;
    const metrics = getHeadingMetricsCached(doc, c, vscode)?.items || [];
    const countByLine = new Map();
    for (const { line, own, sub } of metrics) {
      if (sub === 0) continue;
      let text = "";
      if (sub !== own) {
        text = `/ ${sub.toLocaleString("ja-JP")}字`;
      } else {
        text = `${own.toLocaleString("ja-JP")}字`;
      }
      countByLine.set(line, text);
    }

    const items = [];
    for (const m of metrics) {
      const label = stripHeadingMarkup(m.text);
      if (m.line === 0 && /^updated:\s*\d{4}-\d{1,2}-\d{1,2}/i.test(label)) {
        continue;
      }
      const countText = countByLine.get(m.line) || "";
      items.push({
        label: label,
        uri: doc.uri.toString(),
        line: m.line,
        level: m.level,
        countText: countText,
        children: [],
      });
    }

    const roots = [];
    const stack = [];

    for (const item of items) {
      while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(item);
      } else {
        const parent = stack[stack.length - 1];
        parent.children.push(item);
      }
      stack.push(item);
    }

    return roots;
  }

  _getHtmlForWebview(webview, initialHeadings) {
    const headingsJson = JSON.stringify(initialHeadings || []).replace(
      /</g,
      "\\u003c",
    );
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      padding: 0;
      margin: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background-color: var(--vscode-sideBar-background);
      user-select: none;
    }
    .tree-container {
      padding: 8px 0;
    }
    .tree-node {
      display: flex;
      flex-direction: column;
    }
    .tree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0px 2px 0px 8px;
      cursor: pointer;
      height: 22px;
      line-height: 22px;
    }
    .tree-item:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .tree-item-content {
      display: flex;
      align-items: center;
      flex-grow: 1;
      min-width: 0;
    }
    .arrow {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-right: 4px;
      color: var(--vscode-icon-foreground);
    }
    .arrow::before {
      content: '';
      display: inline-block;
      border-left: 5px solid currentColor;
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transition: transform 0.1s ease;
    }
    .arrow.expanded::before {
      transform: rotate(90deg);
    }
    .arrow.hidden::before {
      visibility: hidden;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-grow: 1;
    }
    .count {
      flex-shrink: 0;
      margin-left: 8px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .children {
      display: none;
    }
    .children.expanded {
      display: block;
    }
  </style>
</head>
<body>
  <div class="tree-container" id="container"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('container');
    const collapsedState = new Map();

    // 初期データ描画
    const initialHeadings = ${headingsJson};
    renderTree(initialHeadings);

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        renderTree(message.headings);
      }
    });

    function renderTree(headings) {
      container.innerHTML = '';
      if (!headings || headings.length === 0) {
        container.innerHTML = '<div style="padding: 8px; color: var(--vscode-descriptionForeground);">見出しはありません</div>';
        return;
      }

      const fragment = document.createDocumentFragment();
      buildTreeDOM(headings, fragment, 0);
      container.appendChild(fragment);
    }

    function buildTreeDOM(nodes, parentEl, level) {
      for (const node of nodes) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'tree-node';

        const itemEl = document.createElement('div');
        itemEl.className = 'tree-item';
        itemEl.style.paddingLeft = (level * 12 + 8) + 'px';

        const contentEl = document.createElement('div');
        contentEl.className = 'tree-item-content';

        const arrowEl = document.createElement('div');
        arrowEl.className = 'arrow';
        const hasChildren = node.children && node.children.length > 0;

        const nodeKey = node.uri + '#' + node.line;
        if (!collapsedState.has(nodeKey)) {
          collapsedState.set(nodeKey, false); // デフォルト展開
        }
        const isCollapsed = collapsedState.get(nodeKey);

        if (!hasChildren) {
          arrowEl.classList.add('hidden');
        } else if (!isCollapsed) {
          arrowEl.classList.add('expanded');
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'label';
        labelEl.textContent = node.label;
        labelEl.title = node.label;

        contentEl.appendChild(arrowEl);
        contentEl.appendChild(labelEl);

        const countEl = document.createElement('span');
        countEl.className = 'count';
        countEl.textContent = node.countText || '';

        itemEl.appendChild(contentEl);
        itemEl.appendChild(countEl);
        nodeEl.appendChild(itemEl);

        let childrenEl = null;
        if (hasChildren) {
          childrenEl = document.createElement('div');
          childrenEl.className = 'children';
          if (!isCollapsed) {
            childrenEl.classList.add('expanded');
          }
          buildTreeDOM(node.children, childrenEl, level + 1);
          nodeEl.appendChild(childrenEl);
        }

        itemEl.addEventListener('click', (e) => {
          if (e.target === arrowEl || arrowEl.contains(e.target)) {
            toggleNode(nodeKey, arrowEl, childrenEl);
          } else {
            vscode.postMessage({ type: 'reveal', uri: node.uri, line: node.line });
          }
        });

        parentEl.appendChild(nodeEl);
      }
    }

    function toggleNode(key, arrowEl, childrenEl) {
      if (!childrenEl) return;
      const wasCollapsed = collapsedState.get(key);
      const nowCollapsed = !wasCollapsed;
      collapsedState.set(key, nowCollapsed);

      if (nowCollapsed) {
        arrowEl.classList.remove('expanded');
        childrenEl.classList.remove('expanded');
      } else {
        arrowEl.classList.add('expanded');
        childrenEl.classList.add('expanded');
      }
    }
  </script>
</body>
</html>`;
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
    vscode.TextEditorRevealType.AtTop,
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
    }),
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
  return headings.filter((h) => h.level >= targetLevel).map((h) => h.line);
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
    vscode.TextEditorRevealType.Default,
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
    vscode.TextEditorRevealType.Default,
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
    bodyRange = new vscode.Range(realBodyStart, 0, endLine, endLineText.length);
  }

  return { fullRange, bodyRange };
}

function cmdSelectHeadingSection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      "カーソル行または上方向にMarkdownの見出しが見つかりません。",
    );
    return;
  }

  const { start, end } = section.fullRange;
  editor.selections = [new vscode.Selection(start, end)];

  vscode.window.setStatusBarMessage("見出しセクションを選択。", 2000);
}

function cmdSelectHeadingSectionBody() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const section = findHeadingSection(editor);
  if (!section) {
    vscode.window.showInformationMessage(
      "カーソル行または上方向にMarkdownの見出しが見つかりません。",
    );
    return;
  }
  if (!section.bodyRange) {
    vscode.window.showInformationMessage(
      "見出し行と直後の行のみで選択範囲がありません。",
    );
    return;
  }

  const { start, end } = section.bodyRange;
  editor.selections = [new vscode.Selection(start, end)];

  vscode.window.setStatusBarMessage("見出し本文を選択（見出し行除外）。", 2000);
}

async function cmdToggleFoldAllHeadings({ cfg, sb }) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  const c = cfg();
  const lang = (ed.document.languageId || "").toLowerCase();
  if (!(lang === "plaintext" || lang === "novel" || lang === "markdown")) {
    vscode.window.showInformationMessage(
      "このトグルは .txt / novel / .md でのみ有効です",
    );
    return;
  }
  if (!c.headingFoldEnabled) {
    vscode.window.showInformationMessage(
      "見出しの折りたたみ機能が無効です（posNote.headings.folding.enabled）",
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
        `展開対象の見出し（レベル${minLv}以上）は見つかりませんでした。`,
      );
      return;
    }

    const caret = ed.selection?.active ?? new vscode.Position(0, 0);
    const enclosing = findEnclosingHeadingLineFor(
      ed.document,
      caret.line,
      minLv,
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
            safeRestoreSelections[0].active,
          ),
          vscode.TextEditorRevealType.Default,
        );
      }
    }
    return;
  }

  const minLv = await resolveFoldMinLevel(ed.document, c);
  const lines = collectHeadingLinesByMinLevel(ed.document, minLv);
  if (lines.length === 0) {
    vscode.window.showInformationMessage(
      `折りたたみ対象の見出し（レベル${minLv}以上）は見つかりませんでした。`,
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
          safeRestoreSelections[0].active,
        ),
        vscode.TextEditorRevealType.Default,
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
          new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region),
        );
    }

    // ``` フェンス折りたたみ
    // および /* ... */ ブロックコメント折りたたみ
    const text = document.getText();
    const blockRegex = /```[\s\S]*?```|\/\*[\s\S]*?\*\//g;
    let match;
    while ((match = blockRegex.exec(text)) !== null) {
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);

      // 開始行と終了行が異なれば折りたたみ対象
      if (endPos.line > startPos.line) {
        ranges.push(
          new vscode.FoldingRange(
            startPos.line,
            endPos.line,
            vscode.FoldingRangeKind.Region,
          ),
        );
      }
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
        document.lineAt(endLine).text.length,
      );
      const selectionRange = new vscode.Range(
        line,
        0,
        line,
        document.lineAt(line).text.length,
      );
      const sym = new vscode.DocumentSymbol(
        title,
        "",
        vscode.SymbolKind.Namespace,
        range,
        selectionRange,
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

  // 1. Sidebar Webview Provider
  const provider = new HeadingsWebviewProvider(helpers, context);
  const tree = vscode.window.registerWebviewViewProvider(
    "posNoteHeadings",
    provider,
  );

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
    const forceMinimap =
      typeof options === "boolean" ? options : options.forceMinimap || false;
    const immediate =
      typeof options === "object" ? options["immediate"] || false : false;

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
      provider.refresh(),
    ),
    vscode.commands.registerCommand("posNote.headings.reveal", revealHeading),
    vscode.commands.registerCommand("posNote.headings.minimapRefresh", () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) updateAll(ed, true);
    }),
    vscode.commands.registerCommand("posNote.toggleFoldAllHeadings", () =>
      cmdToggleFoldAllHeadings({ cfg, sb: helpers.sb }),
    ),
    vscode.commands.registerCommand("posNote.headings.gotoPrev", () =>
      cmdMoveToPrevHeading(),
    ),
    vscode.commands.registerCommand("posNote.headings.gotoNext", () =>
      cmdMoveToNextHeading(),
    ),
    vscode.commands.registerCommand("posNote.headline.selectSection", () =>
      cmdSelectHeadingSection(),
    ),
    vscode.commands.registerCommand("posNote.headline.selectSectionBody", () =>
      cmdSelectHeadingSectionBody(),
    ),
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
      new HeadingFoldingProvider(cfg),
    ),
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new HeadingSymbolProvider(),
    ),
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
