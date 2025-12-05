// 縦書きプレビュー（保存時中心に更新）。
const vscode = require("vscode");
const fs = require("fs");

// === ルビのプレースホルダー化 ===
const RUBY_RE = /\|([^《》\|\n]+)《([^》\n]+)》/g;
const PHR = (i) => `\uE000RB${i}\uE001`;
function extractRubyPlaceholders(input) {
  if (!input || typeof input !== "string") {
    return { textWithPH: input || "", rubyHtmlList: [] };
  }
  let idx = 0;
  const rubyHtmlList = [];
  const textWithPH = input.replace(RUBY_RE, (_, base, reading) => {
    const html = generateRubyHtml(base, reading);
    rubyHtmlList.push(html);
    return PHR(idx++);
  });
  return { textWithPH, rubyHtmlList };
}

function generateRubyHtml(base, reading) {
  const baseChars = [...base];
  const esc = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const onlyDots = reading.replace(/・/g, "") === "";
  if (onlyDots) {
    const pairs = [];
    for (let i = 0; i < baseChars.length; i++) {
      pairs.push(`<rb>${esc(baseChars[i])}</rb><rt>・</rt>`);
    }
    return `<ruby class="rb-group">${pairs.join("")}</ruby>`;
  }

  const hasSep = reading.includes("・");
  const readingParts = hasSep ? reading.split("・") : [...reading];
  const perChar = hasSep || readingParts.length === baseChars.length;

  if (perChar) {
    const pairs = [];
    for (let i = 0; i < baseChars.length; i++) {
      const rb = esc(baseChars[i]);
      const rt = esc(readingParts[i] ?? "");
      pairs.push(`<rb>${rb}</rb><rt>${rt}</rt>`);
    }
    return `<ruby class="rb-group">${pairs.join("")}</ruby>`;
  }
  return `<ruby><rb>${esc(base)}</rb><rt>${esc(reading)}</rt></ruby>`;
}

// === 三点リーダーのプレースホルダー化（"……"） ===
const ELLIPSIS_RE = /…{2}/g; // two U+2026
const PHE = (i) => `\uE000EL${i}\uE001`;
function extractEllipsisPlaceholders(input) {
  if (!input || typeof input !== "string") {
    return { textWithPH: input || "", ellipsisHtmlList: [] };
  }
  let idx = 0;
  const ellipsisHtmlList = [];
  const textWithPH = input.replace(ELLIPSIS_RE, () => {
    const html = `<span class="ellipsis">…………</span>`;
    ellipsisHtmlList.push(html);
    return PHE(idx++);
  });
  return { textWithPH, ellipsisHtmlList };
}

// === ダッシュ（——）のプレースホルダー化 ===
const DASH_RE = /[—―]{2}/g; // two EM DASH or two HORIZONTAL BAR
const PHD = (i) => `\uE000DL${i}\uE001`;
function extractDashPlaceholders(input) {
  if (!input || typeof input !== "string") {
    return { textWithPH: input || "", dashHtmlList: [] };
  }
  let idx = 0;
  const dashHtmlList = [];
  const textWithPH = input.replace(DASH_RE, () => {
    const html = `<span class="dash">——</span>`;
    dashHtmlList.push(html);
    return PHD(idx++);
  });
  return { textWithPH, dashHtmlList };
}
/**
 * 縦書きプレビュー Webview の制御クラス。
 * 保存時中心に差分描画し、行ジャンプや強調を橋渡しする。
 */
class PreviewPanel {
  static currentPanel = undefined;
  static viewType = "posNote.preview";

