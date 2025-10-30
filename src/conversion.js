// src/conversion.js
// かな↔漢字 双方向変換
// Ctrl+. → かな→漢字 / Alt+. → 漢字→かな
// <workspace>/.vscode/conversion.json を自動読み込み
// { "かな": "漢字", "かな": "漢字", ... } を双方向に展開
// 片方向だけ書けば OK 逆方向は自動生成

const vscode = require("vscode");
const path = require("path");

// ===== 既定ペア（ファイル無しや壊れている場合のフォールバック） =====
/** @type {Record<string, string>} */
const DEFAULT_TO_KANJI = {
  かすか: "微か",
  わずか: "僅か",
};
/** @type {Record<string, string>} */
const DEFAULT_TO_KANA = {
  微か: "かすか",
  僅か: "わずか",
};

// キャッシュ
/**
 * @typedef {Object} DictCache
 * @property {Record<string,string>} toKanji
 * @property {Record<string,string>} toKana
 * @property {boolean} loadedFromFile
 * @property {"default"|"old"|"flat"|"merged"} sourceSchema
 */
/** @type {DictCache} */
let _dictCache = {
  toKanji: { ...DEFAULT_TO_KANJI },
  toKana: { ...DEFAULT_TO_KANA },
  loadedFromFile: false,
  sourceSchema: "default", // "default" | "old" | "flat"
};

// ===== ユーティリティ =====
function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/*************  ✨ Windsurf Command ⭐  *************/
/**
 * Escapes special characters in a string for use in a RegExp.
 *
 * The following characters have special meanings in RegExp and must be escaped:
 * - `.` (dot)
 * - `*` (star)
 * - `+` (plus sign)
 * - `?` (question mark)
 * - `^` (caret)
 * - `$` (dollar sign)
 * - `{` (left curly brace)
 * - `}` (right curly brace)
 * - `(` (left parenthesis)
 * - `)` (right parenthesis)
 * - `|` (vertical bar or pipe)
 * - `[` (left square bracket)
 * - `]` (right square bracket)
 * - `\` (backslash)
 *
 * This function escapes all of these characters in a given string.
 *
 * @param {string} s - The string to escape.
 * @returns {string} The escaped string.
/*******  ed5aa8fb-a975-4621-99f2-6f4ee68a2fc4  *******/ function escapeRegExp(
  s
) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeString(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

// entries のうち key/value が文字列のものだけ抽出しトリム
/**
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
 * 新スキーマ（フラット）から双方向辞書を構築
 * 例: { "てのひら":"掌", "かすか":"微か" } -> toKanji はそのまま toKana は反転
 * 多対一（例: ほほえみ/微笑 → 微笑）の逆引き競合は**後勝ち**（最後に書かれたエントリが優先）
 * 競合を明示的に制御したい場合は旧スキーマ（toKana）を使えば上書き可能
 */
/**
 * @param {Record<string,string>} flat
 * @returns {{toKanji: Record<string,string>, toKana: Record<string,string>, sourceSchema: "flat"}}
 */
function buildFromFlat(flat) {
  const toKanji = sanitizeDict(flat);
  /** @type {Record<string,string>} */
  const toKana = {};
  for (const [kana, kanji] of Object.entries(toKanji)) {
    // 逆方向
    toKana[kanji] = kana;
  }
  return { toKanji, toKana, sourceSchema: "flat" };
}

/** 旧スキーマから構築し 既定を下支えにしてユーザ定義を優先 */
/**
 * @returns {{toKanji: Record<string,string>, toKana: Record<string,string>, sourceSchema: "old"}}
 */
function buildFromOld(json) {
  const userToKanji = sanitizeDict(json.toKanji || {});
  const userToKana = sanitizeDict(json.toKana || {});
  return {
    toKanji: { ...DEFAULT_TO_KANJI, ...userToKanji },
    toKana: { ...DEFAULT_TO_KANA, ...userToKana },
    sourceSchema: "old",
  };
}

// ===== ワークスペース辞書のロード＆監視 =====
function getDictUri() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return vscode.Uri.joinPath(folders[0].uri, ".vscode", "conversion.json");
}

