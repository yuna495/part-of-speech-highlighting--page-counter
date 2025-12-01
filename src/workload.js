// workload.js
// ============================================================
// 作業量トラッカー（VS Code 拡張用モジュール）
// 目的
//   - 原稿ファイルの“出来上がりの長さ差”を基準に日次作業量を集計
//   - 追加も削除も作業量として加算する "net" が既定
//   - ステータスバー表示と 30 日分の簡易グラフ表示
//   - IME 候補巡回などの中間揺れは guard で“最終差のみ”確定可
//
// 主なエントリポイント
//   - initWorkload(context)
//   - applyExternalLen(docUri, curLen, { imeLike?: boolean })
//
// 設定キー（settings.json -> "posNote.workload.*"）
//   - enabled: boolean            作業量トラッカー ON/OFF（既定 true）
//   - dailyTarget: number         1 日の目標値
//   - timeZone: "system"|IANA     日次集計のタイムゾーン
//   - mode: "net"|"gross"|"signedLen"
//       net       : |差| を合計へ加算 追加は add 削除は del に反映
//       gross     : |差|×2 を合計へ加算（置換を重く数える）
//       signedLen : 符号付き差を合計へ加算 成果の純増減を見たい用途
//   - imeGuardMsNormal: number    通常編集の確定待ち 0 なら即時確定
//   - imeGuardMsCandidate: number 候補巡回らしい変更の確定待ち
//                                旧 imeGuardMs があればそれを流用
//
// 依存
//   - VS Code API（vscode）
// ============================================================

/* ------------------------------ 依存 ------------------------------ */
const vscode = require("vscode");

/* ------------------------------ 定数 ------------------------------ */
const KEY_HISTORY = "posNote.workload.history"; // globalState 格納キー

// デモ切替（true で架空履歴を返す。開発用）
const DEMO_MODE = false;

/* ------------------------------ 内部状態 ------------------------------ */
// VS Code 拡張コンテキストと UI
let _context = null;
let _statusBarItem = null;
let _graphPanel = null;

// 履歴キャッシュ（頻繁な read を最適化）
let _histCache = null;

// 直近のベースライン長（“確定済み”とみなす長さ）
const _baselineLenByDoc = new Map(); // key: docUri -> number

// IME などの候補巡回ガード
// key: docUri -> { startLen:number, lastLen:number, timer:NodeJS.Timeout|null }
const _imeGuardByDoc = new Map();

// 日付越え監視
let _lastDateKey = null;
let _midnightTimer = null;

/* ------------------------------ 設定取得 ------------------------------ */
function cfg() {
  const c = vscode.workspace.getConfiguration("posNote");
  return {
    workloadEnabled: c.get("workload.enabled", true),
    dailyTarget: c.get("workload.dailyTarget", 2000),
    timeZone: c.get("workload.timeZone", "system"),
    // "gross" | "net" | "signedLen"
    mode: c.get("workload.mode", "net"),
    // 通常編集の確定待ち（0 なら即確定）
    imeGuardMsNormal: c.get("workload.imeGuardMsNormal", 50),
    // 候補巡回らしい変更の確定待ち
    // 旧 imeGuardMs が設定されていればそれをデフォルトに利用
    imeGuardMsCandidate: c.get(
      "workload.imeGuardMsCandidate",
      c.get("workload.imeGuardMs", 800)
    ),
    // グラフスタイル（"bar"|"radial"）
    graphStyle: c.get("workload.graphStyle", "radial"),
  };
}

/* ------------------------------ 日時ユーティリティ ------------------------------ */
// TZ ごとの DateTimeFormat をキャッシュ
const _dtfCache = new Map(); // timeZone -> Intl.DateTimeFormat

