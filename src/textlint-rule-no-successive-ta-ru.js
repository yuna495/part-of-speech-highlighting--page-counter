"use strict";

const { splitAST, SentenceSplitterSyntax } = require("sentence-splitter");

const DEFAULT_OPTIONS = {
  maxPara: 3,
  maxBlock: 4,
  ruMaxPara: 4,
  ruMaxBlock: 5,
};

module.exports = function(context, options = {}) {
  const { Syntax, RuleError, report, getSource } = context;
  const maxPara = options.maxPara !== undefined ? options.maxPara : (options.max || DEFAULT_OPTIONS.maxPara);
  const maxBlock = options.maxBlock !== undefined ? options.maxBlock : (options.max || DEFAULT_OPTIONS.maxBlock);
  const ruMaxPara = options.ruMaxPara !== undefined ? options.ruMaxPara : DEFAULT_OPTIONS.ruMaxPara;
  const ruMaxBlock = options.ruMaxBlock !== undefined ? options.ruMaxBlock : DEFAULT_OPTIONS.ruMaxBlock;

  // 複数段落にまたがる（空行でリセットされる）カウント
  let shitaBlockCount = 0;
  let ttaBlockCount = 0;
  let otherTaBlockCount = 0;
  let iruBlockCount = 0;
  let aruBlockCount = 0;
  let ruBlockCount = 0;
  let lastParagraphEndLine = -1;

  return {
    [Syntax.Paragraph](node) {
      // 空行チェック（ブロックカウントのリセット）
      const currentStartLine = node.loc && node.loc.start ? node.loc.start.line : -1;
      if (lastParagraphEndLine !== -1 && currentStartLine - lastParagraphEndLine > 1) {
        shitaBlockCount = 0;
        ttaBlockCount = 0;
        otherTaBlockCount = 0;
        iruBlockCount = 0;
        aruBlockCount = 0;
        ruBlockCount = 0;
      }

      if (!node.children || node.children.length === 0) {
        if (node.loc && node.loc.end) {
          lastParagraphEndLine = node.loc.end.line;
        }
        return;
      }

      // 単一段落内（改行でリセットされる）カウント
      let shitaParaCount = 0;
      let ttaParaCount = 0;
      let otherTaParaCount = 0;
      let iruParaCount = 0;
      let aruParaCount = 0;
      let ruParaCount = 0;

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
        const match = text.match(/(した|った|た|いる|ある|る)[。！？\.\!\?」』）\]\s]*$/);

        if (match) {
          const ending = match[1];
          // 報告済みのフラグ
          let reported = false;
          let isTa = false;
          let isRu = false;

          if (ending === "した") {
            shitaParaCount++; shitaBlockCount++;
            ttaParaCount = 0; ttaBlockCount = 0;
            otherTaParaCount = 0; otherTaBlockCount = 0;
            isTa = true;

            if (shitaParaCount >= maxPara) {
              report(sentence, new RuleError(`【段落内】「～した」の文が${maxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && shitaBlockCount >= maxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で「～した」の文が${maxBlock}回以上連続しています。`));
              reported = true;
            }
          } else if (ending === "った") {
            ttaParaCount++; ttaBlockCount++;
            shitaParaCount = 0; shitaBlockCount = 0;
            otherTaParaCount = 0; otherTaBlockCount = 0;
            isTa = true;

            if (ttaParaCount >= maxPara) {
              report(sentence, new RuleError(`【段落内】「～った」の文が${maxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && ttaBlockCount >= maxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で「～った」の文が${maxBlock}回以上連続しています。`));
              reported = true;
            }
          } else if (ending === "た") {
            otherTaParaCount++; otherTaBlockCount++;
            shitaParaCount = 0; shitaBlockCount = 0;
            ttaParaCount = 0; ttaBlockCount = 0;
            isTa = true;

            if (otherTaParaCount >= maxPara) {
              report(sentence, new RuleError(`【段落内】「～た」の文が${maxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && otherTaBlockCount >= maxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で「～た」の文が${maxBlock}回以上連続しています。`));
              reported = true;
            }
          } else if (ending === "いる") {
            iruParaCount++; iruBlockCount++;
            aruParaCount = 0; aruBlockCount = 0;
            ruParaCount++; ruBlockCount++;
            isRu = true;

            if (iruParaCount >= maxPara) {
              report(sentence, new RuleError(`【段落内】「～いる」の文が${maxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && iruBlockCount >= maxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で「～いる」の文が${maxBlock}回以上連続しています。`));
              reported = true;
            }
          } else if (ending === "ある") {
            aruParaCount++; aruBlockCount++;
            iruParaCount = 0; iruBlockCount = 0;
            ruParaCount++; ruBlockCount++;
            isRu = true;

            if (aruParaCount >= maxPara) {
              report(sentence, new RuleError(`【段落内】「～ある」の文が${maxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && aruBlockCount >= maxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で「～ある」の文が${maxBlock}回以上連続しています。`));
              reported = true;
            }
          } else if (ending === "る") {
            iruParaCount = 0; iruBlockCount = 0;
            aruParaCount = 0; aruBlockCount = 0;
            ruParaCount++; ruBlockCount++;
            isRu = true;
          }

          if (isTa) {
            iruParaCount = 0; iruBlockCount = 0;
            aruParaCount = 0; aruBlockCount = 0;
            ruParaCount = 0; ruBlockCount = 0;
          } else if (isRu) {
            shitaParaCount = 0; shitaBlockCount = 0;
            ttaParaCount = 0; ttaBlockCount = 0;
            otherTaParaCount = 0; otherTaBlockCount = 0;

            if (!reported && ruParaCount >= ruMaxPara) {
              report(sentence, new RuleError(`【段落内】文末が「～る」の全体的な文が${ruMaxPara}回以上連続しています。`));
              reported = true;
            } else if (!reported && ruBlockCount >= ruMaxBlock) {
              report(sentence, new RuleError(`【段落跨ぎ】複数段落で文末が「～る」の全体的な文が${ruMaxBlock}回以上連続しています。`));
              reported = true;
            }
          }
        } else {
          // 文末が該当しない場合、連続カウントをすべてリセット
          if (text.trim().length > 0) {
            shitaParaCount = 0; shitaBlockCount = 0;
            ttaParaCount = 0; ttaBlockCount = 0;
            otherTaParaCount = 0; otherTaBlockCount = 0;
            iruParaCount = 0; iruBlockCount = 0;
            aruParaCount = 0; aruBlockCount = 0;
            ruParaCount = 0; ruBlockCount = 0;
          }
        }
      }

      if (node.loc && node.loc.end) {
        lastParagraphEndLine = node.loc.end.line;
      }
    }
  };
};
