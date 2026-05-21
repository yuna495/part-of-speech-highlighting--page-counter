"use strict";

const { parentPort } = require("worker_threads");
const path = require("path");

// Semantic Token Legend (Must match semantic.js)
const tokenTypesArr = [
  "noun", "verb", "adjective", "adverb", "particle",
  "auxiliary", "prenoun", "conjunction", "interjection",
  "symbol", "other", "bracket", "character", "glossary",
  "space", "heading", "fencecomment"
];

let tokenizer = null;

function initTokenizer() {
  if (tokenizer) return Promise.resolve(tokenizer);
  try {
    // wasm-pack generates a Node.js-compatible CommonJS module at ../wasm_module/pos_note_wasm
    const { WasmTokenizer } = require("../wasm_module/pos_note_wasm");
    tokenizer = new WasmTokenizer();
    console.log("[SemanticWorker Wasm] Synchronously loaded Rust Wasm morphological analyzer successfully!");
    return Promise.resolve(tokenizer);
  } catch (err) {
    console.error("[SemanticWorker Wasm] Failed to load Wasm morphological analyzer:", err);
    return Promise.reject(err);
  }
}

const activeJobs = new Set();
const ABORT_CHECK_INTERVAL = 1000; // Check every N lines

parentPort.on("message", async (msg) => {
  try {
    if (msg.command === "init") {
      await initTokenizer();
      parentPort.postMessage({ command: "init_complete" });
    }
    else if (msg.command === "abort") {
        const reqId = msg.reqId;
        if (activeJobs.has(reqId)) {
          activeJobs.delete(reqId);
        }
    }
    else if (msg.command === "tokenize_simple") {
      if (!tokenizer) await initTokenizer();
      const text = msg.text || "";
      
      // Obtain flat u32 array [start, length, typeIdx, mods] from Wasm
      const wasmData = tokenizer.tokenize(text);
      const tokens = [];
      
      for (let i = 0; i < wasmData.length; i += 4) {
        const start = wasmData[i];
        const length = wasmData[i + 1];
        const typeIdx = wasmData[i + 2];
        
        let pos = "その他";
        if (typeIdx === 4) pos = "助詞"; // cursor.js checks for "助詞" only
        
        tokens.push({
          word_position: start + 1, // 1-indexed for compatibility with kuromoji usage in cursor.js
          surface_form: text.slice(start, start + length),
          pos: pos
        });
      }
      
      parentPort.postMessage({ command: "tokenize_simple_result", reqId: msg.reqId, tokens });
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
            // Wasm returns flat u32 array [start, length, typeIdx, mods]
            const wasmData = tokenizer.tokenize(text);
            for (let i = 0; i < wasmData.length; i += 4) {
              const start = wasmData[i];
              const length = wasmData[i + 1];
              const typeIdx = wasmData[i + 2];
              const mods = wasmData[i + 3];
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
