// Dynamic World 9 类: 名称 + base_map.png 同款调色板
const CLASSES = [
  { name: "水体", color: "#419bdf" },
  { name: "树木", color: "#397d49" },
  { name: "草地", color: "#88b053" },
  { name: "涉水植被", color: "#7a87c6" },
  { name: "作物", color: "#e49635" },
  { name: "灌丛", color: "#dfc35a" },
  { name: "建成区", color: "#c4281b" },
  { name: "裸地", color: "#a59b8f" },
  { name: "冰雪", color: "#b39fe1" },
];

const DEFAULT_META = {
  has_geo: true,
  lat: -16.4,
  lon: -71.8,
  subtitle: "当前位置: 秘鲁南部 · 诊断瓦片",
};

const TOP_N = 10;   // "置信度前十"按钮保留的点数
const ZOOM_R = 7;   // 局部放大半径: (2*7+1) = 15x15

const CUE_LABELS = { boundary: "边界", low_confidence: "低置信度" };
const CUE_TIPS = {
  boundary: "boundary：窗口位于模型预测的两个类别交界处",
  low_confidence: "low_confidence：窗口属于模型最没把握的一批",
};

const markersEl = document.getElementById("markers");
const mapWrapEl = document.getElementById("mapWrap");
const hintCardEl = document.getElementById("hintCard");
const detailCardEl = document.getElementById("detailCard");
const top10BtnEl = document.getElementById("top10Btn");
const zoomCanvas = document.getElementById("zoomCanvas");
const zoomEmptyEl = document.getElementById("zoomEmpty");
const zoomNoteEl = document.getElementById("zoomNote");
const mapLegendEl = document.getElementById("mapLegend");
const uploadBtnEl = document.getElementById("uploadBtn");
const fileInputEl = document.getElementById("fileInput");
const backBtnEl = document.getElementById("backBtn");

let predMap = null;   // 全图逐像素类别字符串, fetch 后填充
let allPoints = [];   // 全部窗口, 供取消选中时恢复汇总统计
let gridH = 128;      // 网格尺寸, 由 data.json 覆盖
let gridW = 128;
let META = { ...DEFAULT_META };
let top10Only = false;
let selectedDot = null;

function classChip(cls) {
  const c = CLASSES[cls];
  return c
    ? `<span class="chip" style="background:${c.color}"></span>${cls} · ${c.name}`
    : `${cls} · 未知`;
}

/* ---------- 红点尺寸跟随底图缩放 ---------- */
// 格子显示尺寸 = 图宽/网格宽, 点径取格子的 0.9 倍并夹在 [4px, 14px]
function sizeDots() {
  const cell = markersEl.clientWidth / gridW;
  const px = Math.min(14, Math.max(4, cell * 0.9));
  markersEl.style.setProperty("--dot", `${px.toFixed(1)}px`);
}
new ResizeObserver(sizeDots).observe(mapWrapEl);
window.addEventListener("resize", sizeDots);

/* ---------- 局部放大 (canvas, 纯前端裁剪) ---------- */
function drawZoom(p) {
  const r0 = Math.max(0, p.row - ZOOM_R), r1 = Math.min(gridH, p.row + ZOOM_R + 1);
  const c0 = Math.max(0, p.col - ZOOM_R), c1 = Math.min(gridW, p.col + ZOOM_R + 1);
  const cell = 10;
  const dpr = window.devicePixelRatio || 1;
  const w = (c1 - c0) * cell, h = (r1 - r0) * cell;

  zoomCanvas.width = Math.round(w * dpr);
  zoomCanvas.height = Math.round(h * dpr);
  zoomCanvas.style.width = `${w}px`;
  zoomCanvas.style.height = `${h}px`;

  const ctx = zoomCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const ch = predMap[r * gridW + c];
      ctx.fillStyle = ch === "x" ? "#e2e8f0" : CLASSES[+ch].color;
      ctx.fillRect((c - c0) * cell, (r - r0) * cell, cell, cell);
    }
  }
  // 中心(选中窗口)描红框
  ctx.strokeStyle = "#f87171";
  ctx.lineWidth = 2;
  ctx.strokeRect((p.col - c0) * cell + 1, (p.row - r0) * cell + 1, cell - 2, cell - 2);

  zoomCanvas.hidden = false;
  zoomEmptyEl.hidden = true;
  zoomNoteEl.textContent = `中心 (row ${p.row}, col ${p.col}) · 红框为选中窗口 · ${p.pred_class} · ${CLASSES[p.pred_class].name}`;
}

function resetZoom() {
  zoomCanvas.hidden = true;
  zoomEmptyEl.hidden = false;
  zoomNoteEl.textContent = "";
}

/* ---------- 详情卡片 ---------- */
function clearSelection() {
  if (selectedDot) selectedDot.classList.remove("selected");
  selectedDot = null;
  detailCardEl.classList.add("hidden");
  detailCardEl.innerHTML = "";
  hintCardEl.classList.remove("hidden");
  resetZoom();
  renderStats(); // 恢复汇总统计
}

