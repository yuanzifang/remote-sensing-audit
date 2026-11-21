"""为网页展示准备数据：可疑窗口清单 + 底图 PNG + meta。

默认(无参数) = demo 模式: 用 oe_inferencex_demo 的秘鲁瓦片。
参数化模式 = 上传地图: 由 server.py 调用, 指定概率图/审计输出/无真值/无地理位置。

输出: base_map.png, data.json {"pred_map","grid_h","grid_w","windows"}, meta.json
"""

import argparse
import csv
import json
import struct
import zlib

import numpy as np

DEMO = "oe_inferencex_demo"

# Dynamic World 9 类标准调色板 (RGB)，与 review_set.png 底图一致
DW_PALETTE = [
    (65, 155, 223),   # 0 water
    (57, 125, 73),    # 1 trees
    (136, 176, 83),   # 2 grass
    (122, 135, 198),  # 3 flooded_vegetation
    (228, 150, 53),   # 4 crops
    (223, 195, 90),   # 5 shrub_and_scrub
    (196, 40, 27),    # 6 built
    (165, 155, 143),  # 7 bare
    (179, 159, 225),  # 8 snow_and_ice
]
NODATA_RGB = (255, 255, 255)  # 无效像素涂白


def load_scores(prob_path):
    """读入分数图: .npy 或 GeoTIFF。返回 (数组, 地理中心或 None)。"""
    if prob_path.endswith(".npy"):
        return np.load(prob_path).astype(np.float32), None
    import rasterio
    with rasterio.open(prob_path) as src:
        arr = src.read().astype(np.float32)
        if src.nodata is not None:
            arr[arr == src.nodata] = np.nan
        geo = None
        if src.crs and src.crs.to_epsg() == 4326:
            b = src.bounds
            geo = ((b.top + b.bottom) / 2, (b.left + b.right) / 2)
    if arr.ndim == 2:  # (H, W) 二值概率 -> 两通道
        arr = np.stack([1 - arr, arr])
    return arr, geo


def load_pred_truth(prob_path, truth_path):
    """读入概率与真值(可选)，算 pred；NaN 像素单独标记。"""
    prob, _ = load_scores(prob_path)                          # (C, H, W)
    valid = ~np.isnan(prob).any(axis=0)
    pred = np.where(valid, np.nan_to_num(prob, nan=-1.0).argmax(axis=0), -1)
    if truth_path == "none":
        truth, annotated = None, np.zeros(pred.shape, bool)
    else:
        truth = np.load(truth_path)
        annotated = valid & (truth != -1)                # 有专家标注的窗口
    return pred, truth, annotated


def write_png(path, rgb):
    """无第三方依赖的 PNG 写出 (RGB, 8bit)。rgb: (H, W, 3) uint8"""
    h, w = rgb.shape[:2]
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))  # 每行加 filter=0

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def render_base_map(pred):
    """按类别调色板把预测图渲染成 RGB。"""
    rgb = np.full(pred.shape + (3,), NODATA_RGB, dtype=np.uint8)
    for cls, color in enumerate(DW_PALETTE):
        rgb[pred == cls] = color
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prob", default=f"{DEMO}/sample_probabilities.npy")
    ap.add_argument("--truth", default=f"{DEMO}/sample_truth.npy",
                    help="'none' 表示没有参考真值(上传模式)")
    ap.add_argument("--audit-dir", default=f"{DEMO}/audit")
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--geo", default="-16.4,-71.8",
                    help="'lat,lon' 全球视图标记位置; 'auto' 取 GeoTIFF 自带的地理参考; 'none' 无地理位置")
    ap.add_argument("--subtitle", default="当前位置: 秘鲁南部 · 诊断瓦片")
    args = ap.parse_args()

    pred, truth, annotated = load_pred_truth(args.prob, args.truth)
    write_png(f"{args.out_dir}/base_map.png", render_base_map(pred))

    with open(f"{args.audit_dir}/review_set_05pct.csv", newline="") as f:
        rows = [r for r in csv.DictReader(f) if int(r["rank"]) <= 100]

    # 每个窗口被标记的线索 (boundary / low_confidence), 来自 explanation.json
    try:
        exp = json.load(open(f"{args.audit_dir}/explanation.json"))
        cue_map = {(w["row"], w["col"]): w["cues"]
                   for w in exp["budgets"]["0.05"]["windows"]}
    except (FileNotFoundError, KeyError):
        cue_map = {}

    prob_arr = np.load(args.prob) if args.prob.endswith(".npy") else load_scores(args.prob)[0]
    windows = []
    for r in rows:
        pr, pc = int(r["pixel_row"]), int(r["pixel_col"])
        p = int(pred[pr, pc])
        t = int(truth[pr, pc]) if truth is not None else -1
        windows.append({
            "rank": int(r["rank"]),
            "row": pr,
            "col": pc,
            "confidence": float(r["confidence"]),
            "pred_class": p,
            "true_class": t,
            # 无真值时一律 null: 图片合成的地图没有对错可言
            "is_error": bool(p != t) if annotated[pr, pc] else None,
            "cues": cue_map.get((pr, pc), []),
            # 9 类概率分布 (供前端 OOD/风险等级计算)
            "probs": [round(float(v), 4) for v in prob_arr[:, pr, pc]],
        })

    # 全图逐像素类别, 每字符一个像素: '0'-'8' 为类别, 'x' 为无效
    pred_map = "".join("x" if v < 0 else str(v) for v in pred.flatten())
    assert len(pred_map) == pred.size

    with open(f"{args.out_dir}/data.json", "w") as f:
        json.dump({
            "pred_map": pred_map,
            "grid_h": int(pred.shape[0]),
            "grid_w": int(pred.shape[1]),
            "windows": windows,
        }, f, indent=1)

    if args.geo == "auto":
        _, raster_geo = load_scores(args.prob)
        if raster_geo:
            lat, lon = raster_geo
            meta = {"has_geo": True, "lat": round(lat, 4), "lon": round(lon, 4),
                    "subtitle": args.subtitle}
        else:
            meta = {"has_geo": False, "subtitle": args.subtitle}
    elif "," in args.geo:
        lat, lon = (float(v) for v in args.geo.split(","))
        meta = {"has_geo": True, "lat": lat, "lon": lon, "subtitle": args.subtitle}
    else:
        meta = {"has_geo": False, "subtitle": args.subtitle}
    with open(f"{args.out_dir}/meta.json", "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    n_ann = sum(w["is_error"] is not None for w in windows)
    n_err = sum(w["is_error"] is True for w in windows)
    n_cue = sum(bool(w["cues"]) for w in windows)
    err_rate = f"{n_err / n_ann:.0%}" if n_ann else "无参考真值"
    print(f"data.json: {len(windows)} 个窗口 ({err_rate} 错误), "
          f"{n_cue} 个带诊断线索; 网格 {pred.shape[0]}x{pred.shape[1]}; "
          f"geo={'%.1f,%.1f' % (meta['lat'], meta['lon']) if meta['has_geo'] else '无'}")


if __name__ == "__main__":
    main()
