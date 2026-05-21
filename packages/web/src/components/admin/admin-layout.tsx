import { NavLink, Outlet, useNavigate } from 'react-router'
import { Users, ListTodo, FileText, ArrowLeft, Menu, Settings, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { User } from '@/components/auth/user'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/admin/users', icon: Users, label: '用户管理' },
  { to: '/admin/tasks', icon: ListTodo, label: '任务管理' },
  { to: '/admin/logs', icon: FileText, label: '操作日志' },
  { to: '/admin/env-pool', icon: Database, label: '环境池' },
  { to: '/admin/settings', icon: Settings, label: '平台设置' },
]

export function AdminLayout() {
  const navigate = useNavigate()

  return (
    <div className="h-dvh flex">
      {/* Sidebar - same style as TaskSidebar */}
      <aside className="w-64 border-r bg-muted/30 flex flex-col flex-shrink-0">
        {/* Header - matches sidebar header style */}
        <div className="px-2 md:px-3 pt-3 md:pt-5.5 pb-3 md:pb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium tracking-wide px-2 py-1 rounded text-foreground bg-accent">
                管理后台
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => navigate('/')}
              title="返回任务列表"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Navigation items - matches task list style */}
        <nav className="flex-1 overflow-y-auto px-2 md:px-3 pb-3 md:pb-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content area - matches AppLayout main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar - matches SharedHeader style */}
        <div className="flex-shrink-0 px-0 pt-0.5 md:pt-3 pb-1.5 md:pb-4">
          <div className="flex items-center justify-between gap-2 h-8 min-w-0 px-3">
            <div className="flex items-center gap-2 min-w-0">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => navigate('/')} title="返回">
                <Menu className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <User />
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-auto px-4 pb-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