function selectPoint(p, dot) {
  if (selectedDot) selectedDot.classList.remove("selected");
  selectedDot = dot;
  dot.classList.add("selected");

  let trueValue;
  if (p.is_error === null) {
    trueValue = `<span class="value nolabel">${p.true_class} · 无参考</span>
                 <span class="badge nolabel">无真值对照</span>`;
  } else {
    trueValue = `<span class="value ${p.is_error ? "wrong" : ""}">${classChip(p.true_class)}</span>
                 ${p.is_error ? '<span class="badge error">预测错误</span>' : ""}`;
  }

  const cuesHtml = (p.cues || []).length
    ? p.cues.map((q) =>
        `<span class="cue" title="${CUE_TIPS[q] || q}">${CUE_LABELS[q] || q}</span>`).join("")
    : `<span class="value nolabel">—</span>`;

  // 窗口的真实经纬度 (有地理参考时)
  const geoField = META.has_geo
    ? (() => {
        const [lat, lon] = windowToLatLng(p);
        return `<div class="field"><span class="label">地理位置</span>
          <span class="value">${fmtLatLng(lat, lon)}</span></div>`;
      })()
    : "";

  const risk = riskOf(p);

  hintCardEl.classList.add("hidden");
  detailCardEl.classList.remove("hidden");
  detailCardEl.innerHTML = `
    <div class="rank-line"><h2>#${p.rank}</h2><small>最可疑排名${isOod(p) ? " · OOD" : ""}</small></div>
    <div class="field"><span class="label">窗口坐标</span>
      <span class="value">(row ${p.row}, col ${p.col})</span></div>
    ${geoField}
    <div class="field"><span class="label">模型预测</span>
      <span class="value">${classChip(p.pred_class)}</span></div>
    <div class="field"><span class="label">真实标注</span>${trueValue}</div>
    <div class="field"><span class="label">模型置信度</span>
      <span class="value">${(p.confidence * 100).toFixed(1)}%</span></div>
    <div class="field"><span class="label">预估风险等级</span>
      <span class="value"><span class="risk-chip ${risk.cls}">${risk.level}</span></span></div>
    <div class="field"><span class="label">诊断线索</span>
      <span class="value">${cuesHtml}</span></div>
    <p class="alert-hint" style="margin-top:10px">${risk.note}</p>
    <div class="fb-row">
      <button class="fb-btn ok" id="fbOk">✅ 模型正确</button>
      <button class="fb-btn err" id="fbErr">❌ 确认为错误</button>
    </div>
    <div id="fbExtra"></div>`;
  wireFeedback(p);

  drawZoom(p);
  renderPointStats(p);
  if (META.has_geo) {
    const [lat, lon] = windowToLatLng(p);
    fetchEnv(lat, lon, `瓦片窗口 #${p.rank}`);
    updateGlobeInfo(`瓦片窗口 #${p.rank}`, lat, lon);
  }
}

/* ---------- 前 10 过滤 ---------- */
top10BtnEl.addEventListener("click", () => {
  top10Only = !top10Only;
  markersEl.classList.toggle("show-top10", top10Only);
  top10BtnEl.classList.toggle("active", top10Only);
  top10BtnEl.textContent = top10Only ? "显示全部窗口" : "显示置信度前十";
  renderLegend(); // 图例计数跟随当前显示的点
  // 若当前选中的点被过滤掉, 回到提示态
  if (top10Only && selectedDot && !selectedDot.classList.contains("top10")) {
    clearSelection();
  }
});

/* ---------- 上传地图图片 ---------- */
uploadBtnEl.addEventListener("click", () => fileInputEl.click());
fileInputEl.addEventListener("change", async () => {
  const f = fileInputEl.files[0];
  if (!f) return;
  uploadBtnEl.disabled = true;
  uploadBtnEl.textContent = "识别中…（转概率 → 审计 → 生成）";
  try {
    const res = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, {
      method: "POST",
      body: f,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "处理失败");
    location.reload();
  } catch (e) {
    uploadBtnEl.disabled = false;
    uploadBtnEl.textContent = `上传失败: ${e.message}`;
    console.error(e);
  }
});

/* ---------- 统计条 + 侧边栏图例 + 地图悬浮图例 ---------- */
function renderStats() {
  const points = allPoints;
  const annotated = points.filter((p) => p.is_error !== null);
  if (!annotated.length) {
    // 上传模式: 没有参考真值, 无法判定对错
    document.getElementById("stats").innerHTML = `
      <div class="stat"><div class="num cyan">${points.length}</div><div class="lbl">可疑窗口</div></div>
      <div class="stat"><div class="num">—</div><div class="lbl">预测错误</div></div>
      <div class="stat"><div class="num">—</div><div class="lbl">无真值</div></div>`;
    return;
  }
  const errors = annotated.filter((p) => p.is_error).length;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="num cyan">${points.length}</div><div class="lbl">可疑窗口</div></div>
    <div class="stat"><div class="num red">${errors}</div><div class="lbl">预测错误</div></div>
    <div class="stat"><div class="num">${Math.round(100 * errors / annotated.length)}%</div><div class="lbl">点开即错</div></div>`;
}

/* 选中某个点后, 统计条切换为该点的关键信息 */
function renderPointStats(p) {
  const status = p.is_error === null
    ? { text: "无真值", cls: "" }
    : p.is_error
      ? { text: "错误", cls: "red" }
      : { text: "正确", cls: "green" };
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="num cyan">#${p.rank}</div><div class="lbl">当前排名</div></div>
    <div class="stat"><div class="num">${(p.confidence * 100).toFixed(1)}%</div><div class="lbl">模型置信度</div></div>
    <div class="stat"><div class="num ${status.cls}">${status.text}</div><div class="lbl">当前状态</div></div>`;
}

function renderLegend() {
  // 主体: 整图的类别构成 (逐像素统计 pred_map, 与底图画面严格一致)
  if (!predMap) return;
  const counts = {};
  let total = 0;
  for (const ch of predMap) {
    if (ch === "x") continue;
    counts[ch] = (counts[ch] || 0) + 1;
    total += 1;
  }
  // 辅助: 当前显示的疑点窗口计数 (跟随前十过滤)
  const pts = top10Only ? allPoints.filter((p) => p.rank <= TOP_N) : allPoints;
  const flagCounts = {};
  pts.forEach((p) => (flagCounts[p.pred_class] = (flagCounts[p.pred_class] || 0) + 1));

  const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  document.querySelector("#legendList").innerHTML = order.map((i) => {
    const c = CLASSES[+i];
    return `<li><span class="chip" style="background:${c.color}"></span>
      <span class="name">${i} · ${c.name}</span>
      <span class="count">整图 ${Math.round(100 * counts[i] / total)}% · 疑点 ${flagCounts[i] || 0}</span></li>`;
  }).join("");
  document.getElementById("legendTitle").innerHTML =
    `预测类别图例 <span class="lg-total">整图构成 · 疑点 ${pts.length} 个</span>`;
}

function renderMapLegend() {
  mapLegendEl.querySelector("ul").innerHTML = CLASSES
    .map((c, i) => `<li><span class="chip" style="background:${c.color}"></span>${i} · ${c.name}</li>`)
    .join("");
}

