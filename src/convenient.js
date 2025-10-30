// convenient.js
// ======================================================
// 便利系自動整形：行末の全角・半角スペース削除
// ======================================================
const vscode = require("vscode");
const path = require("path");
let _limitItem = null; // limit 残日表示用

// YYYY-M-D / YYYY-MM-DD を厳密に解釈（0時始まり）
function parseDateYYYYMD(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = +m[1],
    mo = +m[2],
    d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0)); // UTC基準で日付丸め
  return isNaN(dt.getTime()) ? null : dt;
}

// 残日数を計算（今日→期限日までの切上げ日数。過去は 0）
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

// ISO 表記 YYYY-MM-DD に整形
function formatDateYYYYMMDD(dtUtc) {
  const y = dtUtc.getUTCFullYear();
  const m = String(dtUtc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtUtc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// アクティブ文書と同一フォルダの notesetting.json から limit を読む
async function readLimitFromNoteSettingFor(doc) {
  try {
    if (!doc || !doc.uri || !doc.uri.fsPath)
      return { days: null, where: null, iso: null, raw: null };
    const dir = path.dirname(doc.uri.fsPath);
    const noteUri = vscode.Uri.file(path.join(dir, "notesetting.json"));

    try {
      await vscode.workspace.fs.stat(noteUri);
    } catch {
      return { days: null, where: null, iso: null, raw: null };
    }

    const bin = await vscode.workspace.fs.readFile(noteUri);
    const text = Buffer.from(bin).toString("utf8");
    const json = JSON.parse(text);

    if (!Object.prototype.hasOwnProperty.call(json, "limit")) {
      return { days: null, where: noteUri.fsPath, iso: null, raw: null };
    }
    if (json.limit === null) {
      return { days: null, where: noteUri.fsPath, iso: null, raw: null };
    }

    const dt = parseDateYYYYMD(json.limit);
    if (!dt)
      return { days: null, where: noteUri.fsPath, iso: null, raw: json.limit };

    const days = calcRemainingDays(dt);
    const iso = formatDateYYYYMMDD(dt);
    return { days, where: noteUri.fsPath, iso, raw: json.limit };
  } catch {
    return { days: null, where: null, iso: null, raw: null };
  }
}

// 対象ドキュメントか（この拡張の軽量判定と同様）
function isLimitTargetDoc(doc) {
  if (!doc) return false;
  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isPlain = lang === "plaintext" || fsPath.endsWith(".txt");
  const isMd = lang === "markdown" || fsPath.endsWith(".md");
  const isNovel = lang === "novel";
  return isPlain || isMd || isNovel;
}

// ステータスバー更新
async function updateLimitStatusFor(doc) {
  if (!_limitItem) return;
  if (!isLimitTargetDoc(doc)) {
    _limitItem.hide();
    return;
  }
  const { days, iso } = await readLimitFromNoteSettingFor(doc);
  if (days == null) {
    _limitItem.hide();
    return;
  }
  _limitItem.text = `$(calendar) 残り${days}日`;
  _limitItem.tooltip = iso ? `期限 ${iso}` : "notesetting.json の limit 期限";
  _limitItem.show();
}

/**
 * 行末の全角・半角スペースを削除する
 * @param {vscode.TextDocument} doc
 * @returns {Promise<void>}
 */
async function trimTrailingSpaces(doc) {
  if (!doc || doc.isUntitled || doc.isDirty) return;

  const lang = (doc.languageId || "").toLowerCase();
  const fsPath = (doc.uri?.fsPath || "").toLowerCase();
  const isTarget =
    lang === "plaintext" ||
    lang === "markdown" ||
    lang === "novel" ||
    fsPath.endsWith(".txt") ||
    fsPath.endsWith(".md");

  if (!isTarget) return;

  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const text = doc.getText();

  // 正規表現で行末スペースを削除
  const newText = text.replace(/[ \u3000]+$/gm, "");

  // 差分がなければ何もしない
  if (text === newText) return;

  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(text.length)
  );

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, newText);
  });

  // 自動保存抑止 → ここで再保存
  await doc.save();
}

/**
 * 拡張機能の初期化
 * @param {vscode.ExtensionContext} context
 */
function registerConvenientFeatures(context) {
  // limit 用ステータスバー
  _limitItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10
  );
  context.subscriptions.push(_limitItem);

  // 保存時に行末スペースを削除（既存）
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      try {
        await trimTrailingSpaces(doc);
      } catch (err) {
        console.error("[POSNote:convenient] trim error:", err);
      }
      try {
        // 保存時に limit も更新（notesetting.json/本文どちらの保存でも反映）
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document) await updateLimitStatusFor(ed.document);
      } catch {}
    })
  );

  // アクティブ切替で更新
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (ed) => {
      if (ed && ed.document) await updateLimitStatusFor(ed.document);
    })
  );

  // notesetting.json の変更監視で更新
  const wNote = vscode.workspace.createFileSystemWatcher("**/notesetting.json");
  context.subscriptions.push(wNote);
  const refreshActive = async () => {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document) await updateLimitStatusFor(ed.document);
  };
  wNote.onDidCreate(refreshActive);
  wNote.onDidChange(refreshActive);
  wNote.onDidDelete(refreshActive);

  // ★ 初回表示
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document) {
    updateLimitStatusFor(ed.document);
  }
}

module.exports = { registerConvenientFeatures };
