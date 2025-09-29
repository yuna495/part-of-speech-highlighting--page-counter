// preview_panel.js
// VS Code Extension: posNote — 縦書きプレビュー（保存時更新）
// 由来: Novel Preview（novelPreview.*）を posNote.* へ改名・統合

const vscode = require("vscode");
const fs = require("fs");

// === Ruby placeholder extraction (占位化) ===
const RUBY_RE = /\|([^《》\|\n]+)《([^》\n]+)》/g;
// 私用領域(U+E000〜)にインデックスを埋め込んだ占位マーカーを作る
const PH = (i) => `\uE000RB${i}\uE001`;

function extractRubyPlaceholders(input) {
  if (!input || typeof input !== "string") {
    return { textWithPH: input || "", rubyHtmlList: [] };
  }
  let idx = 0;
  const rubyHtmlList = [];
  const textWithPH = input.replace(RUBY_RE, (_, base, reading) => {
    const html = generateRubyHtml(base, reading);
    rubyHtmlList.push(html);
    return PH(idx++);
  });
  return { textWithPH, rubyHtmlList };
}

// |基《よみ》 → <ruby>…> 生成規則：
//  1) 読みに "・" がある → その区切りで**各文字対応**
//  2) "・" が無く、基と読みの長さが等しい → **各文字対応**
//  3) それ以外 → 単語ルビ（基語全体にひとつの rt）
//
// 追加仕様：読みが「・」だけ（= 全部削ると空）なら、基文字数ぶん「・」を配る。
function generateRubyHtml(base, reading) {
  const baseChars = [...base];
  const esc = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const onlyDots = reading.replace(/・/g, "") === "";
  if (onlyDots) {
    // 例: |文《・》, |天地《・・》 など
    const pairs = [];
    for (let i = 0; i < baseChars.length; i++) {
      const rb = esc(baseChars[i]);
      const rt = "・";
      pairs.push(`<rb>${rb}</rb><rt>${rt}</rt>`);
    }
    return `<ruby class="rb-group">${pairs.join("")}</ruby>`;
  }

  const hasSep = reading.includes("・");
  const readingParts = hasSep ? reading.split("・") : [...reading];
  const perChar = hasSep || readingParts.length === baseChars.length;

  if (perChar) {
    const n = baseChars.length;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const rb = esc(baseChars[i]);
      const rt = esc(readingParts[i] ?? "");
      pairs.push(`<rb>${rb}</rb><rt>${rt}</rt>`);
    }
    return `<ruby class="rb-group">${pairs.join("")}</ruby>`;
  } else {
    return `<ruby><rb>${esc(base)}</rb><rt>${esc(reading)}</rt></ruby>`;
  }
}

// === Ellipsis placeholder extraction (「……」→占位) ===
// 「……」(U+2026 × 2) を占位文字へ置換し、完成HTMLは配列に積む
const ELLIPSIS_RE = /…{2}/g; // 三点リーダー2つ
const PHE = (i) => `\uE000EL${i}\uE001`; // 占位マーカー（EL）

function extractEllipsisPlaceholders(input) {
  if (!input || typeof input !== "string") {
    return { textWithPH: input || "", ellipsisHtmlList: [] };
  }
  let idx = 0;
  const ellipsisHtmlList = [];
  const textWithPH = input.replace(ELLIPSIS_RE, () => {
    const html = `<span class="ellipsis">……</span>`;
    ellipsisHtmlList.push(html);
    return PHE(idx++);
  });
  return { textWithPH, ellipsisHtmlList };
}

class PreviewPanel {
  static currentPanel = undefined;
  static viewType = "posNote.preview";

