package com.acutest.app;

import androidx.appcompat.app.AppCompatActivity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The return leg of the Android back key.
 *
 * MainActivity consumes every back press and fires `slogaBackPressed` at the
 * window. The web layer (components/client/AndroidBackWorker.tsx) walks the
 * dismissal ladder — native fullscreen, the Escape group of floating elements
 * and modals and the channel side column, the phone slide drawer, then history
 * — and calls {@link #exitApp(PluginCall)} here only when every rung declined:
 * there was no overlay to close and nowhere left to navigate back to.
 *
 * That round trip exists because the native side cannot wait for the answer.
 * The press has to be consumed synchronously, and what it means is only
 * knowable in the web layer, so "nothing was open, actually leave" has to come
 * back across the bridge as a separate call.
 *
 * Registered in MainActivity.onCreate exactly like PushTokenPlugin and
 * AppFlavorPlugin, and the plugin name here must stay `SlogaBack` — it is what
 * the web layer passes to registerPlugin(). No new dependency: `@capacitor/app`
 * is deliberately not added, and it would not have removed the predictive-back
 * work anyway.
 */
@CapacitorPlugin(name = "SlogaBack")
public class SlogaBackPlugin extends Plugin {

    @PluginMethod
    public void exitApp(PluginCall call) {
        AppCompatActivity activity = getActivity();
        if (!(activity instanceof MainActivity)) {
            call.reject("No MainActivity to leave");
            return;
        }
        // exitFromWebLayer hops to the UI thread itself: Capacitor may deliver
        // a plugin call on a background thread, and moveTaskToBack/finish are
        // main-thread only.
        ((MainActivity) activity).exitFromWebLayer();
        call.resolve();
    }
}
