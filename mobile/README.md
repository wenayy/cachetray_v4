# CacheTray mobile preview

This Expo app uses the same Firebase Authentication project and the same Firestore document as the Chrome extension:

`users/{firebaseUid}/cachetray/state`

No custom authentication server is involved. Google signs the user in, Firebase verifies the credential, and Firestore rules isolate each user's document.

## Local end-to-end test

1. Install Java 21 or newer, then start the emulators from the repository root:

   ```sh
   npx firebase-tools emulators:start --project demo-cachetray --only auth,firestore
   ```

2. Install and build the app:

   ```sh
   cd mobile
   npm install
   npm run ios
   # or: npm run android
   ```

3. Load the extension unpacked, and sign in from its cloud-sync dialog. In both clients, choose the local test account. They use the same emulator UID and document.

The Android emulator reaches the host machine through `10.0.2.2`, not `127.0.0.1`. Change `emulatorHost` in `src/config.js` for Android emulator testing. A physical device needs the computer's LAN address.

## Real Google sign-in

1. Set `useEmulators` to `false` in both `mobile/src/config.js` and the root `firebase-config.js`.
2. Put the same Firebase web configuration into both clients.
3. Register Android package `com.cachetray.mobile` (including its signing SHA-1) and iOS bundle ID `com.cachetray.mobile` in the Google/Firebase project.
4. Set the Web and iOS OAuth client IDs in `mobile/src/config.js`.
5. Replace `com.googleusercontent.apps.placeholder` in `mobile/app.json` with the reversed iOS client ID shown by Google (the value beginning `com.googleusercontent.apps.`).
6. Replace the placeholder Chrome-extension OAuth client in the root `manifest.json`.
7. Build a native development client; Google Sign-In does not run in Expo Go.

## Monetization boundary

Authentication and syncing need no server that you operate. Paid-plan enforcement does need trusted code: use Stripe or RevenueCat webhooks in Firebase/Google Cloud Functions to set a Firebase custom claim such as `pro: true`. Production Firestore rules can then require that claim for cloud-sync reads and writes. Never unlock Pro based only on a boolean written by the mobile app or extension.
