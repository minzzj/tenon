import io
p = r"H:\minzzj文件\技术部\项目\官方\榫卯\public\super-v4.css"
s = io.open(p, encoding="utf-8").read()
old = ".toast{background:rgba(16,28,44,.96);border:1px solid rgba(120,180,255,.25);color:#eaf6ff;font-size:13px;padding:9px 14px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:auto}"
new = ".toast{background:rgba(16,28,44,.96);border:1px solid rgba(120,180,255,.25);color:#eaf6ff;font-size:13px;padding:9px 14px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none}"
assert s.count(old) == 1, "toast css anchor"
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new))
print("toast pointer-events fixed")
