<p align="center">
  <img src="icon128.png" width="72" alt="CacheTray logo">
</p>

<h1 align="center">CacheTray</h1>

<p align="center">
  Your clipboard remembers one thing. CacheTray keeps the context you need next.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/pgohpbolcaaoenhaapkikmheckannlpn">Install for Chrome</a>
  · <a href="https://cachetray.gitflex.lol">Website</a>
  · <a href="https://cachetray.gitflex.lol/received.html">Phone app</a>
  · <a href="#development">Run locally</a>
</p>

CacheTray is a local-first clipboard manager for research, coding and AI workflows. Collect screenshots, links, code and text in one tray, pick the context that matters, and send it to ChatGPT or Claude without repeatedly downloading files and copying things back and forth.

Built as a **Chrome Manifest V3 extension**, with a **phone PWA**, **Cloudflare backend** and **Dodo Payments subscriptions**. Current extension version: **1.7.8**.

## Watch it work

[![Watch the CacheTray demo on YouTube](CacheTray-YouTube-Thumbnail-Demo.png)](https://www.youtube.com/watch?v=6k_3QaWkQXo)

**[Watch the demo on YouTube](https://www.youtube.com/watch?v=6k_3QaWkQXo)**

## Two small changes that save a lot of repetition

### Highlight. Copy. Save.

Select text on a supported webpage. CacheTray copies it to your system clipboard **and** saves it in your tray, so you can paste it immediately or find it again later. Available on Free and Pro.

![Feature preview: highlight webpage text to copy and save it in CacheTray](CacheTray-Feature-Select-Copy-Save.png)

Selection capture replaces your current clipboard. Pause auto-capture to turn it off; password and editable fields are excluded from selection capture.

### Your clips, on your phone.

Install the phone web app, pair with a QR code, and keep recent text, links, code and tasks within reach. Send images individually when you want them on your phone, then preview, download or share them through your phone's share sheet.

![Feature preview: send images and sync recent clips from the extension to your phone](CacheTray-Feature-Phone-Sync.png)

*The images above are promotional feature illustrations. The YouTube demo shows the working extension.*

## What you can do

| Workflow | What CacheTray gives you |
| --- | --- |
| Capture useful context | Save copied text, links, code and images; highlight text to copy and save; add notes, tasks or the current tab. |
| Find it again | Category filters, search, workspaces and favourites keep related context together. |
| Give AI the right context | Select mixed items and send them to ChatGPT or Claude. Copy or insert saved text into other supported inputs. |
| Stay in your flow | Use the quick popup, persistent Chrome side panel or keyboard shortcuts. |
| Move from desktop to phone | QR pairing without an account, recent clip sync and individual image transfers. |
| Use a proper phone inbox | Image thumbnails, grid/list views, clip categories, link actions, sharing, download feedback and swipe-to-delete in image list view. |

### Try it in a minute

1. [Install CacheTray](https://chromewebstore.google.com/detail/pgohpbolcaaoenhaapkikmheckannlpn) and open the popup or side panel.
2. Highlight a useful sentence, copy a link or capture an image.
3. Find it in the tray, select the items you need, and send them into your AI chat.
4. For mobile, open the phone setup in the extension, scan the install QR, install the web app, then use the pairing QR to connect.

On **Android**, install from Chrome. On **iPhone**, use Safari → Share → Add to Home Screen. Installation guidance adapts to the phone.

## Local-first, with temporary phone sync

- The extension's saved tray stays on the device by default. Local use does not require an account or payment.
- Pairing enables temporary cloud sync for recent text, links, code and tasks. Images upload only when you send them to a phone.
- Local clips currently expire after **3 days**, including favourites. Phone clips and sent images are available for **24 hours** on both plans.
- Phone image deletion removes the corresponding cloud transfer/object, not the local extension original. Downloads and copies shared to other apps are separate files.
- Cloud image expiry is backed by cleanup and an R2 lifecycle rule. Physical lifecycle deletion is asynchronous, not guaranteed at the exact 24-hour mark.
- Phone transfers are **not end-to-end encrypted**. Pairing credentials and Pro recovery keys should be treated as private.

[Read the privacy policy](https://cachetray.gitflex.lol/privacy.html).

### Free and Pro

The local tray and selection-to-copy feature are available to everyone. Pro increases phone limits.

| Phone feature | Free | Pro — $4.99 USD/month, plus applicable taxes |
| --- | --- | --- |
| Images | 5 successful sends per rolling 24 hours | 50 stored images per phone |
| Recent text, links, code and tasks | Newest 20 items in each category | Newest 100 items in each category |
| Paired phones per extension | 1 | 2 |
| Phone content availability | 24 hours | 24 hours |

Deleting an image **does not reset** Free's daily send allowance. Pro image slots become available after deletion or expiry. Free usage is tied to an anonymous installation identity; it is not an account-backed, abuse-proof identity system.

## Development

```sh
git clone https://github.com/wenayy/cachetray_v4.git
cd cachetray_v4
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this folder. No extension build step is required.

To run the regression suite with Node.js 22 or newer, install the Worker dependencies first:

```sh
npm ci --prefix transfer-worker
node --test transfer-worker/test/*.test.js tests/*.test.js
```

The repository includes production service URLs. Configure your own backend for phone and billing development.

Detailed architecture, development instructions, setup guides and interview notes live in **[CacheTray Concepts](https://github.com/wenayy/cachetray-concepts)**.

## Support

[Support page](https://cachetray.gitflex.lol/support.html) · [Email treastingmike@gmail.com](mailto:treastingmike@gmail.com) · [Privacy policy](https://cachetray.gitflex.lol/privacy.html)
