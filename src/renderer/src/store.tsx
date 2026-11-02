import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  AccessMode,
  Account,
  AppInfo,
  Job,
  JobProgress,
  LibraryStats,
  Profile,
  RemoteActivity,
  Settings,
  UpdateState,
  VaultEvent,
} from "@shared/types";
import { VaultClientError, call, errorMessage, isCancelled, onVaultEvent } from "./lib/api";

export type Route =
  | { name: "library" }
  | { name: "profile"; id: number }
  | { name: "quick"; url?: string }
  | { name: "accounts" }
  | { name: "settings" };

interface AccessPromptState {
  message: string;
  account: Account | null;
  resolve: (choice: { use: boolean; remember: boolean }) => void;
}

interface Store {
  route: Route;
  navigate: (route: Route) => void;
  info: AppInfo | null;
  profiles: Profile[];
  stats: LibraryStats | null;
  accounts: Account[];
  settings: Settings | null;
  jobs: Job[];
  progress: Record<number, JobProgress>;
  activity: RemoteActivity | null;
  update: UpdateState;
  developing: string[];
  loaded: boolean;
  downloadsOpen: boolean;
  setDownloadsOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  accessPrompt: AccessPromptState | null;
  refreshProfiles: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Ejecuta una operación remota con la política de respaldo de cuenta. */
  remote: <T>(run: (access: AccessMode, accountId: number | null) => Promise<T>, opts?: { access?: AccessMode; quiet?: boolean }) => Promise<T | null>;
  subscribe: (listener: (event: VaultEvent) => void) => () => void;
  defaultAccount: Account | null;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreProvider ausente");
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [progress, setProgress] = useState<Record<number, JobProgress>>({});
  const [activity, setActivity] = useState<RemoteActivity | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ state: "idle" });
  const [developing, setDeveloping] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accessPrompt, setAccessPrompt] = useState<AccessPromptState | null>(null);
  const listeners = useRef(new Set<(event: VaultEvent) => void>());
  const refreshTimer = useRef<number | null>(null);

  const refreshProfiles = useCallback(async () => {
    const [list, s] = await Promise.all([call("profiles:list"), call("library:stats")]);
    setProfiles(list);
    setStats(s);
  }, []);
  const refreshAccounts = useCallback(async () => setAccounts(await call("accounts:list")), []);
  const refreshJobs = useCallback(async () => setJobs(await call("downloads:jobs")), []);

  const scheduleProfiles = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshProfiles();
    }, 350);
  }, [refreshProfiles]);

  useEffect(() => {
    void (async () => {
      try {
        const [appInfo, s] = await Promise.all([call("app:info"), call("settings:get")]);
        setInfo(appInfo);
        setSettings(s);
        document.documentElement.dataset.reduceMotion = String(s.reduceMotion);
        await Promise.all([refreshProfiles(), refreshAccounts(), refreshJobs()]);
      } catch (error) {
        toast.error("No se pudo abrir la biblioteca", { description: errorMessage(error) });
      } finally {
        setLoaded(true);
      }
    })();
  }, [refreshProfiles, refreshAccounts, refreshJobs]);

  useEffect(
    () =>
      onVaultEvent((event) => {
        switch (event.type) {
          case "library:changed":
          case "media:changed":
            scheduleProfiles();
            break;
          case "job:progress":
            setProgress((prev) => ({ ...prev, [event.progress.jobId]: event.progress }));
            if (event.progress.last?.thumbUrl) {
              const url = event.progress.last.thumbUrl;
              setDeveloping((prev) => [url, ...prev.filter((u) => u !== url)].slice(0, 40));
            }
            if (!jobs.some((j) => j.id === event.progress.jobId)) void refreshJobs();
            break;
          case "job:finished":
            setProgress((prev) => {
              const next = { ...prev };
              delete next[event.job.id];
              return next;
            });
            void refreshJobs();
            scheduleProfiles();
            if (event.job.status === "done") {
              const detail = event.job.failed ? `${event.job.ok} listas · ${event.job.failed} con error` : `${event.job.ok} piezas reveladas`;
              toast.success(`Descarga terminada: ${event.job.label}`, { description: detail });
            }
            break;
          case "remote:activity":
            setActivity(event.activity);
            break;
          case "accounts:changed":
            void refreshAccounts();
            break;
          case "update":
            setUpdate(event.update);
            break;
          default:
            break;
        }
        for (const listener of listeners.current) listener(event);
      }),
    [jobs, refreshAccounts, refreshJobs, scheduleProfiles],
  );

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await call("settings:set", patch);
    setSettings(next);
    document.documentElement.dataset.reduceMotion = String(next.reduceMotion);
  }, []);

  const defaultAccount = useMemo(() => {
    const valid = accounts.filter((a) => a.status === "valid");
    return valid.find((a) => a.id === settings?.defaultAccountId) ?? valid[0] ?? null;
  }, [accounts, settings?.defaultAccountId]);

  const askAccess = useCallback(
    (message: string) =>
      new Promise<{ use: boolean; remember: boolean }>((resolve) => {
        setAccessPrompt({
          message,
          account: defaultAccount,
          resolve: (choice) => {
            setAccessPrompt(null);
            resolve(choice);
          },
        });
      }),
    [defaultAccount],
  );

  const remote = useCallback<Store["remote"]>(
    async (run, opts = {}) => {
      const access = opts.access ?? "public";
      try {
        return await run(access, access === "account" ? (defaultAccount?.id ?? null) : null);
      } catch (error) {
        if (isCancelled(error)) {
          toast("Operación cancelada");
          return null;
        }
        if (error instanceof VaultClientError && error.canUseAccount && defaultAccount) {
          const choice = await askAccess(error.message);
          if (!choice.use) return null;
          if (choice.remember) await saveSettings({ fallbackPolicy: "auto" });
          try {
            return await run("account", defaultAccount.id);
          } catch (inner) {
            if (!isCancelled(inner)) toast.error("Instagram no lo permitió", { description: errorMessage(inner) });
            return null;
          }
        }
        if (opts.quiet) throw error;
        const needsAccount = error instanceof VaultClientError && error.canUseAccount && !defaultAccount;
        toast.error(needsAccount ? "Hace falta una cuenta conectada" : "No se pudo completar", {
          description: needsAccount ? `${errorMessage(error)} Conecta una cuenta en «Cuentas».` : errorMessage(error),
          action: needsAccount ? { label: "Conectar", onClick: () => setRoute({ name: "accounts" }) } : undefined,
        });
        return null;
      }
    },
    [askAccess, defaultAccount, saveSettings],
  );

  const subscribe = useCallback((listener: (event: VaultEvent) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    if (next.name === "profile") void call("profiles:touch", { profileId: next.id }).catch(() => undefined);
  }, []);

  const value: Store = {
    route,
    navigate,
    info,
    profiles,
    stats,
    accounts,
    settings,
    jobs,
    progress,
    activity,
    update,
    developing,
    loaded,
    downloadsOpen,
    setDownloadsOpen,
    paletteOpen,
    setPaletteOpen,
    accessPrompt,
    refreshProfiles,
    refreshAccounts,
    refreshJobs,
    saveSettings,
    remote,
    subscribe,
    defaultAccount,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
