<p align="center">
  <img src="logo.png" alt="InstaVault" width="160" />
</p>

<h1 align="center">InstaVault</h1>

<p align="center">
  <strong>Archivador privado de perfiles de Instagram.</strong><br/>
  Publicaciones, stories, highlights y fotos de perfil en máxima calidad,<br/>guardados como BLOB dentro de una biblioteca SQLite local.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white" alt="Tauri"/>
  <img src="https://img.shields.io/badge/Rust-estable-DEA584?logo=rust&logoColor=white" alt="Rust"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white" alt="SQLite"/>
  <img src="https://img.shields.io/badge/plataforma-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Plataformas"/>
  <img src="https://img.shields.io/badge/licencia-MIT-blue" alt="Licencia"/>
</p>

---

## ✨ Características

### Cuentas y sesiones
- **Tres formas de entrar**: pegar las cookies de tu navegador, **importar desde un perfil de Chrome/Edge/Firefox** (cookies descriptas del keyring del sistema), o **login asistido** en el navegador propio de la app (Chrome headless con CDP).
- **Cifrado en el keyring del sistema**: las cookies nunca se guardan en claro, ni siquiera en la base de datos.
- **Validación de sesión** continua (reintenta y detecta expiración), con múltiples cuentas a la vez.

### Perfiles
- Búsqueda por username mediante un **motor CDP** (Instagram bloquea los clientes HTTP externos; la app navega con un Chrome propio).
- Datos completos: nombre, bio, seguidores, seguidos, privacidad, foto de perfil en HD (descargada y guardada localmente).
- **Favoritos** y estadísticas por perfil y por tipo de contenido.

### Contenido
- **Posts**: feed con paginación, carruseles (item por item) y videos.
- **Stories** activas.
- **Highlights**: lectura del DOM del perfil + API de reels (los endpoints públicos de highlights están caídos; la app los extrae del navegador).
- **Auto-sync**: al abrir un perfil recién buscado, la app trae posts, stories y highlights automáticamente (solo metadatos).

### Descargas
- **Máxima calidad disponible**: al descargar, la app consulta `media/{id}/info/` y toma el mejor candidato — para stories/highlights es la **resolución original sin límite de píxeles** — y con firma de CDN fresca (adiós 403 por URL expirada).
- **Download manager**: concurrencia configurable, progreso por ítem, reintentos con backoff y panel de jobs.
- **Deduplicación por `media_id`**: nunca re-baja lo que ya está en disco.
- **Re-descargar** cualquier ítem (borra el archivo y lo baja de nuevo) y **vaciar el álbum** por perfil.
- **Álbum por perfil**: grilla de lo descargado con lightbox. Los bytes permanecen dentro de SQLite y **“Guardar en dispositivo”** exporta una copia al destino que elijas.
- **Actualizaciones automáticas firmadas** desde GitHub Releases, con comprobación al iniciar y desde “Acerca de”.

### Biblioteca local
- SQLite (modo WAL): perfiles, medios, highlights, jobs y estado de cada descarga, con reintentos de fallidos.
- Interfaz en español con Tailwind CSS 4, shadcn/ui, Motion, Lucide, Sonner y tema oscuro accesible.

---

## 🚀 Instalación

