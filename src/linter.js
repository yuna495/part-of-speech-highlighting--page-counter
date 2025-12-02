// VSCode API
const vscode = require("vscode");

// textlint kernel & plugins
const { TextlintKernel } = require("@textlint/kernel");
const {
  findRepeatedPunctDiagnostics,
  findExclamQuestionSpaceDiagnostics,
  maskCodeBlocks,
  fenceStateBefore,
} = require("./linter_original_rules");

let pluginText = null;
try {
  // .txt を処理するために必要
  pluginText = require("@textlint/textlint-plugin-text");
} catch (e) {
  // 未導入でも起動は続行（ログのみ）
}

let pluginMarkdown = null;
try {
  // @ts-ignore
  pluginMarkdown = require("@textlint/textlint-plugin-markdown");
} catch (e) {
  // markdown plugin は任意
}

// ===== 0) グローバル状態 / ログ / 保存理由 =====
const channel = vscode.window.createOutputChannel("textlint-kernel-linter");

// ---- ログ抑止：Output へ一切書き込まない ----
try {
  const _origAppend = channel.appendLine.bind(channel);
  channel.appendLine = (_s) => {
    /* no-op */
  };
} catch {}

const lastSaveReason = new Map(); // 保存理由（Auto Save をスキップ判定に使う）
const docCache = new Map(); // uriString -> { textLines: string[], diagnostics: vscode.Diagnostic[] }
let lintStatusItem = null; // vscode.StatusBarItem
let lintRunning = 0; // ネスト対策用カウンタ

// ===== 1) ステータスバー UI ヘルパー =====
function ensureStatusBar(context) {
  if (lintStatusItem) return lintStatusItem;
  lintStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10000
  );
  lintStatusItem.name = "textlint-kernel-linter";
  lintStatusItem.tooltip =
    "クリックでこのファイルを lint（保存不要） / Linter result";
  lintStatusItem.command = "linter.lintActiveFile"; // クリックで lint 実行
  context.subscriptions.push(lintStatusItem);
  return lintStatusItem;
}

// アイドル時の表示を、対象ドキュメントの前回結果に合わせて更新
function updateIdleUIForDoc(doc) {
  if (!lintStatusItem) return;
  let count = 0;
  if (doc && doc.uri) {
    const cached = docCache.get(doc.uri.toString());
    if (cached && Array.isArray(cached.diagnostics)) {
      count = cached.diagnostics.length;
    }
  }
  lintStatusItem.text = `$(check) ${count} iss`;
  lintStatusItem.show();
}

// スピナー表示
function startLintUI(text = "Linting...") {
  lintRunning++;
  if (lintStatusItem) {
    lintStatusItem.text = `$(sync~spin) ${text}`;
    lintStatusItem.show();
  }
}

// 完了表示（N iss / 0 iss / Error）
function finishLintUI(resultText = "0 iss") {
  lintRunning = Math.max(0, lintRunning - 1);
  if (!lintStatusItem) return;
  if (lintRunning === 0) {
    lintStatusItem.text = `$(check) ${resultText}`;
    lintStatusItem.show();
  }
}

// 対象外・早期 return 時でも前回件数で UI を確実に復帰
function finishWithCachedCount(doc) {
  try {
    const key = doc?.uri?.toString();
    let count = 0;
    if (key && docCache.has(key)) {
      const cached = docCache.get(key);
      if (cached && Array.isArray(cached.diagnostics))
        count = cached.diagnostics.length;
    }
    finishLintUI(`${count} iss`);
  } catch {
    finishLintUI("0 iss");
  }
}

// ===== 2) 実行条件／トリガー共通化 =====
function shouldLintOnSave(docUriString, reason) {
  const cfg = vscode.workspace.getConfiguration("posNote.linter");
  const lintOnAutoSave = cfg.get("lintOnAutoSave", false); // 既定: false

  // Auto Save を無効にしている場合は、手動保存のみ
  if (
    !lintOnAutoSave &&
    (reason === vscode.TextDocumentSaveReason.AfterDelay ||
      reason === vscode.TextDocumentSaveReason.FocusOut)
  ) {
    return false;
  }

  // アクティブなエディタのドキュメントのみ対象
  const active = vscode.window.activeTextEditor?.document;
  return !!(active && active.uri.toString() === docUriString);
}

