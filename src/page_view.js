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
    const column = vscode.ViewColumn.Beside;

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

    // コードフェンス除去
    const rawLines = safeText.split("\n");
    const lines = [];
    let inFence = false;
    for (const line of rawLines) {
        if (line.trim().startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            continue;
        }
        lines.push(line);
    }
    const bannedSet = new Set(kinsokuEnabled ? bannedChars : []);

    let pages = [];
    let currentLines = [];

    for (let rawLine of lines) {
        if (rawLine.length === 0) {
            currentLines.push("\u3000");
            if (currentLines.length >= rowsPerNote) {
                pages.push(currentLines);
                currentLines = [];
            }
            continue;
        }

        // 見出し置換
        rawLine = rawLine.replace(/^#+\s+/, "\u3000\u3000\u3000");

        // トークン化（ルビと通常文字に分割）
        const tokens = this._tokenizeLine(rawLine);

        let tokenIdx = 0;

        while (tokenIdx < tokens.length) {
            // 1行(currentLine)を構築する
            let lineStr = "";
            let currentLen = 0; // 文字数カウント

            // 行容量いっぱいまでトークンを取り込む
            while (tokenIdx < tokens.length) {
                const token = tokens[tokenIdx];
                const tokenLen = token.length;

                // 次の1文字（またはルビブロック）が入るか？
                // 禁則処理：次が禁則で、かつ行頭に来てしまう場合、前の行に詰め込む？
                // ここでは「行の残り容量」と比較

                // 禁則判定用の先読み
                // もし次のトークンを入れるとあふれる場合...
                if (currentLen + tokenLen > colsPerRow) {
                   // あふれる。
                   // でも「ぶら下げ」が有効なら、禁則文字(length=1)は+2まで許容
                   if (kinsokuEnabled && tokenLen === 1 && bannedSet.has(token.char)) {
                       // ぶら下げ許容範囲内(colsPerRow + 2)か？
                       const maxLen = colsPerRow + 2;
                       if (currentLen + tokenLen <= maxLen) {
                           // OK, push it
                           lineStr += token.html;
                           currentLen += tokenLen;
                           tokenIdx++;
                           // ぶら下げ成功したら、その行はそこで終わり（無理やり詰め込んだので）
                           break;
                       }
                   }

                   // 収まらないので改行
                   break;
                }

                // 通常追加
                lineStr += token.html;
                currentLen += tokenLen;
                tokenIdx++;
            }

            currentLines.push(lineStr);

            if (currentLines.length >= rowsPerNote) {
                pages.push(currentLines);
                currentLines = [];
            }
        }
    }

    if (currentLines.length > 0) {
        pages.push(currentLines);
    }
    if (pages.length === 0) {
        pages.push([""]);
    }

    return pages;
  }

  _tokenizeLine(line) {
    const tokens = [];
    const RUBY_RE = /\|([^《》\|\n]+)《([^》\n]+)》/g;

    let lastIndex = 0;
    let match;

    // ルビ処理
    while ((match = RUBY_RE.exec(line)) !== null) {
        // マッチ前の通常文字
        if (match.index > lastIndex) {
            const plain = line.substring(lastIndex, match.index);
            for (const char of plain) {
                tokens.push({
                    type: 'char',
                    char: char,
                    length: 1,
                    html: this._escapeHtml(char)
                });
            }
        }

        // ルビ部分
        const base = match[1];
        const ruby = match[2];
        const rubyHtml = this._generateRubyHtml(base, ruby);
        // ルビブロックの長さは親文字の長さ
        tokens.push({
            type: 'ruby',
            length: base.length,
            html: rubyHtml
        });

        lastIndex = RUBY_RE.lastIndex;
    }

    // 残りの文字
    if (lastIndex < line.length) {
        const plain = line.substring(lastIndex);
        for (const char of plain) {
            tokens.push({
                type: 'char',
                char: char,
                length: 1,
                html: this._escapeHtml(char)
            });
        }
    }

    return tokens;
  }

  _escapeHtml(str) {
      return str.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
  }

  _generateRubyHtml(base, reading) {
    const esc = this._escapeHtml;
    // preview_panel.js から移植・簡略化
    const baseChars = [...base];
    const onlyDots = reading.replace(/・/g, "") === "";

    if (onlyDots) {
        const pairs = baseChars.map(c => `<rb>${esc(c)}</rb><rt>・</rt>`).join("");
        return `<ruby class="rb-group">${pairs}</ruby>`;
    }

    const hasSep = reading.includes("・");
    const readingParts = hasSep ? reading.split("・") : [...reading];
    const perChar = hasSep || readingParts.length === baseChars.length;

    if (perChar) {
        let pairs = "";
        for (let i = 0; i < baseChars.length; i++) {
             const rb = esc(baseChars[i]);
             const rt = esc(readingParts[i] ?? "");
             pairs += `<rb>${rb}</rb><rt>${rt}</rt>`;
        }
        return `<ruby class="rb-group">${pairs}</ruby>`;
    }

    return `<ruby><rb>${esc(base)}</rb><rt>${esc(reading)}</rt></ruby>`;
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
      height: 100%;
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
      border-right: 1px solid #333;
      border-left: 1px solid #333;

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

    ruby {
        ruby-align: center;
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
      gap: 16px; /* ボタンとの間隔 */
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
    #refresh-btn {
      pointer-events: auto;
      cursor: pointer;
      background: rgba(0,0,0,0.5);
      border: 1px solid #666;
      color: #fff;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
    }
    #refresh-btn:hover {
      background: #444;
    }
  </style>
</head>
<body>
  <div id="container"></div>
  <div id="footer">
    <button id="refresh-btn">更新</button>
    <span id="page-info" title="クリックでページ移動">-- / --</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('container');
    const pageInfo = document.getElementById('page-info');
    const refreshBtn = document.getElementById('refresh-btn');

    let state = { pages: [], rows: 20, cols: 20 };

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        render(msg.payload);
      } else if (msg.type === 'jumpTo') {
        jumpToPage(msg.page);
      }
    });

    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
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
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return; // 横スクロール成分が強ければブラウザに任せる

      const delta = e.deltaY;
      // "scrollLeft -= delta" で左へ（次へ）
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

        // すでにHTML化されているので escapeHtml はしない
        contentDiv.innerHTML = lines.map(line => \`<p>\${line}</p>\`).join('');

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

      // Vertical Padding:
      // #container: 10px top + 10px bottom = 20px
      // .page: 40px top + 40px bottom = 80px
      // Total V-Padding = 100px
      const safeH = H - 100;

      // Horizontal Padding:
      // .page: 40px left + 40px right = 80px
      const safeW = W - 80;

      // 縦方向の制約 (Height / (cols + 2文字分))
      // CSS height = calc((var(--cols) + 2) * var(--font-size))
      // なので、fontSize * (cols + 2) <= safeH
      const vFit = safeH / (cols + 2);

      // 横方向の制約
      // CSS width = calc(var(--rows) * var(--font-size) * var(--line-height-ratio))
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
