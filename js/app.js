const savedSettings = readSettings();

// Central state is also available in DevTools as window.IPTV_APP_STATE.
const appState = window.IPTV_APP_STATE = {
  playlists: window.IPTV_CONFIG?.playlists || [],
  epgSources: [],
  epgChannels: new Map(),
  epgLoaded: false,
  epgError: null,
  guideStartTime: new Date(savedSettings.guideStart === "now" ? Date.now() : Math.floor(Date.now() / 1800000) * 1800000),
  guideWindowMinutes: 180,
  channels: [],
  filteredChannels: [],
  sortedChannels: new Map(),
  globalSearchQuery: "",
  searchChannelResults: [],
  searchProgramResults: [],
  programSearchIndex: [],
  programSearchTitleGrams: new Map(),
  searchChannelLimit: 20,
  searchProgramLimit: 30,
  selectedProvider: "",
  selectedCategory: "",
  searchQuery: "",
  favorites: readFavorites(),
  recentChannels: readRecentChannels(),
  recentOnly: false,
  favoritesOnly: false,
  guideFavoritesOnly: false,
  settings: savedSettings,
  showGuideLessChannels: savedSettings.showGuideLessChannels,
  visibleLimit: 100,
  view: "home",
  selectedChannel: null,
  playerOpen: false,
  online: navigator.onLine,
  playbackStatus: "idle",
  playbackError: null,
  playlist: null,
  playlistStatus: "idle",
  playlistError: null,
  guideReturnView: "home"
};

