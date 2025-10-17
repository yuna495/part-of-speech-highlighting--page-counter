// 純作業量（入力・貼り付け・削除の合計）を集計し、ステータスバー表示。
// - 変更検知: onDidChangeTextDocument（contentChanges）
// - 文字数定義: 改行(\n / \r\n)は作業量に含める（\r\n は 1 改行として数える）
// - 日次集計: Asia/Tokyo のローカル日付キー（YYYY-MM-DD）で保存（globalState）
// - ホバー: 過去7日間の合計を表示
// - 設定: posNote.workload.enabled (default: true)
// - コマンド: posNote.workload.toggle（ON/OFF）

const vscode = require("vscode");

const KEY_HISTORY = "posNote.workload.history"; // { "YYYY-MM-DD": number, ... }
const KEY_TODAY_SESSION = "posNote.workload.session"; // セッション内合計（表示用・メモリのみ）

// ---- 内部 state ----
let _statusBarItem = null;
let _helpers = null; // { cfg, isTargetDoc }
let _context = null;

// 直前フラッシュ時点の「確定長」を覚える
// key: doc.uri.toString() -> number
const _baselineLenByDoc = new Map();

// タイマーだけを持つ簡易ペンディング
const _pendingByDoc = new Map(); // key -> { timer: NodeJS.Timeout | null }

// ドキュメントごとの「直前テキスト」スナップショット
// 変更レンジは「変更前ドキュメント基準」なので、これで削除文字を正確取得できる
const _prevText = new Map(); // key: doc.uri.toString() -> string
let _lastDateKey = null;
let _midnightTimer = null;

// グラフWebviewを再利用するための参照
let _graphPanel = null;

// ==== デモ切替フラグ ====
// デモ用の架空データを返したい期間だけ true にしてください。
// 終わったら false に戻せば、実データ(globalState)の読み書きに復帰します。
const DEMO_MODE = false;

// ---- デモ用履歴を組み立てる ----
// 直近30日（本日含む）をキー YYYY-MM-DD で作成
// total = add + del で整合を取る
// デモモードで使う架空の作業履歴を生成する
function buildDemoHistory(days = 30) {
  const out = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toTzDateKey(d, cfg().timeZone); // ★修正：正しいキー名で作成

    // 視覚的に起伏が出るダミー生成
    const dow = d.getDay(); // 0:日〜6:土
    const base = 1200 + (dow === 0 || dow === 6 ? 1800 : 400 * ((i % 3) - 1));
    const add = Math.max(0, Math.round(base * 0.7));
    const del = Math.max(0, Math.round(base * 0.3));
    const total = add + del;

    out[key] = { total, add, del };
  }
  return out;
}

// ---- util ----
// 改行を 1 文字として数えながら入力／削除量を算出する
function countCharsWithNewline(text) {
  if (!text) return 0;
  // CRLF を LF に正規化してからコードポイント数を数える（\r\n を 1 として扱う）
  const normalized = String(text).replace(/\r\n/g, "\n");
  return Array.from(normalized).length;
}
// --- タイムゾーン対応：日付キー作成（YYYY-MM-DD） ---
const _dtfCache = new Map(); // timeZone -> Intl.DateTimeFormat

