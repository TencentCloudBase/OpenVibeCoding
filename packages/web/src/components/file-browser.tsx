import { useState, useEffect, useCallback, useRef } from 'react'
import {
  File,
  Folder,
  FolderOpen,
  Clock,
  GitBranch,
  Loader2,
  GitCommit,
  ExternalLink,
  Scissors,
  Copy,
  Clipboard,
  Lock,
  RotateCcw,
  FilePlus,
  FolderPlus,
  Trash2,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAtom } from 'jotai'
import { getTaskFileBrowserState } from '@/lib/atoms/file-browser'
import { useMemo } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface FileChange {
  filename: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  changes: number
}

interface FileTreeNode {
  type: 'file' | 'directory'
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  changes?: number
  children?: { [key: string]: FileTreeNode }
  loaded?: boolean
  loading?: boolean
}

interface FileBrowserProps {
  taskId: string
  branchName?: string | null
  repoUrl?: string | null
  sandboxId?: string | null
  onFileSelect?: (filename: string, isFolder?: boolean) => void
  onFilesLoaded?: (filenames: string[]) => void
  selectedFile?: string
  refreshKey?: number
  viewMode?: 'local' | 'remote' | 'all' | 'all-local'
  onViewModeChange?: (mode: 'local' | 'remote' | 'all' | 'all-local') => void
  hideHeader?: boolean
}

