import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Database, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { useUpdater } from "./Updater";

export function AboutView({ profiles, media, downloaded }: { profiles: number; media: number; downloaded: number }) {
  const [version, setVersion] = useState("1.0.0");
  const updater = useUpdater();
  useEffect(() => { void getVersion().then(setVersion); }, []);
  return <div className="view about-view">
    <div className="page-head"><div><h1 className="page-title">Acerca de</h1><p className="page-sub">Información, privacidad y actualizaciones de InstaVault.</p></div></div>
    <Card className="about-hero">
      <img src="/logo.png" alt="Logo de InstaVault" />
      <div><span className="version-pill">Versión {version}</span><h2>Tu archivo de Instagram, privado y local.</h2>
      <p>Perfiles, publicaciones, stories y highlights organizados en una biblioteca SQLite bajo tu control.</p></div>
    </Card>
    <div className="about-grid">
      <Card className="about-card"><ShieldCheck /><h3>Privacidad local</h3><p>Los medios se guardan dentro de la base de datos de la aplicación. Solo se exportan cuando eliges “Guardar en dispositivo”.</p></Card>
      <Card className="about-card"><Database /><h3>Biblioteca</h3><p>{profiles} perfiles · {media} medios · {downloaded} descargados</p></Card>
    </div>
    <Card className="about-update"><div><h3>Actualizaciones vía GitHub</h3><p>{updater.availableVersion ? `Versión ${updater.availableVersion} disponible.` : "Canal estable · GitHub Releases"}</p></div>
      <Button onClick={() => updater.checkNow(true)} disabled={updater.checking}>{updater.checking ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Buscar actualizaciones</Button></Card>
    <div className="about-links"><span>© Xainner · Licencia MIT</span><button onClick={() => openUrl("https://github.com/Xainner/instavault")}>Ver repositorio <ExternalLink size={13} /></button></div>
  </div>;
}
