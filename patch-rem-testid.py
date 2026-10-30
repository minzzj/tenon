import io
p = r"H:\minzzj文件\技术部\项目\官方\榫卯\public\super.html"
s = io.open(p, encoding="utf-8").read()
pairs = [
 ('<div id="reminders-pending" class="list" data-testid="reminder-list"></div>', '<div id="reminders-pending" class="list" data-testid="reminders-pending"></div>'),
 ('<div id="reminders-overdue" class="list"></div>', '<div id="reminders-overdue" class="list" data-testid="reminders-overdue"></div>'),
 ('<div id="reminders-done" class="list"></div>', '<div id="reminders-done" class="list" data-testid="reminders-done"></div>'),
]
for a,b in pairs:
    assert s.count(a)==1, a[:60]
    s = s.replace(a,b)
io.open(p,"w",encoding="utf-8",newline="").write(s)
print("super.html testids patched")