export function FileBrowser({
  taskId,
  branchName,
  repoUrl,
  sandboxId,
  onFileSelect,
  onFilesLoaded,
  selectedFile,
  refreshKey,
  viewMode: viewModeProp = 'remote',
  onViewModeChange,
  hideHeader = false,
}: FileBrowserProps) {
  // When no branch but sandbox exists, force local-only mode
  const hasBranch = !!(branchName && branchName.trim().length > 0)
  const sandboxOnly = !hasBranch && !!sandboxId
  const viewMode = sandboxOnly ? 'all-local' : viewModeProp
  // Use Jotai atom for state management
  const taskStateAtom = useMemo(() => getTaskFileBrowserState(taskId), [taskId])
  const [state, setState] = useAtom(taskStateAtom)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [isStartingSandbox, setIsStartingSandbox] = useState(false)

  // Clipboard state for cut/copy/paste
  const [clipboardFile, setClipboardFile] = useState<{ filename: string; operation: 'cut' | 'copy' } | null>(null)

  // Context menu state
  const [contextMenuFile, setContextMenuFile] = useState<string | null>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)

  // Drag and drop state
  const [draggedItem, setDraggedItem] = useState<{ path: string; type: 'file' | 'folder' } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [isDraggingActive, setIsDraggingActive] = useState(false)

  // Dialog state
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showSyncDialog, setShowSyncDialog] = useState(false)
  const [syncCommitMessage, setSyncCommitMessage] = useState('')
  const [showCommitMessageDialog, setShowCommitMessageDialog] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [showNewFileDialog, setShowNewFileDialog] = useState(false)
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [isCreatingFile, setIsCreatingFile] = useState(false)
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [fileToDelete, setFileToDelete] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [fileToDiscard, setFileToDiscard] = useState<string | null>(null)
  const [isDiscarding, setIsDiscarding] = useState(false)
  // Detect OS for keyboard shortcuts
  const isMac = useMemo(() => {
    if (typeof window === 'undefined') return false
    return navigator.platform.toUpperCase().indexOf('MAC') >= 0
  }, [])

  // Get current viewMode data with default values
  interface ViewModeData {
    files: FileChange[]
    fileTree: { [key: string]: FileTreeNode }
    expandedFolders: Set<string>
    fetchAttempted: boolean
    error: string | null
  }

  type ViewModeKey = 'local' | 'remote' | 'all' | 'all-local'
  const currentViewData = (state[viewMode as ViewModeKey] as ViewModeData | undefined) || {
    files: [],
    fileTree: {},
    expandedFolders: new Set<string>(),
    fetchAttempted: false,
    error: null,
  }
  const { files, fileTree, expandedFolders, fetchAttempted, error } = currentViewData
  const { loading } = state

  // Helper function to recursively collect all folder paths
  const getAllFolderPaths = useCallback(function collectPaths(
    tree: { [key: string]: FileTreeNode },
    basePath = '',
  ): string[] {
    const paths: string[] = []

    Object.entries(tree).forEach(([name, node]) => {
      const fullPath = basePath ? `${basePath}/${name}` : name

      if (node.type === 'directory') {
        paths.push(fullPath)
        if (node.children) {
          paths.push(...collectPaths(node.children, fullPath))
        }
      }
    })

    return paths
  }, [])

  // Helper function to find the first file in the tree
  const getFirstFile = useCallback(function findFirstFile(
    tree: { [key: string]: FileTreeNode },
    path = '',
  ): string | null {
    const sortedEntries = Object.entries(tree).sort(([nameA, nodeA], [nameB, nodeB]) => {
      if (nodeA.type === 'directory' && nodeB.type === 'file') return -1
      if (nodeA.type === 'file' && nodeB.type === 'directory') return 1
      return nameA.toLowerCase().localeCompare(nameB.toLowerCase())
    })

    for (const [name, node] of sortedEntries) {
      const fullPath = path ? `${path}/${name}` : name

      if (node.type === 'file' && node.filename) {
        return node.filename
      } else if (node.type === 'directory' && node.children) {
        const firstFileInDir = findFirstFile(node.children, fullPath)
        if (firstFileInDir) {
          return firstFileInDir
        }
      }
    }

    return null
  }, [])

  // Lazy load a single directory's entries from the sandbox
  const fetchDirEntries = useCallback(
    async (dirPath: string) => {
      try {
        const url = `/api/tasks/${taskId}/files/list-dir?path=${encodeURIComponent(dirPath)}`
        const response = await fetch(url)
        const result = await response.json()
        if (!result.success || !result.entries) return null
        return result.entries as Array<{ name: string; type: 'file' | 'directory'; path: string }>
      } catch {
        return null
      }
    },
    [taskId],
  )

  // Refresh file tree: sandboxOnly uses list-dir, otherwise uses full files API
  const refreshFileTree = useCallback(
    async (extraExpandedFolders?: Set<string>) => {
      if (sandboxOnly) {
        const entries = await fetchDirEntries('.')
        if (entries) {
          const lazyTree: Record<string, FileTreeNode> = {}
          const lazyFiles: FileChange[] = []
          for (const entry of entries) {
            if (entry.type === 'directory') {
              lazyTree[entry.name] = { type: 'directory', children: {}, loaded: false }
            } else {
              lazyTree[entry.name] = {
                type: 'file',
                filename: entry.path,
                status: 'modified',
                additions: 0,
                deletions: 0,
                changes: 0,
              }
              lazyFiles.push({
                filename: entry.path,
                status: 'modified',
                additions: 0,
                deletions: 0,
                changes: 0,
              })
            }
          }
          const merged = extraExpandedFolders ? new Set([...expandedFolders, ...extraExpandedFolders]) : expandedFolders
          setState({
            [viewMode]: {
              files: lazyFiles,
              fileTree: lazyTree,
              expandedFolders: merged,
              fetchAttempted: true,
              error: null,
            },
            loading: false,
          })
          return { success: true, files: lazyFiles, fileTree: lazyTree }
        }
        return null
      }
      // Non-sandbox: use full files API
      try {
        const url = `/api/tasks/${taskId}/files?mode=${viewMode}`
        const response = await fetch(url)
        const result = await response.json()
        if (result.success) {
          const merged = extraExpandedFolders ? new Set([...expandedFolders, ...extraExpandedFolders]) : expandedFolders
          setState({
            [viewMode]: {
              files: result.files || [],
              fileTree: result.fileTree || {},
              expandedFolders: merged,
              fetchAttempted: true,
              error: null,
            },
            loading: false,
          })
          return result
        }
      } catch {
        // ignore
      }
      return null
    },
    [sandboxOnly, fetchDirEntries, taskId, viewMode, setState, expandedFolders],
  )

  const fetchBranchFiles = useCallback(async () => {
    if (!hasBranch && !sandboxId) return

    const isInitialLoad = files.length === 0 && !fetchAttempted

    if (isInitialLoad) {
      setState({ loading: true, error: null })
    }

    // Lazy loading: for all-local (sandbox-only), always use list-dir
    if (sandboxOnly) {
      const entries = await fetchDirEntries('.')
      if (entries) {
        const lazyTree: Record<string, FileTreeNode> = {}
        const lazyFiles: FileChange[] = []
        for (const entry of entries) {
          if (entry.type === 'directory') {
            lazyTree[entry.name] = { type: 'directory', children: {}, loaded: false }
          } else {
            lazyTree[entry.name] = {
              type: 'file',
              filename: entry.path,
              status: 'modified',
              additions: 0,
              deletions: 0,
              changes: 0,
            }
            lazyFiles.push({
              filename: entry.path,
              status: 'modified',
              additions: 0,
              deletions: 0,
              changes: 0,
            })
          }
        }
        setState({
          [viewMode]: {
            files: lazyFiles,
            fileTree: lazyTree,
            expandedFolders: new Set<string>(),
            fetchAttempted: true,
            error: null,
          },
          loading: false,
        })
        return
      }
      // Fallback: if list-dir fails, continue with full fetch below
    }

    try {
      const url = `/api/tasks/${taskId}/files?mode=${viewMode}`
      const response = await fetch(url)
      const result = await response.json()

      if (result.success) {
        const fetchedFiles = result.files || []
        const fetchedFileTree = result.fileTree || {}

        const newExpandedFolders = isInitialLoad
          ? viewMode === 'local' || viewMode === 'remote'
            ? new Set(getAllFolderPaths(fetchedFileTree))
            : new Set<string>()
          : expandedFolders

        setState({
          [viewMode]: {
            files: fetchedFiles,
            fileTree: fetchedFileTree,
            expandedFolders: newExpandedFolders,
            fetchAttempted: true,
            error: null,
          },
          loading: false,
        })

        if (onFilesLoaded && fetchedFiles.length > 0) {
          onFilesLoaded(fetchedFiles.map((f: FileChange) => f.filename))
        }

        if (isInitialLoad && !selectedFile && fetchedFileTree && Object.keys(fetchedFileTree).length > 0) {
          const firstFile = getFirstFile(fetchedFileTree)
          if (firstFile && onFileSelect) {
            onFileSelect(firstFile, false)
          }
        }
      } else {
        const isSandboxNotRunning =
          response.status === 410 || result.error?.includes('Sandbox is not running') || result.error?.includes('410')
        const errorMessage = isSandboxNotRunning ? 'SANDBOX_NOT_RUNNING' : result.error || 'Failed to fetch files'

        setState({
          [viewMode]: {
            files: [],
            fileTree: {},
            expandedFolders: new Set<string>(),
            fetchAttempted: true,
            error: errorMessage,
          },
          loading: false,
        })
      }
    } catch {
      setState({
        [viewMode]: {
          files: [],
          fileTree: {},
          expandedFolders: new Set<string>(),
          fetchAttempted: true,
          error: 'Failed to fetch branch files',
        },
        loading: false,
      })
    }
  }, [
    branchName,
    taskId,
    sandboxId,
    onFilesLoaded,
    viewMode,
    setState,
    getAllFolderPaths,
    files.length,
    fetchAttempted,
    expandedFolders,
    selectedFile,
    onFileSelect,
    getFirstFile,
    sandboxOnly,
    fetchDirEntries,
  ])

  const handleSyncChanges = useCallback(async () => {
    if (isSyncing || (!hasBranch && !sandboxId)) return

    setIsSyncing(true)
    setShowSyncDialog(false)

    try {
      const response = await fetch(`/api/tasks/${taskId}/sync-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage: syncCommitMessage || 'Sync local changes' }),
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to sync changes')
      }

      toast.success('Changes synced successfully')
      setSyncCommitMessage('')

      try {
        await refreshFileTree()
      } catch (err) {
        console.error('Error refreshing file list:', err)
      }
    } catch (err) {
      console.error('Error syncing changes:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to sync changes')
    } finally {
      setIsSyncing(false)
    }
  }, [isSyncing, branchName, taskId, syncCommitMessage, viewMode, currentViewData, setState])

  const handleResetChanges = useCallback(async () => {
    if (isResetting || (!hasBranch && !sandboxId)) return

    setIsResetting(true)
    setShowCommitMessageDialog(false)

    try {
      const response = await fetch(`/api/tasks/${taskId}/reset-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage: commitMessage || 'Reset changes' }),
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to reset changes')
      }

      toast.success('Changes reset successfully')
      setCommitMessage('')

      try {
        await refreshFileTree()
      } catch (err) {
        console.error('Error refreshing file list:', err)
      }
    } catch (err) {
      console.error('Error resetting changes:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to reset changes')
    } finally {
      setIsResetting(false)
    }
  }, [isResetting, branchName, taskId, commitMessage, viewMode, currentViewData, setState])

  const handleStartSandbox = useCallback(async () => {
    setIsStartingSandbox(true)
    try {
      const response = await fetch(`/api/tasks/${taskId}/start-sandbox`, { method: 'POST' })

      if (response.ok) {
        toast.success('Sandbox started! Loading files...')
        setState({
          [viewMode]: {
            files: [],
            fileTree: {},
            expandedFolders: new Set<string>(),
            fetchAttempted: false,
            error: null,
          },
          loading: true,
        })
        await new Promise((resolve) => setTimeout(resolve, 6000))
        await fetchBranchFiles()
      } else {
        const error = await response.json()
        toast.error(error.error || 'Failed to start sandbox')
      }
    } catch (error) {
      console.error('Error starting sandbox:', error)
      toast.error('Failed to start sandbox')
    } finally {
      setIsStartingSandbox(false)
    }
  }, [taskId, viewMode, setState, fetchBranchFiles])

  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim()) {
      toast.error('Please enter a file name')
      return
    }
    setIsCreatingFile(true)
    try {
      const isSelectedItemFolder =
        selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
      const filename =
        isSelectedItemFolder && !newFileName.includes('/')
          ? `${selectedFile}/${newFileName.trim()}`
          : newFileName.trim()

      const response = await fetch(`/api/tasks/${taskId}/create-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to create file')

      toast.success('File created successfully')
      setShowNewFileDialog(false)
      setNewFileName('')

      try {
        const parentPath = filename.split('/').slice(0, -1).join('/')
        const extra = parentPath ? new Set([parentPath]) : undefined
        await refreshFileTree(extra)
        if (onFileSelect) onFileSelect(filename, false)
      } catch (err) {
        console.error('Error refreshing file list:', err)
      }
    } catch (err) {
      console.error('Error creating file:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create file')
    } finally {
      setIsCreatingFile(false)
    }
  }, [newFileName, taskId, viewMode, currentViewData, setState, onFileSelect, selectedFile, files])

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      toast.error('Please enter a folder name')
      return
    }
    setIsCreatingFolder(true)
    try {
      const isSelectedItemFolder =
        selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
      const foldername =
        isSelectedItemFolder && !newFolderName.includes('/')
          ? `${selectedFile}/${newFolderName.trim()}`
          : newFolderName.trim()

      const response = await fetch(`/api/tasks/${taskId}/create-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foldername }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to create folder')

      toast.success('Folder created successfully')
      setShowNewFolderDialog(false)
      setNewFolderName('')

      try {
        const parentPath = foldername.split('/').slice(0, -1).join('/')
        const extra = new Set<string>()
        if (parentPath) extra.add(parentPath)
        extra.add(foldername)
        await refreshFileTree(extra)
        if (onFileSelect) onFileSelect(foldername, true)
      } catch (err) {
        console.error('Error refreshing file list:', err)
      }
    } catch (err) {
      console.error('Error creating folder:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create folder')
    } finally {
      setIsCreatingFolder(false)
    }
  }, [newFolderName, taskId, viewMode, currentViewData, setState, selectedFile, files, onFileSelect])

  const handleDelete = useCallback(
    async (filename: string) => {
      if (!filename) {
        toast.error('No file selected for deletion')
        return
      }
      setIsDeleting(true)
      try {
        const response = await fetch(`/api/tasks/${taskId}/delete-file`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename }),
        })
        const result = await response.json()
        if (!response.ok || !result.success) throw new Error(result.error || 'Failed to delete file')

        toast.success('File deleted successfully')
        setShowDeleteConfirm(false)
        setFileToDelete(null)

        try {
          await refreshFileTree()
        } catch (err) {
          console.error('Error refreshing file list:', err)
        }
      } catch (err) {
        console.error('Error deleting file:', err)
        toast.error(err instanceof Error ? err.message : 'Failed to delete file')
      } finally {
        setIsDeleting(false)
      }
    },
    [taskId, viewMode, currentViewData, setState],
  )

  const prevSandboxIdRef = useRef<string | null | undefined>(sandboxId)

  useEffect(() => {
    const prev = prevSandboxIdRef.current
    prevSandboxIdRef.current = sandboxId ?? null
    if (!prev && sandboxId) {
      setState((prevState) => ({
        ...prevState,
        [viewMode]: {
          ...((prevState[viewMode as ViewModeKey] as ViewModeData | undefined) ?? currentViewData),
          fetchAttempted: false,
          error: null,
        },
      }))
    }
  }, [sandboxId, viewMode, setState, currentViewData])

  useEffect(() => {
    if ((hasBranch || sandboxId) && files.length === 0 && !loading && !fetchAttempted) {
      fetchBranchFiles()
    }
  }, [hasBranch, sandboxId, files.length, loading, fetchAttempted, fetchBranchFiles])

  useEffect(() => {
    if ((hasBranch || sandboxId) && refreshKey !== undefined && refreshKey > 0) {
      setState({ [viewMode]: { ...currentViewData, fetchAttempted: false } })
      fetchBranchFiles()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, hasBranch, sandboxId])

  // Helper: update a nested node in fileTree by path
  const updateTreeNode = useCallback(
    (tree: Record<string, FileTreeNode>, path: string, updater: (node: FileTreeNode) => FileTreeNode) => {
      const newTree = { ...tree }
      const parts = path.split('/')
      let current = newTree

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        if (current[part]?.type === 'directory') {
          current[part] = { ...current[part], children: { ...current[part].children } }
          current = current[part].children!
        } else {
          return tree // path not found
        }
      }

      const lastPart = parts[parts.length - 1]
      if (current[lastPart]) {
        current[lastPart] = updater(current[lastPart])
      }
      return newTree
    },
    [],
  )

  const toggleFolder = useCallback(
    async (path: string) => {
      const newExpanded = new Set(expandedFolders)
      if (newExpanded.has(path)) {
        newExpanded.delete(path)
        setState({ [viewMode]: { ...currentViewData, expandedFolders: newExpanded } })
        return
      }

      // Expanding: check if lazy loading is needed (all-local mode, not yet loaded)
      newExpanded.add(path)

      if (sandboxOnly) {
        // Find the node at this path
        const parts = path.split('/')
        let node: FileTreeNode | undefined
        let level = fileTree
        for (const part of parts) {
          node = level[part]
          if (!node) break
          if (node.type === 'directory' && node.children) level = node.children
        }

        if (node?.type === 'directory' && !node.loaded) {
          // Mark as loading
          const loadingTree = updateTreeNode(fileTree, path, (n) => ({ ...n, loading: true }))
          setState({ [viewMode]: { ...currentViewData, fileTree: loadingTree, expandedFolders: newExpanded } })

          // Fetch directory entries
          const entries = await fetchDirEntries(path)
          if (entries) {
            const children: Record<string, FileTreeNode> = {}
            for (const entry of entries) {
              if (entry.type === 'directory') {
                children[entry.name] = { type: 'directory', children: {}, loaded: false }
              } else {
                children[entry.name] = {
                  type: 'file',
                  filename: entry.path,
                  status: 'modified',
                  additions: 0,
                  deletions: 0,
                  changes: 0,
                }
              }
            }
            const updatedTree = updateTreeNode(fileTree, path, (n) => ({
              ...n,
              children,
              loaded: true,
              loading: false,
            }))
            setState({ [viewMode]: { ...currentViewData, fileTree: updatedTree, expandedFolders: newExpanded } })
          } else {
            // Failed, just mark loaded to avoid retrying
            const failedTree = updateTreeNode(fileTree, path, (n) => ({
              ...n,
              loaded: true,
              loading: false,
            }))
            setState({ [viewMode]: { ...currentViewData, fileTree: failedTree, expandedFolders: newExpanded } })
          }
          return
        }
      }

      setState({ [viewMode]: { ...currentViewData, expandedFolders: newExpanded } })
    },
    [expandedFolders, setState, viewMode, currentViewData, sandboxOnly, fileTree, fetchDirEntries, updateTreeNode],
  )

  const handleOpenOnGitHub = useCallback(
    (path: string, isFolder: boolean = false) => {
      if (!repoUrl || !branchName) {
        toast.error('Repository URL or branch name not available')
        return
      }
      try {
        const repoPath = repoUrl.replace('https://github.com/', '').replace(/\.git$/, '')
        const pathType = isFolder ? 'tree' : 'blob'
        const githubUrl = `https://github.com/${repoPath}/${pathType}/${branchName}/${path}`
        window.open(githubUrl, '_blank', 'noopener,noreferrer')
      } catch (err) {
        console.error('Error opening GitHub URL:', err)
        toast.error(`Failed to open ${isFolder ? 'folder' : 'file'} on GitHub`)
      }
    },
    [repoUrl, branchName],
  )

  const handleCut = useCallback((filename: string) => {
    setClipboardFile({ filename, operation: 'cut' })
    toast.success('File cut to clipboard')
  }, [])
  const handleCopy = useCallback((filename: string) => {
    setClipboardFile({ filename, operation: 'copy' })
    toast.success('File copied to clipboard')
  }, [])

  const handleDownload = useCallback(
    async (filePath: string, options?: { asZip?: boolean }) => {
      const url = `/api/tasks/${taskId}/files/download?path=${encodeURIComponent(filePath)}`
      try {
        const response = await fetch(url, { credentials: 'include' })
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error || 'Download failed')
        }
        const blob = await response.blob()
        const disposition = response.headers.get('Content-Disposition')
        let filename = filePath.split('/').pop() || 'download'
        if (options?.asZip && !filename.endsWith('.zip')) filename = `${filename}.zip`
        const match = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i)
        if (match?.[1]) filename = decodeURIComponent(match[1])
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(objectUrl)
      } catch (err) {
        console.error('Download failed:', err)
        toast.error(err instanceof Error ? err.message : 'Download failed')
      }
    },
    [taskId],
  )

  const handlePaste = useCallback(
    async (targetPath?: string) => {
      if (!clipboardFile) {
        toast.error('No file in clipboard')
        return
      }
      try {
        const response = await fetch(`/api/tasks/${taskId}/file-operation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: clipboardFile.operation,
            sourceFile: clipboardFile.filename,
            targetPath: targetPath || null,
          }),
        })
        const result = await response.json()
        if (!response.ok || !result.success) throw new Error(result.error || 'Failed to paste file')

        toast.success(clipboardFile.operation === 'cut' ? 'File moved successfully' : 'File copied successfully')
        if (clipboardFile.operation === 'cut') setClipboardFile(null)

        try {
          await refreshFileTree()
        } catch (err) {
          console.error('Error refreshing file list:', err)
        }
      } catch (err) {
        console.error('Error pasting file:', err)
        toast.error(err instanceof Error ? err.message : 'Failed to paste file')
      }
    },
    [clipboardFile, taskId, viewMode, currentViewData, setState],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent, filename: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenuFile(filename)
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
  }, [])

  const handleDiscardChanges = useCallback(async () => {
    if (!fileToDiscard) return
    setIsDiscarding(true)
    try {
      const response = await fetch(`/api/tasks/${taskId}/discard-file-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fileToDiscard }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to discard changes')

      toast.success('Changes discarded successfully')

      try {
        await refreshFileTree()
      } catch (err) {
        console.error('Error refreshing file list:', err)
      }
    } catch (err) {
      console.error('Error discarding changes:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to discard changes')
    } finally {
      setIsDiscarding(false)
      setShowDiscardConfirm(false)
      setFileToDiscard(null)
    }
  }, [fileToDiscard, taskId, viewMode, currentViewData, setState])

  // Drag and drop handlers
  const handleDragStart = useCallback(
    (e: React.DragEvent, path: string, type: 'file' | 'folder') => {
      if (viewMode !== 'all-local') {
        e.preventDefault()
        return
      }
      e.stopPropagation()
      setIsDraggingActive(true)
      setDraggedItem({ path, type })
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', path)
    },
    [viewMode],
  )

  const handleDragEnd = useCallback(() => {
    setDraggedItem(null)
    setDropTarget(null)
    setTimeout(() => setIsDraggingActive(false), 50)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      if (!draggedItem || viewMode !== 'all-local') return
      if (draggedItem.path === folderPath || folderPath.startsWith(draggedItem.path + '/')) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(folderPath)
    },
    [draggedItem, viewMode],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetFolderPath: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (!draggedItem) return
      if (draggedItem.path === targetFolderPath || targetFolderPath.startsWith(draggedItem.path + '/')) {
        toast.error('Cannot move a folder into itself')
        setDraggedItem(null)
        setDropTarget(null)
        return
      }
      try {
        const response = await fetch(`/api/tasks/${taskId}/file-operation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'cut',
            sourceFile: draggedItem.path,
            targetPath: targetFolderPath === '__root__' ? null : targetFolderPath,
          }),
        })
        const result = await response.json()
        if (!response.ok || !result.success) throw new Error(result.error || 'Failed to move item')

        toast.success(`${draggedItem.type === 'folder' ? 'Folder' : 'File'} moved successfully`)

        try {
          const extra = targetFolderPath !== '__root__' ? new Set([targetFolderPath]) : undefined
          await refreshFileTree(extra)
        } catch (err) {
          console.error('Error refreshing file list:', err)
        }
      } catch (err) {
        console.error('Error moving item:', err)
        toast.error(err instanceof Error ? err.message : 'Failed to move item')
      } finally {
        setDraggedItem(null)
        setDropTarget(null)
      }
    },
    [draggedItem, taskId, viewMode, currentViewData, setState],
  )

  // Keyboard shortcut handler for copy/cut/paste
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode !== 'local' && viewMode !== 'all-local') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      const isCmdOrCtrl = e.ctrlKey || e.metaKey
      // Don't intercept Cmd+C when user has text selected — let native copy work
      const selection = window.getSelection()
      if (isCmdOrCtrl && e.key === 'c' && selection && selection.toString().length > 0) return
      if (isCmdOrCtrl && e.key === 'c' && selectedFile) {
        e.preventDefault()
        handleCopy(selectedFile)
      }
      if (isCmdOrCtrl && e.key === 'x' && selectedFile) {
        e.preventDefault()
        handleCut(selectedFile)
      }
      if (isCmdOrCtrl && e.key === 'v' && clipboardFile) {
        e.preventDefault()
        handlePaste()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode, clipboardFile, selectedFile, handleCopy, handleCut, handlePaste])

  const renderFileTree = (tree: { [key: string]: FileTreeNode }, path = '') => {
    const sortedEntries = Object.entries(tree).sort(([nameA, nodeA], [nameB, nodeB]) => {
      if (nodeA.type === 'directory' && nodeB.type === 'file') return -1
      if (nodeA.type === 'file' && nodeB.type === 'directory') return 1
      return nameA.toLowerCase().localeCompare(nameB.toLowerCase())
    })

    return sortedEntries.map(([name, node]) => {
      const fullPath = path ? `${path}/${name}` : name

      if (node.type === 'directory') {
        const isExpanded = expandedFolders.has(fullPath)
        const isSandboxMode = viewMode === 'local' || viewMode === 'all-local'
        const isRemoteMode = viewMode === 'remote' || viewMode === 'all'
        const isFolderContextMenuOpen = contextMenuFile === fullPath
        const isDropTargetHere = dropTarget === fullPath
        const isDragging = draggedItem?.path === fullPath
        const isSelected = selectedFile === fullPath
        const isDragEnabled = viewMode === 'all-local'

        return (
          <div key={fullPath}>
            <div style={{ position: 'relative' }}>
              <div
                draggable={isDragEnabled}
                onDragStart={(e) => handleDragStart(e, fullPath, 'folder')}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, fullPath)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, fullPath)}
                className={`flex items-center gap-2 px-2 md:px-3 py-1.5 rounded-sm ${isSelected ? 'bg-card' : 'hover:bg-card/50'} ${isDropTargetHere ? 'bg-blue-500/20' : ''} ${isDragging ? 'opacity-50 cursor-move' : 'cursor-pointer'}`}
                onClick={() => {
                  if (!isDraggingActive) {
                    toggleFolder(fullPath)
                    onFileSelect?.(fullPath, true)
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, fullPath)}
              >
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isExpanded ? (
                    <FolderOpen className="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500 flex-shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500 flex-shrink-0" />
                  )}
                </div>
                <span className="text-xs md:text-sm font-medium truncate">{name}</span>
                {viewMode === 'all' && (
                  <Lock className="w-2.5 h-2.5 md:w-3 md:h-3 text-muted-foreground flex-shrink-0 ml-auto" />
                )}
              </div>
              {(isSandboxMode || isRemoteMode) && isFolderContextMenuOpen && contextMenuPosition && (
                <DropdownMenu
                  open={isFolderContextMenuOpen}
                  onOpenChange={(open) => {
                    if (!open) {
                      setContextMenuFile(null)
                      setContextMenuPosition(null)
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <div
                      style={{
                        position: 'fixed',
                        top: contextMenuPosition.y,
                        left: contextMenuPosition.x,
                        width: '1px',
                        height: '1px',
                        pointerEvents: 'none',
                      }}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="bottom">
                    {isRemoteMode && (
                      <DropdownMenuItem onClick={() => handleOpenOnGitHub(fullPath, true)}>
                        <ExternalLink className="w-4 h-4 mr-2" />
                        Open on GitHub
                      </DropdownMenuItem>
                    )}
                    {isSandboxMode && (
                      <>
                        {viewMode === 'all-local' && (
                          <>
                            <DropdownMenuItem
                              onClick={() => {
                                onFileSelect?.(fullPath, true)
                                setShowNewFileDialog(true)
                              }}
                            >
                              <FilePlus className="w-4 h-4 mr-2" />
                              New File
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                onFileSelect?.(fullPath, true)
                                setShowNewFolderDialog(true)
                              }}
                            >
                              <FolderPlus className="w-4 h-4 mr-2" />
                              New Folder
                            </DropdownMenuItem>
                          </>
                        )}
                        <DropdownMenuItem onClick={() => handlePaste(fullPath)} disabled={!clipboardFile}>
                          <Clipboard className="w-4 h-4 mr-2" />
                          Paste<DropdownMenuShortcut>{isMac ? '⌘V' : 'Ctrl+V'}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownload(fullPath, { asZip: true })}>
                          <Download className="w-4 h-4 mr-2" />
                          Download as zip
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {isExpanded && node.children && (
              <div className="ml-3 md:ml-4">
                {node.loading ? (
                  <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading...
                  </div>
                ) : (
                  renderFileTree(node.children, fullPath)
                )}
              </div>
            )}
          </div>
        )
      } else {
        const isSelected = selectedFile === node.filename
        const isSandboxMode = viewMode === 'local' || viewMode === 'all-local'
        const isRemoteMode = viewMode === 'remote' || viewMode === 'all'
        const isContextMenuOpen = contextMenuFile === node.filename
        const isCut = clipboardFile?.filename === node.filename && clipboardFile?.operation === 'cut'
        const isDragging = draggedItem?.path === node.filename
        const isDragEnabled = viewMode === 'all-local'

        return (
          <div key={fullPath} style={{ position: 'relative' }}>
            <div
              draggable={isDragEnabled}
              onDragStart={(e) => handleDragStart(e, node.filename!, 'file')}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-2 px-2 md:px-3 py-1.5 rounded-sm ${isSelected ? 'bg-card' : 'hover:bg-card/50'} ${isCut || isDragging ? 'opacity-50' : ''} ${isDragging ? 'cursor-move' : 'cursor-pointer'}`}
              onClick={() => {
                if (!isDraggingActive) onFileSelect?.(node.filename!, false)
              }}
              onContextMenu={(e) => handleContextMenu(e, node.filename!)}
            >
              <div className="flex items-center gap-1 flex-shrink-0">
                <File className="w-3.5 h-3.5 md:w-4 md:h-4 text-muted-foreground flex-shrink-0" />
              </div>
              <span
                className={`text-xs md:text-sm flex-1 truncate ${viewMode === 'all-local' && node.status === 'added' ? 'text-green-600' : viewMode === 'all-local' && node.status === 'modified' ? 'text-yellow-600' : ''}`}
              >
                {name}
              </span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {(viewMode === 'local' || viewMode === 'remote') &&
                  ((node.additions || 0) > 0 || (node.deletions || 0) > 0) && (
                    <div className="flex items-center gap-1 text-xs">
                      {(node.additions || 0) > 0 && <span className="text-green-600">+{node.additions}</span>}
                      {(node.deletions || 0) > 0 && <span className="text-red-600">-{node.deletions}</span>}
                    </div>
                  )}
                {viewMode === 'all' && (
                  <Lock className="w-2.5 h-2.5 md:w-3 md:h-3 text-muted-foreground flex-shrink-0" />
                )}
              </div>
            </div>
            {isContextMenuOpen && contextMenuPosition && (
              <DropdownMenu
                open={isContextMenuOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    setContextMenuFile(null)
                    setContextMenuPosition(null)
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <div
                    style={{
                      position: 'fixed',
                      top: contextMenuPosition.y,
                      left: contextMenuPosition.x,
                      width: '1px',
                      height: '1px',
                      pointerEvents: 'none',
                    }}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  {isRemoteMode && (
                    <DropdownMenuItem onClick={() => handleOpenOnGitHub(node.filename!)}>
                      <ExternalLink className="w-4 h-4 mr-2" />
                      Open on GitHub
                    </DropdownMenuItem>
                  )}
                  {isSandboxMode && (
                    <>
                      {viewMode === 'local' ? (
                        <DropdownMenuItem
                          onClick={() => {
                            setFileToDiscard(node.filename!)
                            setShowDiscardConfirm(true)
                          }}
                        >
                          <RotateCcw className="w-4 h-4 mr-2" />
                          Discard Changes
                        </DropdownMenuItem>
                      ) : (
                        <>
                          <DropdownMenuItem onClick={() => handleCut(node.filename!)}>
                            <Scissors className="w-4 h-4 mr-2" />
                            Cut<DropdownMenuShortcut>{isMac ? '⌘X' : 'Ctrl+X'}</DropdownMenuShortcut>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleCopy(node.filename!)}>
                            <Copy className="w-4 h-4 mr-2" />
                            Copy<DropdownMenuShortcut>{isMac ? '⌘C' : 'Ctrl+C'}</DropdownMenuShortcut>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handlePaste()} disabled={!clipboardFile}>
                            <Clipboard className="w-4 h-4 mr-2" />
                            Paste<DropdownMenuShortcut>{isMac ? '⌘V' : 'Ctrl+V'}</DropdownMenuShortcut>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDownload(node.filename!)}>
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setFileToDelete(node.filename!)
                              setShowDeleteConfirm(true)
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )
      }
    })
  }

  if (!hasBranch && !sandboxId) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 md:p-4 border-b">
          <h3 className="text-base md:text-lg font-semibold">Files</h3>
          <p className="text-xs md:text-sm text-muted-foreground">Task in progress</p>
        </div>
        <div className="flex-1 flex items-center justify-center p-4 md:p-6">
          <div className="text-center space-y-3 md:space-y-4">
            <div className="flex justify-center">
              <div className="flex items-center gap-2 text-amber-500">
                <Clock className="w-5 h-5 md:w-6 md:h-6" />
                <GitBranch className="w-5 h-5 md:w-6 md:h-6" />
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm md:text-base font-medium">Sandbox Not Ready</h4>
              <p className="text-xs md:text-sm text-muted-foreground max-w-xs px-2 md:px-0">
                The coding agent is still working on this task. File changes will appear here once the sandbox is ready.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">Check the logs for progress updates</div>
          </div>
        </div>
      </div>
    )
  }

  const filesPane = viewMode === 'all' || viewMode === 'all-local' ? 'files' : 'changes'
  const subMode = viewMode === 'all' || viewMode === 'remote' ? 'remote' : 'local'

  return (
    <div className="flex flex-col h-full">
      {!hideHeader && (
        <div className="border-b">
          <div className="py-2 px-3 flex items-center justify-between h-[46px]">
            <div className="flex items-center gap-1">
              {/* <button
                onClick={() => onViewModeChange?.(subMode === 'local' ? 'local' : 'remote')}
                className={`text-sm font-semibold px-2 py-1 rounded transition-colors ${filesPane === 'changes' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Changes
              </button> */}
              <button
                onClick={() => onViewModeChange?.(subMode === 'local' ? 'all-local' : 'all')}
                className={`text-sm font-semibold px-2 py-1 rounded transition-colors ${filesPane === 'files' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Files
              </button>
            </div>
            {/* <div className="inline-flex rounded-md border border-border bg-muted/50 p-0.5">
              <Button
                variant={subMode === 'remote' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onViewModeChange?.(filesPane === 'files' ? 'all' : 'remote')}
                className={`h-6 px-2 text-xs rounded-sm ${subMode === 'remote' ? 'bg-background shadow-sm hover:bg-background' : 'hover:bg-transparent hover:text-foreground'}`}
              >
                Remote
              </Button>
              <Button
                variant={subMode === 'local' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onViewModeChange?.(filesPane === 'files' ? 'all-local' : 'local')}
                className={`h-6 px-2 text-xs rounded-sm ${subMode === 'local' ? 'bg-background shadow-sm hover:bg-background' : 'hover:bg-transparent hover:text-foreground'}`}
              >
                Sandbox
              </Button>
            </div> */}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          error === 'SANDBOX_NOT_RUNNING' ? (
            <div className="h-full flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="text-sm text-muted-foreground">Sandbox is not running</div>
                <Button size="sm" onClick={handleStartSandbox} disabled={isStartingSandbox}>
                  {isStartingSandbox ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    'Start Sandbox'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-xs md:text-sm text-destructive">{error}</div>
            </div>
          )
        ) : files.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-xs md:text-sm text-muted-foreground">
              {viewMode === 'local'
                ? 'No changes in sandbox'
                : viewMode === 'remote'
                  ? 'No changes in PR'
                  : 'No files found'}
            </div>
          </div>
        ) : (
          <DropdownMenu
            open={contextMenuFile === '__root__'}
            onOpenChange={(open) => !open && setContextMenuFile(null)}
          >
            <div
              className={`py-2 px-1 min-h-full outline-none ${dropTarget === '__root__' ? 'bg-blue-500/10' : ''}`}
              onContextMenu={(e) => {
                if ((viewMode === 'local' || viewMode === 'all-local') && e.target === e.currentTarget)
                  handleContextMenu(e, '__root__')
              }}
              onDragOver={(e) => {
                if (viewMode === 'local' || viewMode === 'all-local') handleDragOver(e, '__root__')
              }}
              onDragLeave={handleDragLeave}
              onDrop={(e) => {
                if (viewMode === 'local' || viewMode === 'all-local') handleDrop(e, '__root__')
              }}
            >
              {renderFileTree(fileTree)}
            </div>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handlePaste()} disabled={!clipboardFile}>
                <Clipboard className="w-4 h-4 mr-2" />
                Paste<DropdownMenuShortcut>{isMac ? '⌘V' : 'Ctrl+V'}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Bottom Action Bar */}
      <div className="flex items-center justify-between gap-2 flex-shrink-0 pt-2">
        {viewMode === 'local' && files.length > 0 ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowSyncDialog(true)}
              disabled={isSyncing || isResetting}
              className="text-xs"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <GitCommit className="h-3 w-3 mr-1.5" />
                  Sync Changes
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowResetConfirm(true)}
              disabled={isSyncing || isResetting}
              className="text-xs"
            >
              {isResetting ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Resetting...
                </>
              ) : (
                <>
                  <RotateCcw className="h-3 w-3 mr-1.5" />
                  Reset
                </>
              )}
            </Button>
          </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-1">
          {viewMode === 'all-local' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowNewFileDialog(true)}
                disabled={loading}
                className="h-7 w-7 p-0"
                title="New File"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowNewFolderDialog(true)}
                disabled={loading}
                className="h-7 w-7 p-0"
                title="New Folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setState({ [viewMode]: { ...currentViewData, fetchAttempted: false } })
              fetchBranchFiles()
            }}
            disabled={loading}
            className="h-7 w-7 p-0"
            title="Refresh"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Dialogs */}
      <Dialog open={showSyncDialog} onOpenChange={setShowSyncDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sync Changes</DialogTitle>
            <DialogDescription>Enter a commit message for syncing your changes to the remote branch.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="sync-commit-message">Commit Message</Label>
            <Input
              id="sync-commit-message"
              value={syncCommitMessage}
              onChange={(e) => setSyncCommitMessage(e.target.value)}
              placeholder="Sync local changes"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSyncChanges()
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowSyncDialog(false)
                setSyncCommitMessage('')
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSyncChanges} disabled={isSyncing}>
              {isSyncing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Syncing...
                </>
              ) : (
                'Sync Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset all local changes in the sandbox to match the remote branch. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetConfirm(false)
                handleResetChanges()
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showCommitMessageDialog} onOpenChange={setShowCommitMessageDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit Message</DialogTitle>
            <DialogDescription>Enter a commit message for this reset operation (optional).</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="commit-message">Commit Message</Label>
            <Input
              id="commit-message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Reset changes"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleResetChanges()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCommitMessageDialog(false)
                setCommitMessage('')
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleResetChanges} disabled={isResetting}>
              {isResetting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Resetting...
                </>
              ) : (
                'Reset Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewFileDialog} onOpenChange={setShowNewFileDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New File</DialogTitle>
            <DialogDescription>
              {selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
                ? `Creating file in: ${selectedFile}/`
                : 'Enter the name for the new file (e.g., src/utils/helper.ts).'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="new-file-name">File Name</Label>
            <Input
              id="new-file-name"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder={
                selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
                  ? 'filename.ts'
                  : 'path/to/file.ts'
              }
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleCreateFile()
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowNewFileDialog(false)
                setNewFileName('')
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateFile} disabled={isCreatingFile || !newFileName.trim()}>
              {isCreatingFile ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create File'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Folder</DialogTitle>
            <DialogDescription>
              {selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
                ? `Creating folder in: ${selectedFile}/`
                : 'Enter the name for the new folder (e.g., src/components).'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="new-folder-name">Folder Name</Label>
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={
                selectedFile && files.some((f: FileChange) => f.filename.startsWith(selectedFile + '/'))
                  ? 'foldername'
                  : 'path/to/folder'
              }
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleCreateFolder()
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowNewFolderDialog(false)
                setNewFolderName('')
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder || !newFolderName.trim()}>
              {isCreatingFolder ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Folder'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{fileToDelete}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowDeleteConfirm(false)
                setFileToDelete(null)
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (fileToDelete) handleDelete(fileToDelete)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard Changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to discard changes to &quot;{fileToDiscard}&quot;? This will revert the file to its
              last committed state and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowDiscardConfirm(false)
                setFileToDiscard(null)
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardChanges} disabled={isDiscarding}>
              {isDiscarding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Discarding...
                </>
              ) : (
                'Discard Changes'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
