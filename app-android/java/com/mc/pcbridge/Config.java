package com.mc.pcbridge;

/** 固定配置：电脑那头的公网地址与令牌（隧道固定域名，不需要改）。 */
final class Config {
    // 电脑 dsh 的 MCP 服务（读会话 / 发消息 / 新建会话）
    static final String MCP_URL = "https://mcp.example.com/mcp";
    static final String MCP_TOKEN = "YOUR_MCP_TOKEN";

    // 派活台（看电脑屏幕 / 触控 / 发命令）
    static final String PANEL_URL = "https://panel.example.com";
    static final String PANEL_TOKEN = "YOUR_PANEL_TOKEN";

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
