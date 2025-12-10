// かな⇔漢字 双方向変換
// Ctrl+. で かな→漢字 / Alt+. で 漢字→かな
// <workspace>/.vscode/conversion.json と 対象ドキュメントと同階層の notesetting.json を自動読み込み
// { "かな": "漢字", ... } を双方向に展開（片方向だけ書けば逆方向を自動生成）
// ※ 既定ペア（フォールバック）は廃止

const vscode = require("vscode");
const path = require("path");
const { loadNoteSettingForDoc } = require("./utils");

// キャッシュ
/**
 * @typedef {Object} DictCache
 * @property {Record<string,string>} toKanji
 * @property {Record<string,string>} toKana
 * @property {boolean} loadedFromFile
 * @property {"empty"|"old"|"flat"|"merged"} sourceSchema
 */
/** @type {DictCache} */
let _dictCache = {
  toKanji: {},
  toKana: {},
  loadedFromFile: false,
  sourceSchema: "empty",
};

// ===== ユーティリティ =====
function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 正規表現で使う文字をエスケープする。
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeString(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

/**
 * entries のうち key/value が文字列のものだけ抽出しトリムする。
 * @param {any} obj
 * @returns {Record<string,string>}
 */
function sanitizeDict(obj) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const kk = normalizeString(k).trim();
    const vv = normalizeString(v).trim();
    if (kk && vv) out[kk] = vv;
  }
  return out;
}

/**
 * 新スキーマ（フラット）から双方向辞書を構築する。
 * 例: { "てのひら":"掌", "かすか":"微か" } -> toKanji はそのまま / toKana は反転
 * @param {Record<string,string>} flat
 * @returns {{toKanji: Record<string,string>, toKana: Record<string,string>, sourceSchema: "flat"}}
 */
function buildFromFlat(flat) {
  const toKanji = sanitizeDict(flat);
  /** @type {Record<string,string>} */
  const toKana = {};
  for (const [kana, kanji] of Object.entries(toKanji)) {
    toKana[kanji] = kana;
  }
  return { toKanji, toKana, sourceSchema: "flat" };
}

/**
 * 旧スキーマから構築する（ユーザー定義のみ。既定は混入しない）。
 * @returns {{toKanji: Record<string,string>, toKana: Record<string,string>, sourceSchema: "old"}}
 */
function buildFromOld(json) {
  const userToKanji = sanitizeDict(json.toKanji || {});
  const userToKana = sanitizeDict(json.toKana || {});
  return {
    toKanji: { ...userToKanji },
    toKana: { ...userToKana },
    sourceSchema: "old",
  };
}

// ===== ワークスペース辞書のロード＆監視 =====
function getDictUri() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return vscode.Uri.joinPath(folders[0].uri, ".vscode", "conversion.json");
}

// .vscode 常時 + notesetting があれば合流（notesetting が後勝ち）
async function loadDictFromWorkspace(activeDocUri) {
  const wsUri = getDictUri();
  const dicts = [];
  let noteApplied = false;

  if (wsUri) {
    const wsDict = await tryReadDict(wsUri);
    if (wsDict) dicts.push(wsDict);
  }

  if (activeDocUri) {
    const setDict = await tryReadSettingConversion({ uri: activeDocUri });
    if (setDict) {
      dicts.push(setDict);
      noteApplied = true;
    }
  }

  if (dicts.length === 0) {
    _dictCache = { toKanji: {}, toKana: {}, loadedFromFile: false, sourceSchema: "empty" };
    return;
  }

  const merged = dicts.reduce((acc, cur) => {
    const newToKanji = { ...acc.toKanji, ...cur.toKanji };
    const newToKana = { ...acc.toKana, ...cur.toKana };
    for (const [k, v] of Object.entries(cur.toKanji)) {
      if (newToKanji[v] === k) {
        delete newToKanji[v];
        delete newToKana[k];
      }
    }
    for (const [k, v] of Object.entries(cur.toKana)) {
      if (newToKana[v] === k) {
        delete newToKana[v];
        delete newToKanji[k];
      }
    }
    return { toKanji: newToKanji, toKana: newToKana };
  }, { toKanji: {}, toKana: {} });

  _dictCache = { toKanji: { ...merged.toKanji }, toKana: { ...merged.toKana }, loadedFromFile: true, sourceSchema: "merged" };

  if (noteApplied) {
    vscode.window.setStatusBarMessage("P/N: notesetting.json を適用", 2500);
  }
}

// 同一フォルダ notesetting.json の conversion を読む
/**
 * @param {{uri:{fsPath?:string}}} docLike // 対象ドキュメントのあるディレクトリを示すオブジェクト
 * @returns {Promise<{toKanji:Record<string,string>, toKana:Record<string,string>}|null>}
 */
