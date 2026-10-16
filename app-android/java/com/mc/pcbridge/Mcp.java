package com.mc.pcbridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** 电脑那头 MCP 服务的客户端：sessions / session_progress / session_send / session_new / list_tasks。 */
final class Mcp {

    private final Map<String, String> headers = new HashMap<>();
    private int seq = 0;

    /** 每次请求现取配置（用户随时可能在「设置」里改地址/令牌） */
    private Map<String, String> headersNow() {
        headers.put("Authorization", "Bearer " + Config.MCP_TOKEN);
        headers.put("Content-Type", "application/json; charset=utf-8");
        return headers;
    }

    private String call(String tool, String argsJson) throws Exception {
        int id = ++seq;
        String body = "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"tools/call\",\"params\":{\"name\":\""
                + tool + "\",\"arguments\":" + argsJson + "}}";
        // 隧道 + 5G 环境下偶发丢包，自动重试两次（每次 12 秒超时，比一直干等强）
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                String resp = Net.postJson(Config.MCP_URL, body, headersNow());
                return textOf(resp);
            } catch (Exception e) {
                last = e;
                if (String.valueOf(e.getMessage()).contains("401")) break;   // 令牌不对，重试没意义
                try { Thread.sleep(400); } catch (InterruptedException ie) { throw e; }
            }
        }
        throw last == null ? new Exception("调用失败") : last;
    }

    private static String textOf(String resp) throws Exception {
        JSONObject o = new JSONObject(resp);
        if (o.has("error")) throw new Exception("MCP 错误: " + o.get("error"));
        JSONObject result = o.optJSONObject("result");
        if (result == null) return resp;
        if (result.has("isError") && result.optBoolean("isError")) return "❌ " + firstText(result);
        return firstText(result);
    }

    private static String firstText(JSONObject result) {
        JSONArray arr = result.optJSONArray("content");
        if (arr != null && arr.length() > 0) {
            JSONObject c = arr.optJSONObject(0);
            if (c != null && c.has("text")) return c.optString("text");
        }
        return result.toString();
    }

    /** 列出电脑上的会话（含正在进行的） */
    String sessions() throws Exception {
        return call("sessions", "{}");
    }

    /** 读某条会话的进度 */
    String progress(String id, int tail) throws Exception {
        return call("session_progress", "{\"id\":\"" + Net.esc(id) + "\",\"tail\":" + tail + "}");
    }

    /** 往某条会话里发一条消息（接着做） */
    String send(String id, String text, boolean steer) throws Exception {
        return call("session_send", "{\"id\":\"" + Net.esc(id) + "\",\"text\":\"" + Net.esc(text) + "\""
                + (steer ? ",\"mode\":\"steer\"" : "") + "}");
    }

    /** 在电脑上新建一条会话（可带第一条消息） */
    String newSession(String text, String cwd) throws Exception {
        String args = "{\"text\":\"" + Net.esc(text == null ? "" : text) + "\""
                + (cwd == null || cwd.isEmpty() ? "" : ",\"cwd\":\"" + Net.esc(cwd) + "\"") + "}";
        return call("session_new", args);
    }

    /** 让电脑 dsh 界面切到指定会话（手机点开哪条，电脑跟着切） */
    String focusSession(String id) throws Exception {
        return call("focus_session", "{\"sessionId\":\"" + Net.esc(id) + "\"}");
    }

    /** 电脑上「等你拍板」的任务（紧凑格式：CONFIRM|id|标题|问题|选项~选项） */
    String confirmations() throws Exception {
        return call("confirmations", "{}");
    }

    /** 回答某个待确认任务 */
    String answer(String id, String answer) throws Exception {
        return call("answer_confirmation", "{\"id\":\"" + Net.esc(id) + "\",\"answer\":\"" + Net.esc(answer) + "\"}");
    }

    /** 远程派活的任务列表 */
    String tasks() throws Exception {
        return call("list_tasks", "{}");
    }

    Map<String, String> headers() {
        return Collections.unmodifiableMap(headers);
    }
}
