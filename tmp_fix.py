from pathlib import Path

p = Path("media/main.js")
text = p.read_text(encoding="utf-8")

start = text.find('window.addEventListener("message"')
if start == -1:
    raise SystemExit("start not found")

end = text.find("});", start)
if end == -1:
    raise SystemExit("end not found")
end += 3

new_block = """  // VS Code message handler
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
"""

text = text[:start] + new_block + text[end:]
p.write_text(text, encoding="utf-8")
