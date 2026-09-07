import { describe, expect, it } from "vitest";

import { MUSIC_PROVIDERS, RADIO_STATIONS, RADIO_STATION_DETAILS, formatPlaybackTime, providerById } from "./listen-data";

describe("Signal Deck Listen data", () => {
  it("keeps the three future music source adapters distinct", () => {
    expect(MUSIC_PROVIDERS.map((provider) => provider.id)).toEqual(["apple", "spotify", "local"]);
    expect(providerById("local").libraryLabel).toBe("Device Library");
  });

  it("uses the exact eleven station names carried by MTDO Terminal", () => {
    expect(RADIO_STATIONS).toEqual([
      "Lofi Hip Hop Radio",
      "EDM Pulse",
      "Synthwave Nights",
      "House Grooves",
      "Dubstep Underground",
      "Drum & Bass",
      "Darksynth",
      "Chillsynth",
      "Vaporwave",
      "Indie Pop",
      "Hacker Radio",
    ]);
  });

  it("keeps Radio's browser sources aligned with the Terminal stream contract", () => {
    expect(RADIO_STATION_DETAILS[0]?.url).toBe("https://ice1.somafm.com/groovesalad-128-mp3");
    expect(RADIO_STATION_DETAILS[2]?.url).toBe("https://stream.nightride.fm/nightride.mp3");
    expect(RADIO_STATION_DETAILS[10]?.url).toBe("https://ice1.somafm.com/defcon-128-mp3");
  });

  it("formats mock player timing without needing an audio transport", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(226)).toBe("3:46");
  });
});
