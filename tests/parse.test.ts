import { describe, expect, it } from "vitest";
import {
  bestImage,
  bestVideo,
  collectMedia,
  detectDenial,
  extractMobileItem,
  findHighlights,
  findProfile,
  findReels,
  findUser,
  paginationHasMore,
  parseJsonScripts,
  parseCompactNumber,
  parseDescriptionCounts,
  parseEmbedHtml,
  parseHighlightsTray,
  parseReels,
  profileFromSnapshot,
  recordPublicationCodes,
  retainGridMedia,
  sanitizeUsername,
  snapshotIndicatesEmpty,
  snapshotIndicatesLoginWall,
  timelineFromProfileInfo,
  userTimelineHasMore,
} from "../src/main/ig/parse";
import type { ExtractedMedia } from "../src/main/ig/types";

describe("selección del mejor candidato", () => {
  it("prefiere la imagen más grande y, en empate, la de más bytes", () => {
    const best = bestImage([
      { url: "small", width: 320, height: 320, file_size: 9999 },
      { url: "large-a", width: 1440, height: 1800, file_size: 1000 },
      { url: "large-b", width: 1440, height: 1800, file_size: 2000 },
    ]);
    expect(best?.url).toBe("large-b");
  });

  it("en video gana resolución, luego bitrate y luego tamaño", () => {
    const best = bestVideo([
      { url: "low", width: 1080, height: 1920, bit_rate: 1200, file_size: 5000 },
      { url: "high-small", width: 1080, height: 1920, bit_rate: 4800, file_size: 4000 },
      { url: "high-large", width: 1080, height: 1920, bit_rate: 4800, file_size: 8000 },
      { url: "tiny", width: 480, height: 854, bit_rate: 9000, file_size: 9000 },
    ]);
    expect(best?.url).toBe("high-large");
  });
});

describe("forma móvil (API v1)", () => {
  it("extrae cada pieza de un carrusel con su índice", () => {
    const item = {
      pk: "3100",
      code: "ABC",
      media_type: 8,
      taken_at: 1700000000,
      caption: { text: "hola" },
      user: { username: "demo" },
      carousel_media: [
        { media_type: 1, image_versions2: { candidates: [{ url: "a1", width: 1080, height: 1350 }, { url: "a0", width: 320, height: 400 }] } },
        {
          media_type: 2,
          image_versions2: { candidates: [{ url: "cover", width: 640, height: 800 }] },
          video_versions: [{ url: "v1", width: 720, height: 900 }, { url: "v2", width: 1080, height: 1350 }],
          video_duration: 7.5,
        },
      ],
    };
    const out = extractMobileItem(item, { kind: "post" });
    expect(out.map((m) => [m.mediaId, m.childIndex, m.mediaType, m.bestUrl])).toEqual([
      ["3100_0", 0, 1, "a1"],
      ["3100_1", 1, 2, "v2"],
    ]);
    expect(out.every((m) => m.childCount === 2 && m.publicationCode === "ABC" && m.qualityVerified)).toBe(true);
    expect(out[1].duration).toBe(7.5);
    expect(out[1].thumbnailUrl).toBe("cover");
  });

  it("antepone prefijos a stories y highlights", () => {
    const story = extractMobileItem({ id: "55_9", media_type: 1, image_versions2: { candidates: [{ url: "s", width: 1080, height: 1920 }] } }, { kind: "story" });
    expect(story[0].mediaId).toBe("st_55");
    const reels = parseReels(
      { reels: { "highlight:17": { id: "highlight:17", items: [{ pk: "1", media_type: 1, image_versions2: { candidates: [{ url: "h", width: 1, height: 1 }] } }] } } },
      "highlight",
    );
    expect(reels[0].mediaId).toBe("hl_1");
    expect(reels[0].highlightId).toBe("17");
  });
});

