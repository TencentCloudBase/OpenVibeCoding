import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { Label } from '../../components/ui/label'
import { toast } from 'sonner'
import { Save, AlertTriangle, RotateCcw } from 'lucide-react'

const PROVISION_MODES = [
  {
    value: 'shared',
    label: '共享环境',
    description: '所有用户共享一个 CloudBase 环境，适合小团队、低成本场景',
    badge: '默认',
  },
  {
    value: 'isolated',
    label: '按用户隔离',
    description: '每个用户独立一个 CloudBase 环境，适合企业级数据隔离需求',
    badge: '企业',
  },
  {
    value: 'task',
    label: '按任务隔离',
    description: '每个任务创建独立 CloudBase 环境，适合多项目并行的企业（环境信息关联在任务上）',
    badge: '高级',
  },
] as const

const SANDBOX_INSTANCE_MODES = [
  {
    value: 'shared',
    label: '共享实例',
    description: '同一 CloudBase 环境下的所有任务共用一个 AGS 沙箱实例（共盘 /home/user）',
    badge: '默认',
  },
  {
    value: 'isolated',
    label: '按任务隔离',
    description: '每个任务独立一个 AGS 沙箱实例；删除任务会停止对应实例',
    badge: '隔离',
  },
] as const

type ProvisionSource = 'db' | 'env' | 'default'
interface ProvisionMeta {
  source: ProvisionSource
  envDefault: string
}

const SOURCE_LABEL: Record<ProvisionSource, { text: string; tone: string }> = {
  db: { text: 'DB（管理员设置）', tone: 'bg-primary/10 text-primary border-primary/20' },
  env: {
    text: 'Env（部署配置）',
    tone: 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  },
  default: { text: '默认值', tone: 'bg-muted text-muted-foreground border-border' },
}

