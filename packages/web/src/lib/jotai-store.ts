import { createStore } from 'jotai'

/** Shared with <JotaiProvider store={appJotaiStore}> — do not use getDefaultStore() in app code. */
export const appJotaiStore = createStore()
