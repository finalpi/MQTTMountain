# MqttMountain

一款高性能的跨平台 MQTT 桌面客户端，基于 **Electron + Vue 3 + TypeScript**。专为**超大数据量**场景打造，百万级消息稳定不卡。

![platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-blue)
![stack](https://img.shields.io/badge/vue-3.5-green?logo=vue.js)
![electron](https://img.shields.io/badge/electron-32-9feaf9?logo=electron)
![license](https://img.shields.io/badge/license-MIT-yellow)

## 特性

### 连接与协议
- 支持 **mqtt / mqtts / ws / wss** 四种协议
- **多连接配置** CRUD，一键切换，导入 / 导出 JSON
- 自动重连、连接状态实时指示

### 订阅与发布
- QoS 0 / 1 / 2，保留消息、通配符 `+` `#`
- **订阅暂停 / 恢复**（broker 侧 UNSUBSCRIBE，本地保留记录）
- 发布历史记录、一键重放、JSON 格式化

### 消息查看
- **时间线 / 主题分组** 双视图
- 主题列表支持**多种排序**：主题名 / 最近活跃 / 消息量 / 首次出现
- 全局过滤（忽略空格）+ 命中高亮
- 右键任意消息 → **格式化查看器**（自动识别 JSON，语法高亮，内置搜索 / 上下跳转 / Ctrl+F）
- 新消息自动跟随、一键置顶
- 消息禁用（指定主题不记录不推送）

### 历史查询
- 按时间范围 + 关键字 + 连接范围筛选
- 时间**快速选择**：5 分钟 / 1 小时 / 今天 / 本次启动 / 全部...
- 按主题分组，支持二次查看
- 导出：MQTTX 兼容 JSON / 按主题分组 ZIP

### 性能
- **B 方案存储**：秒级合批 + 长度前缀二进制 BLOB，写入减少 100×、磁盘占用降 30%
- 主进程批量 IPC（33 ms / 400 条） + 优先主题降采样保护
- 渲染侧环形缓冲 + `content-visibility: auto` 原生虚拟化
- SQLite WAL + 按连接 / 按日分片日库 + LRU 连接缓存
- 自动清理 Worker，过期日志按天文件整删

### 个性化
- **深色 / 浅色主题**一键切换
- **消息字号**实时调节（10–22 px）
- **面板折叠**，左右栏可收起扩大主区
- 自定义消息日志目录，过期自动清理

## 截图

> 请在 Release 页面查看

## 快速开始

### 开发环境

```bash
# Node 18+ / 20 LTS
npm install
npm run dev
```

第一次启动前若 `better-sqlite3` 报 `NODE_MODULE_VERSION` 错误：

```bash
npx electron-builder install-app-deps
```

### 打包

```bash
# Windows（输出 release/*.exe）
npm run build

# 仅生成目录版（免 NSIS，调试更快）
npm run build:dir
```

产物在 `release/` 目录下：
- `MqttMountain-<version>-win-x64.exe` — NSIS 安装包
- `win-unpacked/` — 免安装版

### CI / CD

打 tag 推送即自动构建并发布到 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 32 |
| 渲染 | Vue 3.5 + Pinia 2 + TypeScript 5 |
| 构建 | Vite 5 + vite-plugin-electron |
| MQTT | mqtt.js 5 |
| 持久化 | better-sqlite3 11 (WAL + 分片) |
| 打包 | electron-builder 25 |

## 目录结构

```
MqttMountain/
├── electron/
│   ├── main/                   # 主进程
│   │   ├── index.ts            # 入口 / 窗口
│   │   ├── mqtt-service.ts     # 多连接 MQTT + 批量 IPC
│   │   ├── storage.ts          # 秒级合批 + 分片 SQLite
│   │   ├── settings.ts         # 配置 & 设置
│   │   └── ipc.ts              # IPC 路由
│   └── preload/index.ts        # contextBridge 安全 API
├── shared/types.ts             # 主 / 渲染共享类型
└── src/                        # 渲染进程（Vue 3）
    ├── components/             # UI 组件
    ├── composables/            # 组合式 API
    ├── stores/                 # Pinia store
    ├── utils/                  # 工具（RingBuffer / 过滤 / 导出...）
    └── assets/styles.scss      # 主题 / 全局样式
```

## 数据目录

- Windows: `%APPDATA%\MqttMountain\`
- macOS: `~/Library/Application Support/MqttMountain/`
- Linux: `~/.config/MqttMountain/`

下分：
- `mqtt_mountain.db` — 连接配置 & 应用设置
- `message_logs/<connectionId>/<YYYY-MM-DD>.db` — 消息日库（可在设置里迁移到任意目录）

## 贡献

欢迎 Issue 与 PR。建议提交前执行：

```bash
npm run typecheck
```

## License

MIT
