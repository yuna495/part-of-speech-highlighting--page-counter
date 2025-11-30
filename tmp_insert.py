from pathlib import Path
p=Path("media/main.js")
t=p.read_text(encoding='utf-8')
ins = "    if (type === \"setRefreshing\") {\n      setRefreshing(!!(payload and payload.get('spinning')));\n      return;\n    }\n\n"
marker = "    if (type === \"highlight\") {\n"
if ins in t:
    print('already inserted')
else:
    t = t.replace(marker, ins + marker, 1)
    p.write_text(t, encoding='utf-8')
