import { useEffect, useState, useRef, useCallback } from 'react'
import { BROADCAST_CHANNEL_NAME, type SyncMessage } from '../lib/storage'

interface CrossTabState {
  tabId: string
  activeTabs: number
  lastSync: Date | null
  isLeader: boolean
}

interface UseCrossTabSyncOptions {
  onMessage?: (message: SyncMessage) => void
}

/**
 * Hook for cross-tab synchronization and leader election
 *
 * Uses BroadcastChannel to:
 * - Track active tabs
 * - Elect a leader tab for server sync
 * - Broadcast custom messages
 */
export function useCrossTabSync(options: UseCrossTabSyncOptions = {}) {
  const [state, setState] = useState<CrossTabState>({
    tabId: '',
    activeTabs: 1,
    lastSync: null,
    isLeader: false,
  })

  const channelRef = useRef<BroadcastChannel | null>(null)
  const tabIdRef = useRef<string>('')
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tabsRef = useRef<Set<string>>(new Set())

  // Initialize
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return

    // Generate unique tab ID
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    tabIdRef.current = tabId
    tabsRef.current.add(tabId)

    setState((s) => ({ ...s, tabId }))

    // Create broadcast channel
    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    channelRef.current = channel

    // Message handler
    channel.onmessage = (event) => {
      const message = event.data as SyncMessage | TabMessage

      if (isTabMessage(message)) {
        handleTabMessage(message)
      } else {
        options.onMessage?.(message)
      }
    }

    // Announce presence
    broadcast({ type: 'TAB_ANNOUNCE', tabId, timestamp: Date.now() })

    // Heartbeat to detect stale tabs
    heartbeatRef.current = setInterval(() => {
      broadcast({ type: 'TAB_HEARTBEAT', tabId, timestamp: Date.now() })
    }, 5000)

    // Request all tabs to announce
    broadcast({ type: 'TAB_REQUEST_ANNOUNCE', tabId, timestamp: Date.now() })

    // Handle tab close
    const handleUnload = () => {
      broadcast({ type: 'TAB_CLOSE', tabId, timestamp: Date.now() })
    }
    window.addEventListener('beforeunload', handleUnload)

    return () => {
      window.removeEventListener('beforeunload', handleUnload)
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
      }
      handleUnload()
      channel.close()
    }
  }, [])

  // Tab message types
  type TabMessageType = 'TAB_ANNOUNCE' | 'TAB_HEARTBEAT' | 'TAB_CLOSE' | 'TAB_REQUEST_ANNOUNCE'

  interface TabMessage {
    type: TabMessageType
    tabId: string
    timestamp: number
  }

  function isTabMessage(message: unknown): message is TabMessage {
    return (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      typeof (message as TabMessage).type === 'string' &&
      (message as TabMessage).type.startsWith('TAB_')
    )
  }

  function handleTabMessage(message: TabMessage) {
    const { type, tabId } = message

    switch (type) {
      case 'TAB_ANNOUNCE':
      case 'TAB_HEARTBEAT':
        tabsRef.current.add(tabId)
        updateTabState()
        break

      case 'TAB_CLOSE':
        tabsRef.current.delete(tabId)
        updateTabState()
        break

      case 'TAB_REQUEST_ANNOUNCE':
        // Another tab wants to know who's here
        if (tabIdRef.current) {
          broadcast({
            type: 'TAB_ANNOUNCE',
            tabId: tabIdRef.current,
            timestamp: Date.now(),
          })
        }
        break
    }
  }

  function updateTabState() {
    const activeTabs = tabsRef.current.size

    // Simple leader election: lowest tabId is leader
    const sortedTabs = Array.from(tabsRef.current).sort()
    const isLeader = sortedTabs[0] === tabIdRef.current

    setState((s) => ({
      ...s,
      activeTabs,
      isLeader,
    }))
  }

  function broadcast(message: TabMessage | SyncMessage) {
    channelRef.current?.postMessage(message)
  }

  // Public broadcast method
  const broadcastMessage = useCallback((message: SyncMessage) => {
    channelRef.current?.postMessage(message)
  }, [])

  // Update last sync time
  const setLastSync = useCallback((date: Date) => {
    setState((s) => ({ ...s, lastSync: date }))
  }, [])

  return {
    ...state,
    broadcastMessage,
    setLastSync,
  }
}
