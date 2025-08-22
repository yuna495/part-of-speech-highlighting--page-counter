// status_bar.js
// ステータスバー：ページ/行（原稿用紙風）、文字数（選択→なければ全体）表示、Git(HEAD)との差分（編集中ファイル単体）

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

// ------- 内部 state -------
let _statusBarItem = null;
let _debouncer = null;
let _idleRecomputeTimer = null;
let _enabledNote = true; // ページ情報表示のON/OFF（トグル用）
let _metrics = null; // computeNoteMetrics の結果（キャッシュ）
let _deltaFromHEAD = { key: null, value: null }; // ファイル単体の±
let _helpers = null; // { cfg, isTargetDoc }

// ------- 公開APIの初期化 -------
function initStatusBar(context, helpers) {
  _helpers = helpers;

  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    2
  );
  context.subscriptions.push(_statusBarItem);

  // 初回：アクティブエディタの情報で初期化
  if (vscode.window.activeTextEditor) {
    _recomputeFileDelta(vscode.window.activeTextEditor);
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
  }

  // 公開関数を返す
  return {
    // commands
    cmdRefreshPos,
    cmdToggleNote,
    cmdSetNoteSize,

    // events
    scheduleUpdate,
    recomputeOnSaveIfNeeded,
    onActiveEditorChanged,
    onSelectionChanged,
    onConfigChanged,

    // utils
    updateStatusBar,
    recomputeAndCacheMetrics,

    // for deactivate
    dispose: () => {
      if (_statusBarItem) _statusBarItem.dispose();
    },
  };
}

