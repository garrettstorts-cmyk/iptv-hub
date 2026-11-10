# IPTV Hub PWA Starter

A lightweight, TV-first Progressive Web App starter for organizing legal/public IPTV playlists and XMLTV guide data.

## Folder structure

```text
IPTV-Hub-PWA/
├── index.html
├── manifest.webmanifest
├── sw.js
├── README.md
├── .gitignore
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   ├── config.js
│   ├── m3u-parser.js
│   ├── xmltv-parser.js
│   ├── xmltv-loader.js
│   ├── epg.js
│   └── player.js
├── assets/
│   ├── icons/
│   ├── images/
│   └── logos/
└── data/
    ├── playlists/
    └── epg/
```

## First run in VS Code

Do not open `index.html` directly with `file://` if you want the service worker/PWA features to work.

Recommended:

1. Open this folder in VS Code.
2. Install the **Live Server** extension, or use another local HTTP server.
3. Right-click `index.html` and choose **Open with Live Server**.
4. The starter home screen should load.
5. Open DevTools → Application to inspect the manifest and service worker.

## Good first development milestones

1. Replace sample home-screen data with your real categories.
2. Put your public/authorized playlist URLs in `js/config.js`.
3. Fetch and parse one M3U playlist.
4. Fetch and parse one XMLTV guide.
5. Match `tvg-id` from M3U to XMLTV `channel id`.
6. Add a real `<video>` player using hls.js.
7. Improve remote-control spatial navigation.
8. Add favorites and continue-watching data using IndexedDB/localStorage.
9. Add a full-screen guide view.
10. Test on your TV browser.

## Important

This starter intentionally does not include any premium or unauthorized IPTV feeds. Use public/free streams or feeds you are authorized to access.
