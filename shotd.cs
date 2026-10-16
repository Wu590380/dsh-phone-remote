// shotd.cs —— 常驻屏幕采集 + 增量编码（VNC 思路）：只传画面里"变了的那几块"
// 桌面大多时候是静态的，整帧 JPEG（110KB/帧）太浪费；改成 64x64 分块比较，只发脏块。
// 输出协议（stdout，全部小端）：[1 字节类型][4 字节长度][payload]
//   类型 1 = 全帧 JPEG（关键帧，每 keyEvery 帧或变化过大时发）
//   类型 2 = 增量包：payload = [2B 块数] + 每块 [2B x][2B y][2B w][2B h][4B len][JPEG]
// 编译: csc.exe /nologo /optimize+ /out:shotd.exe shotd.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class ShotD
{
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    static int Main(string[] args)
    {
        int width = 1100, quality = 60, fps = 20, tile = 64, keyEvery = 60;
        double qDelta = 0.9;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            switch (args[i])
            {
                case "--width": width = int.Parse(args[i + 1]); break;
                case "--quality": quality = int.Parse(args[i + 1]); break;
                case "--fps": fps = int.Parse(args[i + 1]); break;
                case "--tile": tile = int.Parse(args[i + 1]); break;
                case "--key": keyEvery = int.Parse(args[i + 1]); break;
            }
        }
        if (fps < 1) fps = 1;
        if (tile < 16) tile = 16;
        int frameMs = 1000 / fps;

        Stream os = Console.OpenStandardOutput();
        var jpeg = GetJpegCodec();
        var epFull = new EncoderParameters(1);
        epFull.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
        int qTile = Math.Max(30, (int)Math.Round(quality * qDelta));
        var epTile = new EncoderParameters(1);
        epTile.Param[0] = new EncoderParameter(Encoder.Quality, (long)qTile);

        try { SetProcessDPIAware(); } catch { }

        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int ow = GetSystemMetrics(SM_CXVIRTUALSCREEN), oh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (ow <= 0 || oh <= 0) { ow = 1920; oh = 1080; vx = 0; vy = 0; }
        double scale = (width > 0 && ow > width) ? (double)width / ow : 1.0;
        int dw = Math.Max(1, (int)Math.Round(ow * scale)), dh = Math.Max(1, (int)Math.Round(oh * scale));

        var meta = System.Text.Encoding.UTF8.GetBytes("{\"ow\":" + ow + ",\"oh\":" + oh + ",\"w\":" + dw + ",\"h\":" + dh + ",\"tile\":" + tile + "}\n");
        os.Write(meta, 0, meta.Length); os.Flush();

        byte[] prev = new byte[dw * dh * 3];
        byte[] cur = new byte[dw * dh * 3];
        bool first = true;
        int sinceKey = keyEvery;

        while (true)
        {
            try
            {
                using (var full = new Bitmap(dw, dh, PixelFormat.Format24bppRgb))
                {
                    using (var raw = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
                    {
                        // 先把整个屏幕抓下来（ow x oh），再等比缩放到 dw x dh；
                        // 注意 CopyFromScreen 的第五个参数是"要拷贝的屏幕区域大小"，写成 dw/dh 就变成只截左上角那一块了。
                        using (var gRaw = Graphics.FromImage(raw))
                        {
                            gRaw.CopyFromScreen(vx, vy, 0, 0, new Size(ow, oh), CopyPixelOperation.SourceCopy);
                        }
                        using (var g = Graphics.FromImage(full))
                        {
                            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                            g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
                            g.CompositingQuality = CompositingQuality.HighSpeed;
                            g.DrawImage(raw, new Rectangle(0, 0, dw, dh));
                        }
                    }
                    var bd = full.LockBits(new Rectangle(0, 0, dw, dh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                    int stride = bd.Stride;
                    if (stride == dw * 3) Marshal.Copy(bd.Scan0, cur, 0, cur.Length);
                    else for (int y = 0; y < dh; y++) Marshal.Copy(IntPtr.Add(bd.Scan0, y * stride), cur, y * dw * 3, dw * 3);
                    full.UnlockBits(bd);

                    bool forceKey = first || sinceKey >= keyEvery;
                    if (forceKey)
                    {
                        WritePacket(os, 1, Jpeg(full, jpeg, epFull));
                        Buffer.BlockCopy(cur, 0, prev, 0, cur.Length);
                        first = false; sinceKey = 0;
                    }
                    else
                    {
                        var dirty = new List<int[]>();
                        long changed = 0;
                        for (int ty = 0; ty < dh; ty += tile)
                        {
                            int th = Math.Min(tile, dh - ty);
                            for (int tx = 0; tx < dw; tx += tile)
                            {
                                int tw = Math.Min(tile, dw - tx);
                                if (TileDiffers(prev, cur, dw, tx, ty, tw, th))
                                {
                                    dirty.Add(new int[] { tx, ty, tw, th });
                                    changed += (long)tw * th;
                                }
                            }
                        }
                        if (dirty.Count == 0)
                        {
                            // 没事发生：不发东西（省带宽，客户端保留上一帧）
                        }
                        else if (changed > (long)dw * dh * 45 / 100)
                        {
                            WritePacket(os, 1, Jpeg(full, jpeg, epFull));
                            Buffer.BlockCopy(cur, 0, prev, 0, cur.Length);
                            sinceKey = 0;
                        }
                        else
                        {
                            var ms = new MemoryStream(64 * 1024);
                            WriteU16(ms, dirty.Count);
                            foreach (var rc in dirty)
                            {
                                byte[] tj = JpegTile(cur, dw, rc[0], rc[1], rc[2], rc[3], jpeg, epTile);
                                WriteU16(ms, rc[0]); WriteU16(ms, rc[1]); WriteU16(ms, rc[2]); WriteU16(ms, rc[3]);
                                WriteU32(ms, tj.Length); ms.Write(tj, 0, tj.Length);
                            }
                            WritePacket(os, 2, ms.ToArray());
                            Buffer.BlockCopy(cur, 0, prev, 0, cur.Length);
                        }
                    }
                }
                sinceKey++;
            }
            catch (IOException) { return 0; }                       // 管道断了 → 退出，agent 会重启
            catch (Exception e) { Console.Error.WriteLine("shotd: " + e.Message); Thread.Sleep(500); }

            int rest = frameMs;                                     // 采集本身很快，按目标帧率节流
            try { } catch { }
            if (rest > 0) Thread.Sleep(rest);
        }
    }

    static bool TileDiffers(byte[] a, byte[] b, int w, int x0, int y0, int tw, int th)
    {
        for (int y = 0; y < th; y++)
        {
            int off = ((y0 + y) * w + x0) * 3;
            int end = off + tw * 3;
            for (int i = off; i < end; i++) if (a[i] != b[i]) return true;
        }
        return false;
    }

    static byte[] JpegTile(byte[] rgb, int w, int x0, int y0, int tw, int th, ImageCodecInfo codec, EncoderParameters ep)
    {
        using (var bmp = new Bitmap(tw, th, PixelFormat.Format24bppRgb))
        {
            var bd = bmp.LockBits(new Rectangle(0, 0, tw, th), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            for (int y = 0; y < th; y++)
            {
                int srcOff = ((y0 + y) * w + x0) * 3;
                Marshal.Copy(rgb, srcOff, IntPtr.Add(bd.Scan0, y * bd.Stride), tw * 3);
            }
            bmp.UnlockBits(bd);
            return Jpeg(bmp, codec, ep);
        }
    }

    static byte[] Jpeg(Bitmap bmp, ImageCodecInfo codec, EncoderParameters ep)
    {
        using (var ms = new MemoryStream(32 * 1024)) { bmp.Save(ms, codec, ep); return ms.ToArray(); }
    }

    static void WriteU16(Stream s, int v) { s.WriteByte((byte)(v & 0xFF)); s.WriteByte((byte)((v >> 8) & 0xFF)); }
    static void WriteU32(Stream s, int v) { s.WriteByte((byte)(v & 0xFF)); s.WriteByte((byte)((v >> 8) & 0xFF)); s.WriteByte((byte)((v >> 16) & 0xFF)); s.WriteByte((byte)((v >> 24) & 0xFF)); }

    static void WritePacket(Stream os, int type, byte[] payload)
    {
        var h = new byte[5];
        h[0] = (byte)type;
        h[1] = (byte)(payload.Length & 0xFF); h[2] = (byte)((payload.Length >> 8) & 0xFF);
        h[3] = (byte)((payload.Length >> 16) & 0xFF); h[4] = (byte)((payload.Length >> 24) & 0xFF);
        os.Write(h, 0, 5);
        os.Write(payload, 0, payload.Length);
        os.Flush();
    }

    static ImageCodecInfo GetJpegCodec()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        throw new Exception("no jpeg codec");
    }
}
