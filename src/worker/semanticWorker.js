"use strict";

const { parentPort } = require("worker_threads");
const kuromoji = require("kuromoji");
const path = require("path");

// Semantic Token Legend (Must match semantic.js)
const tokenTypesArr = [
  "noun", "verb", "adjective", "adverb", "particle",
  "auxiliary", "prenoun", "conjunction", "interjection",
  "symbol", "other", "bracket", "character", "glossary",
  "space", "heading", "fencecomment"
];
const tokenModsArr = ["proper", "prefix", "suffix"];

let tokenizer = null;
let initPromise = null;

// Map Kuromoji token to semantic type/mod index
function mapKuromojiToSemantic(tk) {
  const pos = tk.pos || "";
  const pos1 = tk.pos_detail_1 || "";
  let type = "other";

  if (pos === "名詞") type = "noun";
  else if (pos === "動詞") type = "verb";
  else if (pos === "形容詞") type = "adjective";
  else if (pos === "副詞") type = "adverb";
  else if (pos === "助詞") type = "particle";
  else if (pos === "助動詞") type = "auxiliary";
  else if (pos === "連体詞") type = "prenoun";
  else if (pos === "接続詞") type = "conjunction";
  else if (pos === "感動詞") type = "interjection";
  else if (pos === "記号") type = "symbol";

  let mods = 0;
  if (pos1 === "固有名詞") mods |= 1 << tokenModsArr.indexOf("proper");
  if (pos1 === "接頭") mods |= 1 << tokenModsArr.indexOf("prefix");
  if (pos1 === "接尾") mods |= 1 << tokenModsArr.indexOf("suffix");

  const typeIdx = Math.max(0, tokenTypesArr.indexOf(type));
  return { typeIdx, mods };
}

function getDicPath() {
    // In bundled environment, this worker is in dist/worker/semanticWorker.js
    // Dictionary is in dist/dict (shared)
    return path.join(__dirname, "..", "dict");
}

function initTokenizer(dicPath) {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    // If not provided, fallback to relative (which might fail)
    const finalPath = dicPath || getDicPath();
    kuromoji.builder({ dicPath: finalPath }).build((err, tknz) => {
      if (err) {
        initPromise = null;
        reject(err);
      } else {
        tokenizer = tknz;
        resolve(tknz);
      }
    });
  });
  return initPromise;
}

const activeJobs = new Set();
const ABORT_CHECK_INTERVAL = 1000; // Check every N lines

parentPort.on("message", async (msg) => {
  try {
    if (msg.command === "init") {
      await initTokenizer(msg.dictPath);
      parentPort.postMessage({ command: "init_complete" });
    }
    else if (msg.command === "abort") {
        const reqId = msg.reqId;
        if (activeJobs.has(reqId)) {
            // We can't synchronously stop the loop, but we can set a flag tracked globally?
            // Actually, we need to track job abort status.
            activeJobs.delete(reqId); // Removing it signals abort
        }
    }
    else if (msg.command === "tokenize") {
      // msg: { reqId, lines: [{ lineIndex, text }, ...] }
      if (!tokenizer) await initTokenizer();

      const reqId = msg.reqId;
      activeJobs.add(reqId);

      const lines = msg.lines || [];
      const flatData = [];

      let processedCount = 0;

      for (const item of lines) {
        if (!activeJobs.has(reqId)) {
             // Aborted
             return;
        }

        const lineIdx = item.lineIndex;
        const text = item.text;
        if (text) {
            const tokens = tokenizer.tokenize(text);
            for (const tk of tokens) {
                if (!tk.word_position) continue;
                const start = tk.word_position - 1;
                const length = tk.surface_form.length;
                const { typeIdx, mods } = mapKuromojiToSemantic(tk); // Ensure mapKuromojiToSemantic is accessible
                flatData.push(lineIdx, start, length, typeIdx, mods);
            }
        }

        processedCount++;
        // Yield to event loop occasionally to process 'abort' messages
        if (processedCount % ABORT_CHECK_INTERVAL === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
      }

      if (activeJobs.has(reqId)) {
          const buffer = new Uint32Array(flatData);
          parentPort.postMessage({ command: "tokenize_result", reqId: msg.reqId, data: buffer }, [buffer.buffer]);
          activeJobs.delete(reqId);
      }
    }
  } catch (err) {
    parentPort.postMessage({ command: "error", error: String(err) });
  }
});
