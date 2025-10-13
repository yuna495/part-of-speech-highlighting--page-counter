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
// ドキュメントごとの「直前テキスト」スナップショット
// 変更レンジは「変更前ドキュメント基準」なので、これで削除文字を正確取得できる
const _prevText = new Map(); // key: doc.uri.toString() -> string

// ---- util ----
function countCharsWithNewline(text) {
  if (!text) return 0;
  // CRLF を LF に正規化してからコードポイント数を数える（\r\n を 1 として扱う）
  const normalized = String(text).replace(/\r\n/g, "\n");
  return Array.from(normalized).length;
}
function toJstDateStr(d = new Date()) {
  // VS Code は環境依存だが、明示的にJSTに補正（+09:00）
  const tzOffsetMin = d.getTimezoneOffset(); // 分（JSTなら -540 が多い）
  const wantOffset = -9 * 60; // JST
  const delta = (wantOffset - tzOffsetMin) * 60000;
  const j = new Date(d.getTime() + delta);
  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, "0");
  const day = String(j.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}
function getHistory(context) {
  const obj = context.globalState.get(KEY_HISTORY);
  return obj && typeof obj === "object" ? { ...obj } : {};
}
async function saveHistory(context, hist) {
  await context.globalState.update(KEY_HISTORY, hist);
}
function getSessionSum() {
  return _context?.workspaceState.get(KEY_TODAY_SESSION) || 0;
}
function setSessionSum(n) {
  if (_context) _context.workspaceState.update(KEY_TODAY_SESSION, n);
}
function getPrevTextFor(doc) {
  const k = doc.uri.toString();
  return _prevText.get(k);
}
function setPrevTextFor(doc, text) {
  const k = doc.uri.toString();
  _prevText.set(k, text);
}
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
function substringByRange(prevText, range) {
  // range: { start: Position, end: Position }（いずれも変更前ドキュメント基準）
  const s = positionToOffset(prevText, range.start);
  const e = positionToOffset(prevText, range.end);
  return prevText.slice(s, e);
}

// ---- ステータスバー ----
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
function updateStatusBarText(c) {
  const sb = _statusBarItem;
  if (!sb) return;

  if (!c.workloadEnabled) {
    sb.hide();
    return;
  }

  const today = toJstDateStr();
  const hist = getHistory(_context);
  const todaySum = hist[today] || 0;
  const session = getSessionSum();

  sb.text = `$(pencil) ${fmt(todaySum)}`;
  sb.tooltip = buildHoverTooltip(hist);
  sb.show();
}
function buildHoverTooltip(hist) {
  // 過去7日（本日含む）合計と内訳
  let total7 = 0;
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toJstDateStr(d);
    const v = hist[key] || 0;
    total7 += v;
    lines.push(`${key}: ${fmt(v)}`);
  }
  return `過去7日合計: ${fmt(total7)}\n` + lines.join("\n");
}

// ---- メイン：変更処理 ----
function handleDocChange(e, c) {
  if (!c.workloadEnabled) return;

  const doc = e.document;
  const { isTargetDoc } = _helpers;
  if (!isTargetDoc(doc, c)) return;

  // 変更前スナップショット（なければ初回取得）
  let prev = getPrevTextFor(doc);
  if (prev == null) prev = doc.getText(); // 初回は差分を取れないので 0 加算扱い
  let added = 0;
  let removed = 0;

  // contentChanges は「変更前ドキュメント座標」で与えられる
  for (const ch of e.contentChanges) {
    const oldText = substringByRange(prev, ch.range);
    removed += countCharsWithNewline(oldText);
    added += countCharsWithNewline(ch.text);
    // prev にこの変更を適用していく（次の change の基準を更新）
    const s = positionToOffset(prev, ch.range.start);
    const eoff = positionToOffset(prev, ch.range.end);
    prev = prev.slice(0, s) + ch.text + prev.slice(eoff);
  }

  const delta = added + removed; // 「純作業量」= 入力 + 削除
  if (delta > 0) {
    const hist = getHistory(_context);
    const key = toJstDateStr();
    hist[key] = (hist[key] || 0) + delta;
    saveHistory(_context, hist); // 非同期保存
  }

  // 次回のために、最新本文をキャッシュ
  setPrevTextFor(doc, doc.getText());

  // 表示更新
  updateStatusBarText(c);
}

// ---- 公開API ----
function initWorkload(context, helpers) {
  _context = context;
  _helpers = helpers;

  const sb = ensureStatusBar(context);

  // アクティブエディタ初期化（前回テキスト取り込み）
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document) {
    setPrevTextFor(ed.document, ed.document.getText());
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

  return {
    onConfigChanged(editor) {
      updateStatusBarText(cfg());
    },
  };
}