describe("forma GraphQL web", () => {
  it("lee los 12 primeros posts de web_profile_info", () => {
    const payload = {
      data: {
        user: {
          username: "demo",
          edge_owner_to_timeline_media: {
            count: 30,
            page_info: { has_next_page: true, end_cursor: "next" },
            edges: [
              {
                node: {
                  id: "1",
                  shortcode: "P1",
                  display_url: "d1",
                  display_resources: [
                    { src: "r640", config_width: 640, config_height: 800 },
                    { src: "r1080", config_width: 1080, config_height: 1350 },
                  ],
                  dimensions: { width: 1080, height: 1350 },
                  edge_media_to_caption: { edges: [{ node: { text: "pie" } }] },
                  taken_at_timestamp: 1,
                },
              },
              { node: { id: "2", shortcode: "P2", is_video: true, display_url: "cover2", dimensions: { width: 720, height: 1280 } } },
            ],
          },
        },
      },
    };
    const timeline = timelineFromProfileInfo(payload);
    expect(timeline.codes).toEqual(["P1", "P2"]);
    expect(timeline.hasNext).toBe(true);
    expect(timeline.endCursor).toBe("next");
    expect(timeline.media[0].bestUrl).toBe("r1080");
    expect(timeline.media[0].caption).toBe("pie");
    // Video sin URL: se resolverá al descargar.
    expect(timeline.media[1]).toMatchObject({ mediaType: 2, bestUrl: "" });
  });

  it("ignora medios de otras cuentas (anuncios, sugerencias)", () => {
    const payload = {
      items: [
        { pk: "1", code: "MINE", media_type: 1, user: { username: "demo" }, image_versions2: { candidates: [{ url: "m", width: 1, height: 1 }] } },
        { pk: "2", code: "AD", media_type: 1, user: { username: "brand" }, image_versions2: { candidates: [{ url: "x", width: 1, height: 1 }] } },
      ],
    };
    expect(collectMedia(payload, { kind: "post", username: "demo" }).map((m) => m.publicationCode)).toEqual(["MINE"]);
  });

  it("marca como no verificada la cuadrícula DOM", () => {
    const out = collectMedia([{ id: "web_X", __instavault_dom: true, shortcode: "X", display_url: "dom" }], { kind: "post" });
    expect(out[0]).toMatchObject({ qualityVerified: false, source: "dom_fallback" });
  });
});

describe("paginación y cuadrícula", () => {
  it("sólo considera el final con una señal explícita", () => {
    expect(paginationHasMore([{ data: { edge: { edges: [], page_info: { has_next_page: true } } } }])).toBe(true);
    expect(paginationHasMore([{ page_info: { has_next_page: false } }])).toBe(false);
    expect(paginationHasMore([{ items: [], more_available: false }])).toBe(false);
    expect(paginationHasMore([{ items: [] }])).toBeNull();
  });

  it("la cuadrícula del perfil es la frontera de confianza", () => {
    const item = (code: string) => ({ publicationCode: code }) as ExtractedMedia;
    expect(retainGridMedia([item("MIA"), item("OTRA"), item("AD")], ["MIA"]).map((m) => m.publicationCode)).toEqual(["MIA"]);
  });

  it("reanuda tras el checkpoint y respeta el lote", () => {
    const state = { checkpoint: "B", reached: false, seen: new Set<string>(), codes: [] as string[] };
    recordPublicationCodes([{ shortcode: "A" }, { shortcode: "B" }, { shortcode: "C" }, { shortcode: "D" }, { shortcode: "C" }, { shortcode: "E" }], state, 2);
    expect(state.codes).toEqual(["C", "D"]);
  });
});

