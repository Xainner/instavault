export interface AccountInfo {
  id: number;
  username: string;
  status: string; // valid | invalid | unknown
  last_valid: number | null;
}

export interface Profile {
  id: number | null;
  username: string;
  pk: string | null;
  full_name: string | null;
  biography: string | null;
  followers: number | null;
  following: number | null;
  media_count: number | null;
  is_private: number | null;
  is_verified: number | null;
  profile_pic_url: string | null;
  has_content: boolean;
  content_url: string | null;
  byte_size: number | null;
  is_favorite: number;
  fetched_at: number | null;
}

export interface Media {
  id: number | null;
  media_id: string;
  publication_code: string | null;
  child_index: number;
  profile_id: number | null;
  kind: string; // post | story | highlight
  code: string | null;
  taken_at: number | null;
  caption: string | null;
  media_type: number | null; // 1 foto 2 video 8 carousel
  thumbnail_url: string | null;
  thumbnail_content_url: string | null;
  best_url: string | null;
  has_content: boolean;
  content_url: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  quality_verified: boolean;
  status: string; // metadata | downloaded | failed
  error: string | null;
  created_at: number | null;
}

export type Kind = "post" | "story" | "highlight";

export type SyncAccessMode = "public_anonymous" | "authenticated_explicit";
export type SyncStatus =
  | "more_available"
  | "complete"
  | "anonymous_limit"
  | "stalled"
  | "rate_limited"
  | "challenge_required"
  | "cancelled";

export interface SyncProgress {
  profile_id: number;
  kind: string;
  access_mode: SyncAccessMode;
  last_shortcode: string | null;
  publications_seen: number;
  status: SyncStatus;
  stop_reason: string | null;
  updated_at: number;
}

export interface SyncSummary {
  profile_id: number;
  kind: string;
  status: SyncStatus;
  access_mode: SyncAccessMode;
  batch_publications: number;
  new_publications: number;
  updated_publications: number;
  asset_count: number;
  local_publications: number;
  continuation_available: boolean;
  stop_reason: string | null;
  last_shortcode: string | null;
}

export interface DownloadProgress {
  job_id: number;
  profile_id: number;
  kind: string;
  total: number;
  done: number;
  ok: number;
  failed: number;
  current: string | null;
}

export interface DownloadError {
  media_id: string;
  code: string | null;
  error: string;
}

export interface DownloadSummary {
  total: number;
  ok: number;
  failed: number;
  errors: DownloadError[];
}

export interface DownloadJob {
  id: number;
  profile_id: number;
  username: string;
  kind: string;
  total: number;
  ok: number;
  failed: number;
  started_at: number;
  finished_at: number | null;
}

export interface KindStats {
  kind: string;
  local_count: number;
  downloaded: number;
  failed: number;
  last_sync: number | null;
}

export interface ProfileStats {
  profile_id: number;
  total_media: number;
  kinds: KindStats[];
}