  /**
   * プレビュー Webview を構築し、イベントを購読する。
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.Uri} extensionUri
   * @param {vscode.TextEditor} editor
   * @param {vscode.ExtensionContext} context
   */
  constructor(panel, extensionUri, editor, context) {
    // WebviewPanel とエディタの参照を保持し、イベントを購読する
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._editor = editor;
    this._context = context;
    this._docUri = editor?.document?.uri;
    this._prevPreview = null;
    this._disposables = [];
    this._initialized = false;
    this._hasWarmed = false;

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
        if (message.type === "requestRefresh") {
          this._prevPreview = null; // 次の描画はフル差し替え
          this._update(false, true);
        }
      },
      null,
      this._disposables
    );

    this._update(true);
  }

  // コマンドから呼ばれ、プレビューパネルを開くか既存パネルを再利用する
  /**
   * コマンドから呼ばれ、プレビューを開く（既存があれば再利用）。
   * @param {vscode.Uri} extensionUri
   * @param {vscode.ExtensionContext} context
   */
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
    // 初回ウォームアップ（Webviewロード直後にバックグラウンドで1回だけ）
    setTimeout(() => {
      if (PreviewPanel.currentPanel && !PreviewPanel.currentPanel._hasWarmed) {
        PreviewPanel.currentPanel._hasWarmed = true;
        // ウォームアップ中であることを Webview へ通知（スピナー表示用）
        PreviewPanel.currentPanel._panel.webview.postMessage({
          type: "setRefreshing",
          payload: { spinning: true },
        });
        PreviewPanel.currentPanel._update(true, true);
      }
    }, 50);
  }

  // VS Code 再起動後の Webview 復元で呼ばれ、状態を再構築する
  /**
   * VS Code 復元時に呼ばれ、状態を再構築する。
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.Uri} extensionUri
   * @param {vscode.TextEditor} editor
   * @param {vscode.ExtensionContext} context
   */
  static revive(panel, extensionUri, editor, context) {
    PreviewPanel.currentPanel = new PreviewPanel(
      panel,
      extensionUri,
      editor,
      context
    );
  }

  // Webview が閉じられたときの後片付け。購読を解除する
  /** Webview が閉じられたときの後片付け。購読を解除する。 */
  dispose() {
    PreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  // 外部から明示的に最新状態へ更新したいときに呼ぶ
  /** 外部から明示的に最新状態へ更新する。 */
  static update() {
    if (this.currentPanel) this.currentPanel._update();
  }

  // 軽量ハイライト更新（テキストは再送しない）
      // アクティブ行の位置だけを Webview へ伝え、軽量にハイライトを移動する
  /** アクティブ行だけを軽量にハイライト更新する。 */
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
  /**
   * 外部からの明示リフレッシュ要求（保存時の自動更新など）
   * forceFull: true で差分キャッシュを破棄してフル再描画
   * showSpinner: true なら Webview 側にスピナー開始を通知
   */
  /**
   * 保存時など外部からのリフレッシュ要求に応える。
   * @param {{forceFull?:boolean, showSpinner?:boolean}} param0
   */
  static refresh({ forceFull = true, showSpinner = true } = {}) {
    const p = this.currentPanel;
    if (!p || !p._panel) return;

    if (showSpinner) {
      try {
        p._panel.webview.postMessage({
          type: "setRefreshing",
          payload: { spinning: true },
        });
      } catch (e) {
        console.error("PreviewPanel.refresh spinner notify failed:", e);
      }
    }

    if (forceFull) p._prevPreview = null;
    p._update(false, forceFull);
  }


  // preview_panel.js 内
  // プレビューデータを組み立てて Webview へ送信する中核処理
  // プレビューデータを組み立てて Webview へ送信する中核処理
  async _update(isFirst = false, forceFull = false) {
    this._panel.title = "posNote Preview";

    // アクティブエディタが無い（Webview にフォーカス）時でも doc を維持
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
    const activeCh = this._editor
      ? this._editor.selection.active.character
      : 0;
    const totalLines = doc.lineCount;
    const docKey = doc.uri.toString();

    // === 設定 ===
    const cfg = vscode.workspace.getConfiguration("posNote.Preview");
    const fontSizeNum = clampNumber(cfg.get("fontSize", 20), 8, 72);
    const fontsize = `${fontSizeNum}px`;
    const showCursor = !!cfg.get("showCursor", false);
    const fontfamily = "";
    const bgColor = cfg.get("backgroundColor", "#111111");
    const textColor = cfg.get("textColor", "#4dd0e1");
    const activeBg = cfg.get("activeLineBackground", "rgba(150, 100, 0, 0.1)");

    // POS ハイライトON/OFF
    const posEnabled = !!cfg.get("posHighlight.enabled", true);
    const posModeOn = !!cfg.get("posHighlight.mode", true);
    const posActive = posEnabled && posModeOn;
    /** @type {string | number | undefined} */
    const rawMaxLines = cfg.get("posHighlight.maxLines");
    const isNone =
      typeof rawMaxLines === "string" &&
      rawMaxLines.toLowerCase() === "none";
    const maxLines = isNone
      ? Number.POSITIVE_INFINITY // "none" で全文表示
      : clampNumber(Number(rawMaxLines ?? 5), 1, Number.MAX_SAFE_INTEGER);
    const symbol = "|";

    const winStart = Math.max(0, activeLine - maxLines);
    const winEnd = Math.min(totalLines - 1, activeLine + maxLines);

    if (!this._initialized || isFirst) {
      this._panel.webview.html = this._getHtmlForWebview();
      this._initialized = true;
    }

    // === 行ごと完成HTMLを作る（ONのときのみ）をレンダリング ===
    let isHtml = false;
    let textHtml = "";
    let tokenCss = "";
    let rubyHtmlListToSend = [];
    let ellipsisHtmlListToSend = [];
    let dashHtmlListToSend = [];
    // ルビ・三点リーダー・ダッシュ占位化は POS の有無にかかわらず実施する
    const { textWithPH: withRubyPH, rubyHtmlList } =
      extractRubyPlaceholders(text);
    const { textWithPH: withEllipsisPH, ellipsisHtmlList } =
      extractEllipsisPlaceholders(withRubyPH);
    const { textWithPH: withDashPH, dashHtmlList } =
      extractDashPlaceholders(withEllipsisPH);
    rubyHtmlListToSend = rubyHtmlList;
    ellipsisHtmlListToSend = ellipsisHtmlList;
    dashHtmlListToSend = dashHtmlList;

    if (posActive) {
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
        // Kuromoji には占位済みテキストを渡す（品詞タグとの競合回避）
        textHtml = await toPosHtml(withDashPH, this._context, {
          maxLines, // 選択行を中心に、この行数だけ前後解析
          activeLine, // 選択行
          headingDetector,
          classPrefix: "pos-",
          docUri: doc.uri,
          renderWindowOnly: true,
        });
        isHtml = true;
        // 追加: ユーザーの semanticTokenColorCustomizations.rules をプレビューCSSへ
        const { buildPreviewCssFromEditorRules } = require("./semantic");
        tokenCss = buildPreviewCssFromEditorRules();
        // ☁️追加: 復元用 HTML を payload に同梱するため、外側スコープで保持
        rubyHtmlListToSend = rubyHtmlList;
        ellipsisHtmlListToSend = ellipsisHtmlList;
        dashHtmlListToSend = dashHtmlList;
        // Webview 側での復元に加え、送信前にも占位子を展開しておく（保険）
        textHtml = inlineRestorePlaceholders(textHtml, {
          RB: rubyHtmlListToSend,
          EL: ellipsisHtmlListToSend,
          DL: dashHtmlListToSend,
        });
      } catch (e) {
        console.error("toPosHtml failed; fallback to plain:", e);
        isHtml = false;
        textHtml = "";
        tokenCss = "";
        rubyHtmlListToSend = [];
        ellipsisHtmlListToSend = [];
        dashHtmlListToSend = [];
      }
    } else {
      // POS を切っているときもカーソル±maxLines のウィンドウだけ描画して負荷を軽減
      isHtml = true;
      textHtml = buildPlainPreviewHtml(withDashPH, {
        activeLine,
        activeCh,
        maxLines,
        showCursor,
        cursorSymbol: symbol,
      });
    }

    // 保険：送信直前に占位子を展開
    textHtml = inlineRestorePlaceholders(textHtml, {
      RB: rubyHtmlListToSend,
      EL: ellipsisHtmlListToSend,
      DL: dashHtmlListToSend,
    });

    // === 差分用マップ ===
    const newLineMap = isHtml ? buildLineHtmlMap(textHtml) : null;
    const prev =
      !forceFull && this._prevPreview?.docKey === docKey
        ? this._prevPreview
        : null;
    const windowSame =
      prev &&
      prev.isHtml &&
      isHtml &&
      prev.start === winStart &&
      prev.end === winEnd;

    const position = showCursor ? "inner" : "none";

    if (windowSame && newLineMap) {
      const changes = [];
      for (let i = winStart; i <= winEnd; i++) {
        const next = newLineMap.get(i) || "";
        const prevHtml = prev.map.get(i) || "";
        if (next !== prevHtml) {
          changes.push({ line: i, html: next });
        }
      }

      this._panel.webview.postMessage({
        type: "diffUpdate",
        payload: {
          changes,
          windowStart: winStart,
          windowEnd: winEnd,
          isHtml,
          textHtml,
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
          posModeOn: posActive,
          rubyHtmlList: rubyHtmlListToSend || [],
          ellipsisHtmlList: ellipsisHtmlListToSend || [],
          dashHtmlList: dashHtmlListToSend || [],
        },
      });
    } else {
      // webview へ差し込むデータを送る（isHtml で描画ルートを切り替える）
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
          posModeOn: posActive,
          rubyHtmlList: rubyHtmlListToSend || [],
          ellipsisHtmlList: ellipsisHtmlListToSend || [],
          dashHtmlList: dashHtmlListToSend || [],
        },
      });
    }

    // 次回差分用に保存
    if (isHtml && newLineMap) {
      this._prevPreview = {
        docKey,
        start: winStart,
        end: winEnd,
        map: newLineMap,
        isHtml,
        tokenCss,
      };
    } else {
      this._prevPreview = null;
    }
  }

  // index.html を読み込み、CSP めE��ソース URI を埋め込んだ HTML を返す\n  // index.html を読み込み、CSP やリソース URI を埋め込んだ HTML を返す
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