function getDateKeyFormatter(timeZone) {
  const tz = timeZone && timeZone !== "system" ? timeZone : undefined; // OS 既定
  if (!tz) {
    // OSの TZ 変更に即追従するため system は毎回生成
    return new Intl.DateTimeFormat("ja-JP-u-ca-gregory", {
      timeZone: undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
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

// 指定 TZ の “YYYY-MM-DD” キーを返す
function toTzDateKey(d = new Date(), timeZone = "system") {
  const parts = getDateKeyFormatter(timeZone).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

/* ------------------------------ 共通ユーティリティ ------------------------------ */
// CRLF を LF に正規化してコードポイント数を数える
// 改行は 1 文字としてカウント
function countCharsWithNewline(text) {
  if (!text) return 0;
  const normalized = String(text).replace(/\r\n/g, "\n");
  return Array.from(normalized).length;
}

// 3 桁区切り
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}

/* ------------------------------ 履歴の取得と保存 ------------------------------ */
// デモ履歴を組み立て（視覚確認用）
function buildDemoHistory(days = 30) {
  const out = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toTzDateKey(d, cfg().timeZone);

    const dow = d.getDay(); // 0:日〜6:土
    const base = 1200 + (dow === 0 || dow === 6 ? 1800 : 400 * ((i % 3) - 1));
    const add = Math.max(0, Math.round(base * 0.7));
    const del = Math.max(0, Math.round(base * 0.3));
    const total = add + del;

    out[key] = { total, add, del };
  }
  return out;
}

function getHistory(context) {
  if (DEMO_MODE) return buildDemoHistory(30);
  if (_histCache) return _histCache;

  const obj = context.globalState.get(KEY_HISTORY);
  _histCache = obj && typeof obj === "object" ? obj : {};
  return _histCache;
}

async function saveHistory(context, hist) {
  if (DEMO_MODE) return;

  // 保持は直近 30 日
  const LIMIT_DAYS = 30;
  const keys = Object.keys(hist).sort();
  if (keys.length > LIMIT_DAYS) {
    const excess = keys.length - LIMIT_DAYS;
    for (let i = 0; i < excess; i++) delete hist[keys[i]];
  }

  await context.globalState.update(KEY_HISTORY, hist);
  _histCache = hist;
}

/* ------------------------------ ステータスバー ------------------------------ */
function ensureStatusBar(context) {
  if (_statusBarItem) return _statusBarItem;
  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    1 // 既存のページ/字より少し左寄せ優先
  );
  _statusBarItem.command = "posNote.workload.showGraph"; // クリックでグラフ
  context.subscriptions.push(_statusBarItem);
  return _statusBarItem;
}

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

  sb.text = `$(pencil) ${fmt(todaySum)}`;
  sb.tooltip = buildHoverTooltip(hist);
  sb.show();
}

/* ------------------------------ 日付越え監視 ------------------------------ */
function checkDateRollover() {
  if (!_context) return;
  const nowKey = toTzDateKey(new Date(), cfg().timeZone);

  if (_lastDateKey && nowKey === _lastDateKey) return;
  _lastDateKey = nowKey;

  const hist = getHistory(_context);
  if (hist[nowKey] == null) {
    hist[nowKey] = { total: 0, add: 0, del: 0 };
    saveHistory(_context, hist);
  }
  updateStatusBarText(cfg());
}

/* ------------------------------ メンテナンスコマンド ------------------------------ */
async function deleteOldestHistory(context) {
  const hist = getHistory(context);
  const keys = Object.keys(hist).sort(); // YYYY-MM-DD 文字列ソートで昇順
  if (keys.length === 0) {
    vscode.window.showInformationMessage("作業量ログは空です");
    return;
  }
  const oldest = keys[0];
  delete hist[oldest];
  await context.globalState.update(KEY_HISTORY, hist);
  updateStatusBarText(cfg());
  refreshGraphIfAny(context);
  vscode.window.showInformationMessage(`削除: ${oldest}`);
}

async function clearAllHistory(context) {
  // 1) 永続を空に
  await context.globalState.update(KEY_HISTORY, {});

  // 2) 今日 0 を再構成しキャッシュ更新
  const todayKey = toTzDateKey(new Date(), cfg().timeZone);
  _histCache = { [todayKey]: { total: 0, add: 0, del: 0 } };
  await context.globalState.update(KEY_HISTORY, _histCache);

  // 3) 現在のエディタ長でベースライン再セット 直後の1打鍵で爆増しないように
  try {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document) {
      const uri = ed.document.uri.toString();
      _baselineLenByDoc.set(uri, countCharsWithNewline(ed.document.getText()));
    }
  } catch {}

  // 4) UI 更新
  updateStatusBarText(cfg());
  refreshGraphIfAny(context);
  vscode.window.showInformationMessage("作業量ログを全て削除しました");
}

// === 任意日付の作業量を強制上書き（保存＆UI更新まで一括） ===
async function overrideWorkloadFor(dateKey, { total, add, del }) {
  const hist = getHistory(_context); // 既存履歴（キャッシュ経由）
  const toNum = (v) => Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0);

  let T = toNum(total);
  let A = toNum(add);
  // del が未指定なら total - add を用いる
  // add が total を超える場合は total に丸める（A<=T を保証）
  if (A > T) A = T;
  let D = del != null ? toNum(del) : Math.max(0, T - A);

  const next = { total: T, add: A, del: D };

  hist[dateKey] = next; // 置換
  await saveHistory(_context, hist); // globalState へ反映（30日整理込み）
  updateStatusBarText(cfg()); // ステータスバー更新
  refreshGraphIfAny(_context); // グラフが開いていれば再描画
  return next;
}

/* ------------------------------ グラフ表示（Webview） ------------------------------ */
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

