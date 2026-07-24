package com.acutest.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the app process, network and microphone
 * alive while the user is in a voice call and the app is backgrounded.
 */
public class VoiceCallService extends Service {
    private static final String CHANNEL_ID = "voice_call";
    private static final int NOTIFICATION_ID = 4801;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();

        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Sloga")
                .setContentText("In a voice call")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .build();

        // Only claim capability types we actually hold the runtime permission
        // for. From Android 14 the platform validates this and throws
        // SecurityException — "the app must be in the eligible state ... to
        // access the foreground only permission" — which killed the whole
        // process the instant a call connected on any device where the mic had
        // not been granted yet. That is exactly the state a first-time caller
        // is in, because we start this service from the room's "connected"
        // event, before getUserMedia has had a chance to prompt.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int type = 0;
            if (hasPermission(android.Manifest.permission.RECORD_AUDIO)) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            if (hasPermission(android.Manifest.permission.CAMERA)) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }

            if (type == 0) {
                // Nothing to keep alive that we're allowed to keep alive. The
                // call itself still runs while the app is in the foreground;
                // only background survival is given up. Never crash for this.
                stopSelf();
                return START_NOT_STICKY;
            }

            try {
                startForeground(NOTIFICATION_ID, notification, type);
            } catch (Exception error) {
                // Racing a permission revoke, or started while the app is not
                // in a foreground-eligible state. Losing the keepalive is
                // recoverable; taking the process down mid-call is not.
                android.util.Log.w("VoiceCallService",
                        "foreground start refused, continuing without keepalive", error);
                stopSelf();
            }
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        return START_NOT_STICKY;
    }

    private boolean hasPermission(String permission) {
        return androidx.core.content.ContextCompat.checkSelfPermission(this, permission)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Voice calls",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Keeps voice calls running in the background");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
}
