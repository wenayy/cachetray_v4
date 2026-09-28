# CacheTray Firebase sync preview

CacheTray remains local-only until the user opens the cloud button and signs in. The preview syncs text, code, links, tasks, and workspace structure. Images remain in the extension's local IndexedDB.

## Run locally with Firebase emulators

Prerequisites: Node.js and Java 21 or newer.

1. Start Auth, Firestore, and the Emulator UI from this directory:

   ```sh
   npx firebase-tools emulators:start --project demo-cachetray --only auth,firestore
   ```

2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select this directory. If it was already loaded, click **Reload**.
3. Open CacheTray, click the cloud icon, and choose **Use local test account**.
4. Add a text clip, then click **Sync now**. Inspect the document in the Emulator UI at `http://127.0.0.1:4000/firestore`.
5. To simulate a second device, load a copy of this directory in a second Chrome profile, sign in to the same local test account, and click **Sync now**.

The companion Expo app under `mobile/` uses the same emulator account and Firestore document. See `mobile/README.md` for its build instructions.

The checked-in `firebase-config.js` points only at localhost. No Firebase project or billing account is needed for this test.

## Connect a real Firebase project

1. Create a Firebase project, enable Google under **Authentication > Sign-in method**, and create Firestore.
2. Deploy `firestore.rules`:

   ```sh
   npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
   ```

3. In Google Cloud Console, create an OAuth client of type **Chrome extension** using the extension ID shown in `chrome://extensions` (the Chrome Web Store ID is stable for production).
4. Replace the placeholder `oauth2.client_id` in `manifest.json` with that client ID.
5. In `firebase-config.js`, set `useEmulators` to `false`, and fill in the Firebase Web API key and project ID.
6. Reload the extension and use **Continue with Google**.

The Firebase API key and OAuth client ID are public application identifiers. The security boundary is Firebase Authentication plus `firestore.rules`, which restricts each document to its owning UID.

## Automated checks

Run the dependency-free sync-core tests:

```sh
node --test tests/cloud-sync.test.js
```

## Preview limitations

- Newest whole-state snapshot wins; simultaneous edits on two devices are not merged per item yet.
- Sync is pushed after local changes and pulled on extension startup, manual sync, and a one-minute alarm.
- Firestore has a 1 MiB document limit. The preview stops below that limit and does not upload images.
- Production image sync should use Firebase Storage with separate access rules and quota controls.
