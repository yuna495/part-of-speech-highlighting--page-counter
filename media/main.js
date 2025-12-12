// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const content = document.getElementById("content");
  const refreshBtn = document.getElementById("refresh-btn");
  let cursorEl = null;
  let blinkTimer = null;
  let isRefreshing = false;
  let lastActiveLine = 0;

  const setRefreshing = (on) => {
    isRefreshing = !!on;
    if (refreshBtn) refreshBtn.classList.toggle("spinning", isRefreshing);
  };

  // 初回ウォームアップ中はスピナーを回しておく
  setRefreshing(true);

  if (refreshBtn) {
    // クリックが下のコンテンツに届いて jumpToLine しないように完全に止める
    ["mousedown", "mouseup", "click"].forEach((ev) => {
      refreshBtn.addEventListener(ev, (e) => {
        e.stopPropagation();
        if (ev !== "click") {
          e.preventDefault();
          return;
        }
        setRefreshing(true);
        vscode.postMessage({ type: "requestRefresh" });
      });
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
    // VS Code からのメッセージ
  window.addEventListener("message", (event) => {
    if (!event || !event.data) return;
    const { type, payload, activeLine } = event.data;

    try {
      if (type === "update") {
        render(payload);
        return;
      }

      if (type === "diffUpdate") {
        applyDiff(payload);
        return;
      }

      if (type === "setRefreshing") {
        const spinning = payload && payload.spinning;
        setRefreshing(!!spinning);
        return;
      }

      if (type === "highlight") {
        const line =
          typeof activeLine === "number"
            ? activeLine
            : Number.isFinite(lastActiveLine)
            ? lastActiveLine
            : 0;
        if (typeof activeLine === "number") lastActiveLine = activeLine;
        highlightActiveLine(line);
        const activeBg =
          content.style.getPropertyValue("--active-bg") ||
          "rgba(255, 215, 0, 0.2)";
        upsertDynamicStyle(activeBg);
        adjustScrollToActive(line);
        return;
      }
    } catch (e) {
      console.error("preview message handling failed:", e);
    } finally {
      if (type === "update" || type === "diffUpdate") {
        setRefreshing(false);
      }
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
      posModeOn = true,
      rubyHtmlList = [],
      ellipsisHtmlList = [],
      dashHtmlList = [],
    } = data || {};

    const hasLine = Number.isFinite(activeLine);
    if (hasLine) lastActiveLine = activeLine;
    const targetLine =
      hasLine || Number.isFinite(lastActiveLine)
        ? hasLine
          ? activeLine
          : lastActiveLine
        : 0;

    applyStyles({
      bgColor,
      textColor,
      activeBg,
      tokenCss,
      fontsize,
      fontfamily,
      posModeOn,
    });

    if (isHtml) {
      renderHtmlWithReuse(textHtml || "");
    } else {
      const html = paragraphsWithLine(text, offset, cursor, showCursor);
      renderHtmlWithReuse(html);
    }

    // プレースホルダはリストが空でも強制クリーンアップ
    restorePlaceholdersHtml(content, {
      RB: rubyHtmlList || [],
      EL: ellipsisHtmlList || [],
      DL: dashHtmlList || [],
    });

    cursorEl = showCursor ? document.getElementById("cursor") : null;
    resetBlink(showCursor);

    highlightActiveLine(targetLine);
    adjustScrollToActive(targetLine);
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
      posModeOn = true,
      rubyHtmlList = [],
      ellipsisHtmlList = [],
      dashHtmlList = [],
      changes = [],
    } = payload || {};

    if (!isHtml || !Array.isArray(changes) || !changes.length) {
      render(payload);
      return;
    }

    const hasLine = Number.isFinite(activeLine);
    if (hasLine) lastActiveLine = activeLine;
    const targetLine =
      hasLine || Number.isFinite(lastActiveLine)
        ? hasLine
          ? activeLine
          : lastActiveLine
        : 0;

    applyStyles({
      bgColor,
      textColor,
      activeBg,
      tokenCss,
      fontsize,
      fontfamily,
      posModeOn,
    });

    const updated = new Set();
    for (const ch of changes) {
      if (!ch || typeof ch.line !== "number" || !ch.html) continue;
      const tpl = document.createElement("template");
      tpl.innerHTML = (ch.html || "")
        ;
      const node = tpl.content.firstElementChild;
      if (!node) continue;
      const line = ch.line;
      updated.add(line);
      const pEl = pCache.get(line) || content.querySelector(`p[data-line="${line}"]`);
      if (pEl) {
        pEl.replaceWith(node);
      } else {
        content.appendChild(node);
      }
      pCache.set(line, node);
    }

    restorePlaceholdersHtml(content, {
      RB: rubyHtmlList || [],
      EL: ellipsisHtmlList || [],
      DL: dashHtmlList || [],
    });

    cursorEl = showCursor ? document.getElementById("cursor") : null;
    resetBlink(showCursor);
    highlightActiveLine(targetLine);
    adjustScrollToActive(targetLine);
    setRefreshing(false);
  }

  function applyStyles({
    bgColor = "#050505",
    textColor = "#fafafa",
    activeBg = "rgba(255, 215, 0, 0.2)",
    tokenCss = "",
    fontsize,
    fontfamily,
    posModeOn = true,
  }) {
    content.style.backgroundColor = bgColor;
    content.style.color = textColor;
    content.style.setProperty("--active-bg", activeBg);
    content.style.setProperty("--font-size", fontsize || "14px");
    content.style.setProperty("--font-family", fontfamily ? `"${fontfamily}"` : "inherit");
    if (document && document.body) {
      document.body.setAttribute("data-pos-mode", posModeOn ? "on" : "off");
    }
    upsertTokenStyle(tokenCss);
    upsertDynamicStyle(activeBg);
  }

  // プレースホルダ(RB/EL/DL)を安全に除去・展開する
  function cleansePlaceholders(html, lists = {}) {
    if (!html) return html;
    const rep = (kind, val) => {
      const re = new RegExp(`\\uE000${kind}(\\d+)\\uE001`, "g");
      html = html.replace(re, (_, idx) => {
        if (Array.isArray(val)) return val[Number(idx)] || "";
        if (typeof val === "string") return val;
        return "";
      });
    };
    rep("RB", lists.RB || "");
    rep("EL", lists.EL || "");
    rep("DL", lists.DL || "——");
    return html.replace(/\uE000RB\d+\uE001/g, "").replace(/\uE000DL\d+\uE001/g, "——");
  }

  // HTML文字列をパースしつつ、既存の <p data-line> を再利用して差し替える
  function renderHtmlWithReuse(html) {
    // まずは確実に表示を復旧させるため、単純代入に戻す
    content.innerHTML = html || "";
    pCache.clear();
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
    // requestAnimationFrame を使用して、DOM が完全にレンダリングされてからスクロール
    requestAnimationFrame(() => {
      const target =
        content.querySelector('p[data-line="' + activeLine + '"]') ||
        content.querySelector('p[data-line="' + lastActiveLine + '"]') ||
        content.querySelector("p:last-of-type");
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
    });
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
      // 変更がある場合のみ書き換えてスタイル再計算を抑制
      if (tag.textContent !== css) {
        tag.textContent = css;
      }
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
