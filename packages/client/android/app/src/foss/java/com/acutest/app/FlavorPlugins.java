package com.acutest.app;

import com.getcapacitor.BridgeActivity;

/**
 * FOSS distribution: F-Droid and the Google-free APK on sloga.gg.
 *
 * F-Droid's inclusion policy forbids an app from downloading and installing
 * updates to itself, so, as on Play, ApkUpdaterPlugin and
 * REQUEST_INSTALL_PACKAGES live only in the `sideload` source set and are
 * absent from this build entirely. There is no FCM here either: the Google
 * messaging code sits in src/gms, which this flavor never compiles.
 *
 * Background push for this flavor comes from a UnifiedPush plugin, registered
 * here in a later change.
 */
final class FlavorPlugins {
    private FlavorPlugins() {}

    static void register(BridgeActivity activity) {
        // Nothing yet. No self-update on foss builds; see class docs.
    }
}
