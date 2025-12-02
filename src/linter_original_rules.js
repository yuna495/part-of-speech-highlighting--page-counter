const vscode = require("vscode");

// ===== 1.1) 句読点連続の独自診断 =====
const RE_PUNCT_RUN = /(。。|、、|、。|。、)/g;

/**
 * 行単位で「。。」「、、」「、。」「。、」を検出し、VS Code Diagnostic を返す。
 * @param {vscode.Uri} uri
 * @param {string} text 対象テキスト（\r は除去される前提でOK）
 * @param {number} baseLine 先頭行のオフセット（部分lint時に使用）
 * @returns {vscode.Diagnostic[]}
 */
function findRepeatedPunctDiagnostics(uri, text, baseLine = 0) {
  const diags = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i];
    RE_PUNCT_RUN.lastIndex = 0;
    let m;
    while ((m = RE_PUNCT_RUN.exec(lineStr)) !== null) {
      const startCol = m.index;
      const endCol = m.index + m[0].length;
      const range = new vscode.Range(
        baseLine + i,
        startCol,
        baseLine + i,
        endCol
      );
      const diag = new vscode.Diagnostic(
        range,
        "句読点が連続しています。",
        vscode.DiagnosticSeverity.Error // 波下線で強調（VS Code 既定のsquiggle）
      );
      diag.source = "textlint-kernel-linter";
      diag.code = "punctuation-run";
      diags.push(diag);
    }
  }
  return diags;
}

// ===== 1.2) 「！」「？」直後の全角スペース不足の独自診断 =====
function findExclamQuestionSpaceDiagnostics(uri, text, baseLine = 0) {
  const diags = [];
  const lines = text.replace(/\r/g, "").split("\n");
  // 「！」or「？」の直後が"「　」「」」「』」！？改行"のいずれでもない
  // After "！" or "？", require a full-width space unless followed by safe punctuation
  // Allow: other end punctuation, closing quotes/brackets, backtick, quotes, asterisk, tilde, or line end
  const RE_NEED_FW_SPACE = /[！？](?![！？　」』〉》）】`'”*~]|$)/g;
  for (let i = 0; i < lines.length; i++) {
    const lineStr = lines[i];
    RE_NEED_FW_SPACE.lastIndex = 0;
    let m;
    while ((m = RE_NEED_FW_SPACE.exec(lineStr)) !== null) {
      const startCol = m.index; // マッチした「！」or「？」」の位置
      const endCol = m.index + 1; // その1文字分
      const range = new vscode.Range(
        baseLine + i,
        startCol,
        baseLine + i,
        endCol
      );
      const diag = new vscode.Diagnostic(
        range,
        "「！」と「？」の後にはスペースが必要です。",
        vscode.DiagnosticSeverity.Error
      );
      diag.source = "textlint-kernel-linter";
      diag.code = "exclam-question-needs-fullwidth-space";
      diags.push(diag);
    }
  }
  return diags;
}

// ===== コードブロック無視フィルタ =====
/**
 * Markdown のコードブロックを “行数を保ったまま” 無視させる。
 * - フェンス: ``` / ~~~（先頭空白OK・言語名OK・未閉でもOK）
 * - インデント型: 直前が空行で、4スペース or タブで始まる「2行以上の塊」
 * - initialFence: スライス開始時点で既にフェンス内なら "```" または "~~~" を渡す
 */
function maskCodeBlocks(text, initialFence = null) {
  const inLines = text.split(/\r?\n/);
  const outLines = [];

  let fence = initialFence; // null / "```" / "~~~"
  const RE_FENCE = /^\s*(```|~~~)/;

  for (let i = 0; i < inLines.length; i++) {
    const raw = inLines[i];

    // すでにフェンス内なら、この行を空行化してから
    // この行が終端フェンスならフェンスを閉じる
    if (fence) {
      outLines.push("");
      if (RE_FENCE.test(raw)) {
        const m = RE_FENCE.exec(raw);
        if (m && m[1] === fence) fence = null;
      }
      continue;
    }

    // ここでフェンス開始？
    const m = RE_FENCE.exec(raw);
    if (m) {
      fence = m[1];
      outLines.push(""); // フェンス行も空行化
      continue;
    }

    // インデント型コード：直前が空行 かつ 2 行以上連続のとき
    const prevIsBlank = i === 0 || inLines[i - 1].trim() === "";
    if (prevIsBlank && /^(?: {4}|\t)/.test(raw)) {
      // 連続範囲を特定
      let j = i;
      while (j < inLines.length && /^(?: {4}|\t)/.test(inLines[j])) j++;
      const count = j - i;
      if (count >= 2) {
        for (let k = i; k < j; k++) outLines.push(""); // まとめて空行化
        i = j - 1; // while の i++ で j へ移動
        continue;
      }
      // 1 行だけは詩行等の誤爆回避で残す
    }

    // 通常行はそのまま
    outLines.push(raw);
  }

  // 未閉フェンスで終わった場合も、上のロジックで全行空行化済み
  return outLines.join("\n");
}

// ===== スライス開始時にフェンス内かどうか判定 =====
function fenceStateBefore(lines, startLine) {
  let fence = null; // "```" / "~~~" / null
  const RE_FENCE = /^\s*(```|~~~)/;
  for (let i = 0; i < startLine; i++) {
    const m = RE_FENCE.exec(lines[i]);
    if (!m) continue;
    const t = m[1];
    if (fence === t) fence = null; // 同種で閉じる
    else if (fence === null) fence = t; // 開く
    else fence = t; // 異種が来た場合も最新に寄せる（安全側）
  }
  return fence;
}

module.exports = {
  findRepeatedPunctDiagnostics,
  findExclamQuestionSpaceDiagnostics,
  maskCodeBlocks,
  fenceStateBefore,
};

