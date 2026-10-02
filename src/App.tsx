import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Sidebar, type View } from "./components/Sidebar";
import { AccountsView } from "./components/AccountsView";
import { ProfilesView } from "./components/ProfilesView";
import { MediaDetail } from "./components/MediaDetail";
import { DownloadManager, DownloadProvider } from "./components/Downloads";
import { ToastProvider } from "./components/Toasts";
import { AboutView } from "./components/AboutView";
import { CommandPalette } from "./components/CommandPalette";
import { UpdaterProvider } from "./components/Updater";
import { getProfileStats, listAccounts, listProfiles } from "./lib/api";
import type { AccountInfo, Kind, Profile, ProfileStats } from "./types";
import "./App.css";

function Shell() {
  const [view, setView] = useState<View>("profiles");
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [stats, setStats] = useState<ProfileStats[]>([]);
  const [accountId, setAccountId] = useState<number>(0);
  const [detail, setDetail] = useState<{ prof: Profile; kind: Kind } | null>(null);
  const [dlOpen, setDlOpen] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);

  const load = useCallback(async () => {
    const [accs, profs, st] = await Promise.all([
      listAccounts(),
      listProfiles(),
      getProfileStats().catch(() => [] as ProfileStats[]),
    ]);
    setAccounts(accs);
    setProfiles(profs);
    setStats(st);
    if (!accountId && accs[0]) setAccountId(accs[0].id);
    setFirstLoad(false);
  }, [accountId]);

  useEffect(() => {
    load().catch(() => setFirstLoad(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChanged = useCallback(() => {
    load();
  }, [load]);

  const mediaTotal = stats.reduce((a, s) => a + s.total_media, 0);
  const downloadedTotal = stats.reduce(
    (a, s) => a + s.kinds.reduce((x, k) => x + k.downloaded, 0),
    0,
  );

  const body = useMemo(() => {
      if (firstLoad)
        return (
          <div className="page-head">
            <div>
              <h1 className="page-title">InstaVault</h1>
              <p className="page-sub">Cargando tu biblioteca…</p>
            </div>
          </div>
        );
      return null;
    }, [firstLoad]);

  return (
    <DownloadProvider onJobDone={onChanged}>
    <div className="layout">
      <Sidebar
        view={view}
        setView={(v) => {
          setView(v);
          setDetail(null);
        }}
        accounts={accounts}
        activeAccount={accountId}
        setAccountId={setAccountId}
        profileCount={profiles.length}
        mediaCount={mediaTotal}
        downloadedCount={downloadedTotal}
        dlOpen={dlOpen}
        onOpenDownloads={() => setDlOpen((o) => !o)}
      />

      <main className="main">
        <AnimatePresence mode="wait">
          {detail ? (
            <motion.div
              key="detail"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.2 }}
            >
              <MediaDetail
                prof={profiles.find((q) => q.id === detail.prof.id) ?? detail.prof}
                kind={detail.kind}
                accountId={accountId}
                stats={stats.find((s) => s.profile_id === detail.prof.id) ?? null}
                onBack={() => setDetail(null)}
                onChanged={onChanged}
              />
            </motion.div>
          ) : (
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {body}
              {view === "accounts" ? (
                <AccountsView
                  accounts={accounts}
                  activeAccount={accountId}
                  setAccountId={setAccountId}
                  onChanged={onChanged}
                />
              ) : view === "about" ? (
                <AboutView profiles={profiles.length} media={mediaTotal} downloaded={downloadedTotal} />
              ) : (
                <ProfilesView
                  profiles={profiles}
                  accountId={accountId}
                  stats={stats}
                  onOpen={(p) => setDetail({ prof: p, kind: "post" })}
                  onChanged={onChanged}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <DownloadManager
        open={dlOpen}
        onClose={() => setDlOpen(false)}
        accountId={accountId}
      />
      <CommandPalette
        navigate={(next) => { setView(next); setDetail(null); }}
        openDownloads={() => setDlOpen(true)}
      />
    </div>
    </DownloadProvider>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <UpdaterProvider><Shell /></UpdaterProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
