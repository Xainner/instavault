import { type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

export function Modal({ open, onClose, title, icon, children, width = 460 }: {
  open: boolean; onClose: () => void; title: string; icon?: ReactNode; children: ReactNode; width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild aria-describedby={undefined}>
              <motion.div
                className="modal"
                style={{ width, maxWidth: "calc(100vw - 32px)" }}
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 320, damping: 28 }}
              >
                <div className="modal-head">
                  <Dialog.Title className="modal-title">{icon}{title}</Dialog.Title>
                  <Dialog.Close asChild><button className="icon-btn" aria-label="Cerrar"><X size={16} /></button></Dialog.Close>
                </div>
                <div className="modal-body">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
