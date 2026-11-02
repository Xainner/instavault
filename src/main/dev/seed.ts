import { existsSync } from "node:fs";
import { join } from "node:path";
import { nativeImage } from "electron";
import type { Repo } from "../db/repo";
import type { ExtractedMedia, ExtractedProfile } from "../ig/types";
import type { VaultStore } from "../vault/store";

/**
 * Biblioteca de demostración para pruebas visuales automatizadas. Sólo se
 * ejecuta con INSTAVAULT_SEED_DIR; nunca contacta Instagram. Todos los
 * perfiles y fotos son ficticios.
 */
interface DemoProfile {
  profile: ExtractedProfile;
  photos: string[];
  favorite?: boolean;
  video?: boolean;
  posts: number;
}

const DEMO: DemoProfile[] = [
  {
    profile: demoProfile("costa.norte", "Costa Norte", "Acantilados, faros y puertos del Cantábrico. Fotografía de viaje lenta.", 48_200, 512, 214, false, true),
    photos: ["01", "02", "03"],
    favorite: true,
    video: true,
    posts: 15,
  },
  {
    profile: demoProfile("ruta.andina", "Ruta Andina", "Lagos de altura, carreteras vacías y cielos enormes.", 12_900, 288, 96, false, false),
    photos: ["05", "10"],
    favorite: true,
    posts: 10,
  },
  {
    profile: demoProfile("taller.cobre", "Taller Cobre · cerámica", "Piezas hechas a mano en pequeñas tandas. Esmaltes propios.", 7_350, 402, 61, false, false),
    photos: ["04"],
    posts: 7,
  },
  {
    profile: demoProfile("mesa.lenta", "Mesa Lenta", "Pan de masa madre, mercados y cocina de temporada.", 23_400, 911, 138, false, false),
    photos: ["07", "09"],
    posts: 9,
  },
  {
    profile: demoProfile("noche.urbana", "Noche Urbana", "La ciudad después de las diez.", 3_120, 180, 44, true, false),
    photos: ["06", "08"],
    posts: 8,
  },
];

function demoProfile(
  username: string,
  fullName: string,
  biography: string,
  followers: number,
  following: number,
  mediaCount: number,
  isPrivate: boolean,
  isVerified: boolean,
): ExtractedProfile {
  return {
    username,
    igId: String(10_000_000 + username.length * 7919),
    fullName,
    biography,
    externalUrl: null,
    followers,
    following,
    mediaCount,
    isPrivate,
    isVerified,
    profilePicUrl: null,
  };
}

const CROPS = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0.08, y: 0.06, w: 0.84, h: 0.84 },
  { x: 0.18, y: 0.12, w: 0.72, h: 0.72 },
  { x: 0, y: 0.2, w: 0.8, h: 0.8 },
  { x: 0.2, y: 0, w: 0.8, h: 0.8 },
];

async function variant(store: VaultStore, path: string, cropIndex: number, square = false) {
  const image = nativeImage.createFromPath(path);
  const size = image.getSize();
  const c = CROPS[cropIndex % CROPS.length];
  let rect = { x: Math.round(size.width * c.x), y: Math.round(size.height * c.y), width: Math.round(size.width * c.w), height: Math.round(size.height * c.h) };
  if (square) {
    const side = Math.min(rect.width, rect.height);
    rect = { ...rect, width: side, height: side };
  }
  const cropped = image.crop(rect);
  const full = cropped.resize({ width: Math.min(1080, rect.width), quality: "best" });
  const fullSize = full.getSize();
  const asset = await store.ingestBuffer(full.toJPEG(88), { bucket: "media", mime: "image/jpeg", width: fullSize.width, height: fullSize.height });
  const thumbImage = full.resize({ width: 480, quality: "good" });
  const thumbSize = thumbImage.getSize();
  const thumb = await store.ingestBuffer(thumbImage.toJPEG(80), { bucket: "thumbs", mime: "image/jpeg", width: thumbSize.width, height: thumbSize.height });
  return { asset, thumb, width: fullSize.width, height: fullSize.height };
}