// plain テキスト用の軽量パス：カーソル±maxLines だけ描画する
function buildPlainPreviewHtml(text, opts = {}) {
  const {
    activeLine = 0,
    activeCh = 0,
    maxLines = 200,
    showCursor = false,
    cursorSymbol = "|",
  } = opts || {};

  const lines = String(text || "").split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(0, activeLine - maxLines);
  const end = Math.min(total - 1, activeLine + maxLines);
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const out = [];
  for (let i = start; i <= end; i++) {
    const raw = lines[i] ?? "";
    let html = esc(raw);
    if (showCursor && i === activeLine) {
      const col = Math.max(0, Math.min(activeCh, raw.length));
      const before = esc(raw.slice(0, col));
      const after = esc(raw.slice(col));
      html = `${before}<span id="cursor">${esc(cursorSymbol)}</span>${after}`;
    }
    const isBlank = raw === "" || /^\s+$/.test(raw);
    if (isBlank && !(showCursor && i === activeLine)) {
      out.push(`<p class="blank" data-line="${i}">_</p>`);
    } else {
      out.push(`<p data-line="${i}">${html}</p>`);
    }
  }

  return out.join("");
}

// ===== util =====
// 指定行へエディタフォーカスとスクロールを移動させる
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

// Webview の CSP に利用するランダムな nonce を生成
function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