// このドキュメントを lint できるか？（.txt / plaintext / markdown）
function canLint(doc) {
  if (!doc) return false;
  if (doc.isUntitled) return false;
  const fsPath = doc.uri?.fsPath?.toLowerCase() || "";
  const isTxt = fsPath.endsWith(".txt");
  const isMd = fsPath.endsWith(".md") || fsPath.endsWith(".markdown");
  const isPlain = doc.languageId === "plaintext";
  const isMarkdown = doc.languageId === "markdown";
  return isPlain || isTxt || isMd || isMarkdown;
}

// 保存時/コマンド時の挙動を共通化
async function triggerLint(
  doc,
  collection,
  { mode = "command", reason = undefined } = {}
) {
  if (mode === "save") {
    // 既存の保存ポリシー（Auto Save無効時は手動保存のみ）を尊重
    if (!shouldLintOnSave(doc.uri.toString(), reason)) {
      updateIdleUIForDoc(vscode.window.activeTextEditor?.document);
      return;
    }
  } else {
    // コマンド/クリック時はファイル種別だけ確認
    if (!canLint(doc)) {
      vscode.window.showInformationMessage(
        "このファイルは lint 対象ではありません（.txt / plaintext / markdown）。"
      );
      updateIdleUIForDoc(doc);
      return;
    }
  }

  // 即スピナー → 1ティック譲って描画 → 実行
  if (lintRunning === 0) startLintUI("Linting...");
  await new Promise((r) => setTimeout(r, 0));
  await lintActiveOnly(collection, doc);
}

// ===== 3) textlint のルール構築 =====
const OPTIONAL_RULES = [
  ["textlint-rule-ja-no-abusage", "ja-no-abusage"],
  ["textlint-rule-ja-no-redundant-expression", "ja-no-redundant-expression"],
  ["textlint-rule-ja-unnatural-alphabet", "ja-unnatural-alphabet"],
  ["textlint-rule-max-ten", "max-ten"],
  ["textlint-rule-no-doubled-conjunction", "no-doubled-conjunction"],
  ["textlint-rule-no-doubled-joshi", "no-doubled-joshi"],
  [
    "textlint-rule-no-mixed-zenkaku-and-hankaku-alphabet",
    "no-mixed-zenkaku-and-hankaku-alphabet",
  ],
  ["textlint-rule-preset-jtf-style", "preset-jtf-style"], // preset
];

const DEFAULT_RULES = {
  "preset-jtf-style": {
    "1.1.1.本文": false,
    "1.1.2.見出し": false,
    "1.1.3.箇条書き": false,
    "1.1.5.図表のキャプション": false,
    "1.2.1.句点(。)と読点(、)": false,
    "2.1.2.漢字": false,
    "2.1.5.カタカナ": false,
    "2.1.6.カタカナの長音": false,
    "2.2.1.ひらがなと漢字の使い分け": false,
    "2.2.2.算用数字と漢数字の使い分け": false,
    "2.2.3.一部の助数詞の表記": false,
    "3.1.1.全角文字と半角文字の間": false,
    "3.1.2.全角文字どうし": false,
    "3.3.かっこ類と隣接する文字の間のスペースの有無": false,
    "4.2.9.ダッシュ(-)": false,
    "4.3.1.丸かっこ（）": false,
    "4.3.2.大かっこ［］": false,
    "4.3.3.かぎかっこ「」": false,
    "4.3.4.二重かぎかっこ『』": false,
    "4.3.5.二重引用符\" \"": false,
    "4.3.6.中かっこ{ }": false,
    "4.3.7.山かっこ<>": false,
    "4.3.8.一重引用符' '": false,
  },
  "no-doubled-conjunction": true,
  "ja-no-abusage": true,
  "ja-no-redundant-expression": true,
  "ja-unnatural-alphabet": { allow: ["/[Ａ-Ｚ]/", "/[A-Z]/", "/[a-z]/"] },
  "max-ten": {
    max: 4,
    kuten: ["。", "「", "」", "『", "』", "—", "―", "…", "！", "？"],
  },
  "no-mixed-zenkaku-and-hankaku-alphabet": true,
  "no-doubled-joshi": {
    allow: ["も", "や", "か"],
    separatorCharacters: [
      ".",
      "．",
      "。",
      "「",
      "」",
      "『",
      "』",
      "?",
      "!",
      "？",
      "！",
      "—",
      "―",
      "…",
      "も",
      "　",
      " "
    ],
    strict: false,
  },
};

