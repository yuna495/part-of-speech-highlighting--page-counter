"use strict";

const { splitAST, SentenceSplitterSyntax } = require("sentence-splitter");

const DEFAULT_OPTIONS = {
  max: 3,
};

module.exports = function(context, options = {}) {
  const { Syntax, RuleError, report, getSource } = context;
  const max = options.max || DEFAULT_OPTIONS.max;

  let taCount = 0;
  let ruCount = 0;
  let lastParagraphEndLine = -1;

  return {
    [Syntax.Paragraph](node) {
      // 空行（Paragraph間の行数が空いている場合）をチェックしてカウントをリセット
      const currentStartLine = node.loc && node.loc.start ? node.loc.start.line : -1;
      if (lastParagraphEndLine !== -1 && currentStartLine - lastParagraphEndLine > 1) {
        taCount = 0;
        ruCount = 0;
      }

      if (!node.children || node.children.length === 0) {
        // 空の段落の場合はここで終了前にendLineを更新
        if (node.loc && node.loc.end) {
          lastParagraphEndLine = node.loc.end.line;
        }
        return;
      }

      let resultNode;
      try {
        resultNode = splitAST(node);
      } catch (e) {
        // フォールバック
        return;
      }
      const sentences = resultNode.children;

      for (const sentence of sentences) {
        if (sentence.type !== SentenceSplitterSyntax.Sentence) {
          continue;
        }

        const text = getSource(sentence);
        // 文末の文字列を取得（空白や感嘆符、句読点、閉じカッコなどを無視した最後の文字）
        const match = text.match(/(た|る)[。！？\.\!\?」』）\]\s]*$/);

        if (match) {
          const ending = match[1];
          if (ending === "た") {
            taCount++;
            ruCount = 0;
          } else if (ending === "る") {
            ruCount++;
            taCount = 0;
          }

          if (taCount >= max) {
            report(
              sentence,
              new RuleError(`文末が「～た」の文が${max}回以上連続しています。`)
            );
          } else if (ruCount >= max) {
            report(
              sentence,
              new RuleError(`文末が「～る」の文が${max}回以上連続しています。`)
            );
          }
        } else {
          // 文末が「た」「る」以外の場合、連続カウントをリセット
          // (文の長さが極端に短い場合などを除外するなどの調整も可能)
          if (text.trim().length > 0) {
            taCount = 0;
            ruCount = 0;
          }
        }
      }

      if (node.loc && node.loc.end) {
        lastParagraphEndLine = node.loc.end.line;
      }
    }
  };
};
