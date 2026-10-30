import io
p = r"H:\minzzj文件\技术部\项目\官方\榫卯\public\super-v4.css"
s = io.open(p, encoding="utf-8").read()
add = r"""

/* 手机端顶栏：允许换行、收紧 chip，避免竖排挤爆 */
@media (max-width: 760px) {
  .topbar { height: auto; min-height: 54px; flex-wrap: wrap; row-gap: 4px; padding: 8px 10px; align-items: center; }
  .brand { flex: none; }
  .brand b { font-size: 15px; white-space: nowrap; }
  .brand .sub { display: none; }
  .brand .logo { width: 22px; height: 22px; font-size: 12px; }
  .chips { flex-wrap: wrap; justify-content: flex-end; row-gap: 4px; gap: 5px; }
  .chips .chip { font-size: 10.5px; padding: 3px 6px; line-height: 1.25; white-space: nowrap; }
  .chips .icon-btn { padding: 0 4px; font-size: 16px; }
  .board-tile .bt-ico { font-size: 17px; }
  .bt-body b { font-size: 13.5px; }
  .bt-sub { font-size: 10.5px; }
  .quick button { font-size: 12px; padding: 7px 11px; }
}
"""
io.open(p, "w", encoding="utf-8", newline="").write(s + add)
print("css mobile topbar appended ->", len(s+add))
