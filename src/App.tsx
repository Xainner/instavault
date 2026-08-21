import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sidebar, type View } from "./components/Sidebar";
import { AccountsView } from "./components/AccountsView";
import { ProfilesView } from "./components/ProfilesView";
import { MediaDetail } from "./components/MediaDetail";
import { ToastProvider } from "./components/Toasts";
import {
  getMedia,
  listAccounts,
  listProfiles,
} from "./lib/api";
import type { AccountInfo, Kind, Profile } from "./types";
import "./App.css";

function Shell() {
  const [view, setView] = useState<View>("profiles");
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [accountId, setAccountId] = useState<number>(0);
  const [detail, setDetail] = useState<{ prof: Profile; kind: Kind } | null>(null);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [firstLoad, setFirstLoad] = useState(true);

  const load = useCallback(async () => {
    const [accs, profs] = await Promise.all([listAccounts(), listProfiles()]);
    setAccounts(accs);
    setProfiles(profs);
    if (!accountId && accs[0]) setAccountId(accs[0].id);
    // conteo total de medios (para el pie de la sidebar)
    try {
      const withId = profs.filter((p) => p.id != null);
      const totals = await Promise.all(
        withId.map((p) => getMedia(p.id!).then((m) => m.length).catch(() => 0)),
      );
      setMediaTotal(totals.reduce((a, b) => a + b, 0));
    } catch {
      /* noop */
    }
    setFirstLoad(false);
  }, [accountId]);

  useEffect(() => {
    load().catch(() => setFirstLoad(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChanged = useCallback(() => {
    load();
  }, [load]);

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
                prof={detail.prof}
                kind={detail.kind}
                accountId={accountId}
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
              ) : (
                <ProfilesView
                  profiles={profiles}
                  accountId={accountId}
                  onOpen={(p) => setDetail({ prof: p, kind: "post" })}
                  onChanged={onChanged}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}