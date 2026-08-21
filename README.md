<p align="center">
  <img src="logo.png" alt="InstaVault" width="180" />
</p>

<h1 align="center">InstaVault</h1>

<p align="center">
  <strong>Descargador de perfiles de Instagram</strong> — fotos de perfil, publicaciones, stories y highlights, guardados en base de datos local.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-24C8D8?logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-1.95-dea584?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/licencia-MIT-blue" alt="Licencia">
</p>

---

## Descripción

InstaVault es una aplicación de escritorio que permite **archivar contenido de perfiles de Instagram** de forma local. Gestiona múltiples cuentas mediante cookies (necesarias para perfiles privados y stories), descarga los medios en máxima calidad y los organiza automáticamente, manteniendo un registro en SQLite con deduplicación por ID de contenido.

## Características

- **Gestión de cuentas por cookies**: agrega tu sesión (sessionid, csrftoken, ds_user_id) pegada desde el navegador; se valida y se guarda cifrada en el llavero del sistema (keyring), nunca en claro.
- **Perfiles**: resolución por username, foto de perfil en HD, datos (bio, seguidores, seguidos, privacidad).
- **Contenido descargable**:
  - Publicaciones del feed (incluye carruseles y videos, con paginación).
  - Stories activas.
  - Highlights.
- **Persistencia en SQLite**: perfiles, medios, highlights y estado de cada descarga.
- **Descarga robusta**: mejor resolución disponible, reintentos con backoff, descarga concurrente y **deduplicación por media_id** (no vuelve a bajar lo ya guardado).
- **Interfaz en español** con tema oscuro: dashboard de cuentas, biblioteca de perfiles y explorador de medios.

## Stack

| Componente | Tecnología |
|---|---|
| Shell de escritorio | [Tauri 2](https://tauri.app) |
| Backend (scraping, BD, descargas) | Rust (`reqwest`, `rusqlite`, `keyring`, `tokio`) |
| Frontend | React + TypeScript + Vite |
| Base de datos | SQLite |
| Almacenamiento de credenciales | Keyring del sistema operativo |

## Requisitos

- [Rust](https://rustup.rs) (toolchain estable)
- [Node.js](https://nodejs.org) 18+
- Windows / macOS / Linux (probado en Windows)

## Instalación y uso

```bash
# Instalar dependencias del frontend
npm install

# Aprobar el postinstall de esbuild (npm 12)
npm install-scripts approve esbuild

# Ejecutar en modo desarrollo
npm run tauri dev

# Compilar instalador
npm run tauri build
```

### Primeros pasos

1. Abre la pestaña **Cuentas** y agrega la tuya pegando las cookies de una sesión iniciada en Instagram (`sessionid`, `csrftoken`, `ds_user_id`).
2. Ve a la pestaña **Perfiles**, busca un username y guárdalo.
3. En la tarjeta del perfil, usa **⟳** para sincronizar (posts, stories o highlights) y **⬇** para descargarlos.
4. Explora el contenido descargado en la vista de detalle.

## Arquitectura

```
src-tauri/
├── src/
│   ├── lib.rs             # Arranque, estado global y registro de comandos
│   ├── commands.rs        # Comandos IPC (tauri::command) expuestos al frontend
│   ├── creds.rs           # Guardado/lectura de cookies en el keyring
│   ├── db.rs              # Capa SQLite (esquema + CRUD, con tests)
│   └── instagram/
│       ├── client.rs      # Cliente HTTP con headers y sesión
│       ├── api.rs         # Endpoints de la API privada de Instagram
│       ├── models.rs      # Estructuras de deserialización y modelos de BD
│       └── download.rs    # Pipeline de descarga con dedup y reintentos
src/
├── App.tsx                # UI principal (React)
├── lib/api.ts             # Wrapper tipado del IPC
└── types.ts               # Tipos compartidos
```

## Aviso legal

InstaVault se desarrolla con fines **personales y educativos** de archivo de contenido al que ya tienes acceso. La descarga automatizada de contenido puede violar los [Términos de uso de Instagram](https://help.instagram.com/581066165581870) y la propiedad intelectual de los creadores. Usa esta herramienta bajo tu propia responsabilidad, solo con cuentas propias y respetando los derechos de autor.

## Roadmap

- [x] Cuentas por cookies y validación de sesión
- [x] Perfiles y foto de perfil en HD
- [x] Posts (con carruseles/videos), stories y highlights
- [x] Persistencia SQLite con deduplicación
- [x] Descarga en máxima calidad con reintentos
- [ ] Rotación entre cuentas para evitar rate-limit
- [ ] Descarga de publicaciones guardadas y etiquetadas
- [ ] Exportación/búsqueda de la biblioteca local

## Licencia

[MIT](LICENSE)

---

Hecho con Rust y Tauri.
