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
    } = data || {};

    // 背景・色・CSS変数
    content.style.backgroundColor = bgColor;
    content.style.color = textColor;
    content.style.setProperty("--active-bg", activeBg);

    // 受け取ったトークンCSSを <head> に適用（エディタ設定の色で上書き）
    upsertTokenStyle(tokenCss);

    // 本文：isHtml のときは拡張側で完成させた <p data-line> をそのまま適用
    if (isHtml) {
      content.innerHTML = textHtml;
    } else {
      // 旧来：プレーンテキストから <p data-line> を生成
      const html = paragraphsWithLine(text, offset, cursor, showCursor);
      content.innerHTML = html;
    }

    // ★ 追加：占位文字 → <ruby> に復元（品詞タグを残したまま置換）
    if (Array.isArray(rubyHtmlList) && rubyHtmlList.length) {
      restoreRubyPlaceholdersHtml(content, rubyHtmlList);
    }

    // p にフォント反映
    content.querySelectorAll("p").forEach((p) => {
      p.style.fontSize = fontsize || "14px";
      p.style.fontFamily = fontfamily ? `"${fontfamily}"` : "";
    });

    // クリックでエディタへジャンプ（data-line 依存）
    content.querySelectorAll("p").forEach((p) => {
      p.addEventListener("click", () => {
        const ln = Number(p.dataset.line || "0");
        vscode.postMessage({ type: "jumpToLine", line: ln });
      });
    });

    // カーソル要素（必要なら）を再取得
    cursorEl = showCursor ? document.getElementById("cursor") : null;
    resetBlink(showCursor);

    // ハイライト & 中央寄せ & 動的スタイル
    highlightActiveLine(activeLine);
    adjustScrollToActive(activeLine);
    upsertDynamicStyle(activeBg);
  }

  /** data-line を付与した <p> 羅列を作る。showCursor=false のときは cursor 挿入しない */
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

  // content 以下の**テキストノード**を探索し、占位だけのノードを <ruby> に置換。
  // 占位が <span class="pos-..."> の中にあっても、親 <span> ごと置換して安全に復元する。
  // === 占位 → <ruby> 復元（HTML 版：タグをまたいでも最短一致で置換） ===
  // プレースホルダ： U+E000 ''  …  U+E001 ''
  // 例）<span></span><span>RB</span><span>12</span><span></span> も一発でマッチさせる
  function restoreRubyPlaceholdersHtml(root, rubyHtmlList) {
    if (!root || !rubyHtmlList || !rubyHtmlList.length) return;

    // 開始 '' と終了 '' のあいだに、任意のタグ/テキストが挟まっても OK
    // 最短一致のため *? を使用。RB(\d+) もタグを跨ぐ可能性があるので、いったん
    // タグを含むパターンで拾ってからインデックスを抽出します。
    const OPEN = "\uE000"; // ''
    const CLOSE = "\uE001"; // ''
    // 例： … RB 123 …    （…の中に <span ...>..</span> 可）
    const PH_HTML_RE = new RegExp(
      OPEN +
        "(?:<[^>]*>|[^<])*?RB(?:<[^>]*>|[^<])*?(\\d+)(?:<[^>]*>|[^<])*?" +
        CLOSE,
      "g"
    );

    // p 要素ごとに置換（段落を跨いだ誤置換を避ける）
    const paras = root.querySelectorAll("p");
    paras.forEach((p) => {
      let html = p.innerHTML;
      // マッチ毎に、キャプチャしたインデックスで rubyHtml を差し込む
      html = html.replace(PH_HTML_RE, (_whole, idxStr) => {
        const idx = Number(idxStr);
        const ruby = rubyHtmlList[idx];
        return ruby ? ruby : ""; // 見つからなければ消す（露出防止）
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
