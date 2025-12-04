const vscode = require("vscode");
const path = require("path");
const { getSidebarBaseDirUri } = require("./sidebar_util");

const PLOT_DIR = "plot";
const STORY_FILE = "board.md";
const CARD_DIR = "card";
// sidebar_util.js の defaultPlotMd と同じ初期テンプレート
const DEFAULT_PLOT_MD = [
  "# 『』",
  "",
  "## テーマ",
  "",
  "## 舞台・背景",
  "",
  "### 時代背景",
  "",
  "### 舞台",
  "",
  "### その他",
  "",
  "## その他設定",
  "",
  "## 作品紹介",
  "",
  "- キャッチコピー",
  "",
  "- 紹介文",
  "",
].join("\n");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
// 列カラー用のデフォルトパレット（黒っぽい緑・黄・赤・青をさらに少し暗く）
const DEFAULT_PALETTE = ["#0c2f24", "#3a3109", "#300c10", "#0c1f38"];
// タグストライプ用のデフォルトパレット（緑・黄・赤・青の中間色）
const DEFAULT_TAG_PALETTE = ["#8dc63f", "#f5a623", "#c45dd8", "#2fa8c9"];

function initKanbn(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("posNote.kanbn.openBoard", () =>
      KanbnPanel.show(context)
    )
  );
}

class KanbnPanel {
  static current = null;

  static async show(context) {
    const root = await resolveRootUri();
    if (!root) {
      vscode.window.showWarningMessage("作品フォルダを開いてください");
      return;
    }
    if (KanbnPanel.current) {
      KanbnPanel.current.retarget(root);
      KanbnPanel.current.panel.reveal();
      return;
    }
    KanbnPanel.current = new KanbnPanel(context, root);
  }

