// status_bar.js
// ステータスバー：ページ/行（原稿用紙風）、文字数（選択→なければ全体）表示、Git(HEAD)との差分（編集中ファイル単体）
// ＋ 同フォルダ・同拡張子「他ファイル」合算文字数（トグル可）

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const { getHeadingLevel } = require("./utils");

// ------- 内部 state -------
let _statusBarItem = null;
let _debouncer = null;
let _idleRecomputeTimer = null;
let _enabledNote = true; // ページ情報表示のON/OFF（トグル用）
let _metrics = null; // computeNoteMetrics の結果（キャッシュ）
let _deltaFromHEAD = { key: null, value: null }; // ファイル単体の±
let _helpers = null; // { cfg, isTargetDoc }
let _folderSumChars = null; // ★追加：同フォルダ・同拡張子（他ファイル）合算文字数

// デフォルトの禁則文字（行頭禁止）
const DEFAULT_BANNED_START = [
  "」",
  "）",
  "『",
  "』",
  "》",
  "】",
  "。",
  "、",
  "’",
  "”",
  "！",
  "？",
  "…",
  "—",
  "―",
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゃ",
  "ゅ",
  "ょ",
  "っ",
  "ー",
  "々",
  "ゞ",
  "ゝ",
  "ァ",
  "ィ",
  "ゥ",
  "ェ",
  "ォ",
  "ャ",
  "ュ",
  "ョ",
  "ッ",
];

function getBannedStart() {
  const config = vscode.workspace.getConfiguration("posNote");
  const userValue = config.get("kinsoku.bannedStart");
  return Array.isArray(userValue) && userValue.length > 0
    ? userValue
    : DEFAULT_BANNED_START;
}

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
    recomputeFolderSum(vscode.window.activeTextEditor);
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

// ------- 低レベル util -------
function countCharsNoLF(text) {
  return Array.from((text || "").replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;
}

// 3桁区切りフォーマッタ（日本語ロケール）
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}

/**
 * テキストを行配列に分解して、行頭の ``` で始まる行の“ペア”に挟まれた行を除去する。
 * 未クローズ（奇数個）の場合は **無視**（= 除外しない）して誤爆を防ぐ。
 * 返り値は、コードフェンス行自身も含めて除去した新しいテキスト。
 */
