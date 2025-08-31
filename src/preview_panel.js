// preview_panel.js
// VS Code Extension: posNote — 縦書きプレビュー（保存時更新）
// 由来: Novel Preview（novelPreview.*）を posNote.* へ改名・統合

const vscode = require("vscode");
const fs = require("fs");

class PreviewPanel {
  static currentPanel = undefined;
  static viewType = "posNote.preview";

  constructor(panel, extensionUri, editor) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._editor = editor;
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

  static show(extensionUri) {
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

    PreviewPanel.currentPanel = new PreviewPanel(panel, extensionUri, editor);
  }

  static revive(panel, extensionUri, editor) {
    PreviewPanel.currentPanel = new PreviewPanel(panel, extensionUri, editor);
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
  _update(isFirst = false) {
    this._panel.title = "posNote Preview";

    // 直近のアクティブエディタ（Webview フォーカス中は undefined の可能性あり）
    const active = vscode.window.activeTextEditor;

    // エディタが生きていれば doc/uri を更新、なければ前回の _docUri を維持
    if (active && active.document) {
      this._editor = active;
      this._docUri = active.document.uri;
    }

    // ここで doc を決定：アクティブが無ければ、URI一致の既存 TextDocument を探す
    let doc = undefined;
    if (this._editor && this._editor.document) {
      doc = this._editor.document;
    } else if (this._docUri) {
      doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === this._docUri.toString()
      );
    }

    // どちらも取れない場合は「何もしない」→ 空更新で消さない
    if (!doc) {
      // 初期化だけ必要なら HTML を張る（空送信はしない）
      if (!this._initialized || isFirst) {
        this._panel.webview.html = this._getHtmlForWebview();
        this._initialized = true;
      }
      return;
    }

    // テキスト・位置情報を doc ベースで取得（エディタが無ければ 0 にフォールバック）
    const text = doc.getText();
    const offset = this._editor
      ? doc.offsetAt(this._editor.selection.anchor)
      : 0;
    const activeLine = this._editor ? this._editor.selection.active.line : 0;

    // === 設定（posNote.Preview） ===
    const config = vscode.workspace.getConfiguration("posNote.Preview");
    const fontSizeNum = clampNumber(config.get("fontSize", 20), 8, 72);
    const fontsize = `${fontSizeNum}px`;
    const showCursor = !!config.get("showCursor", false);
    const fontfamily = "";

    const bgColor = config.get("backgroundColor", "#111111");
    const textColor = config.get("textColor", "#fafafafa");
    const activeBg = config.get(
      "activeLineBackground",
      "rgba(150, 100, 0, 0.1)"
    );

    // カーソル表示有効時のみ利用
    const symbol = "|";
    const position = showCursor ? "inner" : "none";

    if (!this._initialized || isFirst) {
      this._panel.webview.html = this._getHtmlForWebview();
      this._initialized = true;
    }

    // webview へ差分データを送る（空文字は送らない）
    this._panel.webview.postMessage({
      type: "update",
      payload: {
        text,
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
