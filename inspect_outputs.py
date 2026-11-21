"""快速查看 assess 输出：review_set_05pct.csv 的前 3 行 + explanation.json 的主要内容"""

import csv
import json

AUDIT = "oe_inferencex_demo/audit"

# --- review_set_05pct.csv：按优先级排序的人工复查清单 ---
with open(f"{AUDIT}/review_set_05pct.csv", newline="") as f:
    rows = list(csv.DictReader(f))

print(f"review_set_05pct.csv  共 {len(rows)} 行\n")
print(f"{'rank':>4}  {'win_row':>7}  {'win_col':>7}  {'conf':>8}  {'boundary':>8}")
for r in rows[:3]:
    print(f"{r['rank']:>4}  {r['window_row']:>7}  {r['window_col']:>7}  "
          f"{float(r['confidence']):>8.4f}  {float(r['boundary']):>8.1f}")

# --- explanation.json：每个复查窗口为什么被标记 ---
e = json.load(open(f"{AUDIT}/explanation.json"))

print("\nexplanation.json  顶层键:", list(e))
b = e["budgets"]["0.05"]  # 与 5% 复查预算对应的那部分
print(f"\nbudgets['0.05'] 共标记 {b['n_windows']} 个窗口，前 3 个:")
for w in b["windows"][:3]:
    print(json.dumps(w, ensure_ascii=False))
