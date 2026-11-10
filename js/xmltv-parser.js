window.XMLTVParser = {
  parseTimestamp(value) {
    const match = String(value || "").trim().match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/
    );
    if (!match) return NaN;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", zone = ""] = match;
    const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;

    if (!zone) {
      const local = new Date(year, month - 1, day, hour, minute, second);
      if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day ||
        local.getHours() !== hour || local.getMinutes() !== minute || local.getSeconds() !== second) return NaN;
      return local.getTime();
    }

    const utc = Date.UTC(year, month - 1, day, hour, minute, second);
    const utcDate = new Date(utc);
    if (utcDate.getUTCFullYear() !== year || utcDate.getUTCMonth() !== month - 1 || utcDate.getUTCDate() !== day) return NaN;
    if (zone === "Z") return utc;
    const offsetMatch = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!offsetMatch) return NaN;
    const offsetHours = Number(offsetMatch[2]);
    const offsetMinutes = Number(offsetMatch[3]);
    if (offsetHours > 23 || offsetMinutes > 59) return NaN;
    const offset = (offsetHours * 60 + offsetMinutes) * (offsetMatch[1] === "+" ? 1 : -1);
    return utc - offset * 60000;
  },

  parse(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror") || doc.documentElement?.localName === "parsererror") {
      throw new Error("Invalid XMLTV document.");
    }

    const channels = new Map();
    for (const node of doc.querySelectorAll("channel")) {
      const id = node.getAttribute("id") || "";
      if (!id.trim()) continue;
      const displayNames = [...node.querySelectorAll("display-name")]
        .map(displayNode => displayNode.textContent?.trim() || "")
        .filter(Boolean);
      channels.set(id, {
        id,
        displayName: displayNames[0] || id,
        displayNames,
        icon: node.querySelector("icon")?.getAttribute("src") || "",
        programmes: []
      });
    }

    for (const node of doc.querySelectorAll("programme")) {
      const channelId = node.getAttribute("channel") || "";
      const channel = channels.get(channelId);
      if (!channel) continue;
      const start = this.parseTimestamp(node.getAttribute("start"));
      const stop = this.parseTimestamp(node.getAttribute("stop"));
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
      channel.programmes.push({
        start,
        stop,
        title: node.querySelector("title")?.textContent?.trim() || "Untitled",
        icon: node.querySelector("icon")?.getAttribute("src") || "",
        desc: node.querySelector("desc")?.textContent?.trim() || ""
      });
    }

    for (const channel of channels.values()) channel.programmes.sort((a, b) => a.start - b.start);
    return channels;
  }
};