/* ---------- 全球地图上下文 (Leaflet) ---------- */
let globeMap = null;

function showDiag() {
  document.getElementById("globeView").classList.add("hidden");
  document.getElementById("diagView").classList.remove("hidden");
  sizeDots(); // 诊断视图重新可见后按实际宽度重算红点尺寸
}

function showGlobe() {
  if (!META.has_geo) return; // 上传地图没有地理位置, 无处可回
  document.getElementById("diagView").classList.add("hidden");
  document.getElementById("globeView").classList.remove("hidden");
  if (globeMap) globeMap.invalidateSize();
}

function enterDiag() {
  if (globeMap) {
    const halfM = (gridW * 40) / 2;
    const b = tileBounds(halfM);
    globeMap.flyToBounds(b, { maxZoom: 15, duration: 0.8 });
    setTimeout(showDiag, 850);
  } else {
    showDiag();
  }
}

function tileBounds(halfM) {
  const halfLat = halfM / 111320;
  const halfLon = halfM / (111320 * Math.cos(META.lat * Math.PI / 180));
  return [
    [META.lat - halfLat, META.lon - halfLon],
    [META.lat + halfLat, META.lon + halfLon],
  ];
}

function initGlobe() {
  if (typeof L === "undefined" || window.__leafletFailed) {
    console.warn("Leaflet 未加载, 跳过全球地图上下文");
    showDiag();
    return;
  }
  globeMap = L.map("leafletMap", { zoomControl: false })
    .setView([META.lat, META.lon], 5);
  // 恢复上次的地图视角
  const savedView = pref.get("globeView", null);
  if (savedView && savedView.lat !== undefined) {
    globeMap.setView([savedView.lat, savedView.lng], savedView.z);
  }
  globeMap.on("moveend", () => {
    const c = globeMap.getCenter();
    pref.set("globeView", { lat: c.lat, lng: c.lng, z: globeMap.getZoom() });
  });
  L.control.zoom({ position: "topright" }).addTo(globeMap);

  // Esri World Imagery: 免费卫星影像, 无需 key
  L.tileLayer(ESRI_URL, {
    maxZoom: 18,
    attribution: "&copy; Esri, Maxar, Earthstar Geographics",
  }).addTo(globeMap);

  // 国界 + 国家/城市名参考层 (卫星影像不带地名, 默认开启)
  const globeRefLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, attribution: "&copy; Esri" },
  ).addTo(globeMap);

  const bounds = tileBounds((gridW * 40) / 2);

  // 预测图叠加到真实地理位置
  L.imageOverlay("base_map.png", bounds, { opacity: 0.95, interactive: true })
    .addTo(globeMap)
    .on("click", enterDiag);

  // 描边矩形: 放大后显示瓦片边界
  globeRect = L.rectangle(bounds, { color: "#38bdf8", weight: 2, dashArray: "6 4", fill: false })
    .addTo(globeMap)
    .on("click", enterDiag);

  // 脉冲定位标记: 保证任何缩放级别都可见可点击
  globePin = L.marker([META.lat, META.lon], {
    icon: L.divIcon({
      className: "tile-pin",
      html: '<div class="halo"></div><div class="core"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  }).addTo(globeMap);
  globePin.bindTooltip("预测瓦片 · 点击进入诊断", {
    permanent: true,
    direction: "right",
    className: "tile-label",
    offset: [12, 0],
  });
  globePin.on("click", enterDiag);

  // 点击全球地图任意位置 -> 查询该点 NASA 环境数据, 更新位置卡
  globeMap.on("click", (e) => {
    if (drawMode) { addDrawVertex(e.latlng); return; } // 绘制模式下加顶点, 不查环境
    const { lat, lng } = e.latlng;
    updateGlobeInfo("地图选点", lat, lng);
    if (envMarker) globeMap.removeLayer(envMarker);
    envMarker = L.circleMarker([lat, lng], {
      radius: 6, color: "#fbbf24", weight: 2, fillOpacity: 0.4,
    }).addTo(globeMap);
    fetchEnv(lat, lng, "地图选点");
  });

  // 叠加图层: 每个按钮独立开关 (地名国界默认开, 地表温度默认关)
  const glStatusEl = document.getElementById("glStatus");
  let lstLayer = null;
  let lstDate = new Date().toISOString().slice(0, 10);
  const makeLstLayer = (date, triesLeft) => {
    const layer = L.tileLayer(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
      "MODIS_Terra_Land_Surface_Temp_Day" +
      `/default/${date}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`,
      { opacity: 0.65, maxZoom: 18, maxNativeZoom: 7,
        attribution: "NASA GIBS · MODIS Terra 地表温度" },
    );
    let errors = 0, loaded = 0;
    layer.on("tileload", () => {
      loaded += 1;
      glStatusEl.textContent = `地表温度 · ${date} · 蓝=冷 红=暖`;
    });
    layer.on("tileerror", () => {
      errors += 1;
      if (loaded > 0 || errors < 3 || triesLeft <= 0) return;
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      lstDate = d.toISOString().slice(0, 10);
      glStatusEl.textContent = `${date} 无数据, 回退 ${lstDate}…`;
      globeMap.removeLayer(layer);
      lstLayer = makeLstLayer(lstDate, triesLeft - 1);
      lstLayer.addTo(globeMap);
    });
    return layer;
  };
      document.querySelectorAll(".gl-btn[data-layer]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.layer;
          if (kind === "ref") {
            const on = btn.classList.toggle("active");
            pref.set("layerRef", on);
            if (on) globeRefLayer.addTo(globeMap);
            else globeMap.removeLayer(globeRefLayer);
            return;
          }
          // kind === "lst"
          const on = btn.classList.toggle("active");
          pref.set("layerLst", on);
          if (!on) {
            if (lstLayer) {
              globeMap.removeLayer(lstLayer);
              lstLayer = null;
            }
            glStatusEl.textContent = "";
            return;
          }
          lstLayer = makeLstLayer(lstDate, 3);
          lstLayer.addTo(globeMap);
          glStatusEl.textContent = `地表温度 · ${lstDate} · 加载中…`;
        });
      });

      // ✏️ 区域圈定与变化预警 (模拟演示)
      drawAoiBtnEl.addEventListener("click", () => (drawMode ? finishDraw() : startDraw()));
      analyzeBtnEl.addEventListener("click", runAnalysis);
      clearAoiBtnEl.addEventListener("click", clearAoi);
      globeMap.on("dblclick", finishDraw);

      // 恢复上次的图层开关状态
      if (pref.get("layerRef", true) === false) {
        document.querySelector('.gl-btn[data-layer="ref"]').click();
      }
      if (pref.get("layerLst", false) === true) {
        document.querySelector('.gl-btn[data-layer="lst"]').click();
      }
}

