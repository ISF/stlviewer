#!/usr/bin/env python3
"""Generate the stlviewer app icon: a 3D cube in 3-quarter perspective.

Renders at 4× resolution with Pillow's polygon rasterizer, then downsamples
with Lanczos for clean anti-aliased edges. Output is a 1024×1024 PNG written
to src-tauri/icons/icon.png.

Re-run after editing constants below to iterate on the design.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

# Master source PNG. `npm run tauri icon <this path>` rebuilds the per-platform
# variants (icon.icns, the size-specific PNGs, etc.) from it. The
# tauri-generated icon.png is a 512-pixel downscale of the source and gets
# overwritten by tauri icon; we keep the 1024 master here so re-runs are
# deterministic.
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "icon-source.png"

SIZE = 1024
SUPER = 4  # supersampling factor
W = SIZE * SUPER

# Background — dark blue-gray, evokes a CAD viewport
BG_TOP = (30, 42, 58, 255)
BG_BOT = (16, 24, 36, 255)

# Cube face colors (top, front, right) — light to dark for depth
FACE_TOP = (140, 195, 235, 255)
FACE_FRONT = (90, 150, 210, 255)
FACE_RIGHT = (60, 110, 175, 255)

EDGE_COLOR = (220, 235, 250, 255)
EDGE_WIDTH_PX = 14 * SUPER // 4  # tuned visually

# Camera in cube-local coords. Cube is unit-scale at origin.
CAM = (4.6, -4.6, 3.6)
TARGET = (0.0, 0.0, 0.0)
WORLD_UP = (0.0, 0.0, 1.0)
FOV_DEG = 28.0


def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def vnorm(a):
    n = math.sqrt(vdot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


def project(v):
    """Pinhole perspective projection -> image coordinates."""
    forward = vnorm(vsub(TARGET, CAM))
    right = vnorm(vcross(forward, WORLD_UP))
    true_up = vcross(right, forward)

    rel = vsub(v, CAM)
    cam_x = vdot(rel, right)
    cam_y = vdot(rel, true_up)
    cam_z = vdot(rel, forward)

    f = 1.0 / math.tan(math.radians(FOV_DEG) / 2)
    ndc_x = cam_x * f / cam_z
    ndc_y = cam_y * f / cam_z

    px = (ndc_x + 1) * 0.5 * W
    py = (1 - (ndc_y + 1) * 0.5) * W
    return (px, py)


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    """Squircle-ish rounded rectangle mask matching modern macOS app icons."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple, bot: tuple) -> Image.Image:
    img = Image.new("RGBA", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(4))
        d.line([(0, y), (size, y)], fill=c)
    return img


def main() -> None:
    # Cube vertices: bottom face 0..3 (z=-1), top face 4..7 (z=+1).
    verts = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),  # bottom
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),      # top
    ]
    p = [project(v) for v in verts]

    # Faces visible to a camera at (+x, -y, +z): top, front (-y), right (+x).
    top_face = [p[4], p[5], p[6], p[7]]
    front_face = [p[0], p[1], p[5], p[4]]
    right_face = [p[1], p[2], p[6], p[5]]

    img = vertical_gradient(W, BG_TOP, BG_BOT)
    draw = ImageDraw.Draw(img)

    # Fill faces back-to-front. Right and front share an edge; order doesn't
    # matter so long as top is last (it sits on top of both).
    draw.polygon(right_face, fill=FACE_RIGHT)
    draw.polygon(front_face, fill=FACE_FRONT)
    draw.polygon(top_face, fill=FACE_TOP)

    # Visible edges only: silhouette + the three edges meeting at the front
    # top-right corner.
    visible_edges = [
        # top face perimeter
        (4, 5), (5, 6), (6, 7), (7, 4),
        # front face's lower & vertical edges
        (0, 1), (1, 5), (4, 0),
        # right face's lower-right & far-vertical edges
        (1, 2), (2, 6),
    ]
    for a, b in visible_edges:
        draw.line([p[a], p[b]], fill=EDGE_COLOR, width=EDGE_WIDTH_PX, joint="curve")

    # Apply a rounded mask so the icon matches modern macOS shapes even when
    # not rendered through the system's automatic mask (e.g. inside the app
    # window itself).
    mask = rounded_rect_mask(W, radius=int(W * 0.225))
    img.putalpha(mask)

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT} ({SIZE}×{SIZE})")


if __name__ == "__main__":
    main()