  constructor(context, rootUri) {
    this.context = context;
    this.rootUri = rootUri;
    this.panel = vscode.window.createWebviewPanel(
      "posNoteKanbnBoard",
      "プロットボード",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri, rootUri],
        retainContextWhenHidden: true,
      }
    );
    this.panel.onDidDispose(() => {
      KanbnPanel.current = null;
      this.disposeWatchers();
    });
    this.panel.webview.html = this.html();
    this.bindMessages();
    this.attachWatchers();
    this.refresh();
  }

  retarget(rootUri) {
    this.rootUri = rootUri;
    this.attachWatchers();
    this.refresh();
  }

  disposeWatchers() {
    this.storyWatcher?.dispose();
    this.cardWatcher?.dispose();
  }

  attachWatchers() {
    this.disposeWatchers();
    const storyPattern = new vscode.RelativePattern(
      this.rootUri,
      `${PLOT_DIR}/${STORY_FILE}`
    );
    const cardPattern = new vscode.RelativePattern(
      this.rootUri,
      `${PLOT_DIR}/${CARD_DIR}/**`
    );
    this.storyWatcher = vscode.workspace.createFileSystemWatcher(storyPattern);
    this.cardWatcher = vscode.workspace.createFileSystemWatcher(cardPattern);
    for (const w of [this.storyWatcher, this.cardWatcher]) {
      w.onDidChange(() => this.refresh());
      w.onDidCreate(() => this.refresh());
      w.onDidDelete(() => this.refresh());
      this.context.subscriptions.push(w);
    }
  }

  bindMessages() {
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.refresh();
          break;
        case "moveCard":
          await BoardStore.moveCard(
            this.rootUri,
            msg.cardId,
            msg.toColumnId,
            msg.toIndex
          );
          await this.refresh();
          break;
        case "addCard":
          await BoardStore.addCard(this.rootUri, msg.columnId);
          await this.refresh();
          break;
        case "deleteCard":
          await BoardStore.deleteCard(this.rootUri, msg.cardId);
          await this.refresh();
          break;
        case "openCard":
          await BoardStore.openCard(this.rootUri, msg.cardId);
          break;
        case "addColumn":
          await BoardStore.addColumn(this.rootUri, msg.afterColumnId);
          await this.refresh();
          break;
        case "moveColumn":
          await BoardStore.moveColumn(this.rootUri, msg.columnId, msg.toIndex);
          await this.refresh();
          break;
        case "renameColumn":
          await BoardStore.renameColumn(this.rootUri, msg.columnId);
          await this.refresh();
          break;
        case "deleteColumn":
          await BoardStore.deleteColumn(this.rootUri, msg.columnId);
          await this.refresh();
          break;
        case "deleteColumnHard":
          await BoardStore.deleteColumnHard(this.rootUri, msg.columnId);
          await this.refresh();
          break;
        case "exportPlot":
          const ans = await vscode.window.showWarningMessage(
            "plot.md に書き出します（既存部分は上書きされます）。よろしいですか？",
            { modal: true },
            "書き出し"
          );
          if (ans !== "書き出し") {
            this.panel.webview.postMessage({ type: "exportResult", ok: false, error: "キャンセルされました" });
            return;
          }
          try {
            await BoardStore.exportPlot(this.rootUri);
            this.panel.webview.postMessage({ type: "exportResult", ok: true });
          } catch (err) {
            vscode.window.showErrorMessage(`plot.md 書き出しに失敗しました: ${err.message}`);
            this.panel.webview.postMessage({ type: "exportResult", ok: false, error: err.message });
          }
          await this.refresh();
          break;
        case "addTag":
          await BoardStore.addTag(this.rootUri, msg.cardId, msg.tag);
          await this.refresh();
          break;
        case "removeTag":
          await BoardStore.removeTag(this.rootUri, msg.cardId, msg.tag);
          await this.refresh();
          break;
        default:
          break;
      }
    });
  }

  async refresh() {
    const data = await BoardStore.loadBoard(this.rootUri);
    const columnColors = getColumnColors();
    const tagColorsPayload = getTagColorsPayload();
    this.panel.webview.postMessage({ type: "data", ...data, columnColors, tagColorsPayload });
    this.panel.title = `プロットボード - ${path.basename(this.rootUri.fsPath)}`;
  }

  html() {
    const paletteLiteral = JSON.stringify(getColumnColors());
    const tagPaletteLiteral = JSON.stringify(getTagColorsPayload());
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; padding:12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#111; color:#eee; }
    .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
    .tag-palette { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:4px 8px; background:#1b1b1b; border:1px solid #333; border-radius:8px; color:#fff; }
    .tag-chip { padding:2px 8px; border-radius:999px; background:#333; color:#000; font-size:12px; cursor:grab; user-select:none; }
    .tag-palette { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:4px 8px; background:#1b1b1b; border:1px solid #333; border-radius:8px; }
    .tag-chip { padding:2px 8px; border-radius:999px; background:#333; font-size:12px; cursor:grab; user-select:none; }
    button { background:#2d7dff; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
    button.sub { background:#444; }
    .icon-btn { width:32px; height:32px; padding:0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:16px; }
    .loading { animation: spin 0.8s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
    .board { display:flex; gap:12px; align-items:stretch; overflow-x:auto; --col-base:300px; --col-min:120px; --col-max:500px; }
    .column { flex:1 1 var(--col-base); min-width:var(--col-min); max-width:var(--col-max); display:flex; flex-direction:column; min-height:calc(100vh - 80px); background:transparent; }
    /* TBDは常に他列のおおよそ1/2幅になるよう grow を0.5、basisを1/2に設定し、縮小も許可 */
    .column.tbd { flex:0.5 1 calc(var(--col-base) / 2); min-width:calc(var(--col-min) / 2); max-width:calc(var(--col-max) / 2); }
    .column-body { background:var(--col-bg, #222); border-radius:10px; padding:10px; box-shadow:0 2px 6px #0006; display:flex; flex-direction:column; }
    .column-filler { flex:1; background:transparent; }
    .column.tbd .column-body { flex:1; }
    .column.tbd .column-filler { flex:0; }
    .column header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .column-title { font-weight:700; }
    .cards { display:flex; flex-direction:column; gap:8px; min-height:24px; flex:1; padding-bottom:12px; }
    .card { position:relative; padding:10px 10px 10px 14px; background:#111; border:1px solid #444; border-radius:8px; cursor:grab; }
    .card::before { content:""; position:absolute; inset:0 auto 0 0; width:6px; border-radius:8px 0 0 8px; background:var(--tag-stripe, #444); opacity:var(--tag-stripe-opacity, 0); }
    .card::after  { content:""; position:absolute; inset:0 0 0 auto; width:6px; border-radius:0 8px 8px 0; background:var(--tag-stripe, #444); opacity:var(--tag-stripe-opacity, 0); }
    .card.dragging { opacity:0.6; }
    .tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .tag { background:#333; padding:2px 6px; border-radius:999px; font-size:11px; }
    .tag[draggable="true"] { cursor:grab; }
    .characters .tag { background:#2e8b57; }
    .time { margin-top:6px; font-size:11px; color:#ddd; }
    .trash { margin-left:auto; padding:6px 10px; border:1px dashed #ff7777; color:#ffaaaa; border-radius:8px; min-width:110px; text-align:center; cursor:default; }
    .trash.active { background:#552222; color:#ffdddd; border-color:#ffdddd; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="add-column">列を追加</button>
    <button id="refresh" class="sub icon-btn" title="再読み込み">⟳</button>
    <button id="export" class="sub" title="plot.md に書き出し">plot.md に出力</button>
    <div id="tag-palette" class="tag-palette"><span class="label">登録タグ：</span></div>
    <div id="trash" class="trash" title="ここにドロップで削除">🗑 カード・列をドロップで削除</div>
  </div>
  <div id="board" class="board"></div>
  <script>
    const vscode = acquireVsCodeApi();
  let state = { columns: [], cards: {} };
  const paletteEl = document.getElementById("tag-palette");
    let loading = false;

    const boardEl = document.getElementById("board");
    document.getElementById("add-column").onclick = () => vscode.postMessage({ type: "addColumn" });
    document.getElementById("refresh").onclick = () => {
      setLoading(true);
      vscode.postMessage({ type: "ready" });
    };
    const exportBtn = document.getElementById("export");
    if (exportBtn) {
      exportBtn.onclick = () => {
        setLoading(true);
        vscode.postMessage({ type: "exportPlot" });
      };
    }
    const trashEl = document.getElementById("trash");

    boardEl.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("application/kanbn-tag-remove")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        return;
      }
      // タグ追加のドラッグはスルー（カードで受ける）
      if (e.dataTransfer.types.includes("application/kanbn-tag")) return;
      if (!e.dataTransfer.types.includes("text/column")) return;
      e.preventDefault();
    });
    boardEl.addEventListener("drop", (e) => {
      const removePayload = e.dataTransfer.getData("application/kanbn-tag-remove");
      if (removePayload) {
        e.preventDefault();
        const { cardId, tag } = JSON.parse(removePayload);
        // カード外でドロップされたら削除
        if (!e.target.closest || !e.target.closest(".card")) {
          vscode.postMessage({ type: "removeTag", cardId, tag });
        }
        return;
      }
      if (!e.dataTransfer.types.includes("text/column")) return;
      e.preventDefault();
      const columnId = e.dataTransfer.getData("text/column");
      if (!columnId) return;
      const idx = dropColumnIndex(boardEl, e.clientX);
      vscode.postMessage({ type: "moveColumn", columnId, toIndex: idx });
    });

    // ゴミ箱ドロップ
    ["dragover", "dragenter"].forEach((evName) => {
      trashEl.addEventListener(evName, (e) => {
        if (acceptsTrash(e.dataTransfer)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          trashEl.classList.add("active");
        }
      });
    });
    ["dragleave", "dragend"].forEach((evName) => {
      trashEl.addEventListener(evName, () => trashEl.classList.remove("active"));
    });
    trashEl.addEventListener("drop", (e) => {
      e.preventDefault();
      trashEl.classList.remove("active");
      const colId = e.dataTransfer.getData("text/column") || e.dataTransfer.getData("application/kanbn-column");
      const cardId = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/kanbn-card");
      if (colId) {
        if (colId === "tbd") return;
        vscode.postMessage({ type: "deleteColumnHard", columnId: colId });
      } else if (cardId) {
        vscode.postMessage({ type: "deleteCard", cardId });
      }
    });

    window.addEventListener("message", (ev) => {
      const msg = ev.data;
      if (msg.type === "data") {
        state = { columns: msg.columns, cards: msg.cards };
        // 設定更新
        if (msg.columnColors) palette = msg.columnColors;
        if (msg.tagColorsPayload) {
          tagColorsPayload = msg.tagColorsPayload;
          tagColors = tagColorsPayload.map;
          hasUserTagColors = tagColorsPayload.userProvided;
          // tagOrder再構築
          for (const key in tagOrder) delete tagOrder[key];
          if (tagColors) {
            Object.keys(tagColors).forEach((k, i) => {
              if (k === "other") return;
              tagOrder[k] = i;
            });
          }
        }
        setLoading(false);
        render();
        renderPalette();
      } else if (msg.type === "exportResult") {
        setLoading(false);
        if (msg.ok) {
          alert("plot.md へ書き出しました。");
        } else {
          alert("書き出しに失敗しました: " + (msg.error || ""));
        }
      }
    });

    let palette = ${paletteLiteral};
    let tagColorsPayload = ${tagPaletteLiteral};
    let tagColors = tagColorsPayload.map;
    let hasUserTagColors = tagColorsPayload.userProvided;
    const tagOrder = {};
    if (tagColors) {
      Object.keys(tagColors).forEach((k, i) => {
        if (k === "other") return;
        tagOrder[k] = i;
      });
    }
    const DEFAULT_TAG_PALETTE = ${JSON.stringify(DEFAULT_TAG_PALETTE)};

    function render() {
      boardEl.innerHTML = "";
      let colorIdx = 0;
      state.columns.forEach((col, idx) => {
        const colEl = document.createElement("div");
        colEl.className = "column";
        if (col.id === "tbd") colEl.classList.add("tbd");
        colEl.dataset.id = col.id;

        const body = document.createElement("div");
        body.className = "column-body";
        if (col.id === "tbd") {
          body.style.setProperty("--col-bg", "#303030");
        } else {
          body.style.setProperty("--col-bg", palette[colorIdx % palette.length]);
          colorIdx++;
        }

        const header = document.createElement("header");
        const title = document.createElement("div");
        title.className = "column-title";
        title.textContent = col.name;
        header.appendChild(title);

        const btns = document.createElement("div");
        btns.innerHTML = '<button class="sub" data-act="add-card">＋</button>';
        header.appendChild(btns);
        body.appendChild(header);

        // 列ドラッグはヘッダーのみをハンドルにする
        header.draggable = col.id !== "tbd";
        if (col.id !== "tbd") {
          header.addEventListener("dragstart", (e) => {
            colEl.classList.add("dragging");
            e.dataTransfer.setData("text/column", col.id);
            e.dataTransfer.setData("application/kanbn-column", col.id);
            e.dataTransfer.effectAllowed = "move";
          });
          header.addEventListener("dragend", () => colEl.classList.remove("dragging"));
        }
        // ダブルクリックで列名変更
        header.addEventListener("dblclick", () => {
          vscode.postMessage({ type: "renameColumn", columnId: col.id });
        });

        const cardsEl = document.createElement("div");
        cardsEl.className = "cards";
        cardsEl.dataset.columnId = col.id;
        cardsEl.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        cardsEl.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cardId = e.dataTransfer.getData("text/plain");
          if (!cardId) return;
          const idxCard = dropIndex(cardsEl, e.clientY);
          vscode.postMessage({ type: "moveCard", cardId, toColumnId: col.id, toIndex: idxCard });
        });
        // カード以外の領域（列の余白）でもドロップできるように列要素にもリスナーを追加
        colEl.addEventListener("dragover", (e) => {
          if (!acceptsCard(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        colEl.addEventListener("drop", (e) => {
          if (!acceptsCard(e.dataTransfer)) return;
          e.preventDefault();
          const cardId = e.dataTransfer.getData("text/plain");
          if (!cardId) return;
          const idxCard = dropIndex(cardsEl, e.clientY);
          vscode.postMessage({ type: "moveCard", cardId, toColumnId: col.id, toIndex: idxCard });
        });

    col.cards.forEach((id) => {
        const card = state.cards[id] || { id, title: id, tags: [] };
      const el = document.createElement("div");
      el.className = "card";
      el.draggable = true;
      el.dataset.id = id;

        const sortedTags = (Array.isArray(card.tags) ? card.tags : []).map((t, idx) => ({
          tag: t,
          idx,
          ord: tagOrder[t] ?? 9999 + idx,
        })).sort((a, b) => (a.ord === b.ord ? a.idx - b.idx : a.ord - b.ord));

        el.innerHTML =
          '<div class="card-title">' + (card.title || id) + "</div>" +
          (card.characters && card.characters.length
            ? '<div class="tags characters">' + card.characters.map((c) => '<span class="tag">' + c + "</span>").join("") + "</div>"
            : "") +
          (card.time
            ? '<div class="time">🕒 ' + card.time + "</div>"
            : "") +
          (sortedTags.length
            ? '<div class="tags">' + sortedTags
                .map((o) => {
                  const color = tagColors && tagColors[o.tag];
                  const style = color ? ' style="background:' + color + ';color:#000;"' : "";
                  return '<span class="tag" draggable="true" data-tag="' + o.tag + '"' + style + ">" + o.tag + "</span>";
                })
                .join("") + "</div>"
            : "");
      el.addEventListener("dragstart", (e) => {
        el.classList.add("dragging");
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.setData("text/kanbn-card", id);
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
      el.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("application/kanbn-tag")) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
        }
      });
      el.addEventListener("drop", (e) => {
        const tag = e.dataTransfer.getData("application/kanbn-tag");
        if (tag) {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: "addTag", cardId: id, tag });
          return;
        }
      });
          el.addEventListener("dblclick", () => vscode.postMessage({ type: "openCard", cardId: id }));
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            quickCardMenu(id);
          });
          applyTagStripe(el, card, tagColors);
          el.querySelectorAll(".tag").forEach((tagEl) => {
            const tag = tagEl.getAttribute("data-tag") || tagEl.textContent;
            tagEl.addEventListener("dragstart", (e) => {
              e.stopPropagation();
              e.dataTransfer.setData("application/kanbn-tag-remove", JSON.stringify({ cardId: id, tag }));
              e.dataTransfer.effectAllowed = "move";
            });
          });
          cardsEl.appendChild(el);
        });

        body.appendChild(cardsEl);
        colEl.appendChild(body);
        const filler = document.createElement("div");
        filler.className = "column-filler";
        if (col.id === "tbd") filler.style.setProperty("--col-bg", "#303030");
        colEl.appendChild(filler);
        boardEl.appendChild(colEl);

        btns.querySelector('[data-act="add-card"]').onclick = () =>
          vscode.postMessage({ type: "addCard", columnId: col.id });
      });
    }

    function renderPalette() {
      if (!paletteEl) return;
      // ラベル以外（チップ）を削除
      const chips = paletteEl.querySelectorAll(".tag-chip");
      chips.forEach(c => c.remove());

      // ラベルがない場合は再生成（念のため）
      if (!paletteEl.querySelector(".label")) {
        const lbl = document.createElement("span");
        lbl.className = "label";
        lbl.textContent = "登録タグ：";
        paletteEl.prepend(lbl);
      }
      const entries = Object.entries(tagColors || {})
        .filter(([k, v]) => k !== "other" && String(v).toLowerCase() !== "none");
      entries.forEach(([tag, color]) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        chip.style.background = color || "#555";
        chip.style.color = color ? "#000" : "#fff";
        chip.draggable = true;
        chip.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("application/kanbn-tag", tag);
          e.dataTransfer.effectAllowed = "copy";
        });
        paletteEl.appendChild(chip);
      });
    }

    function dropIndex(container, y) {
      const cards = Array.from(container.querySelectorAll(".card"));
      if (!cards.length) return 0;
      const firstRect = cards[0].getBoundingClientRect();
      const lastRect = cards[cards.length - 1].getBoundingClientRect();
      if (y < firstRect.top) return 0;
      if (y > lastRect.bottom) return cards.length; // 列の下側余白でも末尾に
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        const upper = r.top + r.height * 0.5;
        const lower = r.bottom - r.height * 0.5;
        if (y < upper) return i;           // 上50%で前に
        if (y >= lower && y <= r.bottom) return i + 1; // 下50%で後ろに
      }
      return cards.length;
    }

    function acceptsCard(dt) {
      return dt && (dt.types.includes("text/plain") || dt.types.includes("text/kanbn-card"));
    }

    function dropColumnIndex(container, x) {
      const cols = Array.from(container.querySelectorAll(".column"));
      if (!cols.length) return 0;
      // 判定幅を広げるため、幅の70%ゾーンで前後を決定
      for (let i = 0; i < cols.length; i++) {
        const r = cols[i].getBoundingClientRect();
        const mid = r.left + r.width * 0.5;
        if (x < mid) return i;
      }
      return cols.length;
    }

    function acceptsTrash(dt) {
      return dt && (
        dt.types.includes("text/column") ||
        dt.types.includes("application/kanbn-column") ||
        dt.types.includes("text/kanbn-card") ||
        dt.types.includes("text/plain")
      );
    }

    function quickCardMenu(cardId) {
      const pick = confirm("削除しますか？ (OKで削除 / キャンセルでカードを開く)") ? "delete" : "open";
      if (pick === "delete") vscode.postMessage({ type: "deleteCard", cardId });
      else vscode.postMessage({ type: "openCard", cardId });
    }

    function applyTagStripe(el, card, tagColorsMap) {
      const tags = Array.isArray(card.tags) ? card.tags : [];
      if (!tags.length) {
        el.style.setProperty("--tag-stripe-opacity", 0);
        return;
      }
      const colors = [];
      const getColor = (tag, idxForFallback) => {
        if (tagColorsMap && typeof tagColorsMap === "object") {
          if (tagColorsMap[tag]) {
            if (String(tagColorsMap[tag]).toLowerCase() === "none") return null;
            return tagColorsMap[tag];
          }
          if (tagColorsMap.other) {
            if (String(tagColorsMap.other).toLowerCase() === "none") return null;
            return tagColorsMap.other;
          }
          const fallbackKey = String(idxForFallback + 1);
          if (tagColorsMap[fallbackKey]) return tagColorsMap[fallbackKey];
        }
        return DEFAULT_TAG_PALETTE[idxForFallback % DEFAULT_TAG_PALETTE.length];
      };
      for (const tag of tags) {
        const color = getColor(tag, colors.length);
        if (color) colors.push(color);
        if (colors.length >= 3) break;
      }
      if (!colors.length) {
        el.style.setProperty("--tag-stripe-opacity", 0);
        return;
      }
      const step = 100 / colors.length;
      const stops = colors
        .map((c, i) => {
          const start = i * step;
          const end = (i + 1) * step;
          return c + " " + start + "% " + end + "%";
        })
        .join(", ");
      el.style.setProperty("--tag-stripe", "linear-gradient(to bottom, " + stops + ")");
      el.style.setProperty("--tag-stripe-opacity", 1);
    }

    function setLoading(flag) {
      loading = flag;
      const btn = document.getElementById("refresh");
      if (!btn) return;
      if (loading) btn.classList.add("loading");
      else btn.classList.remove("loading");
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

class BoardStore {
  static async loadBoard(root) {
    await this.ensureStory(root);
    const columns = await this.readStory(root);
    const cards = await this.readCards(root, columns);
    return { columns, cards };
  }

  static async ensureStory(root) {
    const storyUri = vscode.Uri.joinPath(root, PLOT_DIR, STORY_FILE);
    try {
      await vscode.workspace.fs.stat(storyUri);
      return;
    } catch {}
    // 初回起動時に必要なフォルダ/ファイルを生成
    const defaultCols = defaultColumns();
    await this.writeStory(root, defaultCols);
  }

  static async readStory(root) {
    const storyUri = vscode.Uri.joinPath(root, PLOT_DIR, STORY_FILE);
    try {
      const buf = await vscode.workspace.fs.readFile(storyUri);
      const lines = decoder.decode(buf).split(/\r?\n/);
      const cols = [];
      let current = null;
      for (const line of lines) {
        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
          if (current) cols.push(current);
          const name = h2[1].trim();
          let baseId = slugify(name);
          let id = baseId;
          let n = 2;
          while (cols.some((c) => c.id === id)) {
            id = `${baseId}-${n++}`;
          }
          current = { id, name, cards: [] };
          continue;
        }
        if (current) {
          const li = line.match(/^[-*]\s+(.+)$/);
          if (li) {
            const token = li[1].trim();
            const id = token.split(/\s+/)[0];
            current.cards.push(id);
          }
        }
      }
      if (current) cols.push(current);
      if (!cols.length) throw new Error("no columns");
      const hasTbd = cols.some((c) => c.id === "tbd");
      if (!hasTbd) cols.unshift({ id: "tbd", name: "TBD", cards: [] });
      return cols;
    } catch {
      return defaultColumns();
    }
  }

  static async writeStory(root, columns) {
    const storyUri = vscode.Uri.joinPath(root, PLOT_DIR, STORY_FILE);
    const plotDir = vscode.Uri.joinPath(root, PLOT_DIR);
    await vscode.workspace.fs.createDirectory(plotDir);
    const lines = ["# Plot Board", ""];
    for (const col of columns) {
      lines.push(`## ${col.name}`);
      for (const id of col.cards || []) {
        lines.push(`- ${id}`);
      }
      lines.push("");
    }
    await vscode.workspace.fs.writeFile(
      storyUri,
      encoder.encode(lines.join("\n"))
    );
  }

  static async readCards(root, columns) {
    const map = {};
    for (const col of columns) {
      for (const id of col.cards) {
        if (!map[id]) {
          map[id] = (await this.readCard(root, id)) || {
            id,
            title: id,
            description: "",
            characters: [],
            time: "",
            tags: [],
          };
        }
      }
    }
    return map;
  }

  static cardUri(root, id) {
    return vscode.Uri.joinPath(root, PLOT_DIR, CARD_DIR, `${id}.json`);
  }

  static async readCard(root, id) {
    const uri = this.cardUri(root, id);
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(decoder.decode(buf));
    } catch {
      return null;
    }
  }

  static async writeCard(root, card) {
    const dir = vscode.Uri.joinPath(root, PLOT_DIR, CARD_DIR);
    await vscode.workspace.fs.createDirectory(dir);
    const uri = this.cardUri(root, card.id);
    // tags を最後に書き出して JSON 上も末尾に配置
    const payload = {
      id: card.id,
      title: card.title,
      description: card.description,
      characters: card.characters,
      time: card.time,
      tags: card.tags,
    };
    await vscode.workspace.fs.writeFile(
      uri,
      encoder.encode(JSON.stringify(payload, null, 2))
    );
    return payload;
  }

  static async addTag(root, cardId, tag) {
    if (!tag) return;
    const card = (await this.readCard(root, cardId)) || {
      id: cardId,
      title: cardId,
      description: "",
      characters: [],
      time: "",
      tags: [],
    };
    const tags = Array.isArray(card.tags) ? [...card.tags] : [];
    if (!tags.includes(tag)) tags.push(tag);
    card.tags = tags;
    await this.writeCard(root, card);
  }

  static async removeTag(root, cardId, tag) {
    if (!tag) return;
    const card = await this.readCard(root, cardId);
    if (!card) return;
    card.tags = (Array.isArray(card.tags) ? card.tags : []).filter((t) => t !== tag);
    await this.writeCard(root, card);
  }

  static async addCard(root, columnId) {
    const title = await vscode.window.showInputBox({ prompt: "カードタイトル" });
    if (!title) return;
    const description = await vscode.window.showInputBox({
      prompt: "説明（任意）",
    });
    const tagsInput = await vscode.window.showInputBox({
      prompt: "タグ（カンマ区切り・任意）",
    });
    const card = {
      id: makeId("card"),
      title,
      description: description || "",
      characters: [],
      time: "",
      tags: splitTags(tagsInput),
    };
    await this.writeCard(root, card);
    const cols = await this.readStory(root);
    const col = cols.find((c) => c.id === columnId) || cols[0];
    col.cards.push(card.id);
    await this.writeStory(root, cols);
  }

  static async deleteCard(root, cardId) {
    const ok = await vscode.window.showWarningMessage(
      `削除しますか？\n${cardId}`,
      { modal: true },
      "削除"
    );
    if (ok !== "削除") return;
    const cols = await this.readStory(root);
    cols.forEach((c) => (c.cards = c.cards.filter((id) => id !== cardId)));
    await this.writeStory(root, cols);
    try {
      await vscode.workspace.fs.delete(this.cardUri(root, cardId));
    } catch {}
    // サイドバーのコンテナを最新化
    try {
      await vscode.commands.executeCommand("posNote.utilities.refreshView");
    } catch {}
  }

  static async openCard(root, cardId) {
    const card = (await this.readCard(root, cardId)) || {
      id: cardId,
      title: cardId,
      description: "",
      characters: [],
      time: "",
      tags: [],
    };
    await this.writeCard(root, card);
    const doc = await vscode.workspace.openTextDocument(
      this.cardUri(root, cardId)
    );
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  static async moveCard(root, cardId, toColumnId, toIndex) {
    const cols = await this.readStory(root);
    for (const c of cols) {
      c.cards = (c.cards || []).filter((id) => id !== cardId);
    }
    const target = cols.find((c) => c.id === toColumnId) || cols[0];
    const idx = Math.max(0, Math.min(toIndex, target.cards.length));
    target.cards.splice(idx, 0, cardId);
    await this.writeStory(root, cols);
  }

  static async addColumn(root, afterId) {
    const name = await vscode.window.showInputBox({
      prompt: "列名",
      placeHolder: "例）シーン名",
    });
    if (!name) return;
    const cols = await this.readStory(root);
    const baseId = slugify(name);
    let id = baseId;
    let n = 2;
    while (cols.some((c) => c.id === id)) id = `${baseId}-${n++}`;
    const col = { id, name, cards: [] };
    if (afterId) {
      const idx = cols.findIndex((c) => c.id === afterId);
      cols.splice(idx >= 0 ? idx + 1 : cols.length, 0, col);
    } else {
      cols.push(col);
    }
    await this.writeStory(root, cols);
  }

  static async renameColumn(root, columnId) {
    const cols = await this.readStory(root);
    const col = cols.find((c) => c.id === columnId);
    if (!col) {
      vscode.window.showWarningMessage("列が見つかりません");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "新しい列名",
      value: col.name,
    });
    if (!name) return;
    col.name = name;
    await this.writeStory(root, cols);
  }

  static async deleteColumn(root, columnId) {
    if (columnId === "tbd") {
      vscode.window.showWarningMessage("TBD 列は削除できません");
      return;
    }
    const cols = await this.readStory(root);
    if (cols.length <= 1) {
      vscode.window.showWarningMessage("列が1つのため削除できません");
      return;
    }
    const col = cols.find((c) => c.id === columnId);
    if (!col) return;
    const ok = await vscode.window.showWarningMessage(
      `列を削除しますか？\n${col.name}`,
      { modal: true },
      "削除"
    );
    if (ok !== "削除") return;
    const idx = cols.findIndex((c) => c.id === columnId);
    const moveTo = cols[idx === 0 ? 1 : idx - 1];
    moveTo.cards = [...col.cards, ...moveTo.cards];
    const next = cols.filter((c) => c.id !== columnId);
    await this.writeStory(root, next);
  }

  static async deleteColumnHard(root, columnId) {
    if (columnId === "tbd") {
      vscode.window.showWarningMessage("TBD 列は削除できません");
      return;
    }
    const cols = await this.readStory(root);
    if (cols.length <= 1) {
      vscode.window.showWarningMessage("列が1つのため削除できません");
      return;
    }
    const col = cols.find((c) => c.id === columnId);
    if (!col) return;
    const ok = await vscode.window.showWarningMessage(
      `列またはカードを削除しますか？\n${col.name}`,
      { modal: true },
      "削除"
    );
    if (ok !== "削除") return;
    // カードファイル削除
    for (const cardId of col.cards || []) {
      try {
        await vscode.workspace.fs.delete(this.cardUri(root, cardId));
      } catch {}
    }
    const next = cols.filter((c) => c.id !== columnId);
    await this.writeStory(root, next);
  }

  static async moveColumn(root, columnId, toIndex) {
    if (columnId === "tbd") return;
    const cols = await this.readStory(root);
    const idx = cols.findIndex((c) => c.id === columnId);
    if (idx < 0) return;
    const [col] = cols.splice(idx, 1);
    const target = Math.max(1, Math.min(toIndex, cols.length)); // 0 は tbd 用に予約
    cols.splice(target, 0, col);
    await this.writeStory(root, cols);
  }

  static async exportPlot(root) {
    const { columns, cards } = await this.loadBoard(root);
    const block = buildPlotMarkdown(columns, cards);
    const markerTop = "<!-- P/N:この行以下は出力時に自動上書きされます。手動編集も消えます。 -->";
    const markerBottom = "<!-- P/N:この行以上は出力時に自動上書きされます。手動編集も消えます。 -->";
    const wrapped = `${markerTop}\n${block}\n${markerBottom}`;
    const plotUri = vscode.Uri.joinPath(root, PLOT_DIR, "plot.md");
    // フォルダがなければ作成
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, PLOT_DIR));
    let existing = "";
    try {
      const buf = await vscode.workspace.fs.readFile(plotUri);
      existing = decoder.decode(buf);
    } catch {
      existing = DEFAULT_PLOT_MD;
    }
    let next;
    const first = existing.indexOf(markerTop);
    const last = existing.lastIndexOf(markerBottom);
    if (first !== -1 && last !== -1 && first < last) {
      next = existing.slice(0, first) + wrapped + existing.slice(last + markerBottom.length);
    } else if (existing.trim().length) {
      next = `${existing.trimEnd()}\n\n${wrapped}\n`;
    } else {
      next = `${wrapped}\n`;
    }
    try {
      await vscode.workspace.fs.writeFile(plotUri, encoder.encode(next));
      vscode.window.showInformationMessage("plot.md に書き出しました");
    } catch (err) {
      vscode.window.showErrorMessage(`plot.md の書き出しに失敗しました: ${err.message}`);
    }
  }
}

async function resolveRootUri() {
  // サイドバーで表示中のコンテナ直下を最優先
  try {
    const pinned = getSidebarBaseDirUri?.();
    if (pinned) return pinned;
  } catch {}

  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const uri = ed.document.uri;
    if (uri.scheme === "file") {
      const fileDir = path.dirname(uri.fsPath);
      const baseName = path.basename(fileDir);
      // もし親フォルダが plot なら一つ上（小説タイトル階層）をルートとする
      if (baseName.toLowerCase() === "plot") {
        return vscode.Uri.file(path.dirname(fileDir));
      }
      // そうでなければファイルと同じ階層をルートとし、そこに plot/ を切る
      return vscode.Uri.file(fileDir);
    }
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) return ws.uri;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  if (folders.length === 1) return folders[0].uri;
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      uri: f.uri,
    })),
    { placeHolder: "作品フォルダを選択" }
  );
  return pick?.uri ?? null;
}

function splitTags(input) {
  if (!input) return [];
  return input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function slugify(str) {
  const s = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  if (s) return s;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return "col-" + (hash >>> 0).toString(16);
}

function makeId(prefix) {
  const rand = Math.random().toString(16).slice(2, 6);
  return `${Date.now()}-${rand}`;
}

function defaultColumns() {
  return [
    { id: "tbd", name: "TBD", cards: [] },
    { id: "act1", name: "Act1", cards: [] },
    { id: "act2", name: "Act2", cards: [] },
    { id: "act3", name: "Act3", cards: [] },
    { id: "act4", name: "Act4", cards: [] },
  ];
}

function getColumnColors() {
  const cfg = vscode.workspace.getConfiguration("posNote");
  const inspect = cfg.inspect("kanbn.columnColors");
  const user =
    inspect?.workspaceFolderValue ??
    inspect?.workspaceValue ??
    inspect?.globalValue ??
    undefined;
  let colors = [];
  if (Array.isArray(user)) {
    colors = user.filter((c) => typeof c === "string" && c.trim().length);
    if (user !== undefined && colors.length) return colors.map((c) => c.trim()).slice(0, 10);
  } else if (user && typeof user === "object") {
    const rows = Object.keys(user)
      .filter((k) => /^row\d+$/i.test(k))
      .sort((a, b) => parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10));
    colors = rows
      .map((k) => user[k])
      .filter((c) => typeof c === "string" && c.trim().length);
    if (user !== undefined && colors.length) return colors.map((c) => c.trim()).slice(0, 10);
  }
  // ユーザー指定が無い場合のみデフォルトを返す
  colors = colors.map((c) => c.trim());
  if (!colors.length) return DEFAULT_PALETTE;
  return colors.slice(0, 10);
}

function getTagColorsPayload() {
  const cfg = vscode.workspace.getConfiguration("posNote");
  const inspect = cfg.inspect("kanbn.tagsColors");
  const user =
    inspect?.workspaceFolderValue ??
    inspect?.workspaceValue ??
    inspect?.globalValue ??
    undefined; // defaultValue は無視し、ユーザー指定があるか判定

  const normalizeEntries = (entries) =>
    Object.fromEntries(
      entries
        .filter(([, v]) => typeof v === "string" && v.trim().length) // none も残す
        .map(([k, v]) => [String(k), v.trim()])
    );

  if (Array.isArray(user)) {
    const entries = user.map((v, i) => [String(i + 1), v]);
    return { map: normalizeEntries(entries), userProvided: true };
  }
  if (user && typeof user === "object") {
    const norm = normalizeEntries(Object.entries(user));
    return { map: norm, userProvided: true };
  }

  const fallback = {
    "出会い": DEFAULT_TAG_PALETTE[0],
    "イベント": DEFAULT_TAG_PALETTE[1],
    "トラブル": DEFAULT_TAG_PALETTE[2],
    "解決": DEFAULT_TAG_PALETTE[3],
  };
  return { map: fallback, userProvided: false };
}

module.exports = { initKanbn };

function buildPlotMarkdown(columns, cards) {
  const lines = [];
  lines.push("## 構成", "");
  for (const col of columns) {
    if (col.id === "tbd") continue;
    lines.push(`### ${col.name}`);
    lines.push("");
    for (const id of col.cards || []) {
      const card = cards[id] || { id, title: id, description: "", characters: [], time: "", tags: [] };
      const title = card.title || id;
      lines.push(`- ${title}`);
      if (card.description) {
        lines.push("  - description:");
        lines.push(`    ${card.description}`);
      }
      const chars = Array.isArray(card.characters) ? card.characters.filter(Boolean) : [];
      if (chars.length) {
        lines.push("  - characters:");
        lines.push(`    ${chars.join(", ")}`);
      }
      if (card.time) {
        lines.push("  - time:");
        lines.push(`    ${card.time}`);
      }
      const tags = Array.isArray(card.tags) ? card.tags.filter(Boolean) : [];
      if (tags.length) {
        lines.push("  - tags:");
        lines.push(`    ${tags.join(", ")}`);
      }
      lines.push(""); // カード間1行
    }
    if (lines[lines.length - 1] !== "") lines.push(""); // 列間も1行
  }
  return lines.join("\n");
}
