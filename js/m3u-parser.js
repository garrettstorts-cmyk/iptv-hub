window.M3UParser = {
  parse(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const channels = [];
    let pending = null;

    for (const line of lines) {
      if (line.startsWith("#EXTINF")) {
        const attrs = {};
        for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) {
          attrs[match[1]] = match[2];
        }

        const comma = line.indexOf(",");
        const name = comma >= 0 ? line.slice(comma + 1).trim() : "Unnamed";

        pending = {
          name,
          tvgId: attrs["tvg-id"] || "",
          tvgName: attrs["tvg-name"] || "",
          logo: attrs["tvg-logo"] || "",
          number: attrs["tvg-chno"] || attrs["channel-number"] || "",
          group: attrs["group-title"] || "Other",
          url: ""
        };
      } else if (pending && !line.startsWith("#")) {
        pending.url = line;
        channels.push(pending);
        pending = null;
      }
    }

    return channels;
  }
};
