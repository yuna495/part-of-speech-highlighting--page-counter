const vscode = require("vscode");
const { DEFAULT_BANNED_START } = require("./status_bar");

/**
 * ページビュー（縦書き・原稿用紙風）パネル
 */
class PageViewPanel {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this._context = context;
    this._panel = undefined;
    this._disposables = [];
  }

  static createOrShow(context) {
    const column = vscode.ViewColumn.Active;

    // 既存ならそこへフォーカス
    if (PageViewPanel.currentPanel) {
      PageViewPanel.currentPanel._panel.reveal(column);
      return;
    }

    // 新規作成
    const panel = vscode.window.createWebviewPanel(
      "posNotePageView",
      "縦書きプレビュー",
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath)],
      }
    );

    PageViewPanel.currentPanel = new PageViewPanel(context);
    PageViewPanel.currentPanel._panel = panel;
    PageViewPanel.currentPanel._init();
  }

  _init() {
    const panel = this._panel;
    panel.onDidDispose(() => this.dispose(), null, this._disposables);

    panel.webview.html = this._getHtmlForWebview(panel.webview);

    // 初期表示
    this._update();

    // イベントリスナー
    const debounce = (func, wait) => {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    };

    const onDocChange = debounce(() => {
        if (this._panel.visible) {
            this._update();
        }
    }, 500);

    vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            onDocChange();
        }
    }, null, this._disposables);

    vscode.window.onDidChangeActiveTextEditor(() => {
        this._update();
    }, null, this._disposables);

    // メッセージ受信 (再描画要求など)
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === "refresh") {
            this._update();
        } else if (msg.type === "askPageJump") {
            // ページジャンプ入力
            const total = msg.total || 1;
            vscode.window.showInputBox({
                prompt: `移動先のページ番号 (1〜${total})`,
                placeHolder: "ページ番号",
                validateInput: (v) => {
                    const n = parseInt(v, 10);
                    if (isNaN(n) || n < 1 || n > total) return "範囲外のページ番号です";
                    return null;
                }
            }).then(val => {
                if (val) {
                    const page = parseInt(val, 10);
                    this._panel.webview.postMessage({ type: "jumpTo", page });
                }
            });
        }
    }, null, this._disposables);
  }

  dispose() {
    PageViewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  _update() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._panel) return;

    this._panel.title = "縦書き: " + editor.document.fileName.split(/[/\\]/).pop();

    const cfg = vscode.workspace.getConfiguration("posNote");
    const rowsPerNote = cfg.get("Note.rowsPerNote", 20);
    const colsPerRow = cfg.get("Note.colsPerRow", 20);
    const kinsokuEnabled = cfg.get("kinsoku.enabled", true);

    // 禁則文字設定（独自設定があれば取得、なければデフォルト）
    const userBanned = cfg.get("kinsoku.bannedStart");
    const bannedChars = (Array.isArray(userBanned) && userBanned.length > 0)
        ? userBanned
        : DEFAULT_BANNED_START;

    const text = editor.document.getText();
    const pages = this._paginateText(text, rowsPerNote, colsPerRow, kinsokuEnabled, bannedChars);

    this._panel.webview.postMessage({
      type: "update",
      payload: {
        pages,
        rowsPerNote,
        colsPerRow
      }
    });
  }

  /**
   * テキストをページ分割する
   */
  _paginateText(text, rowsPerNote, colsPerRow, kinsokuEnabled, bannedChars) {
    // 改行正規化
    let safeText = text.replace(/\r\n/g, "\n");

    // コードフェンス除去（行単位で処理して、行数カウントにも含めない）
    const rawLines = safeText.split("\n");
    const lines = [];
    let inFence = false;
    for (const line of rawLines) {
        if (line.trim().startsWith("```")) {
            inFence = !inFence;
            continue; // フェンス行自体も除外
        }
        if (inFence) {
            continue; // フェンス内の行も除外
        }
        lines.push(line);
    }
    const bannedSet = new Set(kinsokuEnabled ? bannedChars : []);

    let pages = [];
    let currentLines = [];

    for (let rawLine of lines) {
        // 空行対応：全角スペースを入れて1行確保（または空文字でもCSSでmin-heightがあればよいが、文字として扱うほうが安全）
        if (rawLine.length === 0) {
            currentLines.push("\u3000"); // 全角スペース1つで空行を表現
            if (currentLines.length >= rowsPerNote) {
                pages.push(currentLines);
                currentLines = [];
            }
            continue;
        }

        // 見出し置換（#+ のあとにスペースがある場合、全角スペース3つに）
        rawLine = rawLine.replace(/^#+\s+/, "\u3000\u3000\u3000");

        // 文字の切り出し（禁則対応）
        const chars = Array.from(rawLine);
        let pos = 0;
        const len = chars.length;

        while (pos < len) {
            let take = colsPerRow;

            // 禁則処理：次行の1文字目が禁則文字なら、今の行に収める（ぶら下げ）
            // 最大2文字まで拡張
            if (kinsokuEnabled) {
                const maxExtend = 2;
                let extended = 0;
                // まだ文字があり、かつ次の行頭になる文字が禁則の場合
                while (
                    pos + take + extended < len &&
                    bannedSet.has(chars[pos + take + extended]) &&
                    extended < maxExtend
                ) {
                    extended++;
                }
                take += extended;
            }

            // 切り出し
            // 今回の「行」が確定
            const lineStr = chars.slice(pos, pos + take).join("");
            currentLines.push(lineStr);

            pos += take;

            // ページ送り判定
            if (currentLines.length >= rowsPerNote) {
                pages.push(currentLines);
                currentLines = [];
            }
        }
    }

    // 残りがあればページ追加
    if (currentLines.length > 0) {
        pages.push(currentLines);
    }
    // 空ファイル対応
    if (pages.length === 0) {
        pages.push([""]);
    }

    return pages;
  }

  _getHtmlForWebview(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>縦書きプレビュー</title>
  <style>
    :root {
      --font-size: 20px;
      --line-height-ratio: 1.7;
      --rows: 20;
      --cols: 20;
    }
    html, body {
      margin: 0; padding: 0;
      width: 100vw; height: 100vh;
      overflow: hidden;
      background-color: #1a1a1a;
      color: #eee;
      font-family: serif;
    }

    #container {
      display: flex;
      flex-direction: row-reverse;
      width: 100%;
      height: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;

      /* コンテナ自体のpaddingはあってもいいが、page側で制御する */
      box-sizing: border-box;
    }

    /* 各ページ */
    .page {
      flex: 0 0 100vw;
      height: 100vh;
      scroll-snap-align: center;

      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;

      /* ページ外周の余白 */
      padding: 40px; /* 少し大きめに */
      box-sizing: border-box;
    }

    /* 本文表示エリア（原稿用紙部分） */
    .page-content {
      writing-mode: vertical-rl;
      font-size: var(--font-size);
      line-height: var(--line-height-ratio);

      /* 固定サイズ：行数・文字数に基づく */
      /* 幅（Horizontal）: 行数 * (文字サイズ * 行間) */
      width: calc(var(--rows) * var(--font-size) * var(--line-height-ratio));

      /* 高さ（Vertical）: 文字数 * 文字サイズ */
      /* ※文字間 (letter-spacing) が 0 なら */
      height: calc((var(--cols) + 2) * var(--font-size));

      /* 罫線：最初の行の右（＝Block Start）、最後の行の左（＝Block End） */
      border-right: 1px solid #666;
      border-left: 1px solid #666;

      /* ボックス内での配置 */
      /* margin: auto; flexで中央寄せ済み */

      /* テキストが少ない場合もボックスサイズを維持 */
      flex-shrink: 0;
    }

    /* 行ごとのスタイル */
    p {
      margin: 0;
      padding: 0;
      font-feature-settings: "palt" 0;
    }

    /* フッター */
    #footer {
      position: fixed;
      bottom: 30px; /* 少し上げる */
      left: 0;
      width: 100%;
      height: 30px;
      pointer-events: none; /* 下のクリックを邪魔しないようにするならnoneだが、ボタン押せなくなる */
      /* page-infoだけクリックさせたい */
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      font-family: sans-serif;
      font-size: 14px; /* 少し大きく */
      color: #ccc;
    }
    #page-info {
      pointer-events: auto;
      cursor: pointer;
      padding: 4px 12px;
      border-radius: 16px;
      background: rgba(0,0,0,0.5); /* 背景追加 */
    }
    #page-info:hover {
      background: rgba(255,255,255,0.2);
      color: #fff;
    }
  </style>
