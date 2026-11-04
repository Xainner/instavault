import type { DownloadRequest, Job, JobProgress } from "@shared/types";
import { assetUrl } from "@shared/urls";
import type { MediaDownloadRow, Repo } from "../db/repo";
import { VaultError } from "../errors";
import { isExpired } from "../ig/cdn";
import type { InstagramService } from "../ig/service";
import { CdnError, downloadToStore, imageSize, makeThumb } from "../net/cdn";
import type { VaultStore } from "../vault/store";

export interface DownloadHooks {
  progress(progress: JobProgress): void;
  finished(job: Job): void;
  mediaChanged(profileId: number, mediaIds: number[]): void;
}

interface JobState {
  id: number;
  profileId: number | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  cancelled: boolean;
  running: number;
  queued: number;
  accountId: number | null;
  controllers: Set<AbortController>;
}

interface Task {
  jobId: number;
  row: MediaDownloadRow;
}

/** Cola global de descargas con concurrencia configurable. */
export class DownloadManager {
  private queue: Task[] = [];
  private jobs = new Map<number, JobState>();
  private inFlight = new Set<number>();
  private active = 0;
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(
    private readonly repo: Repo,
    private readonly store: VaultStore,
    private readonly ig: InstagramService,
    private readonly hooks: DownloadHooks,
  ) {}

  private get concurrency() {
    return Math.min(8, Math.max(1, this.repo.getSettings().concurrency));
  }

  async start(req: DownloadRequest): Promise<Job | null> {
    let rows = this.repo
      .downloadRows({ ids: req.mediaIds, profileId: req.profileId, kind: req.kind, includeFailed: req.includeFailed, force: req.force })
      .filter((row) => !this.inFlight.has(row.id));
    if (!rows.length) return null;
    if (req.force) {
      this.repo.resetMedia(rows.map((r) => r.id));
      rows = rows.map((r) => ({ ...r, status: "pending" }));
    }
    const profiles = new Set(rows.map((r) => r.profileId));
    const profileId = profiles.size === 1 ? rows[0].profileId : null;
    const kindLabel = req.kind ? { post: "publicaciones", story: "stories", highlight: "highlights" }[req.kind] : "piezas";
    const label = req.mediaIds?.length
      ? `${rows.length} ${rows.length === 1 ? "pieza" : "piezas"}${profileId ? ` de @${rows[0].username}` : ""}`
      : `${kindLabel} de @${rows[0].username}`;
    const jobId = this.repo.insertJob(profileId, label, rows.length);
    const state: JobState = {
      id: jobId,
      profileId,
      total: rows.length,
      done: 0,
      ok: 0,
      failed: 0,
      cancelled: false,
      running: 0,
      queued: rows.length,
      accountId: this.ig.resolveAccountId(req.accountId ?? null),
      controllers: new Set(),
    };
    this.jobs.set(jobId, state);
    for (const row of rows) this.inFlight.add(row.id);
    this.emitProgress(state, null);
    void this.prepare(state, rows);
    return this.repo.getJob(jobId);
  }

