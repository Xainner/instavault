import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";

export type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: number;
  type: ToastType;
  title: string;
  desc?: string;
}

const ToastCtx = createContext<{
  toast: (type: ToastType, title: string, desc?: string) => void;
}>({ toast: () => {} });

export const useToast = () => useContext(ToastCtx);

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={19} color="var(--ok)" />,
  error: <XCircle size={19} color="var(--err)" />,
  warning: <AlertTriangle size={19} color="var(--warn)" />,
  info: <Info size={19} color="#5aa9f6" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: ToastType, title: string, desc?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, type, title, desc }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toasts">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 60, scale: 0.92 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, scale: 0.92 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="toast"
            >
              <div className="toast-icon">{ICONS[t.type]}</div>
              <div className="toast-body">
                <div className="toast-title">{t.title}</div>
                {t.desc && <div className="toast-desc">{t.desc}</div>}
              </div>
              <button
                className="toast-close"
                onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}