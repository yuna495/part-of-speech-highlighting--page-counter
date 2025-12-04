const vscode = require("vscode");
const path = require("path");

const PLOT_DIR = "plot";
const STORY_FILE = "story.md";
const CARD_DIR = "card";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const DEFAULT_PALETTE = ["#00aa55", "#ffcc00", "#ff4444", "#3388ff"];

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
        default:
          break;
      }
    });
  }

  async refresh() {
    const data = await BoardStore.loadBoard(this.rootUri);
    this.panel.webview.postMessage({ type: "data", ...data });
    this.panel.title = `プロットボード - ${path.basename(this.rootUri.fsPath)}`;
  }

  html() {
    const paletteLiteral = JSON.stringify(getColumnColors());
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; padding:12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#111; color:#eee; }
    .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
    button { background:#2d7dff; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
    button.sub { background:#444; }
    .board { display:flex; gap:12px; align-items:flex-start; overflow-x:auto; }
    .column { width:260px; border-radius:10px; padding:10px; box-shadow:0 2px 6px #0006; }
    .column header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .column-title { font-weight:700; }
    .cards { display:flex; flex-direction:column; gap:8px; min-height:24px; }
    .card { padding:10px; background:#222; border:1px solid #333; border-radius:8px; cursor:grab; }
    .card.dragging { opacity:0.6; }
    .tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .tag { background:#333; padding:2px 6px; border-radius:999px; font-size:11px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="add-column">列を追加</button>
    <button id="refresh" class="sub">再読み込み</button>
  </div>
  <div id="board" class="board"></div>
  <script>
    const vscode = acquireVsCodeApi();
    let state = { columns: [], cards: {} };

    const boardEl = document.getElementById("board");
    document.getElementById("add-column").onclick = () => vscode.postMessage({ type: "addColumn" });
    document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "ready" });

    boardEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/column")) return;
      e.preventDefault();
    });
    boardEl.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes("text/column")) return;
      e.preventDefault();
      const columnId = e.dataTransfer.getData("text/column");
      if (!columnId) return;
      const idx = dropColumnIndex(boardEl, e.clientX);
      vscode.postMessage({ type: "moveColumn", columnId, toIndex: idx });
    });

    window.addEventListener("message", (ev) => {
      const msg = ev.data;
      if (msg.type === "data") {
        state = { columns: msg.columns, cards: msg.cards };
        render();
      }
    });

    const palette = ${paletteLiteral};

    function render() {
      boardEl.innerHTML = "";
      state.columns.forEach((col, idx) => {
        const colEl = document.createElement("div");
        colEl.className = "column";
        colEl.dataset.id = col.id;
        colEl.style.background = palette[idx % palette.length];

        const header = document.createElement("header");
        const title = document.createElement("div");
        title.className = "column-title";
        title.textContent = col.name;
        header.appendChild(title);

        const btns = document.createElement("div");
        btns.innerHTML =
          '<button class="sub" data-act="add-card">＋</button>' +
          '<button class="sub" data-act="rename-col">名</button>' +
          '<button class="sub" data-act="delete-col">削</button>';
        header.appendChild(btns);
        colEl.appendChild(header);

        // 列ドラッグはヘッダーのみをハンドルにする
        header.draggable = true;
        header.addEventListener("dragstart", (e) => {
          colEl.classList.add("dragging");
          e.dataTransfer.setData("text/column", col.id);
          e.dataTransfer.effectAllowed = "move";
        });
        header.addEventListener("dragend", () => colEl.classList.remove("dragging"));

        const cardsEl = document.createElement("div");
        cardsEl.className = "cards";
        cardsEl.dataset.columnId = col.id;
        cardsEl.addEventListener("dragover", (e) => e.preventDefault());
        cardsEl.addEventListener("drop", (e) => {
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
          el.innerHTML =
            '<div class="card-title">' + (card.title || id) + "</div>" +
            (card.tags && card.tags.length
              ? '<div class="tags">' + card.tags.map((t) => '<span class="tag">' + t + "</span>").join("") + "</div>"
              : "");
          el.addEventListener("dragstart", (e) => {
            el.classList.add("dragging");
            e.dataTransfer.setData("text/plain", id);
            e.dataTransfer.effectAllowed = "move";
          });
          el.addEventListener("dragend", () => el.classList.remove("dragging"));
          el.addEventListener("dblclick", () => vscode.postMessage({ type: "openCard", cardId: id }));
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            quickCardMenu(id);
          });
          cardsEl.appendChild(el);
        });

        colEl.appendChild(cardsEl);
        boardEl.appendChild(colEl);

        btns.querySelector('[data-act="add-card"]').onclick = () =>
          vscode.postMessage({ type: "addCard", columnId: col.id });
        btns.querySelector('[data-act="rename-col"]').onclick = () =>
          vscode.postMessage({ type: "renameColumn", columnId: col.id });
        btns.querySelector('[data-act="delete-col"]').onclick = () =>
          vscode.postMessage({ type: "deleteColumn", columnId: col.id });
      });
    }

    function dropIndex(container, y) {
      const cards = Array.from(container.querySelectorAll(".card"));
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return cards.length;
    }

    function dropColumnIndex(container, x) {
      const cols = Array.from(container.querySelectorAll(".column"));
      for (let i = 0; i < cols.length; i++) {
        const r = cols[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return i;
      }
      return cols.length;
    }

    function quickCardMenu(cardId) {
      const pick = confirm("削除しますか？") ? "delete" : "open";
      if (pick === "delete") vscode.postMessage({ type: "deleteCard", cardId });
      else vscode.postMessage({ type: "openCard", cardId });
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
          current = { id: slugify(name), name, cards: [] };
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
    const payload = {
      ...card,
      created: card.created || new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    await vscode.workspace.fs.writeFile(
      uri,
      encoder.encode(JSON.stringify(payload, null, 2))
    );
    return payload;
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
      tags: splitTags(tagsInput),
    };
    await this.writeCard(root, card);
    const cols = await this.readStory(root);
    const col = cols.find((c) => c.id === columnId) || cols[0];
    col.cards.unshift(card.id);
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
  }

  static async openCard(root, cardId) {
    const card = (await this.readCard(root, cardId)) || {
      id: cardId,
      title: cardId,
      description: "",
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
      placeHolder: "例) アイデア",
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

  static async moveColumn(root, columnId, toIndex) {
    const cols = await this.readStory(root);
    const idx = cols.findIndex((c) => c.id === columnId);
    if (idx < 0) return;
    const [col] = cols.splice(idx, 1);
    const target = Math.max(0, Math.min(toIndex, cols.length));
    cols.splice(target, 0, col);
    await this.writeStory(root, cols);
  }
}

async function resolveRootUri() {
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const uri = ed.document.uri;
    if (uri.scheme === "file") {
      const dir = path.dirname(uri.fsPath);
      return vscode.Uri.file(dir);
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
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || `col-${Date.now()}`
  );
}

function makeId(prefix) {
  const rand = Math.random().toString(16).slice(2, 6);
  return `${prefix}-${Date.now()}-${rand}`;
}

function defaultColumns() {
  return [
    { id: "act1", name: "Act1", cards: [] },
    { id: "act2", name: "Act2", cards: [] },
    { id: "act3", name: "Act3", cards: [] },
    { id: "act4", name: "Act4", cards: [] },
  ];
}

function getColumnColors() {
  const cfg = vscode.workspace.getConfiguration("posNote");
  const user = cfg.get("kanbn.columnColors");
  let colors = [];
  if (Array.isArray(user)) {
    colors = user.filter((c) => typeof c === "string" && c.trim().length);
  } else if (user && typeof user === "object") {
    const rows = Object.keys(user)
      .filter((k) => /^row\d+$/i.test(k))
      .sort((a, b) => parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10));
    colors = rows
      .map((k) => user[k])
      .filter((c) => typeof c === "string" && c.trim().length);
  }
  colors = colors.map((c) => c.trim());
  if (!colors.length) return DEFAULT_PALETTE;
  return colors.slice(0, 10);
}

module.exports = { initKanbn };