  /** Re-resuelve sólo las piezas sin URL o con la firma caducada y encola. */
  private async prepare(state: JobState, rows: MediaDownloadRow[]) {
    const stale = rows.filter((r) => !r.bestUrl || isExpired(r.urlExpiresAt));
    if (stale.length) {
      try {
        await this.ig.refreshCandidates(stale, state.accountId);
      } catch (error) {
        // Límite o verificación: no se insiste; las piezas caducadas fallarán con el motivo.
        const message = error instanceof Error ? error.message : String(error);
        for (const row of stale) this.repo.setMediaStatus(row.id, "pending", null);
        if (error instanceof VaultError && ["rate_limited", "challenge_required"].includes(error.code)) {
          for (const row of stale) this.fail(state, row, message);
          rows = rows.filter((r) => !stale.includes(r));
        }
      }
      const fresh = new Map(this.repo.downloadRows({ ids: rows.map((r) => r.id), force: true }).map((r) => [r.id, r]));
      rows = rows.map((r) => fresh.get(r.id) ?? r);
    }
    for (const row of rows) this.queue.push({ jobId: state.id, row });
    this.pump();
    this.maybeFinish(state);
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift()!;
      const state = this.jobs.get(task.jobId);
      if (!state || state.cancelled) {
        this.inFlight.delete(task.row.id);
        continue;
      }
      this.active++;
      state.running++;
      void this.process(state, task.row).finally(() => {
        this.active--;
        state.running--;
        this.inFlight.delete(task.row.id);
        this.maybeFinish(state);
        this.pump();
      });
    }
  }

  private async fetchAsset(row: MediaDownloadRow, controller: AbortController) {
    if (!row.bestUrl) throw new Error("Instagram no entregó una URL descargable para esta pieza.");
    return downloadToStore(this.store, row.bestUrl, {
      bucket: "media",
      fallbackMime: row.mediaType === 2 ? "video/mp4" : "image/jpeg",
      signal: controller.signal,
      onBytes: (n) => this.sample(n),
    });
  }

  private async process(state: JobState, original: MediaDownloadRow) {
    let row = original;
    const controller = new AbortController();
    state.controllers.add(controller);
    this.repo.setMediaStatus(row.id, "downloading");
    this.hooks.mediaChanged(row.profileId, [row.id]);
    try {
      let asset;
      try {
        asset = await this.fetchAsset(row, controller);
      } catch (error) {
        if (!(error instanceof CdnError) || !error.expired) throw error;
        // Firma caducada a pesar del margen: una sola re-resolución.
        await this.ig.refreshCandidates([row], state.accountId);
        row = this.repo.downloadRows({ ids: [row.id], force: true })[0] ?? row;
        asset = await this.fetchAsset(row, controller);
      }
      let width = row.width;
      let height = row.height;
      let thumbSha: string | null = null;
      if (row.mediaType === 1) {
        const size = imageSize(asset.absPath);
        if (size) ({ width, height } = size);
        thumbSha = (await makeThumb(this.store, asset.absPath))?.sha256 ?? null;
      } else if (!row.thumbSha && row.thumbnailUrl) {
        try {
          thumbSha = (await downloadToStore(this.store, row.thumbnailUrl, { bucket: "thumbs", fallbackMime: "image/jpeg", maxBytes: 6 * 1024 * 1024 })).sha256;
        } catch {
          thumbSha = null;
        }
      }
      this.repo.markDownloaded(row.id, asset.sha256, { width, height, thumbSha });
      state.ok++;
      state.done++;
      this.hooks.mediaChanged(row.profileId, [row.id]);
      this.emitProgress(state, { mediaId: row.id, thumbUrl: assetUrl(thumbSha ?? (row.mediaType === 1 ? asset.sha256 : row.thumbSha)), ok: true });
    } catch (error) {
      if (controller.signal.aborted) {
        this.repo.setMediaStatus(row.id, "pending");
        this.hooks.mediaChanged(row.profileId, [row.id]);
        state.done++;
        this.emitProgress(state, null);
      } else {
        this.fail(state, row, error instanceof Error ? error.message : String(error));
      }
    } finally {
      state.controllers.delete(controller);
    }
  }

  private fail(state: JobState, row: MediaDownloadRow, message: string) {
    const friendly = /HTTP 40[34]/.test(message) ? "La CDN rechazó el enlace (caducado o restringido)." : message;
    this.repo.setMediaStatus(row.id, "failed", friendly);
    this.inFlight.delete(row.id);
    state.failed++;
    state.done++;
    this.hooks.mediaChanged(row.profileId, [row.id]);
    this.emitProgress(state, { mediaId: row.id, thumbUrl: null, ok: false });
  }

  private maybeFinish(state: JobState) {
    if (!this.jobs.has(state.id)) return;
    const pendingInQueue = this.queue.some((t) => t.jobId === state.id);
    if (state.running > 0 || pendingInQueue) return;
    if (state.done < state.total && !state.cancelled) return;
    this.jobs.delete(state.id);
    this.repo.finishJob(state.id, state.ok, state.failed, state.cancelled ? "cancelled" : "done");
    const job = this.repo.getJob(state.id);
    if (job) this.hooks.finished(job);
  }

  cancel(jobId: number) {
    const state = this.jobs.get(jobId);
    if (!state) return;
    state.cancelled = true;
    const removed = this.queue.filter((t) => t.jobId === jobId);
    this.queue = this.queue.filter((t) => t.jobId !== jobId);
    for (const task of removed) this.inFlight.delete(task.row.id);
    for (const controller of state.controllers) controller.abort();
    this.maybeFinish(state);
  }

  cancelAll() {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private sample(bytes: number) {
    const t = Date.now();
    this.samples.push({ t, bytes });
    while (this.samples.length && t - this.samples[0].t > 3000) this.samples.shift();
  }

  private speed(): number {
    if (!this.samples.length) return 0;
    const span = Math.max(1, Date.now() - this.samples[0].t) / 1000;
    return Math.round(this.samples.reduce((a, s) => a + s.bytes, 0) / Math.max(span, 1));
  }

  private emitProgress(state: JobState, last: JobProgress["last"]) {
    this.hooks.progress({
      jobId: state.id,
      profileId: state.profileId,
      total: state.total,
      done: state.done,
      ok: state.ok,
      failed: state.failed,
      bytesPerSecond: this.speed(),
      last,
    });
  }

  activeJobIds(): number[] {
    return [...this.jobs.keys()];
  }
}
