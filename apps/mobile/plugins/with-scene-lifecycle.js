// Adopts the UIScene life cycle on iOS. Apps built with the iOS 27 SDK trap at launch without it
// (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Expo 57 ships the scene delegate
// (ExpoAppSceneDelegate) but its app template still starts React Native from the app delegate, so
// this plugin wires the two together: the scene delegate creates the window and starts React Native
// with the factory the app delegate created. Drop this once the Expo template adopts scenes itself.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE = 'EXExpoAppSceneDelegate';

const LEGACY_CLASS = 'class AppDelegate: ExpoAppDelegate {';
const SCENE_CLASS = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';

// The template's window + startReactNative block; the scene delegate does this under scenes.
const LEGACY_START =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([^)]*\)\n#endif\n/;

function adoptSceneFactory(contents) {
  if (contents.includes(SCENE_CLASS)) return contents;
  if (!contents.includes(LEGACY_CLASS) || !LEGACY_START.test(contents)) {
    throw new Error(
      'with-scene-lifecycle: AppDelegate.swift no longer matches the Expo 57 template. ' +
        'Check whether Expo adopts the scene life cycle itself now and remove this plugin.',
    );
  }
  return contents.replace(LEGACY_CLASS, SCENE_CLASS).replace(LEGACY_START, '');
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE,
          },
        ],
      },
    };
    return config;
  });

  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      throw new Error('with-scene-lifecycle: expected a Swift AppDelegate.');
    }
    config.modResults.contents = adoptSceneFactory(config.modResults.contents);
    return config;
  });
};
