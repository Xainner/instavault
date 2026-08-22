import { createContext, useContext, type ReactNode } from "react";
import { Toaster, toast as sonner } from "sonner";

export type ToastType = "success" | "error" | "info" | "warning";
const ToastCtx = createContext<{ toast: (type: ToastType, title: string, desc?: string) => void }>({ toast: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = (type: ToastType, title: string, desc?: string) => {
    const options = { description: desc, duration: 4600 };
    if (type === "warning") sonner.warning(title, options);
    else sonner[type](title, options);
  };
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <Toaster theme="dark" richColors closeButton position="bottom-right" toastOptions={{
        style: { background: "#151923", border: "1px solid rgba(255,255,255,.12)", color: "#f2f4f8" },
      }} />
    </ToastCtx.Provider>
  );
}
