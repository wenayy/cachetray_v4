# CacheTray 1.7.5 release review

Reviewed October 7, 2026. No extension behavior, billing settings or production data changed during this review.

## Fix status: 1.7.6

The subsequent user-authorized implementation addresses the three confirmed findings below. Collection writes now use a background-owned serialized patch queue; clients rebase pending/unsaved edits against revisioned updates, with stable workspace IDs and UUIDs for new notes. Image garbage collection also goes through the queue. Search, workspace badges and palette item content use safe DOM construction. The page-message capture bridge and its web-accessible script declaration are removed; synthetic copy/cut events are ignored and image capture payloads are accepted only from the extension's offscreen document. Polling retries failed saves and honors capture pause. Registered content scripts now consistently include frames, including updates to existing registrations.

Regression tests cover stale saves, overlapping captures, rename/delete conflicts, out-of-order responses, failed saves, rejected webpage mutation requests and capture forgery. Isolated real-Chrome checks passed for concurrent popup/sidebar writes, the image capture race, search/workspace HTML rendering, UUID selection, image delete/undo, rejected synthetic capture and zero page exceptions. They do not recover already-missing historical image bytes or establish that every possible bug/security issue is absent. No payment-provider settings or production data were changed.

Release verification: all 54 automated tests pass (44 existing plus 10 new regression tests). Real-Chrome checks also verify literal palette rendering. Version 1.7.6 is packaged separately from the original review archive.

## Original 1.7.5 review verification (before fixes)

- All 44 existing automated tests passed under Node 22.23.2, including local image transaction durability, phone pairing/disconnect, daily image quotas, concurrent quota reservations, verified billing activation, environment isolation and recovery.
- Packaged JavaScript passed Node syntax checks.
- Every one of the 32 files in `CacheTray-1.7.5.zip` matched the corresponding local file byte-for-byte at the time of the original review. Packaged HTML resource checks found no missing files.
- The archive scan found no matches for the checked private API-key, webhook-secret or private-key patterns. This is not a guarantee against every possible secret format.
- Three additional isolated reproductions confirmed the findings below. The diagnostic script is `/private/tmp/cachetray-review-175.cjs`; it uses extracted real functions with mocked browser/storage dependencies, not the user's Chrome profile.

## Findings to address before release

### High: competing metadata writers can lose saved items or edits

`popup.js:85` saves the popup/sidebar's entire in-memory collection directly to `chrome.storage.local`. `background.js:133` loads a snapshot before asynchronous image compression/storage, then commits that entire snapshot at `background.js:218`. The background save queue only serializes background operations; it does not serialize popup/sidebar writes. Storage-change notifications do not refresh the background operation's already-loaded snapshot.

Reproduction: start a background image capture and pause compression; add and save a text clip from the popup; resume image capture. The final stored collection contains the new image but loses the popup's text clip. This confirms a remaining data-loss path, but does not prove it caused every historical blank thumbnail.

Recommended approach: one owner for all collection mutations, with serialized commands from popup/sidebar, capture and cleanup. Use stable globally unique item IDs and handle failures before reporting success. Add simultaneous capture/edit/delete tests across contexts. Fix this before adding more automatic capture paths.

### Medium: search input and workspace labels reach HTML sinks unescaped

`popup.js:1188` interpolates the search query into `innerHTML`; `popup.js:1203` does the same with a workspace name and color. Searching for HTML-shaped text can create markup instead of displaying the text literally. The query path was reproduced with a harmless image tag string. Workspace-name interpolation was identified by inspection.

This demonstrates HTML injection/UI manipulation; privileged JavaScript execution was not demonstrated, and the extension's content security policy provides additional restrictions. Nevertheless, injected markup can distort the UI or request external resources.

Recommended approach: construct elements using `textContent`, set validated colors through style properties, and preserve search highlights without concatenating untrusted HTML. Add query/workspace rendering tests.

### Medium: webpage clipboard bridge is forgeable

The `window` message listener in `content-script.js` accepts a public source string and forwards the supplied text/image to the background. A page can reproduce that envelope without actually copying anything. Copy/cut event listeners also do not check `isTrusted`; the keydown listener does.

Reproduction: deliver a same-window message with `source: '__quicknotes_injected'` and a `COPIED_TEXT` payload. It triggers the capture forwarding function despite no clipboard action. This confirms unintended capture, not payment escalation or credential theft. When paired, captured non-image text may then sync to the phone.

Recommended approach: do not treat page-provided bridge data as trusted clipboard evidence. Tie capture to trusted interaction and extension-owned clipboard reads where possible, enforce payload sizes/types and rate limits, and test synthetic events/messages. A hidden string alone is not a sound boundary against page scripts.

## Other inspected limitations

- Newly registered content scripts omit `allFrames`, although initial injection into existing tabs uses `allFrames: true`. Capture inside iframes may therefore vary by whether a tab existed at startup. Verify this in real Chrome and make the behavior intentional.
- Free limits are per anonymous installation, not a verified person. Creating a new identity can obtain another Free allowance. Existing payment tests confirm that frontend Pro fields do not grant server quotas; they do not establish that the system is abuse-proof.
- Separate refund/chargeback events are not implemented in the current subscription handler. Configure an operational revocation policy before broad live billing.
- This review did not perform a real-money purchase, access the user's Chrome profile, inspect historical missing image bytes, or independently penetration-test production. Passing automated tests is not a guarantee of zero errors.

## Selection capture follow-up: 1.7.7

Further user-requested change in 1.7.8: selections now also copy to the system clipboard for pasting, including repeated selections already stored in CacheTray. The capture toggle prevents copying as well as saving. An HTTP-compatible copying fallback restores focus/selection, and failed automatic copying is reported while retaining the saved clip. Clipboard transports are substituted in the browser tests to avoid changing the user's system clipboard; the fallback is covered by unit tests. The privacy notice and release instructions are updated. On October 8, the production website was published successfully and the Worker/R2 origins were configured for the published Chrome extension ID.

The user subsequently requested selection capture for everyone. Version 1.7.7 implements it for Free and Pro using settled trusted pointer/keyboard gestures, with editable-field exclusion and the existing capture pause. It leaves the system clipboard unchanged and uses the background save queue and existing paired-phone sync limits. All 57 automated tests and isolated Chrome checks passed. The proposal below records the original review recommendation, before this follow-up.

## Original optional Pro selection capture proposal

Feasible, but not implemented or included in the ZIP. Recommended experience: an explicit Pro setting, off by default, to save a settled user selection directly into CacheTray without changing the system clipboard. Skip password/payment fields and editable fields by default, avoid intermediate drag/duplicate selections, honor capture pause, and explain that paired clip sync also sends saved selections to the phone. A small “Save to CacheTray” selection action is a lower-risk alternative. The existing right-click selection menu already offers manual saving.

Check verified plan status in the background, not just a UI checkbox. Local-only paid features remain modifiable by someone altering an unpacked extension; cloud quotas must continue to be enforced on the server. Resolve the single-writer storage issue first.
