package com.mc.pcbridge;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Base64;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 极简 WebSocket 客户端（只够用：连 wss、收二进制帧、回 pong、断线重连）。
 * 服务器把我们推的帧直接塞成二进制帧，省掉 base64 那一层。
 */
final class WsClient {

    interface Listener {
        void onFrame(byte[] jpeg);          // 一帧 JPEG
        void onMeta(int w, int h);          // hello 里的电脑分辨率
        void onState(String state);         // 连接状态文案（给界面显示）
    }

    private final String host;
    private final int port;
    private final String path;
    private final boolean tls;
    private final Listener listener;
    private volatile boolean closed = false;
    private volatile Socket sock;
    private Thread thread;
    private int fpsCount = 0;
    private long fpsAt = System.currentTimeMillis();
    private volatile int fps = 0;

    WsClient(String url, Listener listener) throws Exception {
        this.listener = listener;
        java.net.URI u = new java.net.URI(url);
        this.tls = !"ws".equalsIgnoreCase(u.getScheme());
        this.host = u.getHost();
        this.port = u.getPort() > 0 ? u.getPort() : (tls ? 443 : 80);
        String p = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        this.path = p + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
    }

    int fps() { return fps; }

    void start() {
        thread = new Thread(this::runLoop, "ws-screen");
        thread.setDaemon(true);
        thread.start();
    }

    void close() {
        closed = true;
        try { if (sock != null) sock.close(); } catch (Exception ignored) { }
        if (thread != null) thread.interrupt();
    }

    private void runLoop() {
        while (!closed) {
            try {
                connectAndRead();
            } catch (Exception e) {
                if (closed) return;
                android.util.Log.w("pc-dsh-ws", "断开: " + e.toString());
                listener.onState("画面连接断开：" + e.getMessage() + "，2 秒后重连");
            }
            if (closed) return;
            try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
        }
    }

    private void connectAndRead() throws Exception {
        Socket s;
        if (tls) {
            s = SSLSocketFactory.getDefault().createSocket();
            ((SSLSocket) s).setSoTimeout(15000);           // 握手/首帧超时
            s.connect(new InetSocketAddress(host, port), 12000);
        } else {
            s = new Socket();
            s.connect(new InetSocketAddress(host, port), 12000);
        }
        this.sock = s;
        s.setTcpNoDelay(true);
        s.setSoTimeout(0);                                  // 之后是长连接，不设读超时

        OutputStream out = s.getOutputStream();
        InputStream rawIn = new BufferedInputStream(s.getInputStream(), 256 * 1024);

        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);
        String req = "GET " + path + " HTTP/1.1\r\n" +
                "Host: " + host + (port == 443 || port == 80 ? "" : ":" + port) + "\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: " + key + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "User-Agent: pc-dsh-app/1.0\r\n\r\n";
        out.write(req.getBytes("UTF-8"));
        out.flush();

        String head = readHead(rawIn);
        android.util.Log.i("pc-dsh-ws", "握手返回: " + head.split("\r\n")[0]);
        if (!head.startsWith("HTTP/1.1 101") && !head.contains(" 101 ")) {
            throw new Exception("升级失败：" + head.split("\r\n")[0]);
        }
        android.util.Log.i("pc-dsh-ws", "升级成功，开始收帧");
        listener.onState("画面已连上（实时推送）");

        ByteArrayOutputStream frame = new ByteArrayOutputStream(256 * 1024);
        while (!closed) {
            int b0 = rawIn.read();
            if (b0 < 0) throw new Exception("连接被关闭");
            int b1 = rawIn.read();
            if (b1 < 0) throw new Exception("连接被关闭");
            int op = b0 & 0x0f;
            boolean fin = (b0 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) {
                len = ((long) rawIn.read() << 8) | rawIn.read();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | rawIn.read();
            }
            byte[] payload = new byte[(int) len];
            int off = 0;
            while (off < payload.length) {
                int r = rawIn.read(payload, off, payload.length - off);
                if (r < 0) throw new Exception("读帧中断");
                off += r;
            }
            if (op == 0x9) {                                // ping → pong
                sendMasked(out, 0xA, payload);
                continue;
            }
            if (op == 0x8) throw new Exception("服务器关闭连接");
            if (op == 0x1) {                                // 文本帧（hello 等）
                handleText(new String(payload, "UTF-8"));
                continue;
            }
            if (op == 0x2 || op == 0x0) {
                frame.write(payload);
                if (!fin) continue;
                byte[] jpg = frame.toByteArray();
                frame.reset();
                android.util.Log.i("pc-dsh-ws", "收到帧 " + jpg.length + "B");
                if (jpg.length > 4) tickFps();
                if (jpg.length > 4) listener.onFrame(jpg);
            }
        }
    }

    private void handleText(String s) {
        try {
            // {"type":"hello","w":1920,"h":1200,...}
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("\"w\"\\s*:\\s*(\\d+)\\s*,\\s*\"h\"\\s*:\\s*(\\d+)").matcher(s);
            if (s.contains("hello") && m.find()) {
                listener.onMeta(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)));
            }
        } catch (Exception ignored) { }
    }

    private void tickFps() {
        fpsCount++;
        long now = System.currentTimeMillis();
        if (now - fpsAt >= 1000) {
            fps = (int) Math.round(fpsCount * 1000.0 / (now - fpsAt));
            fpsCount = 0;
            fpsAt = now;
        }
    }

    private void sendMasked(OutputStream out, int op, byte[] payload) {
        try {
            byte[] mask = new byte[4];
            new SecureRandom().nextBytes(mask);
            ByteArrayOutputStream b = new ByteArrayOutputStream(payload.length + 8);
            b.write(0x80 | op);
            if (payload.length < 126) b.write(0x80 | payload.length);
            else if (payload.length < 65536) {
                b.write(0x80 | 126);
                b.write((payload.length >> 8) & 0xFF);
                b.write(payload.length & 0xFF);
            } else {
                b.write(0x80 | 127);
                for (int i = 7; i >= 0; i--) b.write((int) (((long) payload.length >> (8 * i)) & 0xFF));
            }
            b.write(mask);
            for (int i = 0; i < payload.length; i++) b.write(payload[i] ^ mask[i & 3]);
            out.write(b.toByteArray());
            out.flush();
        } catch (Exception ignored) { }
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(512);
        int state = 0;
        while (state < 4) {
            int c = in.read();
            if (c < 0) throw new Exception("握手无响应");
            b.write(c);
            if ((state == 0 || state == 2) && c == '\r') state++;
            else if ((state == 1 || state == 3) && c == '\n') state++;
            else state = 0;
        }
        return new String(b.toByteArray(), "ISO-8859-1");
    }
}
