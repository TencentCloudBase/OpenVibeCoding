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
      '@coder/dashboard': path.resolve(__dirname, '../dashboard/src'),
    },
    // 防止 jotai 被重复实例化：web 和 dashboard 必须共享同一份 module，
    // 否则 getDefaultStore() 在 dashboard 模块里和 web 模块里返回的是不同的 store。
    dedupe: ['jotai', 'react', 'react-dom'],
  },
  define: {
    'process.env': {},
  },
  server: {
    port: 5174,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        // SSE 流式响应需要禁用超时，否则 Vite proxy 会缓冲数据
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.error('[vite] /api proxy error:', err.message)
          })
        },
      },
    },
  },
})