// DEFAULT_RULES とユーザー設定 rules を浅く上書きせず、必要なキーだけ上書きする
function mergeRules(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = mergeRules(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const normalizePluginModule = (mod) => {
  const m = mod?.default ?? mod;
  if (m && m.Processor) return { Processor: m.Processor };
  if (typeof m === "function") return { Processor: m };
  if (m && m.TextProcessor) return { Processor: m.TextProcessor };
  return null;
};

const normalizeRuleExport = (r) => {
  if (typeof r === "function") return r;
  if (r && (typeof r.linter === "function" || typeof r.fixer === "function"))
    return r;
  if (r && r.rule) {
    const x = r.rule;
    if (typeof x === "function") return x;
    if (x && (typeof x.linter === "function" || typeof x.fixer === "function"))
      return x;
  }
  return null;
};

/**
 * @returns {{ type: 'preset', entries: any[][] } | { type: 'rule', rule: any } | { type: 'invalid' }}
 */
const normalizeRuleModule = (mod) => {
  const m = mod?.default ?? mod;
  if (m && typeof m.rules === "object") {
    const out = [];
    for (const [childId, val] of Object.entries(m.rules)) {
      const rr = normalizeRuleExport(val);
      if (rr) out.push([childId, rr]);
      else channel.appendLine(`[warn] preset 内で不正な rule: ${childId}`);
    }
    return { type: "preset", entries: out };
  }
  const single = normalizeRuleExport(m);
  if (single) return { type: "rule", rule: single };
  return { type: "invalid" };
};

function buildKernelOptions() {
  const plugins = [];
  const rules = [];
  const presetIds = new Set();

  // plugin
  if (pluginText) {
    const norm = normalizePluginModule(pluginText);
    if (norm) {
      plugins.push({ pluginId: "text", plugin: norm });
    } else {
      channel.appendLine("[warn] text プラグインの Processor が見当たりません");
    }
  } else {
    channel.appendLine(
      "[warn] @textlint/textlint-plugin-text が見つかりません。`.txt` の解析に必要です。"
    );
  }

  if (pluginMarkdown) {
    const normMd = normalizePluginModule(pluginMarkdown);
    if (normMd) {
      plugins.push({ pluginId: "markdown", plugin: normMd });
    } else {
      channel.appendLine("[warn] markdown plugin is invalid");
    }
  } else {
    channel.appendLine(
      "[warn] @textlint/textlint-plugin-markdown is missing; .md lint disabled"
    );
  }

  // ユーザー設定を読み、デフォルトとマージ（ユーザー優先）
  let userRules = {};
  try {
    const cfg = vscode.workspace.getConfiguration("posNote.linter");
    userRules = cfg.get("rules") || {};
  } catch (e) {
    channel.appendLine("[warn] ユーザー設定 rules 読み込み失敗: " + e.message);
  }
  // shallow スプレッドだと preset-jtf-style: {} でデフォルト無効が消えるため deep merge
  const mergedRules = mergeRules(DEFAULT_RULES, userRules);

  // フラット/入れ子を一元化
  const optionMap = new Map();
  for (const [k, v] of Object.entries(mergedRules)) {
    if (k.includes("/")) optionMap.set(k, v);
  }
  const nested = Object.entries(mergedRules).filter(([k]) => !k.includes("/"));

  // どれが preset か知るため先に形だけ読み込む
  /** @type {[string, { type: 'preset', entries: any[][] } | { type: 'rule', rule: any } | { type: 'invalid' }][]} */
  const loadedModules = [];
  for (const [pkg, baseId] of OPTIONAL_RULES) {
    try {
      const mod = require(pkg);
      const shape = normalizeRuleModule(mod);
      loadedModules.push([baseId, shape]);
      if (shape.type === "preset") presetIds.add(baseId);
    } catch {
      channel.appendLine(`[info] ${pkg} は未導入のためスキップ`);
    }
  }
  for (const [k, v] of nested) {
    if (typeof v === "boolean") {
      optionMap.set(k, v);
    } else if (v && typeof v === "object") {
      if (presetIds.has(k)) {
        for (const [subId, subVal] of Object.entries(v)) {
          optionMap.set(`${k}/${subId}`, subVal);
        }
      } else {
        optionMap.set(k, v);
      }
    }
  }

  // 最終 rules を組み立て（false は登録しない／options は直接埋める）
  for (const [pkg, baseId] of OPTIONAL_RULES) {
    try {
      const mod = require(pkg);
      const shape =
        loadedModules.find(([id]) => id === baseId)?.[1] ||
        normalizeRuleModule(mod);

      if (shape.type === "rule") {
        const opt = optionMap.get(baseId);
        if (opt === false) {
          channel.appendLine(`[cfg] disable rule: ${baseId}`);
          continue;
        }
        const entry = { ruleId: baseId, rule: shape.rule };
        if (opt && typeof opt === "object") entry.options = opt;
        rules.push(entry);
        channel.appendLine(`[info] rule loaded: ${baseId}`);
      } else if (shape.type === "preset") {
        let used = 0,
          disabled = 0;
        for (const [childId, ruleBody] of shape.entries) {
          const full = `${baseId}/${childId}`;
          const opt = optionMap.get(full);
          if (opt === false) {
            disabled++;
            continue;
          }
          const entry = { ruleId: full, rule: ruleBody };
          if (opt && typeof opt === "object") entry.options = opt;
          rules.push(entry);
          used++;
        }
        channel.appendLine(
          `[info] preset loaded: ${baseId} (+${used} rules, disabled=${disabled})`
        );
      }
    } catch {
      // 導入されていない rule は既にログ済みなので黙ってスキップ
    }
  }

  channel.appendLine(`[cfg] effective rules count=${rules.length}`);
  return { plugins, rules };
}

// ===== 4) textlint → VS Code Diagnostics 変換 =====
function toDiagnostics(uri, messages) {
  const diags = [];
  for (const m of messages) {
    const line = Math.max((m.loc?.start?.line || 1) - 1, 0);
    const colStart = Math.max((m.loc?.start?.column || 1) - 1, 0);
    const lineEnd = Math.max((m.loc?.end?.line || line + 1) - 1, line);
    const colEnd = Math.max(
      (m.loc?.end?.column || colStart + 1) - 1,
      colStart + 1
    );

    const range = new vscode.Range(line, colStart, lineEnd, colEnd);
    const severity =
      m.severity === 2
        ? vscode.DiagnosticSeverity.Error
        : m.severity === 1
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Information;

    const diag = new vscode.Diagnostic(range, m.message, severity);
    diag.source = "textlint";
    diag.code = m.ruleId || "textlint";
    diags.push(diag);
  }
  return diags;
}

// ===== 5) 差分リント用ユーティリティ =====
function splitLines(s) {
  return s.replace(/\r/g, "").split("\n");
}

function computeChangedRanges(prevLines, nextLines) {
  let a = 0;
  const aMax = prevLines.length;
  const bMax = nextLines.length;

  while (a < aMax && a < bMax && prevLines[a] === nextLines[a]) a++;

  let ta = aMax - 1;
  let tb = bMax - 1;
  while (ta >= a && tb >= a && prevLines[ta] === nextLines[tb]) {
    ta--;
    tb--;
  }

  if (a > ta && a > tb) return []; // 変化なし
  const start = a;
  const end = tb; // 含む index
  return [{ start, end }];
}

function expandToParagraphRanges(lines, ranges, context = 0) {
  const res = [];
  const n = lines.length;
  for (const r of ranges) {
    let s = Math.max(0, r.start);
    let e = Math.min(n - 1, r.end);
    while (s > 0 && lines[s - 1].trim() !== "") s--;
    while (e < n - 1 && lines[e + 1].trim() !== "") e++;
    s = Math.max(0, s - context);
    e = Math.min(n - 1, e + context);
    res.push({ start: s, end: e });
  }
  res.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const cur of res) {
    if (!merged.length || merged[merged.length - 1].end + 1 < cur.start) {
      merged.push({ ...cur });
    } else {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        cur.end
      );
    }
  }
  return merged;
}