backBtnEl.addEventListener("click", showGlobe);

/* ---------- 双击切换真实卫星影像 (Esri 存档 / NASA 当日) ---------- */
const ESRI_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const GIBS_URL = (date) =>
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
  "MODIS_Terra_CorrectedReflectance_TrueColor" +
  `/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

const satOverlayEl = document.getElementById("satOverlay");
const satStatusEl = document.getElementById("satStatus");
const gibsDateEl = document.getElementById("gibsDate");
let satMap = null;
let satVisible = false;
let satTileLayer = null;
let satSource = "esri";
let satDate = new Date().toISOString().slice(0, 10); // UTC 今天
gibsDateEl.value = satDate;
const satRefLayer = (typeof L !== "undefined")
  ? L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "&copy; Esri" },
    )
  : null;

function gibsLayer(date) {
  const layer = L.tileLayer(GIBS_URL(date), {
    maxZoom: 19,
    maxNativeZoom: 9, // GIBS MODIS 最高 9 级 (250m), 更高缩放由浏览器放大
    attribution: "NASA GIBS · MODIS Terra 每日真彩",
  });
  let errors = 0, loaded = 0, tried = 0;
  layer.on("tileload", () => {
    loaded += 1;
    if (loaded >= 1) satStatusEl.textContent = `MODIS Terra · ${date} · 250 m`;
  });
  // 当日该区域无影像时自动回退前一天 (最多 7 天)
  layer.on("tileerror", () => {
    errors += 1;
    if (loaded > 0 || errors < 3 || tried >= 7 || satSource !== "modis") return;
    tried += 1;
    errors = 0;
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    satDate = d.toISOString().slice(0, 10);
    gibsDateEl.value = satDate;
    satStatusEl.textContent = `${date} 该区域无影像, 回退 ${satDate}…`;
    if (satTileLayer === layer) {
      satMap.removeLayer(layer);
      satTileLayer = gibsLayer(satDate);
      satTileLayer.addTo(satMap);
    }
  });
  return layer;
}

function buildSatLayer() {
  if (satTileLayer) {
    satMap.removeLayer(satTileLayer);
    satTileLayer = null;
  }
  // 地名国界参考层始终叠在影像上, 便于识别位置
  if (satRefLayer && !satMap.hasLayer(satRefLayer)) satRefLayer.addTo(satMap);
  if (satSource === "esri") {
    gibsDateEl.disabled = true;
    satStatusEl.textContent = "";
    satTileLayer = L.tileLayer(ESRI_URL, {
      maxZoom: 19,
      attribution: "&copy; Esri, Maxar, Earthstar Geographics",
    });
  } else {
    gibsDateEl.disabled = false;
    satStatusEl.textContent = `MODIS Terra · ${satDate} · 加载中…`;
    satTileLayer = gibsLayer(satDate);
  }
  satTileLayer.addTo(satMap);
}

document.querySelectorAll(".src-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".src-btn").forEach((b) => b.classList.toggle("active", b === btn));
    satSource = btn.dataset.src;
    if (satMap) buildSatLayer();
  });
});

gibsDateEl.addEventListener("change", () => {
  if (gibsDateEl.value) {
    satDate = gibsDateEl.value;
    if (satSource === "modis" && satMap) buildSatLayer();
  }
});

function toggleSatellite(e) {
  e.preventDefault();
  if (!META.has_geo) return; // 上传的地图没有地理位置, 找不到对应的真实影像
  satVisible = !satVisible;
  satOverlayEl.classList.toggle("hidden", !satVisible);
  if (satVisible && typeof L !== "undefined" && !window.__leafletFailed) {
    if (!satMap) {
      // 静态影像视图: 锁定瓦片范围, 仅查看
      satMap = L.map("satelliteMap", {
        zoomControl: false, dragging: false, scrollWheelZoom: false,
        doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
      });
      satMap.fitBounds(tileBounds((gridW * 40) / 2), { animate: false });
      buildSatLayer();
    }
    satMap.invalidateSize();
  }
}
mapWrapEl.addEventListener("dblclick", toggleSatellite);

/* ---------- 本地偏好记忆 (引擎/图层/地图视角) ---------- */
const pref = {
  get(k, d) {
    try { const v = localStorage.getItem("dw." + k); return v === null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("dw." + k, JSON.stringify(v)); } catch { /* 忽略 */ }
  },
};

/* ---------- 静态演示模式（GitHub Pages）：跳过依赖本地服务的请求 ---------- */
const DEMO = location.hostname.endsWith("github.io") || location.protocol === "file:";

/* ---------- 🙋 人工修正记录 ---------- */
function loadCorrections() {
  if (DEMO) return;
  fetch("/corrections")
    .then((r) => r.json())
    .then((d) => {
      const totalEl = document.getElementById("corrTotal");
      const bodyEl = document.getElementById("corrBody");
      if (!d.total) return;
      totalEl.textContent = `(${d.total} 条)`;
      bodyEl.innerHTML = d.rows.slice(0, 10).map((r) => {
        const time = (r.timestamp || "").slice(5, 16).replace("T", " ");
        const main = r.verdict === "error"
          ? `<span class="bad">❌ 修正为 ${CLASSES[+r.corrected_class]?.name ?? r.corrected_class}</span>`
          : `<span class="good">✅ 确认正确</span>`;
        return `<div class="corr-row"><span>${time} · 窗口#${r.rank}</span>${main}</div>`;
      }).join("") + (d.total > 10
        ? `<p class="env-hint" style="margin-top:6px">仅显示最近 10 条，共 ${d.total} 条</p>` : "");
    })
    .catch(() => {});
}
loadCorrections();

