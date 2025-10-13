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
  };
}

module.exports = { initWorkload };
