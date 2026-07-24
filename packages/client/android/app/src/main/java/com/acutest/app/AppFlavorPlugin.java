package com.acutest.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reports which distribution channel this APK was built for ("sideload" or
 * "play"), so the shared web bundle can hide the things Google Play forbids.
 *
 * The web layer is one build serving web, sideload and Play, so this gating
 * has to happen at runtime — see components/client/distribution.ts.
 */
@CapacitorPlugin(name = "AppFlavor")
public class AppFlavorPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("channel", BuildConfig.DISTRIBUTION_CHANNEL);
        call.resolve(result);
    }
}
