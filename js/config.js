window.IPTV_CONFIG = {
  appName: "IPTV Hub",

  // Add only public/free or otherwise authorized sources.
  playlists: [
    {
      name: "United States",
      url: "https://iptv-org.github.io/iptv/countries/us.m3u",
      provider: "iptv-org",
      enabled: true,
      epg: []
    },
    {
      name: "Pluto TV",
      url: "https://raw.githubusercontent.com/BuddyChewChew/pluto/main/pluto_us.m3u",
      provider: "Pluto TV",
      enabled: true,
      epg: [
        {
          name: "Pluto TV EPG",
          url: "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/refs/heads/master/PlutoTV/all.xml"
        }
      ]
    },
    {
      name: "Samsung TV Plus",
      url: "https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/samsungtvplus_us.m3u",
      provider: "Samsung TV Plus",
      enabled: true,
      epg: [
        {
          name: "Samsung TV Plus EPG",
          url: "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/refs/heads/master/SamsungTVPlus/us.xml"
        }
      ]
    },
    {
      name: "Plex TV",
      url: "https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/plex_us.m3u",
      provider: "Plex TV",
      enabled: true,
      epg: [
        {
          name: "Plex TV EPG",
          url: "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/refs/heads/master/Plex/us.xml"
        }
      ]
    },
    {
      name: "Roku TV",
      url: "https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/roku_all.m3u",
      provider: "Roku TV",
      enabled: true,
      epg: [
        {
          name: "Roku TV EPG",
          url: "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/refs/heads/master/Roku/all.xml"
        }
      ]
    },
    {
      name: "Xumo TV",
      url: "https://raw.githubusercontent.com/BuddyChewChew/xumo-playlist-generator/refs/heads/main/playlists/xumo_playlist.m3u",
      provider: "Xumo TV",
      enabled: true,
      epg: [
        {
          name: "Xumo TV EPG",
          url: "https://raw.githubusercontent.com/BuddyChewChew/xumo-playlist-generator/main/playlists/xumo_epg.xml.gz"
        }
      ]
    }
  ],

  epgSources: [
    // Optional global sources apply to channels from every enabled playlist.
    // { name: "Global EPG", url: "https://example.com/guide.xml" }
  ]
};
