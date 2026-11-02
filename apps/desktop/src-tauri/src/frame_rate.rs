//! WebKit holds pages to about 60 frames a second even on a 120 Hz display while this private preference is on.
//! It only takes effect on a web view created with it, so the main window is built with this configuration.

use objc2::{msg_send, rc::Retained, runtime::NSObject, sel, ClassType, MainThreadMarker};
use objc2_foundation::{NSArray, NSString};
use objc2_web_kit::{WKPreferences, WKWebViewConfiguration};

const NEAR_60_FPS: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

pub fn webview_configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
    unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        follow_display_refresh_rate(&config.preferences());
        config
    }
}

/// A WebKit without these private methods or this feature keeps its default.
unsafe fn follow_display_refresh_rate(preferences: &WKPreferences) {
    let class = WKPreferences::class();
    let has_features: bool = msg_send![class, respondsToSelector: sel!(_features)];
    if !has_features || !class.responds_to(sel!(_setEnabled:forFeature:)) {
        return;
    }
    let features: Retained<NSArray<NSObject>> = msg_send![class, _features];
    for feature in features.iter() {
        let key: Retained<NSString> = msg_send![&*feature, key];
        if key.to_string() == NEAR_60_FPS {
            let _: () = msg_send![preferences, _setEnabled: false, forFeature: &*feature];
        }
    }
}
