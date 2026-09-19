#!/usr/bin/env python3
"""光的游戏 安卓图标生成脚本（可复现）

不用图像模型，直接按游戏自己的配色与元件画法绘制几何图标 ——
**改图标就是改这个脚本**，随时重新生成，且每次输出完全一致。

图标讲的就是核心玩法：白光射入分光镜，被拆成红 / 绿 / 蓝三束。

配色与 `scripts/renderer.js` 的 BEAM_COLORS / ELEMENT_LINE 同源：
  页面底色 #08090c、元件线条 #e4eaf4、白 #ffffff、红 #ff5f5f、绿 #5ce08a、蓝 #5aa9ff

输出：
  icon-source/icon-full.png         1024 整图（含背景，用于传统图标与归档）
  icon-source/icon-foreground.png   1024 透明背景前景（自适应图标用）
  icon-source/store-icon-512.png    512 归档
  app/src/main/res/mipmap-*/ic_launcher.png           各密度传统图标
  app/src/main/res/mipmap-*/ic_launcher_foreground.png 各密度自适应前景

用法（在 android/ 目录下执行）：
  python tools/make-icons.py
依赖：Pillow
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent.parent          # android/
SRC = HERE / "icon-source"
RES = HERE / "app" / "src" / "main" / "res"

# 所有几何都按 1024 画，最后缩放到各密度 —— 缩小时自带抗锯齿，
# 而 PIL 直接在小画布上画线是没有抗锯齿的。
BASE = 1024
CX = BASE // 2
CY = BASE // 2

# ---- 配色（与 scripts/renderer.js 同源）----
BG_DEEP = (8, 9, 12)            # 网页 --bg-deep #08090c
BG_GLOW = (34, 42, 56)          # 背景径向高光
ELEMENT = (228, 234, 244)       # 元件线条 #e4eaf4
WHITE = (255, 255, 255)         # 白光
RED = (255, 95, 95)             # #ff5f5f
GREEN = (92, 224, 138)          # #5ce08a
BLUE = (90, 169, 255)           # #5aa9ff

# ---- 内容占比 ----
# 传统图标是方形/圆形，可以画满一些；自适应图标会被各家启动器裁成圆形或圆角方形，
# 内容必须留在中心安全区内（108dp 画布的安全区是直径 72dp 的圆 ≈ 66.7%）。
#
# 注意 X 方向才是约束：内容横向跨度是 2*half（白光 + 三束），纵向只有 1.58*half。
# 另外光晕的模糊尾巴也算在跨度里（实测约 200px），所以前景的 half 明显小于传统图标。
FULL_HALF = 320                 # 内容占 62.5%
FORE_HALF = 240                 # 含光晕后落进 66.7% 安全区

# 光晕：把光画粗一圈再做高斯模糊。比叠几层半透明线柔和得多 ——
# 叠线会在端点留下明显的「胶囊」轮廓。
GLOW_BLUR = 26

LEGACY = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
FOREGROUND = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def rgba(color, alpha):
    return (color[0], color[1], color[2], max(0, min(255, int(round(alpha * 255)))))


def segment(draw, p0, p1, color, width):
    """一段圆头线条。PIL 的 line 没有圆头，端点各补一个圆。"""
    w = max(1, int(round(width)))
    draw.line([p0, p1], fill=color, width=w)
    r = w / 2.0
    for x, y in (p0, p1):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def make_background(size):
    """深色底 + 中心径向高光，避免整块死黑"""
    base = Image.new("RGB", (size, size), BG_DEEP)
    # radial_gradient 是「中心黑 → 边缘白」，取反后中心才变白，用作混合遮罩
    mask = ImageOps.invert(Image.radial_gradient("L")).resize((size, size), Image.LANCZOS)
    mask = mask.point(lambda v: int(v * 0.62))
    return Image.composite(Image.new("RGB", (size, size), BG_GLOW), base, mask)


def build_beams(half):
    """白光从左侧射入，在中心被分光镜拆成红 / 绿 / 蓝三束向右散开"""
    w_in = 44
    w_out = 38
    center = (CX, CY)
    # 三束取相同长度：按 52° 散开（cos52°≈0.62、sin52°≈0.79），
    # 上下两束的实际长度即为 half，与水平那束一致。
    dx = round(half * 0.62)
    dy = round(half * 0.79)
    return [
        ((CX - half, CY), center, WHITE, w_in),
        (center, (CX + dx, CY - dy), RED, w_out),
        (center, (CX + half, CY), GREEN, w_out),
        (center, (CX + dx, CY + dy), BLUE, w_out),
    ]


def render(half, transparent_bg):
    if transparent_bg:
        canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    else:
        canvas = make_background(BASE).convert("RGBA")

    beams = build_beams(half)

    # 光晕：把光画粗一圈再做高斯模糊。比叠几层半透明线柔和得多 ——
    # 叠线会在端点留下明显的「胶囊」轮廓。
    glow = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for p0, p1, color, width in beams:
        segment(gd, p0, p1, rgba(color, 0.55), width * 1.9)
    glow = glow.filter(ImageFilter.GaussianBlur(GLOW_BLUR))

    core = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    for p0, p1, color, width in beams:
        segment(cd, p0, p1, rgba(color, 1.0), width)
    # 交汇处补一个亮斑，填掉几条线之间的缝隙
    cd.ellipse([CX - 24, CY - 24, CX + 24, CY + 24], fill=rgba(WHITE, 0.94))

    canvas = Image.alpha_composite(canvas, glow)
    canvas = Image.alpha_composite(canvas, core)
    return canvas


def render_splitter():
    """分光镜：一条短斜线 + 一条平行的淡线（对应 renderer.js 的 drawSplitter）

    当前**未启用** —— 试过压在光层下面，两端露出来的部分像一根孤立的短棒杵在旁边，
    反而比没有更乱。图标只留「白光进、三色光出」这条主线，信息量已经够了。
    要恢复就把 render() 里的注释打开。
    """
    layer = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    half_len = 62
    width = 32
    p0 = (CX - half_len, CY - half_len)
    p1 = (CX + half_len, CY + half_len)

    segment(draw, p0, p1, rgba(ELEMENT, 0.92), width)
    # 沿镜面法线方向平移，才看得出「这是半透的」
    off = 20
    segment(
        draw,
        (p0[0] + off, p0[1] - off),
        (p1[0] + off, p1[1] - off),
        rgba(ELEMENT, 0.5),
        width * 0.5,
    )
    return layer


def resize_to(img, size):
    return img.resize((size, size), Image.LANCZOS)


def main():
    SRC.mkdir(parents=True, exist_ok=True)

    full = render(FULL_HALF, transparent_bg=False)
    fore = render(FORE_HALF, transparent_bg=True)

    full.save(SRC / "icon-full.png")
    fore.save(SRC / "icon-foreground.png")
    resize_to(full.convert("RGB"), 512).save(SRC / "store-icon-512.png", optimize=True)
    print(f"  归档 icon-source/  icon-full.png / icon-foreground.png / store-icon-512.png")

    for folder, size in LEGACY.items():
        d = RES / folder
        d.mkdir(parents=True, exist_ok=True)
        resize_to(full.convert("RGB"), size).save(d / "ic_launcher.png", optimize=True)
        print(f"  ic_launcher.png            {folder}  {size}x{size}")

    for folder, size in FOREGROUND.items():
        d = RES / folder
        d.mkdir(parents=True, exist_ok=True)
        resize_to(fore, size).save(d / "ic_launcher_foreground.png", optimize=True)
        print(f"  ic_launcher_foreground.png {folder}  {size}x{size}")

    print("图标生成完成")


if __name__ == "__main__":
    main()
