// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const content = document.getElementById("content");
  const refreshBtn = document.getElementById("refresh-btn");
  let cursorEl = null;
  let blinkTimer = null;
  let isRefreshing = false;

  const setRefreshing = (on) => {
    isRefreshing = !!on;
    if (refreshBtn) refreshBtn.classList.toggle("spinning", isRefreshing);
  };

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      setRefreshing(true);
      vscode.postMessage({ type: "requestRefresh" });
    });
  }

  // 縦ホイール → 横スクロール
  content.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) return;
      const delta = normalizeWheelDelta(e);
      content.scrollLeft +=
        Math.abs(delta.x) > Math.abs(delta.y) ? delta.x : delta.y * 0.5;
      e.preventDefault();
    },
    { passive: false }
  );

  // イベントデリゲーション: クリックでエディタへジャンプ
  // 各<p>に個別にリスナーを追加するのではなく、親要素で一括処理
  content.addEventListener("click", (e) => {
    const target = e.target.closest("p[data-line]");
    if (target) {
      const ln = Number(target.dataset.line || "0");
      vscode.postMessage({ type: "jumpToLine", line: ln });
    }
  });

  function normalizeWheelDelta(e) {
    const LINE_PIXELS = 16;
    const PAGE_PIXELS = content.clientHeight || window.innerHeight || 800;
    const f =
      e.deltaMode === 1 ? LINE_PIXELS : e.deltaMode === 2 ? PAGE_PIXELS : 1;
    return { x: e.deltaX * f, y: e.deltaY * f };
  }

  // VS Code からのメッセージ（更新）
  window.addEventListener("message", (event) => {
    if (!event || !event.data) return;
    const { type, payload, activeLine } = event.data;

    if (type === "update") {
      render(payload);
      return;
    }

    if (type === "diffUpdate") {
      applyDiff(payload);
      return;
    }

    if (type === "highlight") {
      highlightActiveLine(typeof activeLine === "number" ? activeLine : 0);
      const activeBg =
        content.style.getPropertyValue("--active-bg") ||
        "rgba(255, 215, 0, 0.2)";
      upsertDynamicStyle(activeBg);
      adjustScrollToActive(typeof activeLine === "number" ? activeLine : 0);
      return;
    }
  });

  /**
   * 描画処理
   * @param {{
   *   text:string, offset:number, cursor:string, position:string,
   *   fontsize:string, fontfamily:string, activeLine:number, showCursor:boolean
   * }} data
   */
  // === main.js の render(data) をこの全文に置き換え ===
  function render(data) {
    const {
      isHtml = false,
      text = "",
      textHtml = "",
      tokenCss = "",
      offset,
      cursor,
      position,
      fontsize,
      fontfamily,
      activeLine,
      showCursor,
      bgColor = "#111111",
      textColor = "#fafafa",
      activeBg = "rgba(255, 215, 0, 0.2)",
      rubyHtmlList = [],
      ellipsisHtmlList = [],
      dashHtmlList = [],
    } = data || {};

    applyStyles({ bgColor, textColor, activeBg, tokenCss, fontsize, fontfamily });

    if (isHtml) {
      content.innerHTML = textHtml;
    } else {
      const html = paragraphsWithLine(text, offset, cursor, showCursor);
      content.innerHTML = html;
    }

    if (
      (rubyHtmlList && rubyHtmlList.length) ||
      (ellipsisHtmlList && ellipsisHtmlList.length) ||
      (dashHtmlList && dashHtmlList.length)
    ) {
      restorePlaceholdersHtml(content, {
        RB: rubyHtmlList,
        EL: ellipsisHtmlList,
        DL: dashHtmlList,
      });
    }

    cursorEl = showCursor ? document.getElementById("cursor") : null;
    resetBlink(showCursor);

    highlightActiveLine(activeLine);
    adjustScrollToActive(activeLine);
    setRefreshing(false);
  }

  function applyDiff(payload) {
    const {
      isHtml = false,
      textHtml = "",
      tokenCss = "",
      activeLine = 0,
      showCursor = false,
      bgColor = "#111111",
      textColor = "#fafafa",
      activeBg = "rgba(255, 215, 0, 0.2)",
      fontsize,
      fontfamily,
      rubyHtmlList = [],
      ellipsisHtmlList = [],
      dashHtmlList = [],
      changes = [],
    } = payload || {};

    if (!isHtml || !Array.isArray(changes) || !changes.length) {
      render(payload);
      return;
    }

    applyStyles({ bgColor, textColor, activeBg, tokenCss, fontsize, fontfamily });

    for (const ch of changes) {
      if (!ch || typeof ch.line !== "number" || !ch.html) continue;
      const pEl = content.querySelector(`p[data-line="${ch.line}"]`);
      if (!pEl) {
        render(payload);
        return;
      }
      const tpl = document.createElement("template");
      tpl.innerHTML = ch.html.trim();
      const node = tpl.content.firstElementChild;
      if (node) pEl.replaceWith(node);
    }

    if (
      (rubyHtmlList && rubyHtmlList.length) ||
      (ellipsisHtmlList && ellipsisHtmlList.length) ||
      (dashHtmlList && dashHtmlList.length)
    ) {
      restorePlaceholdersHtml(content, {
        RB: rubyHtmlList,
        EL: ellipsisHtmlList,
        DL: dashHtmlList,
      });
    }

    cursorEl = showCursor ? document.getElementById("cursor") : null;
    resetBlink(showCursor);
    highlightActiveLine(activeLine);
    adjustScrollToActive(activeLine);
    setRefreshing(false);
  }

  function applyStyles({
    bgColor = "#111111",
    textColor = "#fafafa",
    activeBg = "rgba(255, 215, 0, 0.2)",
    tokenCss = "",
    fontsize,
    fontfamily,
  }) {
    content.style.backgroundColor = bgColor;
    content.style.color = textColor;
    content.style.setProperty("--active-bg", activeBg);
    content.style.setProperty("--font-size", fontsize || "14px");
    content.style.setProperty("--font-family", fontfamily ? `"${fontfamily}"` : "inherit");
    upsertTokenStyle(tokenCss);
    upsertDynamicStyle(activeBg);
  }