function stripClosedCodeFences(text) {
  const src = String(text || "").split(/\r?\n/);
  const fenceRe = /^\s*```/;
  const fenceLines = [];
  for (let i = 0; i < src.length; i++) {
    if (fenceRe.test(src[i])) fenceLines.push(i);
  }
  if (fenceLines.length < 2) return src.join("\n");

  // 奇数の場合は末尾の開始だけ無視
  if (fenceLines.length % 2 === 1) fenceLines.pop();

  // 除外ラインをマーク
  const mask = new Array(src.length).fill(false);
  for (let k = 0; k < fenceLines.length; k += 2) {
    const s = fenceLines[k],
      e = fenceLines[k + 1];
    for (let i = s; i <= e; i++) mask[i] = true; // フェンス行自身も除外
  }

  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (!mask[i]) out.push(src[i]);
  }
  return out.join("\n");
}

// 見出し行（# で始まり getHeadingLevel(...) > 0 の行）を丸ごと除外
function stripHeadingLines(text) {
  const src = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const ln of src) {
    // getHeadingLevel は 0=見出しでない、>0=見出し
    if (getHeadingLevel(ln) === 0) kept.push(ln);
  }
  return kept.join("\n");
}

// 表示用：設定に応じて半角/全角スペースを除外
function countCharsForDisplay(text, c) {
  // 改行正規化
  let t = (text || "").replace(/\r\n/g, "\n");

  // コードフェンス除外（ペア成立のみ）
  t = stripClosedCodeFences(t);

  // 見出し行を丸ごと除外（未選択時・選択時・合算の全てで統一）
  t = stripHeadingLines(t);

  // 《...》括弧内を除去
  t = t.replace(/《.*?》/g, "");

  const arr = Array.from(t);
  if (c?.countSpaces) {
    // スペースも字として数えるが、「#」 「|」 「｜」 は常に除外
    return arr.filter(
      (ch) => ch !== "\n" && ch !== "#" && ch !== "|" && ch !== "｜"
    ).length;
  } else {
    // スペースは除外（半角/全角）、さらに 「#」 「|」 「｜」 も除外
    return arr.filter(
      (ch) =>
        ch !== "\n" &&
        ch !== " " &&
        ch !== "　" &&
        ch !== "#" &&
        ch !== "|" &&
        ch !== "｜"
    ).length;
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
  // 改行正規化
  let t = (text || "").replace(/\r\n/g, "\n");

  // コードフェンス除外（ペア成立のみ）
  t = stripClosedCodeFences(t);

  // 《...》括弧内を除去
  t = t.replace(/《.*?》/g, "");

  const lines = t.split("\n");
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

// ------- ★追加：同フォルダ・同拡張子（他ファイル）合算 -------
// 同フォルダ・同拡張子の合算（★編集中ファイルも含む。未保存の変更も反映）
function computeFolderSumChars(editor, c) {
  try {
    const doc = editor?.document;
    const uri = doc?.uri;
    if (!uri || uri.scheme !== "file") return null;

    const currentPath = uri.fsPath;
    const dir = path.dirname(currentPath);
    const ext = path.extname(currentPath).toLowerCase();
    if (!ext) return null;

    // 1) まず編集中のドキュメントをカウント（未保存の内容も反映）
    //    他ファイルと同じカウント規則（countCharsForDisplay）を使用
    let sum = countCharsForDisplay(doc.getText(), c);

    // 2) 同フォルダにある同拡張子の"他ファイル"を加算
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (path.extname(name).toLowerCase() !== ext) continue;

      const full = path.join(dir, name);
      // ファイルのみ対象
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      // 自分はすでに加算済みなのでスキップ
      if (path.resolve(full) === path.resolve(currentPath)) continue;

      // 他ファイルも countCharsForDisplay を厳密適用
      let content;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      sum += countCharsForDisplay(content, c);
    }

    return sum;
  } catch {
    return null;
  }
}

function recomputeFolderSum(editor) {
  const { cfg, isTargetDoc } = _helpers;
  if (!editor) {
    _folderSumChars = null;
    return;
  }
  const c = cfg();
  if (!isTargetDoc(editor.document, c)) {
    _folderSumChars = null;
    return;
  }
  if (!c.showFolderSum) {
    _folderSumChars = null;
    return;
  }
  _folderSumChars = computeFolderSumChars(editor, c);
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
    headPart = `${fmt(mm.currentNote)} / ${fmt(mm.totalNotes)} -${fmt(
      mm.lastLineInLastNote
    )}（${fmt(c.rowsPerNote)}×${fmt(c.colsPerRow)}）`;
  }

  // 2) 字=選択文字数（未選択時は全体文字数）
  let selPart = "";
  if (c.showSelectedChars) {
    const selections = editor.selections?.length
      ? editor.selections
      : [editor.selection];
    const selCnt = countSelectedCharsForDisplay(editor.document, selections, c);
    const baseTotal =
      _metrics?.totalChars ??
      countCharsForDisplay(editor.document.getText(), c);

    const shown = selCnt > 0 ? selCnt : baseTotal;

    // フォルダ合算の追記（設定ONかつ合算が算出できた場合）
    if (c.showFolderSum && _folderSumChars != null) {
      selPart = `${fmt(shown)}字 / ${fmt(_folderSumChars)}`;
    } else {
      selPart = `${fmt(shown)}字`;
    }
  }

  // 3) ±=HEAD 差分
  let deltaPart = "";
  if (c.showDeltaFromHEAD && _deltaFromHEAD.value != null) {
    const d = _deltaFromHEAD.value;
    const sign = d > 0 ? "＋" : d < 0 ? "－" : "±";
    deltaPart = ` ${sign}${fmt(Math.abs(d))}`;
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
    tips.push(
      c.showFolderSum
        ? "字=選択文字数（改行除外）※未選択時は全体文字数／同フォルダ同拡張子 合算（編集中ファイルを含む）"
        : "字=選択文字数（改行除外）※未選択時は全体文字数"
    );
  if (c.showDeltaFromHEAD) tips.push("±=HEAD(直近コミット)からの増減");
  _statusBarItem.tooltip = tips.join("｜");

  // 7) クリック時コマンド
  if (headPart) {
    _statusBarItem.command = "posNote.setNoteSize";
  } else {
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
    recomputeFolderSum(editor); // アイドル再計算で合算も更新
    updateStatusBar(editor);
  }, c.recomputeIdleMs);
}

// ------- events hooks -------
function recomputeOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  updateStatusBar(ed);
}
function onActiveEditorChanged(ed) {
  if (!ed) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  scheduleUpdate(ed);
}
function onSelectionChanged(editor) {
  // 選択だけでは合算は再計算しない（重いI/Oを避ける）
  recomputeAndCacheMetrics(editor);
  updateStatusBar(editor);
}
function onConfigChanged(editor) {
  recomputeAndCacheMetrics(editor);
  recomputeFolderSum(editor); // （設定変更に追随）
  scheduleUpdate(editor);
}

// ------- commands -------
async function cmdRefreshPos() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
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
    recomputeFolderSum(ed);
    updateStatusBar(ed);
  }
  vscode.window.showInformationMessage(
    `行×列を ${rows}×${cols} に変更しました`
  );
}

module.exports = { initStatusBar, getBannedStart };