async function loadPlaylist() {
  appState.channels = [];
  appState.playlistError = null;
  const enabledPlaylists = appState.playlists.filter(source => source.enabled === true);
  appState.playlist = enabledPlaylists[0] || null;
  if (!enabledPlaylists.length) {
    appState.playlistStatus = "idle";
    refreshLiveData();
    if (appState.view === "search") updateGlobalSearchResults();
    console.warn("[IPTV Hub] No enabled playlist configured.");
    await loadEpg();
    return;
  }

  appState.playlistStatus = "loading";
  const results = await Promise.all(enabledPlaylists.map(async playlist => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(playlist.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Playlist request failed: HTTP ${response.status}`);
      const text = await response.text();
      if (!/^#EXTM3U(?:\s|$)/.test(text.trimStart())) throw new Error("Invalid M3U playlist: missing #EXTM3U header.");
      const channels = window.M3UParser.parse(text);
      if (!Array.isArray(channels) || channels.length === 0) throw new Error("Playlist did not contain any parseable channels.");
      for (const [index, channel] of channels.entries()) {
        channel.provider = playlist.provider || playlist.name || "Unknown provider";
        channel.sourceOrder = index;
        channel.providerOrder = appState.playlists.indexOf(playlist);
        channel.number ||= String(index + 1);
      }
      return { playlist, channels, error: null };
    } catch (error) {
      const message = error.name === "AbortError" ? "Playlist request timed out after 30 seconds." : error.message || "Unable to load playlist.";
      console.error("[IPTV Hub] Unable to load playlist:", playlist.name || playlist.url, message, error);
      return { playlist, channels: [], error: message };
    } finally {
      clearTimeout(timeout);
    }
  }));
  appState.channels = results.flatMap(result => result.channels);
  assignDisplayChannelNumbers();
  cacheChannelOrder();
  const failures = results.filter(result => result.error);
  appState.playlistStatus = appState.channels.length ? "ready" : failures.length ? "error" : "idle";
  appState.playlistError = failures.length ? failures.map(result => `${result.playlist.name || "Playlist"}: ${result.error}`).join(" ") : null;
  console.log(`[IPTV Hub] Total channels: ${appState.channels.length}`);
  logPlaylistDuplicates(enabledPlaylists);
  refreshLiveData();
  if (appState.view === "search") updateGlobalSearchResults();
  renderContinueWatching();
  await loadEpg();
  applyStartupScreen();
}

const DISPLAY_CHANNEL_RANGES = new Map([
  ["Pluto TV", 1000],
  ["Samsung TV Plus", 2000],
  ["Plex TV", 3000],
  ["Roku TV", 4000],
  ["Xumo TV", 5000],
  ["iptv-org", 6000]
]);

function providerDisplayName(provider) {
  return provider === "iptv-org" ? "United States" : provider || "Unknown provider";
}

function assignDisplayChannelNumbers() {
  const counts = new Map();
  for (const channel of appState.channels) {
    const base = DISPLAY_CHANNEL_RANGES.get(channel.provider);
    if (base === undefined) continue;
    const offset = counts.get(channel.provider) || 0;
    channel.displayChannelNumber = base + offset;
    counts.set(channel.provider, offset + 1);
  }
}

function cacheChannelOrder() {
  appState.sortedChannels = new Map([
    ["number", [...appState.channels].sort((a, b) =>
      (a.displayChannelNumber ?? Number.MAX_SAFE_INTEGER) - (b.displayChannelNumber ?? Number.MAX_SAFE_INTEGER) ||
      a.providerOrder - b.providerOrder || a.sourceOrder - b.sourceOrder)],
    ["name", [...appState.channels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))],
    ["provider", [...appState.channels].sort((a, b) => a.providerOrder - b.providerOrder || a.sourceOrder - b.sourceOrder)]
  ]);
}

function logPlaylistDuplicates(playlists) {
  const channelIdsByProvider = new Map();
  for (const playlist of playlists) {
    const provider = playlist.provider || playlist.name || "Unknown provider";
    if (!channelIdsByProvider.has(provider)) channelIdsByProvider.set(provider, new Set());
    const ids = channelIdsByProvider.get(provider);
    for (const channel of appState.channels) {
      if (channel.provider === provider && channel.tvgId?.trim()) ids.add(channel.tvgId.trim());
    }
  }

  const providers = [...channelIdsByProvider.entries()];
  for (let first = 0; first < providers.length; first++) {
    for (let second = first + 1; second < providers.length; second++) {
      const [firstProvider, firstIds] = providers[first];
      const [secondProvider, secondIds] = providers[second];
      let duplicateCount = 0;
      for (const id of firstIds) {
        if (secondIds.has(id)) duplicateCount++;
      }
      // Future deduplication can use these shared tvg-id values; preserve all source channels for now.
      console.info(`[IPTV Hub EPG] Duplicate tvg-id channels between ${firstProvider} and ${secondProvider}: ${duplicateCount}`);
    }
  }
}

async function loadEpg() {
  console.info("[IPTV Hub EPG] EPG loading starts after playlist loading.");
  const globalSources = (window.IPTV_CONFIG?.epgSources || [])
    .filter(source => source && source.enabled !== false)
    .map(source => ({ ...source, global: true, provider: "" }));
  const providerSources = appState.playlists
    .filter(playlist => playlist.enabled === true)
    .flatMap(playlist => (playlist.epg || [])
      .filter(source => source && source.enabled !== false)
      .map(source => ({
        ...source,
        global: false,
        provider: source.provider || playlist.provider || playlist.name || ""
      })));
  const sources = [...globalSources, ...providerSources];
  console.info("[IPTV Hub EPG] Discovered sources", {
    globalSources: globalSources.length,
    playlistSources: providerSources.length
  });
  appState.epgSources = sources.map(source => ({
    name: source.name || source.provider || "XMLTV source",
    url: source.url || "",
    provider: source.provider || "",
    global: source.global,
    status: "loading",
    error: null
  }));
  appState.epgLoaded = false;
  appState.epgError = null;
  const mergedChannels = new Map();
  const programmeKeys = new Map();
  const settled = await Promise.all(sources.map(async (source, index) => {
    const state = appState.epgSources[index];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      console.info("[IPTV Hub EPG] Requesting source:", state.name, source.url);
      if (!source.url) throw new Error("Missing XMLTV URL.");
      const xml = await window.XMLTVLoader.fetchXmltvSource(source, { signal: controller.signal });
      let parsed;
      try {
        parsed = window.XMLTVParser.parse(xml);
      } catch (error) {
        console.error("[IPTV Hub EPG] Invalid XMLTV parsing:", state.name, source.url, error);
        throw new Error("Invalid XMLTV document.", { cause: error });
      }
      for (const [id, parsedChannel] of parsed) {
        const key = JSON.stringify([source.global ? "global" : "provider", source.provider, id]);
        let channel = mergedChannels.get(key);
        if (!channel) {
          channel = {
            key,
            id,
            displayName: parsedChannel.displayName || id,
            displayNames: [],
            icon: parsedChannel.icon || "",
            programmes: [],
            global: false,
            providers: new Set(),
            prefixMaximumStop: []
          };
          mergedChannels.set(key, channel);
          programmeKeys.set(key, new Set());
        }
        for (const name of parsedChannel.displayNames) {
          if (!channel.displayNames.includes(name)) channel.displayNames.push(name);
        }
        if (!channel.icon && parsedChannel.icon) channel.icon = parsedChannel.icon;
        if (source.global) channel.global = true;
        else channel.providers.add(source.provider);
        const keys = programmeKeys.get(key);
        for (const programme of parsedChannel.programmes) {
          const key = `${programme.start}\u0000${programme.stop}\u0000${programme.title}`;
          if (keys.has(key)) continue;
          keys.add(key);
          channel.programmes.push(programme);
        }
      }
      state.status = "loaded";
      console.info("[IPTV Hub EPG] Source loaded:", state.name, source.url);
      return true;
    } catch (error) {
      state.status = "error";
      state.error = error.name === "AbortError" ? "Request timed out after 30 seconds." : error.message || "Unable to load XMLTV source.";
      console.error("[IPTV Hub EPG] Source failed:", state.name, source.url, error.kind || error.name, error);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }));

  for (const channel of mergedChannels.values()) window.IPTVGuide.buildProgrammeIndex(channel);
  appState.epgChannels = mergedChannels;
  const indexes = window.IPTVGuide.buildIndexes(mergedChannels);
  let matched = 0;
  for (const channel of appState.channels) {
    const match = window.IPTVGuide.findMatch(channel, indexes);
    channel.epgChannelId = match?.channel.id || "";
    channel.epgChannelKey = match?.channel.key || "";
    channel.epgMatchStatus = match?.status || "unmatched";
    if (match) matched++;
  }
  const providerLabels = new Map();
  for (const playlist of appState.playlists) {
    const provider = playlist.provider || playlist.name || "Unknown provider";
    if (!providerLabels.has(provider)) providerLabels.set(provider, playlist.name || provider);
  }
  const providers = new Map();
  for (const channel of appState.channels) {
    const provider = channel.provider || "Unknown provider";
    if (!providers.has(provider)) providers.set(provider, { total: 0, matched: 0 });
    const stats = providers.get(provider);
    stats.total++;
    if (channel.epgMatchStatus !== "unmatched") stats.matched++;
  }
  for (const [provider, stats] of providers) {
    const unmatched = stats.total - stats.matched;
    const percentage = stats.total ? (stats.matched / stats.total * 100).toFixed(1) : "0.0";
    console.info(`[IPTV Hub EPG] ${providerLabels.get(provider) || provider}: ${stats.matched} / ${stats.total} matched (${percentage}%)`, {
      provider,
      unmatchedChannels: unmatched
    });
  }
  const total = appState.channels.length;
  const unmatched = total - matched;
  const percentage = total ? (matched / total * 100).toFixed(1) : "0.0";
  console.info("[IPTV Hub EPG] Overall match summary (secondary across mixed providers)", {
    totalChannels: total,
    matchedChannels: matched,
    unmatchedChannels: unmatched,
    matchPercentage: `${percentage}%`
  });

  const failed = settled.filter(success => !success).length;
  appState.epgLoaded = true;
  if (!sources.length || (sources.length && failed === sources.length)) {
    appState.epgError = "TV guide data is currently unavailable.";
  } else if (failed) {
    appState.epgError = `${failed} of ${sources.length} guide sources could not be loaded.`;
  }
  buildProgramSearchIndex();
  refreshGuideFilters();
  renderContinueWatching();
  renderGuidePreview();
  if (appState.view === "guide") renderFullGuide();
  if (appState.view === "sports") renderSports();
  if (appState.view === "search") updateGlobalSearchResults();
}

const categories = [
  ["📺", "Live TV"],
  ["🎬", "Movies"],
  ["▱", "Series"],
  ["🏈", "Sports"],
  ["📰", "News"],
  ["🧸", "Kids"],
  ["🎵", "Music"],
  ["🎥", "Documentary"]
];

function renderCategories() {
  const row = document.getElementById("categoryRow");
  row.innerHTML = categories.map(([icon, label]) => `
    <button class="category-card" data-category="${label}">
      <span class="icon">${icon}</span>
      <strong>${label}</strong>
    </button>
  `).join("");
}

function renderContinueWatching() {
  const row = document.getElementById("continueRow");
  const section = row.closest(".section-block");
  const channelsById = new Map();
  for (const channel of appState.channels) {
    const id = channelId(channel);
    if (!channelsById.has(id)) channelsById.set(id, channel);
  }
  const seen = new Set();
  const recent = [];
  for (const id of appState.recentChannels) {
    if (seen.has(id)) continue;
    seen.add(id);
    const channel = channelsById.get(id);
    if (channel) recent.push(channel);
    if (recent.length === 4) break;
  }

  const cards = recent.map(channel => {
    const epgChannel = appState.epgChannels.get(channel.epgChannelKey);
    const programme = window.IPTVGuide.currentProgram(epgChannel);
    const card = createElement("button", "continue-card");
    card.type = "button";
    card.dataset.continueChannelId = channelId(channel);
    card.dataset.guideChannelKey = channelId(channel);
    card.dataset.provider = channel.provider || "";
    card.setAttribute("aria-label", `Watch ${channel.name}${programme ? `, ${programme.title}` : ""}`);

    const artworkUrl = programme?.icon || channel.logo || epgChannel?.icon || "";
    if (artworkUrl) {
      const artwork = createLogo({ name: channel.name, logo: artworkUrl });
      artwork.classList.add("continue-art");
      artwork.querySelector(".channel-initials").textContent =
        categories.find(([, category]) => channelCategories(channel).includes(category))?.[0] || "▣";
      artwork.append(createElement(
        "span",
        "continue-art-fallback-label",
        `${providerDisplayName(channel.provider)} · ${channelCategories(channel).join(" · ")}`
      ));
      card.append(artwork);
    } else {
      const artwork = createElement("div", "continue-art-fallback");
      artwork.setAttribute("aria-hidden", "true");
      const icon = categories.find(([, category]) => channelCategories(channel).includes(category))?.[0] || "▣";
      artwork.append(
        createElement("span", "continue-fallback-icon", icon),
        createElement("span", "continue-fallback-provider", providerDisplayName(channel.provider))
      );
      card.append(artwork);
    }

    card.append(
      createElement("h3", "", programme?.title || channel.name),
      createElement("p", "", `${providerDisplayName(channel.provider)} · ${channelCategories(channel).join(" · ")}`),
      createElement("span", "continue-play-icon", "▶")
    );
    card.addEventListener("click", () => {
      card.focus({ preventScroll: true });
      appState.selectedChannel = channel;
      openPlayer();
    });
    return card;
  });

  row.replaceChildren(...cards);
  section.hidden = cards.length === 0;
}

const GUIDE_ROW_HEIGHT = 72;
const GUIDE_PIXELS_PER_MINUTE = 8;
const GUIDE_OVERSCAN = 4;
let guideReturnFocus = null;
let guideProgramOpener = null;
let guidePlayerOpener = null;

function matchedChannels() {
  return appState.channels.filter(channel => channel.epgMatchStatus !== "unmatched" && appState.epgChannels.has(channel.epgChannelKey));
}

function guideChannels() {
  const source = appState.sortedChannels.get(appState.settings.channelSort) || appState.channels;
  const channels = source.filter(channel =>
    (appState.showGuideLessChannels || (channel.epgMatchStatus !== "unmatched" && appState.epgChannels.has(channel.epgChannelKey))) &&
    (!appState.selectedProvider || (channel.provider || "Unknown provider") === appState.selectedProvider) &&
    (!appState.selectedCategory || channelCategories(channel).includes(appState.selectedCategory)) &&
    (!appState.guideFavoritesOnly || appState.favorites.has(channelId(channel)))
  );
  const candidates = new Map(channels.map(channel => [channelId(channel), channel]));
  const favorites = channels.filter(channel => appState.favorites.has(channelId(channel)));
  const recent = appState.recentChannels.map(id => candidates.get(id)).filter(channel => channel && !appState.favorites.has(channelId(channel)));
  const prioritized = new Set([...favorites, ...recent]);
  return [...favorites, ...recent, ...channels.filter(channel => !prioritized.has(channel))];
}

function orderedPreviewChannels() {
  const matched = matchedChannels();
  const byId = new Map(matched.map(channel => [channelId(channel), channel]));
  const chosen = [];
  const included = new Set();
  const add = channel => {
    if (!channel) return;
    const id = channelId(channel);
    if (!included.has(id)) { included.add(id); chosen.push(channel); }
  };
  matched.filter(channel => appState.favorites.has(channelId(channel))).forEach(add);
  appState.recentChannels.forEach(id => add(byId.get(id)));
  matched.forEach(add);
  return chosen.slice(0, 6);
}

function guideStartTimestamp() {
  return appState.guideStartTime.getTime();
}

function formatGuideTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function guideLogo(channel) {
  const epg = appState.epgChannels.get(channel.epgChannelKey);
  return createLogo({ ...channel, logo: channel.logo || epg?.icon || "" });
}

function displayNumber(channel) {
  return channel.displayChannelNumber ?? channel.number ?? "";
}

function setTimelineWidth(element) {
  element.style.width = `${appState.guideWindowMinutes * GUIDE_PIXELS_PER_MINUTE}px`;
}

function appendTimeHeaders(container, start) {
  container.replaceChildren();
  setTimelineWidth(container);
  const fragment = document.createDocumentFragment();
  const count = appState.guideWindowMinutes / 30;
  for (let index = 0; index < count; index++) {
    const tick = createElement("div", "guide-time-tick", formatGuideTime(start + index * 30 * 60000));
    tick.style.width = `${30 * GUIDE_PIXELS_PER_MINUTE}px`;
    fragment.append(tick);
  }
  container.append(fragment);
}

function appendNowLine(container, start) {
  const old = container.querySelector(".guide-now-line");
  old?.remove();
  const now = Date.now();
  if (now < start || now > start + appState.guideWindowMinutes * 60000) return;
  const line = createElement("div", "guide-now-line");
  line.style.left = `${(now - start) / 60000 * GUIDE_PIXELS_PER_MINUTE}px`;
  line.setAttribute("aria-hidden", "true");
  container.append(line);
}

function appendNowLabel(container, start) {
  const label = createElement("span", "guide-now-label", `Now ${formatGuideTime(Date.now())}`);
  label.classList.add("guide-now-indicator");
  label.style.left = `${Math.max(0, Math.min(appState.guideWindowMinutes * GUIDE_PIXELS_PER_MINUTE, (Date.now() - start) / 60000 * GUIDE_PIXELS_PER_MINUTE))}px`;
  container.append(label);
}

function updateNowIndicators() {
  const start = guideStartTimestamp();
  const end = start + appState.guideWindowMinutes * 60000;
  const now = Date.now();
  const left = Math.max(0, Math.min(appState.guideWindowMinutes * GUIDE_PIXELS_PER_MINUTE, (now - start) / 60000 * GUIDE_PIXELS_PER_MINUTE));
  document.querySelectorAll(".guide-now-indicator").forEach(label => {
    label.textContent = `Now ${formatGuideTime(now)}`;
    label.style.left = `${left}px`;
  });
  document.querySelectorAll(".guide-now-line").forEach(line => {
    line.style.left = `${left}px`;
    line.hidden = now < start || now > end;
  });
  document.querySelectorAll(".guide-program-button").forEach(button => {
    const begins = Number(button.dataset.programStart);
    const ends = Number(button.dataset.programStop);
    button.classList.toggle("is-current", begins <= now && ends > now);
  });
}

function renderGuidePreview() {
  const grid = document.getElementById("guidePreview");
  if (!grid) return;
  const message = document.getElementById("guidePreviewMessage");
  const channels = orderedPreviewChannels();
  const start = guideStartTimestamp();
  const end = start + appState.guideWindowMinutes * 60000;
  const timeline = createElement("div", "guide-preview-timeline");
  const header = createElement("div", "guide-preview-header");
  const leftHeader = createElement("div", "guide-preview-channel");
  leftHeader.append(createElement("strong", "", "Channel"));
  header.append(leftHeader);
  const timeHeaders = createElement("div", "guide-time-headers");
  appendTimeHeaders(timeHeaders, start);
  appendNowLabel(timeHeaders, start);
  header.append(timeHeaders);
  timeline.append(header);
  const rows = createElement("div", "guide-preview-rows");
  setTimelineWidth(rows);
  for (const [index, channel] of channels.entries()) {
    const row = createElement("div", "guide-preview-row");
    const channelButton = createElement("button", "guide-preview-channel guide-channel-launch");
    channelButton.type = "button";
    channelButton.setAttribute("aria-label", `Watch ${channel.name}`);
    channelButton.dataset.guideChannelKey = channelId(channel);
    channelButton.append(createElement("span", "guide-channel-number", String(displayNumber(channel) || index + 1)), guideLogo(channel), createElement("strong", "guide-channel-name", channel.name));
    channelButton.addEventListener("click", () => playChannelFromGuide(channel, channelButton));
    row.append(channelButton);
    const track = createElement("div", "guide-preview-track");
    setTimelineWidth(track);
    for (const programme of window.IPTVGuide.programsInWindow(appState.epgChannels.get(channel.epgChannelKey), start, end)) {
      const block = createProgramButton(programme, channel, start, true);
      track.append(block);
    }
    appendNowLine(track, start);
    row.append(track);
    rows.append(row);
  }
  timeline.append(rows);
  grid.replaceChildren(timeline);
  if (message) {
    message.textContent = appState.epgError || (channels.length ? "" : "TV guide data is currently unavailable.");
    message.hidden = !message.textContent;
  }
}

function createProgramButton(programme, channel, start, preview = false) {
  const button = createElement("button", `guide-program-button${programme.start <= Date.now() && programme.stop > Date.now() ? " is-current" : ""}`, programme.title);
  button.type = "button";
  button.dataset.programStart = String(programme.start);
  button.dataset.programStop = String(programme.stop);
  button.dataset.guideChannelKey = channelId(channel);
  button.setAttribute("aria-label", `${programme.title}, ${channel.name}, ${formatGuideTime(programme.start)} to ${formatGuideTime(programme.stop)}`);
  button.dataset.programCenter = String((programme.start + programme.stop) / 2);
  const left = Math.max(0, (programme.start - start) / 60000 * GUIDE_PIXELS_PER_MINUTE);
  const right = Math.min(appState.guideWindowMinutes * GUIDE_PIXELS_PER_MINUTE, (programme.stop - start) / 60000 * GUIDE_PIXELS_PER_MINUTE);
  button.style.left = `${left}px`;
  button.style.width = `${Math.max(1, right - left - 4)}px`;
  button.title = `${programme.title} · ${formatGuideTime(programme.start)}–${formatGuideTime(programme.stop)}`;
  button.addEventListener("click", () => showProgramDetail(channel, programme, button));
  if (preview) button.classList.add("guide-preview-program");
  return button;
}

function refreshGuideFilters() {
  const guideSourceChannels = appState.showGuideLessChannels ? appState.channels : matchedChannels();
  const providers = [...new Set(guideSourceChannels.map(channel => channel.provider || "Unknown provider"))].sort();
  const providerSelect = document.getElementById("guideProviderFilter");
  if (!providerSelect) return;
  const previousProvider = appState.selectedProvider;
  providerSelect.replaceChildren(new Option("All providers", ""));
  providers.forEach(provider => providerSelect.add(new Option(providerDisplayName(provider), provider)));
  if (!providers.includes(previousProvider)) appState.selectedProvider = "";
  providerSelect.value = appState.selectedProvider;

  const groups = [...new Set(guideSourceChannels.flatMap(channelCategories))].sort((a, b) => a.localeCompare(b));
  const categorySelect = document.getElementById("guideCategoryFilter");
  categorySelect.replaceChildren(new Option("All categories", ""));
  groups.forEach(category => categorySelect.add(new Option(category, category)));
  if (!groups.includes(appState.selectedCategory)) appState.selectedCategory = "";
  categorySelect.value = appState.selectedCategory;
  document.getElementById("guideFavoritesOnly").setAttribute("aria-pressed", String(appState.guideFavoritesOnly));
  document.getElementById("showGuideLessChannels").checked = appState.showGuideLessChannels;
}

function renderFullGuide() {
  if (appState.view !== "guide") return;
  document.querySelector(".guide-left-header").textContent = "Channel";
  const channels = guideChannels();
  const start = guideStartTimestamp();
  const end = start + appState.guideWindowMinutes * 60000;
  const content = document.getElementById("guideTimelineContent");
  const width = appState.guideWindowMinutes * GUIDE_PIXELS_PER_MINUTE;
  content.style.width = `${width}px`;
  const headers = document.getElementById("guideTimeHeaders");
  appendTimeHeaders(headers, start);
  appendNowLabel(headers, start);

  const message = document.getElementById("guideMessage");
  const noMatches = !channels.length;
  message.textContent = appState.epgError || (noMatches ? "TV guide data is currently unavailable." : "");
  message.hidden = !message.textContent;

  const viewport = document.getElementById("guideProgramViewport");
  const scrollTop = viewport.scrollTop;
  const totalHeight = channels.length * GUIDE_ROW_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / GUIDE_ROW_HEIGHT) - GUIDE_OVERSCAN);
  const count = Math.ceil((viewport.clientHeight || 520) / GUIDE_ROW_HEIGHT) + GUIDE_OVERSCAN * 2;
  const last = Math.min(channels.length, first + count);
  const channelLayer = document.getElementById("guideChannelLayer");
  const programLayer = document.getElementById("guideProgramLayer");
  channelLayer.style.height = `${totalHeight}px`;
  programLayer.style.height = `${totalHeight}px`;
  channelLayer.replaceChildren();
  programLayer.replaceChildren();

  for (let index = first; index < last; index++) {
    const channel = channels[index];
    const top = index * GUIDE_ROW_HEIGHT;
    const channelButton = createElement("button", "guide-full-channel guide-channel-launch");
    channelButton.type = "button";
    channelButton.dataset.guideRowIndex = String(index);
    channelButton.dataset.guideChannelKey = channelId(channel);
    channelButton.style.top = `${top}px`;
    channelButton.setAttribute("aria-label", `Watch channel ${displayNumber(channel)}, ${channel.name}`);
    channelButton.append(
      createElement("span", "guide-channel-number", String(displayNumber(channel))),
      guideLogo(channel),
      createElement("span", "guide-channel-identity", channel.name),
      ...(!appState.selectedProvider ? [createElement("small", "guide-channel-provider", providerDisplayName(channel.provider))] : [])
    );
    channelButton.addEventListener("click", () => playChannelFromGuide(channel, channelButton));
    channelLayer.append(channelButton);

    const row = createElement("div", "guide-full-row");
    row.dataset.guideRowIndex = String(index);
    row.style.top = `${top}px`;
    row.style.width = `${width}px`;
    const epgChannel = appState.epgChannels.get(channel.epgChannelKey);
    const programmes = epgChannel ? window.IPTVGuide.programsInWindow(epgChannel, start, end) : [];
    programmes.forEach((programme, programIndex) => {
      const block = createProgramButton(programme, channel, start);
      block.dataset.guideRowIndex = String(index);
      block.dataset.guideProgramIndex = String(programIndex);
      block.dataset.guideChannelKey = channelId(channel);
      row.append(block);
    });
    if (!programmes.length) row.append(createElement("span", "guide-no-program", "No guide data"));
    appendNowLine(row, start);
    programLayer.append(row);
  }
  document.getElementById("guideChannelViewport").scrollTop = scrollTop;
}

function showProgramDetail(channel, programme, opener) {
  guideProgramOpener = opener;
  appState.selectedChannel = channel;
  document.getElementById("programDetailTitle").textContent = programme.title;
  document.getElementById("programDetailChannel").textContent = channel.name;
  document.getElementById("programDetailTime").textContent = `${formatGuideTime(programme.start)} – ${formatGuideTime(programme.stop)}`;
  document.getElementById("programDetailDescription").textContent = programme.desc || "No description available.";
  document.getElementById("programDetail").showModal();
  document.getElementById("closeProgramDetail").focus();
}

function restoreProgramFocus() {
  if (guideProgramOpener?.isConnected) {
    guideProgramOpener.focus();
    return;
  }
  const channelKey = guideProgramOpener?.dataset.guideChannelKey;
  const start = guideProgramOpener?.dataset.programStart;
  const candidates = [...document.querySelectorAll("#guideView [data-guide-channel-key], #guidePreview [data-guide-channel-key]")];
  const target = candidates.find(element =>
    element.dataset.guideChannelKey === channelKey && element.dataset.programStart === start
  );
  (target || (appState.view === "guide" ? document.getElementById("guideBack") : document.querySelector("[data-page='guide']"))).focus();
}

function playChannelFromGuide(channel, opener) {
  guidePlayerOpener = opener;
  appState.selectedChannel = channel;
  if (!appState.playerOpen) openPlayer();
}

function openGuide(opener) {
  document.getElementById("sportsView").hidden = true;
  guideReturnFocus = opener || document.activeElement;
  appState.guideReturnView = ["live", "search"].includes(appState.view) ? appState.view : "home";
  appState.view = "guide";
  document.getElementById("homeView").hidden = true;
  document.getElementById("liveView").hidden = true;
  document.getElementById("searchView").hidden = true;
  document.getElementById("homeHeader").hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("guideView").hidden = false;
  document.getElementById("guideProgramViewport").scrollTop = 0;
  renderFullGuide();
  document.getElementById("guideBack").focus();
}

function closeGuide() {
  const returnView = appState.guideReturnView;
  appState.view = returnView;
  document.getElementById("guideView").hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("homeView").hidden = returnView !== "home";
  document.getElementById("liveView").hidden = returnView !== "live";
  document.getElementById("searchView").hidden = returnView !== "search";
  document.getElementById("homeHeader").hidden = !["home", "search"].includes(returnView);
  if (guideReturnFocus?.isConnected) guideReturnFocus.focus();
  else (returnView === "live" ? document.getElementById("backHome") : document.querySelector(".top-actions [data-page='guide']")).focus();
}

function shiftGuideWindow(minutes) {
  appState.guideStartTime = new Date(guideStartTimestamp() + minutes * 60000);
  renderGuidePreview();
  renderFullGuide();
}

function focusGuideRow(rowIndex, programIndex = 0) {
  const viewport = document.getElementById("guideProgramViewport");
  const top = rowIndex * GUIDE_ROW_HEIGHT;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + GUIDE_ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + GUIDE_ROW_HEIGHT - viewport.clientHeight;
  renderFullGuideRowsForFocus();
  const target = document.querySelector(`[data-guide-row-index="${rowIndex}"][data-guide-program-index="${programIndex}"]`)
    || document.querySelector(`.guide-channel-launch[data-guide-row-index="${rowIndex}"]`);
  target?.focus({ preventScroll: true });
}

function renderFullGuideRowsForFocus() {
  renderFullGuide();
}

function handleGuideKey(event) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return false;
  const current = document.activeElement;
  const rowIndex = Number(current.dataset.guideRowIndex);
  if (!Number.isInteger(rowIndex)) return false;
  const channels = guideChannels();
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const nextRow = rowIndex + (event.key === "ArrowDown" ? 1 : -1);
    if (nextRow < 0 || nextRow >= channels.length) return false;
    const center = Number(current.dataset.programCenter);
    if (!Number.isFinite(center)) {
      event.preventDefault();
      focusGuideRow(nextRow);
      return true;
    }
    const nextChannel = channels[nextRow];
    const nextPrograms = window.IPTVGuide.programsInWindow(
      appState.epgChannels.get(nextChannel.epgChannelKey),
      guideStartTimestamp(),
      guideStartTimestamp() + appState.guideWindowMinutes * 60000
    );
    const programIndex = nextPrograms.reduce((closest, programme, index) =>
      Math.abs((programme.start + programme.stop) / 2 - center) <
        Math.abs((nextPrograms[closest].start + nextPrograms[closest].stop) / 2 - center) ? index : closest, 0);
    event.preventDefault();
    focusGuideRow(nextRow, programIndex);
    return true;
  }
  if (current.classList.contains("guide-program-button")) {
    const row = current.closest(".guide-full-row");
    const buttons = [...row.querySelectorAll(".guide-program-button")];
    const center = Number(current.dataset.programCenter);
    const neighbors = buttons
      .filter(button => event.key === "ArrowRight" ? Number(button.dataset.programCenter) > center : Number(button.dataset.programCenter) < center)
      .sort((first, second) => Math.abs(Number(first.dataset.programCenter) - center) - Math.abs(Number(second.dataset.programCenter) - center));
    if (neighbors.length) {
      event.preventDefault();
      neighbors[0].focus();
      return true;
    }
  }
  event.preventDefault();
  return true;
}

function setupGuide() {
  document.querySelectorAll("[data-page='guide']").forEach(button => button.addEventListener("click", () => openGuide(button)));
  document.getElementById("guideBack").addEventListener("click", closeGuide);
  document.getElementById("guideEarlier").addEventListener("click", () => shiftGuideWindow(-30));
  document.getElementById("guideLater").addEventListener("click", () => shiftGuideWindow(30));
  document.getElementById("guideProviderFilter").addEventListener("change", event => {
    appState.selectedProvider = event.target.value;
    renderFullGuide();
  });
  document.getElementById("guideCategoryFilter").addEventListener("change", event => {
    appState.selectedCategory = event.target.value;
    renderFullGuide();
  });
  document.getElementById("guideFavoritesOnly").addEventListener("click", event => {
    appState.guideFavoritesOnly = !appState.guideFavoritesOnly;
    event.currentTarget.setAttribute("aria-pressed", String(appState.guideFavoritesOnly));
    renderFullGuide();
  });
  document.getElementById("showGuideLessChannels").addEventListener("change", event => {
    appState.showGuideLessChannels = event.target.checked;
    appState.settings.showGuideLessChannels = event.target.checked;
    saveSettings();
    document.getElementById("settingsShowGuideLess").checked = event.target.checked;
    refreshGuideFilters();
    renderFullGuide();
  });
  document.getElementById("settingsBack").addEventListener("click", closeSettings);
  document.getElementById("settingsShowGuideLess").addEventListener("change", event => {
    appState.settings.showGuideLessChannels = event.target.checked;
    appState.showGuideLessChannels = event.target.checked;
    document.getElementById("showGuideLessChannels").checked = event.target.checked;
    saveSettings();
    refreshGuideFilters();
    renderFullGuide();
  });
  document.getElementById("settingsStartup").addEventListener("change", event => {
    appState.settings.startupScreen = event.target.value;
    saveSettings();
  });
  document.getElementById("settingsGuideStart").addEventListener("change", event => {
    appState.settings.guideStart = event.target.value;
    const timestamp = Date.now();
    appState.guideStartTime = new Date(event.target.value === "now" ? timestamp : Math.floor(timestamp / 1800000) * 1800000);
    saveSettings();
    renderGuidePreview();
    renderFullGuide();
  });
  document.getElementById("settingsChannelSort").addEventListener("change", event => {
    appState.settings.channelSort = event.target.value;
    saveSettings();
    applyFilters();
    renderGuidePreview();
    renderFullGuide();
  });
  document.getElementById("guideProgramViewport").addEventListener("scroll", event => {
    document.getElementById("guideChannelViewport").scrollTop = event.currentTarget.scrollTop;
    renderFullGuide();
  });
  const detail = document.getElementById("programDetail");
  document.getElementById("closeProgramDetail").addEventListener("click", () => detail.close());
  document.getElementById("programWatchLive").addEventListener("click", () => {
    guidePlayerOpener = guideProgramOpener;
    openPlayer();
  });
  detail.addEventListener("cancel", event => { event.preventDefault(); detail.close(); });
  detail.addEventListener("close", () => {
    if (!appState.playerOpen) restoreProgramFocus();
  });
}

function setupKeyboardNavigation() {
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented) return;
    if (appState.playerOpen) return; // The player owns its keys; native video controls keep theirs.
    const modal = document.getElementById("channelDetail");
    const programModal = document.getElementById("programDetail");
    const editing = event.target.matches("input, textarea, select, [contenteditable='true']");
    if (appState.view === "guide" && !programModal.open && handleGuideKey(event)) return;
    if (event.key === "Escape" || (event.key === "Backspace" && (!editing || appState.view === "settings"))) {
      if (programModal.open) { event.preventDefault(); programModal.close(); }
      else if (modal.open) { event.preventDefault(); modal.close(); }
      else if (appState.view === "guide") { event.preventDefault(); closeGuide(); }
      else if (appState.view === "settings") { event.preventDefault(); closeSettings(); }
      else if (appState.view === "sports") { event.preventDefault(); closeSports(); }
      else if (appState.view === "live") { event.preventDefault(); showHome(); }
      else if (appState.view === "search") {
        event.preventDefault();
        appState.view = "home";
        document.getElementById("searchView").hidden = true;
        document.getElementById("homeView").hidden = false;
        document.getElementById("homeHeader").hidden = false;
        document.getElementById("globalSearch").focus();
      }
      return;
    }
    // Preserve native text editing and select navigation.
    if (editing || modal.open || !event.key.startsWith("Arrow")) return;
    const card = event.target.closest(".channel-card");
    if (card && appState.view === "live") {
      const cards = [...document.querySelectorAll(".channel-card")];
      const index = cards.indexOf(card);
      const columns = getComputedStyle(document.getElementById("channelGrid")).gridTemplateColumns.split(" ").length;
      let next = index;
      if (event.key === "ArrowRight" && index % columns < columns - 1) next++;
      if (event.key === "ArrowLeft" && index % columns > 0) next--;
      if (event.key === "ArrowDown") next = Math.min(index + columns, cards.length - 1);
      if (event.key === "ArrowUp") next = index - columns;
      event.preventDefault();
      if (next < 0) document.getElementById("liveSearch").focus();
      else cards[Math.min(next, cards.length - 1)]?.querySelector(".channel-select").focus();
      return;
    }
    const scope = appState.view === "live" ? document.getElementById("liveView") : document;
    const focusable = [...scope.querySelectorAll("button, input, select, [tabindex='0']")]
      .filter(el => !el.disabled && el.getClientRects().length);
    const index = focusable.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    focusable[Math.max(0, Math.min(index + delta, focusable.length - 1))]?.focus();
  });
}

let installPromptEvent = null;
let appInstalled = false;
let waitingServiceWorker = null;
let updateReloadPending = false;
let updateReloadStarted = false;
let updateControllerChangeHandler = null;
let updateWaitTimer = null;

function isStandaloneMode() {
  return appInstalled ||
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    navigator.standalone === true;
}

function renderInstallStatus(message = "") {
  const installButton = document.getElementById("installApp");
  if (!installButton) return;
  const standalone = isStandaloneMode();
  document.getElementById("appModeStatus").textContent = standalone ? "Installed App" : "Browser";
  installButton.hidden = standalone || !installPromptEvent;
  document.getElementById("installStatus").textContent = message ||
    (standalone ? "IPTV Hub is installed on this device." :
      installPromptEvent ? "Available to install on this device." : "Not currently available in this browser.");
}

function renderConnectionStatus() {
  const wasOnline = appState.online;
  const online = navigator.onLine;
  appState.online = online;
  const status = document.getElementById("connectionStatus");
  status.textContent = online ? "Online" : "Offline";
  status.classList.toggle("is-offline", !online);
  document.getElementById("watchLive").disabled = !online;
  document.getElementById("programWatchLive").disabled = !online;
  const selectedIndex = appState.filteredChannels.indexOf(appState.selectedChannel);
  document.getElementById("previousChannel").disabled = !online || selectedIndex <= 0;
  document.getElementById("nextChannel").disabled = !online ||
    selectedIndex < 0 || selectedIndex >= appState.filteredChannels.length - 1;

  if (!online && wasOnline && appState.playerOpen) {
    IPTVPlayer.stop();
    appState.playbackStatus = "offline";
    document.getElementById("playbackMessage").textContent = "Offline. Connect to watch live.";
  } else if (online && !wasOnline && appState.playerOpen) {
    appState.playbackStatus = "idle";
    document.getElementById("playbackMessage").textContent = "Online. Select a channel to resume.";
  }
}

function setWaitingServiceWorker(worker) {
  if (!worker || !navigator.serviceWorker.controller) return;
  waitingServiceWorker = worker;
  document.getElementById("updateStatus").textContent = "Update available.";
  document.getElementById("updateNow").hidden = false;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    document.getElementById("updateStatus").textContent = "Updates are unavailable in this browser.";
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(registration => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaitingServiceWorker(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && registration.waiting) {
            setWaitingServiceWorker(registration.waiting);
          }
        });
      });
    }).catch(error => {
      console.error("[IPTV Hub PWA] Service worker registration failed:", error);
      document.getElementById("updateStatus").textContent = "Updates could not be checked.";
    });
  });
}

function setupPwaControls() {
  const installStatus = document.getElementById("installStatus");
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (isStandaloneMode()) return;
    installPromptEvent = event;
    renderInstallStatus();
  });
  window.addEventListener("appinstalled", () => {
    installPromptEvent = null;
    appInstalled = true;
    renderInstallStatus("IPTV Hub is installed on this device.");
  });
  const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
  if (standaloneQuery) {
    const onModeChange = () => renderInstallStatus();
    if (standaloneQuery.addEventListener) standaloneQuery.addEventListener("change", onModeChange);
    else standaloneQuery.addListener(onModeChange);
  }
  renderInstallStatus();

  document.getElementById("installApp").addEventListener("click", async () => {
    const prompt = installPromptEvent;
    if (!prompt || isStandaloneMode()) return;
    installPromptEvent = null;
    renderInstallStatus("Opening the install prompt…");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        appInstalled = true;
        renderInstallStatus("IPTV Hub is installed on this device.");
      } else {
        renderInstallStatus("Installation was dismissed.");
      }
    } catch (error) {
      console.warn("[IPTV Hub PWA] Install prompt failed:", error);
      renderInstallStatus("Install is unavailable right now.");
    }
  });

  document.getElementById("updateNow").addEventListener("click", () => {
    if (!waitingServiceWorker || updateReloadPending) return;
    updateReloadPending = true;
    document.getElementById("updateNow").disabled = true;
    document.getElementById("updateStatus").textContent = "Installing update…";

    updateControllerChangeHandler = () => {
      if (!updateReloadPending || updateReloadStarted) return;
      updateReloadPending = false;
      updateReloadStarted = true;
      clearTimeout(updateWaitTimer);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", updateControllerChangeHandler);
    updateWaitTimer = setTimeout(() => {
      if (!updateReloadPending) return;
      updateReloadPending = false;
      navigator.serviceWorker.removeEventListener("controllerchange", updateControllerChangeHandler);
      updateControllerChangeHandler = null;
      document.getElementById("updateNow").disabled = false;
      document.getElementById("updateStatus").textContent = "Update could not be applied. Select Update Now to try again.";
    }, 15000);
    waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
  });
}

function setupConnectionStatus() {
  window.addEventListener("online", renderConnectionStatus);
  window.addEventListener("offline", renderConnectionStatus);
  renderConnectionStatus();
}

renderCategories();
renderContinueWatching();
setupLiveTV();
setupSports();
setupGlobalSearch();
setupGuide();
setupPlayer();
setupKeyboardNavigation();
setupPwaControls();
setupConnectionStatus();
registerServiceWorker();
loadPlaylist();
renderGuidePreview();
setInterval(() => {
  updateNowIndicators();
  if (appState.view === "sports" && !appState.playerOpen && !document.getElementById("programDetail").open) renderSports();
}, 30000);
// Favorites store IDs only; filteredChannels contains references to the loaded objects.
function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem("iptv-hub-favorites") || "[]");
    return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []);
  } catch (error) {
    console.warn("[IPTV Hub] Favorites could not be restored:", error);
    return new Set();
  }
}

function readSettings() {
  const defaults = {
    showGuideLessChannels: false,
    startupScreen: "home",
    guideStart: "half-hour",
    channelSort: "number"
  };
  try {
    const saved = JSON.parse(localStorage.getItem("iptv-hub-settings") || "{}");
    return {
      showGuideLessChannels: saved.showGuideLessChannels === true,
      startupScreen: ["home", "live", "guide"].includes(saved.startupScreen) ? saved.startupScreen : defaults.startupScreen,
      guideStart: ["now", "half-hour"].includes(saved.guideStart) ? saved.guideStart : defaults.guideStart,
      channelSort: ["number", "name", "provider"].includes(saved.channelSort) ? saved.channelSort : defaults.channelSort
    };
  } catch (error) {
    console.warn("[IPTV Hub] Settings could not be restored:", error);
    return defaults;
  }
}

function readRecentChannels() {
  try {
    const saved = JSON.parse(localStorage.getItem("iptv-hub-recent-channels") || "[]");
    if (!Array.isArray(saved)) return [];
    const recent = [...new Set(saved.filter(id => typeof id === "string"))].slice(0, 20);
    if (recent.length !== saved.length) localStorage.setItem("iptv-hub-recent-channels", JSON.stringify(recent));
    return recent;
  } catch (error) {
    console.warn("[IPTV Hub] Recent channels could not be restored:", error);
    return [];
  }
}

function channelId(channel) {
  return channel.tvgId?.trim()
    ? `tvg:${channel.tvgId.trim()}`
    : `source:${JSON.stringify([channel.provider || "", channel.name || "", channel.url || ""])}`;
}

function normalizeCategory(value) {
  const name = (value || "Other").trim().replace(/\s+/g, " ") || "Other";
  const aliases = { movie: "Movies", movies: "Movies", sport: "Sports", sports: "Sports", news: "News", kids: "Kids", children: "Kids", music: "Music", documentary: "Documentary", documentaries: "Documentary" };
  return aliases[name.toLowerCase()] || name;
}

function saveSettings() {
  try {
    localStorage.setItem("iptv-hub-settings", JSON.stringify(appState.settings));
  } catch (error) {
    console.warn("[IPTV Hub] Settings could not be saved:", error);
  }
}

function updateRecentChannels(channel) {
  const id = channelId(channel);
  appState.recentChannels = [id, ...appState.recentChannels.filter(savedId => savedId !== id)].slice(0, 20);
  try {
    localStorage.setItem("iptv-hub-recent-channels", JSON.stringify(appState.recentChannels));
  } catch (error) {
    console.warn("[IPTV Hub] Recent channels could not be saved:", error);
  }
  renderContinueWatching();
  applyFilters({ preserveVisibleLimit: true });
  renderGuidePreview();
  if (appState.view === "guide") renderFullGuide();
}

function channelCategories(channel) {
  // M3U permits several groups separated by semicolons. Preserve the original group.
  return [...new Set((channel.group || "Other").split(";").map(normalizeCategory))];
}

function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function searchChannelRank(channel, query) {
  const displayNumber = String(channel.displayChannelNumber ?? "");
  const sourceNumber = String(channel.number ?? "");
  const name = normalizeSearchText(channel.name);
  const tvgName = normalizeSearchText(channel.tvgName);
  const provider = normalizeSearchText(providerDisplayName(channel.provider));
  const group = normalizeSearchText(channel.group);
  const categories = channelCategories(channel).map(normalizeSearchText);
  const tvgId = normalizeSearchText(channel.tvgId);

  if (displayNumber === query || sourceNumber === query) return 0;
  if (name === query) return 1;
  if (name.startsWith(query)) return 2;
  if (name.includes(query)) return 3;
  if (displayNumber.includes(query) || sourceNumber.includes(query)) return 4;
  if (tvgName.includes(query)) return 5;
  if (provider.includes(query) || group.includes(query) || categories.some(category => category.includes(query))) return 6;
  if (tvgId.includes(query)) return 7;
  return null;
}

function searchTextBigrams(value) {
  const characters = Array.from(value);
  const grams = new Set();
  for (let index = 0; index < characters.length - 1; index++) {
    grams.add(characters[index] + characters[index + 1]);
  }
  return grams;
}

function buildProgramSearchIndex() {
  const channelsByEpgKey = new Map();
  for (const channel of appState.channels) {
    if (!channel.epgChannelKey) continue;
    if (!channelsByEpgKey.has(channel.epgChannelKey)) channelsByEpgKey.set(channel.epgChannelKey, []);
    channelsByEpgKey.get(channel.epgChannelKey).push(channel);
  }

  const index = [];
  const titleGrams = new Map();
  const now = Date.now();
  for (const [epgChannelKey, epgChannel] of appState.epgChannels) {
    const matchedChannels = channelsByEpgKey.get(epgChannelKey) || [];
    if (!matchedChannels.length) continue;
    for (const programme of epgChannel.programmes) {
      if (programme.stop <= now) continue;
      const title = String(programme.title || "");
      const normalizedTitle = normalizeSearchText(title);
      if (!normalizedTitle) continue;
      for (const channel of matchedChannels) {
        const indexEntry = index.length;
        index.push({ title, normalizedTitle, start: programme.start, stop: programme.stop, channel, epgChannelKey, programme });
        for (const gram of searchTextBigrams(normalizedTitle)) {
          if (!titleGrams.has(gram)) titleGrams.set(gram, new Set());
          titleGrams.get(gram).add(indexEntry);
        }
      }
    }
  }
  appState.programSearchIndex = index;
  appState.programSearchTitleGrams = titleGrams;
}

function matchingProgramIndexes(query) {
  const grams = [...searchTextBigrams(query)];
  if (!grams.length) return [];
  const sets = grams.map(gram => appState.programSearchTitleGrams.get(gram));
  if (sets.some(set => !set)) return [];
  sets.sort((first, second) => first.size - second.size);
  return [...sets[0]].filter(index => sets.every(set => set.has(index)));
}

function searchPrograms(query) {
  const now = Date.now();
  return matchingProgramIndexes(query)
    .map(index => appState.programSearchIndex[index])
    .filter(result => result.stop > now && result.normalizedTitle.includes(query))
    .map(result => ({
      result,
      rank: result.normalizedTitle === query ? 0 : result.normalizedTitle.startsWith(query) ? 1 : 2,
      current: result.start <= now
    }))
    .sort((first, second) =>
      first.rank - second.rank ||
      Number(second.current) - Number(first.current) ||
      first.result.start - second.result.start
    )
    .map(item => item.result);
}

function updateGlobalSearchResults() {
  const query = normalizeSearchText(appState.globalSearchQuery);
  const channelSearchEnabled = query.length >= 2 || /^\d$/.test(query);
  if (!query) {
    appState.searchChannelResults = [];
    appState.searchProgramResults = [];
    appState.view = "home";
    document.getElementById("searchView").hidden = true;
    document.getElementById("homeView").hidden = false;
    document.getElementById("homeHeader").hidden = false;
    return;
  }

  appState.searchChannelResults = channelSearchEnabled
    ? appState.channels
      .map((channel, index) => ({ channel, index, rank: searchChannelRank(channel, query) }))
      .filter(item => item.rank !== null)
      .sort((first, second) => first.rank - second.rank || first.index - second.index)
      .map(item => item.channel)
    : [];
  appState.searchProgramResults = query.length >= 2 ? searchPrograms(query) : [];
  appState.searchChannelLimit = 20;
  appState.searchProgramLimit = 30;
  appState.view = "search";
  document.getElementById("homeView").hidden = true;
  document.getElementById("liveView").hidden = true;
  document.getElementById("guideView").hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("searchView").hidden = false;
  document.getElementById("homeHeader").hidden = false;
  renderSearchResults(query);
}

function searchProgramSchedule(result, now = Date.now()) {
  const start = new Date(result.start);
  const today = new Date(now).toDateString() === start.toDateString();
  const date = today ? "" : start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const isCurrent = result.start <= now && result.stop > now;
  return {
    date,
    time: formatGuideTime(result.start),
    current: isCurrent,
    status: isCurrent ? "On Now" : `Starts ${formatGuideTime(result.start)}`
  };
}

function renderSearchResults(query = normalizeSearchText(appState.globalSearchQuery)) {
  const channelResults = document.getElementById("searchChannelResults");
  const programResults = document.getElementById("searchProgramResults");
  const message = document.getElementById("searchResultsMessage");
  const thresholdMet = query.length >= 2 || /^\d$/.test(query);
  document.getElementById("searchChannelCount").textContent = String(appState.searchChannelResults.length);
  document.getElementById("searchProgramCount").textContent = String(appState.searchProgramResults.length);
  channelResults.replaceChildren();
  programResults.replaceChildren();

  if (!thresholdMet) {
    message.textContent = "Type at least 2 characters to search.";
  } else {
    message.textContent = "";
    appState.searchChannelResults.slice(0, appState.searchChannelLimit).forEach(channel => {
      const button = createElement("button", "search-result-card search-channel-card");
      button.type = "button";
      button.setAttribute("aria-label", `Channel ${displayNumber(channel)}, ${channel.name}, ${providerDisplayName(channel.provider)}`);
      const logo = createLogo(channel);
      logo.classList.add("search-result-art");
      const copy = createElement("span", "search-result-copy");
      copy.append(
        createElement("strong", "", channel.name),
        createElement("span", "", `Channel ${displayNumber(channel)} · ${providerDisplayName(channel.provider)}`),
        createElement("span", "", channelCategories(channel).join(" · "))
      );
      button.append(logo, copy);
      button.addEventListener("click", () => showChannelDetail(channel, button));
      channelResults.append(button);
    });

    const now = Date.now();
    appState.searchProgramResults.slice(0, appState.searchProgramLimit).forEach(result => {
      const button = createElement("button", "search-result-card search-program-card");
      button.type = "button";
      button.dataset.guideChannelKey = channelId(result.channel);
      button.dataset.programStart = String(result.start);
      button.setAttribute("aria-label", `${result.title}, ${result.channel.name}, ${searchProgramSchedule(result, now).status}`);
      const epgChannel = appState.epgChannels.get(result.epgChannelKey);
      const logo = createLogo({ ...result.channel, logo: result.programme.icon || result.channel.logo || epgChannel?.icon || "" });
      logo.classList.add("search-result-art");
      const copy = createElement("span", "search-result-copy");
      const schedule = searchProgramSchedule(result, now);
      copy.append(
        createElement("strong", "", result.title),
        createElement("span", "", `${result.channel.name} · Channel ${displayNumber(result.channel)} · ${providerDisplayName(result.channel.provider)}`),
        createElement("span", "", `${schedule.date ? `${schedule.date} · ` : ""}${schedule.current ? `${schedule.time} · ${schedule.status}` : schedule.status}`)
      );
      button.append(logo, copy);
      button.addEventListener("click", () => showProgramDetail(result.channel, result.programme, button));
      programResults.append(button);
    });
  }

  document.getElementById("searchChannelsMore").hidden = appState.searchChannelResults.length <= appState.searchChannelLimit;
  document.getElementById("searchProgramsMore").hidden = appState.searchProgramResults.length <= appState.searchProgramLimit;
  document.getElementById("searchEmptyMessage").hidden =
    !thresholdMet || appState.searchChannelResults.length > 0 || appState.searchProgramResults.length > 0;
}

function focusFirstSearchResult() {
  const result = document.querySelector("#searchChannelResults button, #searchProgramResults button");
  result?.focus();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createLogo(channel) {
  const tile = createElement("div", "channel-logo");
  tile.setAttribute("aria-hidden", "true");
  tile.append(createElement("span", "channel-initials", (channel.name || "TV").split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase()));
  if (channel.logo) {
    try {
      const url = new URL(channel.logo, location.href);
      if (!["https:", "http:"].includes(url.protocol)) return tile;
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = url.href;
      tile.append(image);
    } catch { /* Invalid URLs use the initials tile. */ }
  }
  return tile;
}

function refreshLiveData() {
  const providers = [...new Set(appState.channels.map(channel => channel.provider || "Unknown provider"))].sort();
  const select = document.getElementById("providerFilter");
  select.replaceChildren(new Option("All providers", ""));
  providers.forEach(provider => select.add(new Option(providerDisplayName(provider), provider)));
  if (!providers.includes(appState.selectedProvider)) appState.selectedProvider = "";
  select.value = appState.selectedProvider;
  const groups = [...new Set(appState.channels.flatMap(channelCategories))].sort((a, b) => a.localeCompare(b));
  if (!groups.includes(appState.selectedCategory)) appState.selectedCategory = "";
  const preferred = ["News", "Sports", "Movies", "Kids", "Music", "Documentary"];
  const top = [...preferred.filter(group => groups.includes(group)), ...groups.filter(group => !preferred.includes(group))].slice(0, 6);
  const row = document.getElementById("categoryFilters");
  row.replaceChildren();
  for (const group of top) {
    const button = createElement("button", "live-control", group);
    button.dataset.category = group;
    button.addEventListener("click", () => {
      appState.selectedCategory = appState.selectedCategory === group ? "" : group;
      applyFilters();
    });
    row.append(button);
  }
  const more = document.getElementById("moreCategories");
  more.replaceChildren(new Option("Choose category", ""));
  groups.filter(group => !top.includes(group)).forEach(group => more.add(new Option(group, group)));
  document.getElementById("moreCategoriesLabel").hidden = groups.length <= top.length;
  refreshGuideFilters();
  applyFilters();
}

function applyFilters({ preserveVisibleLimit = false } = {}) {
  const visibleLimit = appState.visibleLimit;
  const query = appState.searchQuery.trim().toLowerCase();
  const source = appState.recentOnly
    ? appState.recentChannels.map(id => appState.channels.find(channel => channelId(channel) === id)).filter(Boolean)
    : appState.sortedChannels.get(appState.settings.channelSort) || appState.channels;
  appState.filteredChannels = source.filter(channel =>
    (!appState.selectedProvider || (channel.provider || "Unknown provider") === appState.selectedProvider) &&
    (!appState.selectedCategory || channelCategories(channel).includes(appState.selectedCategory)) &&
    (!appState.favoritesOnly || appState.favorites.has(channelId(channel))) &&
    (!appState.recentOnly || appState.recentChannels.includes(channelId(channel))) &&
    (!query || [
      channel.name,
      channel.tvgName,
      channel.displayChannelNumber,
      channel.number,
      channel.tvgId,
      channel.group,
      providerDisplayName(channel.provider),
      ...channelCategories(channel)
    ].some(value => String(value ?? "").toLowerCase().includes(query)))
  );
  appState.visibleLimit = preserveVisibleLimit ? visibleLimit : 100;
  document.getElementById("allChannels").setAttribute("aria-pressed", String(!appState.favoritesOnly && !appState.recentOnly && !appState.selectedCategory && !appState.selectedProvider && !appState.searchQuery));
  document.getElementById("favoriteChannels").setAttribute("aria-pressed", String(appState.favoritesOnly));
  document.getElementById("recentChannels").setAttribute("aria-pressed", String(appState.recentOnly));
  document.querySelectorAll("#categoryFilters button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.category === appState.selectedCategory)));
  const more = document.getElementById("moreCategories");
  more.value = [...more.options].some(option => option.value === appState.selectedCategory) ? appState.selectedCategory : "";
  if (appState.view === "live") renderChannels();
}

function renderChannels(append = false) {
  const grid = document.getElementById("channelGrid");
  const start = append ? grid.children.length : 0;
  if (!append) grid.replaceChildren();
  const fragment = document.createDocumentFragment();
  appState.filteredChannels.slice(start, appState.visibleLimit).forEach(channel => {
    const card = createElement("article", "channel-card");
    const select = createElement("button", "channel-select");
    select.setAttribute("aria-label", `Details for ${channel.name}`);
    select.append(createElement("span", "channel-number", String(displayNumber(channel))), createLogo(channel), createElement("strong", "channel-name", channel.name), createElement("span", "channel-meta", providerDisplayName(channel.provider)), createElement("span", "channel-meta", channelCategories(channel).join(" · ")));
    select.addEventListener("click", () => showChannelDetail(channel, select));
    const favorite = createElement("button", "favorite-button");
    updateFavoriteButton(favorite, channel);
    favorite.addEventListener("click", () => toggleFavorite(channel, favorite));
    card.append(select, favorite);
    fragment.append(card);
  });
  grid.append(fragment);
  const shown = grid.children.length;
  document.getElementById("channelCount").textContent = `${shown} shown · ${appState.filteredChannels.length} matching channels`;
  const message = document.getElementById("liveMessage");
  if (appState.playlistStatus === "loading") message.textContent = "Loading channels…";
  else if (appState.playlistError) message.textContent = `Could not load channels. ${appState.playlistError} Check your connection and reload to try again.`;
  else if (!appState.channels.length) message.textContent = "No channels available.";
  else message.textContent = appState.filteredChannels.length ? "" : "No channels match your current filters.";
  if (!appState.channels.length && appState.playlistError) message.textContent += " No channels available.";
  document.getElementById("loadMore").hidden = shown >= appState.filteredChannels.length;
}

function updateFavoriteButton(button, channel) {
  const saved = appState.favorites.has(channelId(channel));
  button.textContent = saved ? "★" : "☆";
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute("aria-label", `${saved ? "Unfavorite" : "Favorite"} ${channel.name}`);
}

function toggleFavorite(channel, button, fromPlayer = false) {
  const id = channelId(channel);
  if (appState.favorites.has(id)) appState.favorites.delete(id);
  else appState.favorites.add(id);
  try {
    localStorage.setItem("iptv-hub-favorites", JSON.stringify([...appState.favorites]));
    document.getElementById("favoritesMessage").textContent = "";
  } catch {
    document.getElementById("favoritesMessage").textContent = "Favorites are available for this session, but could not be saved on this device.";
  }
  if (fromPlayer) {
    renderGuidePreview();
    if (appState.view === "guide" && appState.guideFavoritesOnly) renderFullGuide();
    return; // Reconcile the browser grid when playback closes.
  }
  if (appState.favoritesOnly) {
    const index = [...document.querySelectorAll(".favorite-button")].indexOf(button);
    applyFilters();
    const remaining = document.querySelectorAll(".favorite-button");
    (remaining[Math.min(index, remaining.length - 1)] || document.getElementById("favoriteChannels")).focus();
  } else {
    // Multiple stream variants can share one tvg-id and therefore one favorite.
    document.querySelectorAll(".favorite-button").forEach((item, index) => updateFavoriteButton(item, appState.filteredChannels[index]));
  }
  renderGuidePreview();
  if (appState.view === "guide") renderFullGuide();
}

let detailOpener = null;
function showChannelDetail(channel, opener) {
  detailOpener = opener;
  appState.selectedChannel = channel;
  document.getElementById("detailLogo").replaceChildren(createLogo(channel));
  document.getElementById("detailTitle").textContent = channel.name;
  document.getElementById("detailProvider").textContent = `Channel ${displayNumber(channel)} · ${providerDisplayName(channel.provider)}`;
  document.getElementById("detailCategory").textContent = `Category: ${channelCategories(channel).join(" · ")}`;
  document.getElementById("detailTvgId").textContent = channel.tvgId ? `tvg-id: ${channel.tvgId}` : "";
  // Selection opens details; only Watch Live starts playback.
  document.getElementById("channelDetail").showModal();
  document.getElementById("closeDetail").focus();
}

function showHome() {
  document.getElementById("sportsView").hidden = true;
  appState.view = "home";
  document.getElementById("liveView").hidden = true;
  document.getElementById("guideView").hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("searchView").hidden = true;
  document.getElementById("homeView").hidden = false;
  document.getElementById("homeHeader").hidden = false;
  document.querySelector(".top-actions [data-page='live']").focus();
}

function openLiveTvWithCategory(category = "") {
  const selectedCategory = category === "Live TV" ? "" : category ? normalizeCategory(category) : "";
  appState.selectedCategory = selectedCategory;
  appState.selectedProvider = "";
  appState.favoritesOnly = false;
  appState.recentOnly = false;
  appState.searchQuery = "";
  document.getElementById("liveSearch").value = "";

  refreshLiveData();
  appState.selectedCategory = selectedCategory;
  appState.selectedProvider = "";
  document.getElementById("providerFilter").value = "";
  appState.view = "live";
  document.getElementById("homeView").hidden = true;
  document.getElementById("homeHeader").hidden = true;
  document.getElementById("guideView").hidden = true;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("liveView").hidden = false;
  applyFilters();
  document.getElementById("backHome").focus();
}

function setupLiveTV() {
  const openLive = () => {
    document.getElementById("sportsView").hidden = true;
    appState.view = "live";
    document.getElementById("homeView").hidden = true;
    document.getElementById("homeHeader").hidden = true;
    document.getElementById("guideView").hidden = true;
    document.getElementById("settingsView").hidden = true;
    document.getElementById("searchView").hidden = true;
    document.getElementById("liveView").hidden = false;
    refreshLiveData();
    document.getElementById("backHome").focus();
  };
  document.querySelector(".top-actions [data-page='live']").addEventListener("click", openLive);
  document.getElementById("categoryRow").addEventListener("click", event => {
    const tile = event.target.closest("button[data-category]");
    if (tile) openLiveTvWithCategory(tile.dataset.category);
  });
  document.querySelector(".top-actions [data-page='favorites']").addEventListener("click", () => {
    appState.favoritesOnly = true;
    appState.recentOnly = false;
    openLive();
    document.getElementById("favoriteChannels").setAttribute("aria-pressed", "true");
  });
  document.querySelector(".top-actions [data-page='settings']").addEventListener("click", openSettings);
  document.getElementById("backHome").addEventListener("click", showHome);
  document.getElementById("liveSearch").addEventListener("input", event => { appState.searchQuery = event.target.value; applyFilters(); });
  document.getElementById("providerFilter").addEventListener("change", event => { appState.selectedProvider = event.target.value; applyFilters(); });
  document.getElementById("moreCategories").addEventListener("change", event => { appState.selectedCategory = event.target.value; applyFilters(); });
  document.getElementById("allChannels").addEventListener("click", () => {
    appState.favoritesOnly = false;
    appState.recentOnly = false;
    appState.selectedProvider = "";
    appState.selectedCategory = "";
    appState.searchQuery = "";
    document.getElementById("liveSearch").value = "";
    document.getElementById("providerFilter").value = "";
    applyFilters();
  });
  document.getElementById("favoriteChannels").addEventListener("click", () => {
    appState.favoritesOnly = !appState.favoritesOnly;
    if (appState.favoritesOnly) appState.recentOnly = false;
    applyFilters();
  });
  document.getElementById("recentChannels").addEventListener("click", () => {
    appState.recentOnly = !appState.recentOnly;
    if (appState.recentOnly) appState.favoritesOnly = false;
    applyFilters();
  });
  document.getElementById("loadMore").addEventListener("click", () => {
    const previous = document.getElementById("channelGrid").children.length;
    appState.visibleLimit += 100;
    renderChannels(true);
    document.querySelectorAll(".channel-select")[previous]?.focus();
  });
  const modal = document.getElementById("channelDetail");
  document.getElementById("closeDetail").addEventListener("click", () => modal.close());
  modal.addEventListener("close", () => { if (!appState.playerOpen && detailOpener?.isConnected) detailOpener.focus(); });
}

function setupGlobalSearch() {
  const search = document.getElementById("globalSearch");
  search.addEventListener("input", event => {
    appState.globalSearchQuery = event.target.value;
    updateGlobalSearchResults();
  });
  search.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (appState.view !== "search") updateGlobalSearchResults();
      focusFirstSearchResult();
    } else if (event.key === "ArrowDown" && appState.view === "search") {
      event.preventDefault();
      focusFirstSearchResult();
    }
  });
  document.getElementById("searchChannelsMore").addEventListener("click", () => {
    appState.searchChannelLimit += 20;
    renderSearchResults();
  });
  document.getElementById("searchProgramsMore").addEventListener("click", () => {
    appState.searchProgramLimit += 30;
    renderSearchResults();
  });
}

let settingsReturnView = "home";
function openSettings() {
  document.getElementById("sportsView").hidden = true;
  settingsReturnView = ["live", "guide", "search"].includes(appState.view) ? appState.view : "home";
  appState.view = "settings";
  document.getElementById("homeView").hidden = true;
  document.getElementById("liveView").hidden = true;
  document.getElementById("guideView").hidden = true;
  document.getElementById("searchView").hidden = true;
  document.getElementById("homeHeader").hidden = true;
  document.getElementById("settingsView").hidden = false;
  document.getElementById("settingsShowGuideLess").checked = appState.settings.showGuideLessChannels;
  document.getElementById("settingsStartup").value = appState.settings.startupScreen;
  document.getElementById("settingsGuideStart").value = appState.settings.guideStart;
  document.getElementById("settingsChannelSort").value = appState.settings.channelSort;
  renderInstallStatus();
  renderConnectionStatus();
  document.getElementById("settingsBack").focus();
}

function closeSettings() {
  appState.view = settingsReturnView;
  document.getElementById("settingsView").hidden = true;
  document.getElementById("homeView").hidden = settingsReturnView !== "home";
  document.getElementById("liveView").hidden = settingsReturnView !== "live";
  document.getElementById("guideView").hidden = settingsReturnView !== "guide";
  document.getElementById("searchView").hidden = settingsReturnView !== "search";
  document.getElementById("homeHeader").hidden = !["home", "search"].includes(settingsReturnView);
  if (settingsReturnView === "live") refreshLiveData();
  else if (settingsReturnView === "guide") renderFullGuide();
  (settingsReturnView === "search" ? document.getElementById("globalSearch")
    : document.querySelector(`.top-actions [data-page="${settingsReturnView === "guide" ? "guide" : settingsReturnView === "live" ? "live" : "settings"}"]`)
      || document.getElementById("settingsBack")).focus();
}

function applyStartupScreen() {
  if (appState.settings.startupScreen === "live") {
    document.querySelector(".top-actions [data-page='live']").click();
  } else if (appState.settings.startupScreen === "guide") {
    openGuide(document.querySelector(".top-actions [data-page='guide']"));
  }
}


let playerReturnFocus = null;
let playerReturnScroll = 0;
let playerReturnView = "home";
let playerReturnGuideChannel = "";
let playerReturnGuideProgram = "";
let playerOverlayTimer = null;
function startPlayerChannel(channel) {
  if (!navigator.onLine) return;
  appState.selectedChannel = channel;
  document.getElementById("playerLogo").replaceChildren(createLogo(channel));
  document.getElementById("playerTitle").textContent = channel.name;
  document.getElementById("playerChannelNumber").textContent = `Channel ${displayNumber(channel)}`;
  document.getElementById("playerProvider").textContent = providerDisplayName(channel.provider);
  document.getElementById("playerCategory").textContent = channelCategories(channel).join(" · ");
  updateFavoriteButton(document.getElementById("playerFavorite"), channel);
  showPlayerInfoOverlay(channel);
  const index = appState.filteredChannels.indexOf(channel);
  document.getElementById("previousChannel").disabled = !appState.online || index <= 0;
  document.getElementById("nextChannel").disabled = !appState.online || index < 0 || index >= appState.filteredChannels.length - 1;
  IPTVPlayer.play(channel, document.getElementById("liveVideo"), {
    onStatus(status, message) {
      appState.playbackStatus = status;
      appState.playbackError = status === "error" ? message : null;
      document.getElementById("playbackMessage").textContent = message;
      if (status === "playing") updateRecentChannels(channel);
    }
  });
}

function showPlayerInfoOverlay(channel) {
  const overlay = document.getElementById("playerInfoOverlay");
  const guide = channel.epgChannelKey && appState.epgChannels.get(channel.epgChannelKey);
  const current = window.IPTVGuide.currentProgram(guide);
  const next = window.IPTVGuide.nextProgram(guide);
  document.getElementById("playerOverlayLogo").replaceChildren(createLogo(channel));
  document.getElementById("playerOverlayChannel").textContent = `${displayNumber(channel)} · ${channel.name}`;
  document.getElementById("playerOverlayCurrent").textContent = current ? `Now: ${current.title}` : "No current program";
  document.getElementById("playerOverlayNext").textContent = next ? `Next: ${next.title}` : "Next: No program listed";
  overlay.hidden = false;
  clearTimeout(playerOverlayTimer);
  playerOverlayTimer = setTimeout(() => { overlay.hidden = true; }, 5000);
}

function openPlayer() {
  if (!appState.selectedChannel) return;
  if (!navigator.onLine) {
    renderConnectionStatus();
    return;
  }
  playerReturnView = appState.view;
  playerReturnFocus = guidePlayerOpener ||
    (playerReturnView === "guide" ? guideProgramOpener : playerReturnView === "home" ? document.activeElement : detailOpener);
  playerReturnGuideChannel = playerReturnFocus?.dataset.guideChannelKey || channelId(appState.selectedChannel);
  playerReturnGuideProgram = playerReturnFocus?.dataset.programStart || "";
  playerReturnScroll = window.scrollY;
  appState.playerOpen = true;
  if (document.getElementById("channelDetail").open) document.getElementById("channelDetail").close();
  if (document.getElementById("programDetail").open) document.getElementById("programDetail").close();
  document.getElementById("playerView").showModal();
  document.body.classList.add("player-open");
  document.getElementById("playerFavoritesMessage").textContent = "";
  startPlayerChannel(appState.selectedChannel);
  document.getElementById("closePlayer").focus();
}

function finishPlayerClose() {
  if (!appState.playerOpen) return;
  IPTVPlayer.stop();
  appState.playerOpen = false;
  appState.playbackStatus = "idle";
  appState.playbackError = null;
  document.body.classList.remove("player-open");
  if (document.fullscreenElement === document.getElementById("playerView")) {
    document.exitFullscreen?.().catch(error => console.warn("[IPTV Hub Player] Exit fullscreen failed", error));
  }
  if (playerReturnView === "sports") {
    guidePlayerOpener = null;
    (playerReturnFocus?.isConnected ? playerReturnFocus : document.getElementById("sportsBack")).focus({ preventScroll: true });
    return;
  }
  if (playerReturnView === "guide") {
    renderFullGuide();
    renderGuidePreview();
    const target = playerReturnFocus?.isConnected ? playerReturnFocus
      : [...document.querySelectorAll("#guideView [data-guide-channel-key]")].find(element =>
        element.dataset.guideChannelKey === playerReturnGuideChannel &&
        (!playerReturnGuideProgram || element.dataset.programStart === playerReturnGuideProgram)
      ) || document.getElementById("guideBack");
    target.focus({ preventScroll: true });
    guidePlayerOpener = null;
    return;
  }
  if (playerReturnView === "home") {
    renderGuidePreview();
    const target = playerReturnFocus?.isConnected ? playerReturnFocus
      : [...document.querySelectorAll("#continueRow [data-continue-channel-id]")]
        .find(element => element.dataset.continueChannelId === playerReturnGuideChannel)
      || [...document.querySelectorAll("#guidePreview [data-guide-channel-key]")].find(element =>
        element.dataset.guideChannelKey === playerReturnGuideChannel &&
        (!playerReturnGuideProgram || element.dataset.programStart === playerReturnGuideProgram)
      )
      || document.querySelector(".top-actions [data-page='guide']");
    target.focus({ preventScroll: true });
    guidePlayerOpener = null;
    return;
  }
  if (playerReturnView === "search") {
    const target = playerReturnFocus?.isConnected ? playerReturnFocus : document.getElementById("globalSearch");
    target.focus({ preventScroll: true });
    guidePlayerOpener = null;
    return;
  }
  // Reconcile favorite changes without resetting the loaded batch or scroll position.
  const original = appState.filteredChannels.indexOf(appState.selectedChannel);
  const openerIndex = playerReturnFocus?.isConnected ? [...document.querySelectorAll(".channel-select")].indexOf(playerReturnFocus) : original;
  if (appState.favoritesOnly) {
    appState.filteredChannels = appState.filteredChannels.filter(channel => appState.favorites.has(channelId(channel)));
    renderChannels();
  } else {
    document.querySelectorAll(".favorite-button").forEach((button, index) => updateFavoriteButton(button, appState.filteredChannels[index]));
  }
  const target = playerReturnFocus?.isConnected ? playerReturnFocus : document.querySelectorAll(".channel-select")[Math.max(0, Math.min(openerIndex, document.querySelectorAll(".channel-select").length - 1))];
  (target || document.getElementById("favoriteChannels")).focus({ preventScroll: true });
  window.scrollTo(0, playerReturnScroll);
}

function closePlayer() {
  // Stop immediately; the dialog close event also handles native/programmatic closure.
  IPTVPlayer.stop();
  document.getElementById("playerView").close();
  finishPlayerClose();
}

function setupPlayer() {
  const modal = document.getElementById("playerView");
  const video = document.getElementById("liveVideo");
  document.getElementById("watchLive").addEventListener("click", openPlayer);
  document.getElementById("closePlayer").addEventListener("click", closePlayer);
  modal.addEventListener("cancel", event => { event.preventDefault(); closePlayer(); });
  modal.addEventListener("close", finishPlayerClose);
  for (const [id, delta] of [["previousChannel", -1], ["nextChannel", 1]]) {
    document.getElementById(id).addEventListener("click", () => {
      const index = appState.filteredChannels.indexOf(appState.selectedChannel);
      const channel = appState.filteredChannels[index + delta];
      if (index >= 0 && channel) startPlayerChannel(channel);
      // Keep focus on a usable control at the end of the filtered list.
      if (document.activeElement.disabled) document.getElementById("closePlayer").focus();
    });
  }
  document.addEventListener("keydown", event => {
    if (!appState.playerOpen || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    if (event.target.matches("input, textarea, select, [contenteditable='true'], video")) return;
    event.preventDefault();
    const index = appState.filteredChannels.indexOf(appState.selectedChannel);
    const delta = event.key === "ArrowUp" ? -1 : 1;
    const channel = appState.filteredChannels[index + delta];
    if (index >= 0 && channel) startPlayerChannel(channel);
  });
  document.getElementById("playerFavorite").addEventListener("click", event => {
    toggleFavorite(appState.selectedChannel, event.currentTarget, true);
    updateFavoriteButton(event.currentTarget, appState.selectedChannel);
    document.getElementById("playerFavoritesMessage").textContent = document.getElementById("favoritesMessage").textContent;
  });
  document.getElementById("playerFullscreen").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === modal) await document.exitFullscreen();
      else if (modal.requestFullscreen) await modal.requestFullscreen();
    } catch (error) { console.warn("[IPTV Hub Player] Fullscreen unavailable; keeping full-window view", error); }
  });
  modal.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); closePlayer(); return; }
    // Native video controls own their arrow keys and Space behavior.
    if (event.target === video || event.composedPath().includes(video)) return;
    if (event.key === " " && event.target === modal) {
      event.preventDefault();
      if (video.paused) video.play().catch(error => console.warn("[IPTV Hub Player] Manual play failed", error));
      else video.pause();
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const controls = [...modal.querySelectorAll("button")].filter(button => !button.disabled);
      const index = controls.indexOf(document.activeElement);
      if (index >= 0) { event.preventDefault(); controls[Math.max(0, Math.min(index + (event.key === "ArrowRight" ? 1 : -1), controls.length - 1))].focus(); }
    }
  });
  window.addEventListener("pagehide", () => { if (appState.playerOpen) closePlayer(); else IPTVPlayer.stop(); });
}
