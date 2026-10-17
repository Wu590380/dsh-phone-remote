package com.mc.pcbridge;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.method.ScrollingMovementMethod;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 手机上的「电脑 dsh」：
 *   全屏（隐藏手机状态栏/导航栏），横屏左右分栏
 *   只看屏幕：画面等比铺满可用区域，点哪点哪；长按画面＝把焦点给输入框（手机键盘打字）
 *   点底部状态行 = 切换「高清静图 / 实时画面」（界面上不再放多余按钮）
 *   打开会话：屏幕留在左侧，右侧放会话列表 / 进度 + 输入
 */
public class MainActivity extends Activity {

    private static final int BG = Color.parseColor("#0E1016");
    private static final int CARD = Color.parseColor("#171A22");
    private static final int FG = Color.parseColor("#E6E9F0");
    private static final int MUTED = Color.parseColor("#9AA4B8");
    private static final int DIM = Color.parseColor("#616B80");
    private static final int ACCENT = Color.parseColor("#3B6EF6");
    private static final int GREEN = Color.parseColor("#22C55E");
    private static final int ORANGE = Color.parseColor("#F59E0B");
    private static final int GRAY = Color.parseColor("#6B7280");

    private final ExecutorService pool = Executors.newFixedThreadPool(2);       // 只管画面抓取
    private final ExecutorService ioPool = Executors.newCachedThreadPool();     // 打字/点击/MCP：永不被抓屏堵住
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Mcp mcp = new Mcp();

    private LinearLayout content;
    private LinearLayout screenBox;
    private FrameLayout panelBox;
    private View panelSessions, panelDetail;
    private boolean panelShown = false;

    private LinearLayout sessionsBox;
    private LinearLayout confirmBox;
    private String lastSessions = "";
    private boolean showRaw = false;

    private TextView detailTitle, progressText;
    private LinearLayout detailConfirmBox;   // 会话内的"待拍板"区
    private final java.util.Set<String> pendingBySession = new java.util.HashSet<>();   // 有待拍板的会话
    private int pendingUnassigned = 0;                                                   // 没指定会话的待拍板数量
    private String lastSessionsText = "";                                                // 缓存会话列表原文，便于另一份数据到达后重绘
    private EditText sendBox;
    private String currentSession = "";
    private String lastProgress = "";
    private boolean progressRaw = false;
    private boolean newMode = false;

