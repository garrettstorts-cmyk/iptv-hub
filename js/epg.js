window.IPTVGuide = (() => {
  const normalize = value => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

  function buildIndexes(channels) {
    const indexes = {
      ids: new Map(),
      normalizedIds: new Map(),
      names: new Map(),
      normalizedNames: new Map()
    };
    const add = (index, key, channel) => {
      if (!key) return;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(channel);
    };

    for (const channel of channels.values()) {
      add(indexes.ids, channel.id, channel);
      add(indexes.normalizedIds, normalize(channel.id), channel);
      for (const name of channel.displayNames) {
        add(indexes.names, name, channel);
        add(indexes.normalizedNames, normalize(name), channel);
      }
    }
    return indexes;
  }

  function findMatch(channel, indexes) {
    const provider = channel.provider || "";
    const allowed = candidate => candidate.global || candidate.providers.has(provider);
    const firstAllowed = list => list?.find(allowed) || null;
    const id = (channel.tvgId || "").trim();

    if (id) {
      const exact = firstAllowed(indexes.ids.get(id));
      if (exact) return { channel: exact, status: "exact" };
      const normalized = firstAllowed(indexes.normalizedIds.get(normalize(id)));
      if (normalized) return { channel: normalized, status: "exact" };
    }

    const tvgName = (channel.tvgName || "").trim();
    if (tvgName) {
      const exactName = firstAllowed(indexes.names.get(tvgName));
      if (exactName) return { channel: exactName, status: "name-match" };
    }

    const channelName = normalize(channel.name);
    const nameMatch = channelName && firstAllowed(indexes.normalizedNames.get(channelName));
    return nameMatch ? { channel: nameMatch, status: "name-match" } : null;
  }

  function buildProgrammeIndex(channel) {
    channel.programmes.sort((a, b) => a.start - b.start);
    let maximumStop = -Infinity;
    channel.prefixMaximumStop = channel.programmes.map(programme => {
      maximumStop = Math.max(maximumStop, programme.stop);
      return maximumStop;
    });
  }

  function firstEndingAfter(channel, timestamp) {
    let low = 0;
    let high = channel.prefixMaximumStop.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (channel.prefixMaximumStop[middle] <= timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function currentProgram(channel, timestamp = Date.now()) {
    if (!channel) return null;
    for (let cursor = firstEndingAfter(channel, timestamp); cursor < channel.programmes.length; cursor++) {
      const programme = channel.programmes[cursor];
      if (programme.start > timestamp) break;
      if (programme.start <= timestamp && programme.stop > timestamp) return programme;
    }
    return null;
  }

  function nextProgram(channel, timestamp = Date.now()) {
    if (!channel) return null;
    for (let cursor = firstEndingAfter(channel, timestamp); cursor < channel.programmes.length; cursor++) {
      if (channel.programmes[cursor].start > timestamp) return channel.programmes[cursor];
    }
    return null;
  }

  function programsInWindow(channel, start, end) {
    if (!channel || end <= start) return [];
    const programmes = [];
    for (let cursor = firstEndingAfter(channel, start); cursor < channel.programmes.length; cursor++) {
      const programme = channel.programmes[cursor];
      if (programme.start >= end) break;
      if (programme.stop > start) programmes.push(programme);
    }
    return programmes;
  }

  function nowPlayingStatus(channel, timestamp = Date.now()) {
    const current = currentProgram(channel, timestamp);
    return current ? { playing: true, program: current } : { playing: false, program: null };
  }

  return { normalize, buildIndexes, findMatch, buildProgrammeIndex, currentProgram, nextProgram, programsInWindow, nowPlayingStatus };
})();