async function tryReadSettingConversion(docLike) {
  try {
    const { data } = await loadNoteSettingForDoc(docLike);
    const conv = data && data.conversion;
    if (!conv || typeof conv !== "object") return null;

    if (isPlainObject(conv.toKanji) || isPlainObject(conv.toKana)) {
      const built = buildFromOld(conv);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }
    if (isPlainObject(conv)) {
      const built = buildFromFlat(conv);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 辞書ファイルを読み込んで双方向辞書を構築
 * @param {vscode.Uri} uri
 * @returns {Promise<{toKanji: Record<string,string>, toKana: Record<string,string>} | null>}
 */
async function tryReadDict(uri) {
  try {
    const bin = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bin).toString("utf8");
    const json = JSON.parse(text);

    // 旧スキーマ
    if (isPlainObject(json.toKanji) || isPlainObject(json.toKana)) {
      const built = buildFromOld(json);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }

    // 新スキーマ
    if (isPlainObject(json)) {
      const built = buildFromFlat(json);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }

    return null; // 不正フォーマット
  } catch (e) {
    console.warn(
      `[posNote] conversion.json 読み込み失敗 (${uri.fsPath}):`,
      e.message
    );
    return null;
  }
}

// 監視対象を .vscode/conversion.json と notesetting.json
function ensureWatcher(context) {
  const wConv = vscode.workspace.createFileSystemWatcher(
    "**/.vscode/conversion.json"
  );
  const wNote = vscode.workspace.createFileSystemWatcher("**/notesetting.json");
  context.subscriptions.push(wConv, wNote);

  const reload = async () => {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    await loadDictFromWorkspace(uri);
  };

  wConv.onDidCreate(reload);
  wConv.onDidChange(reload);
  wConv.onDidDelete(reload);

  wNote.onDidCreate(reload);
  wNote.onDidChange(reload);
  wNote.onDidDelete(reload);
}

// ===== 全文一括置換 =====
/**
 * @param {vscode.TextEditor} editor
 * @param {Record<string,string>} mapping
 * @returns {Promise<number>}
 */
async function replaceWholeDocument(editor, mapping) {
  const doc = editor.document;
  const fullText = doc.getText();

  const keys = Object.keys(mapping);
  if (keys.length === 0) return 0;

  // 長いキーを先にマッチさせて再置換を抑止
  keys.sort((a, b) => b.length - a.length);

  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");

  let count = 0;
  fullText.replace(pattern, (m) => {
    if (m in mapping) count++;
    return m;
  });
  if (count === 0) return 0;

  const newText = fullText.replace(pattern, (m) => mapping[m] ?? m);
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(fullText.length)
  );
  const ok = await editor.edit((edit) => edit.replace(fullRange, newText));
  return ok ? count : 0;
}

// ===== コマンド本体 =====
async function convertToKanji(editor) {
  const mapping = _dictCache.toKanji; // 空なら何もしない
  const n = await replaceWholeDocument(editor, mapping);
  showResult(n, _dictCache.loadedFromFile ? "かな→漢字（辞書）" : "かな→漢字");
}

async function convertToKana(editor) {
  const mapping = _dictCache.toKana; // 空なら何もしない
  const n = await replaceWholeDocument(editor, mapping);
  showResult(n, _dictCache.loadedFromFile ? "漢字→かな（辞書）" : "漢字→かな");
}

function showResult(n, label) {
  if (n > 0) {
    vscode.window.setStatusBarMessage(`P/N: ${label} を ${n} 件置換`, 2500);
  } else {
    vscode.window.setStatusBarMessage(`P/N: ${label} 対象なし`, 2000);
  }
}

// ===== エントリポイント =====
/**
 * @param {vscode.ExtensionContext} context
 * @param {{ isTargetDoc: (doc: import('vscode').TextDocument, cfg:any)=>boolean }} deps
 */
function registerConversionCommands(context, { isTargetDoc }) {
  const initUri = vscode.window.activeTextEditor?.document?.uri;
  loadDictFromWorkspace(initUri).then(() => ensureWatcher(context));
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) =>
      loadDictFromWorkspace(ed?.document?.uri)
    )
  );

  function guardAndRun(fn) {
    return async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const doc = ed.document;
      try {
        if (typeof isTargetDoc === "function") {
          if (!isTargetDoc(doc, { applyToTxtOnly: true })) {
            vscode.window.setStatusBarMessage(
              "P/N: この言語では変換を無効化",
              2000
            );
            return;
          }
        }
      } catch {}
      await fn(ed);
    };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "posNote.convert.toKanji",
      guardAndRun(convertToKanji)
    ),
    vscode.commands.registerCommand(
      "posNote.convert.toKana",
      guardAndRun(convertToKana)
    ),
    vscode.commands.registerCommand(
      "posNote.convert.formatspacelines",
      guardAndRun(formatSpaceLines)
    )
  );
}

// ===== 整形コマンド: 空白＋全角空白→改行 等 =====
async function formatSpaceLines(editor) {
  const doc = editor.document;
  const fullText = doc.getText();
  if (!fullText) return;

  // 1. " 　" (半角スペース+全角スペース) を "\n　" (改行+全角スペース) に置換
  // 2. " " (半角スペース) が括弧開きの直前にある場合、改行に置換
  //    ただし、Markdownのリスト記号(# - . *)やインデント(空白)の直後は除外する
  //    対象: ([^#\-\.\* ]) + " " + (?=「『...)
  const regex1 = / 　/g;
  const regex2 = /([^#\-\.\* ]) (?=[「『（［｛〈《【〔“‘])/g;

  let newText = fullText.replace(regex1, "\n　");
  newText = newText.replace(regex2, "$1\n");

  if (newText === fullText) {
    vscode.window.setStatusBarMessage("P/N: 整形対象が見つかりませんでした", 2000);
    return;
  }

  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(fullText.length)
  );
  const ok = await editor.edit((edit) => edit.replace(fullRange, newText));
  if (ok) {
    vscode.window.setStatusBarMessage("P/N: スペース整形を実行しました", 2000);
  }
}

module.exports = { registerConversionCommands };
