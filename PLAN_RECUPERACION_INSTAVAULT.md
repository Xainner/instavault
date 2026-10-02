# Recuperación integral de InstaVault v1.0.3

## Diagnóstico confirmado

- La release pública es `v1.0.1`; la instalación local y el trabajo sin publicar están en `1.0.2`.
- Los tests simulados pasan, pero las pruebas reales fallan porque Instagram rechaza los endpoints internos utilizados tanto en modo público como privado.
- La biblioteca SQLite está íntegra y debe preservarse. El fallo está en la adquisición remota, no en los BLOB ni en la exportación.
- La API oficial de Meta sólo cubre cuentas profesionales autorizadas. El acceso a perfiles personales o privados se mantendrá como compatibilidad web no oficial, explícita y limitada.

## Implementación acordada

1. Respaldar y verificar SQLite/WAL antes de instalar, conservar el trabajo local y no modificar GitHub durante el desarrollo.
2. Separar físicamente los transportes:
   - Público: navegador temporal, anónimo, sin acceso al llavero ni a cookies privadas y sin fallback autenticado.
   - Privado: navegador visible con perfil dedicado, iniciado sólo por una acción explícita.
3. Eliminar la importación de cookies del navegador cotidiano, el cierre automático de navegadores y los probes que leen credenciales reales.
4. No realizar tráfico a Instagram al iniciar, abrir la biblioteca o escribir en búsqueda. La consulta remota se ejecuta sólo con Enter o el botón Buscar.
5. Permitir una sola operación remota, cancelable y con estados visibles. Detener inmediatamente ante `401`, `403`, `429`, challenge, checkpoint o `feedback_required`.
6. Resolver perfiles locales desde SQLite primero. Si una consulta anónima no puede determinar privacidad, ofrecer una segunda acción explícita para intentarlo como privado.
7. Seleccionar fotos por resolución y tamaño; videos por resolución, bitrate y tamaño. Refrescar una vez mediante el mismo modo de acceso y marcar como no verificada cualquier descarga que use un candidato anterior.
8. Mantener bytes sólo en `media_content` y `profile_avatar_content`. Únicamente “Guardar en dispositivo” crea una copia externa verificada por SHA-256.
9. Sustituir `local_path` y `avatar_local_path` en los DTO por `has_content`, `content_url`, tamaño, dimensiones, bitrate y `quality_verified`. Mantener columnas legacy sólo para migración idempotente.
10. Completar HTTP Range, incluidos rangos abiertos, sufijos y respuesta `416`.
11. Mostrar claramente “Público · sin sesión” y “Privado · sesión explícita”; usar errores tipados y estados de progreso/cancelación.
12. Completar la UI con Tailwind CSS 4, primitives shadcn, Motion con movimiento reducido, Lucide, Sonner, React Hook Form y cmdk. No instalar tablas, gráficas, paneles ni drag-and-drop sin una función que los necesite.
13. Unificar `1.0.3`, construir NSIS/updater firmado, instalar sobre `1.0.2` y verificar la biblioteca antes y después.
14. Sólo tras la aceptación local, auditar privacidad, confirmar código y publicar `v1.0.3` con `latest.json` válido.

## Interfaces objetivo

- `lookup_public_profile(username)`
- `add_private_profile(username, accountId)`
- `sync_profile(profileId, kind, accountId?)`
- `cancel_sync(operationId)`
- `connect_private_account()` / `disconnect_private_account(accountId)`
- Modos internos `PublicAnonymous` y `PrivateExplicit`.
- Errores: `public_blocked`, `private_login_required`, `challenge_required`, `rate_limited`, `not_found`, `network`, `cancelled` y `provider_changed`.

## Aceptación

- Una ruta pública falla si consulta el llavero, lee cookies, comparte perfil de navegador o activa un fallback privado.
- Iniciar la app, abrir la biblioteca y escribir no contactan Instagram.
- Las pruebas privadas automatizadas nunca usan la cuenta real; el smoke privado es único, manual y explícito.
- Se validan fixtures de perfil, foto, video, carrusel, stories, highlights y paginación; calidad, hash, BLOB, Range, exportación, redescarga, borrado y migración interrumpida.
- Deben pasar build frontend, pruebas de aislamiento, `cargo test`, auditoría de privacidad y NSIS limpio.
- La actualización local a `1.0.3` conserva integridad, conteos y contenido antes de cualquier publicación.

## Límites

- Los perfiles arbitrarios dependen de la web no oficial de Instagram y pueden dejar de estar disponibles.
- Si Instagram exige login para contenido público, InstaVault informará `public_blocked`; nunca utilizará cookies privadas para evitarlo.
- No habrá sincronización automática, periódica ni en segundo plano.
- Windows x64 con instalador NSIS es el único destino soportado para esta release.