    private FrameLayout screenHolder;
    private ImageView screenView;
    private TextView screenStatus;
    private EditText typeBox;
    private float fitScale = 1f;
    private int pcW = 1920, pcH = 1200;
    private boolean polling = false, hdMode = false, wsFellBack = false;
    private Runnable ticker, longPressTask;
    private boolean longPressFired = false;
    private boolean fillMode = false;          // false=完整显示（留黑边） true=铺满（裁掉超出部分）
    private long lastTapAt = 0;
    private float touchDownX = 0, touchDownY = 0;
    private WsClient ws;
    private volatile long lastWsFrameAt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Config.load(this);            // 必须最先加载：界面里的 WebSocket 一建好就用地址了
        hideSystemBars();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.addView(buildHeader());

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.HORIZONTAL);
        screenBox = (LinearLayout) buildScreenPage();
        panelBox = new FrameLayout(this);
        panelSessions = buildSessionsPage();
        panelDetail = buildDetailPage();
        panelBox.addView(panelSessions);
        panelBox.addView(panelDetail);
        content.addView(screenBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        content.addView(panelBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        applyLayout();
        if (!Config.isConfigured()) {
            ui.postDelayed(this::showSetupDialog, 400);
        } else {
            refreshSessions();
        }
    }

    /** 隐藏手机状态栏与导航栏（沉浸式），把空间全给画面 */
    private void hideSystemBars() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        } catch (Throwable ignored) { }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyLayout();
    }

    private void applyLayout() {
        boolean land = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        if (!panelShown) {
            panelBox.setVisibility(View.GONE);
            screenBox.setVisibility(View.VISIBLE);
            LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) screenBox.getLayoutParams();
            lp.width = ViewGroup.LayoutParams.MATCH_PARENT; lp.weight = 0;
            screenBox.setLayoutParams(lp);
            startScreen();
        } else {
            panelBox.setVisibility(View.VISIBLE);
            if (land) {
                screenBox.setVisibility(View.VISIBLE);
                LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) screenBox.getLayoutParams();
                lp.width = 0; lp.weight = 1;
                screenBox.setLayoutParams(lp);
                LinearLayout.LayoutParams rp = (LinearLayout.LayoutParams) panelBox.getLayoutParams();
                rp.width = Math.round(screenW * 0.45f); rp.weight = 0;
                panelBox.setLayoutParams(rp);
                startScreen();
            } else {
                screenBox.setVisibility(View.GONE);
                stopScreen();
                LinearLayout.LayoutParams rp = (LinearLayout.LayoutParams) panelBox.getLayoutParams();
                rp.width = ViewGroup.LayoutParams.MATCH_PARENT; rp.weight = 0;
                panelBox.setLayoutParams(rp);
            }
        }
        ui.postDelayed(this::layoutScreen, 60);
    }

    private void openPanel(boolean showDetail) {
        panelShown = true;
        panelSessions.setVisibility(showDetail ? View.GONE : View.VISIBLE);
        panelDetail.setVisibility(showDetail ? View.VISIBLE : View.GONE);
        applyLayout();
    }

    /* ------------------------------ 顶部（极简，3 个按钮） ------------------------------ */

    private View buildHeader() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#15171D"));
        bar.setPadding(dp(10), dp(4), dp(6), dp(4));

        TextView title = new TextView(this);
        title.setText("电脑 dsh");
        title.setTextColor(FG);
        title.setTextSize(15);
        title.setTypeface(null, Typeface.BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        bar.addView(smallBtn("会话", () -> { openPanel(false); refreshSessions(); }));
        bar.addView(smallBtn("只有屏幕", () -> { panelShown = false; applyLayout(); }));
        bar.addView(smallBtn("刷新", () -> {
            if (panelDetail.getVisibility() == View.VISIBLE) reloadDetail();
            else refreshSessions();
        }));
        bar.addView(smallBtn("设置", this::showSetupDialog));

        return bar;
    }

    /* ------------------------------ 屏幕页 ------------------------------ */

    private View buildScreenPage() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(0, 0, 0, 0);

        screenHolder = new FrameLayout(this);
        screenHolder.setBackgroundColor(Color.BLACK);
        screenHolder.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> layoutScreen());

        screenView = new ImageView(this);
        screenView.setScaleType(ImageView.ScaleType.FIT_XY);   // 尺寸由 layoutScreen 精确算好（等比、不变形）
        screenView.setBackgroundColor(Color.BLACK);
        longPressTask = () -> { longPressFired = true; toast("在右侧会话的输入框里打字"); };
        screenView.setOnTouchListener((v, ev) -> {
            int act = ev.getAction();
            if (act == MotionEvent.ACTION_DOWN) {
                longPressFired = false;
                touchDownX = ev.getX(); touchDownY = ev.getY();
                ui.postDelayed(longPressTask, 480);          // 长按 = 把焦点交给输入框（弹手机键盘）
            } else if (act == MotionEvent.ACTION_MOVE) {
                if (Math.abs(ev.getX() - touchDownX) > dp(14) || Math.abs(ev.getY() - touchDownY) > dp(14)) ui.removeCallbacks(longPressTask);
            } else if (act == MotionEvent.ACTION_UP) {
                ui.removeCallbacks(longPressTask);
                long nowMs = System.currentTimeMillis();
                if (nowMs - lastTapAt < 320) {                // 双击 = 铺满 / 完整 切换
                    lastTapAt = 0;
                    fillMode = !fillMode;
                    layoutScreen();
                    toast(fillMode ? "铺满（裁掉超出部分）" : "完整显示（留黑边）");
                    return true;
                }
                lastTapAt = nowMs;
                if (!longPressFired && fitScale > 0) {        // 短按 = 点电脑那个位置
                    int px = (int) (ev.getX() / fitScale), py = (int) (ev.getY() / fitScale);
                    if (px < 0) px = 0; if (py < 0) py = 0;
                    if (px >= pcW) px = pcW - 1; if (py >= pcH) py = pcH - 1;
                    clickPc(px, py);
                }
            } else if (act == MotionEvent.ACTION_CANCEL) {
                ui.removeCallbacks(longPressTask);
            }
            return true;
        });
        screenHolder.addView(screenView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        page.addView(screenHolder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 细状态行：点它 = 高清静图 / 回实时
        screenStatus = new TextView(this);
        screenStatus.setTextColor(MUTED);
        screenStatus.setTextSize(10);
        screenStatus.setPadding(dp(6), dp(3), dp(6), dp(3));
        screenStatus.setText("正在连接实时画面…");
        screenStatus.setOnClickListener(v -> toggleHd());
        page.addView(screenStatus);

        // 注：屏幕区不再放输入框（按需求只保留会话里的那个）
        return page;
    }

    /** 画面等比铺满可用区域（不变形），并记录换算比例供点按使用 */
    private void layoutScreen() {
        if (screenHolder == null || screenView == null) return;
        int availW = screenHolder.getWidth(), availH = screenHolder.getHeight();
        if (availW <= 0 || availH <= 0) return;
        float sFit = Math.min((float) availW / pcW, (float) availH / pcH);
        float sFill = Math.max((float) availW / pcW, (float) availH / pcH);
        fitScale = fillMode ? sFill : sFit;
        int w = Math.round(pcW * fitScale), h = Math.round(pcH * fitScale);
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) screenView.getLayoutParams();
        if (lp.width != w || lp.height != h) {
            lp.width = w; lp.height = h; lp.gravity = Gravity.CENTER;
            screenView.setLayoutParams(lp);
        }
    }

    private void startScreen() {
        if (screenBox.getVisibility() != View.VISIBLE) return;
        wsFellBack = false;
        lastWsFrameAt = 0;
        if (ws == null) {
            try {
                ws = new WsClient(Config.wsScreenUrl(), new ScreenListener(this));
                ws.start();
            } catch (Exception e) {
                wsFellBack = true;
                startPolling();
                return;
            }
        }
        ui.postDelayed(() -> {
            if (screenBox.getVisibility() != View.VISIBLE) return;
            if (lastWsFrameAt == 0 && !wsFellBack) { wsFellBack = true; startPolling(); }
        }, Config.WS_FALLBACK_MS);
    }

    private void stopScreen() {
        stopPolling();
        if (ws != null) { ws.close(); ws = null; }
    }

    private void startPolling() {
        if (polling) return;
        polling = true;
        ticker = () -> {
            if (!polling || hdMode) return;
            shotOnce();
            ui.postDelayed(ticker, Config.REFRESH_MS);
        };
        ui.post(ticker);
    }

    private void stopPolling() { polling = false; }

    /** 点状态行：高清静图 ↔ 实时画面 */
    private void toggleHd() {
        if (hdMode) {
            hdMode = false;
            screenStatus.setText("回到实时画面…");
            return;
        }
        hdMode = true;
        screenStatus.setText("正在抓高清图（原生 1920×1200）…");
        ioPool.execute(() -> {
            try {
                byte[] jpg = Net.getBytes(Config.PANEL_URL + "/api/shot.jpg?w=1920&q=90&t=" + Config.PANEL_TOKEN);
                Bitmap bmp = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                if (bmp == null) throw new Exception("解码失败");
                final int len = jpg.length;
                ui.post(() -> {
                    layoutScreen();
                    screenView.setImageBitmap(bmp);
                    screenStatus.setText("高清静图 " + bmp.getWidth() + "×" + bmp.getHeight() + " · " + len / 1024 + "KB · 点这里回实时");
                });
            } catch (Exception e) {
                ui.post(() -> { screenStatus.setText("高清失败：" + e.getMessage() + "（点这里重试）"); hdMode = false; });
            }
        });
    }

    private void shotOnce() {
        pool.execute(() -> {
            try {
                byte[] jpg = Net.getBytes(Config.PANEL_URL + "/api/shot.jpg?t=" + Config.PANEL_TOKEN);
                Bitmap bmp = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                if (bmp == null) throw new Exception("解码失败");
                final int len = jpg.length;
                ui.post(() -> {
                    if (hdMode) return;
                    layoutScreen();
                    screenView.setImageBitmap(bmp);
                    screenStatus.setText(bmp.getWidth() + "×" + bmp.getHeight() + " · 实时(轮询) · " + len / 1024 + "KB · 点这里看高清");
                });
            } catch (Exception e) {
                ui.post(() -> screenStatus.setText("抓屏失败：" + e.getMessage()));
            }
        });
    }

    /* ---------- WebSocket 画面回调（ScreenListener 调用） ---------- */

    void onWsFrame(byte[] jpeg) {
        lastWsFrameAt = System.currentTimeMillis();
        final Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        if (bmp == null) return;
        final int len = jpeg.length;
        ui.post(() -> {
            if (hdMode || screenBox.getVisibility() != View.VISIBLE) return;
            layoutScreen();
            screenView.setImageBitmap(bmp);
            int fps = ws == null ? 0 : ws.fps();
            screenStatus.setText(bmp.getWidth() + "×" + bmp.getHeight() + " · 实时 " + fps + " fps · " + len / 1024 + "KB/帧 · 点这里看高清");
        });
    }

    void onWsMeta(int w, int h) {
        if (w > 0 && h > 0 && (w != pcW || h != pcH)) { pcW = w; pcH = h; ui.post(this::layoutScreen); }
    }

    void onWsState(String state) {
        ui.post(() -> { if (!hdMode) screenStatus.setText(state + " · 点这里看高清"); });
    }

    /* ------------------------------ 手机键盘打字 ------------------------------ */

    /** 长按画面：把焦点给输入框并弹出手机键盘 */
    private void focusTypeBox() {
        if (typeBox == null) return;
        typeBox.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(typeBox, InputMethodManager.SHOW_IMPLICIT);
        toast("现在打字会直接进电脑");
    }

    /** 发送输入框里的字（withEnter=true 顺带发一个回车） */
    private void sendTyped(boolean withEnter) {
        if (typeBox == null) return;
        String s = typeBox.getText().toString();
        if (s.isEmpty() && !withEnter) { toast("先打点字"); return; }
        typeBox.setText("");
        final String shown = s.length() > 20 ? s.substring(0, 20) + "…" : s;
        if (!s.isEmpty()) toast("正在送到电脑：" + shown);      // 立刻给回执，别让人以为没反应
        if (!s.isEmpty()) sendText(s);
        if (withEnter) sendKey("enter");
    }

    private void sendText(String s) {
        ioPool.execute(() -> {
            try {
                Net.postJson(Config.PANEL_URL + "/api/input?t=" + Config.PANEL_TOKEN,
                        "{\"action\":\"text\",\"text\":\"" + Net.esc(s) + "\"}", null);
                ui.post(() -> screenStatus.setText("已送到电脑：" + (s.length() > 18 ? s.substring(0, 18) + "…" : s)));
            } catch (Exception e) { ui.post(() -> toast("打字发送失败：" + e.getMessage())); }
        });
    }

    private void sendKey(String key) {
        ioPool.execute(() -> {
            try {
                Net.postJson(Config.PANEL_URL + "/api/input?t=" + Config.PANEL_TOKEN,
                        "{\"action\":\"key\",\"keys\":\"" + key + "\"}", null);
            } catch (Exception e) { ui.post(() -> toast("按键失败：" + e.getMessage())); }
        });
    }

    /* ------------------------------ 会话列表 ------------------------------ */

    private View buildSessionsPage() {
        ScrollView sv = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(10), dp(8), dp(10), dp(24));
        confirmBox = new LinearLayout(this);
        confirmBox.setOrientation(LinearLayout.VERTICAL);
        col.addView(confirmBox);
        sessionsBox = new LinearLayout(this);
        sessionsBox.setOrientation(LinearLayout.VERTICAL);
        col.addView(sessionsBox);
        sv.addView(col);
        return sv;
    }

    private void refreshSessions() {
        if (lastSessions.isEmpty()) hint("正在读电脑上的会话…");
        else renderSessions(lastSessions);
        ioPool.execute(() -> {                 // ① 确认队列（并行拉，不阻塞列表；只在会话行上打小标记）
            try {
                String cf = mcp.confirmations();
                java.util.Set<String> ids = new java.util.HashSet<>();
                int un = 0;
                for (String ln : cf.split("\n")) {
                    String s2 = ln.trim();
                    if (!s2.startsWith("CONFIRM|")) continue;
                    String[] p2 = s2.substring(8).split("\\|", -1);
                    if (p2.length < 5) continue;
                    if (p2[1].isEmpty()) un++; else ids.add(p2[1]);
                }
                final int unFinal = un;
                final java.util.Set<String> idsFinal = ids;
                ui.post(() -> {
                    pendingBySession.clear();
                    pendingBySession.addAll(idsFinal);
                    pendingUnassigned = unFinal;
                    if (!lastSessionsText.isEmpty()) renderSessions(lastSessionsText);
                });
            } catch (Exception ignored) { }
        });
        ioPool.execute(() -> {                 // ② 会话列表
            try {
                String text = mcp.sessions();
                ui.post(() -> { lastSessionsText = text; renderSessions(text); });
            } catch (Exception e) {
                ui.post(() -> hint("读会话失败：" + e.getMessage()));
            }
        });
    }

    /** 顶部「等你拍板」区块：手机上一键回答电脑的确认请求 */
    private void renderConfirmations(String text, String onlySession) {
        if (detailConfirmBox == null) return;
        detailConfirmBox.removeAllViews();
        if (text == null || text.trim().isEmpty() || text.trim().equals("NONE")) return;

        TextView head = new TextView(this);
        head.setText("⚠️ 电脑上有事等你拍板");
        head.setTextColor(ORANGE);
        head.setTextSize(15);
        head.setTypeface(null, Typeface.BOLD);
        head.setPadding(dp(4), dp(6), dp(4), dp(6));
        detailConfirmBox.addView(head);

        for (String line : text.split("\n")) {
            String s = line.trim();
            if (!s.startsWith("CONFIRM|")) continue;
            String[] parts = s.substring(8).split("\\|", -1);
            if (parts.length < 5) continue;
            final String id = parts[0], sid = parts[1], title = parts[2], q = parts[3], opts = parts[4];
            if (onlySession != null && !onlySession.isEmpty() && !sid.isEmpty() && !sid.equals(onlySession)) continue;

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackgroundColor(Color.parseColor("#3A2A12"));
            card.setPadding(dp(12), dp(10), dp(12), dp(10));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(8);
            card.setLayoutParams(lp);

            TextView t1 = new TextView(this);
            t1.setText(title.isEmpty() ? "任务" : title);
            t1.setTextColor(MUTED);
            t1.setTextSize(12);
            card.addView(t1);

            TextView t2 = new TextView(this);
            t2.setText(q);
            t2.setTextColor(FG);
            t2.setTextSize(15);
            card.addView(t2);

            if (!opts.isEmpty()) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setPadding(0, dp(6), 0, 0);
                for (String o : opts.split("~")) {
                    final String opt = o.trim();
                    if (opt.isEmpty()) continue;
                    String label = opt;
                    if (label.length() > 14) label = label.substring(0, 14) + "…";
                    row.addView(smallBtn(label, () -> answerConfirm(id, opt)));
                }
                card.addView(row);
            }
            detailConfirmBox.addView(card);
        }
    }

    private void answerConfirm(String id, String answer) {
        toast("正在告诉电脑：" + answer);
        ioPool.execute(() -> {
            try {
                String r = mcp.answer(id, answer);
                ui.post(() -> toast("已答复电脑"));
                Thread.sleep(800);
                reloadDetail();
            } catch (Exception e) {
                ui.post(() -> toast("答复失败：" + e.getMessage()));
            }
        });
    }
    /** 首次运行（或未配置）时的设置框：填自己的 MCP / 面板地址与令牌 */
    private void showSetupDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        box.setPadding(pad, pad, pad, pad);

        TextView tip = new TextView(this);
        tip.setText("填你自己电脑的地址与令牌（填一次即可，存在本机）：\n· MCP：手机给电脑下指令用的接口\n· 面板：电脑屏幕画面与触控");
        tip.setTextSize(13);
        tip.setTextColor(Color.parseColor("#555555"));
        box.addView(tip);

        final EditText eMcp = field(box, "MCP 地址（如 https://mcp.你的域名/mcp）", Config.MCP_URL);
        final EditText eMcpTok = field(box, "MCP 令牌", Config.MCP_TOKEN);
        final EditText ePanel = field(box, "面板地址（如 https://panel.你的域名）", Config.PANEL_URL);
        final EditText ePanelTok = field(box, "面板令牌", Config.PANEL_TOKEN);

        new android.app.AlertDialog.Builder(this)
                .setTitle("连接设置")
                .setView(box)
                .setCancelable(false)
                .setPositiveButton("保存并连接", (d, w) -> {
                    Config.save(this, eMcp.getText().toString(), eMcpTok.getText().toString(),
                            ePanel.getText().toString(), ePanelTok.getText().toString());
                    toast("已保存，开始连接电脑…");
                    stopScreen();
                    stopPolling();
                    startScreen();
                    refreshSessions();
                })
                .setNegativeButton("稍后", (d, w) -> toast("未配置；右上角「设置」可随时再填"))
                .show();
    }

    private EditText field(LinearLayout box, String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setTextColor(Color.parseColor("#222222"));
        e.setHintTextColor(Color.parseColor("#888888"));
        e.setTextSize(14);
        if (value != null && !value.startsWith("YOUR_") && !value.contains("example.com")) e.setText(value);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        box.addView(e, lp);
        return e;
    }

    private void hint(String msg) {
        sessionsBox.removeAllViews();
        TextView t = new TextView(this);
        t.setText(msg);
        t.setTextColor(MUTED);
        t.setTextSize(14);
        t.setPadding(dp(4), dp(12), dp(4), dp(12));
        sessionsBox.addView(t);
    }

    private static final Pattern IDP = Pattern.compile("session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern HEAD = Pattern.compile("^-\\s*\\[(.+?)\\]\\s*(.*)$");

    private static class Sess {
        String id = "", status = "", title = "", sum = "", doing = "", cwd = "", ago = "";
        String groupTitle = "";      // 工具给的工作区标题（与电脑侧栏一致）
    }
    private final java.util.Set<String> expanded = new java.util.HashSet<>();

    private void renderSessions(String text) {
        lastSessions = text;
        sessionsBox.removeAllViews();

        LinearLayout addCard = new LinearLayout(this);
        addCard.setGravity(Gravity.CENTER_VERTICAL);
        addCard.setBackgroundColor(Color.parseColor("#1E2A44"));
        addCard.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        alp.bottomMargin = dp(8);
        addCard.setLayoutParams(alp);
        TextView addT = new TextView(this);
        addT.setText("＋ 新建会话");
        addT.setTextColor(Color.WHITE);
        addT.setTextSize(15);
        addT.setTypeface(null, Typeface.BOLD);
        addCard.addView(addT);
        addCard.setOnClickListener(v -> openNewSession());
        sessionsBox.addView(addCard);

        List<Sess> list = new ArrayList<>();
        Sess cur = null;
        String curWorkspaceTitle = "";
        for (String raw : text.split("\n")) {
            String s = raw.trim();
            if (s.isEmpty()) continue;
            Matcher gh = Pattern.compile("^==\\s*工作区:\\s*(.+?)\\s*\\|").matcher(s);
            if (gh.find()) {              // == 工作区: 标题 | 路径 | n 条 ==
                String gt = gh.group(1);
                curWorkspaceTitle = gt.trim();
                continue;
            }
            Matcher h = HEAD.matcher(s);
            if (h.find()) {
                cur = new Sess();
                cur.status = h.group(1);
                String rest = h.group(2);
                Matcher id = IDP.matcher(rest);
                if (id.find()) { cur.id = id.group(); rest = rest.replace(id.group(), ""); }
                Matcher id2 = IDP.matcher(s);
                if (cur.id.isEmpty() && id2.find()) cur.id = id2.group();
                cur.title = rest.replaceAll("[（()）\\s]+$", "").replaceAll("^[（()）\\s]+", "").trim();
                cur.groupTitle = curWorkspaceTitle;
                list.add(cur);
                continue;
            }
            if (cur == null) continue;
            Matcher idOnly = IDP.matcher(s);
            if (s.startsWith("(") && idOnly.find()) { if (cur.id.isEmpty()) cur.id = idOnly.group(); continue; }
            if (s.startsWith("目录")) {
                Matcher mc = Pattern.compile("目录[:：]?\\s*([^\\s]+)").matcher(s);
                if (mc.find()) cur.cwd = mc.group(1);
                StringBuilder sb = new StringBuilder();
                Matcher m1 = Pattern.compile("待办\\s*([0-9]+/[0-9]+)").matcher(s);
                if (m1.find()) sb.append("待办 ").append(m1.group(1)).append(" · ");
                Matcher m2 = Pattern.compile("轮次\\s*([0-9]+)").matcher(s);
                if (m2.find()) sb.append("第 ").append(m2.group(1)).append(" 轮 · ");
                Matcher m3 = Pattern.compile("最后活动\\s*([0-9]+\\s*[^\\s]{0,3}前|刚刚)").matcher(s);
                if (m3.find()) { cur.ago = m3.group(1); sb.append(m3.group(1)); }
                cur.sum = sb.toString().replaceAll("\\s*·\\s*$", "");
            } else if (s.startsWith("正在做")) {
                cur.doing = s.replaceFirst("^正在做[:：]?\\s*", "");
            }
        }

        if (list.isEmpty()) {
            hint("没读到会话，点「刷新」再试");
        } else {
            // 按工作区（目录）分组，跟电脑左侧栏一样
            java.util.LinkedHashMap<String, List<Sess>> groups = new java.util.LinkedHashMap<>();
            for (Sess s : list) {
                String key = !s.groupTitle.isEmpty() ? s.groupTitle : (s.cwd.isEmpty() ? "（未知目录）" : s.cwd);
                List<Sess> g = groups.get(key);
                if (g == null) { g = new ArrayList<>(); groups.put(key, g); }
                g.add(s);
            }
            int total = list.size();
            TextView sect = new TextView(this);
            sect.setText("工作区");
            sect.setTextColor(DIM);
            sect.setTextSize(12);
            sect.setPadding(dp(4), dp(2), dp(4), dp(4));
            sessionsBox.addView(sect);
            for (java.util.Map.Entry<String, List<Sess>> e : groups.entrySet()) {
                String dir = e.getKey();
                List<Sess> g = e.getValue();
                sessionsBox.addView(workgroupHeader(dir, g.size()));

                boolean exp = expanded.contains(dir);
                int show = exp ? g.size() : Math.min(g.size(), 5);
                for (int i = 0; i < show; i++) sessionsBox.addView(sessionCard(g.get(i)));
                if (g.size() > 5) {
                    TextView more = new TextView(this);
                    more.setText(exp ? "▲ 收起" : "▼ 展开其余 " + (g.size() - 5) + " 个会话");
                    more.setTextColor(ACCENT);
                    more.setTextSize(13);
                    more.setPadding(dp(14), dp(2), dp(4), dp(10));
                    more.setOnClickListener(v -> {
                        if (expanded.contains(dir)) expanded.remove(dir); else expanded.add(dir);
                        renderSessions(lastSessions);
                    });
                    sessionsBox.addView(more);
                }
            }
            TextView cnt = new TextView(this);
            cnt.setText("共 " + groups.size() + " 个工作区 · " + total + " 条会话");
            cnt.setTextColor(DIM);
            cnt.setTextSize(11);
            cnt.setPadding(dp(4), dp(6), dp(4), dp(10));
            sessionsBox.addView(cnt);
            if (pendingUnassigned > 0) {
                TextView un2 = new TextView(this);
                un2.setText("⚠️ 另有 " + pendingUnassigned + " 项待拍板（不属于特定会话，打开任一会话可见）");
                un2.setTextColor(ORANGE);
                un2.setTextSize(12);
                un2.setPadding(dp(4), 0, dp(4), dp(8));
                sessionsBox.addView(un2);
            }
        }

        TextView toggle = new TextView(this);
        toggle.setText(showRaw ? "▲ 收起原始输出" : "▼ 原始输出");
        toggle.setTextColor(DIM);
        toggle.setTextSize(11);
        toggle.setPadding(dp(4), dp(4), dp(4), dp(4));
        toggle.setOnClickListener(v -> { showRaw = !showRaw; renderSessions(lastSessions); });
        sessionsBox.addView(toggle);

        if (showRaw) {
            TextView rawText = new TextView(this);
            rawText.setText(text);
            rawText.setTextColor(DIM);
            rawText.setTextSize(10);
            rawText.setTypeface(Typeface.MONOSPACE);
            sessionsBox.addView(rawText);
        }
    }

    private int statusColor(String st) {
        if (st.contains("进行中")) return GREEN;
        if (st.contains("确认") || st.contains("等你")) return ORANGE;
        return GRAY;
    }

    private String statusText(String st) {
        if (st.contains("进行中")) return "进行中";
        if (st.contains("确认") || st.contains("等你")) return "等你确认";
        if (st.contains("结束")) return "已结束";
        return st;
    }

    /** 工作区分组标题（跟电脑左侧栏的"工作区"一样） */
    private View workgroupHeader(String dir, int count) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(4), dp(10), dp(4), dp(6));
        TextView t = new TextView(this);
        String name = dir;
        int p = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));   // 取文件夹名（单个反斜杠！）
        if (p >= 0 && p + 1 < dir.length()) name = dir.substring(p + 1);
        t.setText(name);
        t.setTextColor(Color.parseColor("#AEB8CC"));   // 跟电脑一样：灰字
        t.setTextSize(14);
        t.setTypeface(Typeface.SANS_SERIF, Typeface.NORMAL);   // 跟电脑一样：不加粗
        box.addView(t);
        return box;
    }

    /** 会话一行：状态点 + 标题（左） + 多久前（右）——跟电脑左侧栏一样，点整行=看进度 */
    private View sessionCard(final Sess s) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(9), dp(8), dp(9));

        TextView dot = new TextView(this);
        dot.setText("●");
        dot.setTextColor(statusColor(s.status));
        dot.setTextSize(11);
        row.addView(dot);

        TextView title = new TextView(this);
        title.setText(s.title.isEmpty() ? "（无标题）" : s.title);
        title.setTextColor(FG);
        title.setTextSize(15);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(8);
        row.addView(title, tlp);

        if (pendingBySession.contains(s.id)) {
            TextView warn = new TextView(this);
            warn.setText("⚠️");
            warn.setTextSize(13);
            warn.setPadding(0, 0, dp(6), 0);
            row.addView(warn);
        }
        TextView ago = new TextView(this);
        ago.setText(shortAgo(s.ago));
        ago.setTextColor(DIM);
        ago.setTextSize(12);
        row.addView(ago);

        row.setOnClickListener(v -> openDetail(s.id, s.title));
        row.setOnLongClickListener(v -> { openDetail(s.id, s.title); return true; });
        return row;
    }

    /** "27 秒前" → "刚刚"，"5 分钟前" → "5分钟"，跟电脑侧栏一致 */
    private String shortAgo(String a) {
        if (a == null || a.isEmpty()) return "";
        if (a.contains("秒")) return "刚刚";
        return a.replace("前", "").replace(" ", "").replace("个月", "月");
    }
    /* ------------------------------ 会话详情 / 新建 ------------------------------ */

    private View buildDetailPage() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(10), dp(8), dp(10), dp(8));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(smallBtn("← 会话列表", () -> { openPanel(false); refreshSessions(); }));
        detailTitle = new TextView(this);
        detailTitle.setTextColor(FG);
        detailTitle.setTextSize(14);
        detailTitle.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(6);
        top.addView(detailTitle, tlp);
        top.addView(smallBtn("原始", () -> { progressRaw = !progressRaw; showProgress(lastProgress); }));
        page.addView(top);

        detailConfirmBox = new LinearLayout(this);
        detailConfirmBox.setOrientation(LinearLayout.VERTICAL);
        page.addView(detailConfirmBox);

        ScrollView sv = new ScrollView(this);
        progressText = new TextView(this);
        progressText.setTextColor(FG);
        progressText.setTextSize(13);
        progressText.setLineSpacing(dp(2), 1f);
        progressText.setMovementMethod(new ScrollingMovementMethod());
        progressText.setPadding(dp(2), dp(10), dp(2), dp(8));
        sv.addView(progressText);
        page.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        sendBox = new EditText(this);
        sendBox.setHint("发给电脑的话");
        sendBox.setTextColor(FG);
        sendBox.setHintTextColor(MUTED);
        sendBox.setTextSize(14);
        sendBox.setSingleLine(true);
        sendBox.setImeOptions(EditorInfo.IME_ACTION_SEND);
        sendBox.setOnEditorActionListener((v, actionId, ev2) -> { doSend(); return true; });
        row.addView(sendBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(smallBtn("发送", this::doSend));
        page.addView(row);
        return page;
    }

    private void openDetail(String id, String title) {
        if (id != null && !id.isEmpty()) {          // 手机点开哪条，电脑界面就切到哪条
            final String fid = id;
            ioPool.execute(() -> { try { mcp.focusSession(fid); } catch (Exception ignored) { } });
        }
        newMode = false;
        currentSession = id;
        detailTitle.setText(title.isEmpty() ? "会话" : title);
        progressText.setText("正在读进度…");
        lastProgress = "";
        openPanel(true);
        reloadDetail();
    }

    private void openNewSession() {
        newMode = true;
        currentSession = "";
        lastProgress = "";
        detailTitle.setText("新建会话");
        progressText.setText("在下面写第一句话，发出去电脑就会新建一条会话开始干。\n\n目录默认 E:\\harness-workspace");
        sendBox.setHint("比如：帮我看看这个项目怎么跑起来");
        openPanel(true);
        // 直接把键盘弹出来，不然看着像"没反应"
        sendBox.postDelayed(() -> {
            sendBox.requestFocus();
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(sendBox, InputMethodManager.SHOW_IMPLICIT);
            toast("写第一句话，点发送就在电脑上开新会话");
        }, 250);
    }

    private void reloadDetail() {
        if (currentSession.isEmpty()) return;
        final String id = currentSession;
        ioPool.execute(() -> {
            try {
                String t = mcp.progress(id, 4);
                ui.post(() -> { lastProgress = t; showProgress(t); });
            } catch (Exception e) {
                ui.post(() -> progressText.setText("读进度失败：" + e.getMessage()));
            }
        });
        ioPool.execute(() -> {
            try {
                String cf = mcp.confirmations();
                ui.post(() -> renderConfirmations(cf, id));
            } catch (Exception ignored) { }
        });
    }

    private void showProgress(String raw) {
        if (raw == null || raw.isEmpty()) { progressText.setText("（还没读到）"); return; }
        if (progressRaw) { progressText.setText(raw); return; }

        StringBuilder outline = new StringBuilder();
        List<String> chat = new ArrayList<>();
        int toolCalls = 0;
        for (String line : raw.split("\n")) {
            String s = line.trim();
            if (s.isEmpty()) continue;
            if (s.startsWith("[调用]") || s.startsWith("[结果]")) { toolCalls++; continue; }
            if (s.contains("<system-reminder>")) continue;
            if (s.startsWith("[助手]")) { chat.add("电脑：" + shorten(s.substring(4).trim(), 240)); continue; }
            if (s.startsWith("[用户]")) { chat.add("你：" + shorten(s.substring(4).trim(), 160)); continue; }
            if (s.startsWith("最近对话")) continue;
            if (s.startsWith("会话:") || s.startsWith("会话：")) continue;
            if (s.contains("session-")) continue;
            if (s.startsWith("最近动作")) {
                String tool = s;
                Matcher tm = Pattern.compile("最后一个工具是\\s*(\\S+)").matcher(s);
                if (tm.find()) tool = "最近一次用的是 " + tm.group(1) + " 工具";
                s = s.contains("结果") ? tool + "（输出已折叠，点「原始」可看）" : s;
            }
            s = s.replaceAll("[0-9a-fA-F]{12,}", "…");
            s = s.replaceAll("(\\S{40,})", "…");
            s = s.replace("[completed]", "已完成 ").replace("[in_progress]", "正在做 ")
                 .replace("[pending]", "待做 ").replace("[todo]", "待做 ").replace("[done]", "已完成 ");
            s = s.replaceAll("\\[(ok|error|failed|cancelled)\\]", "");
            s = s.replaceAll("[　\\s]+", " ");
            if (s.matches("^[\\p{Punct}\\s]*$")) continue;
            outline.append(s).append("\n");
        }
        StringBuilder chatBlock = new StringBuilder();
        for (int i = chat.size() - 1; i >= 0; i--) chatBlock.append(chat.get(i)).append("\n\n");
        String body = outline.toString().trim();
        StringBuilder fin = new StringBuilder();
        if (!body.isEmpty()) fin.append(body);
        if (chat.size() > 0) {
            if (fin.length() > 0) fin.append("\n\n");
            fin.append("【最近的对话（新→旧）】\n\n").append(chatBlock.toString().trim());
        }
        if (toolCalls > 0) fin.append("\n\n（另有 ").append(toolCalls).append(" 条工具调用/结果，已折叠）");
        progressText.setText(fin.length() == 0 ? "（没有可显示的内容，点「原始」）" : fin.toString());
    }

    private void doSend() {
        String text = sendBox.getText().toString().trim();
        if (text.isEmpty()) { toast("写点什么再发"); return; }
        sendBox.setText("");

        if (newMode) {
            progressText.setText("正在电脑上新建会话…");
            ioPool.execute(() -> {
                try {
                    String r = mcp.newSession(text, null);
                    Matcher m = IDP.matcher(r);
                    final String id = m.find() ? m.group() : "";
                    ui.post(() -> {
                        if (id.isEmpty()) { progressText.setText("新建失败：\n" + r); return; }
                        newMode = false;
                        currentSession = id;
                        detailTitle.setText("新会话");
                        toast("已新建会话，电脑开始跑了");
                        reloadDetail();
                    });
                } catch (Exception e) {
                    ui.post(() -> progressText.setText("新建失败：" + e.getMessage()));
                }
            });
            return;
        }

        if (currentSession.isEmpty()) { toast("先选一条会话"); return; }
        toast("正在发到电脑…");
        final String id = currentSession;
        ioPool.execute(() -> {
            try {
                mcp.send(id, text, false);
                ui.post(() -> toast("已发进电脑那条会话"));
                Thread.sleep(1500);
                reloadDetail();
            } catch (Exception e) {
                ui.post(() -> toast("发送失败：" + e.getMessage()));
            }
        });
    }

    private void clickPc(int x, int y) {
        ioPool.execute(() -> {
            try {
                Net.postJson(Config.PANEL_URL + "/api/input?t=" + Config.PANEL_TOKEN,
                        "{\"action\":\"click\",\"x\":" + x + ",\"y\":" + y + "}", null);
            } catch (Exception e) {
                ui.post(() -> toast("点击失败：" + e.getMessage()));
            }
        });
    }

    /* ------------------------------ 工具 ------------------------------ */

    private Button smallBtn(String label, Runnable action) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.parseColor("#242838"));
        b.setPadding(dp(10), dp(2), dp(10), dp(2));
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        b.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(5);
        b.setLayoutParams(lp);
        return b;
    }

    private static String shorten(String s, int n) {
        if (s == null) return "";
        s = s.replaceAll("\\s+", " ").trim();
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onDestroy() {
        stopScreen();
        pool.shutdownNow();
        ioPool.shutdownNow();
        super.onDestroy();
    }
}
