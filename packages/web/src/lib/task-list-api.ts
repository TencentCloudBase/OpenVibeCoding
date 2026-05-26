import type { Task } from '@coder/shared'

export function filterActiveTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt)
}

export async function fetchActiveTasks(signal?: AbortSignal): Promise<Task[]> {
  const response = await fetch('/api/tasks', {
    credentials: 'include',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    if (response.status === 401) return []
    throw new Error('Failed to fetch tasks')
  }
  const data = await response.json()
  return filterActiveTasks((data.tasks ?? []) as Task[])
}
