package com.acutest.app;

import com.getcapacitor.BridgeActivity;

/**
 * Play Store distribution: deliberately registers nothing.
 *
 * Google Play's Device and Network Abuse policy forbids an app distributed on
 * Play from modifying, replacing or updating itself by any mechanism other than
 * Play, and REQUEST_INSTALL_PACKAGES is restricted to apps whose core purpose
 * is installing packages — which a chat app is not. So ApkUpdaterPlugin and
 * that permission live only in the `sideload` source set and are absent from
 * this build entirely, rather than merely being disabled at runtime.
 */
final class FlavorPlugins {
    private FlavorPlugins() {}

    static void register(BridgeActivity activity) {
        // No self-update on Play builds. See class docs before adding anything.
    }
}
