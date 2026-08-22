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
  avatar_local_path: string | null;
  is_favorite: number;
  fetched_at: number | null;
}

export interface Media {
  id: number | null;
  media_id: string;
  profile_id: number | null;
  kind: string; // post | story | highlight
  code: string | null;
  taken_at: number | null;
  caption: string | null;
  media_type: number | null; // 1 foto 2 video 8 carousel
  thumbnail_url: string | null;
  best_url: string | null;
  local_path: string | null;
  status: string; // metadata | downloaded | failed
  error: string | null;
  created_at: number | null;
}

export type Kind = "post" | "story" | "highlight";

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
