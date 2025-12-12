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

    // 更新処理のデバウンス
    const onDocChange = debounce(() => {
        if (this._panel.visible) {
            this._update();
        }
    }, 500);

    vscode.workspace.onDidChangeTextDocument((e) => {
        if (this._targetEditor && e.document === this._targetEditor.document) {
            onDocChange();
        }
    }, null, this._disposables);

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            this._targetEditor = editor;
            this._update();
        }
    }, null, this._disposables);

    // メッセージ受信
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === "refresh") {
            // リフレッシュ時は強制的に現在の保持しているドキュメントで更新
            this._update();
        } else if (msg.type === "askPageJump") {
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
                    if (!isNaN(page) && page >= 1 && page <= total) {
                        this._panel.webview.postMessage({ type: "jumpTo", page });
                    }
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
    if (!this._panel) return;

    // アクティブエディタが無い場合（Webviewフォーカス時など）は、最後に記憶したエディタを使う
    const editor = vscode.window.activeTextEditor || this._targetEditor;
    if (!editor) return;

    // 記憶も更新
    this._targetEditor = editor;

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
        rawLine = rawLine.replace(/^(#+)\s+/, (match, hashes) => {
            return "\u3000".repeat(hashes.length + 1);
        });

        // トークン化
        const tokens = this._tokenizeLine(rawLine);

        let tokenIdx = 0;

        while (tokenIdx < tokens.length) {
            let lineStr = "";
            let currentLen = 0;

            // 1. まずは行容量 (colsPerRow) いっぱいまで埋める
            while (tokenIdx < tokens.length) {
                const token = tokens[tokenIdx];
                if (currentLen + token.length > colsPerRow) {
                    break;
                }
                lineStr += token.html;
                currentLen += token.length;
                tokenIdx++;
            }

            // 2. ぶら下げ処理 (status_bar.js: wrappedRowsForText 互換)
            // 次に来る文字が禁則文字なら、最大2文字分まで拡張して取り込む
            if (kinsokuEnabled) {
                let extended = 0;
                const MAX_EXTEND = 2; // status_bar.js に合わせる

                while (tokenIdx < tokens.length && extended < MAX_EXTEND) {
                    const token = tokens[tokenIdx];
                    // トークンの先頭文字が禁則かどうか判定
                    // bannedChars check uses the first char of the token
                    if (token.firstChar && bannedSet.has(token.firstChar)) {
                        // 拡張した場合の長さチェック (colsPerRow + 2 を超えないこと)
                        if (currentLen + token.length <= colsPerRow + MAX_EXTEND) {
                            lineStr += token.html;
                            currentLen += token.length;
                            // extended は文字数ベースで増やす（status_bar.jsは char単位ループなので）
                            extended += token.length;
                            tokenIdx++;
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }

            // 行が空（1つも入らなかった＝巨大トークン等）なら強制的に1つ入れる
            if (currentLen === 0 && tokenIdx < tokens.length) {
                const token = tokens[tokenIdx];
                lineStr += token.html;
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
                // 通常文字もすべて <span> で囲み、1文字1マスを強制する
                tokens.push({
                    type: 'char',
                    char: char,
                    firstChar: char,
                    length: 1,
                    html: `<span class="char">${this._escapeHtml(char)}</span>`
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
            firstChar: base[0],
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
                firstChar: char,
                length: 1,
                html: `<span class="char">${this._escapeHtml(char)}</span>`
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
    const baseLen = base.length;
    // ルビブロック全体の高さを親文字数に合わせる
    // vertical-rl における height は文字の積み上げ方向の長さ
    const style = `style="height: ${baseLen}em;"`;

    const baseChars = [...base];
    const onlyDots = reading.replace(/・/g, "") === "";

    if (onlyDots) {
        const pairs = baseChars.map(c => `<rb>${esc(c)}</rb><rt>・</rt>`).join("");
        return `<ruby class="rb-group" ${style}>${pairs}</ruby>`;
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
        return `<ruby class="rb-group" ${style}>${pairs}</ruby>`;
    }

    return `<ruby ${style}><rb>${esc(base)}</rb><rt>${esc(reading)}</rt></ruby>`;
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
      background-color: #101010;
      color: #eee;
      /* 1マス1文字レイアウト (Grid/Lattice behavior) for proper alignment */
      font-family: "HiraMinProN-W3", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS Mincho", "TakaoMincho", serif;
      font-variant-east-asian: full-width;
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
      border-right: 1px solid #444;
      border-left: 1px solid #444;

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

    /* 文字単位のスタイル：1文字1マスを強制 */
    .char {
        display: inline-flex;
        width: 1em;
        height: 1em;
        justify-content: center;
        align-items: center;
        /* 行方向のズレを防ぐ */
        vertical-align: middle;
    }

    ruby {
        ruby-align: center;
        /* ruby要素自体もインラインブロック的に振る舞わせ、高さを指定できるようにする */
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        /* height はインラインスタイルで動的に指定される */
        width: 1em; /* 横幅は1行分 */
        vertical-align: middle;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    rb, rt {
       /* ensure contents are centered */
       text-align: center;
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
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    #refresh-btn {
      pointer-events: auto;
      cursor: pointer;
      background: transparent;
      border: none;
      color: #fff;
      width: 24px; height: 24px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.3s;
    }
    #refresh-btn:hover {
      color: #fff;
    }
    #refresh-btn svg {
      width: 18px; height: 18px;
      fill: currentColor;
    }
    #refresh-btn.spinning svg {
        animation: spin 1s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="container"></div>
  <div id="footer">
    <button id="refresh-btn" title="更新">
        <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
    </button>
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
      refreshBtn.classList.add('spinning');
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
      refreshBtn.classList.remove('spinning');

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
