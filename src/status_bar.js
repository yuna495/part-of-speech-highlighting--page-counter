// ステータスバー：ページ/行（原稿用紙風。文字数＝選択がなければ全体）表示、Git(HEAD)との差分（編集中ファイル単体）
// ＋ 同フォルダ・同拡張子「他ファイル」合算文字数（トグル可）

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const { TextDecoder } = require("util");

const {
  getHeadingLevel,
  stripClosedCodeFences,
  stripHeadingLines,
  countCharsForDisplay,
  loadNoteSettingForDoc,
  getHeadingMetricsCached,
} = require("./utils");

// ------- 内部 state -------
let _statusBarItem = null;
let _limitItem = null; // 期限表示用
let _debouncer = null;
let _idleRecomputeTimer = null;
let _enabledNote = true; // ページ表示のON/OFF（トグル用）
let _metrics = null; // computeNoteMetrics の結果（キャッシュ）
let _deltaFromHEAD = { key: null, value: null }; // ファイル単体の差分
let _helpers = null; // { cfg, isTargetDoc }
// 同フォルダ・同拡張子（他ファイル）合算文字数
let _folderSumChars = null;
let _precountTotalForThisTick = null;
let _docMetricsCache = new Map(); // uri -> { version, data: { ... } }

// デフォルトの禁則先頭文字（行頭禁止）
const DEFAULT_BANNED_START = [
  "、",
  "。", // 句点・読点
  "，",
  "．",
  "？",
  "！",
  "」",
  "』",
  "】",
  "〉",
  "》",
  "’",
  "”",
  "…",
  "‥",
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

/**
 * 設定の禁則先頭リストを取得する（未設定時は既定値）。
 * @returns {string[]} 行頭禁止文字の配列
 */
function getBannedStart() {
  const config = vscode.workspace.getConfiguration("posNote");
  const userValue = config.get("kinsoku.bannedStart");
  return Array.isArray(userValue) && userValue.length > 0
    ? userValue
    : DEFAULT_BANNED_START;
}

/**
 * 事前に計算した表示用文字数を保持しつつ更新をスケジュールする。
 * @param {vscode.TextEditor} editor 対象エディタ
 * @param {number} shownLen 表示に使う総文字数
 */
function scheduleUpdateWithPrecount(editor, shownLen) {
  _precountTotalForThisTick = shownLen;
  scheduleUpdate(editor);
}

// ------- 公開APIの初期化 -------
/**
 * ステータスバー項目を初期化し、外部に渡す操作用 API を返す。
 * @param {vscode.ExtensionContext} context 拡張コンテキスト
 * @param {{ cfg: Function, isTargetDoc: Function }} helpers 設定取得と対象判定のヘルパー
 * @returns {object} ステータスバー制御用の公開関数群
 */
function initStatusBar(context, helpers) {
  _helpers = helpers;

  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    2
  );
  context.subscriptions.push(_statusBarItem);
  _limitItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  context.subscriptions.push(_limitItem);

  // 初回：アクティブエディタの有無で初期化
  const refreshLimit = async (doc) => {
    try {
      await updateLimitStatusFor(doc);
    } catch (e) {
      console.error("[POSNote:status] limit update error:", e);
    }
  };

  if (vscode.window.activeTextEditor) {
    _recomputeFileDelta(vscode.window.activeTextEditor);
    recomputeAndCacheMetrics(vscode.window.activeTextEditor);
    recomputeFolderSum(vscode.window.activeTextEditor);
    updateStatusBar(vscode.window.activeTextEditor);
    refreshLimit(vscode.window.activeTextEditor.document);
  }

  // limit 用ウォッチャー（notesetting.json 監視＋保存＋アクティブ切替）
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => refreshLimit(doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document) refreshLimit(ed.document);
      else if (_limitItem) _limitItem.hide();
    })
  );
  const wNote = vscode.workspace.createFileSystemWatcher("**/notesetting.json");
  context.subscriptions.push(wNote);
  const refreshActiveLimit = () => {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document) refreshLimit(ed.document);
    else if (_limitItem) _limitItem.hide();
  };
  wNote.onDidCreate(refreshActiveLimit);
  wNote.onDidChange(refreshActiveLimit);
  wNote.onDidDelete(refreshActiveLimit);

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
// 3桁区切りフォーマッタ（日本語ロケール）
function fmt(n) {
  return (typeof n === "number" ? n : Number(n)).toLocaleString("ja-JP");
}

