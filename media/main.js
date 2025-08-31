// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const content = document.getElementById("content");
  let cursorEl = null;
  let blinkTimer = null;

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
      // 全面再描画（本文・スタイル・初回のアクティブ行）
      render(payload);
      return;
    }

    if (type === "highlight") {
      // 軽量：行番号だけでハイライト（本文は作り直さない）
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
  function render(data) {
    content.style.backgroundColor = data.bgColor || "#111111";
    content.style.color = data.textColor || "#fafafa";
    content.style.setProperty(
      "--active-bg",
      data.activeBg || "rgba(255, 215, 0, 0.2)"
    );
    const {
      text,
      offset,
      cursor,
      position,
      fontsize,
      fontfamily,
      activeLine,
      showCursor,
    } = data;

    // 段落化（data-line を付与）＋ カーソルは必要なときだけ注入
    const html = paragraphsWithLine(text, offset, cursor, showCursor);
    content.innerHTML = html;

    // フォント反映
    content.querySelectorAll("p").forEach((p) => {
      p.style.fontSize = fontsize || "14px";
      p.style.fontFamily = fontfamily ? `"${fontfamily}"` : "";
    });

    // クリックでエディタへジャンプ
    content.querySelectorAll("p").forEach((p) => {
      p.addEventListener("click", () => {
        const ln = Number(p.dataset.line || "0");
        vscode.postMessage({ type: "jumpToLine", line: ln });
      });
    });

    // カーソル取得（非表示設定なら null のまま）
    cursorEl = showCursor ? document.getElementById("cursor") : null;

    // カーソル点滅（非表示時はスキップ）
    resetBlink(showCursor);

    // エディタのカーソル行をハイライト＆中央表示
    highlightActiveLine(activeLine);
    adjustScrollToActive(activeLine);
    upsertDynamicStyle(data.activeBg || "rgba(255, 215, 0, 0.2)");
  }

  /** data-line を付与した <p> 羅列を作る。showCursor=false のときは cursor 挿入しない */
  function paragraphsWithLine(text, offset, cursor, showCursor) {
    let injected = text;
    if (showCursor) {
      const safeCursor = '<span id="cursor">' + escapeHtml(cursor) + "</span>";
      const off = Math.max(0, Math.min(offset, text.length));
      injected = text.slice(0, off) + safeCursor + text.slice(off);
    }

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

  function escapeHtml(s) {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
})();