export async function seedDemoLibrary(repo: Repo, store: VaultStore, dir: string, bulk: number) {
  if (repo.listProfiles().length) return;
  const photo = (name: string) => join(dir, "photos", `${name}.jpg`);
  if (!existsSync(photo("01"))) throw new Error(`No hay fotos de demostración en ${dir}`);
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  repo.setSettings({ onboardingDone: process.env.INSTAVAULT_SEED_ONBOARDING !== "1" });

  const accountId = repo.upsertAccount({ username: "tu.cuenta", igUserId: "4242", partition: "persist:ig-acct-demo" });
  repo.setSettings({ defaultAccountId: accountId });

  let firstThumb: string | null = null;
  for (const [profileIndex, demo] of DEMO.entries()) {
    const profileId = repo.upsertProfile(demo.profile);
    if (demo.favorite) repo.setFavorite(profileId, true);
    const avatar = await variant(store, photo(demo.photos[0]), 2, true);
    const avatarImage = nativeImage.createFromPath(store.absolute(avatar.asset.relPath)).resize({ width: 320 });
    const avatarAsset = await store.ingestBuffer(avatarImage.toJPEG(86), { bucket: "avatars", mime: "image/jpeg" });
    repo.setProfileAvatar(profileId, avatarAsset.sha256);

    const items: ExtractedMedia[] = [];
    const files: Array<{ code: string; child: number; asset: string; thumb: string; width: number; height: number; status: "downloaded" | "pending" | "failed" }> = [];
    for (let i = 0; i < demo.posts; i++) {
      const code = `D${profileIndex}${String(i).padStart(3, "0")}xQ`;
      const isCarousel = i === 2;
      const children = isCarousel ? 3 : 1;
      for (let child = 0; child < children; child++) {
        const source = demo.photos[(i + child) % demo.photos.length];
        const v = await variant(store, photo(source), i + child * 2);
        firstThumb ??= v.thumb.sha256;
        const status = i === 5 ? "failed" : i >= demo.posts - 3 ? "pending" : "downloaded";
        items.push({
          mediaId: isCarousel ? `${900 + profileIndex * 100 + i}_${child}` : String(900 + profileIndex * 100 + i),
          publicationCode: code,
          childIndex: child,
          childCount: children,
          kind: "post",
          takenAt: now - (i * 3 + profileIndex) * day - child,
          caption:
            i % 3 === 0
              ? `${demo.profile.fullName} · serie ${i + 1}. Luz de tarde y mucha calma. #fotografia #${demo.profile.username.replace(".", "")}`
              : i % 3 === 1
                ? `Cuaderno de ruta, día ${i + 4}. @${DEMO[(profileIndex + 1) % DEMO.length].profile.username}`
                : null,
          mediaType: 1,
          bestUrl: `https://scontent.cdninstagram.com/demo/${code}_${child}.jpg?oe=${(now + 30 * day).toString(16)}`,
          thumbnailUrl: null,
          width: v.width,
          height: v.height,
          bitrate: null,
          duration: null,
          qualityVerified: i % 4 !== 3,
          source: i % 4 === 3 ? "dom_fallback" : "web_api",
        });
        files.push({ code, child, asset: v.asset.sha256, thumb: v.thumb.sha256, width: v.width, height: v.height, status });
      }
    }
    if (demo.video && existsSync(join(dir, "photos", "clip.mp4"))) {
      const video = await store.ingestFile(join(dir, "photos", "clip.mp4"), { bucket: "media", mime: "video/mp4" });
      const v = await variant(store, photo(demo.photos[0]), 1);
      items.push({
        mediaId: "777001",
        publicationCode: "DVIDEO01xQ",
        childIndex: 0,
        childCount: 1,
        kind: "post",
        takenAt: now - 3600,
        caption: "Atardecer en movimiento. Sonido del mar al final.",
        mediaType: 2,
        bestUrl: `https://scontent.cdninstagram.com/demo/video.mp4?oe=${(now + 30 * day).toString(16)}`,
        thumbnailUrl: null,
        width: 720,
        height: 900,
        bitrate: 2_400_000,
        duration: 6,
        qualityVerified: true,
        source: "web_api",
      });
      files.push({ code: "DVIDEO01xQ", child: 0, asset: video.sha256, thumb: v.thumb.sha256, width: 720, height: 900, status: "downloaded" });
    }
    repo.upsertMedia(profileId, items);
    const rows = repo.listMedia(profileId, "post");
    for (const f of files) {
      const row = rows.find((r) => r.publicationCode === f.code && r.childIndex === f.child);
      if (!row) continue;
      repo.setThumb(row.id, f.thumb);
      if (f.status === "downloaded") repo.markDownloaded(row.id, f.asset, { width: f.width, height: f.height, thumbSha: f.thumb });
      if (f.status === "failed") repo.setMediaStatus(row.id, "failed", "La CDN rechazó el enlace (caducado o restringido).");
    }
    repo.saveSync({
      profileId,
      kind: "post",
      access: demo.profile.isPrivate ? "account" : "public",
      cursor: null,
      lastCode: files.at(-1)?.code ?? null,
      seen: demo.posts,
      status: profileIndex === 1 ? "anonymous_limit" : profileIndex === 0 ? "complete" : "more_available",
      stopReason: profileIndex === 1 ? "Instagram limitó el modo anónimo tras 10 publicaciones." : null,
    });

    if (profileIndex === 0) {
      // Stories y highlights de ejemplo
      const stories: ExtractedMedia[] = [];
      for (let s = 0; s < 4; s++) {
        stories.push({
          mediaId: `st_55${s}`,
          publicationCode: null,
          childIndex: 0,
          childCount: 1,
          kind: "story",
          takenAt: now - s * 4 * 3600,
          caption: null,
          mediaType: 1,
          bestUrl: `https://scontent.cdninstagram.com/demo/story${s}.jpg`,
          thumbnailUrl: null,
          width: 1080,
          height: 1920,
          bitrate: null,
          duration: null,
          qualityVerified: true,
          source: "web_api",
        });
      }
      repo.upsertMedia(profileId, stories);
      const storyRows = repo.listMedia(profileId, "story");
      for (const [s, row] of storyRows.entries()) {
        const v = await variant(store, photo(demo.photos[s % demo.photos.length]), s + 1);
        repo.setThumb(row.id, v.thumb.sha256);
        repo.markDownloaded(row.id, v.asset.sha256, { width: v.width, height: v.height, thumbSha: v.thumb.sha256 });
      }
      repo.saveSync({ profileId, kind: "story", access: "account", cursor: null, lastCode: null, seen: 4, status: "complete", stopReason: null });
      const highlightTitles = ["Faros", "Puertos", "Mareas", "Invierno"];
      repo.upsertHighlights(
        profileId,
        highlightTitles.map((title, h) => ({ highlightId: `1780${h}`, title, coverUrl: null, itemCount: 3 + h })),
      );
      const hl = repo.listHighlights(profileId);
      const hlItems: ExtractedMedia[] = [];
      for (const [h, entry] of hl.entries()) {
        const cover = await variant(store, photo(demo.photos[h % demo.photos.length]), h + 2, true);
        repo.setHighlightCover(entry.id, cover.thumb.sha256);
        for (let k = 0; k < 2; k++) {
          hlItems.push({
            mediaId: `hl_${entry.highlightId}${k}`,
            publicationCode: null,
            childIndex: 0,
            childCount: 1,
            kind: "highlight",
            highlightId: entry.highlightId,
            takenAt: now - (h * 30 + k) * day,
            caption: null,
            mediaType: 1,
            bestUrl: `https://scontent.cdninstagram.com/demo/hl${h}${k}.jpg`,
            thumbnailUrl: null,
            width: 1080,
            height: 1920,
            bitrate: null,
            duration: null,
            qualityVerified: true,
            source: "web_api",
          });
        }
      }
      repo.upsertMedia(profileId, hlItems);
      for (const [k, row] of repo.listMedia(profileId, "highlight").entries()) {
        const v = await variant(store, photo(demo.photos[k % demo.photos.length]), k + 3);
        repo.setThumb(row.id, v.thumb.sha256);
        if (k % 3 !== 2) repo.markDownloaded(row.id, v.asset.sha256, { width: v.width, height: v.height, thumbSha: v.thumb.sha256 });
      }
      repo.saveSync({ profileId, kind: "highlight", access: "account", cursor: null, lastCode: null, seen: hlItems.length, status: "complete", stopReason: null });
    }

    const jobId = repo.insertJob(profileId, `publicaciones de @${demo.profile.username}`, demo.posts);
    repo.finishJob(jobId, demo.posts - 1, profileIndex % 2, "done");
  }

  repo.addQuick({ url: "https://www.instagram.com/p/D0001xQ/", ownerUsername: "costa.norte", itemCount: 1, thumbSha: firstThumb, savedLibrary: true });
  repo.addQuick({ url: "https://www.instagram.com/reel/D3002xQ/", ownerUsername: "mesa.lenta", itemCount: 1, thumbSha: firstThumb, savedLibrary: false });

  if (bulk > 0) {
    const profileId = repo.upsertProfile(demoProfile("archivo.masivo", "Archivo masivo", "Perfil sintético para pruebas de rendimiento.", 1_200_000, 12, bulk, false, false));
    const thumbs = repo.listMedia(repo.listProfiles().find((p) => p.username === "costa.norte")!.id, "post").filter((m) => m.thumbUrl);
    const items: ExtractedMedia[] = [];
    for (let i = 0; i < bulk; i++) {
      items.push({
        mediaId: `bulk_${i}`,
        publicationCode: `BULK${i}`,
        childIndex: 0,
        childCount: 1,
        kind: "post",
        takenAt: now - i * 3600,
        caption: null,
        mediaType: 1,
        bestUrl: `https://scontent.cdninstagram.com/demo/bulk${i}.jpg`,
        thumbnailUrl: null,
        width: 1080,
        height: 1350,
        bitrate: null,
        duration: null,
        qualityVerified: true,
        source: "web_api",
      });
    }
    repo.upsertMedia(profileId, items);
    const rows = repo.listMedia(profileId, "post");
    repo.tx(() => {
      rows.forEach((row, i) => {
        const source = thumbs[i % thumbs.length];
        const sha = source.thumbUrl!.replace("vault://a/", "");
        repo.setThumb(row.id, sha);
      });
    });
  }
}
