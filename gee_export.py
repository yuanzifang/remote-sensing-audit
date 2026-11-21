"""从 Google Earth Engine 导出 Dynamic World 9 类概率为 GeoTIFF。

前置 (一次性, 需能访问 Google 的网络; 有本地代理可先 export HTTPS_PROXY):
  .venv/bin/earthengine authenticate          # 浏览器登录
  # 或服务账号: 设置 EE_SERVICE_ACCOUNT 私钥路径 + EE_PROJECT

用法:
  .venv/bin/python gee_export.py --lat 30.59 --lon 114.31 --date latest \
      --size-km 6 --scale 40 --project 你的GEE项目ID --out uploads/gee_dw.tif

输出 GeoTIFF (9 波段概率, EPSG:4326), 直接可被看板上传/审计流水线消费。
"""

import argparse
import io
import os
import sys
import tempfile
import urllib.request
import zipfile

import ee


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--date", default="latest",
                    help="'latest' 取最近一景, 或 YYYY-MM-DD 取当日/之前最近")
    ap.add_argument("--size-km", type=float, default=6.0, help="正方形边长 (公里)")
    ap.add_argument("--scale", type=float, default=40, help="输出分辨率 (米/像素)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--project", default=os.environ.get("EE_PROJECT", ""))
    args = ap.parse_args()

    try:
        ee.Initialize(project=args.project) if args.project else ee.Initialize()
    except Exception as e:
        sys.exit(f"[认证失败] 请先在有 Google 访问的网络运行: .venv/bin/earthengine authenticate\n"
                 f"本机有代理时先 export HTTPS_PROXY=http://127.0.0.1:<端口> 再试。\n详情: {e}")

    half = args.size_km * 1000 / 2
    d_lat = half / 111320
    d_lon = half / (111320 * __import__("math").cos(__import__("math").radians(args.lat)))
    rect = ee.Geometry.Rectangle([args.lon - d_lon, args.lat - d_lat,
                                  args.lon + d_lon, args.lat + d_lat])

    if args.date == "latest":
        end = ee.Date(datetime.date.today().isoformat())
        start = end.advance(-90, "day")  # 近 90 天内最近一景
    else:
        end = ee.Date(args.date).advance(1, "day")
        start = ee.Date(args.date).advance(-30, "day")  # 当日无景则回看 30 天

    col = (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
           .filterBounds(rect).filterDate(start, end))
    img = ee.Image(col.sort("system:time_start", False).first())
    acquired = ee.Date(img.get("system:time_start")).format("YYYY-MM-dd").getInfo()

    # 稳健地选全部 9 个概率波段 (无论命名是 probability_* 还是类别名)
    prob_names = img.bandNames().filter(ee.Filter.stringContains("probability"))
    probs = img.select(prob_names).clip(rect)
    n = prob_names.size().getInfo()
    if n != 9:
        sys.exit(f"[数据异常] 概率波段数 {n} != 9")

    url = probs.getDownloadURL({
        "scale": args.scale,
        "region": rect,
        "crs": "EPSG:4326",
        "format": "ZIPPED_GEO_TIFF",
    })
    with urllib.request.urlopen(urllib.request.Request(url), timeout=120) as r:
        data = r.read()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        tif = next(n for n in z.namelist() if n.lower().endswith((".tif", ".tiff")))
        with open(args.out, "wb") as f:
            f.write(z.read(tif))
    print(f"OK: {args.out} | Dynamic World 影像日期 {acquired} | {args.size_km}km @ {args.scale}m")


if __name__ == "__main__":
    main()
