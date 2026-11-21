# 遥感地图审计 · 可疑窗口查看器

> **在线 Demo**：https://yuanzifang.github.io/remote-sensing-audit/
> 静态版只保留浏览与诊断；上传、GEE 实时拉取、实时环境需本地运行 `server.py`。

无标签条件下，从一张遥感分类预测图里挑出**最值得人工复核的窗口**，并给出可解释的原因（边界优先、低置信度），在网页上直接看。

> 不需要真值标签，也能回答：这张图哪里最可能错、先看哪几个窗口、预算内能覆盖多少风险。

## 功能

- **上传即审计**：支持 `.npy` 概率图、GeoTIFF（9 波段概率）和普通分类着色图（按 Dynamic World 调色板反推概率）
- **可疑窗口排序**：按边界与低置信度两类线索排序，输出 1% / 5% / 10% 复核集
- **可解释**：每个窗口给出触发原因与置信度，而不是只给一个分数
- **地图联动**：左侧地图 + 窗口标记，点选查看局部放大与类别构成
- **内置 Demo**：秘鲁南部瓦片（含真值），可直接对比审计效果
- **GEE 导出**：一条命令从 Google Earth Engine 拉取 Dynamic World 真实概率

## 快速开始

```bash
git clone <repo-url> && cd remote-sensing-audit

# 依赖（uv 管理，Python 3.13）
uv venv
uv pip install -r requirements.txt

# 启动本地预览（默认 8000，被占用会自动往后找）
python server.py
```

打开 <http://127.0.0.1:8000>，默认加载 Demo 数据；右上角可上传自己的概率图。

## 目录结构

```text
server.py            # 本地预览服务器（标准库），上传 + 调流水线 + 出图
index.html           # 页面结构
script.js            # 地图着色、窗口列表、局部放大、图例
style.css            # 样式
prepare_data.py      # 审计结果 -> base_map.png / data.json / meta.json
image_to_prob.py     # 分类着色图 -> 9 类概率图（按调色板距离）
gee_export.py        # Google Earth Engine -> Dynamic World 概率 GeoTIFF
inspect_outputs.py   # 审计输出排查工具
oe_inferencex_demo/  # 秘鲁瓦片 Demo（概率、真值、审计结果）
```

## 数据与口径

- 类别体系：Dynamic World 9 类（水体、树木、草地、涉水植被、作物、灌丛、建成区、裸地、冰雪）
- 概率来源分两种，页面会如实标注：
  - **真实模型输出**：上传 `.npy` / GeoTIFF，或由 `gee_export.py` 从 GEE 导出
  - **图片合成概率**：由分类着色图按调色板距离反推，仅用于演示流程，不代表模型真实置信度
- 审计算法来自 [`olmoearth-inferencex`](https://pypi.org/project/olmoearth-inferencex/)：`assess` 产出复核集、线索与操作点

## 从 GEE 拉取真实概率

```bash
.venv/bin/earthengine authenticate          # 一次性
.venv/bin/python gee_export.py \
  --lat 30.59 --lon 114.31 --date latest \
  --size-km 6 --scale 40 --project <你的 GEE 项目 ID> \
  --out uploads/gee_dw.tif

python server.py                            # 上传该 tif 即可审计
```

## 已知限制

- 图片合成的概率只保证流程可跑通，不能用于评估模型真实表现
- 上传图最长边会缩到 256，保证浏览器端渲染与审计速度
- 无真值时只输出「可疑窗口」，不输出准确率；需要准确率请使用带真值的样本与 `estimate`
