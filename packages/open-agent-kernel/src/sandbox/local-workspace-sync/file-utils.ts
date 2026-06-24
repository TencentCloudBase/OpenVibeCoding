import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.oak'])
const EXCLUDED_FILES = new Set(['.DS_Store', '.restore-in-status.json'])

export function safeSegment(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]/g, '-')
  return normalized || 'default'
}

export function assertSafeRelativePath(relPath: string): void {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\')) {
    throw new Error('relative path is not safe')
  }
  for (const segment of relPath.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error('relative path contains unsafe segment')
    }
  }
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, '', out)
  out.sort()
  return out
}

export async function copyTree(srcRoot: string, dstRoot: string): Promise<void> {
  const files = await listWorkspaceFiles(srcRoot)
  await fs.mkdir(dstRoot, { recursive: true })
  for (const relPath of files) {
    assertSafeRelativePath(relPath)
    const src = path.join(srcRoot, relPath)
    const dst = path.join(dstRoot, relPath)
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(src, dst)
  }
}

export async function replaceTree(srcRoot: string, dstRoot: string): Promise<void> {
  await fs.rm(dstRoot, { recursive: true, force: true })
  await fs.mkdir(dstRoot, { recursive: true })
  await copyTree(srcRoot, dstRoot)
}

async function walk(absDir: string, relPrefix: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    const absPath = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      await walk(absPath, relPath, out)
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue
      out.push(relPath)
    }
  }
}
