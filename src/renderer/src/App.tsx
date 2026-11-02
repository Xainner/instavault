import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Toaster } from "sonner";
import { AccessPrompt } from "./shell/AccessPrompt";
import { CommandPalette } from "./shell/CommandPalette";
import { DownloadsDrawer } from "./shell/DownloadsDrawer";
import { Rail } from "./shell/Rail";
import { TitleBar } from "./shell/TitleBar";
import { StoreProvider, useStore } from "./store";
import { AccountsView } from "./views/AccountsView";
import { LibraryView } from "./views/LibraryView";
import { Onboarding } from "./views/Onboarding";
import { ProfileView } from "./views/ProfileView";
import { QuickView } from "./views/QuickView";
import { SettingsView } from "./views/SettingsView";

function Routes() {
  const { route } = useStore();
  const key = route.name === "profile" ? `profile-${route.id}` : route.name === "quick" ? `quick-${route.url ?? ""}` : route.name;
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={key}
        className="absolute inset-0"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {route.name === "library" && <LibraryView />}
        {route.name === "profile" && <ProfileView profileId={route.id} />}
        {route.name === "quick" && <QuickView initialUrl={route.url} />}
        {route.name === "accounts" && <AccountsView />}
        {route.name === "settings" && <SettingsView />}
      </motion.div>
    </AnimatePresence>
  );
}

function Shell() {
  const { settings } = useStore();
  return (
    <MotionConfig reducedMotion={settings?.reduceMotion ? "always" : "user"}>
      <div className="app-backdrop" />
      <div className="shell">
        <TitleBar />
        <Rail />
        <main className="main">
          <Routes />
        </main>
      </div>
      <DownloadsDrawer />
      <CommandPalette />
      <AccessPrompt />
      <AnimatePresence>{settings && !settings.onboardingDone && <Onboarding />}</AnimatePresence>
      <Toaster position="bottom-right" theme="dark" closeButton duration={4800} offset={20} />
    </MotionConfig>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
