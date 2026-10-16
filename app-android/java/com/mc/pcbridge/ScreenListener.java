package com.mc.pcbridge;

/**
 * WebSocket 回调的实现类（独立文件，不用匿名内部类 —— d8 处理匿名内部类会 NPE）。
 */
final class ScreenListener implements WsClient.Listener {

    private final MainActivity activity;

    ScreenListener(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public void onFrame(byte[] jpeg) {
        activity.onWsFrame(jpeg);
    }

    @Override
    public void onMeta(int w, int h) {
        activity.onWsMeta(w, h);
    }

    @Override
    public void onState(String state) {
        activity.onWsState(state);
    }
}