// Markdown風見出し検出（0〜3スペース許容）
function getHeadingLevel(lineText) {
  const m = lineText.match(/^ {0,3}(#{1,6})\s+\S/);
  return m ? m[1].length : 0;
}

// ------- 低レベル util -------
function countCharsNoLF(text) {
  return Array.from((text || "").replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;
}

// 表示用：設定に応じて半角/全角スペースを除外
function countCharsForDisplay(text, c) {
  const arr = Array.from((text || "").replace(/\r\n/g, "\n"));
  if (c?.countSpaces) {
    // スペースも字として数える
    return arr.filter((ch) => ch !== "\n").length;
  } else {
    // スペースは除外（半角: U+0020 / 全角: U+3000）
    return arr.filter((ch) => ch !== "\n" && ch !== " " && ch !== "　").length;
  }
}

function countSelectedCharsForDisplay(doc, selections, c) {
  let sum = 0;
  for (const sel of selections) {
    if (!sel.isEmpty) sum += countCharsForDisplay(doc.getText(sel), c);
  }
  return sum;
}

function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// 禁則折返し
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const banned = new Set(kinsokuEnabled ? bannedChars : []);
  let rows = 0;

  for (const line of lines) {
    const arr = Array.from(line);
    const n = arr.length;
    if (n === 0) {
      rows += 1;
      continue;
    }

    let pos = 0;
    while (pos < n) {
      let take = Math.min(cols, n - pos);
      if (kinsokuEnabled) {
        let ni = pos + take;
        while (ni < n && banned.has(arr[ni])) {
          take++;
          ni++;
        }
      }
      rows += 1;
      pos += take;
    }
  }
  return rows;
}

// 原稿用紙風メトリクス
function computeNoteMetrics(doc, c, selection) {
  // 全文（CRLF→LF 正規化）
  const fullText = doc.getText().replace(/\r\n/g, "\n");

  // 1) 総文字数：見出し行を除外して数える
  const allLines = fullText.split("\n");
  const nonHeadingLines = allLines.filter((ln) => getHeadingLevel(ln) === 0);
  const textNoHeadings = nonHeadingLines.join("\n");
  const totalChars = countCharsForDisplay(textNoHeadings, c); // ← 字は見出し除外＋スペース設定に従う

  // 2) ページ/行：従来どおり「全文」で計算（見出しを含む）
  const totalWrappedRows = wrappedRowsForText(
    fullText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalNotes = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerNote));

  // 3) 現在ページ：選択位置までのテキストで従来どおり計算（全文ベース）
  const prefixText = editorPrefixText(doc, selection);
  const currRows = wrappedRowsForText(
    prefixText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const currentNote = Math.max(
    1,
    Math.min(totalNotes, Math.ceil(currRows / c.rowsPerNote))
  );

  const rem = totalWrappedRows % c.rowsPerNote;
  const lastLineInLastNote = rem === 0 ? c.rowsPerNote : rem;

  return {
    totalChars,
    totalWrappedRows,
    totalNotes,
    currentNote,
    lastLineInLastNote,
  };
}

// Git ルート
function findGitRoot(startDir) {
  try {
    let dir = startDir;
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {}
  return null;
}
// HEAD のファイル内容
function readFileAtHEAD(gitRoot, relPath) {
  try {
    const r = cp.spawnSync("git", ["-C", gitRoot, "show", `HEAD:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (r.status === 0) return r.stdout;
  } catch {}
  return null;
}
// 現在/HEAD（編集中ファイル単体）
function _computeFileCharsAtHEAD(editor) {
  const doc = editor?.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) return { key: null, value: null };

  const gitRoot = findGitRoot(path.dirname(fsPath));
  if (!gitRoot) return { key: fsPath, value: null };

  const rel = path.relative(gitRoot, fsPath).replace(/\\/g, "/");
  const content = readFileAtHEAD(gitRoot, rel);
  if (content == null) return { key: fsPath, value: null };

  return { key: fsPath, value: countCharsNoLF(content) };
}
function _computeFileCharsCurrent(editor) {
  const doc = editor?.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) return { key: null, value: null };
  return { key: fsPath, value: countCharsNoLF(doc.getText()) };
}
function _recomputeFileDelta(editor) {
  const head = _computeFileCharsAtHEAD(editor);
  const curr = _computeFileCharsCurrent(editor);
  if (head.key) {
    _deltaFromHEAD.key = head.key;
    _deltaFromHEAD.value =
      head.value != null && curr.value != null ? curr.value - head.value : null;
  } else {
    _deltaFromHEAD = { key: null, value: null };
  }
}

// ------- メイン処理（公開APIで呼ばれる） -------
function recomputeAndCacheMetrics(editor) {
  const { cfg, isTargetDoc } = _helpers;
  if (!editor) {
    _metrics = null;
    return;
  }
  const c = cfg();
  if (!isTargetDoc(editor.document, c) || !_enabledNote || !c.enabledNote) {
    _metrics = null;
    return;
  }
  _metrics = computeNoteMetrics(editor.document, c, editor.selection);
}

function updateStatusBar(editor) {
  const { cfg, isTargetDoc } = _helpers;
  const c = cfg();
  if (!_statusBarItem) return;

  // 対象外は非表示（ページ情報OFFでも ±/字 は独立表示したい）
  if (!editor || !isTargetDoc(editor.document, c)) {
    _statusBarItem.hide();
    return;
  }

  // 1) ページ情報（enabledNote）
  let headPart = "";
  if (c.enabledNote && _enabledNote) {
    const mm = _metrics ?? {
      totalChars: 0,
      totalWrappedRows: 0,
      totalNotes: 1,
      currentNote: 1,
      lastLineInLastNote: 1,
    };
    headPart = `${mm.currentNote}/${mm.totalNotes} -${mm.lastLineInLastNote}（${c.rowsPerNote}×${c.colsPerRow}）`;
  }

  // 2) 字=選択文字数（未選択時は全体文字数）…… showSelectedChars
  let selPart = "";
  if (c.showSelectedChars) {
    const selections = editor.selections?.length
      ? editor.selections
      : [editor.selection];
    const selCnt = countSelectedCharsForDisplay(editor.document, selections, c);
    if (selCnt > 0) selPart = `${selCnt}字`;
    else {
      const total =
        _metrics?.totalChars ??
        countCharsForDisplay(editor.document.getText(), c);
      selPart = `${total}字`;
    }
  }

  // 3) ±=HEAD 差分…… showDeltaFromHEAD
  let deltaPart = "";
  if (c.showDeltaFromHEAD && _deltaFromHEAD.value != null) {
    const d = _deltaFromHEAD.value;
    const sign = d > 0 ? "＋" : d < 0 ? "－" : "±";
    deltaPart = ` ${sign}${Math.abs(d)}`;
  }

  // 4) 非表示判定
  if (!headPart && !selPart && !deltaPart) {
    _statusBarItem.hide();
    return;
  }

  // 5) テキスト結合
  const parts = [];
  if (headPart) parts.push(headPart);
  if (selPart) parts.push(selPart);
  if (deltaPart) parts.push(`${deltaPart}字`);
  _statusBarItem.text = parts.join(" ");

  // 6) ツールチップ
  const tips = [];
  if (c.enabledNote && _enabledNote)
    tips.push("選択位置/全体ページ｜行=最終文字が最後のページの何行目か");
  if (c.showSelectedChars)
    tips.push("字=選択文字数（改行除外）※未選択時は全体文字数");
  if (c.showDeltaFromHEAD) tips.push("±=HEAD(直近コミット)からの増減");
  _statusBarItem.tooltip = tips.join("｜");

  // 7) クリック時コマンド
  if (headPart) {
    // ページ情報が表示されているときだけクリックで setNoteSize が実行できる
    _statusBarItem.command = "posNote.setNoteSize";
  } else {
    // ページ情報OFFのときはクリックしても何も起こらない
    _statusBarItem.command = undefined;
  }

  // 8) 表示
  _statusBarItem.show();
}

function scheduleUpdate(editor) {
  const { cfg } = _helpers;
  const c = cfg();

  if (_debouncer) clearTimeout(_debouncer);
  _debouncer = setTimeout(() => updateStatusBar(editor), c.debounceMs);

  if (_idleRecomputeTimer) clearTimeout(_idleRecomputeTimer);
  _idleRecomputeTimer = setTimeout(() => {
    recomputeAndCacheMetrics(editor);
    updateStatusBar(editor);
  }, c.recomputeIdleMs);
}

// ------- events hooks -------
function recomputeOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  updateStatusBar(ed);
}
function onActiveEditorChanged(ed) {
  if (!ed) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  scheduleUpdate(ed);
}
function onSelectionChanged(editor) {
  recomputeAndCacheMetrics(editor);
  updateStatusBar(editor);
}
function onConfigChanged(editor) {
  recomputeAndCacheMetrics(editor);
  scheduleUpdate(editor);
}

// ------- commands -------
async function cmdRefreshPos() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  updateStatusBar(ed);
}
async function cmdToggleNote() {
  _enabledNote = !_enabledNote;
  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `ページカウンタ: ${_enabledNote ? "有効化" : "無効化"}`
  );
}
async function cmdSetNoteSize() {
  const { cfg } = _helpers;
  const c = cfg();
  const rows = await vscode.window.showInputBox({
    prompt: "1ページの行数",
    value: String(c.rowsPerNote),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!rows) return;
  const cols = await vscode.window.showInputBox({
    prompt: "1行の文字数",
    value: String(c.colsPerRow),
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : "正の整数で入力"),
  });
  if (!cols) return;

  const conf = vscode.workspace.getConfiguration("posNote");
  await conf.update(
    "Note.rowsPerNote",
    parseInt(rows, 10),
    vscode.ConfigurationTarget.Global
  );
  await conf.update(
    "Note.colsPerRow",
    parseInt(cols, 10),
    vscode.ConfigurationTarget.Global
  );

  const ed = vscode.window.activeTextEditor;
  if (ed) {
    recomputeAndCacheMetrics(ed);
    updateStatusBar(ed);
  }
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

module.exports = { initStatusBar };
