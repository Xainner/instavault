import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  addAccount,
  deleteAccount,
  deleteProfile,
  downloadProfile,
  fetchProfile,
  getMedia,
  listAccounts,
  listProfiles,
  syncHighlights,
  syncPosts,
  syncStories,
  validateAccount,
} from "./lib/api";
import type { AccountInfo, Kind, Media, Profile } from "./types";
import "./App.css";

type View = "accounts" | "profiles";

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtDate(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString("es-CR");
}

export default function App() {
  const [view, setView] = useState<View>("accounts");
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<AccountInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const [accs, profs] = await Promise.all([listAccounts(), listProfiles()]);
    setAccounts(accs);
    setProfiles(profs);
    setSelected((s) => s && accs.find((a) => a.id === s.id) ? { ...s, status: accs.find((a) => a.id === s.id)!.status } : s);
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📸 InstaVault</div>
        <nav>
          <button className={view === "accounts" ? "tab active" : "tab"} onClick={() => setView("accounts")}>
            Cuentas
          </button>
          <button className={view === "profiles" ? "tab active" : "tab"} onClick={() => setView("profiles")}>
            Perfiles
          </button>
        </nav>
      </header>

      <main className="content">
        {view === "accounts" ? (
          <AccountsView
            accounts={accounts}
            selected={selected}
            setSelected={setSelected}
            busy={busy}
            setBusy={setBusy}
            onChanged={refresh}
          />
        ) : (
          <ProfilesView
            profiles={profiles}
            accounts={accounts}
            busy={busy}
            setBusy={setBusy}
            onChanged={refresh}
          />
        )}
      </main>

      {busy && <div className="toast">{busy}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

function AccountsView({
  accounts,
  selected,
  setSelected,
  busy,
  setBusy,
  onChanged,
}: {
  accounts: AccountInfo[];
  selected: AccountInfo | null;
  setSelected: (a: AccountInfo | null) => void;
  busy: string | null;
  setBusy: (s: string | null) => void;
  onChanged: () => void;
}) {
  const [username, setUsername] = useState("");
  const [cookies, setCookies] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setBusy("Agregando cuenta…");
    try {
      await addAccount(username.trim(), cookies.trim());
      setUsername("");
      setCookies("");
      await onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const doValidate = async (a: AccountInfo) => {
    setBusy(`Validando @${a.username}…`);
    await validateAccount(a.id);
    setBusy(null);
    await onChanged();
  };

  const doDelete = async (a: AccountInfo) => {
    if (!confirm(`¿Eliminar la cuenta @${a.username} y sus cookies?`)) return;
    await deleteAccount(a.id);
    if (selected?.id === a.id) setSelected(null);
    await onChanged();
  };

  return (
    <div className="two-col">
      <div className="panel">
        <h2>Cuentas de Instagram</h2>
        {accounts.length === 0 ? (
          <p className="muted">Aún no hay cuentas. Agrega una con tus cookies (necesario para privados y stories).</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr
                  key={a.id}
                  className={selected?.id === a.id ? "row selected" : "row"}
                  onClick={() => setSelected(a)}
                >
                  <td>@{a.username}</td>
                  <td>
                    <span className={`badge ${a.status}`}>{a.status}</span>
                  </td>
                  <td className="row-actions">
                    <button onClick={(e) => { e.stopPropagation(); doValidate(a); }} disabled={!!busy}>
                      Validar
                    </button>
                    <button className="danger" onClick={(e) => { e.stopPropagation(); doDelete(a); }}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Agregar cuenta</h2>
        <p className="hint">
          Pega las cookies de tu sesión iniciada en el navegador (perfil privado).
        </p>
        <label>
          Usuario
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="tu_usuario_sin_arroba"
          />
        </label>
        <label>
          Cookies (sessionid, csrftoken, ds_user_id…)
          <textarea
            rows={6}
            value={cookies}
            onChange={(e) => setCookies(e.target.value)}
            placeholder={
              "sessionid=abc...; csrftoken=xyz...; ds_user_id=123; ig_did=..."
            }
          />
        </label>
        {err && <p className="error">{err}</p>}
        <button onClick={submit} disabled={!username || !cookies || !!busy}>
          {busy ? "Trabajando…" : "Agregar cuenta"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Perfiles
// ---------------------------------------------------------------------------

function ProfilesView({
  profiles,
  accounts,
  busy,
  setBusy,
  onChanged,
}: {
  profiles: Profile[];
  accounts: AccountInfo[];
  busy: string | null;
  setBusy: (s: string | null) => void;
  onChanged: () => void;
}) {
  const [accountId, setAccountId] = useState<number | "">("");
  const [username, setUsername] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ prof: Profile; kind: Kind } | null>(null);
  const activeAccount = Number(accountId || accounts[0]?.id || 0);

  const doFetch = async () => {
    if (accountId === "" || !username.trim()) return;
    setErr(null);
    setBusy(`Resolviendo @${username.trim()}…`);
    try {
      await fetchProfile(accountId, username.trim());
      setUsername("");
      await onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const doSync = async (p: Profile, kind: Kind) => {
    setBusy(`Sincronizando ${kind} de @${p.username}…`);
    try {
      if (kind === "post") await syncPosts(activeAccount, p.username);
      if (kind === "story") await syncStories(activeAccount, p.username);
      if (kind === "highlight") await syncHighlights(activeAccount, p.username);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const doDownload = async (p: Profile, kind: Kind) => {
    if (!p.id) return;
    setBusy(`Descargando ${kind} de @${p.username}…`);
    try {
      const [ok, fail] = await downloadProfile(activeAccount, p.id, kind);
      setBusy(`Listo: ${ok} descargados, ${fail} fallidos.`);
      setTimeout(() => setBusy(null), 3000);
    } catch (e) {
      setErr(String(e));
      setBusy(null);
    }
    onChanged();
  };

  const doDelete = async (p: Profile) => {
    if (!p.id) return;
    if (!confirm(`¿Eliminar el perfil @${p.username} y todo su contenido?`)) return;
    await deleteProfile(p.id);
    onChanged();
  };

  return (
    <div className="vstack">
      {detail ? (
        <Detail
          prof={detail.prof}
          kind={detail.kind}
          accountId={activeAccount}
          onBack={() => setDetail(null)}
          reload={onChanged}
        />
      ) : (
        <>
          <div className="panel">
            <h2>Buscar perfil</h2>
            <div className="inline-form">
              <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value) || "")}>
                <option value="" disabled>
                  Elegir cuenta…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                onKeyDown={(e) => e.key === "Enter" && doFetch()}
              />
              <button onClick={doFetch} disabled={!accountId || !username || !!busy}>
                Buscar
              </button>
            </div>
            {err && <p className="error">{err}</p>}
            {accounts.length === 0 && (
              <p className="error">Primero agrega una cuenta en la pestaña Cuentas (las cookies).</p>
            )}
          </div>

          <div className="panel">
            <h2>Perfiles guardados</h2>
            {profiles.length === 0 ? (
              <p className="muted">Busca un usuario para guardarlo aquí.</p>
            ) : (
              <div className="profile-grid">
                {profiles.map((p) => (
                  <div key={p.username} className="profile-card">
                    <div
                      className="avatar"
                      style={
                        p.profile_pic_url
                          ? { backgroundImage: `url(${p.profile_pic_url})` }
                          : { background: "#555" }
                      }
                    />
                    <div className="meta">
                      <strong>@{p.username}</strong>
                      <span className="muted">
                        {p.is_private ? "🔒 " : ""}
                        {fmtNum(p.media_count)} posts · {fmtNum(p.followers)} seguidores
                      </span>
                    </div>
                    <div className="kind-buttons">
                      {(["post", "story", "highlight"] as Kind[]).map((k) => (
                        <div key={k} className="kind-row">
                          <button onClick={() => setDetail({ prof: p, kind: k })}>
                            Ver {k}s
                          </button>
                          <button onClick={() => doDownload(p, k)} disabled={!!busy}>
                            ⬇
                          </button>
                          <button onClick={() => doSync(p, k)} disabled={!!busy}>
                            ⟳
                          </button>
                        </div>
                      ))}
                    </div>
                    <button className="danger" onClick={() => doDelete(p)}>
                      Eliminar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalle / biblioteca
// ---------------------------------------------------------------------------

function Detail({
  prof,
  kind,
  accountId,
  onBack,
  reload,
}: {
  prof: Profile;
  kind: Kind;
  accountId: number;
  onBack: () => void;
  reload: () => void;
}) {
  const [media, setMedia] = useState<Media[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyDl, setBusyDl] = useState(false);

  useEffect(() => {
    if (!prof.id) return;
    getMedia(prof.id, kind).then((m) => {
      setMedia(m);
      setLoaded(true);
    });
  }, [prof.id, kind]);

  const pending = media.filter((m) => m.status === "metadata");

  const downloadAll = async () => {
    if (!prof.id || pending.length === 0) return;
    setBusyDl(true);
    try {
      const [ok, fail] = await downloadProfile(accountId, prof.id, kind);
      alert(`Descarga terminada: ${ok} OK, ${fail} fallidos.`);
    } catch (e) {
      alert(String(e));
    } finally {
      setBusyDl(false);
      reload();
    }
  };

  return (
    <div className="panel">
      <div className="detail-head">
        <button onClick={onBack}>← Volver</button>
        <h2>
          @{prof.username} · {kind}s{" "}
          {loaded && <span className="muted">({media.length})</span>}
        </h2>
        <button onClick={downloadAll} disabled={!pending.length || busyDl}>
          {busyDl ? "Descargando…" : `⬇ Descargar ${pending.length} pendientes`}
        </button>
      </div>

      <div className="media-grid">
        {!loaded ? (
          <p className="muted">Cargando…</p>
        ) : media.length === 0 ? (
          <p className="muted">
            Sin {kind}s guardados. Usa ⟳ en la tarjeta del perfil para sincronizar.
          </p>
        ) : (
          media.map((m) => (
            <div key={m.media_id} className={`media-card ${m.status}`}>
              {m.thumbnail_url || m.local_path ? (
                <img
                  src={m.local_path ? convertFileSrc(m.local_path) : m.thumbnail_url!}
                  alt={m.caption ?? m.media_id}
                  loading="lazy"
                  onClick={() => m.best_url && window.open(m.best_url, "_blank")}
                />
              ) : (
                <div className="no-thumb">video/carousel</div>
              )}
              <div className="media-foot">
                <span className={`badge ${m.status}`}>
                  {m.status === "metadata" ? "pendiente" : m.status}
                </span>
                <span className="muted">{fmtDate(m.taken_at)}</span>
              </div>
              {m.status === "failed" && m.error && (
                <div className="media-err" title={m.error}>
                  ⚠
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
