// status_bar.js
// ステータスバー：ページ/行（原稿用紙風）、文字数（選択→なければ全体）表示、Git(HEAD)との差分（編集中ファイル単体）
// ＋ 同フォルダ・同拡張子「他ファイル」合算文字数（トグル可）

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const {
  getHeadingLevel,
  stripClosedCodeFences,
  stripHeadingLines,
  countCharsForDisplay,
} = require("./utils");
const { getHeadingCharMetricsCached } = require("./headline_symbols");

// ------- 内部 state -------
let _statusBarItem = null;
let _debouncer = null;
let _idleRecomputeTimer = null;
let _enabledNote = true; // ページ情報表示のON/OFF（トグル用）
let _metrics = null; // computeNoteMetrics の結果（キャッシュ）
let _deltaFromHEAD = { key: null, value: null }; // ファイル単体の±
let _helpers = null; // { cfg, isTargetDoc }
let _folderSumChars = null; // 同フォルダ・同拡張子（他ファイル）合算文字数
let _precountTotalForThisTick = null; // 一時的に受け取る表示用総文字数

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

// 設定から禁則文字リストを取得し、未設定なら既定値を返す
function getBannedStart() {
  const config = vscode.workspace.getConfiguration("posNote");
  const userValue = config.get("kinsoku.bannedStart");
  return Array.isArray(userValue) && userValue.length > 0
    ? userValue
    : DEFAULT_BANNED_START;
}

function scheduleUpdateWithPrecount(editor, shownLen) {
  _precountTotalForThisTick = shownLen;
  scheduleUpdate(editor);
}

// ------- 公開APIの初期化 -------
// ステータスバー表示の初期化と公開APIの作成
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
// 改行を除いた文字数を Array.from ベースで数える
function countCharsNoLF(text) {
  return Array.from((text || "").replace(/\r\n/g, "\n")).filter(
    (ch) => ch !== "\n"
  ).length;
}

// 3桁区切りフォーマッタ（日本語ロケール）
// 3桁区切りで整形するフォーマッタ（日本語ロケール）
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}

// 選択範囲それぞれの文字数を合算し、表示ルールに沿ってカウントする
function countSelectedCharsForDisplay(doc, selections, c) {
  let sum = 0;
  for (const sel of selections) {
    if (!sel.isEmpty) sum += countCharsForDisplay(doc.getText(sel), c);
  }
  return sum;
}

// ドキュメント先頭から選択位置までのテキストを取得する
function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

// 禁則折返し
// 原稿用紙風の折り返し行数を禁則処理込みで算出する
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
// 総文字数やページ番号など原稿用紙メトリクスをまとめて計算する
function computeNoteMetrics(doc, c, selection) {
  // 全文（CRLF→LF 正規化）
  const fullText = doc.getText().replace(/\r\n/g, "\n");

  // 共有ロジックに一本化（キャッシュ付き）
  const { items, total } = getHeadingCharMetricsCached(doc, c);
  const totalChars =
    items.length > 0 ? total : countCharsForDisplay(fullText, c);

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
// 現在ファイルから親ディレクトリを辿り、最初に見つかった .git を返す
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
// HEAD 時点のファイル内容を git show で取得する
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
// HEAD と現在編集中ファイルの文字数差分を得るため HEAD 側文字数を計算
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
// 現在編集中ファイルの文字数を取得
function _computeFileCharsCurrent(editor) {
  const doc = editor?.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) return { key: null, value: null };
  return { key: fsPath, value: countCharsNoLF(doc.getText()) };
}
// HEAD と現在の文字数差を再計算して内部キャッシュに保持する
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
// 同フォルダ・同拡張子のファイルを巡回して総文字数を合算する
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

// 表示対象かつ設定ONの場合にフォルダ合算文字数を更新する
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
// ステータスバー表示に必要なメトリクスを再計算しキャッシュする
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

// 現在のメトリクスに基づいてステータスバー文字列を更新・表示する
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
      _precountTotalForThisTick ??
      _metrics?.totalChars ??
      countCharsForDisplay(editor.document.getText(), c);
    _precountTotalForThisTick = null; // 使い捨て
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

// 入力の度に連続して再計算しすぎないよう、更新処理をディレイさせる
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
// 保存時に最新情報へ更新する（対象ファイルのみ）
function recomputeOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  updateStatusBar(ed);
}
// アクティブエディタが切り替わったときに差分や合算をリフレッシュ
function onActiveEditorChanged(ed) {
  if (!ed) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  scheduleUpdate(ed);
}
// 選択変更に応じて文字数・ページ情報を更新
function onSelectionChanged(editor) {
  // 選択だけでは合算は再計算しない（重いI/Oを避ける）
  recomputeAndCacheMetrics(editor);
  updateStatusBar(editor);
}
// 設定変更を反映し、必要な再計算を行う
function onConfigChanged(editor) {
  recomputeAndCacheMetrics(editor);
  recomputeFolderSum(editor); // （設定変更に追随）
  scheduleUpdate(editor);
}

// ------- commands -------
// コマンド: ステータスバーの内容を即時再計算する
async function cmdRefreshPos() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  updateStatusBar(ed);
}
// コマンド: 原稿用紙表示のON/OFFを切り替える
async function cmdToggleNote() {
  _enabledNote = !_enabledNote;
  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `ページカウンタ: ${_enabledNote ? "有効化" : "無効化"}`
  );
}
// コマンド: 原稿用紙の行数・列数をインタラクティブに変更する
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

module.exports = { initStatusBar, getBannedStart, scheduleUpdateWithPrecount };
