import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// Vite 配置：纯前端工程，无后端代理
export default defineConfig(({ command }) => ({
  // GitHub Pages 项目页部署在 https://<user>.github.io/TonePome/ 子路径下，
  // 因此构建产物必须带该前缀；本地 dev / preview 仍使用根路径，避免访问时多一层目录
  base: command === 'build' ? '/TonePome/' : '/',
  plugins: [vue()],
  resolve: {
    alias: {
      // 统一使用 @ 指向 src 目录，方便后续迭代时移动文件
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500
  }
}))
