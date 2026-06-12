import { atom } from 'jotai'
import type { Task } from '@coder/shared'

/** Single source of truth for sidebar + /tasks list (Jotai store, not React context). */
export const taskListAtom = atom<Task[]>([])
export const taskListLoadingAtom = atom(false)
