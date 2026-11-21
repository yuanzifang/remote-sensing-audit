"""本地预览服务器 (含地图图片上传)。

用法:  python3 server.py [端口]   (默认 8000, 被占用时自动向后找)
仅标准库; 处理流水线通过 .venv 里的 Python/工具执行。启动后自动打开浏览器。
"""

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

VENV_PY = os.path.join(ROOT, ".venv", "bin", "python")
OE_ASSESS = os.path.join(ROOT, ".venv", "bin", "oe-inferencex")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


def run_pipeline(path, subtitle_override=None):
    """真实概率文件(.npy/.tif) 直传审计; 普通图片则按调色板合成概率。返回 (ok, 日志)。"""
    audit = os.path.join(ROOT, "uploads", "audit")
    shutil.rmtree(audit, ignore_errors=True)
    os.makedirs("uploads", exist_ok=True)

    if os.path.splitext(path)[1].lower() in (".npy", ".tif", ".tiff"):
        prob, subtitle, geo = path, \
            subtitle_override or "当前位置: 上传地图 · 真实模型输出（无真值对照）", "auto"
        steps = [
            [OE_ASSESS, "assess", prob, "--patch", "1", "--out", audit],
        ]
    else:
        prob = os.path.join(ROOT, "uploads", "prob.npy")
        subtitle, geo = "当前位置: 上传地图图片 · 概率由图片颜色合成（非模型真实输出）", "none"
        steps = [
            [VENV_PY, "image_to_prob.py", path, prob],
            [OE_ASSESS, "assess", prob, "--patch", "1", "--out", audit],
        ]

    steps.append([VENV_PY, "prepare_data.py", "--prob", prob, "--truth", "none",
                  "--audit-dir", audit, "--out-dir", ".",
                  "--geo", geo, "--subtitle", subtitle])

    log = []
    for cmd in steps:
        p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
        log.append(f"$ {' '.join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))}"
                   f"\n{p.stdout}{p.stderr}".strip())
        if p.returncode != 0:
            return False, "\n\n".join(log)
    return True, "\n\n".join(log)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 刷新即拿最新页面
        super().end_headers()

    def _json(self, code, obj):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode())

    # ---------- /correct: 人在回路修正, 追加写入 user_corrections.csv ----------
    def _correct(self, p):
        import csv as _csv
        import datetime
        path = os.path.join(ROOT, "user_corrections.csv")
        is_new = not os.path.exists(path)
        env = p.get("env") or {}
        row = [
            datetime.datetime.now().isoformat(timespec="seconds"),
            p.get("rank"), p.get("row"), p.get("col"),
            p.get("confidence"), p.get("pred_class"), p.get("true_class"),
            p.get("verdict"), p.get("corrected_class"),
            env.get("temp_c", ""), env.get("moisture_pct", ""), env.get("date", ""),
        ]
        try:
            with open(path, "a", newline="", encoding="utf-8") as f:
                w = _csv.writer(f)
                if is_new:
                    w.writerow(["timestamp", "rank", "row", "col", "confidence",
                                "pred_class", "true_class", "verdict", "corrected_class",
                                "env_temp_c", "env_moisture_pct", "env_date"])
                w.writerow(row)
        except Exception as e:
            self._json(200, {"ok": False, "error": f"写入失败: {e}"})
            return
        with open(path, encoding="utf-8") as f:
            total = sum(1 for _ in f) - 1
        self._json(200, {"ok": True, "total": total})

    # ---------- /env: NASA POWER 点位环境数据代理 ----------
    ENV_CACHE = {}  # (lat, lon) -> (时间戳, 结果), 10 分钟缓存

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/env":
            q = parse_qs(parsed.query)
            try:
                lat, lon = float(q["lat"][0]), float(q["lon"][0])
            except (KeyError, ValueError):
                self._json(400, {"ok": False, "error": "需要 lat/lon 参数"})
                return
            self._env(lat, lon)
            return
        if parsed.path == "/geocode":
            q = parse_qs(parsed.query).get("q", [""])[0].strip()
            if not q:
                self._json(400, {"ok": False, "error": "需要 q 参数"})
                return
            self._geocode(q)
            return
        if parsed.path == "/corrections":
            self._corrections()
            return
        super().do_GET()

    # ---------- /corrections: 读取人工修正记录 ----------
    def _corrections(self):
        import csv as _csv
        path = os.path.join(ROOT, "user_corrections.csv")
        rows = []
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                rows = list(_csv.DictReader(f))
        rows.reverse()  # 最近在前
        self._json(200, {"ok": True, "total": len(rows), "rows": rows[:50]})

    # ---------- /geocode: 城市/国家名 -> 经纬度 (内置国家表 + Photon) ----------
    # Photon 对中文国家名支持差(搜"秘鲁"只回领事馆), 常用国家内置兜底; zoom 4 = 国家级视野
    COUNTRIES = {
        "中国": (35.0, 103.0), "china": (35.0, 103.0),
        "美国": (39.8, -98.6), "united states": (39.8, -98.6), "usa": (39.8, -98.6),
        "加拿大": (56.1, -106.3), "canada": (56.1, -106.3),
        "墨西哥": (23.6, -102.5), "mexico": (23.6, -102.5),
        "巴西": (-14.2, -51.9), "brazil": (-14.2, -51.9),
        "阿根廷": (-38.4, -63.6), "argentina": (-38.4, -63.6),
        "智利": (-35.7, -71.5), "chile": (-35.7, -71.5),
        "秘鲁": (-9.2, -75.0), "peru": (-9.2, -75.0),
        "玻利维亚": (-16.3, -63.6), "bolivia": (-16.3, -63.6),
        "哥伦比亚": (4.6, -74.3), "colombia": (4.6, -74.3),
        "委内瑞拉": (6.4, -66.6), "venezuela": (6.4, -66.6),
        "英国": (54.0, -2.5), "united kingdom": (54.0, -2.5), "uk": (54.0, -2.5),
        "法国": (46.6, 2.2), "france": (46.6, 2.2),
        "德国": (51.2, 10.4), "germany": (51.2, 10.4),
        "意大利": (41.9, 12.6), "italy": (41.9, 12.6),
        "西班牙": (40.5, -3.7), "spain": (40.5, -3.7),
        "葡萄牙": (39.4, -8.2), "portugal": (39.4, -8.2),
        "荷兰": (52.1, 5.3), "netherlands": (52.1, 5.3),
        "瑞士": (46.8, 8.2), "switzerland": (46.8, 8.2),
        "瑞典": (60.1, 18.6), "sweden": (60.1, 18.6),
        "挪威": (60.5, 8.5), "norway": (60.5, 8.5),
        "芬兰": (61.9, 25.7), "finland": (61.9, 25.7),
        "波兰": (51.9, 19.1), "poland": (51.9, 19.1),
        "俄罗斯": (61.5, 90.0), "russia": (61.5, 90.0),
        "乌克兰": (48.4, 31.2), "ukraine": (48.4, 31.2),
        "土耳其": (39.0, 35.2), "turkey": (39.0, 35.2),
        "希腊": (39.1, 21.8), "greece": (39.1, 21.8),
        "埃及": (26.8, 30.8), "egypt": (26.8, 30.8),
        "南非": (-30.6, 22.9), "south africa": (-30.6, 22.9),
        "尼日利亚": (9.1, 8.7), "nigeria": (9.1, 8.7),
        "肯尼亚": (-0.02, 37.9), "kenya": (-0.02, 37.9),
        "埃塞俄比亚": (9.1, 40.5), "ethiopia": (9.1, 40.5),
        "摩洛哥": (31.8, -7.1), "morocco": (31.8, -7.1),
        "沙特阿拉伯": (23.9, 45.1), "saudi arabia": (23.9, 45.1),
        "伊朗": (32.4, 53.7), "iran": (32.4, 53.7),
        "伊拉克": (33.2, 43.7), "iraq": (33.2, 43.7),
        "以色列": (31.0, 34.9), "israel": (31.0, 34.9),
        "印度": (20.6, 79.0), "india": (20.6, 79.0),
        "巴基斯坦": (30.4, 69.3), "pakistan": (30.4, 69.3),
        "孟加拉国": (23.7, 90.4), "bangladesh": (23.7, 90.4),
        "斯里兰卡": (7.9, 80.8), "sri lanka": (7.9, 80.8),
        "泰国": (15.9, 101.0), "thailand": (15.9, 101.0),
        "越南": (14.1, 108.3), "vietnam": (14.1, 108.3),
        "缅甸": (21.9, 95.9), "myanmar": (21.9, 95.9),
        "马来西亚": (4.2, 102.0), "malaysia": (4.2, 102.0),
        "新加坡": (1.35, 103.8), "singapore": (1.35, 103.8),
        "印度尼西亚": (-2.5, 118.0), "indonesia": (-2.5, 118.0),
        "菲律宾": (12.9, 121.8), "philippines": (12.9, 121.8),
        "日本": (36.5, 138.2), "japan": (36.5, 138.2),
        "韩国": (36.5, 127.9), "south korea": (36.5, 127.9), "korea": (36.5, 127.9),
        "朝鲜": (40.3, 127.5), "north korea": (40.3, 127.5),
        "蒙古": (46.9, 103.8), "mongolia": (46.9, 103.8),
        "澳大利亚": (-25.3, 133.8), "australia": (-25.3, 133.8),
        "新西兰": (-41.5, 172.8), "new zealand": (-41.5, 172.8),
    }

    ZOOM_BY_TYPE = {
        "country": 5, "state": 6, "region": 6, "county": 8, "district": 9,
        "city": 10, "town": 12, "village": 13, "municipality": 10,
        "suburb": 13, "neighbourhood": 14, "house": 16,
    }

    def _geocode(self, query):
        import urllib.parse
        import urllib.request

        def get(url, timeout=8):
            req = urllib.request.Request(
                url, headers={"User-Agent": "rsa-dashboard/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)

        def zoom_for(t):
            return Handler.ZOOM_BY_TYPE.get(t, 10)

        results = []
        country = Handler.COUNTRIES.get(query.strip().lower())
        if country:
            lat, lon = country
            results.append({
                "name": query.strip(), "ctx": "国家", "lat": lat, "lon": lon,
                "type": "country", "zoom": 4,
            })
        try:
            # 注意: Photon 只接受 q= 参数 (query= 会 400)
            data = get("https://photon.komoot.io/api/?limit=5&q=" + urllib.parse.quote(query))
            for f in data.get("features", [])[:5]:
                p = f.get("properties", {})
                lon, lat = f["geometry"]["coordinates"][:2]
                ctx = " · ".join(x for x in (p.get("state"), p.get("country")) if x)
                results.append({
                    "name": p.get("name", query),
                    "ctx": ctx,
                    "lat": lat, "lon": lon,
                    "type": p.get("osm_value") or p.get("type") or "",
                    "zoom": zoom_for(p.get("osm_value") or ""),
                })
        except Exception:
            pass

        if not results:  # Photon 失败或无结果 -> Nominatim 兜底
            try:
                data = get("https://nominatim.openstreetmap.org/search?format=json&limit=5&q="
                           + urllib.parse.quote(query))
                for it in data[:5]:
                    results.append({
                        "name": it["display_name"].split(",")[0],
                        "ctx": ", ".join(it["display_name"].split(",")[1:4]).strip(),
                        "lat": float(it["lat"]), "lon": float(it["lon"]),
                        "type": it.get("type", ""),
                        "zoom": zoom_for(it.get("type", "")),
                    })
            except Exception as e:
                self._json(200, {"ok": False, "error": f"地理编码失败: {e}"})
                return

        self._json(200, {"ok": bool(results), "results": results,
                         "error": None if results else "未找到该地点"})

    def _env(self, lat, lon):
        import datetime
        import urllib.request

        key = (round(lat, 3), round(lon, 3))
        now = datetime.datetime.now().timestamp()
        hit = Handler.ENV_CACHE.get(key)
        if hit and now - hit[0] < 600:
            self._json(200, hit[1])
            return

        end = datetime.date.today()
        start = end - datetime.timedelta(days=8)  # 多取几天, 容忍滞后
        url = ("https://power.larc.nasa.gov/api/temporal/daily/point"
               f"?parameters=TS,GWETTOP&community=re"
               f"&latitude={lat:.4f}&longitude={lon:.4f}"
               f"&start={start:%Y%m%d}&end={end:%Y%m%d}&format=JSON")
        req = urllib.request.Request(url, headers={"User-Agent": "rsa-dashboard/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.load(r)["properties"]["parameter"]
        except Exception as e:
            self._json(200, {"ok": False, "error": f"NASA POWER 请求失败: {e}"})
            return

        days = []
        for d in sorted(data.get("TS", {})):
            t, m = data["TS"][d], data.get("GWETTOP", {}).get(d, -999)
            if t is None or t <= -900 or m is None or m <= -900:
                continue  # -999 = 填充值
            days.append({
                "date": f"{d[4:6]}-{d[6:8]}",
                "temp_c": round(t - 273.15, 1) if t > 150 else round(float(t), 1),
                "moisture_pct": round(float(m) * 100),
            })
        result = {
            "ok": bool(days),
            "lat": lat, "lon": lon,
            "days": days[-3:],  # 最近 3 个有效日
            "latest": days[-1]["date"] if days else None,
            "source": "NASA POWER · MERRA-2 再分析 (滞后数日)",
            "error": None if days else "近期无有效数据 (海洋/极夜或服务滞后)",
        }
        Handler.ENV_CACHE[key] = (now, result)
        self._json(200, result)

    def do_POST(self):
        if self.path.startswith("/correct"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                self._json(400, {"ok": False, "error": "JSON 解析失败"})
                return
            self._correct(payload)
            return
        if self.path.startswith("/gee"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except Exception:
                self._json(400, {"ok": False, "error": "JSON 解析失败"})
                return
            self._gee(payload)
            return
        if not self.path.startswith("/upload"):
            self.send_error(404)
            return

    # ---------- /gee: 从 Google Earth Engine 拉取 Dynamic World 真实概率 ----------
    def _gee(self, p):
        try:
            lat, lon = float(p["lat"]), float(p["lon"])
        except (KeyError, TypeError, ValueError):
            self._json(200, {"ok": False, "error": "需要 lat/lon"})
            return
        date = str(p.get("date") or "latest")[:10] or "latest"
        size = min(20.0, max(1.0, float(p.get("size_km") or 6)))
        tif = os.path.join(ROOT, "uploads", "gee_dw.tif")
        os.makedirs("uploads", exist_ok=True)
        cmd = [VENV_PY, "gee_export.py", "--lat", str(lat), "--lon", str(lon),
               "--date", date, "--size-km", str(size), "--out", tif]
        proj = os.environ.get("EE_PROJECT", "")
        if proj:
            cmd += ["--project", proj]
        exp = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, timeout=300)
        log = (exp.stdout + exp.stderr).strip()
        if exp.returncode != 0:
            self._json(200, {"ok": False, "error": "GEE 拉取失败 (见下方日志)",
                             "log": log[-1200:]})
            return
        ok, pipe_log = run_pipeline(
            tif, subtitle_override=f"当前位置: GEE Dynamic World 真实概率 · {date} 附近景")  # .tif 走真实概率审计流水线
        self._json(200, {"ok": ok,
                         "error": None if ok else "审计流水线失败",
                         "log": (log + "\n\n" + pipe_log)[-1200:]});
        name = parse_qs(urlparse(self.path).query).get("name", ["map.png"])[0]
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:80] or "map.png"
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 200 * 1024 * 1024:
            self.send_error(400, "bad upload")
            return
        body = self.rfile.read(length)
        os.makedirs("uploads", exist_ok=True)
        img_path = os.path.join(ROOT, "uploads", safe)
        with open(img_path, "wb") as f:
            f.write(body)

        ok, log = run_pipeline(img_path)
        payload = {"ok": ok, "file": safe, "log": log[-1500:]}
        if not ok:
            payload["error"] = "处理失败: 概率文件应是 (9,H,W) 或 (H,W) 的 .npy/GeoTIFF; 图片应是分类着色图"

        self.send_response(200 if ok else 500)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode())


Handler.extensions_map.update({".js": "application/javascript"})

server = None
for port in range(PORT, PORT + 10):
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        break
    except OSError:
        continue

if server is None:
    sys.exit(f"端口 {PORT}-{PORT + 9} 均被占用, 请指定其他端口")

url = f"http://127.0.0.1:{port}/"
print(f"正在服务: {url}  (Ctrl+C 退出)")
threading.Timer(0.5, lambda: webbrowser.open(url)).start()

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\n已停止")