// .vscode 常時 + notesetting があれば合流。ローカル conversion.json は読まない
async function loadDictFromWorkspace(activeDocUri) {
  const wsUri = getDictUri(); // <workspace>/.vscode/conversion.json
  /** @type {vscode.Uri|null} */ let localDirUri = null;
  if (activeDocUri)
    localDirUri = vscode.Uri.file(path.dirname(activeDocUri.fsPath));

  const dicts = [];

  // 1) .vscode は常に読む
  if (wsUri) {
    const wsDict = await tryReadDict(wsUri);
    if (wsDict) dicts.push(wsDict);
  }

  // 2) 同一フォルダ notesetting の conversion を合流
  if (localDirUri) {
    const setDict = await tryReadSettingConversion(localDirUri);
    if (setDict) dicts.push(setDict);
  }

  // 3) どれも無ければ既定
  if (dicts.length === 0) {
    _dictCache = {
      toKanji: { ...DEFAULT_TO_KANJI },
      toKana: { ...DEFAULT_TO_KANA },
      loadedFromFile: false,
      sourceSchema: "default",
    };
    return;
  }

  // 4) マージ（右側優先）→ notesetting が .vscode を上書き
  const merged = dicts.reduce(
    (acc, cur) => ({
      toKanji: { ...acc.toKanji, ...cur.toKanji },
      toKana: { ...acc.toKana, ...cur.toKana },
    }),
    { toKanji: {}, toKana: {} }
  );

  _dictCache = {
    toKanji: { ...DEFAULT_TO_KANJI, ...merged.toKanji },
    toKana: { ...DEFAULT_TO_KANA, ...merged.toKana },
    loadedFromFile: true,
    sourceSchema: "merged",
  };

  // 5) ステータス表示
  if (localDirUri) {
    try {
      const note = vscode.Uri.joinPath(localDirUri, "notesetting.json");
      await vscode.workspace.fs.stat(note);
      vscode.window.setStatusBarMessage(
        "POS/Note: .vscode + notesetting.conversion を統合",
        2500
      );
      return;
    } catch {}
  }
  vscode.window.setStatusBarMessage(
    "POS/Note: .vscode の conversion を適用",
    2000
  );
}

// 同一フォルダ notesetting.json の conversion を読む
/**
 * @param {vscode.Uri} dirUri // 対象ドキュメントのあるディレクトリ
 * @returns {Promise<{toKanji:Record<string,string>, toKana:Record<string,string>}|null>}
 */
async function tryReadSettingConversion(dirUri) {
  const noteUri = vscode.Uri.joinPath(dirUri, "notesetting.json");
  try {
    await vscode.workspace.fs.stat(noteUri);
  } catch {
    return null;
  }

  try {
    const bin = await vscode.workspace.fs.readFile(noteUri);
    const text = Buffer.from(bin).toString("utf8");
    const json = JSON.parse(text);
    const conv = json && json.conversion;
    if (!conv || typeof conv !== "object") return null;

    // 旧スキーマ {toKanji:{}, toKana:{}} もフラット { "かな": "漢字" } も両対応
    if (isPlainObject(conv.toKanji) || isPlainObject(conv.toKana)) {
      const built = buildFromOld(conv);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }
    if (isPlainObject(conv)) {
      const built = buildFromFlat(conv);
      return { toKanji: built.toKanji, toKana: built.toKana };
    }
    return null;
  } catch (e) {
    console.warn(
      `[posNote] notesetting.json 読み込み失敗 (${noteUri.fsPath}):`,
      e.message
    );
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
    // ファイルが存在しない、またはJSON構文エラーなど
    console.warn(
      `[posNote] conversion.json 読み込み失敗 (${uri.fsPath}):`,
      e.message
    );
    return null;
  }
}

// 監視対象を .vscode/conversion.json と notesetting.json
function ensureWatcher(context) {
  // .vscode だけを確実に見る
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

  // キーを長い順に並べて「より長い語を先に」マッチさせると意図せぬ再置換を減らせる
  // 例: 「わずか」と「わず」などが混在する場合の安定化
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
  const mapping = _dictCache.toKanji || DEFAULT_TO_KANJI;
  const n = await replaceWholeDocument(editor, mapping);
  showResult(n, _dictCache.loadedFromFile ? "かな→漢字（辞書）" : "かな→漢字");
}

async function convertToKana(editor) {
  const mapping = _dictCache.toKana || DEFAULT_TO_KANA;
  const n = await replaceWholeDocument(editor, mapping);
  showResult(n, _dictCache.loadedFromFile ? "漢字→かな（辞書）" : "漢字→かな");
}

function showResult(n, label) {
  if (n > 0) {
    vscode.window.setStatusBarMessage(
      `POS/Note: ${label} を ${n} 件置換`,
      2500
    );
  } else {
    vscode.window.setStatusBarMessage(`POS/Note: ${label} 対象なし`, 2000);
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
              "POS/Note: この言語では変換を無効化",
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
    )
  );
}

module.exports = { registerConversionCommands };
