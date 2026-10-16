package com.mc.pcbridge;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 配置：电脑那头的公网地址与令牌。
 *
 * 仓库里的默认值是**占位符**（公开仓库不带任何凭据）。
 * 首次运行时 App 会弹出设置框让你填自己的地址与令牌，存进本机 SharedPreferences；
 * 也可以用 app-android\build.ps1 配合 secrets.local.json 在构建时注入，二者取其一。
 */
final class Config {
    // 电脑 dsh 的 MCP 服务（读会话 / 发消息 / 新建会话 / 派活 / 确认）
    static String MCP_URL = "https://mcp.example.com/mcp";
    static String MCP_TOKEN = "YOUR_MCP_TOKEN";

    // 派活台（看电脑屏幕 / 触控 / 发命令）
    static String PANEL_URL = "https://panel.example.com";
    static String PANEL_TOKEN = "YOUR_PANEL_TOKEN";

    static final String PREFS = "pc-dsh-config";

    /** 从本机保存的设置里读取（有就用，没有就留构建时的值） */
    static void load(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String v;
            v = sp.getString("mcpUrl", "");     if (v != null && !v.isEmpty()) MCP_URL = v;
            v = sp.getString("mcpToken", "");   if (v != null && !v.isEmpty()) MCP_TOKEN = v;
            v = sp.getString("panelUrl", "");   if (v != null && !v.isEmpty()) PANEL_URL = v;
            v = sp.getString("panelToken", ""); if (v != null && !v.isEmpty()) PANEL_TOKEN = v;
        } catch (Exception ignored) { }
    }

    /** 保存设置 */
    static void save(Context ctx, String mcpUrl, String mcpToken, String panelUrl, String panelToken) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        // 只存域名/地址部分，用户可能粘贴成 https://host/mcp 或 host
        MCP_URL = normMcp(mcpUrl);
        MCP_TOKEN = mcpToken == null ? "" : mcpToken.trim();
        PANEL_URL = normPanel(panelUrl);
        PANEL_TOKEN = panelToken == null ? "" : panelToken.trim();
        e.putString("mcpUrl", MCP_URL);
        e.putString("mcpToken", MCP_TOKEN);
        e.putString("panelUrl", PANEL_URL);
        e.putString("panelToken", PANEL_TOKEN);
        e.apply();
    }

    private static String normMcp(String s) {
        String v = s == null ? "" : s.trim();
        if (v.isEmpty()) return v;
        if (!v.startsWith("http")) v = "https://" + v;
        if (!v.endsWith("/mcp")) v = v.replaceAll("/+$", "") + "/mcp";
        return v;
    }

    private static String normPanel(String s) {
        String v = s == null ? "" : s.trim();
        if (v.isEmpty()) return v;
        if (!v.startsWith("http")) v = "https://" + v;
        return v.replaceAll("/+$", "");
    }

    /** 是否已经配置好（默认占位符视为未配置） */
    static boolean isConfigured() {
        return MCP_TOKEN != null && !MCP_TOKEN.isEmpty() && !MCP_TOKEN.startsWith("YOUR_")
                && MCP_URL != null && MCP_URL.contains("://") && !MCP_URL.contains("example.com");
    }

    /** 实时画面：二进制帧走 WebSocket（比 HTTP 轮询快一个数量级） */
    static String wsScreenUrl() {
        String base = PANEL_URL;
        if (base.startsWith("https")) base = "wss" + base.substring(5);
        else if (base.startsWith("http")) base = "ws" + base.substring(4);
        return base + "/ws?t=" + PANEL_TOKEN + "&bin=1";
    }

    static final int REFRESH_MS = 3000;      // 回退到 HTTP 轮询时的间隔
    static final int WS_FALLBACK_MS = 7000;  // WS 多久没来帧就回退轮询
    static final int TIMEOUT_MS = 12000;     // 单次请求超时（隧道 2~5 秒）
}
