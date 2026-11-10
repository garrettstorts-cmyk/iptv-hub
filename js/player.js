// Playback resources belong to this controller, not application state.
window.IPTVPlayer = (() => {
  let active = null;
  const prefix = "[IPTV Hub Player]";
  function stop() {
    const session = active;
    active = null;
    if (!session) return;
    clearTimeout(session.timer);
    session.listeners.forEach(([event, handler]) => session.video.removeEventListener(event, handler));
    if (session.hls) session.hls.destroy();
    session.video.pause();
    session.video.removeAttribute("src");
    session.video.load();
  }

  function play(channel, video, callbacks = {}) {
    stop();
    const session = active = { video, hls: null, listeners: [], recovered: false, triedHls: false, timer: null };
    const current = () => active === session;
    const status = (value, message = "") => { if (current()) callbacks.onStatus?.(value, message); };
    function fail(message, detail) {
      if (!current()) return;
      console.error(prefix, message, detail);
      stop();
      callbacks.onStatus?.("error", message);
    }
    function listen(event, handler) {
      const guarded = () => { if (current()) handler(); };
      session.listeners.push([event, guarded]);
      video.addEventListener(event, guarded);
    }
    function attemptPlay() {
      if (!current()) return;
      try {
        const result = video.play();
        result?.catch(error => {
          if (!current() || error.name === "AbortError") return;
          console.warn(prefix, "play() rejected", error);
          if (error.name === "NotAllowedError") {
            clearTimeout(session.timer);
            status("blocked", "Press Play to Start");
          } else if (error.name !== "NotSupportedError") {
            fail("Playback could not start. Please try another channel.", error);
          }
          // NotSupportedError is handled by the media error event / HLS fallback.
        });
      } catch (error) { fail("Playback could not start.", error); }
    }
    function startHls(url) {
      if (!current() || session.triedHls) return false;
      session.triedHls = true;
      const Hls = window.Hls;
      if (!Hls?.isSupported()) return false;
      console.info(prefix, "Using hls.js", url);
      video.pause();
      video.removeAttribute("src");
      video.load();
      try {
        const hls = session.hls = new Hls();
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (current()) hls.loadSource(url); });
        let playAttempted = false;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (current() && !playAttempted) { playAttempted = true; attemptPlay(); }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!current()) return;
          console.warn(prefix, "HLS error", { type: data.type, details: data.details, fatal: data.fatal, url: data.url, response: data.response });
          // Nonfatal errors use hls.js's own bounded retry policy.
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !session.recovered && !/manifest|codec/i.test(data.details || "")) {
            session.recovered = true;
            status("buffering", "Recovering playback…");
            try { hls.recoverMediaError(); } catch (error) { fail("This browser could not decode the stream.", error); }
            return;
          }
          if (/codec/i.test(data.details || "")) fail("This stream format is not supported by this browser.", data.details);
          else if (/manifest/i.test(data.details || "")) fail("The stream could not be loaded.", data.details);
          else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) fail("This channel is currently unavailable. Check your connection or try another channel.", data.details);
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) fail("This browser could not decode the stream.", data.details);
          else fail("Playback failed. Please try another channel.", data.details);
        });
        hls.attachMedia(video);
        return true;
      } catch (error) {
        fail("The stream could not be loaded.", error);
        return true;
      }
    }

    status("loading", "Loading stream…");
    let url;
    try {
      url = new URL(channel.url, location.href);
      if (!channel.url || !["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported stream URL");
    } catch (error) { fail("This stream URL is not supported by this browser.", error); return; }
    const path = url.pathname.toLowerCase();
    const knownHls = /\.m3u8?$/.test(path);
    const types = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", ogg: "video/ogg", mp3: "audio/mpeg", aac: "audio/aac" };
    const mime = types[path.split(".").pop()];
    const unknown = !knownHls && !mime;
    const nativeHls = Boolean(video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL"));
    listen("playing", () => { clearTimeout(session.timer); status("playing", "Playing live"); });
    listen("waiting", () => status("buffering", "Buffering…"));
    listen("stalled", () => status("buffering", "Waiting for stream…"));
    listen("pause", () => status("paused", "Paused"));
    listen("ended", () => status("ended", "This stream has ended."));
    listen("error", () => {
      const error = video.error;
      if (!error) return; // Ignore a queued error from a source already reset by load().
      console.warn(prefix, "Native media error", { url: url.href, code: error?.code, message: error?.message });
      // Opaque endpoints may redirect to HLS. Try that once after native rejection.
      if (!session.hls && (knownHls || (unknown && error?.code === 4)) && startHls(url.href)) return;
      if (session.hls) return; // hls.js reports detailed errors and controls recovery.
      const messages = { 2: "This channel is currently unavailable. Check your connection or try another channel.", 3: "This browser could not decode the stream.", 4: "This stream format is not supported by this browser." };
      fail(messages[error?.code] || "Playback failed. Please try another channel.", error);
    });
    session.timer = setTimeout(() => fail("The stream could not be loaded. Please try another channel.", "Startup timeout"), 30000);
    // CORS failures cannot reliably be distinguished from network failures in JS.
    // A local/backend stream proxy may be considered later for incompatible public streams.
    if ((knownHls && nativeHls) || (mime && video.canPlayType(mime)) || unknown) {
      console.info(prefix, "Trying native playback", url.href);
      video.src = url.href;
      attemptPlay();
    } else if (!knownHls || !startHls(url.href)) {
      fail("This stream format is not supported by this browser.", { url: url.href, hlsAvailable: Boolean(window.Hls) });
    }
  }
  return { play, stop, destroy: stop };
})();
