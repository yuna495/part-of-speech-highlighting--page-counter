// headline_symbols.js
// # 見出し → DocumentSymbol を提供して、アウトライン／パンくず／Sticky Scroll を有効化
const vscode = require("vscode");
const { getHeadingLevel } = require("./utils");

/**
 * 行番号から、その見出しブロックの end 行（次の同格以下の見出し直前）を求める
 */
function findHeadingBlockEnd(document, startLine, startLevel) {
  const max = document.lineCount;
  for (let i = startLine + 1; i < max; i++) {
    const lvl = getHeadingLevel(document.lineAt(i).text);
    if (lvl > 0 && lvl <= startLevel) {
      return i - 1;
    }
  }
  return max - 1;
}

/**
 * # をシンボル化する Provider
 * - レベル1..6を階層化して DocumentSymbol ツリーを返す
 * - Markdown は VS Code 既定があるため対象外（衝突回避）
 */
class HeadingSymbolProvider {
  provideDocumentSymbols(document, token) {
    if (token?.isCancellationRequested) return [];

    // 言語フィルタ（.txt / novel のみ）
    const lang = (document.languageId || "").toLowerCase();
    if (!(lang === "plaintext" || lang === "novel" || lang === "novel")) {
      return [];
    }

    // 見出し行の収集
    const heads = [];
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      const level = getHeadingLevel(text);
      if (level > 0) {
        heads.push({ line: i, level, text });
      }
    }
    if (heads.length === 0) return [];

    // 行→範囲→DocumentSymbol を生成し、レベルでネストさせる
    const syms = [];
    const stack = []; // { level, sym }

    for (let idx = 0; idx < heads.length; idx++) {
      const { line, level, text } = heads[idx];
      const endLine = findHeadingBlockEnd(document, line, level);

      // タイトル文字列を整形（先頭 # を除去して trim）
      const title = text.replace(/^#+\s*/, "").trim() || `Heading L${level}`;

      // 表示に使う kind は Section が最も自然（Namespace でも可）
      const range = new vscode.Range(
        line,
        0,
        endLine,
        document.lineAt(endLine).text.length
      );
      const selectionRange = new vscode.Range(
        line,
        0,
        line,
        document.lineAt(line).text.length
      );
      const sym = new vscode.DocumentSymbol(
        title,
        "", // detail は空に（必要なら文字数など入れても可）
        vscode.SymbolKind.Section,
        range,
        selectionRange
      );

      // スタックを使って親子関係を形成
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) {
        syms.push(sym);
      } else {
        stack[stack.length - 1].sym.children.push(sym);
      }
      stack.push({ level, sym });
    }

    return syms;
  }
}

/**
 * Provider 登録
 */
function registerHeadingSymbolProvider(context) {
  const selector = [
    { language: "plaintext", scheme: "file" },
    { language: "plaintext", scheme: "untitled" },
    { language: "novel", scheme: "file" },
    { language: "novel", scheme: "untitled" },
    { language: "Novel", scheme: "file" }, // 保険
    { language: "Novel", scheme: "untitled" }, // 保険
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new HeadingSymbolProvider()
    )
  );
}

module.exports = { registerHeadingSymbolProvider };