function rangesFromPrevDiagnostics(lines, diagnostics) {
  if (!diagnostics || diagnostics.length === 0) return [];
  const ranges = diagnostics.map((d) => ({
    start: d.range.start.line,
    end: Math.max(d.range.end.line, d.range.start.line),
  }));
  return expandToParagraphRanges(lines, ranges, 0);
}

function mergeDiagnostics(oldDiags, newDiags, replacedRanges) {
  if (!oldDiags || oldDiags.length === 0) return newDiags;
  const keep = [];
  for (const d of oldDiags) {
    const s = d.range.start.line;
    const e = d.range.end.line;
    const hit = replacedRanges.some((r) => !(e < r.start || s > r.end));
    if (!hit) keep.push(d);
  }
  return keep.concat(newDiags).sort((a, b) => {
    if (a.range.start.line !== b.range.start.line)
      return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
}

// ===== 6) 実行本体（差分リント） =====
async function lintActiveOnly(collection, doc) {
  if (!doc) return;
  collection.clear(); // アクティブ以外の結果は消す
  await lintDocumentIncremental(doc, collection);
}

async function lintDocumentIncremental(doc, collection) {
  try {
    if (!doc) return;
    const fsPath = doc.uri?.fsPath?.toLowerCase() || "";
    const isTxt = fsPath.endsWith(".txt");
    const isMd = fsPath.endsWith(".md") || fsPath.endsWith(".markdown");
    const isPlain = doc.languageId === "plaintext";
    const isMarkdown = doc.languageId === "markdown";
    if (!isPlain && !isTxt && !isMd && !isMarkdown) {
      finishWithCachedCount(doc);
      return;
    }
    if (doc.isUntitled) {
      finishWithCachedCount(doc);
      return;
    }

    // onWillSave / triggerLint 側で出している可能性あり。二重防止。
    if (lintRunning === 0) startLintUI("Linting...");
    channel.appendLine(
      `[lint:start] ${doc.uri.fsPath} lang=${doc.languageId} isTxt=${isTxt}`
    );

    const fullText = doc.getText();
    const uri = doc.uri;
    const nextLines = splitLines(fullText);

    if (!fullText || fullText.trim().length === 0) {
      collection.set(uri, []);
      channel.appendLine(`[lint:clear] ${uri.fsPath} 空のため診断をクリア`);
      docCache.set(uri.toString(), { textLines: nextLines, diagnostics: [] });
      finishLintUI("0 iss");
      return;
    }

    const kernel = new TextlintKernel();
    const { plugins, rules } = buildKernelOptions();
    channel.appendLine(
      `[lint:opts] plugins=${plugins.length} rules=${rules.length}`
    );
    const ext = doc.languageId === "markdown" || isMd ? ".md" : ".txt";

    const cacheKey = uri.toString();
    const cached = docCache.get(cacheKey);

    // 初回（キャッシュなし）→ 全文リント
    if (!cached) {
      const maskedText = maskCodeBlocks(fullText);
      const result = await kernel.lintText(maskedText, {
        filePath: uri.fsPath,
        ext,
        plugins,
        rules,
      });
      const diagnostics = toDiagnostics(uri, result.messages || []);
      // 句読点連続の独自診断を追加
      diagnostics.push(...findRepeatedPunctDiagnostics(uri, maskedText, 0));
      // 「！」「？」直後の全角スペース不足の独自診断を追加
      diagnostics.push(
        ...findExclamQuestionSpaceDiagnostics(uri, maskedText, 0)
      );
      collection.set(uri, diagnostics);
      docCache.set(cacheKey, { textLines: nextLines, diagnostics });
      channel.appendLine(
        `[lint:done] ${uri.fsPath} → ${diagnostics.length} 件 (full)`
      );
      finishLintUI(`${diagnostics.length} iss`);
      return;
    }

    // 差分レンジ（変更行）＋ 前回エラー行レンジ
    const changed = computeChangedRanges(cached.textLines, nextLines);
    const prevErr = rangesFromPrevDiagnostics(nextLines, cached.diagnostics);
    const contextLines = vscode.workspace
      .getConfiguration("posNote.linter")
      .get("incrementalContext", 2);

    let targetRanges = [];
    if (changed.length > 0) {
      const changedPara = expandToParagraphRanges(
        nextLines,
        changed,
        contextLines
      );
      targetRanges = changedPara;
    }
    if (prevErr.length > 0) {
      targetRanges = targetRanges.concat(prevErr);
    }

    // マージ（重複統合）
    targetRanges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const cur of targetRanges) {
      if (!merged.length || merged[merged.length - 1].end + 1 < cur.start) {
        merged.push({ ...cur });
      } else {
        merged[merged.length - 1].end = Math.max(
          merged[merged.length - 1].end,
          cur.end
        );
      }
    }

    // 対象レンジが無ければスキップ（キャッシュだけ更新）
    if (merged.length === 0) {
      channel.appendLine(`[lint:skip] 差分が無いのでスキップ`);
      docCache.set(cacheKey, {
        textLines: nextLines,
        diagnostics: cached.diagnostics,
      });
      collection.set(uri, cached.diagnostics);
      finishLintUI(`${cached.diagnostics.length} iss`);
      return;
    }

    // 各レンジを個別に lint して集約
    const newPartialDiagnostics = [];
    for (const r of merged) {
      const sliceText = nextLines.slice(r.start, r.end + 1).join("\n");
      // ★ 差分スライス開始時点がフェンス内かどうかを判定
      const initialFence = fenceStateBefore(nextLines, r.start);
      // ★ フェンス内から始まる場合でも確実にマスク
      const maskedSlice = maskCodeBlocks(sliceText, initialFence);
      const res = await kernel.lintText(maskedSlice, {
        filePath: uri.fsPath,
        ext,
        plugins,
        rules,
      });

      // slice 内の 1-based loc を元行へオフセット
      const adjusted = (res.messages || []).map((m) => {
        const msg = {
          ...m,
          loc: m.loc ? JSON.parse(JSON.stringify(m.loc)) : undefined,
        };
        if (msg.loc?.start) msg.loc.start.line += r.start;
        if (msg.loc?.end) msg.loc.end.line += r.start;
        return msg;
      });

      const diags = toDiagnostics(uri, adjusted);
      // この差分レンジ内の句読点連続診断を追加（ベース行 = r.start）
      diags.push(...findRepeatedPunctDiagnostics(uri, maskedSlice, r.start));
      // この差分レンジ内の「！」「？」直後 全角スペース不足診断を追加（ベース行 = r.start）
      diags.push(
        ...findExclamQuestionSpaceDiagnostics(uri, maskedSlice, r.start)
      );

      newPartialDiagnostics.push(...diags);
    }

    // 旧診断の該当範囲を新診断で置き換え
    const mergedDiagnostics = mergeDiagnostics(
      cached.diagnostics,
      newPartialDiagnostics,
      merged
    );

    collection.set(uri, mergedDiagnostics);
    docCache.set(cacheKey, {
      textLines: nextLines,
      diagnostics: mergedDiagnostics,
    });

    channel.appendLine(
      `[lint:done] ${uri.fsPath} → ${mergedDiagnostics.length} 件 (partial ×${merged.length})`
    );
    finishLintUI(`${mergedDiagnostics.length} iss`);
  } catch (err) {
    channel.appendLine(
      `[error] lintDocument 失敗: ${err && err.stack ? err.stack : String(err)}`
    );
    finishLintUI("Error");
  }
}

// ===== 7) エントリポイント =====
function activate(context) {
  // channel.appendLine("[activate] textlint-kernel-linter 起動");
  // try {
  //   channel.show(true);
  // } catch {}

  ensureStatusBar(context);
  updateIdleUIForDoc(vscode.window.activeTextEditor?.document); // 起動直後

  // ファイル切替時（自動リントなし方針のまま、直前結果だけ反映）
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateIdleUIForDoc(editor?.document);
    })
  );

  // （既存）出力パネルを開くコマンド
  context.subscriptions.push(
    vscode.commands.registerCommand("linter.showOutput", () => {
      try {
        channel.show(true);
      } catch {}
    })
  );

  const collection = vscode.languages.createDiagnosticCollection(
    "textlint-kernel-linter"
  );
  context.subscriptions.push(collection);

  // クリック/コマンド：今開いているファイルを lint
  context.subscriptions.push(
    vscode.commands.registerCommand("linter.lintActiveFile", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) {
        vscode.window.showInformationMessage(
          "アクティブなエディタがありません。"
        );
        return;
      }
      if (!canLint(doc)) {
        vscode.window.showInformationMessage(
          "このファイルは lint 対象ではありません（.txt / plaintext / markdown のみ）。"
        );
        updateIdleUIForDoc(doc);
        return;
      }
      try {
        await triggerLint(doc, collection, { mode: "command" });
      } catch (e) {
        channel.appendLine(
          `[cmd] linter.lintActiveFile error: ${e?.stack || e}`
        );
        finishLintUI("Error");
      }
    })
  );

  // 保存直前：保存理由を記録し、予定されていれば即スピナー
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      lastSaveReason.set(e.document.uri.toString(), e.reason);
      try {
        if (shouldLintOnSave(e.document.uri.toString(), e.reason)) {
          startLintUI("Linting...");
        }
      } catch {}
    })
  );

  // 保存時：共通トリガー経由で実行
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const reason = lastSaveReason.get(doc.uri.toString());
      lastSaveReason.delete(doc.uri.toString());
      channel.appendLine(`[evt] onDidSaveTextDocument: ${doc.uri.fsPath}`);
      triggerLint(doc, collection, { mode: "save", reason });
    })
  );

  // 起動時／ファイル切替時の自動リントは行わない（ポリシー継承）
}

function deactivate() {}

module.exports = { activate, deactivate };
