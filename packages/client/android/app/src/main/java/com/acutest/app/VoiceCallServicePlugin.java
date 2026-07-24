package com.acutest.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge to start/stop the voice call foreground service.
 */
@CapacitorPlugin(name = "VoiceCallService")
public class VoiceCallServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // From Android 14 a foreground service may only claim a capability the
        // app currently holds the runtime permission for. With neither mic nor
        // camera granted there is no type we may legally start under, and
        // calling startForegroundService anyway would create a startForeground
        // obligation we cannot discharge. Skip instead: the call still runs in
        // the foreground, and the keepalive returns on the next call once the
        // user has answered the permission prompt.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && !holdsPermission(android.Manifest.permission.RECORD_AUDIO)
                && !holdsPermission(android.Manifest.permission.CAMERA)) {
            call.resolve();
            return;
        }

        Intent intent = new Intent(getContext(), VoiceCallService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    /** Named to avoid colliding with Capacitor's public Plugin#hasPermission. */
    private boolean holdsPermission(String permission) {
        return androidx.core.content.ContextCompat.checkSelfPermission(getContext(), permission)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), VoiceCallService.class));
        call.resolve();
    }
}
