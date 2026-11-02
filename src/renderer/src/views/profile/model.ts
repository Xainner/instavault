import type { Media, MediaStatus } from "@shared/types";

/** Una publicación (o story/pieza suelta) con todas sus piezas. */
export interface Pub {
  key: string;
  items: Media[];
  cover: Media;
  takenAt: number | null;
  status: MediaStatus;
  mediaType: 1 | 2;
  isCarousel: boolean;
}

export type Tab = "post" | "story" | "highlight" | "album";
export type Filter = "all" | "photo" | "video" | "carousel" | "pending" | "failed" | "downloaded";

function aggregate(items: Media[]): MediaStatus {
  if (items.some((m) => m.status === "downloading")) return "downloading";
  if (items.some((m) => m.status === "failed")) return "failed";
  if (items.some((m) => m.status === "pending")) return "pending";
  return "downloaded";
}

export function groupPublications(media: Media[], tab: Tab): Pub[] {
  if (tab === "album") {
    return media
      .filter((m) => m.status === "downloaded")
      .map((m) => ({ key: `m${m.id}`, items: [m], cover: m, takenAt: m.takenAt, status: m.status, mediaType: m.mediaType, isCarousel: false }));
  }
  if (tab !== "post") {
    return media.map((m) => ({ key: `m${m.id}`, items: [m], cover: m, takenAt: m.takenAt, status: m.status, mediaType: m.mediaType, isCarousel: false }));
  }
  const groups = new Map<string, Media[]>();
  for (const m of media) {
    const key = m.publicationCode ? `p${m.publicationCode}` : `m${m.id}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  return [...groups.entries()].map(([key, items]) => {
    items.sort((a, b) => a.childIndex - b.childIndex);
    const cover = items[0];
    return {
      key,
      items,
      cover,
      takenAt: items.reduce<number | null>((max, m) => (m.takenAt && (!max || m.takenAt > max) ? m.takenAt : max), null),
      status: aggregate(items),
      mediaType: cover.mediaType,
      isCarousel: items.length > 1,
    };
  });
}

export function applyFilter(pubs: Pub[], filter: Filter): Pub[] {
  switch (filter) {
    case "photo":
      return pubs.filter((p) => !p.isCarousel && p.mediaType === 1);
    case "video":
      return pubs.filter((p) => p.items.some((m) => m.mediaType === 2));
    case "carousel":
      return pubs.filter((p) => p.isCarousel);
    case "pending":
      return pubs.filter((p) => p.status === "pending" || p.status === "downloading");
    case "failed":
      return pubs.filter((p) => p.status === "failed");
    case "downloaded":
      return pubs.filter((p) => p.status === "downloaded");
    default:
      return pubs;
  }
}

export function previewOf(m: Media): { src: string | null; video: boolean } {
  if (m.thumbUrl) return { src: m.thumbUrl, video: false };
  if (m.mediaType === 2 && m.contentUrl) return { src: m.contentUrl, video: true };
  if (m.contentUrl) return { src: m.contentUrl, video: false };
  return { src: null, video: false };
}
