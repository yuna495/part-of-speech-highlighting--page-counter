from pathlib import Path
p=Path('media/main.js')
text=p.read_text(encoding='utf-8')
start=text.find('window.addEventListener("message"')
if start==-1:
    raise SystemExit('start not found')
end=text.find('});', start)
if end==-1:
    raise SystemExit('end not found')
end=end+3
new_block = """  // VS Code からのメッセージ\n  window.addEventListener(\"message\", (event) => {\n    if (!event || !event.data) return;\n    const { type, payload, activeLine } = event.data;\n\n    try {\n      if (type === \"update\") {\n        render(payload);\n        return;\n      }\n\n      if (type === \"diffUpdate\") {\n        applyDiff(payload);\n        return;\n      }\n\n      if (type === \"highlight\") {\n        highlightActiveLine(typeof activeLine === \"number\" ? activeLine : 0);\n        const activeBg =\n          content.style.getPropertyValue(\"--active-bg\") ||\n          \"rgba(255, 215, 0, 0.2)\";\n        upsertDynamicStyle(activeBg);\n        adjustScrollToActive(typeof activeLine === \"number\" ? activeLine : 0);\n        return;\n      }\n    } catch (e) {\n      console.error(\"preview message handling failed:\", e);\n    } finally {\n      if (type === \"update\" || type === \"diffUpdate\") {\n        setRefreshing(false);\n      }\n    }\n  });\n"""
text = text[:start] + new_block + text[end:]
p.write_text(text, encoding='utf-8')
