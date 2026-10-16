#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成可扫描的访问二维码（用经过验证的 qrcode 库，不自己实现编码）。
用法:  python tools/make-qr.py "<文本/网址>" <输出.png> [每格像素=10] [静区=4]
说明:  Windows 上二维码图片单独放在 qr-public.txt 里也能看图，这里同时输出一个同名的 .txt。
"""
import sys
import os

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M
except ImportError:
    sys.stderr.write("缺少 qrcode 库，请先执行: python -m pip install qrcode pillow\n")
    sys.exit(2)

def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    text = sys.argv[1]
    out = sys.argv[2]
    box = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    border = int(sys.argv[4]) if len(sys.argv) > 4 else 4

    qr = qrcode.QRCode(
        version=None,                 # 自动选最小版本
        error_correction=ERROR_CORRECT_M,
        box_size=box,
        border=border,
    )
    # 显式用 byte 模式，避免被自动切成字母数字模式（URL 里有 ?/=/ 也能编，但统一行为更好）
    qr.add_data(text, optimize=0)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out)

    with open(os.path.splitext(out)[0] + ".txt", "w", encoding="utf-8") as f:
        f.write(text + "\n")

    print("二维码已生成: %s  (版本 %s, %dx%d 像素)" % (out, qr.version, img.pixel_size, img.pixel_size))
    return 0

if __name__ == "__main__":
    sys.exit(main())
