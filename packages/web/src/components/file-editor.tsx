import { useState, useEffect, useCallback, useRef } from 'react'
import { TASK_LOG } from '@coder/shared'
import { toast } from 'sonner'
import { pushLiveTaskLog } from '@/lib/push-live-task-log'
import Editor, { type OnMount } from '@monaco-editor/react'

// Monaco types for editor and monaco instances
type MonacoEditor = Parameters<OnMount>[0]
type Monaco = Parameters<OnMount>[1]

interface FileEditorProps {
  filename: string
  initialContent: string
  language: string
  taskId: string
  viewMode?: 'local' | 'remote' | 'all' | 'all-local'
  onUnsavedChanges?: (hasChanges: boolean) => void
  onSavingStateChange?: (isSaving: boolean) => void
  onOpenFile?: (filename: string, lineNumber?: number) => void
  onSaveSuccess?: () => void
}

// Helper function to map file extensions to Monaco language IDs
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'shell',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
  }
  return map[ext || ''] || 'plaintext'
}

// Simple theme detection hook (replacing next-themes useTheme)
function useEditorTheme() {
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const detectTheme = () => {
      const htmlEl = document.documentElement
      // Prefer explicit class on <html>, fall back to system preference
      if (htmlEl.classList.contains('dark')) {
        setCurrentTheme('dark')
      } else if (htmlEl.classList.contains('light')) {
        setCurrentTheme('light')
      } else {
        setCurrentTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      }
    }

    detectTheme()

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => detectTheme()
    mediaQuery.addEventListener('change', handleChange)

    const observer = new MutationObserver(handleChange)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
      observer.disconnect()
    }
  }, [])

  return currentTheme
}