/* ---------- ☁️ GEE 实时拉取 ---------- */
const geeBtnEl = document.getElementById("geeBtn");
const geeStatusEl = document.getElementById("geeStatus");

geeBtnEl.addEventListener("click", async () => {
  const body = {
    lat: parseFloat(document.getElementById("geeLat").value),
    lon: parseFloat(document.getElementById("geeLon").value),
    date: document.getElementById("geeDate").value || "latest",
    size_km: parseFloat(document.getElementById("geeSize").value) || 6,
  };
  if (Number.isNaN(body.lat) || Number.isNaN(body.lon)) {
    geeStatusEl.textContent = "经纬度不合法";
    return;
  }
  geeBtnEl.disabled = true;
  geeBtnEl.textContent = "拉取中…（GEE 下载 + 审计, 约 10-60 秒）";
  geeStatusEl.textContent = "";
  try {
    const res = await fetch("/gee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!j.ok) throw new Error((j.log || j.error || "").split("\n")[0]);
    location.reload();
  } catch (e) {
    geeBtnEl.disabled = false;
    geeBtnEl.textContent = "拉取 Dynamic World 并审计";
    geeStatusEl.textContent = `失败: ${e.message}`;
    console.error(e);
  }
});

/* ---------- 🌍 实时环境监测 (NASA POWER 代理) ---------- */
const envBodyEl = document.getElementById("envBody");
let envMarker = null;
let lastEnvData = null;   // 最近一次环境查询结果, 提交人工修正时附带

/* ---------- 🚦 误判损失评估: 风险等级 + OOD ---------- */
const SEVERE_CLASSES = new Set([0, 6]); // 水体、建成区: 误判代价最高
let oodCut = 0.4; // 数据加载后按 cohort 自适应 (最平坦的 20%)

function sortedProbs(p) {
  return [...(p.probs || [])].sort((a, b) => b - a);
}

function calibrateOod(points) {
  const tops = points.map((p) => sortedProbs(p)[0]).filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (tops.length) {
    oodCut = Math.min(0.4, tops[Math.floor(tops.length * 0.2)]);
  }
}

function isOod(p) {
  if (!p.probs || !p.probs.length) return false;
  const s = sortedProbs(p);
  // 峰值概率过低, 或 top1/top2 几乎完全并列 (分布平坦)
  return s[0] < oodCut || (s.length > 1 && s[0] - s[1] < 0.008);
}

function riskOf(p) {
  if (isOod(p)) {
    return { level: "OOD", cls: "ood",
      note: "概率分布平坦（峰值过低或双峰并列），疑似分布外区域，模型在此不可信，建议人工核查" };
  }
  if (p.is_error === null) {
    return { level: "中", cls: "mid", note: "无参考真值，损失无法量化，按保守口径取中风险" };
  }
  if (!p.is_error) {
    return { level: "低", cls: "low", note: "预测与真值一致，无实际损失" };
  }
  return (SEVERE_CLASSES.has(p.pred_class) || SEVERE_CLASSES.has(p.true_class))
    ? { level: "高", cls: "high", note: "涉及水体/建成区等高代价类别混淆，误判损失大" }
    : { level: "中", cls: "mid", note: "类别混淆（植被/裸地之间），代价中等" };
}

/* ---------- 🌐 数据源引擎切换 ---------- */
const ENGINES = {
  local: {
    cls: "local", badge: "本地测试环境，正在使用秘鲁 Demo 瓦片",
    analyze: "正在对比历史影像与当前影像（本地模拟）…",
  },
  gee: {
    cls: "gee", badge: "GEE 云端算力（演示模式，未实际连接）· 支持实时动态查询",
    analyze: "正在调用 GEE 提取算法，对比历史影像与当前影像…",
  },
  oge: {
    cls: "oge", badge: "OGE 国产算力（演示模式，未实际连接）· 满足数据合规要求",
    analyze: "正在调用武汉一号影像，对比历史影像与当前影像…",
  },
};
let engine = "local";
const engineSelEl = document.getElementById("engineSel");
engineSelEl.addEventListener("change", () => {
  engine = engineSelEl.value;
  pref.set("engine", engine);
  const cfg = ENGINES[engine];
  document.getElementById("engineBadge").className = "engine-badge " + cfg.cls;
  document.getElementById("engineBadgeText").textContent = cfg.badge;
});
// 恢复上次选择的引擎
if (ENGINES[pref.get("engine", "local")] && pref.get("engine", "local") !== "local") {
  engineSelEl.value = pref.get("engine");
  engineSelEl.dispatchEvent(new Event("change"));
}

/* ---------- 🙋 人在回路反馈 ---------- */
function submitCorrection(p, verdict, correctedClass, fbExtraEl) {
  const latest = lastEnvData && lastEnvData.days ? lastEnvData.days[lastEnvData.days.length - 1] : null;
  fetch("/correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rank: p.rank, row: p.row, col: p.col,
      confidence: p.confidence, pred_class: p.pred_class, true_class: p.true_class,
      verdict, corrected_class: correctedClass,
      env: latest ? { temp_c: latest.temp_c, moisture_pct: latest.moisture_pct, date: latest.date } : null,
    }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) throw new Error(d.error || "提交失败");
      fbExtraEl.innerHTML = `<div class="fb-done">已记录 ✓ (累计 ${d.total} 条人工修正)</div>`;
      loadCorrections(); // 刷新修正记录面板
    })
    .catch((e) => {
      fbExtraEl.innerHTML = `<div class="fb-done" style="color:#f87171">提交失败: ${e.message}</div>`;
    });
}