function getGraphHtml(webview, days, targetValue = 10000) {
  const total = days.reduce((a, b) => a + (b.total || 0), 0);
  const maxTotal = Math.max(0, ...days.map((d) => d.total || 0));
  const maxAdd = Math.max(0, ...days.map((d) => d.add || 0));
  const maxDel = Math.max(0, ...days.map((d) => d.del || 0));
  const rawMax = Math.max(1, targetValue, maxTotal, maxAdd, maxDel);

  // 目標値の 1/5 刻み かつ 最低 100
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
      --bar:       var(--vscode-charts-blue,   #4da3ff66);
      --bar-max:   var(--vscode-charts-yellow, #bbd16666);
      --target:    var(--vscode-charts-red,    #ff5555);
      --grid: #4448;
    }
    body { margin: 0; font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans JP', sans-serif; color: var(--fg); background: var(--bg); }
    header { padding: 12px 16px; border-bottom: 1px solid #ffffff12; }
    header h1 { font-size: 14px; margin: 0 0 4px 0; }
    header .meta { color: var(--axis); }
    .wrap { padding: 10px 16px 16px; }
    .legend { display:flex; gap:16px; align-items:center; margin: 6px 0 12px; color: var(--axis); }
    .swatch { width:10px; height:10px; border-radius: 2px; display:inline-block; margin-right:6px; vertical-align: -1px; }
    .swatch.bar     { background: #4da3ff66; }
    .swatch.max     { background: #bbd16666; }
    .swatch.target  { background: #ff0000; }
    .swatch.lineAdd { background: #00ff55; }
    .swatch.lineDel { background: #ff00ff; }
    .chart { width: 100%; height: 600px; border-left:1px solid var(--axis); border-bottom:1px solid var(--axis); position: relative; }
    svg { width: 100%; height: 100%; display:block; }
    .xlabels { display:flex; justify-content:space-between; margin-top:6px; color: var(--axis); font-size: 11px; }
    .hint { margin-top: 8px; color: var(--axis); }
    /* 1/5 ガイド円 */
    .guide5 { stroke: var(--grid); fill: none; opacity: .6 }
    .guide5:nth-child(odd) { opacity: .35 }
    /* ラベル体裁 */
    .tick-label { fill: var(--axis); font-size: 11px; dominant-baseline: middle; }


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
    <div class="hint">右端が本日。バーにマウスを置くと数値を表示します。setting.jsonで "posNote.workload.graphStyle": "radial" に変更できます。</div>
  </div>

  <script>
    const DAYS = ${JSON.stringify(days)};
    const chartMax = ${chartMax};
    const targetValue = ${targetValue};
    const MAX_TOTAL = ${maxTotal};
    const TICK_STEP = ${TICK_STEP};

    const svg = document.getElementById('chartSvg');
    const W = 1000, H = 600, PAD = 28;
    const innerW = W - PAD*2, innerH = H - PAD*2;

    // グリッド
    for (let v = 0; v <= chartMax; v += TICK_STEP) {
      const y = PAD + (innerH - (v / chartMax) * (innerH - 1));
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', PAD);
      line.setAttribute('x2', W - PAD);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', '#4448');
      svg.appendChild(line);
    }

    const n = DAYS.length;
    const gap = 3;
    const barW = innerW / n;

    // 目標ライン
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

    // ツールチップ
    const tooltip = (() => {
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
      };
    })();

    // 棒（total）
    DAYS.forEach((d, i) => {
      const h = chartMax ? ((d.total||0) / chartMax) * (innerH - 1) : 0;
      const x = PAD + barW * i + gap * 0.5;
      const y = PAD + (innerH - h);
      const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', Math.max(1, barW - gap * 3));
      r.setAttribute('height', Math.max(0, h));
      const isMax = (d.total||0) === MAX_TOTAL && MAX_TOTAL > 0;
      const isBelowTarget = (d.total||0) < targetValue;
      if (isMax) {
        r.setAttribute('fill', '#bbd16666'); // 最大日のバー
      } else if (isBelowTarget) {
        r.setAttribute('fill', '#ff993366'); // 目標未達→オレンジ系
      } else {
        r.setAttribute('fill', '#4da3ff66'); // 通常バー
      }
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

    // 折れ線 add
    const polyAdd = document.createElementNS('http://www.w3.org/2000/svg','polyline');
    polyAdd.setAttribute('points', polyPoints('add'));
    polyAdd.setAttribute('fill','none');
    polyAdd.setAttribute('stroke', '#00ff55');
    polyAdd.setAttribute('stroke-width','6');
    svg.appendChild(polyAdd);

    // 折れ線 del
    const polyDel = document.createElementNS('http://www.w3.org/2000/svg','polyline');
    polyDel.setAttribute('points', polyPoints('del'));
    polyDel.setAttribute('fill','none');
    polyDel.setAttribute('stroke', '#ff00ff');
    polyDel.setAttribute('stroke-width','6');
    svg.appendChild(polyDel);

    // 頂点マーカー
    for (let i = 0; i < n; i++) {
      const d = DAYS[i];
      const xCenter = PAD + (barW * i + (barW - gap)/2 + gap*0.5);
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
      if ((d.del||0) > 0) {
        const yDel = PAD + (innerH - (d.del / chartMax) * (innerH - 1));
        const s = 16;
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

    // X 軸ラベル（左 中央 右のみ）
    const xl = document.getElementById('xlabels');
    const left = DAYS[0]?.date ?? '';
    const mid = DAYS[Math.floor(n/2)]?.date ?? '';
    const right = DAYS[n-1]?.date ?? '';
    xl.innerHTML = \`<span>\${left}</span><span>\${mid}</span><span>\${right}</span>\`;

    function polyPoints(kind) {
      const pts = [];
      for (let i=0;i<n;i++){
        const d = DAYS[i];
        const v = kind === 'add' ? (d.add||0) : (d.del||0);
        const x = PAD + (barW * i + (barW - gap)/2 + gap*0.5);
        const y = PAD + (innerH - (v / chartMax) * (innerH - 1));
        pts.push(x + ',' + y);
      }
      return pts.join(' ');
    }
  </script>
</body>
</html>`;
}

function getRadialGraphHtml(webview, days, targetValue = 10000) {
  // スケールづくり（既存の最大値決定ロジックと同等の考え方）
  const maxTotal = Math.max(0, ...days.map((d) => d.total || 0));
  const maxAdd = Math.max(0, ...days.map((d) => d.add || 0));
  const maxDel = Math.max(0, ...days.map((d) => d.del || 0));
  const rawMax = Math.max(1, targetValue, maxTotal, maxAdd, maxDel);

  // 目標値の 1/5刻み（棒グラフのTICK_STEPと挙動を合わせる）
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

  // 円図パラメータ
  const W = 720,
    H = 720; // 正方キャンバス
  const CX = W / 2,
    CY = H / 2; // 中心
  const R_INNER = 50; // 内側の基準半径（ゼロ作業量でも見える土台）
  const R_MAX = 360; // スケール上限半径
  const GAP_DEG = 0.8; // 扇の間のすき間（視認性向上）
  const SLICE_DEG = 12; // 1日ぶんの角度
  const HALF_DEG = 6; // add / del の半分角
  const START_DEG = -90; // 12時＝最新の中央線

  // 値→半径
  const scaleR = (v) =>
    R_INNER + (Math.max(0, v) / chartMax) * (R_MAX - R_INNER);

  // 極座標→直交
  const toXY = (r, deg) => {
    const rad = (Math.PI / 180) * deg;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  };

  // 扇（内側半径 ri, 外側半径 ro, 角度 [a0,a1]）のパス
  const ringWedge = (ri, ro, a0, a1) => {
    // 角度のわずかな隙間で重なりを防ぐ
    const a0c = a0 + GAP_DEG * 0.5;
    const a1c = a1 - GAP_DEG * 0.5;
    const [x0, y0] = toXY(ro, a0c);
    const [x1, y1] = toXY(ro, a1c);
    const [x2, y2] = toXY(ri, a1c);
    const [x3, y3] = toXY(ri, a0c);
    const large = a1c - a0c > 180 ? 1 : 0;
    return [
      `M ${x0} ${y0}`,
      `A ${ro} ${ro} 0 ${large} 1 ${x1} ${y1}`,
      `L ${x2} ${y2}`,
      `A ${ri} ${ri} 0 ${large} 0 ${x3} ${y3}`,
      `Z`,
    ].join(" ");
  };

  // 目標リング（点線）
  const targetR = scaleR(targetValue);

  // === ガイド円（0/5〜N/5）を描く ただし本数が多すぎる場合は間引く ===
  // 基本刻み：目標値の 1/5
  const fifthStep = Math.max(1, Math.floor(targetValue / 5));

  // 上限は 目標値 と 実記録の最大(total) の大きい方
  const maxRecord = Math.max(targetValue, maxTotal);

  // 何本分の等間隔か 0 を含めるので +1 想定
  const ticksTotal = Math.ceil(maxRecord / fifthStep); // 1/5 単位の本数
  const MAX_RINGS = 10; // 表示本数の上限目安

  // 多すぎるときは間引き係数を上げる 例) 24本なら skip=3 → 0,3,6,…,24 を描く
  const skip = Math.max(1, Math.ceil(ticksTotal / MAX_RINGS));

  // ホスト側用の半径スケール
  const scaleRHost = (v) =>
    R_INNER + (Math.max(0, v) / chartMax) * (R_MAX - R_INNER);

  // 0/5〜N/5 の同心円を描画 ただし skip 間隔で間引く
  // 末端の最外周は必ず描くため最後に明示的に追加
  let rings = [];
  for (let i = 0; i <= ticksTotal; i++) {
    if (i % skip !== 0) continue;
    const r = scaleRHost(i * fifthStep);
    rings.push(`<circle class="guide guide5" cx="${CX}" cy="${CY}" r="${r}"/>`);
  }
  // 最外周を保証
  const rEdge = scaleRHost(ticksTotal * fifthStep);
  if (!rings.length || !rings[rings.length - 1].includes(`r="${rEdge}"`)) {
    rings.push(
      `<circle class="guide guide5" cx="${CX}" cy="${CY}" r="${rEdge}"/>`
    );
  }
  const ringGrid = rings.join("");

  // ラベルは出さない
  const labelsHtml = "";

  // SVG 本体
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>純作業量（過去30日）・円環</title>
  <style>
    :root{
      --fg: #ddd;
      --bg: var(--vscode-editor-background, #1e1e1e);
      --axis: #888;
      /* 棒グラフの固定色に完全一致させる */
      --bar:       #4da3ff;  /* 通常バー */
      --bar-max:   #bbd166;  /* 最大バー */
      --add:       #00ff55;    /* add 線・マーカー */
      --del:       #ff00ff;    /* del 線・マーカー */
      --target:    #ff0000;    /* 目標ライン ※棒側に合わせて #ff0000 */
      --grid: #444;
    }
    body{margin:0; color:var(--fg); background:var(--bg); font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;}
    header{padding:12px 16px; border-bottom:1px solid #ffffff12;}
    header h1{font-size:14px; margin:0 0 4px;}
    .meta{color:var(--axis);}
    .wrap{padding:10px 8px 16px;}
    .legend{display:flex; gap:16px; align-items:center; margin:8px 0 12px; color:var(--axis);}
    .sw{width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:6px; vertical-align:-1px;}
    .sw.add{ background: var(--add); }
    .sw.del{ background: var(--del); }
    .sw.total{ background: var(--bar); opacity:.55;}
    .sw.max{ background: var(--bar-max); }
    .sw.target{ background: transparent; border:1px dashed var(--target); width:12px; height:12px; border-radius:50%;}
    .chart{display:flex; justify-content:center;}
    svg{width:${W}px; height:${H}px; display:block;}
    .ticks text{ fill: var(--axis); font-size:11px; text-anchor:middle; }
    .hint{margin-top:6px; color:var(--axis);}
    .tooltip{
      position:fixed; padding:4px 8px; font-size:11px;
      background:rgba(0,0,0,.85); color:#fff; border-radius:4px;
      pointer-events:none; transform:translate(12px,12px);
      z-index:10000; display:none; white-space:pre;
    }
    .day-total{ fill: var(--bar); opacity:.4; }
    .day-total-max{ fill: var(--bar-max); opacity:.6; }
    .day-add{   fill: var(--add); opacity:.85; }
    .day-del{   fill: var(--del); opacity:.85; }
    .ring-target{ stroke: var(--target); stroke-dasharray:6 4; fill:none; }
    .guide{ stroke: var(--grid); fill:none; }
    .hand{ stroke: var(--axis); stroke-width:1; }
    .today-dot{ fill: var(--bar-max); }
  </style>
</head>
<body>
  <header>
    <h1>純作業量（過去30日）・円環</h1>
    <div class="meta">右回りで過去へ。12時＝最新。内から外へ半径が増える。</div>
  </header>
  <div class="wrap">
    <div class="legend">
      <span><span class="sw total"></span>合計（基底扇）</span>
      <span><span class="sw max"></span>最大日の扇</span>
      <span><span class="sw add"></span>入力</span>
      <span><span class="sw del"></span>削除</span>
      <span><span class="sw target"></span>目標ライン（${targetValue.toLocaleString(
        "ja-JP"
      )}）</span>
    </div>

    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" aria-label="純作業量 円環グラフ" role="img" id="radialSvg">
        <!-- ガイド円（目標値1/5刻み 自動間引き 目標超えは最大記録まで拡張） -->
        ${ringGrid}
        <!-- 目盛ラベルは非表示 -->
        <g class="ticks">
          ${labelsHtml}
        </g>
        <!-- 目標リング -->
        <circle class="ring-target" cx="${CX}" cy="${CY}" r="${targetR}"/>

        <!-- 12時の基準線（今日の位置） -->
        <line class="hand" x1="${CX}" y1="${CY}" x2="${CX}" y2="${
    CY - R_MAX - 4
  }" />

        <!-- データ本体は後段のscriptで追加 -->
      </svg>
    </div>
    <div class="hint">扇にマウスを置くと数値を表示。setting.jsonで "posNote.workload.graphStyle": "bar" に変更できます。</div>
    <div class="tooltip" id="tip"></div>
  </div>

  <script>
  const DAYS = ${JSON.stringify(days)}; // buildLastNDays()の出力
  const chartMax = ${chartMax};
  const targetValue = ${targetValue};
  const MAX_TOTAL = ${maxTotal};

  const W=${W}, H=${H}, CX=${CX}, CY=${CY}, R_INNER=${R_INNER}, R_MAX=${R_MAX};
  const SLICE_DEG=${SLICE_DEG}, HALF_DEG=${HALF_DEG}, START_DEG=${START_DEG}, GAP_DEG=${GAP_DEG};

  const scaleR = (v) => R_INNER + (Math.max(0, v) / chartMax) * (R_MAX - R_INNER);
  const toXY = (r, deg) => {
    const rad = (Math.PI/180)*deg;
    return [CX + r*Math.cos(rad), CY + r*Math.sin(rad)];
  };
  const ringWedge = (ri, ro, a0, a1) => {
    const a0c = a0 + GAP_DEG * .5;
    const a1c = a1 - GAP_DEG * .5;
    const [x0,y0] = toXY(ro, a0c);
    const [x1,y1] = toXY(ro, a1c);
    const [x2,y2] = toXY(ri, a1c);
    const [x3,y3] = toXY(ri, a0c);
    const large = (a1c - a0c) > 180 ? 1 : 0;
    return [
      'M',x0,y0,
      'A',ro,ro,0,large,1,x1,y1,
      'L',x2,y2,
      'A',ri,ri,0,large,0,x3,y3,
      'Z'
    ].join(' ');
  };

  const svg = document.getElementById('radialSvg');
  const tip = document.getElementById('tip');

  // ツールチップ制御
  const showTip = (ev, text) => { tip.textContent = text; tip.style.left=ev.clientX+'px'; tip.style.top=ev.clientY+'px'; tip.style.display='block'; };
  const hideTip = () => tip.style.display='none';

    // index 0 を「最新」にするため配列を逆参照
  const n = DAYS.length;

  for (let i = 0; i < n; i++) {
    // 配列末尾が最新 → i=0 が最新になるように取り出す
    const d = DAYS[n - 1 - i];

    // 12時を開始角。そこから時計回りに i*12° 進める
    const aStart = START_DEG + i * SLICE_DEG;      // 開始角（最新の扇の始点）
    const aMid   = aStart + HALF_DEG;              // 6°
    const aEnd   = aStart + SLICE_DEG;             // 12°

    const rTotal = scaleR(d.total || 0);
    const rAdd   = scaleR(d.add   || 0);
    const rDel   = scaleR(d.del   || 0);

    // total：12° 全体を半透明で
    const pTotal = document.createElementNS('http://www.w3.org/2000/svg','path');
    pTotal.setAttribute('d', ringWedge(R_INNER, rTotal, aStart, aEnd));
    const isMax = (d.total||0) === MAX_TOTAL && MAX_TOTAL > 0;
    const isBelowTarget = (d.total||0) < targetValue;

    if (isMax) {
      pTotal.setAttribute('fill', '#bbd166'); // 最大日の扇
      pTotal.setAttribute('opacity', '.6');
    } else if (isBelowTarget) {
      pTotal.setAttribute('fill', '#ff9933'); // 目標未達→オレンジ
      pTotal.setAttribute('opacity', '.5');
    } else {
      pTotal.setAttribute('fill', '#4da3ff'); // 通常
      pTotal.setAttribute('opacity', '.4');
    }

    pTotal.addEventListener('mousemove', (ev) => {
      showTip(
        ev,
        d.date + "\\n" +
        "total: " + (d.total||0).toLocaleString('ja-JP')
      );
    });
    pTotal.addEventListener('mouseleave', hideTip);
    svg.appendChild(pTotal);

    // add：前半 6°
    const pAdd = document.createElementNS('http://www.w3.org/2000/svg','path');
    pAdd.setAttribute('d', ringWedge(R_INNER, rAdd, aStart, aMid));
    pAdd.setAttribute('class','day-add');
    pAdd.addEventListener('mousemove', (ev) => {
      showTip(
        ev,
        d.date + "\\n" +
        "add: " + (d.add||0).toLocaleString('ja-JP')
      );
    });
    pAdd.addEventListener('mouseleave', hideTip);
    svg.appendChild(pAdd);

    // del：後半 6°
    const pDel = document.createElementNS('http://www.w3.org/2000/svg','path');
    pDel.setAttribute('d', ringWedge(R_INNER, rDel, aMid, aEnd));
    pDel.setAttribute('class','day-del');
    pDel.addEventListener('mousemove', (ev) => {
      showTip(
        ev,
        d.date + "\\n" +
        "del: " + (d.del||0).toLocaleString('ja-JP')
      );
    });
    pDel.addEventListener('mouseleave', hideTip);
    svg.appendChild(pDel);

    // 最新日の目印ドット（i=0 のみ。12時開始位置の外側）
    if (i === 0) {
      const [dx, dy] = toXY(R_MAX + 6, START_DEG);
      const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx', dx);
      dot.setAttribute('cy', dy);
      dot.setAttribute('r', 4);
      dot.setAttribute('class','today-dot');
      svg.appendChild(dot);
    }
  }
  </script>
</body>
</html>`;

  return html;
}

function showWorkloadGraph(context) {
  const makeHtml = () => {
    const hist = getHistory(context);
    const days = buildLastNDays(hist, 30);
    const { dailyTarget, graphStyle } = cfg();
    return graphStyle === "radial"
      ? getRadialGraphHtml(_graphPanel.webview, days, dailyTarget)
      : getGraphHtml(_graphPanel.webview, days, dailyTarget);
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

function refreshGraphIfAny(context) {
  if (_graphPanel) {
    const hist = getHistory(context);
    const days = buildLastNDays(hist, 30);
    const { dailyTarget, graphStyle } = cfg();
    _graphPanel.webview.html =
      graphStyle === "radial"
        ? getRadialGraphHtml(_graphPanel.webview, days, dailyTarget)
        : getGraphHtml(_graphPanel.webview, days, dailyTarget);
  }
}

/* ------------------------------ コア集計ロジック ------------------------------ */
// “いまの curLen” を確定値として履歴に反映
function commitLenDiff(docUri, curLen) {
  const c = cfg();
  const baseLen = _baselineLenByDoc.get(docUri) ?? curLen;
  const lenDiff = curLen - baseLen;

  // 変化なし
  if (lenDiff === 0) {
    _baselineLenByDoc.set(docUri, curLen);
    updateStatusBarText(c);
    return;
  }

  // mode ごとの合計寄与量
  let delta = 0;
  if (c.mode === "signedLen") delta = lenDiff; // ±で積む
  else if (c.mode === "gross") delta = Math.abs(lenDiff) * 2; // 置換を重く
  else delta = Math.abs(lenDiff); // "net": 追加も削除も正で積む

  // ベースライン更新
  _baselineLenByDoc.set(docUri, curLen);

  // 履歴更新
  const hist = getHistory(_context);
  const key = toTzDateKey(new Date(), c.timeZone);
  const cur = hist[key];

  let rec =
    typeof cur === "number"
      ? { total: cur, add: 0, del: 0 }
      : cur && typeof cur === "object"
      ? { ...cur }
      : { total: 0, add: 0, del: 0 };

  // add / del の内訳
  if (c.mode === "signedLen") {
    if (lenDiff > 0) rec.add += lenDiff;
    else rec.del += -lenDiff;
    rec.total += delta; // ±で total を動かす
  } else if (c.mode === "net") {
    if (lenDiff > 0) rec.add += lenDiff;
    else rec.del += -lenDiff;
    rec.total += delta; // |差| で積む
  } else {
    // gross は“手数”重視なので total のみ
    rec.total += delta;
  }

  hist[key] = rec;
  saveHistory(_context, hist);
  updateStatusBarText(c);
}

// IME ガードのタイムアウトで“最終差のみ”確定
function commitImeGuard(docUri) {
  const guard = _imeGuardByDoc.get(docUri);
  if (!guard) return;
  _imeGuardByDoc.delete(docUri);

  // セッション開始長 → 最後に観測した長さ の最終差だけ積む
  commitLenDiff(docUri, guard.lastLen);
}

/**
 * 外部から“現在の文書長”を与える API
 * - 通常編集は imeGuardMsNormal
 * - 候補巡回らしい変更は imeGuardMsCandidate
 * guard が 0 以下なら即時確定
 *
 * @param {string}  docUri  e.document.uri.toString()
 * @param {number}  curLen  現在の全文字数（countCharsWithNewline で算出した値を推奨）
 * @param {{imeLike?: boolean}} opts  候補巡回らしいかのヒント
 */
function applyExternalLen(docUri, curLen, opts = {}) {
  const c = cfg();

  // 使う待機時間
  const isImeLike = !!opts.imeLike;
  const guardMs = isImeLike ? c.imeGuardMsCandidate : c.imeGuardMsNormal;

  // guard 0 → 即確定
  if (!guardMs || guardMs <= 0) {
    commitLenDiff(docUri, curLen);
    return;
  }

  // ガードあり → セッションバッファへ 連続入力を“最終差だけ”に集約
  const baseLen = _baselineLenByDoc.get(docUri) ?? curLen;
  let guard = _imeGuardByDoc.get(docUri);
  if (!guard) {
    guard = { startLen: baseLen, lastLen: curLen, timer: null };
    _imeGuardByDoc.set(docUri, guard);
  } else {
    guard.lastLen = curLen;
    if (guard.timer) {
      clearTimeout(guard.timer);
      guard.timer = null;
    }
  }
  guard.timer = setTimeout(() => commitImeGuard(docUri), guardMs);
}

/* ------------------------------ 初期化 ------------------------------ */
function initWorkload(context) {
  _context = context;

  ensureStatusBar(context);

  // 起動時にアクティブエディタのベースラインを確立
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document) {
    _baselineLenByDoc.set(
      ed.document.uri.toString(),
      countCharsWithNewline(ed.document.getText())
    );
  }

  // アクティブエディタ変更で UI 更新
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatusBarText(cfg());
    }),
    // ドキュメントを閉じたらキャッシュとタイマーをクリア（メモリリーク対策）
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      _baselineLenByDoc.delete(uri);
      // IME ガードのタイマーも確実にクリア
      const guard = _imeGuardByDoc.get(uri);
      if (guard?.timer) {
        clearTimeout(guard.timer);
      }
      _imeGuardByDoc.delete(uri);
    })
  );

  // ミッドナイト監視（60 秒周期）
  _lastDateKey = toTzDateKey(new Date(), cfg().timeZone);
  _midnightTimer = setInterval(() => {
    checkDateRollover();
  }, 60 * 1000);

  // dispose 時に監視停止
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

  // コマンド登録
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.workload.showGraph", async () => {
      const c = cfg();
      if (!c.workloadEnabled) return;
      showWorkloadGraph(context);
    }),
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
    ),
    vscode.commands.registerCommand("posNote.workload.clearAll", async () => {
      const pick = await vscode.window.showWarningMessage(
        "作業量ログを全て削除します。元に戻せません。よろしいですか",
        { modal: true },
        "全削除"
      );
      if (pick === "全削除") await clearAllHistory(context);
    }),
    // === 任意日付の作業量を上書き ===
    // initWorkload(context) の中で他の registerCommand と並べて追加
    vscode.commands.registerCommand(
      "posNote.workload.overrideAtDate",
      async () => {
        try {
          const c = cfg();
          const todayKey = toTzDateKey(new Date(), c.timeZone);
          const toNum = (v) =>
            Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0);

          // 1) 日付入力（既定は今日） YYYY-MM-DD
          let dateKey = await vscode.window.showInputBox({
            prompt: "上書きする日付 (YYYY-MM-DD)",
            value: todayKey,
            validateInput: (s) =>
              /^\d{4}-\d{2}-\d{2}$/.test(s)
                ? undefined
                : "YYYY-MM-DD で入力してください",
            ignoreFocusOut: true,
          });
          if (!dateKey) return;

          // 2) 現在値の読込（表示の初期値に利用）
          const hist = getHistory(_context);
          const cur = hist[dateKey];
          const curTotal = typeof cur === "number" ? cur : cur?.total || 0;
          const curAdd = typeof cur === "number" ? 0 : cur?.add || 0;

          // 3) total 入力
          const sTotal = await vscode.window.showInputBox({
            prompt: `total を入力（${dateKey}）`,
            value: String(curTotal),
            ignoreFocusOut: true,
          });
          if (sTotal == null) return;

          // 4) add 入力（del は入力不要）
          const sAdd = await vscode.window.showInputBox({
            prompt: `add を入力（${dateKey}）  ※ total を超えないこと`,
            value: String(curAdd),
            ignoreFocusOut: true,
          });
          if (sAdd == null) return;

          // 5) 数値化と検証
          const nTotal = toNum(sTotal);
          const nAdd = toNum(sAdd);

          if (nAdd > nTotal) {
            vscode.window.showErrorMessage(
              `add が total を超えています  total=${nTotal}  add=${nAdd}`
            );
            return;
          }

          // 6) 自動計算: del = total - add
          const nDel = nTotal - nAdd;

          // 7) 上書き実行（overrideWorkloadFor 側でも A<=T を保証）
          const next = await overrideWorkloadFor(dateKey, {
            total: nTotal,
            add: nAdd,
            del: nDel,
          });
          vscode.window.showInformationMessage(
            `作業量を更新しました ${dateKey}  total:${next.total} / add:${next.add} / del:${next.del}`
          );
        } catch (e) {
          console.error(e);
          vscode.window.showErrorMessage("作業量の上書きに失敗しました");
        }
      }
    )
  );

  // 本日レコードの存在を保証
  checkDateRollover();

  return {
    onConfigChanged() {
      const c = cfg();
      updateStatusBarText(c);
      // 設定変更で既存パネルを即再描画（graphStyle や dailyTarget を反映）
      refreshGraphIfAny(_context);
    },
  };
}

/* ------------------------------ 公開 ------------------------------ */
module.exports = { initWorkload, applyExternalLen };