function paragraphsWithLine(text, offset, cursor, showCursor) {
    let injected = text;
    if (showCursor) {
      const safeCursor = '<span id="cursor">' + escapeHtml(cursor) + "</span>";
      const off = Math.max(0, Math.min(offset, text.length));
      injected = text.slice(0, off) + safeCursor + text.slice(off);
    }

    // ★ ここで一括変換：|基《よみ》 → <ruby>…
    injected = transformRubyNotation(injected);

    const lines = injected.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s+$/.test(line) && line !== "") {
        out.push('<p data-line="' + i + '">' + line + "</p>");
      } else {
        out.push('<p class="blank" data-line="' + i + '">_</p>');
      }
    }
    return out.join("");
  }

  function resetBlink(showCursor) {
    if (blinkTimer) {
      clearTimeout(blinkTimer);
      blinkTimer = null;
    }
    if (!showCursor || !cursorEl) return;

    let visible = true;
    const tick = () => {
      if (!cursorEl) return;
      cursorEl.style.visibility = visible ? "visible" : "hidden";
      visible = !visible;
      blinkTimer = setTimeout(tick, 500);
    };
    tick();
  }

  function highlightActiveLine(activeLine) {
    content
      .querySelectorAll("p.active")
      .forEach((el) => el.classList.remove("active"));
    const target = content.querySelector('p[data-line="' + activeLine + '"]');
    if (target) target.classList.add("active");
  }

  // エディタのアクティブ行を常に中央へ
  function adjustScrollToActive(activeLine) {
    const target = content.querySelector('p[data-line="' + activeLine + '"]');
    if (!target) return;
    // content から見た要素中心
    const targetCenter =
      target.offsetLeft + (target.offsetWidth || target.clientWidth) / 2;
    // 現在のビューポート中心
    const viewCenter = content.scrollLeft + content.clientWidth / 2;
    const delta = targetCenter - viewCenter;
    if (Math.abs(delta) > 1) {
      content.scrollLeft += delta;
    }
  }

  function upsertTokenStyle(cssText) {
    const ID = "np-token-style";
    let tag = document.getElementById(ID);
    if (!cssText) {
      // 空のときは既存タグがあれば消す（既定の style.css に戻す）
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
      return;
    }
    if (!tag) {
      tag = document.createElement("style");
      tag.id = ID;
      tag.type = "text/css";
      tag.textContent = cssText;
      document.head.appendChild(tag);
    } else {
      tag.textContent = cssText;
    }
  }

  // ドキュメント <head> に単一の style を維持して p.active の見た目を上書き
  function upsertDynamicStyle(activeBg) {
    const ID = "np-dynamic-style";
    let tag = document.getElementById(ID);
    const css = `
    /* ユーザー設定のハイライト色で背景＋アウトライン。!important で確実に上書き */
    p.active {
      background: ${activeBg} !important;
      outline: 1px solid ${activeBg} !important;
    }
  `;
    if (!tag) {
      tag = document.createElement("style");
      tag.id = ID;
      tag.type = "text/css";
      tag.textContent = css;
      document.head.appendChild(tag);
    } else {
      tag.textContent = css;
    }
  }

  /// === ルビ変換 ===
  // |基《よみ》 を <ruby><rb>基</rb><rt>よみ</rt></ruby> に変換。
  // 規則：
  //  1) 読みに "・" が含まれる → "・" 区切りで per-char
  //  2) "・" が無く、基と読みの文字数が一致 → per-char
  //  3) それ以外 → 単語ルビ
  //
  // 追加仕様：読みが「・」だけなら、基文字数ぶん「・」を配る。
  function transformRubyNotation(input) {
    if (!input || typeof input !== "string") return input;

    const RUBY_RE = /\|([^《》\|\n]+)《([^》\n]+)》/g;
    const esc = (s) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");

    return input.replace(RUBY_RE, (_, base, reading) => {
      const baseChars = [...base];

      // 追加：読みが「・」だけ
      if (reading.replace(/・/g, "") === "") {
        const out = [];
        for (let i = 0; i < baseChars.length; i++) {
          out.push(`<rb>${esc(baseChars[i])}</rb><rt>・</rt>`);
        }
        return `<ruby class="rb-group">${out.join("")}</ruby>`;
      }

      const hasSeparator = reading.includes("・");
      const readingParts = hasSeparator ? reading.split("・") : [...reading];
      const isPerChar =
        hasSeparator || readingParts.length === baseChars.length;

      if (isPerChar) {
        const out = [];
        const n = baseChars.length;
        for (let i = 0; i < n; i++) {
          const rb = esc(baseChars[i]);
          const rt = esc(readingParts[i] ?? "");
          out.push(`<rb>${rb}</rb><rt>${rt}</rt>`);
        }
        return `<ruby class="rb-group">${out.join("")}</ruby>`;
      } else {
        return `<ruby><rb>${esc(base)}</rb><rt>${esc(reading)}</rt></ruby>`;
      }
    });
  }

  // === 占位文字 → <ruby> 復元 ===
  const PH_RE = /\uE000RB(\d+)\uE001/; // 占位に埋めたインデックスを回収

  function htmlToNode(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstChild;
  }

  // === 占位 → HTML 復元（タグを跨いでも最短一致で置換） ===
  // プレースホルダ書式：  RB0 / EL3 など（OPEN=U+E000, CLOSE=U+E001）
  function restorePlaceholdersHtml(root, lists) {
    if (!root || !lists) return;

    const OPEN = "\uE000"; // ''
    const CLOSE = "\uE001"; // ''
    // kind = RB or EL、index = 数字。間に任意のタグを挟んでもOK
    const PH_HTML_RE = new RegExp(
      OPEN +
        "(?:<[^>]*>|[^<])*?(RB|EL|DL)(?:<[^>]*>|[^<])*?(\\d+)(?:<[^>]*>|[^<])*?" +
        CLOSE,
      "g"
    );

    const paras = root.querySelectorAll("p");
    paras.forEach((p) => {
      let html = p.innerHTML;
      html = html.replace(PH_HTML_RE, (_whole, kind, idxStr) => {
        const idx = Number(idxStr);
        const list = lists[kind] || [];
        const repl = list[idx];
        return repl ? repl : "";
      });
      p.innerHTML = html;
    });
  }

  function escapeHtml(s) {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
})();
