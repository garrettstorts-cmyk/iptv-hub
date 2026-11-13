// Sports discovery uses the same provider-matched EPG and player as the guide.
const SPORTS_RULES = [
  ["Football", /\b(nfl|ncaa football|college football|football|super bowl)\b/i],
  ["Basketball", /\b(nba|wnba|basketball|march madness)\b/i],
  ["Baseball", /\b(mlb|baseball|world series)\b/i],
  ["Hockey", /\b(nhl|hockey|stanley cup)\b/i],
  ["Soccer", /\b(soccer|premier league|uefa|fifa|mls|bundesliga|la liga)\b/i],
  ["Golf", /\b(golf|pga|lpga|ryder cup)\b/i],
  ["Racing", /\b(nascar|indycar|formula (one|1)|motogp|motorsport|auto racing)\b/i],
  ["Combat Sports", /\b(boxing|mma|ufc|wrestling|kickboxing)\b/i],
  ["Tennis", /\b(tennis|wimbledon|atp|wta)\b/i]
];
const sportsState = { mode: "now", sport: "", provider: "", query: "", limit: 60 };
function sportsType(text) {
  return SPORTS_RULES.find(([, pattern]) => pattern.test(text))?.[0] || "";
}
function isSportsChannel(channel) {
  return channelCategories(channel).includes("Sports") ||
    /\b(sports?|espn|nfl|nba|mlb|nhl|golf|tennis|fubo|stadium|bein)\b/i.test(channel.name || "");
}
function sportsWindow(mode, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (mode === "tomorrow") start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [mode === "now" ? now : start.getTime(), mode === "now" ? now + 1 : end.getTime()];
}
function sportsEntries(channels, epgChannels, state, now = Date.now()) {
  const [start, end] = sportsWindow(state.mode, now);
  const entries = [];
  for (const channel of channels) {
    if (state.provider && channel.provider !== state.provider) continue;
    const channelSports = isSportsChannel(channel);
    const epg = epgChannels.get(channel.epgChannelKey);
    if (state.mode === "channels") {
      const sport = sportsType(channel.name);
      if (channelSports && (!state.sport || sport === state.sport) &&
          (!state.query || channel.name.toLowerCase().includes(state.query.toLowerCase()))) {
        entries.push({ channel, sport, programme: window.IPTVGuide.currentProgram(epg, now) });
      }
      continue;
    }
    for (const programme of window.IPTVGuide.programsInWindow(epg, start, end)) {
      const sport = sportsType(programme.title);
      if (!channelSports && !sport && !/\bsports?\b/i.test(programme.title)) continue;
      const classified = sport || sportsType(channel.name) || "Other Sports";
      if (state.sport && state.sport !== classified) continue;
      const text = `${programme.title} ${programme.desc || ""} ${channel.name}`.toLowerCase();
      if (state.query && !text.includes(state.query.toLowerCase())) continue;
      entries.push({ channel, programme, sport: classified });
    }
  }
  return entries.sort((a, b) => state.mode === "channels"
    ? a.channel.name.localeCompare(b.channel.name)
    : a.programme.start - b.programme.start || a.channel.name.localeCompare(b.channel.name));
}
function openSports() {
  for (const id of ["homeView", "liveView", "guideView", "settingsView", "homeHeader"]) document.getElementById(id).hidden = true;
  appState.view = "sports";
  document.getElementById("sportsView").hidden = false;
  const provider = document.getElementById("sportsProvider");
  provider.replaceChildren(new Option("All providers", ""));
  [...new Set(appState.channels.map(channel => channel.provider))].sort().forEach(value => provider.add(new Option(providerDisplayName(value), value)));
  provider.value = sportsState.provider;
  renderSports();
  focusSpatialElement(document.getElementById("sportsBack"));
}
function closeSports() {
  showHome();
  focusSpatialElement(document.querySelector('[data-page="sports"]'));
}
function renderSports() {
  const now = Date.now();
  const entries = sportsEntries(appState.channels, appState.epgChannels, sportsState, now);
  const grid = document.getElementById("sportsGrid");
  const active = document.activeElement;
  const activeKey = active?.closest("[data-sports-key]")?.dataset.sportsKey;
  const activeAction = active?.dataset.sportsAction;
  const cards = entries.slice(0, sportsState.limit).map(({ channel, programme, sport }) => {
    const card = createElement("article", "sports-card");
    card.dataset.sportsKey = `${channelId(channel)}:${programme?.start || "channel"}`;
    const airing = programme && programme.start <= now && programme.stop > now;
    card.append(createElement("span", "sports-badge", sportsState.mode === "channels" ? "CHANNEL" : airing ? "ON NOW" : "SCHEDULED"));
    card.append(createElement("h2", "", sportsState.mode === "channels" ? channel.name : programme.title));
    card.append(createElement("p", "", `${sport || "Sports"} · ${channel.name} · ${providerDisplayName(channel.provider)}`));
    if (programme) card.append(createElement("p", "", `${new Date(programme.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${formatGuideTime(programme.start)} – ${formatGuideTime(programme.stop)}`));
    else card.append(createElement("p", "", "Schedule unavailable — browse this channel live."));
    const actions = createElement("div", "filter-row");
    const watch = createElement("button", "live-control", "Watch Channel");
    watch.dataset.sportsAction = "watch";
    watch.addEventListener("click", () => playChannelFromGuide(channel, watch));
    actions.append(watch);
    if (programme) {
      const details = createElement("button", "live-control", "Program Details");
      details.dataset.sportsAction = "details";
      details.addEventListener("click", () => showProgramDetail(channel, programme, details));
      actions.append(details);
    }
    card.append(actions);
    if (programme && !airing) card.append(createElement("small", "", "Watch Channel opens the current broadcast; it does not play this scheduled program."));
    return card;
  });
  grid.replaceChildren(...cards);
  if (activeKey) {
    const replacement = cards.find(card => card.dataset.sportsKey === activeKey)?.querySelector(`[data-sports-action="${activeAction}"]`);
    focusSpatialElement(replacement || document.getElementById("sportsBack"));
  }
  document.getElementById("sportsMore").hidden = entries.length <= sportsState.limit;
  let status = `${entries.length} ${sportsState.mode === "channels" ? "channels" : "programs"} · Showing ${cards.length}. Based on provider guide listings; scores and live-event verification are unavailable.`;
  if (!entries.length) status = appState.playlistStatus === "loading" ? "Loading channels…" :
    !appState.epgLoaded && sportsState.mode !== "channels" ? "Loading sports guide data…" :
    "No matching listings. Try another day, clear your filters, or browse Sports Channels.";
  if (appState.epgError && sportsState.mode !== "channels") status += ` ${appState.epgError}`;
  document.getElementById("sportsStatus").textContent = status;
}
function setupSports() {
  document.querySelector('[data-page="sports"]').addEventListener("click", openSports);
  document.querySelector('[data-category="Sports"]').addEventListener("click", openSports);
  document.getElementById("sportsBack").addEventListener("click", closeSports);
  const select = document.getElementById("sportsSport");
  [...SPORTS_RULES.map(([name]) => name), "Other Sports"].forEach(name => select.add(new Option(name, name)));
  for (const [id, field, event] of [["sportsSport", "sport", "change"], ["sportsProvider", "provider", "change"], ["sportsSearch", "query", "input"]]) {
    document.getElementById(id).addEventListener(event, e => { sportsState[field] = e.target.value.trim(); sportsState.limit = 60; renderSports(); });
  }
  document.querySelectorAll("[data-sports-mode]").forEach(button => button.addEventListener("click", () => {
    sportsState.mode = button.dataset.sportsMode;
    sportsState.limit = 60;
    document.querySelectorAll("[data-sports-mode]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    renderSports();
  }));
  document.getElementById("sportsMore").addEventListener("click", () => {
    const previous = document.querySelectorAll(".sports-card").length;
    sportsState.limit += 60;
    renderSports();
    focusSpatialElement(document.querySelectorAll(".sports-card")[previous]?.querySelector("button"));
  });
}
