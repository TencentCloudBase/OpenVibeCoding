import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Switch } from '../../components/ui/switch'
import { toast } from 'sonner'
import { RefreshCw, Plus, Database, AlertCircle, CheckCircle, Clock, XCircle, Save } from 'lucide-react'

interface PoolData {
  enabled: boolean
  targetSize: number
  stats: {
    creating: number
    ready: number
    claimed: number
    failed: number
  }
}

const STATUS_CONFIG = {
  ready: {
    label: '就绪',
    icon: CheckCircle,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
  },
  creating: {
    label: '创建中',
    icon: Clock,
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
  },
  claimed: {
    label: '已认领',
    icon: Database,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
  },
  failed: { label: '失败', icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/5' },
} as const

export function AdminEnvPoolPage() {
  const [data, setData] = useState<PoolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [replenishing, setReplenishing] = useState(false)
  const [draining, setDraining] = useState(false)
  const [saving, setSaving] = useState(false)

  // 编辑状态
  const [editEnabled, setEditEnabled] = useState(false)
  const [editSize, setEditSize] = useState('2')

  const loadData = useCallback(async () => {
    try {
      const result = (await api.get('/api/admin/env-pool')) as PoolData
      setData(result)
      setEditEnabled(result.enabled)
      setEditSize(String(result.targetSize))
    } catch (e: any) {
      toast.error('加载失败', { description: e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  async function handleSaveConfig() {
    try {
      setSaving(true)
      await api.put('/api/admin/system-settings/env_pool_enabled', { value: editEnabled ? 'true' : 'false' })
      await api.put('/api/admin/system-settings/env_pool_size', { value: editSize })
      toast.success('配置已保存')
      await loadData()
    } catch (e: any) {
      toast.error('保存失败', { description: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleReplenish() {
    try {
      setReplenishing(true)
      await api.post('/api/admin/env-pool/replenish')
      toast.success('补充已触发', { description: '后台正在创建环境，稍后刷新查看' })
      setTimeout(loadData, 2000)
    } catch (e: any) {
      toast.error('触发失败', { description: e.message })
    } finally {
      setReplenishing(false)
    }
  }

  async function handleDrain() {
    if (!confirm('确认释放池中所有就绪环境？将销毁对应的云资源（CAM + 环境），不可恢复。')) return
    try {
      setDraining(true)
      const result = (await api.post('/api/admin/env-pool/drain')) as { drained: number; failed: number }
      toast.success(`释放完成：${result.drained} 个已销毁${result.failed > 0 ? `，${result.failed} 个失败` : ''}`)
      await loadData()
    } catch (e: any) {
      toast.error('释放失败', { description: e.message })
    } finally {
      setDraining(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载失败</div>
      </div>
    )
  }

  const { stats, enabled, targetSize } = data
  const fillPercent = targetSize > 0 ? Math.min(100, ((stats.ready + stats.creating) / targetSize) * 100) : 0
  const configDirty = editEnabled !== enabled || editSize !== String(targetSize)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">环境池</h1>
          <p className="text-muted-foreground mt-1">预创建 CloudBase 环境，加速 task 创建</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw className="h-4 w-4 mr-1" />
            刷新
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDrain} disabled={draining || !data?.stats.ready}>
            <XCircle className="h-4 w-4 mr-1" />
            {draining ? '释放中...' : '释放池'}
          </Button>
          <Button size="sm" onClick={handleReplenish} disabled={replenishing || !enabled}>
            <Plus className="h-4 w-4 mr-1" />
            {replenishing ? '触发中...' : '手动补充'}
          </Button>
        </div>
      </div>

      {/* Config Card */}
      <Card className="p-6">
        <div className="space-y-4">
          <h2 className="text-lg font-medium">池配置</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">启用环境池</Label>
                <p className="text-xs text-muted-foreground">开启后自动预创建环境</p>
              </div>
              <Switch checked={editEnabled} onCheckedChange={setEditEnabled} />
            </div>
            <div className="rounded-lg border p-4 space-y-2">
              <Label htmlFor="pool-size" className="text-sm font-medium">
                池容量
              </Label>
              <Input
                id="pool-size"
                type="number"
                min={1}
                max={50}
                value={editSize}
                onChange={(e) => setEditSize(e.target.value)}
                className="h-8"
              />
              <p className="text-xs text-muted-foreground">同时保持就绪的环境数量</p>
            </div>
          </div>
          {configDirty && (
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveConfig} disabled={saving}>
                <Save className="h-4 w-4 mr-1" />
                {saving ? '保存中...' : '保存配置'}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Status Card */}
      <Card className="p-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">池状态</h2>
            <Badge variant={enabled ? 'default' : 'secondary'}>{enabled ? '运行中' : '未启用'}</Badge>
          </div>

          {!enabled && (
            <div className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                环境池未启用。在上方开启后保存配置，然后点击"手动补充"开始预创建。
              </p>
            </div>
          )}

          {/* Progress bar */}
          {enabled && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  活跃容量：{stats.ready + stats.creating} / {targetSize}
                </span>
                <span className="text-muted-foreground">{fillPercent.toFixed(0)}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${fillPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(Object.keys(STATUS_CONFIG) as Array<keyof typeof STATUS_CONFIG>).map((status) => {
              const config = STATUS_CONFIG[status]
              const Icon = config.icon
              const count = stats[status] || 0
              return (
                <div key={status} className={`rounded-lg border p-3 ${config.bg}`}>
                  <div className="flex items-center gap-2">
                    <Icon className={`h-4 w-4 ${config.color}`} />
                    <span className={`text-sm font-medium ${config.color}`}>{config.label}</span>
                  </div>
                  <p className="text-2xl font-bold mt-1">{count}</p>
                </div>
              )
            })}
          </div>

          <p className="text-xs text-muted-foreground">自动刷新间隔：10 秒</p>
        </div>
      </Card>
    </div>
  )
}