</head>
<body>
  <div id="container"></div>
  <div id="footer">
    <span id="page-info" title="クリックでページ移動">-- / --</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('container');
    const pageInfo = document.getElementById('page-info');

    let state = { pages: [], rows: 20, cols: 20 };

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        render(msg.payload);
      } else if (msg.type === 'jumpTo') {
        jumpToPage(msg.page);
      }
    });

    // リサイズ監視
    window.addEventListener('resize', () => {
      adjustFontSize();
    });

    // スクロール連動してページ番号更新
    container.addEventListener('scroll', () => {
      updatePageInfo();
    });

    // ホイール処理（縦スクロール → 横スクロール変換）
    // Shiftキーなしでも横スクロールするように
    container.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

      const delta = e.deltaY;
      container.scrollBy({ left: -delta, behavior: 'auto' });
      e.preventDefault();
    }, { passive: false });

    // クリック処理（ページ送り）
    container.addEventListener('click', (e) => {
      // footer等は無視
      if (e.target.closest('#footer')) return;

      const w = window.innerWidth;
      // 左右クリックでページ送り
      if (e.clientX < w / 2) {
        // Left -> Next
        container.scrollBy({ left: -w, behavior: 'smooth' });
      } else {
        // Right -> Prev
        container.scrollBy({ left: w, behavior: 'smooth' });
      }
    });

    // ページ番号クリック
    pageInfo.addEventListener('click', () => {
      vscode.postMessage({ type: 'askPageJump', total: state.pages.length });
    });

    function render(payload) {
      state.pages = payload.pages;
      state.rows = payload.rowsPerNote;
      state.cols = payload.colsPerRow;

      container.innerHTML = '';

      // row-reverse なので、配列先頭(Page 1)がDOM最後に追加されると「左端」になってしまう？
      // いいえ。row-reverse は "item1 item2 item3" を "item3 item2 item1" と右から並べる。
      // なので、pages[0] を最初に追加すれば、それが一番右になる。

      state.pages.forEach((lines, idx) => {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page';
        pageDiv.dataset.idx = idx;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'page-content';
        contentDiv.innerHTML = lines.map(line => \`<p>\${escapeHtml(line)}</p>\`).join('');

        pageDiv.appendChild(contentDiv);
        container.appendChild(pageDiv);
      });

      adjustFontSize();

      // 初期位置（1ページ目＝右端）へ
      setTimeout(() => {
        if (container.firstElementChild) {
           container.firstElementChild.scrollIntoView({ inline: 'start' });
        }
      }, 50);

      updatePageInfo();
    }

    function jumpToPage(pageOneBased) {
        // pageOneBased: 1, 2, ...
        // Index: 0, 1, ...
        // DOM要素: container.children[idx]
        const idx = pageOneBased - 1;
        if (container.children[idx]) {
            container.children[idx].scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }

    function adjustFontSize() {
      const W = window.innerWidth;
      const H = window.innerHeight;

      const rows = state.rows;
      const cols = state.cols;
      const lineHeightRatio = 1.7;

      // 目標: page-content が 画面(W, H) - padding に収まる最大フォントサイズ
      // page-content 幅 = rows * fontSize * 1.7
      // page-content 高さ = cols * fontSize
      // page padding = 40px * 2 = 80px

      const safeW = W - 80;
      const safeH = H - 80;

      const vFit = safeH / cols;
      const hFit = safeW / (rows * lineHeightRatio);

      const fontSize = Math.min(vFit, hFit);

      document.documentElement.style.setProperty('--font-size', fontSize + 'px');
      document.documentElement.style.setProperty('--rows', rows);
      document.documentElement.style.setProperty('--cols', cols);
    }

    function updatePageInfo() {
      // 中央点にある要素を取得
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const el = document.elementFromPoint(cx, cy);
      const pageEl = el ? el.closest('.page') : null;

      if (pageEl) {
        const idx = parseInt(pageEl.dataset.idx, 10);
        state.currentPage = idx + 1;
        const total = state.pages.length;
        pageInfo.textContent = \`\${idx + 1} / \${total}\`;
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// シングルトン保持用
PageViewPanel.currentPanel = undefined;

module.exports = PageViewPanel;