function wireFeedback(p) {
  const okBtn = document.getElementById("fbOk");
  const errBtn = document.getElementById("fbErr");
  const extra = document.getElementById("fbExtra");
  okBtn.addEventListener("click", () => {
    okBtn.disabled = errBtn.disabled = true;
    submitCorrection(p, "correct", p.pred_class, extra);
  });
  errBtn.addEventListener("click", () => {
    extra.innerHTML = `
      <div class="fb-correct">
        <select id="fbClass">
          <option value="">请选择真实类别…</option>
          ${CLASSES.map((c, i) => `<option value="${i}">${i} · ${c.name}</option>`).join("")}
        </select>
        <button id="fbSubmit">提交修正</button>
      </div>`;
    document.getElementById("fbSubmit").addEventListener("click", () => {
      const v = document.getElementById("fbClass").value;
      if (v === "") return;
      okBtn.disabled = errBtn.disabled = true;
      submitCorrection(p, "error", +v, extra);
    });
  });
}

/* ---------- 左上角位置信息卡: 跟踪当前查看位置 ---------- */
const globeInfoMainEl = document.getElementById("globeInfoMain");
const globeInfoCoordsEl = document.getElementById("globeInfoCoords");
const globeInfoHintEl = document.getElementById("globeInfoHint");

function fmtLatLng(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ` +
         `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

function setGlobeInfoDefault() {
  if (META.has_geo) {
    globeInfoMainEl.textContent = "诊断瓦片 · 秘鲁南部太平洋沿岸山区";
    globeInfoCoordsEl.textContent = `Dynamic World 测试瓦片 · ${fmtLatLng(META.lat, META.lon)} · 约 5.1 km × 5.1 km`;
    globeInfoHintEl.textContent = "搜索或点击地图查询环境 · 点击脉冲标记进入诊断";
  } else {
    globeInfoMainEl.textContent = "当前地图无地理参考";
    globeInfoCoordsEl.textContent = "上传模式 · 诊断见右侧面板";
    globeInfoHintEl.textContent = "";
  }
  document.getElementById("subTitle").textContent = META.subtitle;
}

function updateGlobeInfo(name, lat, lon) {
  globeInfoMainEl.textContent = `当前查看 · ${name}`;
  globeInfoCoordsEl.textContent = fmtLatLng(lat, lon);
  globeInfoHintEl.textContent = META.has_geo
    ? "诊断瓦片位于秘鲁南部 · 点击脉冲标记进入诊断"
    : "上传地图无诊断瓦片";
  // 右上角副标题同步为当前位置
  document.getElementById("subTitle").textContent =
    `当前位置: ${name} · ${fmtLatLng(lat, lon)}`;
}

/* ---------- 左上角城市/国家搜索 (Photon via server) ---------- */
const searchInputEl = document.getElementById("searchInput");
const searchResultsEl = document.getElementById("searchResults");

function flyToResult(r) {
  searchResultsEl.classList.add("hidden");
  searchInputEl.value = r.name;
  updateGlobeInfo(r.name, r.lat, r.lon);
  if (typeof globeMap === "undefined" || !globeMap) return;
  globeMap.flyTo([r.lat, r.lon], r.zoom || 10, { duration: 1.5 });
  if (envMarker) globeMap.removeLayer(envMarker);
  envMarker = L.circleMarker([r.lat, r.lon], {
    radius: 7, color: "#fbbf24", weight: 2, fillOpacity: 0.4,
  }).addTo(globeMap)
    .bindTooltip(`${r.name}${r.ctx ? " · " + r.ctx : ""}`, { direction: "top" });
  fetchEnv(r.lat, r.lon, r.name);
}

function doSearch() {
  const q = searchInputEl.value.trim();
  if (!q) return;
  searchResultsEl.classList.remove("hidden");
  searchResultsEl.innerHTML = `<div class="search-empty">搜索中…</div>`;
  fetch(`/geocode?q=${encodeURIComponent(q)}`)
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok || !d.results.length) {
        searchResultsEl.innerHTML = `<div class="search-empty">${d.error || "未找到"}</div>`;
        return;
      }
      searchResultsEl.innerHTML = d.results.map((r, i) => `
        <div class="search-item" data-i="${i}">
          <div class="nm">${r.name}</div>
          ${r.ctx ? `<div class="cx">${r.ctx}</div>` : ""}
        </div>`).join("");
      searchResultsEl.querySelectorAll(".search-item").forEach((el) => {
        el.addEventListener("click", () => flyToResult(d.results[+el.dataset.i]));
      });
    })
    .catch((e) => {
      searchResultsEl.innerHTML = `<div class="search-empty">搜索失败: ${e.message}</div>`;
    });
}

document.getElementById("searchBtn").addEventListener("click", doSearch);
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
  if (e.key === "Escape") searchResultsEl.classList.add("hidden");
});

function windowToLatLng(p) {
  // 诊断窗口坐标 -> 经纬度 (patch=1, 网格即像素)
  const [[s, w], [n, e]] = tileBounds((gridW * 40) / 2);
  return [n - ((p.row + 0.5) / gridH) * (n - s), w + ((p.col + 0.5) / gridW) * (e - w)];
}

function fetchEnv(lat, lon, label) {
  if (DEMO) return;
  envBodyEl.innerHTML = `<p class="env-hint">查询中… (NASA POWER, 约 2-5 秒)</p>`;
  lastEnvData = null;
  fetch(`/env?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`)
    .then((r) => r.json())
    .then((d) => {
      lastEnvData = d.ok ? d : null;
      if (!d.ok) throw new Error(d.error || "无数据");
      const latest = d.days[d.days.length - 1];
      const days = d.days.map((x) =>
        `<div>${x.date}　温度 <b>${x.temp_c}°C</b>　湿度 <b>${x.moisture_pct}%</b></div>`).join("");
      envBodyEl.innerHTML = `
        <div class="env-loc">📍 ${label} · ${lat.toFixed(2)}, ${lon.toFixed(2)}</div>
        <div class="env-main">
          <div class="env-item"><div class="v temp">${latest.temp_c}°C</div><div class="k">地表温度 (${latest.date})</div></div>
          <div class="env-item"><div class="v wet">${latest.moisture_pct}%</div><div class="k">表层土壤湿度</div></div>
        </div>
        <div class="env-days">${days}</div>
        <div class="env-src">来源: ${d.source}</div>`;
    })
    .catch((e) => {
      envBodyEl.innerHTML = `<p class="env-hint">获取失败: ${e.message}</p>`;
    });
}