// 数値設定を安全な範囲に収めるヘルパー
function clampNumber(n, min, max) {
  if (typeof n !== "number" || Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// <p data-line="N"> を抜き出して行番号 -> HTML全文（pタグ含む）にマッピング
function buildLineHtmlMap(html) {
  const map = new Map();
  if (!html) return map;
  const re = /<p[^>]*data-line="(\d+)"[^>]*>[\s\S]*?<\/p>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const line = Number(m[1]);
    const frag = m[0];
    if (Number.isInteger(line)) {
      map.set(line, frag);
    }
  }
  return map;
}

// Webview へ送る前に占位文字を HTML に戻す（念のため二重復元）
function inlineRestorePlaceholders(html, lists) {
  if (!html || !lists) return html;
  // POS HTML �ł� kuromoji ���e�Ńv���X�R�[�v�����ǎm�炵�邩�Ȃ��悤�A�܂��͎��݂��v���X�R�[�v��ǉ�
  const repSimple = (kind, arr) => {
    if (!arr || !arr.length) return;
    const re = new RegExp(`\\uE000${kind}(\\d+)\\uE001`, "g");
    html = html.replace(re, (_, idx) => arr[Number(idx)] || "");
  };
  repSimple("RB", lists.RB);
  repSimple("EL", lists.EL);
  repSimple("DL", lists.DL);

  // kuromoji �ŋO�ɓn�� span ���挟�����Ƃ��E�W�J���悤�ɕϊ�
  const OPEN = "\uE000";
  const CLOSE = "\uE001";
  const splitAwareRe = new RegExp(
    `${OPEN}(?:<[^>]*>|[^<])*?(RB|EL|DL)(?:<[^>]*>|[^<])*?(\\d+)(?:<[^>]*>|[^<])*?${CLOSE}`,
    "g"
  );
  html = html.replace(splitAwareRe, (_whole, kind, idxStr) => {
    const arr = lists[kind];
    if (!arr || !arr.length) return "";
    return arr[Number(idxStr)] || "";
  });

  return html;
}

module.exports = { PreviewPanel };