export function FileEditor({
  filename,
  initialContent,
  language: _language,
  taskId,
  viewMode = 'local',
  onUnsavedChanges,
  onSavingStateChange,
  onOpenFile,
  onSaveSuccess,
}: FileEditorProps) {
  const currentTheme = useEditorTheme()
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)
  const [savedContent, setSavedContent] = useState(initialContent)
  const [fontSize, setFontSize] = useState(16) // Default to 16px for mobile
  const editorRef = useRef<MonacoEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const onUnsavedChangesRef = useRef(onUnsavedChanges)
  const onSavingStateChangeRef = useRef(onSavingStateChange)
  const onOpenFileRef = useRef(onOpenFile)
  const onSaveSuccessRef = useRef(onSaveSuccess)
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null)

  // Set responsive font size based on screen width
  useEffect(() => {
    const updateFontSize = () => {
      // Use 16px on mobile (< 768px) to prevent zoom, 13px on desktop
      setFontSize(window.innerWidth < 768 ? 16 : 13)
    }

    // Set initial font size
    updateFontSize()

    // Update on resize
    window.addEventListener('resize', updateFontSize)
    return () => window.removeEventListener('resize', updateFontSize)
  }, [])

  // Keep refs updated
  useEffect(() => {
    onUnsavedChangesRef.current = onUnsavedChanges
  }, [onUnsavedChanges])

  useEffect(() => {
    onSavingStateChangeRef.current = onSavingStateChange
  }, [onSavingStateChange])

  useEffect(() => {
    onOpenFileRef.current = onOpenFile
  }, [onOpenFile])

  useEffect(() => {
    onSaveSuccessRef.current = onSaveSuccess
  }, [onSaveSuccess])

  useEffect(() => {
    setContent(initialContent)
    setSavedContent(initialContent)
  }, [filename, initialContent])

  useEffect(() => {
    // Don't track unsaved changes for node_modules files (they're read-only)
    const isNodeModules = filename.includes('/node_modules/')
    if (!isNodeModules) {
      const hasChanges = content !== savedContent
      if (onUnsavedChangesRef.current) {
        onUnsavedChangesRef.current(hasChanges)
      }
    }
  }, [content, savedContent, filename])

  const handleContentChange = (newContent: string | undefined) => {
    if (newContent !== undefined) {
      setContent(newContent)
    }
  }

  const handleSave = useCallback(async () => {
    const currentContent = editorRef.current?.getValue()

    if (!currentContent || isSaving || currentContent === savedContent) {
      return
    }

    setIsSaving(true)
    if (onSavingStateChangeRef.current) {
      onSavingStateChangeRef.current(true)
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}/save-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename,
          content: currentContent,
        }),
      })

      const data = await response.json()

      if (response.ok && data.success) {
        setSavedContent(currentContent)
        toast.success('文件已保存')
        pushLiveTaskLog(taskId, { type: 'success', message: TASK_LOG.WORKSPACE_FILE_SAVED }, { persist: false })
        // Notify parent component of successful save
        if (onSaveSuccessRef.current) {
          onSaveSuccessRef.current()
        }
      } else {
        pushLiveTaskLog(taskId, { type: 'error', message: TASK_LOG.WORKSPACE_FILE_SAVE_FAILED }, { persist: false })
        toast.error(data.error || 'Failed to save file')
      }
    } catch (error) {
      console.error('Error saving file:', error)
      pushLiveTaskLog(taskId, { type: 'error', message: TASK_LOG.WORKSPACE_FILE_SAVE_FAILED })
      toast.error('Failed to save file')
    } finally {
      setIsSaving(false)
      if (onSavingStateChangeRef.current) {
        onSavingStateChangeRef.current(false)
      }
    }
  }, [isSaving, savedContent, taskId, filename])

  // Keep handleSave ref updated
  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  const loadProjectFiles = useCallback(async () => {
    // The LSP endpoint will handle all type resolution on demand
  }, [])

  // Define themes before mount to prevent light mode flash
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    // Define Vercel/Geist dark theme
    monaco.editor.defineTheme('vercel-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: 'ededed' },
        { token: 'comment', foreground: 'a1a1a1' },
        { token: 'keyword', foreground: 'ff6b9d' },
        { token: 'string', foreground: '79f2a8' },
        { token: 'string.escape', foreground: '79f2a8' },
        { token: 'number', foreground: 'ffffff' },
        { token: 'constant', foreground: '9ca7ff' },
        { token: 'constant.numeric', foreground: 'ffffff' },
        { token: 'variable', foreground: 'ededed' },
        { token: 'variable.parameter', foreground: 'ffd494' },
        { token: 'function', foreground: 'ea94ea' },
        { token: 'identifier', foreground: 'ededed' },
        { token: 'type', foreground: '9ca7ff' },
        { token: 'type.identifier', foreground: '9ca7ff' },
        { token: 'class.name', foreground: '9ca7ff' },
        { token: 'delimiter', foreground: 'ededed' },
        { token: 'delimiter.bracket', foreground: 'ededed' },
        { token: 'tag', foreground: 'ff6b9d' },
        { token: 'tag.id', foreground: '9ca7ff' },
        { token: 'tag.class', foreground: '9ca7ff' },
        { token: 'attribute.name', foreground: '9ca7ff' },
        { token: 'attribute.value', foreground: '79f2a8' },
        { token: 'meta.tag', foreground: 'ededed' },
      ],
      colors: {
        'editor.background': '#000000',
        'editor.foreground': '#ededed',
        'editor.lineHighlightBackground': '#1a1a1a',
        'editorLineNumber.foreground': '#6b6b6b',
        'editorLineNumber.activeForeground': '#a1a1a1',
        'editor.selectionBackground': '#3d5a80',
        'editor.inactiveSelectionBackground': '#2d4a60',
        'editorCursor.foreground': '#ededed',
        'editorWhitespace.foreground': '#3a3a3a',
        'editorIndentGuide.background': '#1a1a1a',
        'editorIndentGuide.activeBackground': '#2a2a2a',
        'editorBracketMatch.background': '#1a1a1a',
        'editorBracketMatch.border': '#9ca7ff',
      },
    })

    // Define Vercel/Geist light theme
    monaco.editor.defineTheme('vercel-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '171717' },
        { token: 'comment', foreground: '666666' },
        { token: 'keyword', foreground: 'd63384' },
        { token: 'string', foreground: '028a5a' },
        { token: 'string.escape', foreground: '028a5a' },
        { token: 'number', foreground: '111111' },
        { token: 'constant', foreground: '0550ae' },
        { token: 'constant.numeric', foreground: '111111' },
        { token: 'variable', foreground: '171717' },
        { token: 'variable.parameter', foreground: 'c77700' },
        { token: 'function', foreground: '8250df' },
        { token: 'identifier', foreground: '171717' },
        { token: 'type', foreground: '0550ae' },
        { token: 'type.identifier', foreground: '0550ae' },
        { token: 'class.name', foreground: '0550ae' },
        { token: 'delimiter', foreground: '171717' },
        { token: 'delimiter.bracket', foreground: '171717' },
        { token: 'tag', foreground: 'd63384' },
        { token: 'tag.id', foreground: '0550ae' },
        { token: 'tag.class', foreground: '0550ae' },
        { token: 'attribute.name', foreground: '0550ae' },
        { token: 'attribute.value', foreground: '028a5a' },
        { token: 'meta.tag', foreground: '171717' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#171717',
        'editor.lineHighlightBackground': '#f8f8f8',
        'editorLineNumber.foreground': '#9ca3af',
        'editorLineNumber.activeForeground': '#666666',
        'editor.selectionBackground': '#b3d7ff',
        'editor.inactiveSelectionBackground': '#d3e5f8',
        'editorCursor.foreground': '#171717',
        'editorWhitespace.foreground': '#e5e5e5',
        'editorIndentGuide.background': '#f0f0f0',
        'editorIndentGuide.activeBackground': '#e0e0e0',
        'editorBracketMatch.background': '#f0f0f0',
        'editorBracketMatch.border': '#0550ae',
      },
    })
  }, [])

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // IMPORTANT: Set the model to use a file:// URI so TypeScript service can resolve imports
    const model = editor.getModel()
    if (model) {
      const currentUri = model.uri.toString()

      // Normalize filename to always have leading slash
      const normalizedFilename = filename.startsWith('/') ? filename : `/${filename}`
      const expectedUri = `file://${normalizedFilename}`

      // Check if we need to recreate the model with the correct URI
      if (currentUri !== expectedUri) {
        // Get current content
        const currentContent = model.getValue()

        // Check if a model with the expected URI already exists
        const newUri = monaco.Uri.parse(expectedUri)
        const existingModel = monaco.editor.getModel(newUri)

        if (existingModel) {
          // Dispose the temporary model
          model.dispose()
          // Set the existing model on the editor
          editor.setModel(existingModel)
          // Update content if needed
          if (existingModel.getValue() !== currentContent) {
            existingModel.setValue(currentContent)
          }
        } else {
          // Dispose the old model
          model.dispose()

          // Create new model with correct URI
          const language = getLanguageFromPath(normalizedFilename)
          const newModel = monaco.editor.createModel(currentContent, language, newUri)

          // Set the new model on the editor
          editor.setModel(newModel)
        }
      }
    }

    // Disable Monaco's built-in TypeScript diagnostics since we're using the sandbox LSP
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
    })

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: true,
    })

    // Still configure compiler options for basic syntax highlighting
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.React,
      reactNamespace: 'React',
      allowJs: true,
      typeRoots: ['node_modules/@types'],
    })

    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.React,
      reactNamespace: 'React',
      allowJs: true,
    })

    // Load project files for IntelliSense (currently disabled - using LSP instead)
    loadProjectFiles()

    // Add save command (Cmd/Ctrl + S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (handleSaveRef.current) {
        handleSaveRef.current()
      }
    })

    // Helper function to get definitions using remote LSP server in sandbox
    const getDefinitions = async (
      model: ReturnType<MonacoEditor['getModel']>,
      position: ReturnType<MonacoEditor['getPosition']>,
    ) => {
      if (!model || !position) return null

      // Show loading cursor and toast
      if (editorRef.current) {
        const editorDom = editorRef.current.getDomNode()
        if (editorDom) {
          editorDom.style.cursor = 'wait'
        }
      }

      const loadingToast = toast.loading('Finding definition...')

      try {
        // Call the LSP API endpoint
        const response = await fetch(`/api/tasks/${taskId}/lsp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            method: 'textDocument/definition',
            filename,
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
          }),
        })

        if (!response.ok) {
          toast.dismiss(loadingToast)
          toast.error('Failed to find definition')
          return null
        }

        const data = await response.json()

        if (!data.definitions || data.definitions.length === 0) {
          toast.dismiss(loadingToast)
          toast.info('No definition found')
          return null
        }

        // Convert LSP response to Monaco Location format
        interface LspDefinition {
          uri: string
          range: {
            start: { line: number; character: number }
            end: { line: number; character: number }
          }
        }

        const convertedDefinitions = (data.definitions as LspDefinition[]).map((def) => {
          return {
            uri: monaco.Uri.parse(def.uri),
            range: {
              startLineNumber: def.range.start.line + 1,
              startColumn: def.range.start.character + 1,
              endLineNumber: def.range.end.line + 1,
              endColumn: def.range.end.character + 1,
            },
          }
        })

        // Dismiss loading toast
        toast.dismiss(loadingToast)

        return convertedDefinitions
      } catch (error) {
        console.error('[Go to Definition] Error getting definitions:', error)
        toast.dismiss(loadingToast)
        toast.error('Failed to find definition')
        return null
      } finally {
        // Reset cursor
        if (editorRef.current) {
          const editorDom = editorRef.current.getDomNode()
          if (editorDom) {
            editorDom.style.cursor = ''
          }
        }
      }
    }

    // Override Go to Definition command to handle cross-file navigation
    editor.addAction({
      id: 'editor.action.revealDefinition.custom',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: async (ed) => {
        const model = ed.getModel()
        const position = ed.getPosition()

        if (!model || !position) return

        const definitions = await getDefinitions(model, position)

        if (!definitions || definitions.length === 0) return

        const definition = definitions[0]
        const targetUri = definition.uri.toString()
        const currentUri = model.uri.toString()

        // Check if the definition is in a different file
        if (targetUri !== currentUri) {
          let filePath = targetUri.replace('file://', '')
          filePath = filePath.replace(/^\/vercel\/sandbox/, '')

          if (onOpenFileRef.current) {
            onOpenFileRef.current(filePath, definition.range.startLineNumber)
          }
        } else {
          ed.setPosition({
            lineNumber: definition.range.startLineNumber,
            column: definition.range.startColumn,
          })
          ed.revealLineInCenter(definition.range.startLineNumber)
        }
      },
    })

    // Also handle Cmd/Ctrl + Click (go to definition)
    editor.onMouseDown(async (e) => {
      if (e.event.leftButton && (e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        const model = editor.getModel()
        if (!model) return

        const definitions = await getDefinitions(model, e.target.position)
        if (!definitions || definitions.length === 0) return

        const definition = definitions[0]
        const targetUri = definition.uri.toString()
        const currentUri = model.uri.toString()

        if (targetUri !== currentUri) {
          let filePath = targetUri.replace('file://', '')
          filePath = filePath.replace(/^\/vercel\/sandbox/, '')
          if (onOpenFileRef.current) {
            onOpenFileRef.current(filePath, definition.range.startLineNumber)
          }
        } else {
          editor.setPosition({
            lineNumber: definition.range.startLineNumber,
            column: definition.range.startColumn,
          })
          editor.revealLineInCenter(definition.range.startLineNumber)
        }
      }
    })
  }

  // Keyboard shortcut for save (Cmd/Ctrl + S) - fallback for outside editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (handleSaveRef.current) {
          handleSaveRef.current()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Check if this is a node_modules file (read-only)
  const isNodeModulesFile = filename.includes('/node_modules/')

  // Remote files (from GitHub) should be read-only
  const isRemoteFile = viewMode === 'remote' || viewMode === 'all'
  const isReadOnly = isNodeModulesFile || isRemoteFile

  return (
    <div className="flex flex-col h-full">
      {isNodeModulesFile && (
        <div className="px-3 py-2 text-xs bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400">
          Read-only: node_modules file
        </div>
      )}
      {isRemoteFile && !isNodeModulesFile && (
        <div className="px-3 py-2 text-xs bg-blue-500/10 border-b border-blue-500/20 text-blue-600 dark:text-blue-400">
          Read-only: Remote file (from GitHub)
        </div>
      )}
      <Editor
        height="100%"
        language={getLanguageFromPath(filename)}
        value={content}
        onChange={handleContentChange}
        beforeMount={handleBeforeMount}
        onMount={handleEditorMount}
        theme={currentTheme === 'dark' ? 'vercel-dark' : 'vercel-light'}
        keepCurrentModel={true}
        options={{
          readOnly: isReadOnly,
          minimap: { enabled: false },
          fontSize: fontSize,
          lineHeight: 20,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          lineNumbers: 'on',
          wordWrap: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderWhitespace: 'none',
          tabSize: 2,
          insertSpaces: true,
          folding: true,
          matchBrackets: 'always',
          padding: { top: 8 },
          renderLineHighlight: 'line',
          overviewRulerBorder: false,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
        }}
      />
    </div>
  )
}
