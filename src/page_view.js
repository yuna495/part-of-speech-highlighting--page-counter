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

    // カーソル移動同期
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (this._targetEditor && e.textEditor === this._targetEditor && this._panel.visible) {
        const anchor = e.selections[0].anchor; // or active
        // character level sync
        this._panel.webview.postMessage({
          type: 'syncCursor',
          line: anchor.line,
          char: anchor.character
        });
      }
    }, null, this._disposables);

    // デフォルト表示モード (true: Page (Default)設定, false: Note設定)
    this._usePageSettings = false;

    // メッセージ受信
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "refresh") {
        // リフレッシュ時は強制的に現在の保持しているドキュメントで更新
        this._update();
      } else if (msg.type === "toggleMode") {
        // 表示モード切替
        this._usePageSettings = !this._usePageSettings;
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
      } else if (msg.type === "jumpToPosition") {
        // Webviewからのクリックでエディタ移動
        const line = msg.line;
        const char = msg.char;
        if (this._targetEditor && typeof line === 'number' && typeof char === 'number') {
            const pos = new vscode.Position(line, char);
            const sel = new vscode.Selection(pos, pos);
            this._targetEditor.selection = sel;
            this._targetEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            // エディタにフォーカスを戻す（お好みで）
            vscode.window.showTextDocument(this._targetEditor.document, {
                viewColumn: this._targetEditor.viewColumn,
                selection: new vscode.Range(pos, pos)
            });
        }
      } else if (msg.type === "exportPdf") {
        this._exportToPdf();
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
    const previewCfg = vscode.workspace.getConfiguration("posNote.Preview");

    // 設定値の取得 (Note用とPage用)
    const noteRows = cfg.get("Note.rowsPerNote", 20);
    const noteCols = cfg.get("Note.colsPerRow", 20);

    const pageRows = cfg.get("Page.defaultRows", 15);
    const pageCols = cfg.get("Page.defaultCols", 40);

    // モードに応じて切り替え
    const rowsPerNote = this._usePageSettings ? pageRows : noteRows;
    const colsPerRow = this._usePageSettings ? pageCols : noteCols;

    const kinsokuEnabled = cfg.get("kinsoku.enabled", true);

    // 禁則文字設定（独自設定があれば取得、なければデフォルト）
    const userBanned = cfg.get("kinsoku.bannedStart");
    const bannedChars = (Array.isArray(userBanned) && userBanned.length > 0)
      ? userBanned
      : DEFAULT_BANNED_START;

    const text = editor.document.getText();
    const pages = this._paginateText(text, rowsPerNote, colsPerRow, kinsokuEnabled, bannedChars);

    // 色指定の正規化ヘルパー (CSSとして有効にするため、HEXなら # を付与)
    const normalizeColor = (c) => {
      if (!c) return c;
      const s = c.trim();
      // "ff0000" や "FFF" のようなハッシュなしHEXに対応
      if (/^[0-9a-fA-F]{3,8}$/.test(s)) {
        return "#" + s;
      }
      return s;
    };

    const bgColorRaw = previewCfg.get("backgroundColor", "#101010");
    const textColorRaw = previewCfg.get("textColor", "#eeeeee");
    const fontFamily = previewCfg.get("fontFamily", "serif");

    this._panel.webview.postMessage({
      type: "update",
      payload: {
        pages,
        rowsPerNote,
        colsPerRow,
        isPageMode: this._usePageSettings,
        bgColor: normalizeColor(bgColorRaw),
        textColor: normalizeColor(textColorRaw),
        fontFamily
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
    // 元の行番号を維持するために、オブジェクトの配列として処理する
    const rawLines = safeText.split("\n").map((text, index) => ({ text, lineNo: index }));
    const lines = [];
    let inFence = false;
    for (const item of rawLines) {
      if (item.text.trim().startsWith("```")) {
        inFence = !inFence;
        continue; // フェンス行自体も表示しないなら continue
      }
      if (inFence) {
        continue;
      }
      lines.push(item);
    }
    const bannedSet = new Set(kinsokuEnabled ? bannedChars : []);

    let pages = [];
    let currentLines = [];

    for (let lineObj of lines) {
      let rawText = lineObj.text;
      const lineNo = lineObj.lineNo;

      if (rawText.length === 0) {
        currentLines.push("\u3000");
        if (currentLines.length >= rowsPerNote) {
          pages.push(currentLines);
          currentLines = [];
        }
        continue;
      }

      // 見出し置換（元の文字数とずれるが、行番号は維持される）
      // ※正確な文字単位の同期はずれる可能性があるが、行単位同期は確保
      rawText = rawText.replace(/^(#+)\s+/, (match, hashes) => {
          return "\u3000".repeat(hashes.length + 1);
      });

      // トークン化 (lineNo を渡す)
      const tokens = this._tokenizeLine(rawText, lineNo);

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

  async _exportToPdf() {
    // 1. puppeteer-core の読み込み
    let puppeteer;
    try {
      puppeteer = require('puppeteer-core');
    } catch (e) {
      vscode.window.showErrorMessage("PDF出力には 'puppeteer-core' が必要です。ターミナルで 'npm install puppeteer-core' を実行してください。");
      return;
    }

    // 2. ブラウザの検索
    const browserPath = this._findChromePath();
    if (!browserPath) {
      vscode.window.showErrorMessage("Chrome または Edge が見つかりませんでした。インストール場所を確認してください。");
      return;
    }

    // 3. 保存先決定
    const editor = this._targetEditor;
    if (!editor) return;
    const docPath = editor.document.uri.fsPath;
    const defaultPdfPath = docPath.replace(/\.(txt|md|novel)$/i, "") + ".pdf";

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPdfPath),
      filters: { 'PDF File': ['pdf'] }
    });
    if (!uri) return; // キャンセル

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "PDFを出力中...",
      cancellable: false
    }, async (progress) => {
      let browser;
      try {
        // 4. Puppeteer 起動
        browser = await puppeteer.launch({
          executablePath: browserPath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'] // 環境によっては必要
        });

        const page = await browser.newPage();

        // 5. PDF用HTML生成
        // 現在の設定（Page/Note）に基づくページ分割を取得
        const cfg = vscode.workspace.getConfiguration("posNote");
        const previewCfg = vscode.workspace.getConfiguration("posNote.Preview");

        const noteRows = cfg.get("Note.rowsPerNote", 20);
        const noteCols = cfg.get("Note.colsPerRow", 20);
        const pageRows = cfg.get("Page.defaultRows", 15);
        const pageCols = cfg.get("Page.defaultCols", 40);
        const rows = this._usePageSettings ? pageRows : noteRows;
        const cols = this._usePageSettings ? pageCols : noteCols;

        const kinsokuEnabled = cfg.get("kinsoku.enabled", true);
        const userBanned = cfg.get("kinsoku.bannedStart");
        const bannedChars = (Array.isArray(userBanned) && userBanned.length > 0) ? userBanned : DEFAULT_BANNED_START;

        const text = editor.document.getText();
        const pages = this._paginateText(text, rows, cols, kinsokuEnabled, bannedChars);

        const bgColor = previewCfg.get("backgroundColor", "#101010");

        const printBg = "#ffffff";
        const printFg = "#000000";

        // PDF用フォント（空ならプレビュー用を使う）
        let pdfFont = previewCfg.get("PDFoutputfontFamily", "");
        if (!pdfFont || pdfFont.trim() === "") {
          pdfFont = previewCfg.get("fontFamily", "serif");
        }

        const htmlContent = this._getHtmlForPdf(pages, rows, cols, printBg, printFg, pdfFont);

        // 大規模文書対応: タイムアウトを延長し、DOMの構築完了を待つ
        // (外部リソースがないため networkidle0 は不要)
        await page.setContent(htmlContent, {
          waitUntil: 'domcontentloaded',
          timeout: 120000  // 120秒
        });

        // 6. PDF出力
        await page.pdf({
          path: uri.fsPath,
          format: 'A4', // または width/height 指定
          printBackground: true,
          landscape: true
        });

        vscode.window.showInformationMessage(`PDFを出力しました: ${uri.fsPath}`);
      } catch (err) {
          console.error(err);
          vscode.window.showErrorMessage(`PDF出力失敗: ${err.message}`);
      } finally {
          if (browser) await browser.close();
      }
    });
  }

  _findChromePath() {
    const fs = require('fs');
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.CHROME_PATH
    ];
    for (const p of paths) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  _getHtmlForPdf(pages, rows, cols, bgColor, textColor, fontFamily) {
    // PDF出力用のシンプルなHTML
    // 1ページ = 1 div.page (break-after: always)
    return `<!DOCTYPE html>

    <html lang="ja">
    <head>
    <meta charset="UTF-8">
    <style>
      @page {
        size: A4;
        margin: 0;
      }
      body {
        margin: 0;
        padding: 0;
        background-color: ${bgColor};
        color: ${textColor};
        font-family: ${fontFamily};
      }
      .page {
        width: 100%;
        height: 100vh;
        page-break-after: always;
        break-after: always;

        display: flex;
        justify-content: center;
        align-items: center;
        box-sizing: border-box;
        /* 印刷用余白（A4内側） */
        padding: 20mm;
        position: relative;
      }
      .page-content {
        writing-mode: vertical-rl;
        font-size: 14pt; /* PDF用固定サイズあるいは計算 */
        line-height: 1.7;

        /* 行数・文字数で枠を固定 */
        height: calc((${cols} + 2) * 1em); /* 縦方向（文字数） */
        width: calc(${rows} * 1.7em);      /* 横方向（行数） */
      }

      p { margin: 0; padding: 0; text-align: justify; }
      .char { display: inline-block; width: 1em; height: 1em; text-align: center; }
      .tcy {
        display: inline-block;
        height: 1em;
        line-height: 1em;
        text-align: center;
        vertical-align: baseline;
        transform: translateX(0.5em);
      }
      .tcy-1, .tcy-2 {
        width: 1em;
        text-combine-upright: all;
        -webkit-text-combine: horizontal;
        -ms-text-combine-horizontal: all;
        transform: translateX(0em);
      }
      /* 3-4桁: 90度回転して横向きに */
      /* 3-4桁: 横書きモード(正立)にして、長体(scaleX)で1emに収める */
      .tcy-3 {
        writing-mode: horizontal-tb;
        width: 1em;
        height: 1em;
        font-size: 1em;
        display: inline-flex;
        justify-content: center;
        align-items: center;
        transform: scaleX(0.8) translateX(-0.4em);
        transform-origin: center center;
        vertical-align: middle;
      }
      .tcy-4 {
        writing-mode: horizontal-tb;
        width: 1em;
        height: 1em;
        font-size: 1em;
        display: inline-flex;
        justify-content: center;
        align-items: center;
        transform: scaleX(0.6) translateX(-0.4em);
        transform-origin: center center;
        vertical-align: middle;
      }

      /* ルビ */
      ruby { ruby-position: over; ruby-align: center; }
      rt {
        font-size: 0.5em;
        right: 0.5em;
      }

      /* ノンブル */
      .footer {
        position: absolute;
        bottom: 10mm;
        width: 100%;
        text-align: center;
        font-size: 10pt;
        font-family: sans-serif;
      }
    </style>
    </head>
    <body>
      ${pages.map((lines, i) => `
      <div class="page">
          <div class="page-content">
            ${lines.map(line => `<p>${line}</p>`).join('')}
        </div>
          <div class="footer">- ${i + 1} -</div>
      </div>
      `).join('')}
    </body>
    </html>`;
  }

  _tokenizeLine(line, lineNo) {
    const tokens = [];
    const RUBY_RE = /\|([^《》\|\n]+)《([^》\n]+)》/g;
    const NUMBER_RE = /[0-9０-９]{1,4}/g; // 半角・全角数字 1～4文字

    let lastIndex = 0;
    let match;

    // ルビ処理
    while ((match = RUBY_RE.exec(line)) !== null) {
      // マッチ前の通常文字（数字検出処理を含む）
      if (match.index > lastIndex) {
        const plain = line.substring(lastIndex, match.index);
        this._processPlainText(plain, lastIndex, lineNo, tokens);
      }

      // ルビ部分
      const base = match[1];
      const ruby = match[2];
      const rubyHtml = this._generateRubyHtml(base, ruby);
      const startIdx = match.index; // ルビ開始位置

      // ルビブロックの長さは親文字の長さ
      // data-l, data-c は親文字の開始位置を基準にする
      tokens.push({
        type: 'ruby',
        length: base.length,
        firstChar: base[0],
        html: `<span class="ruby-container" data-l="${lineNo}" data-c="${startIdx}">${rubyHtml}</span>`
      });

      lastIndex = RUBY_RE.lastIndex;
    }

    // 残りの文字（数字検出処理を含む）
    if (lastIndex < line.length) {
      const plain = line.substring(lastIndex);
      this._processPlainText(plain, lastIndex, lineNo, tokens);
    }

    return tokens;
  }

  /**
   * プレーンテキストを処理し、数字を縦中横化してトークンに追加
   * @param {string} text - 処理対象のテキスト
   * @param {number} baseOffset - 元の行における開始オフセット
   * @param {number} lineNo - 行番号
   * @param {Array} tokens - 出力先のトークン配列
   */
  _processPlainText(text, baseOffset, lineNo, tokens) {
    // 全角数字を半角に正規化（text-combine-uprightは半角数字のみ対応）
    const normalizedText = text.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
    );

    const NUMBER_RE = /[0-9]{1,4}/g;
    let lastIdx = 0;
    let match;

    // 数字パターンを検出（正規化後のテキストで検索）
    while ((match = NUMBER_RE.exec(normalizedText)) !== null) {
      // 数字の前の通常文字
      if (match.index > lastIdx) {
        const before = text.substring(lastIdx, match.index);
        for (let i = 0; i < before.length; i++) {
          const char = before[i];
          const charIdx = baseOffset + lastIdx + i;
          tokens.push({
            type: 'char',
            char: char,
            firstChar: char,
            length: 1,
            html: `<span class="char" data-l="${lineNo}" data-c="${charIdx}">${this._escapeHtml(char)}</span>`
          });
        }
      }

      // 数字部分を縦中横化（桁数に応じたクラスを追加）
      // 正規化後の半角数字を使用
      const numStr = match[0];
      const numIdx = baseOffset + match.index;
      const digitCount = numStr.length;
      // 実際の表示幅に合わせてlengthを設定（ページ分割計算用）
      // 1-3桁: 1em → length: 1
      // 4桁: 1.25em → length: 2 (端数切り上げ)
      const displayLength = digitCount <= 3 ? 1 : 2;
      tokens.push({
        type: 'tcy',
        length: displayLength,
        firstChar: numStr[0],
        html: `<span class="tcy tcy-${digitCount}" data-l="${lineNo}" data-c="${numIdx}">${this._escapeHtml(numStr)}</span>`
      });

      lastIdx = NUMBER_RE.lastIndex;
    }

    // 残りの通常文字
    if (lastIdx < text.length) {
      const rest = text.substring(lastIdx);
      for (let i = 0; i < rest.length; i++) {
        const char = rest[i];
        const charIdx = baseOffset + lastIdx + i;
        tokens.push({
          type: 'char',
          char: char,
          firstChar: char,
          length: 1,
          html: `<span class="char" data-l="${lineNo}" data-c="${charIdx}">${this._escapeHtml(char)}</span>`
        });
      }
    }
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
  }

  _generateRubyHtml(base, reading) {
    const esc = this._escapeHtml.bind(this);

    // 親文字を1文字ずつ .char で囲む (格子に合わせるため)
    let baseHtml = "";
    for (const c of base) {
      baseHtml += `<span class="char">${esc(c)}</span>`;
    }

    const onlyDots = reading.replace(/・/g, "") === "";
    if (onlyDots) {
      return `<ruby class="rb-group"><rb>${baseHtml}</rb><rt>・</rt></ruby>`;
    }

    const hasSep = reading.includes("・");
    if (hasSep) {
      // 分割時は簡易実装
      return `<ruby><rb>${baseHtml}</rb><rt>${esc(reading)}</rt></ruby>`;
    }

    // 通常
    return `<ruby><rb>${baseHtml}</rb><rt>${esc(reading)}</rt></ruby>`;
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
          font-family: var(--font-family);
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

          padding-right: 0.5em; /* 最初の行と右罫線の間を空ける */

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
          transform: translateX(-1em);
        }

        /* 縦中横（数字を横向きに表示） */
        .tcy {
          display: inline-block;
          height: 1em;
          line-height: 1em;
          text-align: center;
          vertical-align: baseline;
        }
        /* 1-2桁: text-combine-upright を使用 */
        .tcy-1 {
          width: 1em;
          text-combine-upright: all;
          -webkit-text-combine: horizontal;
          -ms-text-combine-horizontal: all;
          transform: translateX(-0.8em);
        }
        .tcy-2 {
          width: 1em;
          text-combine-upright: all;
          -webkit-text-combine: horizontal;
          -ms-text-combine-horizontal: all;
          transform: translateX(-0.75em);
        }
        /* 3-4桁: 横書きモード(正立)にして、長体(scaleX)で1emに収める */
        .tcy-3 {
          writing-mode: horizontal-tb;
          width: 1em;
          height: 1em;
          font-size: 1em;
          display: inline-flex;
          justify-content: center;
          align-items: center;
          transform: scaleX(0.5) translateX(-2em);
          transform-origin: center center;
          vertical-align: middle;
        }
        .tcy-4 {
          writing-mode: horizontal-tb;
          width: 1em;
          height: 1em;
          font-size: 1em;
          display: inline-flex;
          justify-content: center;
          align-items: center;
          transform: scaleX(0.3) translateX(-3.3em);
          transform-origin: center center;
          vertical-align: middle;
        }

        /* === ルビ（縦書き用）=== */
        ruby {
          ruby-position: over;
          ruby-align: center;
          /* 行幅を広げないために inline-block 固定幅 + relative */
          display: inline-block;
          width: 1em; /* 格子サイズに固定 */
          position: relative;
          vertical-align: middle;
          line-height: 1;
          margin: 0;
          padding: 0;
        }
        rt {
          /* ルビをフローから外して絶対配置 */
          position: absolute;
          right: 1.1em;
          top: 0;          /* 親の最上部ら開始 */
          height: 100%;    /* 親(親文字ブロック)の高さ一杯に広げる */
          width: 1em;

          display: flex;             /* Flexboxで配置制御 */
          flex-direction: row;       /* vertical-rl下では row=縦方向が主軸 */
          justify-content: center;   /* 主軸(縦)方向の中央寄せ */
          align-items: center;       /* 交差軸(横)方向の中央寄せ */

          font-size: 0.5em;
          line-height: 1;
          writing-mode: vertical-rl;
          white-space: nowrap;
          pointer-events: none;
        }

        /* カーソル同期用スタイル */
        .char.cursor-active, .ruby-container.cursor-active, .tcy.cursor-active {
          background-color: rgba(255, 255, 0, 0.25);
          outline: 1px solid rgba(255, 255, 0, 0.8);
        }
        .char:hover, .ruby-container:hover, .tcy:hover {
          background-color: rgba(255, 255, 255, 0.1);
          cursor: pointer;
        }

        /* フッター */
        #footer {
          position: fixed;
          bottom: 30px;
          left: 0;
          width: 100%;
          height: 30px;
          pointer-events: none;
          /* 中心揃え */
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 100;
          font-family: sans-serif;
          font-size: 14px;
          color: #ccc;
        }

        /* 中央配置のためのコンテナ（ページ番号） */
        #footer-center {
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          background: rgba(0,0,0,0.5);
          padding: 4px 16px;
          border-radius: 20px;
        }

        /* 左下配置のためのコンテナ（ボタン類） */
        #footer-left {
          position: absolute;
          left: 30px;
          display: flex;
          align-items: center;
          gap: 12px;
          pointer-events: auto;
          background: rgba(0,0,0,0.5);
          padding: 4px 16px;
          border-radius: 20px;
          backdrop-filter: blur(4px);
        }

        #page-info {
          cursor: pointer;
          color: #ccc;
          min-width: 60px;
          text-align: center;
        }
        #page-info:hover {
          color: #fff;
        }
        #refresh-btn, #toggle-btn, #pdf-btn, #btn-next, #btn-prev {
          pointer-events: auto;
          cursor: pointer;
          background: transparent;
          border: none;
          color: #ccc;
          width: 24px; height: 24px;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: color 0.3s;
        }
        #refresh-btn:hover, #toggle-btn:hover, #pdf-btn:hover, #btn-next:hover, #btn-prev:hover {
          color: #fff;
        }
        #toggle-btn.active {
          color: #11ff84;
        }
        #refresh-btn svg, #toggle-btn svg, #pdf-btn svg, #btn-next svg, #btn-prev svg {
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
        <div id="footer-left">
          <button id="toggle-btn" title="文庫サイズに切替 (Page/Note)">
            <svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </button>
          <button id="refresh-btn" title="更新">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
          <button id="pdf-btn" title="文庫サイズでPDF出力">
            <svg viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12H2c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h4v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-6 20H8v-4h6v4zm6 0h-4v-4h4v4zm0-6H8v-2h12v2zm0-4H8V4h12v8z"/></svg>
          </button>
        </div>
        <div id="footer-center">
          <button id="btn-next" title="次のページへ">
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <span id="page-info" title="クリックでページ移動">-- / --</span>
          <button id="btn-prev" title="前のページへ">
            <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
      </div>

      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const container = document.getElementById('container');
        const pageInfo = document.getElementById('page-info');
        const refreshBtn = document.getElementById('refresh-btn');
        const toggleBtn = document.getElementById('toggle-btn');
        const pdfBtn = document.getElementById('pdf-btn');
        const btnNext = document.getElementById('btn-next');
        const btnPrev = document.getElementById('btn-prev');

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

        toggleBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'toggleMode' });
        });

        if (pdfBtn) {
          pdfBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'exportPdf' });
          });
        }

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

        // --- Click Navigation (Remove scroll logic, keep jump logic) ---
        // .char や .ruby-container のクリックはエディタへのジャンプとして処理
        document.body.addEventListener('click', (e) => {
          // footer等は無視
          if (e.target.closest('#footer')) return;

          // 文字クリック (jump)
          const target = e.target.closest('.char, .ruby-container');
          if (target && target.dataset.l) {
            const line = parseInt(target.dataset.l, 10);
            const char = parseInt(target.dataset.c, 10);
            vscode.postMessage({ type: 'jumpToPosition', line, char });
            e.stopPropagation();
          }
          // ページ送り（左右クリック）は廃止
        });

        // --- Message Handling (Sync) ---
        window.addEventListener('message', event => {
          const msg = event.data;
          if (msg.type === 'update') {
            const payload = msg.payload;
            render(payload);
          } else if (msg.type === 'jumpTo') {
            const pg = msg.page;
            const pages = document.querySelectorAll('.page');
            if (pages[pg - 1]) {
              // 縦書きなので inline: center が無難
              pages[pg - 1].scrollIntoView({ inline: 'center' });
            }
          } else if (msg.type === 'syncCursor') {
            // カーソル位置へスクロール＆ハイライト
            const line = msg.line;
            const char = msg.char;

            // 既存ハイライト除去
            document.querySelectorAll('.cursor-active').forEach(el => el.classList.remove('cursor-active'));

            // data-l は一致、data-c は最も近いもの
            const targets = document.querySelectorAll('.char[data-l="' + line + '"], .ruby-container[data-l="' + line + '"]');
            if (targets.length === 0) return;

            let best = null;
            let minDiff = 9999;

            targets.forEach(el => {
              const c = parseInt(el.dataset.c, 10);
              const diff = Math.abs(c - char);
              if (diff < minDiff) {
                minDiff = diff;
                best = el;
              }
            });

            if (best) {
              best.classList.add('cursor-active');
              // スムーズスクロールで該当要素を表示
              best.scrollIntoView({ inline: 'center', block: 'center', behavior: 'smooth' });
            }
          }
        });

        // ページ番号クリック
        pageInfo.addEventListener('click', () => {
          vscode.postMessage({ type: 'askPageJump', total: state.pages.length });
        });

        // ページ送りボタン
        btnNext.addEventListener('click', () => {
          if (state.currentPage < state.pages.length) {
            jumpToPage(state.currentPage + 1);
          }
        });

        btnPrev.addEventListener('click', () => {
          if (state.currentPage > 1) {
            jumpToPage(state.currentPage - 1);
          }
        });

        function render(payload) {
          state.pages = payload.pages;
          state.rows = payload.rowsPerNote;
          state.cols = payload.colsPerRow;

          if (payload.bgColor) {
            document.body.style.backgroundColor = payload.bgColor;
            document.documentElement.style.backgroundColor = payload.bgColor;
          }
          if (payload.textColor) {
            document.body.style.color = payload.textColor;
            document.documentElement.style.color = payload.textColor;
          }
          if (payload.fontFamily) {
            document.documentElement.style.setProperty('--font-family', payload.fontFamily);
          }

          container.innerHTML = '';
          refreshBtn.classList.remove('spinning');

          // アイコン色更新
          if (payload.isPageMode) {
            toggleBtn.classList.add('active');
          } else {
            toggleBtn.classList.remove('active');
          }

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
