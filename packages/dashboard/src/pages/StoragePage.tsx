import { useEffect, useState, useRef } from 'react'
import { useStorageAPI, BucketInfo, FileInfo } from '../services/storage'
import { useCapiClient } from '../services/capi'
import { Button } from '../components/ui'
import {
  FileUp,
  Folder,
  File,
  Trash2,
  Download,
  RefreshCw,
  Globe,
  ChevronRight,
  Home,
  Shield,
  Upload,
  FolderUp,
  Link,
  Copy,
  HardDrive,
  ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAtom } from 'jotai'
import { activeBucketAtom, storagePrefixAtom } from '../atoms/storage'
import BucketPermissions from '../components/storage/BucketPermissions'
import { cn } from '../utils/helpers'

function formatSize(bytes: number): string {
  if (bytes === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function BucketCard({ bucket }: { bucket: BucketInfo }) {
  return (
    <div className="flex items-start gap-4 px-5 py-3 border-b border-border-muted bg-bg-surface-100/20 shrink-0">
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg shrink-0',
          bucket.type === 'static' ? 'bg-violet-500/10' : 'bg-brand/10',
        )}
      >
        {bucket.type === 'static' ? (
          <Globe size={18} className="text-violet-400" strokeWidth={1.5} />
        ) : (
          <HardDrive size={18} className="text-brand" strokeWidth={1.5} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-default">{bucket.label}</span>
          {bucket.isPublic && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-medium">公开</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
          <span className="text-[11px] text-fg-muted font-mono truncate max-w-xs">{bucket.bucket || '-'}</span>
          {bucket.cdnDomain && (
            <a
              href={`https://${bucket.cdnDomain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] text-brand hover:underline"
            >
              <Link size={10} />
              {bucket.cdnDomain}
              <ExternalLink size={10} />
            </a>
          )}
          <span className="text-[11px] text-fg-muted">{bucket.region}</span>
        </div>
      </div>
    </div>
  )
}

export default function StoragePage() {
  const storageAPI = useStorageAPI()
  const capiClient = useCapiClient()
  const [activeBucket] = useAtom(activeBucketAtom)
  const [prefix, setPrefix] = useAtom(storagePrefixAtom)
  const [files, setFiles] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const loadFiles = () => {
    if (!activeBucket) return
    setLoading(true)
    storageAPI
      .listFiles(prefix, activeBucket)
      .then(setFiles)
      .catch((e) => toast.error('加载文件列表失败：' + e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!activeBucket) return
    setFiles([])
    loadFiles()
  }, [activeBucket, prefix])

  // 上传文件 & 上传文件夹共用同一个 onChange 处理函数。
  // 区别仅在于 <input> 元素的属性：
  //   - 上传文件：<input type="file" multiple>
  //   - 上传文件夹：<input type="file" webkitdirectory>
  // 通过 webkitRelativePath 自动保留文件夹的目录结构。
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const fileList = input.files
    if (!fileList || fileList.length === 0 || !activeBucket) return

    setUploading(true)

    try {
      const { successCount, errors } = await storageAPI.uploadFiles({
        files: Array.from(fileList),
        bucket: activeBucket,
        prefix,
      })

      if (errors.length > 0) {
        toast.error(`${errors.length} 个文件上传失败`)
      }
      if (successCount > 0) {
        toast.success(`成功上传 ${successCount} 个文件`)
        loadFiles()
      }
    } catch (err: any) {
      toast.error(`上传失败：${err.message}`)
    }

    // 重置两个 input 的值
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''
    setUploading(false)
  }

  const handleDownload = async (file: FileInfo) => {
    // 静态托管直接用公开 URL
    if (activeBucket?.type === 'static' && file.publicUrl) {
      window.open(file.publicUrl, '_blank')
      return
    }
    try {
      const url = await storageAPI.getDownloadUrl(file.key)
      window.open(url, '_blank')
    } catch {
      toast.error('获取下载链接失败')
    }
  }

  const handleDelete = async (file: FileInfo) => {
    if (!activeBucket || !confirm(`确认删除 "${file.name}"？`)) return
    try {
      await storageAPI.deleteFile(file.key, activeBucket.type)
      toast.success('已删除')
      setFiles((prev) => prev.filter((f) => f.key !== file.key))
    } catch {
      toast.error('删除失败')
    }
  }

  const handleCopyFileId = (file: FileInfo) => {
    const text = file.fileId || file.publicUrl || file.key
    navigator.clipboard.writeText(text)
    toast.success('已复制')
  }

  const breadcrumbs = prefix
    ? prefix
        .split('/')
        .filter(Boolean)
        .map((seg, i, arr) => ({
          label: seg,
          prefix: arr.slice(0, i + 1).join('/') + '/',
        }))
    : []

  const isStatic = activeBucket?.type === 'static'

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-default/70">
      {/* 隐藏的文件选择 input：上传文件（多选）和上传文件夹 */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={handleUpload}
        // @ts-expect-error webkitdirectory is a non-standard attribute
        webkitdirectory=""
        directory=""
      />

      {/* Header */}
      <div className="flex min-h-12 items-center justify-between border-b border-border-muted px-4 bg-bg-surface-100/30">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg-default">存储管理</span>
          {activeBucket && (
            <>
              <span className="text-xs text-fg-muted">·</span>
              <span className="text-xs text-fg-lighter">{activeBucket.label}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {activeBucket?.type === 'storage' && (
            <Button variant="ghost" size="tiny" onClick={() => setPermOpen(true)}>
              <Shield size={14} /> 权限
            </Button>
          )}
          <Button variant="outline" size="tiny" onClick={() => folderInputRef.current?.click()} loading={uploading}>
            <FolderUp size={14} /> {uploading ? '上传中...' : '上传文件夹'}
          </Button>
          <Button variant="primary" size="tiny" onClick={() => fileInputRef.current?.click()} loading={uploading}>
            <Upload size={14} /> {uploading ? '上传中...' : '上传'}
          </Button>
        </div>
      </div>

      {/* 桶信息卡片 */}
      {activeBucket && <BucketCard bucket={activeBucket} />}

      {/* 面包屑 */}
      <div className="flex items-center gap-1 px-5 h-8 border-b border-border-muted text-xs text-fg-lighter shrink-0">
        <button
          onClick={() => setPrefix('')}
          className="flex items-center gap-1 hover:text-fg-default transition-colors"
        >
          <Home size={11} /> 根目录
        </button>
        {breadcrumbs.map((bc, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={10} className="text-fg-muted" />
            <button onClick={() => setPrefix(bc.prefix)} className="hover:text-fg-default transition-colors">
              {bc.label}
            </button>
          </span>
        ))}
        <button onClick={loadFiles} className="ml-auto flex items-center gap-1 hover:text-fg-default transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {/* 文件列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-sm text-fg-lighter">加载中...</div>
        ) : !activeBucket ? (
          <div className="flex items-center justify-center h-40 text-sm text-fg-lighter">请在左侧选择存储桶</div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-3">
            <Folder size={28} className="text-fg-muted" />
            <p className="text-sm text-fg-lighter">当前目录为空</p>
            <Button variant="outline" size="tiny" onClick={() => fileInputRef.current?.click()}>
              <FileUp size={14} /> 上传文件
            </Button>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-surface-200/80 backdrop-blur-sm border-b border-border-default sticky top-0 z-10">
                <th className="text-left px-5 py-2 text-[11px] font-semibold text-fg-muted uppercase tracking-wider">
                  名称
                </th>
                {/* 云存储显示 fileId，静态托管显示公开 URL */}
                <th className="text-left px-4 py-2 text-[11px] font-semibold text-fg-muted uppercase tracking-wider">
                  {isStatic ? '公开链接' : 'File ID'}
                </th>
                <th className="text-left px-4 py-2 text-[11px] font-semibold text-fg-muted uppercase tracking-wider w-20">
                  大小
                </th>
                <th className="text-left px-4 py-2 text-[11px] font-semibold text-fg-muted uppercase tracking-wider w-36">
                  修改时间
                </th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  key={file.key}
                  className="border-b border-border-muted hover:bg-bg-surface-100 transition-colors group"
                  onDoubleClick={() => file.isDir && setPrefix(file.key)}
                >
                  {/* 名称 */}
                  <td className="px-5 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {file.isDir ? (
                        <Folder size={15} className={cn('shrink-0', isStatic ? 'text-violet-400' : 'text-brand')} />
                      ) : (
                        <File size={15} className="text-fg-lighter shrink-0" />
                      )}
                      <button
                        className="text-xs text-fg-default truncate hover:text-brand transition-colors text-left max-w-[200px]"
                        onClick={() => (file.isDir ? setPrefix(file.key) : handleDownload(file))}
                      >
                        {file.name}
                      </button>
                    </div>
                  </td>

                  {/* fileId / publicUrl */}
                  <td className="px-4 py-2">
                    {file.isDir ? (
                      <span className="text-xs text-fg-muted">-</span>
                    ) : isStatic && file.publicUrl ? (
                      <a
                        href={file.publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-brand hover:underline truncate max-w-[220px]"
                      >
                        <ExternalLink size={10} className="shrink-0" />
                        <span className="truncate">{file.publicUrl}</span>
                      </a>
                    ) : file.fileId ? (
                      <button
                        onClick={() => handleCopyFileId(file)}
                        className="flex items-center gap-1 text-[11px] text-fg-lighter hover:text-fg-default transition-colors max-w-[220px] group/id"
                        title={file.fileId}
                      >
                        <span className="font-mono truncate">{file.fileId}</span>
                        <Copy size={10} className="shrink-0 opacity-0 group-hover/id:opacity-100" />
                      </button>
                    ) : (
                      <span className="text-xs text-fg-muted">-</span>
                    )}
                  </td>

                  <td className="px-4 py-2 text-xs text-fg-lighter font-mono tabular-nums">
                    {file.isDir ? '-' : formatSize(file.size)}
                  </td>
                  <td className="px-4 py-2 text-xs text-fg-lighter tabular-nums">{formatDate(file.lastModified)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                      {!file.isDir && (
                        <button
                          onClick={() => handleDownload(file)}
                          className="p-1 rounded text-fg-muted hover:text-fg-default hover:bg-bg-surface-300 transition-colors"
                          title={isStatic ? '访问' : '下载'}
                        >
                          {isStatic ? <ExternalLink size={13} /> : <Download size={13} />}
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(file)}
                        className="p-1 rounded text-fg-muted hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-between px-5 h-8 border-t border-border-muted text-xs text-fg-muted shrink-0">
        <span>
          {files.filter((f) => !f.isDir).length} 个文件，{files.filter((f) => f.isDir).length} 个目录
        </span>
        {activeBucket?.isPublic && (
          <span className="flex items-center gap-1 text-violet-400">
            <Globe size={10} /> 公有读
          </span>
        )}
      </div>

      <BucketPermissions open={permOpen} onOpenChange={setPermOpen} bucket={activeBucket} />
    </div>
  )
}
