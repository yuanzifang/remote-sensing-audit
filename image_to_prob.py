"""把一张分类着色的地图图片转成 (9, H, W) 概率图。

原理: 像素颜色与 Dynamic World 9 类调色板的距离 -> softmax 权重。
颜色干净(贴近某调色板色) -> 高置信; 颜色混合(边界/压缩噪点) -> 低置信。
这是由图片合成的概率, 不是模型真实输出, 页面上会如实标注。
"""

import sys

import numpy as np
import rasterio
from rasterio.enums import Resampling

DW_PALETTE = np.array([
    [65, 155, 223],   # 0 water
    [57, 125, 73],    # 1 trees
    [136, 176, 83],   # 2 grass
    [122, 135, 198],  # 3 flooded_vegetation
    [228, 150, 53],   # 4 crops
    [223, 195, 90],   # 5 shrub_and_scrub
    [196, 40, 27],    # 6 built
    [165, 155, 143],  # 7 bare
    [179, 159, 225],  # 8 snow_and_ice
], dtype=np.float32)

SIGMA = 25.0   # 颜色距离尺度: 调色板最近两色距离约 50, 权重降到 ~0.13
MAX_DIM = 256  # 上传图最长边缩到 256 (最近邻, 不混色), 保证审计速度


def main(img_path, out_path):
    with rasterio.open(img_path) as src:
        scale = min(1.0, MAX_DIM / max(src.width, src.height))
        out_h = max(8, round(src.height * scale))
        out_w = max(8, round(src.width * scale))
        rgb = src.read(
            indexes=[1, 2, 3],
            out_shape=(3, out_h, out_w),
            resampling=Resampling.nearest,
        ).astype(np.float32)

    flat = rgb.reshape(3, -1).T                      # (N, 3)
    d2 = ((flat[:, None, :] - DW_PALETTE[None]) ** 2).sum(-1)  # (N, 9) 颜色距离平方
    w = np.exp(-d2 / (2 * SIGMA ** 2))
    w = np.maximum(w, 1e-3)                          # 概率地板, 避免工具遇到 0
    prob = (w / w.sum(-1, keepdims=True)).T.astype(np.float32)  # (9, N)
    prob = prob.reshape(9, out_h, out_w)
    np.save(out_path, prob)
    top = prob.max(0)
    print(f"{img_path} -> {out_path}: shape {prob.shape}, "
          f"top1 概率均值 {top.mean():.3f}, 低于 0.6 的像素 {np.mean(top < 0.6):.1%}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