describe("perfiles y páginas", () => {
  it("encuentra el perfil en GraphQL anidado", () => {
    const user = findProfile({ data: { user: { id: "7", username: "Test.User", full_name: "Test", is_private: false, follower_count: 12 } } }, "test.user");
    expect(user).toMatchObject({ igId: "7", username: "test.user", followers: 12 });
  });

  it("usa el pk y no el id de FB de las respuestas GraphQL nuevas", () => {
    const user = findProfile(
      { data: { xig_user_by_username: { pk: "484949992", id: "17841400659767577", username: "fio", profile_pic_url: "p", follower_count: 5 } } },
      "fio",
    );
    expect(user?.igId).toBe("484949992");
  });

  it("elige la copia más completa del usuario entre varias respuestas", () => {
    const payloads = [
      { items: [{ code: "A", media_type: 1, user: { pk: "9", username: "fio", profile_pic_url: "small", is_private: false } }] },
      { data: { user: { pk: "9", username: "fio", full_name: "Fio", profile_pic_url: "p", follower_count: 87132, media_count: 897, biography: "hey", is_private: false } } },
    ];
    expect(findUser(payloads, "fio")).toMatchObject({ follower_count: 87132, media_count: 897 });
  });

  it("lee el usuario incrustado en el HTML del perfil", () => {
    const blob = { require: [[{ __bbox: { result: { data: { xig_user_by_username: { pk: "1", username: "fio", full_name: "Fio", profile_pic_url: "p", is_private: false } } } } }]] };
    const html = `<html><script type="application/json" data-sjs>${JSON.stringify(blob)}</script><script type="application/json">{oops</script></html>`;
    const scripts = parseJsonScripts(html);
    expect(scripts).toHaveLength(1);
    expect(findProfile(scripts, "fio")).toMatchObject({ igId: "1", fullName: "Fio", isPrivate: false });
  });

  it("lee stories y highlights incrustados en el HTML del visor", () => {
    const item = (pk: string) => ({ pk, id: `${pk}_9`, code: `C${pk}`, media_type: 1, taken_at: 1, image_versions2: { candidates: [{ url: `u${pk}`, width: 1080, height: 1920 }] } });
    const user = { pk: "9", username: "fio" };
    const stories = { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: "9", reel_type: "user_reel", user, items: [item("1"), item("2")] }] } } };
    const highlight = { data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { id: "highlight:77", reel_type: "highlight_reel", title: "F", user, items: [item("3")] } }] } } };
    const story = parseReels({ reels_media: findReels(stories) }, "story");
    expect(story.map((m) => m.mediaId)).toEqual(["st_1", "st_2"]);
    const hl = parseReels({ reels_media: findReels(highlight) }, "highlight");
    expect(hl).toHaveLength(1);
    expect(hl[0]).toMatchObject({ mediaId: "hl_3", highlightId: "77", width: 1080 });
  });

  it("lee la bandeja de highlights de GraphQL y descarta los de otras cuentas", () => {
    const node = (id: string, username: string) => ({ node: { id: `highlight:${id}`, title: `T${id}`, cover_media: { cropped_image_version: { url: `c${id}` } }, user: { username } } });
    const payload = { data: { highlights: { edges: [node("1", "fio"), node("2", "fio"), node("3", "otra")] } } };
    expect(findHighlights(payload, "fio")).toEqual([
      { highlightId: "1", title: "T1", coverUrl: "c1", itemCount: 0 },
      { highlightId: "2", title: "T2", coverUrl: "c2", itemCount: 0 },
    ]);
  });

  it("toma la paginación de la cuadrícula e ignora el feed de inicio", () => {
    const grid = (more: boolean) => ({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [], page_info: { has_next_page: more } } } });
    const home = { data: { xdt_api__v1__feed__timeline__connection: { page_info: { has_next_page: true } } } };
    expect(userTimelineHasMore([grid(true), home])).toBe(true);
    expect(userTimelineHasMore([grid(true), grid(false), home])).toBe(false);
    expect(userTimelineHasMore([home])).toBeNull();
  });

  it("lee contadores de la meta description", () => {
    expect(parseDescriptionCounts("1,234 Followers, 56 Following, 78 Posts - See photos")).toEqual({ followers: 1234, following: 56, posts: 78 });
    expect(parseCompactNumber("12.5K")).toBe(12500);
  });

  it("detecta muros de login y perfiles vacíos", () => {
    const wall = { url: "https://www.instagram.com/accounts/login/", title: "", text: "Log in to see photos and videos", images: [] };
    expect(snapshotIndicatesLoginWall(wall)).toBe(true);
    expect(snapshotIndicatesEmpty(wall)).toBe(false);
    expect(detectDenial({ ...wall, url: "https://www.instagram.com/challenge/" })?.code).toBe("challenge_required");
  });

  it("construye un perfil desde el DOM", () => {
    const profile = profileFromSnapshot(
      {
        url: "https://www.instagram.com/demo/",
        title: "Demo Person (@demo) • Instagram photos and videos",
        text: "demo\nThis account is private",
        description: "10K Followers, 20 Following, 30 Posts",
        images: [{ src: "pic", alt: "demo's profile picture", width: 150, height: 150, href: "" }],
      },
      "demo",
    );
    expect(profile).toMatchObject({ fullName: "Demo Person", isPrivate: true, followers: 10000, profilePicUrl: "pic" });
  });

  it("valida nombres de usuario", () => {
    expect(sanitizeUsername("@Valid_name.1")).toBe("valid_name.1");
    expect(sanitizeUsername("https://instagram.com/x")).toBeNull();
    expect(sanitizeUsername("bad name")).toBeNull();
  });
});

describe("embed y highlights", () => {
  it("lee shortcode_media del contextJSON del embed", () => {
    const context = JSON.stringify({
      context: { gql_data: { shortcode_media: { id: "9", shortcode: "EMB", is_video: false, display_url: "full", dimensions: { width: 1080, height: 1080 } } } },
    });
    const html = `<script>var x = {"contextJSON":${JSON.stringify(context)}};</script>`;
    const out = parseEmbedHtml(html, "EMB");
    expect(out[0]).toMatchObject({ bestUrl: "full", publicationCode: "EMB", source: "embed", qualityVerified: true });
  });

  it("cae a la imagen embebida si no hay datos", () => {
    const out = parseEmbedHtml('<img class="EmbeddedMediaImage" alt="" src="https://cdn/x.jpg?a=1&amp;b=2">', "IMG");
    expect(out[0]).toMatchObject({ bestUrl: "https://cdn/x.jpg?a=1&b=2", qualityVerified: false });
  });

  it("lee la bandeja de highlights", () => {
    const tray = parseHighlightsTray({ tray: [{ id: "highlight:42", title: "Viajes", media_count: 5, cover_media: { cropped_image_version: { url: "c" } } }] });
    expect(tray).toEqual([{ highlightId: "42", title: "Viajes", coverUrl: "c", itemCount: 5 }]);
  });
});
