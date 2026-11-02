import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { Archive, Download, KeyRound, Link2, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { call } from "../lib/api";
import { useStore } from "../store";
import { Avatar } from "../ui/primitives";

const looksLikeUrl = (q: string) => /instagram\.com\/|instagr\.am\//i.test(q);
const looksLikeUser = (q: string) => /^@?[a-z0-9._]{2,30}$/i.test(q.trim());

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, profiles, navigate, setDownloadsOpen, remote } = useStore();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) setQuery("");
  }, [paletteOpen]);

  const close = () => setPaletteOpen(false);
  const go = (fn: () => void) => {
    close();
    fn();
  };
  const username = query.trim().replace(/^@/, "").toLowerCase();
  const exists = profiles.some((p) => p.username === username);

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <AnimatePresence>
        {paletteOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.div
                className="panel fixed left-1/2 top-[14vh] z-[71] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden"
                initial={{ opacity: 0, y: -10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.16 }}
              >
                <Dialog.Title className="sr-only">Paleta de comandos</Dialog.Title>
                <Command loop label="Paleta de comandos">
                  <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Busca un perfil, pega un enlace o escribe una acción…" />
                  <Command.List>
                    <Command.Empty>Nada por aquí. Prueba con un @usuario o un enlace.</Command.Empty>
                    {looksLikeUrl(query) && (
                      <Command.Group heading="Enlace">
                        <Command.Item value={`url ${query}`} onSelect={() => go(() => navigate({ name: "quick", url: query.trim() }))}>
                          <Link2 size={16} /> Descargar este enlace
                        </Command.Item>
                      </Command.Group>
                    )}
                    {!looksLikeUrl(query) && looksLikeUser(query) && !exists && (
                      <Command.Group heading="Instagram">
                        <Command.Item
                          value={`buscar ${username}`}
                          onSelect={() =>
                            go(async () => {
                              const profile = await remote((access, accountId) => call("ig:lookup", { username, access, accountId }));
                              if (profile) {
                                toast.success(`@${profile.username} añadido a tu archivo`);
                                navigate({ name: "profile", id: profile.id });
                              }
                            })
                          }
                        >
                          <Search size={16} /> Buscar @{username} en Instagram
                        </Command.Item>
                      </Command.Group>
                    )}
                    {profiles.length > 0 && (
                      <Command.Group heading="Tu archivo">
                        {profiles.map((p) => (
                          <Command.Item
                            key={p.id}
                            value={`${p.username} ${p.fullName ?? ""}`}
                            onSelect={() => go(() => navigate({ name: "profile", id: p.id }))}
                          >
                            <Avatar src={p.avatarUrl} name={p.username} size={24} />
                            <span className="text-paper">{p.fullName ?? p.username}</span>
                            <span className="mono text-[11px] text-paper-4">@{p.username}</span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    )}
                    <Command.Group heading="Ir a">
                      <Command.Item value="archivo biblioteca" onSelect={() => go(() => navigate({ name: "library" }))}>
                        <Archive size={16} /> Archivo
                      </Command.Item>
                      <Command.Item value="enlace pegar url" onSelect={() => go(() => navigate({ name: "quick" }))}>
                        <Link2 size={16} /> Descargar por enlace
                      </Command.Item>
                      <Command.Item value="revelando descargas" onSelect={() => go(() => setDownloadsOpen(true))}>
                        <Download size={16} /> Revelando (descargas)
                      </Command.Item>
                      <Command.Item value="cuentas sesión" onSelect={() => go(() => navigate({ name: "accounts" }))}>
                        <KeyRound size={16} /> Cuentas
                      </Command.Item>
                      <Command.Item value="ajustes preferencias" onSelect={() => go(() => navigate({ name: "settings" }))}>
                        <SlidersHorizontal size={16} /> Ajustes
                      </Command.Item>
                    </Command.Group>
                  </Command.List>
                </Command>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