export function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [meta, setMeta] = useState<ProvisionMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [provisionMode, setProvisionMode] = useState('shared')
  const [sandboxInstanceMeta, setSandboxInstanceMeta] = useState<ProvisionMeta | null>(null)
  const [sandboxInstanceMode, setSandboxInstanceMode] = useState('shared')
  const [savingInstance, setSavingInstance] = useState(false)
  const [resettingInstance, setResettingInstance] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    try {
      setLoading(true)
      const data = (await api.get('/api/admin/system-settings')) as {
        settings: Record<string, string>
        meta?: {
          provision_mode?: ProvisionMeta
          sandbox_instance_mode?: ProvisionMeta
        }
      }
      setSettings(data.settings)
      setMeta(data.meta?.provision_mode ?? null)
      setSandboxInstanceMeta(data.meta?.sandbox_instance_mode ?? null)
      setProvisionMode(data.settings['provision_mode'] || 'shared')
      setSandboxInstanceMode(data.settings['sandbox_instance_mode'] || 'shared')
    } catch (e: any) {
      toast.error('加载设置失败', { description: e.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    try {
      setSaving(true)
      await api.put('/api/admin/system-settings/provision_mode', { value: provisionMode })
      toast.success('设置已保存')
      await loadSettings() // 重新加载以更新 meta.source
    } catch (e: any) {
      toast.error('保存失败', { description: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    try {
      setResetting(true)
      await api.delete('/api/admin/system-settings/provision_mode')
      toast.success('已重置为部署默认值')
      await loadSettings()
    } catch (e: any) {
      toast.error('重置失败', { description: e.message })
    } finally {
      setResetting(false)
    }
  }

  async function handleSaveInstance() {
    try {
      setSavingInstance(true)
      await api.put('/api/admin/system-settings/sandbox_instance_mode', { value: sandboxInstanceMode })
      toast.success('沙箱实例策略已保存')
      await loadSettings()
    } catch (e: any) {
      toast.error('保存失败', { description: e.message })
    } finally {
      setSavingInstance(false)
    }
  }

  async function handleResetInstance() {
    try {
      setResettingInstance(true)
      await api.delete('/api/admin/system-settings/sandbox_instance_mode')
      toast.success('已重置为部署默认值')
      await loadSettings()
    } catch (e: any) {
      toast.error('重置失败', { description: e.message })
    } finally {
      setResettingInstance(false)
    }
  }

  const isDirty = provisionMode !== (settings['provision_mode'] || 'shared')
  const isInstanceDirty = sandboxInstanceMode !== (settings['sandbox_instance_mode'] || 'shared')
  const fromDb = meta?.source === 'db'
  const sourceInfo = meta ? SOURCE_LABEL[meta.source] : null
  const instanceFromDb = sandboxInstanceMeta?.source === 'db'
  const instanceSourceInfo = sandboxInstanceMeta ? SOURCE_LABEL[sandboxInstanceMeta.source] : null

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">平台设置</h1>
        <p className="text-muted-foreground mt-1">管理 VibeCoding 平台的全局配置</p>
      </div>

      {/* Provision Mode */}
      <Card className="p-6">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">环境隔离粒度</h2>
              {sourceInfo && (
                <Badge variant="outline" className={`text-xs ${sourceInfo.tone}`}>
                  来源：{sourceInfo.text}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">控制用户开通时 CloudBase 云开发环境的分配策略</p>
            <p className="text-xs text-muted-foreground">
              优先级：管理员设置（DB） &gt; 部署环境变量{' '}
              <code className="px-1 rounded bg-muted">TCB_PROVISION_MODE</code> &gt; 默认{' '}
              <code className="px-1 rounded bg-muted">shared</code>
            </p>
          </div>

          <RadioGroup value={provisionMode} onValueChange={setProvisionMode} className="space-y-3">
            {PROVISION_MODES.map((mode) => (
              <label
                key={mode.value}
                className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                  provisionMode === mode.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <RadioGroupItem value={mode.value} id={mode.value} className="mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={mode.value} className="text-sm font-medium cursor-pointer">
                      {mode.label}
                    </Label>
                    <Badge variant="outline" className="text-xs">
                      {mode.badge}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{mode.description}</p>
                </div>
              </label>
            ))}
          </RadioGroup>

          {isDirty && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                更改环境隔离粒度仅对新注册用户/新任务生效，不影响已有用户的现有环境配置。
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {fromDb && meta && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting || saving}
                size="sm"
                title={`回落到环境变量值：${meta.envDefault}`}
              >
                <RotateCcw className="h-4 w-4 mr-1" />
                {resetting ? '重置中...' : `重置为部署默认（${meta.envDefault}）`}
              </Button>
            )}
            <Button onClick={handleSave} disabled={!isDirty || saving || resetting} size="sm">
              <Save className="h-4 w-4 mr-1" />
              {saving ? '保存中...' : '保存设置'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">沙箱实例复用</h2>
              {instanceSourceInfo && (
                <Badge variant="outline" className={`text-xs ${instanceSourceInfo.tone}`}>
                  来源：{instanceSourceInfo.text}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              控制同一 CloudBase 环境下，多个任务是否共用同一个 AGS 运行时实例（与上方「环境隔离」正交）
            </p>
            <p className="text-xs text-muted-foreground">
              优先级：管理员设置（DB） &gt; <code className="px-1 rounded bg-muted">SANDBOX_INSTANCE_MODE</code>{' '}
              &gt; 默认（provision=task 时为 isolated，否则 shared）
            </p>
          </div>

          <RadioGroup
            value={sandboxInstanceMode}
            onValueChange={setSandboxInstanceMode}
            className="space-y-3"
          >
            {SANDBOX_INSTANCE_MODES.map((mode) => (
              <label
                key={mode.value}
                className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                  sandboxInstanceMode === mode.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <RadioGroupItem value={mode.value} id={`sandbox-${mode.value}`} className="mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`sandbox-${mode.value}`} className="text-sm font-medium cursor-pointer">
                      {mode.label}
                    </Label>
                    <Badge variant="outline" className="text-xs">
                      {mode.badge}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{mode.description}</p>
                </div>
              </label>
            ))}
          </RadioGroup>

          {isInstanceDirty && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                仅对新创建的任务生效；已有任务的 sandboxMode 不变。
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {instanceFromDb && sandboxInstanceMeta && (
              <Button
                variant="outline"
                onClick={handleResetInstance}
                disabled={resettingInstance || savingInstance}
                size="sm"
                title={`回落到环境变量值：${sandboxInstanceMeta.envDefault}`}
              >
                <RotateCcw className="h-4 w-4 mr-1" />
                {resettingInstance ? '重置中...' : `重置为部署默认（${sandboxInstanceMeta.envDefault}）`}
              </Button>
            )}
            <Button
              onClick={handleSaveInstance}
              disabled={!isInstanceDirty || savingInstance || resettingInstance}
              size="sm"
            >
              <Save className="h-4 w-4 mr-1" />
              {savingInstance ? '保存中...' : '保存设置'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