// cfg を helpers から参照（extension.js と同形）
function cfg() {
  const c = vscode.workspace.getConfiguration("posNote");
  return {
    // 既存の isTargetDoc を使うため helpers からだけ受け取る
    workloadEnabled: c.get("workload.enabled", true),
    dailyTarget: c.get("workload.dailyTarget", 2000),
  };
}

// ---- グラフ表示（Webview） ----
function showWorkloadGraph(context) {
  const panel = vscode.window.createWebviewPanel(
    "posNoteWorkloadGraph",
    "純作業量（過去30日）",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const hist = getHistory(context);
  const days = buildLastNDays(hist, 30); // [{date:'YYYY-MM-DD', value:number}, ...] 右端が本日

  const { dailyTarget } = cfg();
  panel.webview.html = getGraphHtml(panel.webview, days, dailyTarget);
}

function buildLastNDays(hist, n) {
  const arr = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toJstDateStr(d);
    arr.push({ date: key, value: hist[key] || 0 });
  }
  return arr; // 左が古い日、右が本日（棒は右へ新しくなる）
}

function getGraphHtml(webview, days, targetValue = 2000) {
  // Data
  const total = days.reduce((a, b) => a + b.value, 0);
  const maxDay = Math.max(0, ...days.map((d) => d.value));
  const rawMax = Math.max(1, maxDay, targetValue); // 目標値もスケールに反映
  const TICK_STEP = 1000; // ★固定：1000字ごと
  const chartMax = Math.max(
    TICK_STEP,
    Math.ceil(rawMax / TICK_STEP) * TICK_STEP
  ); // ★上端を1000の倍数に切り上げ
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
      --bar: var(--vscode-charts-blue, #4da3ff);
      --bar-max: var(--vscode-charts-yellow, #ffd166);
      --target: var(--vscode-charts-red, #ff5555);
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
    .swatch.bar { background: var(--bar); }
    .swatch.max { background: var(--bar-max); }
    .swatch.target { background: var(--target); }
    .chart { width: 100%; height: 240px; border-left:1px solid var(--axis); border-bottom:1px solid var(--axis); position: relative; }
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
    )}</b> ／ 最大日: <b>${maxDay.toLocaleString("ja-JP")}</b></div>
  </header>
  <div class="wrap">
    <div class="legend">
      <span><span class="swatch bar"></span>日別作業量</span>
      <span><span class="swatch max"></span>最大日のバー</span>
      <span><span class="swatch target"></span>目標ライン（${targetValue.toLocaleString(
        "ja-JP"
      )}字/日）</span>
    </div>
    <div class="chart">
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none" id="chartSvg" aria-label="純作業量棒グラフ"></svg>
    </div>
    <div class="xlabels" id="xlabels"></div>
    <div class="hint">右端が本日。バーにマウスを置くと数値を表示します。</div>
  </div>

  <script>
    const DAYS = ${JSON.stringify(days)};
    const chartMax = ${chartMax};       // 切り上げ後の上端
    const targetValue = ${targetValue}; // 同上
    const TICK_STEP = 1000;              // ★固定：1000字ごと

    const svg = document.getElementById('chartSvg');
    const W = 1000, H = 300, PAD = 28;
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
    const gap = 2; // 棒間隔(px換算)
    const barW = innerW / n;
    const maxIndex = DAYS.reduce((mi, d, i) => d.value > DAYS[mi].value ? i : mi, 0);
    const tooltip = makeTooltip();

    // ---- ターゲット水平線 ----
    const ty = PAD + (innerH - (targetValue / chartMax) * (innerH - 1));
    const tline = document.createElementNS('http://www.w3.org/2000/svg','line');
    tline.setAttribute('x1', PAD);
    tline.setAttribute('x2', W - PAD);
    tline.setAttribute('y1', ty);
    tline.setAttribute('y2', ty);
    tline.setAttribute('stroke', getCss('--target','#ff5555'));
    tline.setAttribute('stroke-width', 1.5);
    tline.setAttribute('stroke-dasharray', '6,4');
    svg.appendChild(tline);

    // ---- 棒 ----
    DAYS.forEach((d, i) => {
      const h = chartMax ? (d.value / chartMax) * (innerH - 1) : 0;
      const x = PAD + barW * i + gap * 0.5;
      const y = PAD + (innerH - h);
      const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', Math.max(1, barW - gap));
      r.setAttribute('height', Math.max(0, h));
      r.setAttribute('fill', i===maxIndex ? getCss('--bar-max','#ffd166') : getCss('--bar','#4da3ff'));
      r.style.cursor = 'default';
      r.addEventListener('mousemove', (ev) => {
        tooltip.show(ev.clientX, ev.clientY, \`\${d.date}: \${d.value.toLocaleString('ja-JP')}\`);
      });
      r.addEventListener('mouseleave', () => tooltip.hide());
      svg.appendChild(r);
    });

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
