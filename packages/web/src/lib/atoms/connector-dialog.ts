import { atom } from 'jotai'
import type { Connector } from '@/lib/session/types'

export type DialogView = 'list' | 'presets' | 'form'

export type PresetConfig = {
  name: string
  type: 'HTTP' | 'SSE' | 'STDIO'
  command?: string
  args?: string[]
  url?: string
  envKeys?: string[]
}

// Dialog state atoms
export const connectorDialogOpenAtom = atom(false)
export const connectorDialogViewAtom = atom<DialogView>('list')
export const editingConnectorAtom = atom<Connector | null>(null)
export const selectedPresetAtom = atom<PresetConfig | null>(null)
export const serverTypeAtom = atom<'HTTP' | 'SSE' | 'STDIO'>('HTTP')
export const envVarsAtom = atom<Array<{ key: string; value: string }>>([])
export const visibleEnvVarsAtom = atom<Set<number>>(new Set<number>())
export const customHeadersAtom = atom<Array<{ key: string; value: string }>>([])
export const visibleCustomHeadersAtom = atom<Set<number>>(new Set<number>())

// Derived atoms
export const isEditingAtom = atom((get) => !!get(editingConnectorAtom))

// Action atoms
export const resetDialogStateAtom = atom(null, (get, set) => {
  set(connectorDialogViewAtom, 'list')
  set(editingConnectorAtom, null)
  set(selectedPresetAtom, null)
  set(serverTypeAtom, 'HTTP')
  set(envVarsAtom, [])
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())
})

export const setEditingConnectorActionAtom = atom(null, (get, set, connector: Connector) => {
  set(editingConnectorAtom, connector)
  set(serverTypeAtom, connector.type)

  // Set env vars if they exist
  if (connector.env) {
    const envArray = Object.entries(connector.env).map(([key, value]) => ({ key, value: String(value) }))
    set(envVarsAtom, envArray)
  } else {
    set(envVarsAtom, [])
  }
  set(visibleEnvVarsAtom, new Set<number>())

  // Set custom headers if they exist
  if (connector.headers) {
    const headersArray = Object.entries(connector.headers).map(([key, value]) => ({ key, value: String(value) }))
    set(customHeadersAtom, headersArray)
  } else {
    set(customHeadersAtom, [])
  }
  set(visibleCustomHeadersAtom, new Set<number>())

  set(selectedPresetAtom, null)
  set(connectorDialogViewAtom, 'form')
})

export const startAddingConnectorAtom = atom(null, (get, set) => {
  set(editingConnectorAtom, null)
  set(selectedPresetAtom, null)
  set(serverTypeAtom, 'HTTP')
  set(envVarsAtom, [])
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())
  set(connectorDialogViewAtom, 'presets')
})

export const selectPresetActionAtom = atom(null, (get, set, preset: PresetConfig) => {
  set(selectedPresetAtom, preset)
  set(serverTypeAtom, preset.type)

  // Set env vars based on preset's envKeys
  if (preset.envKeys && preset.envKeys.length > 0) {
    set(
      envVarsAtom,
      preset.envKeys.map((key) => ({ key, value: '' })),
    )
  } else {
    set(envVarsAtom, [])
  }
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())

  // Switch to form view
  set(connectorDialogViewAtom, 'form')
})

export const addCustomServerAtom = atom(null, (get, set) => {
  set(selectedPresetAtom, null)
  set(serverTypeAtom, 'HTTP')
  set(envVarsAtom, [])
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())
  set(connectorDialogViewAtom, 'form')
})

export const goBackFromFormAtom = atom(null, (get, set) => {
  const isEditing = get(isEditingAtom)

  if (isEditing) {
    // Go back to list view when editing
    set(connectorDialogViewAtom, 'list')
    set(editingConnectorAtom, null)
    set(selectedPresetAtom, null)
    set(serverTypeAtom, 'HTTP')
    set(envVarsAtom, [])
    set(visibleEnvVarsAtom, new Set<number>())
    set(customHeadersAtom, [])
    set(visibleCustomHeadersAtom, new Set<number>())
  } else {
    // Go back to presets view when adding
    set(selectedPresetAtom, null)
    set(serverTypeAtom, 'HTTP')
    set(envVarsAtom, [])
    set(visibleEnvVarsAtom, new Set<number>())
    set(customHeadersAtom, [])
    set(visibleCustomHeadersAtom, new Set<number>())
    set(connectorDialogViewAtom, 'presets')
  }
})

export const goBackFromPresetsAtom = atom(null, (get, set) => {
  set(connectorDialogViewAtom, 'list')
})

export const onSuccessActionAtom = atom(null, (get, set) => {
  // Go back to list view on success
  set(connectorDialogViewAtom, 'list')
  set(editingConnectorAtom, null)
  set(selectedPresetAtom, null)
  set(serverTypeAtom, 'HTTP')
  set(envVarsAtom, [])
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())
})

export const clearPresetActionAtom = atom(null, (get, set) => {
  set(selectedPresetAtom, null)
  set(envVarsAtom, [])
  set(visibleEnvVarsAtom, new Set<number>())
  set(customHeadersAtom, [])
  set(visibleCustomHeadersAtom, new Set<number>())
  set(serverTypeAtom, 'HTTP')
})