/* ---------- 载入数据, 装配整个看板 ---------- */
fetch("data.json")
  .then((r) => r.json())
  .then((data) => {
    predMap = data.pred_map;
    gridH = data.grid_h || 128;
    gridW = data.grid_w || 128;
    const points = data.windows;
    allPoints = points;

    fetch("meta.json")
      .then((r) => r.json())
      .catch(() => null)
      .then((meta) => {
        META = { ...DEFAULT_META, ...(meta || {}) };
        document.getElementById("subTitle").textContent = META.subtitle;
        setGlobeInfoDefault();
        if (!META.has_geo) {
          backBtnEl.hidden = true;       // 无地理位置: 不提供全球视图
          showDiag();
        } else {
          initGlobe();
        }
      });

    calibrateOod(points); // 先按 cohort 校准 OOD 阈值, 再创建标记
    points.forEach((p) => {
      const dot = document.createElement("div");
      dot.className = "dot";
      if (p.rank <= TOP_N) dot.classList.add("top10");
      if (isOod(p)) dot.classList.add("ood"); // OOD 窗口加紫色标记
      // +0.5 定位到像素格中心; 百分比定位随图片缩放自动适配
      dot.style.left = `${(100 * (p.col + 0.5)) / gridW}%`;
      dot.style.top = `${(100 * (p.row + 0.5)) / gridH}%`;
      dot.title = `#${p.rank} (${p.row}, ${p.col})`;
      // 重叠时排名靠前的点在上层, 点击优先命中更可疑的点
      dot.style.zIndex = String(1000 - p.rank);
      dot.addEventListener("click", () => selectPoint(p, dot));
      markersEl.appendChild(dot);
    });
    sizeDots();
    renderStats();
    renderLegend();
    renderMapLegend();
    console.log(`已渲染 ${points.length} 个可疑点, 网格 ${gridH}x${gridW}`);
  })
  .catch((e) => {
    document.getElementById("hintCard").innerHTML =
      `<p>加载 data.json 失败: ${e}<br>请通过 server.py 访问, 不要直接双击 index.html。</p>`;
    initGlobe();
  });

/* ---------- ✏️ 区域圈定与变化预警 (模拟演示) ---------- */
const drawAoiBtnEl = document.getElementById("drawAoiBtn");
const analyzeBtnEl = document.getElementById("analyzeBtn");
const clearAoiBtnEl = document.getElementById("clearAoiBtn");
const drawBannerEl = document.getElementById("drawBanner");
const alertBodyEl = document.getElementById("alertBody");
const changeModalEl = document.getElementById("changeModal");

let drawMode = false;
let drawPts = [];       // 已画顶点 [lat, lng]
let drawLine = null;    // 预览折线
let drawDots = [];      // 顶点小圆
let aoiPolygon = null;
let buildings = [];     // 模拟新增建筑 {layer, latlng, w, h, area, conf, idx}
let globePin = null;    // 脉冲标记与瓦片矩形 (绘制期间需临时禁用其点击)
let globeRect = null;

// 绘制期间禁用/恢复 标记与矩形 的点击拦截, 否则点到它们会跳进诊断视图
function setPinInteractive(on) {
  const els = [];
  if (globePin && globePin.getElement) els.push(globePin.getElement());
  if (globeRect && globeRect._path) els.push(globeRect._path);
  els.forEach((el) => { if (el) el.style.pointerEvents = on ? "" : "none"; });
}

function banner(html) {
  if (!html) { drawBannerEl.classList.add("hidden"); return; }
  drawBannerEl.innerHTML = html;
  drawBannerEl.classList.remove("hidden");
}

function bannerDraw() {
  banner(`绘制模式：单击地图添加顶点（至少 3 个）· 双击或点 <button id="bnFinish">✓ 完成绘制</button> 结束 · <button id="bnCancel">取消</button>`);
  document.getElementById("bnFinish").addEventListener("click", finishDraw);
  document.getElementById("bnCancel").addEventListener("click", cancelDraw);
}

function bannerDone() {
  banner(`已圈定监测区域 · <button id="bnAnalyze">🚀 开始变化分析</button> <button id="bnClear2">✕ 清除重画</button>`);
  document.getElementById("bnAnalyze").addEventListener("click", runAnalysis);
  document.getElementById("bnClear2").addEventListener("click", clearAoi);
}

function resetDrawOverlays() {
  if (drawLine) { globeMap.removeLayer(drawLine); drawLine = null; }
  drawDots.forEach((m) => globeMap.removeLayer(m));
  drawDots = [];
}

function clearAoi() {
  resetDrawOverlays();
  if (aoiPolygon) { globeMap.removeLayer(aoiPolygon); aoiPolygon = null; }
  buildings.forEach((b) => globeMap.removeLayer(b.layer));
  buildings = [];
  drawPts = [];
  drawMode = false;
  globeMap.doubleClickZoom.enable();
  setPinInteractive(true);
  drawAoiBtnEl.classList.remove("active");
  analyzeBtnEl.hidden = true;
  clearAoiBtnEl.hidden = true;
  banner(null);
  alertBodyEl.innerHTML =
    `<p class="env-hint">在全球地图圈定一片区域（✏️ 圈定监测范围），开始变化监测演示</p>`;
}

function startDraw() {
  clearAoi();
  drawMode = true;
  globeMap.doubleClickZoom.disable();
  setPinInteractive(false); // 绘制期间让标记不拦点击
  drawAoiBtnEl.classList.add("active");
  bannerDraw();
}

function cancelDraw() {
  drawMode = false;
  globeMap.doubleClickZoom.enable();
  setPinInteractive(true);
  drawAoiBtnEl.classList.remove("active");
  resetDrawOverlays();
  drawPts = [];
  banner(null);
}

