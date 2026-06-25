import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  // 部署到子路径（如 /ai/agent/acp-playground/）时用相对路径，
  // 避免 assets 404。根路径部署也兼容。
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // 直接引用 chat-core 源码（不打包），跟 web 行为一致
      '@coder/chat-core': path.resolve(__dirname, '../chat-core/src/index.ts'),
    },
    // 与 chat-core 共享同一份 jotai/react 模块
    dedupe: ['jotai', 'react', 'react-dom'],
  },
  server: {
    port: 5175,
    host: '0.0.0.0',
    proxy: {
      // 转发到本仓库 server，复用 web 的同源 cookie 认证
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})
