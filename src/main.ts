import { createApp } from 'vue'
import App from './App.vue'
import { initStore } from './core/store'
import './styles/global.css'

// 挂载前先初始化全局状态（读取 localStorage 中上次打开的工程）
initStore()

// 纯前端应用：无后端、无路由，直接挂载
createApp(App).mount('#app')
