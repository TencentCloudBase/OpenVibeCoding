import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  // 沙箱代理预览时需要设置 base，例如：VITE_BASE=/preview/5173/
  // 本地开发不需要设置，默认为 /
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 让 web 直接引用 dashboard 源码，vite 一起打包处理
      // 注意：子路径需要排在包名前面，否则会被包名前缀匹配吞掉
      '@coder/dashboard/storage': path.resolve(__dirname, '../dashboard/src/services/storage.ts'),
      '@coder/dashboard/CloudDashboard': path.resolve(__dirname, '../dashboard/src/CloudDashboard.tsx'),
      '@coder/dashboard': path.resolve(__dirname, '../dashboard/src'),
      // chat-core 直接引用源码，跟 dashboard 一致；workspace deps 也能解析，但显式 alias 更稳
      '@coder/chat-core': path.resolve(__dirname, '../chat-core/src/index.ts'),
    },
    // 防止 jotai 被重复实例化：web、dashboard、chat-core 必须共享同一份 module，
    // 否则 getDefaultStore() 在不同模块里返回的是不同的 store。
    dedupe: ['jotai', 'react', 'react-dom'],
  },
  define: {
    'process.env': {},
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE 流式响应需要禁用超时，否则 Vite proxy 会缓冲数据
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})