### Requisitos
- [Rust](https://rustup.rs) (toolchain estable)
- [Node.js](https://nodejs.org) 18+ (probado con 24)
- Windows, macOS o Linux (desarrollado y probado en Windows)

```bash
# Clonar
git clone https://github.com/Xainner/instavault.git
cd instavault

# Dependencias
npm install

# Desarrollo (hot-reload)
npm run tauri dev

# Build de producción (instalador NSIS en Windows x64)
npm run tauri build
```

> El binario final queda en `src-tauri/target/release/instavault.exe` y los bundles en `src-tauri/target/release/bundle/`.

### Primeros pasos
1. **Cuentas** → agregá tu sesión (pegando cookies o importando desde tu navegador; también hay login asistido con el navegador de la app).
2. **Perfiles** → buscá un username. El primer sync es automático; desde el detalle podés sincronizar por tipo (posts / stories / highlights).
3. **Descargar pendientes** → fotos, videos y avatares se guardan dentro de `%APPDATA%/com.xainner.instavault/instakeeper.db`.
4. **Álbum** → mira lo descargado, expórtalo con “Guardar en dispositivo” o vuelve a descargarlo en máxima calidad.

---

## 🏗️ Arquitectura

```
src-tauri/
├── src/
│   ├── lib.rs               # Arranque, plugins (dialog/opener) y registro de comandos
│   ├── commands.rs          # Comandos IPC expuestos al frontend
│   ├── creds.rs             # Cookies cifradas en el keyring del sistema
│   ├── db.rs                # Capa SQLite: esquema, CRUD, jobs y stats (con tests)
│   └── instagram/
│       ├── client.rs        # Cliente HTTP mobile (UA, headers, sesión)
│       ├── api.rs           # Endpoints privados: feed, reels, media/info
│       ├── models.rs        # DTOs de la API + modelos de BD
│       ├── cdp_login.rs     # Motor CDP: Chrome propio, login asistido, navegación,
│       │                    #   fetch vía página y extracción de highlights del DOM
│       ├── browser.rs       # Detección y lectura de perfiles/cookies de navegadores
│       └── download.rs      # Pipeline: concurrencia, reintentos, dedup, progreso
src/
├── App.tsx                  # Shell: vistas, stats, backfill de avatars
├── components/
│   ├── Sidebar.tsx          # Navegación, logo y badge de descargas activas
│   ├── AccountsView.tsx     # Cuentas: agregar/validar/importar/login asistido
│   ├── ProfilesView.tsx     # Biblioteca de perfiles, búsqueda y favoritos
│   ├── MediaDetail.tsx      # Explorador: pestañas, grilla, lightbox, álbum
│   ├── Downloads.tsx        # Download manager (jobs, progreso, provider global)
│   ├── Toasts.tsx           # Notificaciones no intrusivas
│   └── Modal.tsx            # Diálogos de confirmación
├── lib/api.ts               # Wrapper tipado del IPC (invoke)
└── types.ts                 # Tipos compartidos frontend ↔ backend
```

### Notas de ingeniería
- **CDP (Chrome DevTools Protocol)**: la app levanta un Chrome headless con perfil propio. Instagram bloquea (429) a los clientes HTTP externos para varias rutas, así que búsqueda de perfiles, validación de sesión y highlights pasan por el navegador: `Page.navigate` + `Runtime.evaluate` con timeouts estrictos.
- **Calidad de imagen**: los candidatos mobile traen `stp=…e35…` (re-encode CDN) y, para stories, límite de píxeles. La firma `oh/oe` cubre el query completo (no se puede editar el `stp`), por eso la calidad máxima se obtiene consultando `media/{id}/info/` en cada descarga: devuelve candidatos frescos y, para stories/highlights, el tamaño original.
- **Avatares**: el CDN de fotos de perfil tiene issues DNS (AAAA blackhole) en algunos entornos; la descarga de avatar fuerza IPv4 y el resultado se sirve vía asset protocol de Tauri.
- **Datos**: `%APPDATA%/com.xainner.instavault/instakeeper.db` (SQLite WAL). No se crean archivos de medios independientes salvo al exportarlos.

---

## 🗺️ Roadmap

- [x] Cuentas por cookies, importación de navegador y login asistido
- [x] Perfiles con búsqueda CDP, favoritos y stats
- [x] Posts (carruseles/videos), stories y highlights
- [x] Persistencia SQLite con deduplicación y reintentos
- [x] Download manager con progreso y jobs
- [x] Calidad máxima (original en stories/highlights) + firmas frescas
- [x] Álbum por perfil, re-descarga y “Guardar en este equipo”
- [ ] Rotación entre cuentas para evitar rate-limit
- [ ] Exportación/búsqueda avanzada de la biblioteca local
- [ ] Publicaciones guardadas y etiquetadas

## ⚖️ Aviso legal

InstaVault se desarrolla con fines **personales y educativos** para archivar contenido al que ya tenés acceso. La descarga automatizada puede violar los [Términos de uso de Instagram](https://help.instagram.com/581066165581870) y los derechos de propiedad intelectual de los creadores. Usá esta herramienta bajo tu propia responsabilidad, preferentemente con tu propia cuenta y respetando a los autores.

## 📄 Licencia

[MIT](LICENSE)

---

<p align="center">
  Hecho con <a href="https://www.rust-lang.org">Rust</a> y <a href="https://tauri.app">Tauri</a>.
</p>
