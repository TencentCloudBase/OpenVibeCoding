import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { Connector } from '@/lib/session/types'

const LOCAL_STORAGE_KEY = 'vibe-connectors'

interface ConnectorsContextType {
  connectors: Connector[]
  refreshConnectors: () => Promise<void>
  addConnector: (connector: Connector) => void
  updateConnector: (id: string, data: Partial<Connector>) => void
  deleteConnector: (id: string) => void
  clearConnectors: () => void
  isLoading: boolean
}

const ConnectorsContext = createContext<ConnectorsContextType>({
  connectors: [],
  refreshConnectors: async () => {},
  addConnector: () => {},
  updateConnector: () => {},
  deleteConnector: () => {},
  clearConnectors: () => {},
  isLoading: false,
})

function loadConnectorsFromStorage(): Connector[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Connector[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveConnectorsToStorage(connectors: Connector[]) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(connectors))
}

export function ConnectorsProvider({ children }: { children: React.ReactNode }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refreshConnectors = useCallback(async () => {
    setIsLoading(true)
    const data = loadConnectorsFromStorage()
    setConnectors(data)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    refreshConnectors()
  }, [refreshConnectors])

  const addConnector = useCallback((connector: Connector) => {
    setConnectors((prev) => {
      const next = [...prev, connector]
      saveConnectorsToStorage(next)
      return next
    })
  }, [])

  const updateConnector = useCallback((id: string, data: Partial<Connector>) => {
    setConnectors((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, ...data, updatedAt: Date.now() } : c))
      saveConnectorsToStorage(next)
      return next
    })
  }, [])

  const deleteConnector = useCallback((id: string) => {
    setConnectors((prev) => {
      const next = prev.filter((c) => c.id !== id)
      saveConnectorsToStorage(next)
      return next
    })
  }, [])

  const clearConnectors = useCallback(() => {
    localStorage.removeItem(LOCAL_STORAGE_KEY)
    setConnectors([])
  }, [])

  return (
    <ConnectorsContext.Provider
      value={{
        connectors,
        refreshConnectors,
        addConnector,
        updateConnector,
        deleteConnector,
        clearConnectors,
        isLoading,
      }}
    >
      {children}
    </ConnectorsContext.Provider>
  )
}

export function useConnectors() {
  return useContext(ConnectorsContext)
}