  constructor(panel, extensionUri, editor, context) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._editor = editor;
    this._context = context;
    this._docUri = editor?.document?.uri;
    this._disposables = [];
    this._initialized = false;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) this._update();
      },
      null,
      this._disposables
    );

    // Webview → Extension（プレビュー側クリックでエディタへジャンプ）
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (!message) return;
        if (message.type === "jumpToLine") {
          const line = Number.isInteger(message.line) ? message.line : 0;

          try {
            const uri = this._docUri;
            if (!uri) {
              const active = vscode.window.activeTextEditor;
              if (!active) return;
              await focusEditorAndJump(active, line);
              return;
            }

            // すでに開いている同一文書を探す（複製回避）
            const opened = vscode.window.visibleTextEditors.find(
              (e) => e.document?.uri?.toString() === uri.toString()
            );

            if (opened) {
              const editor = await vscode.window.showTextDocument(
                opened.document,
                {
                  viewColumn: opened.viewColumn,
                  preserveFocus: false,
                  preview: false,
                }
              );
              await focusEditorAndJump(editor, line);
            } else {
              // 未オープンなら左側で開く
              const doc = await vscode.workspace.openTextDocument(uri);
              const editor = await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: false,
                preview: false,
              });
              await focusEditorAndJump(editor, line);
            }
          } catch (err) {
            console.error("jumpToLine failed:", err);
          }
        }
      },
      null,
      this._disposables
    );

    this._update(true);
  }

  static show(extensionUri, context) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.Two;
    const editor = vscode.window.activeTextEditor;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel._panel.reveal(column);
      PreviewPanel.currentPanel._update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      "縦書きプレビュー",
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        retainContextWhenHidden: true,
      }
    );

    PreviewPanel.currentPanel = new PreviewPanel(
      panel,
      extensionUri,
      editor,
      context
    );
  }

  static revive(panel, extensionUri, editor, context) {
    PreviewPanel.currentPanel = new PreviewPanel(
      panel,
      extensionUri,
      editor,
      context
    );
  }

  dispose() {
    PreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  static update() {
    if (this.currentPanel) this.currentPanel._update();
  }

  // 軽量ハイライト更新（テキストは再送しない）
  static highlight(line) {
    const p = this.currentPanel;
    if (!p || !p._panel) return;

    // 対象ドキュメントが未確定のときは無視（空更新で消さない）
    if (!p._docUri) return;

    // Webview が初期化済みであれば、行番号だけ送る
    try {
      p._panel.webview.postMessage({
        type: "highlight",
        activeLine: Number.isInteger(line) ? line : 0,
      });
    } catch (e) {
      console.error("PreviewPanel.highlight failed:", e);
    }
  }

  // preview_panel.js 内
  async _update(isFirst = false) {
    this._panel.title = "posNote Preview";

    // アクティブエディタが無い（=Webviewにフォーカス）時でも doc を維持
    const active = vscode.window.activeTextEditor;
    if (active && active.document) {
      this._editor = active;
      this._docUri = active.document.uri;
    }
    let doc = this._editor?.document;
    if (!doc && this._docUri) {
      doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === this._docUri.toString()
      );
    }
    if (!doc) {
      if (!this._initialized || isFirst) {
        this._panel.webview.html = this._getHtmlForWebview();
        this._initialized = true;
      }
      return;
    }

    const text = doc.getText();
    const offset = this._editor
      ? doc.offsetAt(this._editor.selection.anchor)
      : 0;
    const activeLine = this._editor ? this._editor.selection.active.line : 0;

    // === 設定 ===
    const cfg = vscode.workspace.getConfiguration("posNote.Preview");
    const fontSizeNum = clampNumber(cfg.get("fontSize", 20), 8, 72);
    const fontsize = `${fontSizeNum}px`;
    const showCursor = !!cfg.get("showCursor", false);
    const fontfamily = "";
    const bgColor = cfg.get("backgroundColor", "#111111");
    const textColor = cfg.get("textColor", "#4dd0e1");
    const activeBg = cfg.get("activeLineBackground", "rgba(150, 100, 0, 0.1)");

    // POS ハイライト ON/OFF
    const posEnabled = !!cfg.get("posHighlight.enabled", false);
    const maxLines = cfg.get("posHighlight.maxLines", 1000);

    if (!this._initialized || isFirst) {
      this._panel.webview.html = this._getHtmlForWebview();
      this._initialized = true;
    }

    // === 行ごと完成HTMLを作る（ONのときのみ）★ここだけ残す／置き換える ===
    let isHtml = false;
    let textHtml = "";
    if (posEnabled) {
      try {
        const { toPosHtml } = require("./semantic");
        const { getHeadingLevel } = require("./utils"); // 見出し検出
        const headingDetector = (line) => {
          try {
            return getHeadingLevel ? getHeadingLevel(line) : 0;
          } catch {
            return 0;
          }
        };
        // 1) ルビを占位化
        const { textWithPH: withRubyPH, rubyHtmlList } =
          extractRubyPlaceholders(text);
        // 2) 三点リーダーを占位化（ルビの後）
        const { textWithPH: withEllipsisPH, ellipsisHtmlList } =
          extractEllipsisPlaceholders(withRubyPH);

        // Kuromoji には占位済みテキストを渡す（品詞タグとの競合回避）
        textHtml = await toPosHtml(withEllipsisPH, this._context, {
          maxLines, // 選択行を中心に、この行数だけ前後解析
          activeLine, // 選択行
          headingDetector,
          classPrefix: "pos-",
          docUri: doc.uri,
        });
        isHtml = true;
        // 追加：ユーザーの semanticTokenColorCustomizations.rules をプレビューCSSへ
        const { buildPreviewCssFromEditorRules } = require("./semantic");
        var tokenCss = buildPreviewCssFromEditorRules();
        // ★ 追加：復元用 HTML を payload に同梱するため、外側スコープで保持
        var rubyHtmlListToSend = rubyHtmlList;
        var ellipsisHtmlListToSend = ellipsisHtmlList;
      } catch (e) {
        console.error("toPosHtml failed; fallback to plain:", e);
        isHtml = false;
        textHtml = "";
        var tokenCss = "";
        var rubyHtmlListToSend = [];
        var ellipsisHtmlListToSend = [];
      }
    }

    // === 送信直前で未定義だった値を定義 ===
    const symbol = "|";
    const position = showCursor ? "inner" : "none";

    // webview へ差分データを送る（isHtml で描画ルートを分ける）
    this._panel.webview.postMessage({
      type: "update",
      payload: {
        isHtml,
        textHtml, // isHtml=true の時のみ使用
        text, // isHtml=false の時に paragraphsWithLine() へ
        offset,
        cursor: symbol,
        position,
        fontsize,
        fontfamily,
        activeLine,
        showCursor,
        bgColor,
        textColor,
        activeBg,
        tokenCss,
        rubyHtmlList: rubyHtmlListToSend || [],
        ellipsisHtmlList: ellipsisHtmlListToSend || [],
      },
    });
  }

  _getHtmlForWebview() {
    const webview = this._panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this._extensionUri, "media");

    const indexPath = vscode.Uri.joinPath(mediaRoot, "index.html");
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "style.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "main.js")
    );
    const cspSource = webview.cspSource;
    const nonce = getNonce();

    let html = fs.readFileSync(indexPath.fsPath, "utf8");
    html = html
      .replace(/\{\{cspSource\}\}/g, cspSource)
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{nonce\}\}/g, nonce);

    return html;
  }
}

// ===== util =====
async function focusEditorAndJump(editor, line) {
  const doc = editor.document;
  const clamped = Math.max(0, Math.min(line, doc.lineCount - 1));
  const pos = new vscode.Position(clamped, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter
  );
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function clampNumber(n, min, max) {
  if (typeof n !== "number" || Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

module.exports = { PreviewPanel };
