package com.mc.pcbridge;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/** 极简 HTTP：只用 JDK/Android 自带的 HttpURLConnection，不引第三方库。 */
final class Net {

    static String get(String url) throws Exception {
        return request("GET", url, null, null);
    }

    static String get(String url, Map<String, String> headers) throws Exception {
        return request("GET", url, null, headers);
    }

    static String postJson(String url, String body, Map<String, String> headers) throws Exception {
        return request("POST", url, body, headers);
    }

    static byte[] getBytes(String url) throws Exception {
        HttpURLConnection c = open("GET", url, null, null);
        try {
            int code = c.getResponseCode();
            if (code / 100 != 2) throw new Exception("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream(128 * 1024);
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static String request(String method, String url, String body, Map<String, String> headers) throws Exception {
        HttpURLConnection c = open(method, url, body, headers);
        try {
            int code = c.getResponseCode();
            InputStream in = code / 100 == 2 ? c.getInputStream() : c.getErrorStream();
            String text = in == null ? "" : readAll(in);
            if (code / 100 != 2) throw new Exception("HTTP " + code + " " + trim(text, 200));
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String method, String url, String body, Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(Config.TIMEOUT_MS);
        c.setReadTimeout(Config.TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("User-Agent", "pc-dsh-app/1.0 (Android)");
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        if (body != null) {
            c.setDoOutput(true);
            byte[] b = body.getBytes("UTF-8");
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setFixedLengthStreamingMode(b.length);
            OutputStream os = c.getOutputStream();
            os.write(b);
            os.flush();
            os.close();
        }
        return c;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(16 * 1024);
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    private static String trim(String s, int n) {
        return s == null ? "" : (s.length() <= n ? s : s.substring(0, n) + "…");
    }

    static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.toString();
    }
}
