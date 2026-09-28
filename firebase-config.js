/*
 * CacheTray cloud-sync configuration.
 *
 * Firebase web API keys and OAuth client IDs are identifiers, not secrets.
 * Access is protected by Firebase Authentication and firestore.rules.
 * See FIREBASE_LOCAL_TESTING.md for setup instructions.
 */
globalThis.CACHE_TRAY_FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyAqZwfXq5BKuWwv12snyNzPhJGkw_YdcV4',
  projectId: 'cachetray-3c67b',
  useEmulators: false,

  // Set to true while running the Firebase emulators. The extension will use
  authEmulatorUrl: 'http://127.0.0.1:9099',
  firestoreEmulatorUrl: 'http://127.0.0.1:8080',
  emulatorEmail: 'cachetray-local@example.test',
  emulatorPassword: 'cachetray-local-password'
});
