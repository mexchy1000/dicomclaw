import { useState, useEffect, useCallback } from "react";
import type { AppSettings } from "../types";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({
    openrouterApiKey: "",
    openrouterModel: "",
    visionModel: "",
    chatModel: "",
  });
  const [loading, setLoading] = useState(false);

  const fetchSettings = useCallback(() => {
    setLoading(true);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: AppSettings) => setSettings(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });
    if (res.ok) {
      // Merge partial into current state (PATCH returns { ok: true }, not full settings)
      setSettings((prev) => ({ ...prev, ...partial }));
    }
  }, []);

  return { settings, loading, updateSettings, refreshSettings: fetchSettings };
}