function addDrawVertex(latlng) {
  drawPts.push([latlng.lat, latlng.lng]);
  drawDots.push(L.circleMarker(latlng, {
    radius: 4, color: "#fbbf24", fillOpacity: 0.9,
  }).addTo(globeMap));
  if (drawLine) globeMap.removeLayer(drawLine);
  const ring = drawPts.concat(drawPts.length > 1 ? [drawPts[0]] : []);
  drawLine = L.polyline(ring, { color: "#fbbf24", weight: 2, dashArray: "5 5" }).addTo(globeMap);
}

function finishDraw() {
  if (!drawMode) return;
  drawMode = false;
  globeMap.doubleClickZoom.enable();
  setPinInteractive(true);
  drawAoiBtnEl.classList.remove("active");
  // 去掉双击事件带来的重复末点
  const pts = drawPts.filter((p, i, a) =>
    i === 0 || Math.abs(p[0] - a[i - 1][0]) > 1e-7 || Math.abs(p[1] - a[i - 1][1]) > 1e-7);
  resetDrawOverlays();
  drawPts = [];
  if (pts.length < 3) {
    bannerDraw(); // 顶点不足, 继续画
    return;
  }
  aoiPolygon = L.polygon(pts, {
    color: "#fbbf24", weight: 2, fillColor: "#fbbf24", fillOpacity: 0.08,
  }).addTo(globeMap);
  analyzeBtnEl.hidden = false;
  clearAoiBtnEl.hidden = false;
  bannerDone();
  globeMap.fitBounds(aoiPolygon.getBounds().pad(0.5), { maxZoom: 14 });
}

function pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function runAnalysis() {
  if (!aoiPolygon) return;
  analyzeBtnEl.hidden = true;
  clearAoiBtnEl.hidden = true;
  const taskText = ENGINES[engine].analyze;
  banner(taskText);
  alertBodyEl.innerHTML =
    `<div class="alert-loading"><span class="spinner"></span>${taskText.replace("…", "")}（模拟）…</div>`;
  setTimeout(() => {
    const bounds = aoiPolygon.getBounds();
    const poly = aoiPolygon.getLatLngs()[0].map((ll) => [ll.lat, ll.lng]);
    const target = 8 + Math.floor(Math.random() * 9); // 8-16 处
    let total = 0, tries = 0;
    while (buildings.length < target && tries < 600) {
      tries += 1;
      const lat = bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth());
      const lng = bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest());
      if (!pointInPoly(lat, lng, poly)) continue;
      const w = 25 + Math.random() * 45, h = 25 + Math.random() * 45; // 米
      const dLat = h / 2 / 111320;
      const dLon = w / 2 / (111320 * Math.cos(lat * Math.PI / 180));
      const idx = buildings.length + 1;
      const rect = L.rectangle(
        [[lat - dLat, lng - dLon], [lat + dLat, lng + dLon]],
        { color: "#ef4444", weight: 1.5, fillColor: "#ef4444", fillOpacity: 0.55 },
      ).addTo(globeMap).bindTooltip(`建筑物 #${idx}（模拟）`);
      const info = {
        layer: rect, latlng: [lat, lng], w, h,
        area: Math.round(w * h), conf: 86 + Math.round(Math.random() * 11), idx,
      };
      rect.on("click", () => openChangeDetail(info));
      buildings.push(info);
      total += info.area;
    }
    const ha = total / 10000;
    const areaText = ha >= 1 ? `${ha.toFixed(1)} 公顷` : `${total} m²`;
    alertBodyEl.innerHTML = `
      <div class="alert-red">⚠️ 发现新增建筑物 ${buildings.length} 处，总面积约 ${areaText}</div>
      <p class="alert-hint">您可以点击地图中的红色方块，查看该地块的变化详情</p>
      <div class="alert-foot">对比: 2024-11 ↔ 2026-11 · 模拟数据，仅作演示</div>`;
    banner(null);
    clearAoiBtnEl.hidden = false;
  }, 1500);
}

/* ---------- 地块变化详情弹窗 (示意对比图) ---------- */
function drawScene(canvas, withBuilding) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#63666d";                    // 地面
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 500; i++) {               // 噪点肌理
    const g = 90 + Math.random() * 60 | 0;
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},.4)`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  ctx.strokeStyle = "#9ca3af";                  // 道路
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(0, h * 0.7); ctx.lineTo(w, h * 0.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w * 0.28, 0); ctx.lineTo(w * 0.38, h); ctx.stroke();
  if (withBuilding) {                           // 现状: 新增建筑
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(w * 0.56, h * 0.28, w * 0.2, h * 0.24);
    ctx.strokeStyle = "#fecaca";
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.56, h * 0.28, w * 0.2, h * 0.24);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("新增建筑", w * 0.545, h * 0.24);
  }
  ctx.fillStyle = "rgba(0,0,0,.6)";             // 时间戳
  ctx.fillRect(0, h - 20, w, 20);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "11px sans-serif";
  ctx.fillText(withBuilding ? "2026-11-12" : "2024-11-12", 8, h - 6);
}

function openChangeDetail(info) {
  document.getElementById("cmTitle").innerHTML =
    `地块变化详情 · 建筑物 #${info.idx} <span class="sim-badge">模拟</span>`;
  document.getElementById("cmMeta").innerHTML = `
    <span>位置 <b>${fmtLatLng(info.latlng[0], info.latlng[1])}</b></span>
    <span>足印 <b>${Math.round(info.w)} × ${Math.round(info.h)} m</b></span>
    <span>面积 <b>${info.area} m²</b></span>
    <span>置信度 <b>${info.conf}%</b></span>`;
  drawScene(document.getElementById("cmBefore"), false);
  drawScene(document.getElementById("cmAfter"), true);
  changeModalEl.classList.remove("hidden");
}

document.getElementById("cmClose").addEventListener("click", () =>
  changeModalEl.classList.add("hidden"));
changeModalEl.addEventListener("click", (e) => {
  if (e.target === changeModalEl) changeModalEl.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!changeModalEl.classList.contains("hidden")) {
    changeModalEl.classList.add("hidden");
  } else if (drawMode) {
    cancelDraw();
  }
});