// タイムゾーンごとの DateTimeFormat をキャッシュして再利用する
function getDateKeyFormatter(timeZone) {
  const tz = timeZone && timeZone !== "system" ? timeZone : undefined; // undefined = OS既定
  if (!tz) {
    // ★system（OS既定TZ）の場合は毎回新規生成（OSのTZ変更に即追従）
    return new Intl.DateTimeFormat("ja-JP-u-ca-gregory", {
      timeZone: undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // ここから先は IANA 指定のみキャッシュ
  if (_dtfCache.has(tz)) return _dtfCache.get(tz);
  const fmt = new Intl.DateTimeFormat("ja-JP-u-ca-gregory", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  _dtfCache.set(tz, fmt);
  return fmt;
}

// 指定タイムゾーンの日付を YYYY-MM-DD 文字列に変換する
function toTzDateKey(d = new Date(), timeZone = "system") {
  const fmt = getDateKeyFormatter(timeZone);
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${day}`; // YYYY-MM-DD
}
// 作業量を3桁区切りで表示する
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}
// 永続化された作業履歴（またはデモデータ）を取得する
function getHistory(context) {
  if (DEMO_MODE) {
    // 架空データを返す（30日分）
    return buildDemoHistory(30);
  }
  // ←通常運用：globalState から読む
  const obj = context.globalState.get(KEY_HISTORY);
  return obj && typeof obj === "object" ? { ...obj } : {};
}
// 作業履歴を globalState に保存する
async function saveHistory(context, hist) {
  if (DEMO_MODE) {
    // デモ中は実データを汚さない
    return;
  }
  const LIMIT_DAYS = 30; // 保存上限（例: 30日）
  const keys = Object.keys(hist).sort();
  if (keys.length > LIMIT_DAYS) {
    const excess = keys.length - LIMIT_DAYS;
    for (let i = 0; i < excess; i++) delete hist[keys[i]];
  }
  await context.globalState.update(KEY_HISTORY, hist);
}
// 当日セッション内の作業量合計をメモリから取得
function getSessionSum() {
  return _context?.workspaceState.get(KEY_TODAY_SESSION) || 0;
}
// 当日セッション内の作業量合計を更新
function setSessionSum(n) {
  if (_context) _context.workspaceState.update(KEY_TODAY_SESSION, n);
}
// ドキュメントの直前本文スナップショットを取得
function getPrevTextFor(doc) {
  const k = doc.uri.toString();
  return _prevText.get(k);
}
// ドキュメントの直前本文スナップショットを保存
function setPrevTextFor(doc, text) {
  const k = doc.uri.toString();
  _prevText.set(k, text);
}
// 変更前テキストと Position から絶対オフセットを算出する
function positionToOffset(prevText, pos) {
  // pos: { line, character }（変更前ドキュメント基準）
  // 改行は \n と仮定（CRLF でも VSCode の Position は行/桁論理で扱える）
  const lines = prevText.split("\n");
  let off = 0;
  for (let i = 0; i < pos.line; i++) {
    // "\n" 1文字ぶんを加算
    off += lines[i].length + 1;
  }
  // 同じ行の character を加算
  off += pos.character;
  return off;
}
// 変更前テキストから指定範囲の文字列を切り出す
function substringByRange(prevText, range) {
  // range: { start: Position, end: Position }（いずれも変更前ドキュメント基準）
  const s = positionToOffset(prevText, range.start);
  const e = positionToOffset(prevText, range.end);
  return prevText.slice(s, e);
}

// ---- ステータスバー ----
// 作業量表示用のステータスバー項目を lazily 作成する
function ensureStatusBar(context) {
  if (_statusBarItem) return _statusBarItem;
  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    1 // 既存のページ/字より少し優先度高めに左寄せ
  );
  context.subscriptions.push(_statusBarItem);
  // ステータスバーをクリックしたらグラフを開く
  _statusBarItem.command = "posNote.workload.showGraph";
  return _statusBarItem;
}
// 当日作業量を取得してステータスバーへ反映する
function updateStatusBarText(c) {
  const sb = _statusBarItem;
  if (!sb) return;

  if (!c.workloadEnabled) {
    sb.hide();
    return;
  }

  const today = toTzDateKey(new Date(), c.timeZone);
  const hist = getHistory(_context);
  const h = hist[today];
  const todaySum = typeof h === "number" ? h : h?.total || 0;
  const session = getSessionSum();

  sb.text = `$(pencil) ${fmt(todaySum)}`;
  sb.tooltip = buildHoverTooltip(hist);
  sb.show();
}
// 過去7日分の作業量を集計し、ホバーツールチップ文字列を作る
function buildHoverTooltip(hist) {
  const c = cfg();
  let total7 = 0;
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toTzDateKey(d, c.timeZone);
    const raw = hist[key];
    const vTotal = typeof raw === "number" ? raw : raw?.total || 0;
    total7 += vTotal;
    lines.push(`${key}: ${fmt(vTotal)}`);
  }
  return `過去7日合計: ${fmt(total7)}\n` + lines.join("\n");
}

function flushPending(docUri, c) {
  const p = _pendingByDoc.get(docUri);
  if (!p) return;
  _pendingByDoc.delete(docUri);

  // 対象ドキュメント取得
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === docUri
  );
  if (!doc) {
    updateStatusBarText(c);
    return;
  }

  // 現在長と基準長
  const curLen = countCharsWithNewline(doc.getText());
  const baseLen = _baselineLenByDoc.get(docUri) ?? curLen;

  // モード分岐
  let delta = 0;
  if (c.mode === "signedLen") {
    delta = curLen - baseLen; // 符号付き増減
  } else {
    // 互換: 既存モードは従来の見做し
    const gross = Math.abs(curLen - baseLen) * 2; // 置換を作業量2と見做すなら
    const net = Math.abs(curLen - baseLen);
    delta = c.mode === "net" ? net : gross;
  }

  // 基準を更新（次回バッチの起点）
  _baselineLenByDoc.set(docUri, curLen);

  if (delta !== 0) {
    const hist = getHistory(_context);
    const key = toTzDateKey(new Date(), c.timeZone);
    const cur = hist[key];

    // 後方互換
    let rec =
      typeof cur === "number"
        ? { total: cur, add: 0, del: 0 }
        : cur && typeof cur === "object"
        ? { ...cur }
        : { total: 0, add: 0, del: 0 };

    // 参考までに add/del も符号で反映
    if (c.mode === "signedLen") {
      if (delta > 0) rec.add += delta;
      else rec.del += -delta;
      rec.total += delta; // 符号付きでそのまま積む
    } else {
      rec.total += delta;
    }

    hist[key] = rec;
    saveHistory(_context, hist);
  }

  const minDelta = 1; // ±1 文字の揺れは無視したい場合
  if (Math.abs(delta) <= minDelta) {
    updateStatusBarText(c);
    return;
  }

  updateStatusBarText(c);
}

// ---- メイン：変更処理 ----
// テキスト変更イベントを解析し、入力・削除量を履歴へ積み上げる
function handleDocChange(e, c) {
  checkDateRollover();
  if (!c.workloadEnabled) return;

  const doc = e.document;
  const { isTargetDoc } = _helpers;
  if (!isTargetDoc(doc, c)) return;

  // 初回は基準長をセット
  const k = doc.uri.toString();
  if (!_baselineLenByDoc.has(k)) {
    _baselineLenByDoc.set(k, countCharsWithNewline(doc.getText()));
  }

  // 連続変更を束ねてフラッシュ
  const prev = _pendingByDoc.get(k);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => flushPending(k, c), c.collapseWindowMs);
  _pendingByDoc.set(k, { timer });
}

// 日付越え検知＆初期化
// 日付が変わったらセッションをリセットし、新しい日次レコードを用意する
function checkDateRollover() {
  if (!_context) return;
  const nowKey = toTzDateKey(new Date(), cfg().timeZone);

  if (_lastDateKey && nowKey === _lastDateKey) return;

  _lastDateKey = nowKey;
  setSessionSum(0);

  const hist = getHistory(_context);
  const cur = hist[nowKey];
  if (cur == null) {
    hist[nowKey] = { total: 0, add: 0, del: 0 };
    saveHistory(_context, hist);
  }
  updateStatusBarText(cfg());
}

// 最も古い日付のレコードを1件削除
async function deleteOldestHistory(context) {
  const hist = getHistory(context);
  const keys = Object.keys(hist).sort(); // YYYY-MM-DD なので文字列ソートで日付順
  if (keys.length === 0) {
    vscode.window.showInformationMessage("作業量ログは空です");
    return;
  }
  const oldest = keys[0];
  delete hist[oldest];
  await context.globalState.update(KEY_HISTORY, hist); // 直接反映
  // UI更新
  updateStatusBarText(cfg());
  refreshGraphIfAny(context);
  vscode.window.showInformationMessage(`削除: ${oldest}`);
}

// 全消去
async function clearAllHistory(context) {
  await context.globalState.update(KEY_HISTORY, {}); // 全クリア
  // 今日の空レコードを用意しておくと表示が安定
  const todayKey = toTzDateKey(new Date(), cfg().timeZone);
  const h0 = {};
  h0[todayKey] = { total: 0, add: 0, del: 0 };
  await context.globalState.update(KEY_HISTORY, h0);
  // UI更新
  updateStatusBarText(cfg());
  refreshGraphIfAny(context);
  vscode.window.showInformationMessage("作業量ログを全て削除しました");
}

// ---- 公開API ----
// 作業量トラッカーの初期化。イベント購読とステータスバー登録を行う
function initWorkload(context, helpers) {
  _context = context;
  _helpers = helpers;

  const sb = ensureStatusBar(context);

  // アクティブエディタ初期化（前回テキスト取り込み）
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document) {
    setPrevTextFor(ed.document, ed.document.getText());
    _baselineLenByDoc.set(
      ed.document.uri.toString(),
      countCharsWithNewline(ed.document.getText())
    );
  }

  // イベント購読
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const c = cfg();
      handleDocChange(e, c);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      // エディタ切替時も最新テキストをキャッシュ
      if (ed && ed.document) {
        setPrevTextFor(ed.document, ed.document.getText());
      }
      updateStatusBarText(cfg());
    })
  );

  // ミッドナイト監視開始（30秒おき）
  _lastDateKey = toTzDateKey(new Date(), cfg().timeZone);
  _midnightTimer = setInterval(() => {
    checkDateRollover();
  }, 30 * 1000);

  // dispose 時に止める（context にぶら下げる）
  context.subscriptions.push({
    dispose() {
      if (_midnightTimer) {
        clearInterval(_midnightTimer);
        _midnightTimer = null;
      }
    },
  });

  // 初期表示
  updateStatusBarText(cfg());

  // グラフ表示コマンド（表示用のみ）
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.workload.showGraph", async () => {
      const c = cfg();
      if (!c.workloadEnabled) return; // OFFなら何もしない
      showWorkloadGraph(context);
    })
  );

  // 最古1件削除
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "posNote.workload.deleteOldest",
      async () => {
        const pick = await vscode.window.showWarningMessage(
          "最も古い日付の作業量を1件削除します。よろしいですか",
          { modal: true },
          "削除"
        );
        if (pick === "削除") await deleteOldestHistory(context);
      }
    )
  );

  // 全削除
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.workload.clearAll", async () => {
      const pick = await vscode.window.showWarningMessage(
        "作業量ログを全て削除します。元に戻せません。よろしいですか",
        { modal: true },
        "全削除"
      );
      if (pick === "全削除") await clearAllHistory(context);
    })
  );

  checkDateRollover();

  return {
    onConfigChanged(editor) {
      updateStatusBarText(cfg());
    },
  };
}

// cfg を helpers から参照（extension.js と同形）
// workload 関連の設定値をまとめて取得する
function cfg() {
  const c = vscode.workspace.getConfiguration("posNote");
  return {
    workloadEnabled: c.get("workload.enabled", true),
    dailyTarget: c.get("workload.dailyTarget", 10000),
    timeZone: c.get("workload.timeZone", "system"),
    // 既存: "gross" | "net"
    // 追加: "signedLen" = ファイル長の増減を符号付きでそのまま加算
    mode: c.get("workload.mode", "net"),
    collapseWindowMs: c.get("workload.collapseWindowMs", 500),
  };
}

// ---- グラフ表示（Webview） ----
// 30日分の作業量グラフを Webview で表示する（既存パネルがあれば再利用）
function showWorkloadGraph(context) {
  const makeHtml = () => {
    const hist = getHistory(context);
    const days = buildLastNDays(hist, 30);
    const { dailyTarget } = cfg();
    return getGraphHtml(_graphPanel.webview, days, dailyTarget);
  };

  if (_graphPanel) {
    _graphPanel.webview.html = makeHtml();
    _graphPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  _graphPanel = vscode.window.createWebviewPanel(
    "posNoteWorkloadGraph",
    "純作業量（過去30日）",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  _graphPanel.webview.html = makeHtml();

  _graphPanel.onDidDispose(() => {
    _graphPanel = null;
  });
}

// 追加: 既存パネルがあれば中身だけ再描画
function refreshGraphIfAny(context) {
  if (_graphPanel) {
    const hist = getHistory(context);
    const days = buildLastNDays(hist, 30);
    const { dailyTarget } = cfg();
    _graphPanel.webview.html = getGraphHtml(
      _graphPanel.webview,
      days,
      dailyTarget
    );
  }
}

// 履歴から直近 n 日分のデータを抽出し、欠損日は0で補完する
function buildLastNDays(hist, n) {
  const c = cfg();
  const arr = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toTzDateKey(d, c.timeZone);
    const raw = hist[key];
    if (typeof raw === "number") {
      arr.push({ date: key, total: raw, add: 0, del: 0 });
    } else {
      const r = raw || {};
      arr.push({
        date: key,
        total: r.total || 0,
        add: r.add || 0,
        del: r.del || 0,
      });
    }
  }
  return arr;
}

// Webview に表示する SVG グラフの HTML 全体を組み立てる
function getGraphHtml(webview, days, targetValue = 10000) {
  // Data
  const total = days.reduce((a, b) => a + (b.total || 0), 0);
  const maxTotal = Math.max(0, ...days.map((d) => d.total || 0));
  const maxAdd = Math.max(0, ...days.map((d) => d.add || 0));
  const maxDel = Math.max(0, ...days.map((d) => d.del || 0));
  const rawMax = Math.max(1, targetValue, maxTotal, maxAdd, maxDel);
  // 目標値の1/5刻みにグリッドを引く（最低100刻み）
  const TICK_STEP = Math.max(100, Math.round(targetValue / 5));
  const chartMax = Math.max(
    TICK_STEP,
    Math.ceil(rawMax / TICK_STEP) * TICK_STEP
  );
  const csp = `
    default-src 'none';
    img-src ${webview.cspSource} data:;
    script-src 'unsafe-inline' ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};
  `;

  // 軽量な SVG 棒グラフを自前描画（CDN不要）
  // 配色は VS Code テーマに馴染むように CSS 変数で調整
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>純作業量（過去30日）</title>
  <style>
    :root {
      --fg: var(--vscode-editor-foreground, #ddd);
      --bg: var(--vscode-editor-background, #1e1e1e);
      --axis: var(--vscode-editorLineNumber-foreground, #888);
      /* VS Code テーマがあればそれを優先、なければ右の色にフォールバック */
      --bar:       var(--vscode-charts-blue,   #4da3ffaa);
      --bar-max:   var(--vscode-charts-yellow, #bbd166aa);
      --target:    var(--vscode-charts-red,    #ff5555);
      --line-add:  #ffff00;                     /* 入力折れ線はユーザー要望で固定黄色 */
      --line-del:  var(--vscode-charts-purple, #ff00ff);
      --grid: #4448;
      --accent: var(--vscode-textLink-foreground, #58a6ff);
    }
    body { margin: 0; font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans JP', sans-serif; color: var(--fg); background: var(--bg); }
    header { padding: 12px 16px; border-bottom: 1px solid #ffffff12; }
    header h1 { font-size: 14px; margin: 0 0 4px 0; }
    header .meta { color: var(--axis); }
    .wrap { padding: 10px 16px 16px; }
    .legend { display:flex; gap:16px; align-items:center; margin: 6px 0 12px; color: var(--axis); }
    .swatch { width:10px; height:10px; border-radius: 2px; display:inline-block; margin-right:6px; vertical-align: -1px; }
    /* 直接指定して確実にユーザー指定色を表示 */
    .swatch.bar     { background: #4da3ffaa; }   /* 合計バー */
    .swatch.max     { background: #bbd166aa; }   /* 最大日 */
    .swatch.target  { background: #ff0000; }     /* 目標ライン */
    .swatch.lineAdd { background: #00ff55; }     /* 入力折れ線 */
    .swatch.lineDel { background: #ff00ff; }     /* 削除折れ線 */
    .chart { width: 100%; height: 600px; border-left:1px solid var(--axis); border-bottom:1px solid var(--axis); position: relative; }
    svg { width: 100%; height: 100%; display:block; }
    .xlabels { display:flex; justify-content:space-between; margin-top:6px; color: var(--axis); font-size: 11px; }
    .hint { margin-top: 8px; color: var(--axis); }
  </style>
</head>
<body>
  <header>
    <h1>純作業量（過去30日）</h1>
    <div class="meta">合計: <b>${total.toLocaleString(
      "ja-JP"
    )}</b> ／ 最大日: <b>${maxTotal.toLocaleString("ja-JP")}</b></div>
  </header>
  <div class="wrap">
    <div class="legend">
      <span><span class="swatch bar"></span>日別作業量</span>
      <span><span class="swatch max"></span>最大日のバー</span>
      <span><span class="swatch target"></span>目標ライン（${targetValue.toLocaleString(
        "ja-JP"
      )}字/日）</span>
      <span><span class="swatch lineAdd"></span>入力（折れ線）</span>
      <span><span class="swatch lineDel"></span>削除（折れ線）</span>
    </div>
    <div class="chart">
      <svg viewBox="0 0 1000 600" preserveAspectRatio="none" id="chartSvg" aria-label="純作業量棒グラフ"></svg>
    </div>
    <div class="xlabels" id="xlabels"></div>
    <div class="hint">右端が本日。バーにマウスを置くと数値を表示します。</div>
  </div>

  <script>
    const DAYS = ${JSON.stringify(days)};
    const chartMax = ${chartMax};       // 切り上げ後の上端
    const targetValue = ${targetValue}; // 同上
    const TICK_STEP = ${TICK_STEP};     // 目標値の1/5刻み（最低100）

    const svg = document.getElementById('chartSvg');
    const W = 1000, H = 600, PAD = 28;
    const innerW = W - PAD*2, innerH = H - PAD*2;

    // 背景グリッド（1000字ごと）＋ 左軸の数値ラベル
    for (let v = 0; v <= chartMax; v += TICK_STEP) {
      const y = PAD + (innerH - (v / chartMax) * (innerH - 1));
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', PAD);
      line.setAttribute('x2', W - PAD);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', getCss('--grid','#4448'));
      svg.appendChild(line);
    }

    // 棒
    const n = DAYS.length;
    const gap = 3; // 棒間隔(px換算)
    const barW = innerW / n;
    // 最大日のバー（total 基準）
    const maxIndex = DAYS.reduce((mi, d, i) => ((d.total||0) > (DAYS[mi].total||0) ? i : mi), 0);
    const tooltip = makeTooltip();

    // ---- ターゲット水平線 ----
    const ty = PAD + (innerH - (targetValue / chartMax) * (innerH - 1));
    const tline = document.createElementNS('http://www.w3.org/2000/svg','line');
    tline.setAttribute('x1', PAD);
    tline.setAttribute('x2', W - PAD);
    tline.setAttribute('y1', ty);
    tline.setAttribute('y2', ty);
    tline.setAttribute('stroke','#ff0000');
    tline.setAttribute('stroke-width', 1.5);
    tline.setAttribute('stroke-dasharray', '6,4');
    svg.appendChild(tline);

    // ---- 棒（合計 total）----
    DAYS.forEach((d, i) => {
      const h = chartMax ? ((d.total||0) / chartMax) * (innerH - 1) : 0;
      const x = PAD + barW * i + gap * 0.5;
      const y = PAD + (innerH - h);
      const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', Math.max(1, barW - gap * 3));
      r.setAttribute('height', Math.max(0, h));
      r.setAttribute(
       'fill',
           (d.total||0) === ${maxTotal}
            ? '#bbd166aa'  // 最大日：黄色
            : '#4da3ffaa'  // 通常バー：青
    );
      r.style.cursor = 'default';
      r.addEventListener('mousemove', (ev) => {
        const t = (d.total||0).toLocaleString('ja-JP');
        const a = (d.add||0).toLocaleString('ja-JP');
        const rm = (d.del||0).toLocaleString('ja-JP');
        tooltip.show(ev.clientX, ev.clientY, \`\${d.date}\n合計: \${t}／入力: \${a}／削除: \${rm}\`);
      });
      r.addEventListener('mouseleave', () => tooltip.hide());
      svg.appendChild(r);
    });

    // ---- 折れ線（入力 add / 削除 del）----
    function linePoints(selector) {
      const pts = [];
      for (let i=0;i<n;i++){
        const d = DAYS[i];
        const base = (selector === 'add') ? (d.add||0) : (d.del||0);
        const v = base;
        const x = PAD + (barW * i + (barW - gap)/2 + gap*0.5); // 棒の中央
        const y = PAD + (innerH - (v / chartMax) * (innerH - 1));
        pts.push(x + ',' + y);
      }
      return pts.join(' ');
    }
    const polyAdd = document.createElementNS('http://www.w3.org/2000/svg','polyline');
    polyAdd.setAttribute('points', linePoints('add'));
    polyAdd.setAttribute('fill','none');
    polyAdd.setAttribute('stroke', '#00ff55');
    polyAdd.setAttribute('stroke-width','6');
    svg.appendChild(polyAdd);

    const polyDel = document.createElementNS('http://www.w3.org/2000/svg','polyline');
    polyDel.setAttribute('points', linePoints('del'));
    polyDel.setAttribute('fill','none');
    polyDel.setAttribute('stroke', '#ff00ff');
    polyDel.setAttribute('stroke-width','6');
    svg.appendChild(polyDel); // ★追加：削除系列の折れ線を描画

    // ---- 折れ線の頂点マーカー（入力=●、削除=■ / 値0は表示しない）----
    for (let i = 0; i < n; i++) {
      const d = DAYS[i];
      const xCenter = PAD + (barW * i + (barW - gap)/2 + gap*0.5);
      // 入力（add）…値>0のみ円マーカー
      if ((d.add||0) > 0) {
        const yAdd = PAD + (innerH - (d.add / chartMax) * (innerH - 1));
        const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
        c.setAttribute('cx', xCenter);
        c.setAttribute('cy', yAdd);
        c.setAttribute('r', 8);
        c.setAttribute('fill', '#00ff55');
        c.setAttribute('stroke', '#00000088');
        c.setAttribute('stroke-width', '1');
        svg.appendChild(c);
      }
      // 削除（del）…値>0のみ四角マーカー
      if ((d.del||0) > 0) {
        const yDel = PAD + (innerH - (d.del / chartMax) * (innerH - 1));
        const s = 16; // 一辺
        const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
        r.setAttribute('x', xCenter - s/2);
        r.setAttribute('y', yDel - s/2);
        r.setAttribute('width', s);
        r.setAttribute('height', s);
        r.setAttribute('fill', '#ff00ff');
        r.setAttribute('stroke', '#00000088');
        r.setAttribute('stroke-width', '1');
        svg.appendChild(r);
      }
    }

    // X 軸ラベル（左端/中央/右端のみ）
    const xl = document.getElementById('xlabels');
    const left = DAYS[0]?.date ?? '';
    const mid = DAYS[Math.floor(n/2)]?.date ?? '';
    const right = DAYS[n-1]?.date ?? '';
    xl.innerHTML = \`<span>\${left}</span><span>\${mid}</span><span>\${right}</span>\`;

    function getCss(name, fallback) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    }
    function makeTooltip(){
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.padding = '4px 8px';
      el.style.fontSize = '11px';
      el.style.background = 'rgba(0,0,0,.8)';
      el.style.color = '#fff';
      el.style.borderRadius = '4px';
      el.style.pointerEvents = 'none';
      el.style.transform = 'translate(12px, 12px)';
      el.style.zIndex = 10000;
      el.style.display = 'none';
      document.body.appendChild(el);
      return {
        show(x,y,text){ el.textContent = text; el.style.left = x+'px'; el.style.top = y+'px'; el.style.display='block'; },
        hide(){ el.style.display='none'; }
      }
    }
  </script>
</body>
</html>`;
}

module.exports = { initWorkload };
