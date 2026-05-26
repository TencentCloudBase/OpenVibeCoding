import type { Task } from '@coder/shared'
import { taskListAtom, taskListLoadingAtom } from '@/lib/atoms/task-list'
import { appJotaiStore } from '@/lib/jotai-store'
import { fetchActiveTasks } from '@/lib/task-list-api'

let fetchGeneration = 0
let loadAbort: AbortController | null = null

function commitTasks(gen: number, tasks: Task[]): void {
  if (gen !== fetchGeneration) return
  appJotaiStore.set(taskListAtom, tasks)
}

/** Instant empty sidebar — safe to call synchronously on delete-all confirm. */
export function clearTaskListNow(): void {
  fetchGeneration += 1
  loadAbort?.abort()
  loadAbort = null
  appJotaiStore.set(taskListAtom, [])
  appJotaiStore.set(taskListLoadingAtom, false)
}

export async function loadTaskList(): Promise<void> {
  const gen = ++fetchGeneration
  loadAbort?.abort()
  const controller = new AbortController()
  loadAbort = controller

  const showSkeleton = appJotaiStore.get(taskListAtom).length === 0
  if (showSkeleton) {
    appJotaiStore.set(taskListLoadingAtom, true)
  }

  try {
    const tasks = await fetchActiveTasks(controller.signal)
    if (controller.signal.aborted) return
    commitTasks(gen, tasks)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    console.error('Error loading task list:', error)
  } finally {
    if (!controller.signal.aborted && gen === fetchGeneration) {
      appJotaiStore.set(taskListLoadingAtom, false)
    }
  }
}

export async function finishDeleteAll(deleteSucceeded: boolean): Promise<void> {
  loadAbort?.abort()
  const gen = ++fetchGeneration
  const controller = new AbortController()
  loadAbort = controller

  try {
    const tasks = await fetchActiveTasks(controller.signal)
    if (controller.signal.aborted) return

    if (deleteSucceeded) {
      commitTasks(gen, [])
    } else {
      commitTasks(gen, tasks)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    console.error('Error refreshing task list after delete all:', error)
  } finally {
    if (!controller.signal.aborted && gen === fetchGeneration) {
      appJotaiStore.set(taskListLoadingAtom, false)
    }
  }
}

export function prependTask(task: Task): void {
  const prev = appJotaiStore.get(taskListAtom)
  appJotaiStore.set(taskListAtom, [task, ...prev])
}