/**
 * YYYY-M-D / YYYY/MM/DD / YYYY-MM-DD を UTC 0:00 の Date に変換する。
 * @param {string} s 日付文字列
 * @returns {Date|null} パースできなければ null
 */
function parseDateYYYYMD(s) {
  if (typeof s !== "string") return null;
  // 区切りは - または / を許容し、混在は不可
  const m = s.trim().match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
  if (!m) return null;
  const y = +m[1],
    mo = +m[3],
    d = +m[4];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0)); // UTC基準で日付丸め
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * 今日からの残日数を切り上げで計算する。
 * @param {Date} targetUtcDate UTC 基準の期限日
 * @returns {number} 残日数（過去は 0）
 */
function calcRemainingDays(targetUtcDate) {
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0
  );
  const diffMs = targetUtcDate.getTime() - todayUtc;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / 86400000);
}

/**
 * Date(UTC) を YYYY-MM-DD 形式の文字列に整形する。
 * @param {Date} dtUtc UTC 基準の日付
 * @returns {string} YYYY-MM-DD 文字列
 */
function formatDateYYYYMMDD(dtUtc) {
  const y = dtUtc.getUTCFullYear();
  const m = String(dtUtc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtUtc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * アクティブ文書と同一フォルダの notesetting.json から limit を読み取る。
 * @param {vscode.TextDocument} doc 対象ドキュメント
 * @returns {Promise<{days: number|null, where: string|null, iso: string|null, raw: any}>}
 */
async function readLimitFromNoteSettingFor(doc) {
  try {
    const { data, path: where } = await loadNoteSettingForDoc(doc);
    if (!data) return { days: null, where: null, iso: null, raw: null };

    if (!Object.prototype.hasOwnProperty.call(data, "limit")) {
      return { days: null, where, iso: null, raw: null };
    }
    if (data.limit === null) {
      return { days: null, where, iso: null, raw: null };
    }

    const dt = parseDateYYYYMD(data.limit);
    if (!dt) return { days: null, where, iso: null, raw: data.limit };

    const days = calcRemainingDays(dt);
    const iso = formatDateYYYYMMDD(dt);
    return { days, where, iso, raw: data.limit };
  } catch {
    return { days: null, where: null, iso: null, raw: null };
  }
}

/**
 * limit 設定に基づいて期限表示のステータスバーを更新する。
 * @param {vscode.TextDocument} doc 対象ドキュメント
 * @returns {Promise<void>}
 */
async function updateLimitStatusFor(doc) {
  if (!_limitItem || !_helpers) return;
  const { cfg, isTargetDoc } = _helpers;
  if (!doc || !cfg || !isTargetDoc || !isTargetDoc(doc, cfg())) {
    _limitItem.hide();
    return;
  }
  const { days, iso } = await readLimitFromNoteSettingFor(doc);
  if (days == null) {
    _limitItem.hide();
    return;
  }
  _limitItem.text = `$(calendar) 残${days}日`;
  _limitItem.tooltip = iso ? `期限 ${iso}` : "notesetting.json の limit 期限";
  _limitItem.show();
}

/**
 * 選択範囲ごとの文字数を合算する（表示ルール準拠）。
 * @param {vscode.TextDocument} doc 対象ドキュメント
 * @param {ReadonlyArray<vscode.Selection>} selections 選択範囲
 * @param {object} c 現在の設定
 * @returns {number} 合計文字数
 */
function countSelectedCharsForDisplay(doc, selections, c) {
  let sum = 0;
  for (const sel of selections) {
    if (!sel.isEmpty) sum += countCharsForDisplay(doc.getText(sel), c);
  }
  return sum;
}

/**
 * ドキュメント先頭から現在のカーソル位置までのテキストを取得する。
 * @param {vscode.TextDocument} doc 対象ドキュメント
 * @param {vscode.Selection} selection カーソル・選択位置
 * @returns {string} 先頭からのテキスト
 */
function editorPrefixText(doc, selection) {
  if (!selection) return "";
  const start = new vscode.Position(0, 0);
  const range = new vscode.Range(start, selection.active);
  return doc.getText(range);
}

/**
 * 禁則処理を考慮して原稿用紙の折返し行数を計算する。
 * @param {string} text 対象テキスト
 * @param {number} cols 1行の桁数
 * @param {boolean} kinsokuEnabled 禁則を適用するか
 * @param {string[]} bannedChars 禁則対象の文字
 * @returns {number} 折り返し後の行数
 */
function wrappedRowsForText(text, cols, kinsokuEnabled, bannedChars) {
  // 改行正規化
  let t = (text || "").replace(/\r\n/g, "\n");

  // コードフェンス除外（ペア成立のみ）
  t = stripClosedCodeFences(t);

  // 《...》括弧内を除去
  // 正規表現を定数化しておいたほうが早そうだが、頻度次第。念のため定数利用も検討
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

/**
 * 文書全体のメトリクスを計算（キャッシュ対応）。
 */
function getDocMetricsCached(doc, c) {
  const uri = doc.uri.toString();
  const ver = doc.version;
  const cached = _docMetricsCache.get(uri);

  if (cached && cached.version === ver && cached.cfgHash === JSON.stringify(c)) {
    return cached.data;
  }

  // 全文（CRLF→LF 正規化）
  const fullText = doc.getText().replace(/\r\n/g, "\n");

  // 見出しロジックに一本化（キャッシュ付き）
  const { items, total } = getHeadingMetricsCached(doc, c, vscode);
  const totalChars =
    items.length > 0 ? total : countCharsForDisplay(fullText, c);

  // ページ/行：従来どおり「全文」で計算（見出しを含む）
  const totalWrappedRows = wrappedRowsForText(
    fullText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const totalNotes = Math.max(1, Math.ceil(totalWrappedRows / c.rowsPerNote));

  const rem = totalWrappedRows % c.rowsPerNote;
  const lastLineInLastNote = rem === 0 ? c.rowsPerNote : rem;

  const data = {
    totalChars,
    totalWrappedRows,
    totalNotes,
    lastLineInLastNote
  };

  _docMetricsCache.set(uri, { version: ver, cfgHash: JSON.stringify(c), data });
  return data;
}

/**
 * 原稿用紙表示に必要なメトリクスをまとめて算出する。
 * @param {vscode.TextDocument} doc 対象ドキュメント
 * @param {object} c 設定
 * @param {vscode.Selection} selection 現在の選択
 * @returns {{totalChars:number,totalWrappedRows:number,totalNotes:number,currentNote:number,lastLineInLastNote:number}}
 */
function computeNoteMetrics(doc, c, selection) {
  // 1) 全体メトリクス取得（キャッシュ済みなら高速）
  const base = getDocMetricsCached(doc, c);

  // 2) 現在ページ：選択位置までのテキストで計算
  // ここは常にカーソル位置に依存するためキャッシュしにくい（prefixが変わるため）
  const prefixText = editorPrefixText(doc, selection);
  // prefixTextが非常に大きい場合ここがボトルネックになるが、
  // 全体計算(wrapperRowsForText(fullText))をスキップできるだけで半分以下のコストになる。
  const currRows = wrappedRowsForText(
    prefixText,
    c.colsPerRow,
    c.kinsokuEnabled,
    c.kinsokuBanned
  );
  const currentNote = Math.max(
    1,
    Math.min(base.totalNotes, Math.ceil(currRows / c.rowsPerNote))
  );

  return {
    ...base,
    currentNote,
  };
}

/**
 * 現在ファイルから親ディレクトリを遡って最初の .git を探す。
 * @param {string} startDir 探索開始ディレクトリ
 * @returns {string|null} 見つかった git ルート
 */
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
/**
 * HEAD 時点のファイル内容を git show で取得する。
 * @param {string} gitRoot リポジトリルート
 * @param {string} relPath リポジトリ相対パス
 * @returns {string|null} HEAD の内容
 */
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
/**
 * HEAD 時点の編集中ファイル文字数を算出する。
 * @param {vscode.TextEditor} editor 対象エディタ
 * @param {object} c 現在設定
 * @returns {{ key: string|null, value: number|null }}
 */
function _computeFileCharsAtHEAD(editor, c) {
  const doc = editor?.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) return { key: null, value: null };

  const gitRoot = findGitRoot(path.dirname(fsPath));
  if (!gitRoot) return { key: fsPath, value: null };

  const rel = path.relative(gitRoot, fsPath).replace(/\\/g, "/");
  const content = readFileAtHEAD(gitRoot, rel);
  if (content == null) return { key: fsPath, value: null };

  return { key: fsPath, value: countCharsForDisplay(content, c) };
}
/**
 * 現在編集中ファイルの文字数を算出する。
 * @param {vscode.TextEditor} editor 対象エディタ
 * @param {object} c 現在設定
 * @returns {{ key: string|null, value: number|null }}
 */
function _computeFileCharsCurrent(editor, c) {
  const doc = editor?.document;
  const fsPath = doc?.uri?.fsPath || "";
  if (!fsPath) return { key: null, value: null };
  return { key: fsPath, value: countCharsForDisplay(doc.getText(), c) };
}
/**
 * HEAD と現在の文字数差を再計算し内部キャッシュに保持する。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
function _recomputeFileDelta(editor) {
  const { cfg } = _helpers;
  const c = cfg();
  const head = _computeFileCharsAtHEAD(editor, c);
  const curr = _computeFileCharsCurrent(editor, c);
  if (head.key) {
    _deltaFromHEAD.key = head.key;
    _deltaFromHEAD.value =
      head.value != null && curr.value != null ? curr.value - head.value : null;
  } else {
    _deltaFromHEAD = { key: null, value: null };
  }
}

// ------- ★追加：同フォルダ・同拡張子（他ファイル）合算 -------
/**
 * 同フォルダ・同拡張子の総文字数を非同期で合算する（編集中・未保存分も含む）。
 * @param {vscode.TextEditor} editor 対象エディタ
 * @param {object} c 現在設定
 * @returns {Promise<number|null>} 文字数合計
 */
async function computeFolderSumChars(editor, c) {
  try {
    const doc = editor?.document;
    const uri = doc?.uri;
    if (!uri || uri.scheme !== "file") return null;

    const currentPath = uri.fsPath;
    const dirUri = uri.with({ path: path.dirname(uri.path) });
    const ext = path.extname(currentPath).toLowerCase();
    if (!ext) return null;

    // 1) まず編集中のドキュメントをカウント（未保存の内容も反映）
    let sum = countCharsForDisplay(doc.getText(), c);

    // 2) 同フォルダにある同拡張子の"他ファイル"を加算
    // 非同期で取得
    const entries = await vscode.workspace.fs.readDirectory(dirUri);

    // 読み込みプロミスを生成
    const promises = entries.map(async ([name, type]) => {
      if (type !== vscode.FileType.File) return 0;
      if (path.extname(name).toLowerCase() !== ext) return 0;

      const fileUri = vscode.Uri.joinPath(dirUri, name);
      // 自分自身はスキップ（fsPathで比較）
      if (fileUri.fsPath === currentPath) return 0;

      try {
        const bin = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder("utf-8").decode(bin);
        return countCharsForDisplay(content, c);
      } catch {
        return 0;
      }
    });

    const counts = await Promise.all(promises);
    for (const n of counts) sum += n;

    return sum;
  } catch {
    return null;
  }
}

/**
 * 表示対象かつ設定が有効な場合にフォルダ合算文字数を再計算してキャッシュする。
 * @param {vscode.TextEditor} editor 対象エディタ
 * @returns {Promise<void>}
 */
async function recomputeFolderSum(editor) {
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

  // 非同期計算
  const sum = await computeFolderSumChars(editor, c);

  // 計算完了時点でエディタが変わっていなければ適用
  const currentEd = vscode.window.activeTextEditor;
  if (currentEd && currentEd.document.uri.toString() === editor.document.uri.toString()) {
    _folderSumChars = sum;
    updateStatusBar(currentEd);
  }
}

// ------- メイン処理（公開APIで呼ばれる） -------
/**
 * ステータスバー表示に必要なメトリクスを再計算しキャッシュする。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
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

/**
 * 現在のメトリクスに基づいてステータスバー文字列を更新・表示する。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
function updateStatusBar(editor) {
  const { cfg, isTargetDoc } = _helpers;
  const c = cfg();
  if (!_statusBarItem) return;

  // エディタが無いときは隠す
  if (!editor) {
    _statusBarItem.hide();
    return;
  }

  // 「小説対象の文字列か」を先に判定
  const targetDoc = isTargetDoc(editor.document, c);

  // 1) ページ表示は「対象文字列かつ有効時のみ」
  let headPart = "";
  if (targetDoc && c.enabledNote && _enabledNote) {
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

  // 2) 選択文字数（非選択時は全体）…拡張子を問わず常に可
  let selPart = "";
  if (c.showSelectedChars) {
    const selections = editor.selections?.length
      ? editor.selections
      : [editor.selection];

    // 「表示ルールでの字数」…対象外でも countCharsForDisplay を使う
    const selCnt = countSelectedCharsForDisplay(editor.document, selections, c);

    // 対象外では _metrics が null になり得るので安全にフォールバック
    const baseTotal =
      _precountTotalForThisTick ??
      _metrics?.totalChars ??
      countCharsForDisplay(editor.document.getText(), c);
    _precountTotalForThisTick = null;

    const shown = selCnt > 0 ? selCnt : baseTotal;

    // 同フォルダ合算は従来どおり「対象文字列時のみ」
    if (targetDoc && c.showFolderSum && _folderSumChars != null) {
      selPart = `${fmt(shown)}字 / ${fmt(_folderSumChars)}`;
    } else {
      selPart = `${fmt(shown)}字`;
    }
  }

  // 3) ±=HEAD 差分…拡張子を問わず常に可（取得できた場合のみ）
  let deltaPart = "";
  if (c.showDeltaFromHEAD && _deltaFromHEAD.value != null) {
    const d = _deltaFromHEAD.value;
    const sign = d > 0 ? "＋" : d < 0 ? "－" : "±";
    deltaPart = ` ${sign}${fmt(Math.abs(d))}`;
  }

  // 4) どれも空なら隠す（例: 全表示オフ）
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
  if (headPart)
    tips.push("選択位置/全体ページ＋末尾文字が最後のページの何行目か");
  if (c.showSelectedChars)
    tips.push(
      targetDoc && c.showFolderSum
        ? "選択文字数（改行除外）※未選択時は全体文字数＋同フォルダ同拡張子合算（編集中ファイルを含む）"
        : "選択文字数（改行除外）※未選択時は全体文字数"
    );
  if (c.showDeltaFromHEAD) tips.push("±=HEAD(直近コミット)からの増減");
  _statusBarItem.tooltip = tips.join(" / ");

  // 7) クリックコマンドはページ表示があるときのみ
  _statusBarItem.command = headPart ? "posNote.setNoteSize" : undefined;

  // 8) 表示
  _statusBarItem.show();
}

/**
 * 入力頻度に合わせて更新処理をデバウンスし、必要に応じて再計算をキューする。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
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
/**
 * 保存イベントで差分・メトリクス・合算を再計算する（アクティブ文書のみ）。
 * @param {vscode.TextDocument} savedDoc 保存されたドキュメント
 */
function recomputeOnSaveIfNeeded(savedDoc) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || savedDoc !== ed.document) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  updateStatusBar(ed);
}
/**
 * アクティブエディタ切替時に差分や合算を更新する。
 * @param {vscode.TextEditor} ed 新しいエディタ
 */
function onActiveEditorChanged(ed) {
  if (!ed) return;
  _recomputeFileDelta(ed);
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  scheduleUpdate(ed);
}
/**
 * 選択変更に応じて文字数とページ情報を更新する。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
function onSelectionChanged(editor) {
  // 選択だけでは合算を再計算しない（重いI/Oを避ける）
  // 以前はここで recomputeAndCacheMetrics(editor) を即時呼んでいたが、
  // 文字入力やカーソル移動のたびに走るのは重いので scheduleUpdate に任せる。
  // ただし、ページ番号即時更新のためには metrics 更新が必要。
  // 分割キャッシュ化により recomputeAndCacheMetrics は軽量化したので
  // ここは呼んでも良いが、連続移動を考慮して scheduleUpdate する。
  scheduleUpdate(editor);
}
/**
 * 設定変更を反映し、必要な再計算を行う。
 * @param {vscode.TextEditor} editor 対象エディタ
 */
function onConfigChanged(editor) {
  recomputeAndCacheMetrics(editor);
  recomputeFolderSum(editor); // 設定変更に追随
  scheduleUpdate(editor);
}

// ------- commands -------
/**
 * ステータスバーの内容を即時再計算するコマンド。
 * @returns {Promise<void>}
 */
async function cmdRefreshPos() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  recomputeAndCacheMetrics(ed);
  recomputeFolderSum(ed);
  updateStatusBar(ed);
}
/**
 * 原稿用紙表示の ON/OFF を切り替えるコマンド。
 * @returns {Promise<void>}
 */
async function cmdToggleNote() {
  _enabledNote = !_enabledNote;
  updateStatusBar(vscode.window.activeTextEditor);
  vscode.window.showInformationMessage(
    `ページカウンタ: ${_enabledNote ? "有効" : "無効"}`
  );
}
/**
 * 原稿用紙の行数・列数を対話的に変更するコマンド。
 * @returns {Promise<void>}
 */
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
  vscode.window.showInformationMessage(`行×桁を ${rows}×${cols} に変更しました`);
}

module.exports = { initStatusBar, getBannedStart, scheduleUpdateWithPrecount };
