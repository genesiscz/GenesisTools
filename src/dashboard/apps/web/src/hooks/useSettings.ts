import { useState, useEffect, useCallback } from 'react'

export interface AppSettings {
  // Appearance
  theme: 'dark' | 'light' | 'system'
  scanLinesEffect: boolean
  gridBackground: boolean
  reducedMotion: boolean
  // Notifications
  pushNotifications: boolean
  soundEffects: boolean
  timerCompleteAlert: boolean
  // Data
  cloudSync: boolean
  localStorage: boolean
  analytics: boolean
  // Language
  language: string
  timeFormat: '12h' | '24h'
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  scanLinesEffect: true,
  gridBackground: true,
  reducedMotion: false,
  pushNotifications: true,
  soundEffects: true,
  timerCompleteAlert: true,
  cloudSync: true,
  localStorage: true,
  analytics: false,
  language: 'en',
  timeFormat: '24h',
}

const STORAGE_KEY = 'nexus-settings'

function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return DEFAULT_SETTINGS
}

function saveSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

// Singleton state for cross-component sync
let globalSettings = loadSettings()
const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach((listener) => listener())
}

/**
 * Hook for accessing and updating app settings
 */
export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>(globalSettings)

  useEffect(() => {
    const listener = () => setSettingsState({ ...globalSettings })
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const updateSetting = useCallback(<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    globalSettings = { ...globalSettings, [key]: value }
    saveSettings(globalSettings)
    notifyListeners()
  }, [])

  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    globalSettings = { ...globalSettings, ...updates }
    saveSettings(globalSettings)
    notifyListeners()
  }, [])

  return {
    settings,
    updateSetting,
    updateSettings,
  }
}
