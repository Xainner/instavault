import type { MediaKind, MediaType } from "@shared/types";

export type MediaSource = "web_api" | "web_response" | "dom_fallback" | "embed" | "legacy";

/** Una pieza (foto o video) normalizada desde cualquier forma de respuesta. */
export interface ExtractedMedia {
  mediaId: string;
  publicationCode: string | null;
  childIndex: number;
  childCount: number;
  kind: MediaKind;
  highlightId?: string | null;
  takenAt: number | null;
  caption: string | null;
  mediaType: MediaType;
  bestUrl: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  duration: number | null;
  qualityVerified: boolean;
  source: MediaSource;
  ownerUsername?: string | null;
}

export interface ExtractedProfile {
  username: string;
  igId: string | null;
  fullName: string | null;
  biography: string | null;
  externalUrl: string | null;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  isPrivate: boolean | null;
  isVerified: boolean;
  profilePicUrl: string | null;
}

export interface ExtractedHighlight {
  highlightId: string;
  title: string;
  coverUrl: string | null;
  itemCount: number;
}
