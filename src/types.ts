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
  is_private: number;
  is_verified: number;
  profile_pic_url: string | null;
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
