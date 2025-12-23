// textlint のプラグイン／ルール構成を提供する (Worker/Main 両対応)
// VS Code 依存（vscodeモジュール）は排除すること。

// textlint plugins (optional)
let pluginText = null;
try {
  pluginText = require("@textlint/textlint-plugin-text");
} catch {}

let pluginMarkdown = null;
try {
  // @ts-ignore
  pluginMarkdown = require("@textlint/textlint-plugin-markdown");
} catch {}

// ===== textlint ルール構成 =====
/** @type {[string, any][]} */
const LOADED_RULES = [
  ["ja-no-abusage", require("textlint-rule-ja-no-abusage")],
  ["ja-no-redundant-expression", require("textlint-rule-ja-no-redundant-expression")],
  ["ja-unnatural-alphabet", require("textlint-rule-ja-unnatural-alphabet")],
  ["max-ten", require("textlint-rule-max-ten")],
  ["no-doubled-conjunction", require("textlint-rule-no-doubled-conjunction")],
  ["no-doubled-joshi", require("textlint-rule-no-doubled-joshi")],
  ["no-mixed-zenkaku-and-hankaku-alphabet", require("textlint-rule-no-mixed-zenkaku-and-hankaku-alphabet")],
  ["preset-jtf-style", require("textlint-rule-preset-jtf-style")],
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
    "4.2.7.コロン(：)": false,
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
    allow: ["も", "や", "か", "と"],
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

/**
 * オブジェクトを深めにマージする（配列は上書き）。
 * @param {Record<string, any>} base
 * @param {Record<string, any>} override
 * @returns {Record<string, any>}
 */
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
 * @param {*} mod
 * @param {(msg: string) => void} log
 * @returns {{ type: 'preset', entries: any[][] } | { type: 'rule', rule: any } | { type: 'invalid' }}
 */
const normalizeRuleModule = (mod, log) => {
  const m = mod?.default ?? mod;
  if (m && typeof m.rules === "object") {
    const out = [];
    for (const [childId, val] of Object.entries(m.rules)) {
      const rr = normalizeRuleExport(val);
      if (rr) out.push([childId, rr]);
      else log(`[warn] preset 内で不正な rule: ${childId}`);
    }
    /** @type {{ type: 'preset', entries: any[][] }} */
    return { type: 'preset', entries: out };
  }
  const single = normalizeRuleExport(m);
  if (single) {
    /** @type {{ type: 'rule', rule: any }} */
    return { type: 'rule', rule: single };
  }
  /** @type {{ type: 'invalid' }} */
  return { type: 'invalid' };
};

/**
 * textlint の plugins / rules を組み立てる。
 * ユーザー設定と既定値をマージし、読み込めたものだけ返す。
 * @param {Record<string, any>} userRulesFromConfig ユーザー設定の rules オブジェクト
 * @param {{ appendLine?: (msg:string)=>void } | undefined} channel ログ出力先
 * @returns {{ plugins: any[], rules: any[] }}
 */
function buildKernelOptions(userRulesFromConfig, channel) {
  const log = (msg) => {
    try {
      if (channel?.appendLine) channel.appendLine(msg);
      else console.log(msg);
    } catch {}
  };

  const plugins = [];
  const rules = [];
  const presetIds = new Set();

  // plugin
  if (pluginText) {
    const norm = normalizePluginModule(pluginText);
    if (norm) {
      plugins.push({ pluginId: "text", plugin: norm });
    } else {
      log("[warn] text プラグインの Processor が見当たりません");
    }
  } else {
    log(
      "[warn] @textlint/textlint-plugin-text が見つかりません。`.txt` の解析に必要です。"
    );
  }

  if (pluginMarkdown) {
    const normMd = normalizePluginModule(pluginMarkdown);
    if (normMd) {
      plugins.push({ pluginId: "markdown", plugin: normMd });
    } else {
      log("[warn] markdown plugin is invalid");
    }
  } else {
    log("[warn] @textlint/textlint-plugin-markdown is missing; .md lint disabled");
  }

  const mergedRules = mergeRules(DEFAULT_RULES, userRulesFromConfig || {});

  // フラット/入れ子を一元化
  const optionMap = new Map();
  for (const [k, v] of Object.entries(mergedRules)) {
    if (k.includes("/")) optionMap.set(k, v);
  }
  const nested = Object.entries(mergedRules).filter(([k]) => !k.includes("/"));

  // どれが preset か知るため先に形だけ読み込む
  /** @type {Array<[string, { type: 'preset', entries: any[][] } | { type: 'rule', rule: any } | { type: 'invalid' }]>} */
  const loadedModules = [];
  for (const [baseId, mod] of LOADED_RULES) {
    try {
      const shape = normalizeRuleModule(mod, log);
      loadedModules.push([baseId, shape]);
      if (shape.type === "preset") presetIds.add(baseId);
    } catch {
      log(`[info] ${baseId} の読み込みに失敗 (static loaded)`);
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
  for (const [baseId, mod] of LOADED_RULES) {
    try {
      const shape =
        loadedModules.find(([id]) => id === baseId)?.[1] ||
        normalizeRuleModule(mod, log);

      if (shape.type === "rule") {
        const opt = optionMap.get(baseId);
        if (opt === false) {
          log(`[cfg] disable rule: ${baseId}`);
          continue;
        }
        const entry = { ruleId: baseId, rule: shape.rule };
        if (opt && typeof opt === "object") entry.options = opt;
        rules.push(entry);
        log(`[info] rule loaded: ${baseId}`);
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
        log(
          `[info] preset loaded: ${baseId} (+${used} rules, disabled=${disabled})`
        );
      }
    } catch {
      // 導入されていない rule は既にログ済みなので黙ってスキップ
    }
  }

  log(`[cfg] effective rules count=${rules.length}`);
  return { plugins, rules };
}


// ===== ユーティリティ（Workerでも使うなら別ファイルだが、今回はMainで使うため削除または移動） =====
const RE_MASK_FENCE = /^\s*(```|~~~)/;
const RE_INDENT_BLOCK = /^(?: {4}|\t)/;

function maskCodeBlocks(text, initialFence = null) {
  const inLines = text.split(/\r?\n/);
  const outLines = [];

  let fence = initialFence;

  for (let i = 0; i < inLines.length; i++) {
    const raw = inLines[i];

    if (fence) {
      outLines.push("");
      if (RE_MASK_FENCE.test(raw)) {
        const m = RE_MASK_FENCE.exec(raw);
        if (m && m[1] === fence) fence = null;
      }
      continue;
    }

    const m = RE_MASK_FENCE.exec(raw);
    if (m) {
      fence = m[1];
      outLines.push("");
      continue;
    }

    const prevIsBlank = i === 0 || inLines[i - 1].trim() === "";
    if (prevIsBlank && RE_INDENT_BLOCK.test(raw)) {
      let j = i;
      while (j < inLines.length && RE_INDENT_BLOCK.test(inLines[j])) j++;
      const count = j - i;
      if (count >= 2) {
        for (let k = i; k < j; k++) outLines.push("");
        i = j - 1;
        continue;
      }
    }

    outLines.push(raw);
  }

  return outLines.join("\n");
}

function fenceStateBefore(lines, startLine) {
  let fence = null;
  for (let i = 0; i < startLine; i++) {
    const m = RE_MASK_FENCE.exec(lines[i]);
    if (!m) continue;
    const t = m[1];
    if (fence === t) fence = null;
    else if (fence === null) fence = t;
    else fence = t;
  }
  return fence;
}

module.exports = {
  buildKernelOptions,
  maskCodeBlocks,
  fenceStateBefore,
};
