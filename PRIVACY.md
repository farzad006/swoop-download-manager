# Privacy policy

*Swoop, by Ali Studio. Last updated October 2026.*

Swoop has **no accounts, no ads, no analytics and no telemetry**. Ali Studio receives no information about you or what you download.

## When Swoop connects to the internet

1. **Downloads you start.** This covers clicking a download in your browser, pasting a link, accepting a copied-link suggestion, or a queue or schedule you set up. Swoop connects to that website and sends what the site needs to give you the file: the address and, for downloads that come from your browser, the same cookies, referrer and browser name your browser would have sent.
2. **Web videos.** When you use *Download this video*, Swoop runs the free tool [yt-dlp](https://github.com/yt-dlp/yt-dlp), which contacts that website to find and download the video.
3. **Keeping the video downloader up to date.** Once a day, if *Keep the video downloader up to date* is on (it is by default), Swoop asks yt-dlp to check for a newer version. That contacts the Python package index (pypi.org) or GitHub, depending on how yt-dlp was installed. No personal information is sent. Turn it off in **Settings → Videos**.
4. **Links you choose to open.** Buttons like *Project on GitHub*, *Report a problem* and *Send a gift card* open those web pages in your browser.

Swoop makes no other network connections.

## The browser extension

The extension notices download links and video addresses on the pages you visit so it can offer to download them. That information goes **only to the Swoop app on the same computer** (through your browser's "native messaging" feature), never to the internet. When you download something, the cookies for that one website are passed to Swoop so the download works the same as it would in your browser.

## What Swoop keeps on your computer

- Your download list and settings, in `%APPDATA%\com.alistudio.swoop`.
- Temporary cookie files for video downloads. They're deleted when the download finishes, when you remove it, or when you close the video dialog without downloading.
- Partly downloaded files (`.part`), next to the finished file, until the download completes.

If *Notice copied links* is on, Swoop looks at your clipboard to offer copied download links. Clipboard contents never leave your computer.

## Changes Swoop makes to Windows

- Registry entries (for your user account only) that let browsers with the Swoop extension talk to Swoop. Swoop refreshes them each time it starts, and they're removed when you uninstall.
- A *Start with Windows* entry, only if you turn that option on.

## Contact

Questions: [open an issue](https://github.com/farzad006/swoop-download-manager/issues) or email farzad006@gmail.com.
