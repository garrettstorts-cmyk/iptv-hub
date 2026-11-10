window.XMLTVLoader = (() => {
  class XMLTVSourceError extends Error {
    constructor(kind, message, cause) {
      super(message, { cause });
      this.name = "XMLTVSourceError";
      this.kind = kind;
    }
  }

  function isGzip(bytes) {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  async function decodeXmltvResponse(response, sourceUrl = "") {
    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new XMLTVSourceError("network", "Unable to read XMLTV response.", error);
    }

    const url = sourceUrl || response.url || "";
    const contentEncoding = response.headers.get("content-encoding") || "";
    const gzipHint = /\.gz(?:$|[?#])/i.test(url) || /(?:^|,)\s*gzip(?:\s|,|$)/i.test(contentEncoding);

    if (isGzip(bytes)) {
      console.info("[IPTV Hub EPG] Gzip XMLTV response detected:", url);
      if (typeof DecompressionStream !== "function") {
        throw new XMLTVSourceError("unsupported-decompression", "This browser cannot decompress gzip guide data.");
      }

      try {
        const compressedStream = new Blob([bytes]).stream();
        const decompressedStream = compressedStream.pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
      } catch (error) {
        throw new XMLTVSourceError("gzip-decompression", "Unable to decompress gzip guide data.", error);
      }
    } else if (gzipHint) {
      console.info("[IPTV Hub EPG] Gzip source was already transparently decompressed by the browser:", url);
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new XMLTVSourceError("utf8-decoding", "Unable to decode XMLTV as UTF-8.", error);
    }
  }

  async function fetchXmltvSource(source, options = {}) {
    let response;
    try {
      response = await fetch(source.url, { signal: options.signal });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new XMLTVSourceError("network", `XMLTV fetch failed: ${error.message || "network error"}`, error);
    }

    if (!response.ok) {
      throw new XMLTVSourceError("network", `XMLTV request failed: HTTP ${response.status}`);
    }

    return decodeXmltvResponse(response, source.url);
  }

  return { fetchXmltvSource, decodeXmltvResponse };
})();
