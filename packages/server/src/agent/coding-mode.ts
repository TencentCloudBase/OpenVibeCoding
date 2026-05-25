const DEV_SERVER_PORT = 5173

/**
 * The correct vite.config.ts content for CloudBase sandbox preview.
 * - base "./" for static hosting deployment (relative asset paths)
 * - dev server is launched with --base=/ (TRW vite-dev-manager) which overrides this for preview
 * - server.host "0.0.0.0" lets the CloudBase gateway proxy reach the dev server
 * - server.allowedHosts true allows requests from the gateway domain
 */
const SANDBOX_VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CloudBase sandbox preview setup:
// - base "./" for static hosting deployment (relative asset paths)
// - dev server is launched with --base=/ (TRW vite-dev-manager) which overrides this for preview
// - server.host "0.0.0.0" lets the CloudBase gateway proxy reach the dev server
// - server.allowedHosts true allows requests from the gateway domain
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
  },
});
`

// ─── Exports ───────────────────────────────────────────────────────────────

/**
 * Returns the system prompt for coding mode.
 * The project is seeded from a CloudBase Web template (React + Vite + Tailwind + DaisyUI).
 * The agent should modify the existing template rather than scaffold from scratch.
 */
export function getCodingSystemPrompt(envId: string, publishableKey: string): string {
  return `<coding-mode>
当前处于 Coding 模式，你正在一个基于 CloudBase Web 项目模板的 React 应用中工作。
模板已包含完整的项目脚手架，请基于已有代码进行页面修改和功能开发，不要从零搭建项目。

<IMPORTANT>
IMPORTANT: 必须先读取 src/utils/cloudbase.ts，将其中的 ENV_ID 和 PUBLISHABLE_KEY 替换为当前环境的真实值。
IMPORTANT: 直接修改代码而非创建 .env 文件。有关登录态判断时使用 auth-web-cloudbase skill 使用 supabase-like 的 api，如果需要注册，不支持用户名密码注册，需要邮箱/手机号【验证码】注册并同时设置用户名密码，同时需要先开启 邮箱/手机号 登录，邮箱 smtp 配置默认 { "SenderAddress": "cloudbase_noreply@tencent.com", "ServerHost": "","ServerPort": 0,"AccountUsername": "","SecurityMode": "SSL"}。
- ENV_ID：${envId}
- PUBLISHABLE_KEY：${publishableKey}
IMPORTANT: 注意数据库权限，默认 PUBLISHABLE_KEY 时是匿名身份，刚开始数据库最好公有读写（ aclTag: CUSTOM, rule: { "read": true, "write": true } ），方便调试，后续完善。
IMPORTANT: 页面需要做好 error 处理，显示出具体的错误堆栈信息，而非直接 crash。需要 toast 等方式显示而非 console 打印。
</IMPORTANT>

<tech-stack>
- React 19 + Shadcn + Tailwind CSS + lucide-react + Vite 6
- React Router（客户端路由）
- @cloudbase/js-sdk（云开发前端 SDK）
</tech-stack>

<workspace-location>
项目代码在 **远程沙箱** 的 \`/home/user\`（或 prepare 返回的 workspace），不在本机 \`/tmp\` / \`ovc-agent\` 目录。
用户问 pwd、列文件、统计文件数：必须用 **Bash/Read/Glob** 在远程执行后作答，禁止根据 SDK 本机会话目录猜测。
</workspace-location>

<dev-rules>
1. 仅使用以上技术栈，除非用户明确要求，不要引入新框架或库。
2. 新组件放在 src/components/，新页面放在 src/pages/ 并在 src/App.tsx 注册路由。
3. 代码修改后 Vite HMR 会自动热更新，不需要手动重启 dev server。
4. 一轮对话内完成所有工作：写好所有文件、安装依赖、确保应用能运行，不要期望用户追问后再继续。
5. 开发前端应用时，推荐使用 @cloudbase/js-sdk 直接操作数据库（BaaS 模式，无需后端中转），也可以编写云函数作为后端接口。
6. 注意应用的完整性：确保前端 UI、数据持久化、接口调用、错误处理都完整实现，不要只写半成品。
</dev-rules>
</coding-mode>`
}

export const CODING_DEV_SERVER_PORT = DEV_SERVER_PORT
