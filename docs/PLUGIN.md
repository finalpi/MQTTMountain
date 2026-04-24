# MQTTMountain 插件开发指南

> 本文档面向希望为 MQTTMountain 编写插件的第三方开发者。

## 插件能做什么

| 能力 | 说明 |
|---|---|
| **Sender 发送模板** | 预定义 `topic` + `payload` 模板（支持参数占位），用户在发布面板一键选用 |
| **Decoder 消息解码** | 拿到 `(topic, payload)` 返回**摘要 / 高亮字段 / 结构化数据**，展示在格式化查看器中 |
| **TopicLabel 主题别名** | 把 `thing/product/ABC/events` 这类技术主题名翻译成「设备事件 · ABC」之类的中文标签 |

---

## 插件分发 = 独立 Git 仓库

用户在「🧩 插件」面板填入你的仓库 URL 即可安装。仓库**根目录**必须包含：

```
my-plugin/
├── mqttmountain-plugin.json   ← 必须：manifest
├── index.js                    ← 可选：CommonJS runtime 入口
├── package.json                ← 可选：第三方依赖
├── icon.png                    ← 可选：128×128 图标
└── README.md
```

---

## manifest 规范（`mqttmountain-plugin.json`）

```json
{
    "id": "com.your-company.dji-drone",
    "name": "DJI 大疆设备解析",
    "version": "1.0.0",
    "description": "解析大疆机场 thing/product/... 协议",
    "author": "your-name",
    "homepage": "https://github.com/your-company/dji-mqtt-plugin",
    "icon": "icon.png",
    "main": "index.js",
    "engines": { "mqttmountain": ">=1.0.0" },
    "topicPatterns": [
        "thing/product/+/events",
        "thing/product/+/state"
    ],
    "senders": [
        {
            "id": "camera.photo",
            "name": "📸 拍照",
            "group": "相机",
            "topic": "thing/product/{deviceSn}/services",
            "payloadTemplate": "{\"method\":\"camera_photo_take\",\"data\":{\"payload_index\":\"{payloadIndex}\"}}",
            "qos": 1,
            "params": [
                { "key": "deviceSn", "label": "设备 SN", "required": true },
                { "key": "payloadIndex", "label": "挂载位", "type": "select", "options": ["39-0-7", "52-0-0"], "default": "39-0-7" }
            ]
        }
    ]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 反向域名唯一标识，避免冲突（`com.company.xxx`） |
| `name` | ✅ | 显示名 |
| `version` | ✅ | SemVer |
| `main` | ❌ | CommonJS 入口文件，默认 `index.js`。**纯声明式插件可省略** |
| `senders` | ❌ | 静态发送模板数组（见下） |
| `topicPatterns` | ❌ | 声明你关心的主题，仅 UI 提示用 |

### Sender 模板

- `topic` / `payloadTemplate` 支持 `{paramKey}` 占位，会用用户填入的参数替换
- `params[]` 声明用户要填什么，`type` 可为 `string / number / boolean / select`
- `group` 同组 sender 会在下拉菜单中归到一起

---

## runtime 规范（`index.js`）

如果你的插件需要**动态逻辑**（解码、运行时计算 sender、激活钩子等），提供 `index.js`，以 CommonJS 导出：

```js
// index.js
module.exports = {
    // 可选：运行时追加 sender（与 manifest.senders 合并）
    senders: [
        { id: 'dyn-1', name: '动态模板', topic: 't/x', payloadTemplate: '{}' }
    ],

    // 或函数形式，每次启用时调用
    // senders: () => computeSenders(),

    // 解析某条消息
    decode(topic, payload) {
        if (!topic.startsWith('thing/')) return null;
        try {
            const obj = JSON.parse(payload);
            return {
                summary: `${obj.method} · ${obj.gateway}`,
                highlights: [
                    { label: 'gateway', value: obj.gateway },
                    { label: 'tid', value: obj.tid },
                    { label: 'ts', value: new Date(obj.timestamp).toISOString() }
                ]
            };
        } catch (e) {
            return null;
        }
    },

    // 给 topic 起个中文别名
    topicLabel(topic) {
        if (topic.endsWith('/events')) return '事件上报';
        if (topic.endsWith('/state')) return '状态同步';
        return null;
    },

    // 可选：激活/停用
    activate(ctx) {
        ctx.log('activated in ' + ctx.pluginDir);
    },
    deactivate() {}
};
```

### decode 返回值

```ts
{
    summary?: string;                                  // 一行摘要
    highlights?: { label: string; value: string }[];   // 关键字段
    tree?: unknown;                                    // 结构化数据（保留字段，未来用）
    topicLabel?: string;                               // 覆盖主题标签
}
```

返回 `null` 表示**本插件不处理**该消息，继续让其他插件或宿主处理。

### 运行环境

- 插件代码运行在 **Electron 主进程**，拥有 Node.js 全部能力
- 上下文通过 `activate(ctx)` 传入：
  - `ctx.pluginId` / `ctx.pluginDir` / `ctx.hostVersion` / `ctx.log(msg)`

### 安全建议

- **只接受可信来源的插件**
- 插件有 Node 全权限（可读写文件、访问网络），请仔细评审第三方插件代码后再启用

---

## 调试工作流

1. 在你的插件仓库开发代码
2. 安装到 MQTTMountain：
   - 方式 A：推送 git 后，在「🧩 插件」面板 → 填 URL → 安装
   - 方式 B：把仓库目录直接放到 `%APPDATA%/MQTTMountain/plugins/<id>/`，然后在插件面板点 🔄 刷新
3. 启用开关 → 如果 `index.js` 有语法错误会显示「加载失败」标签，错误行在 error 栏
4. 改代码 → 在「🧩 插件」面板点「🔄 重载」热更新（无需重启 app）

---

## 升级与卸载

- **升级**：git 安装的插件可点「⬆️ 升级」触发 `git pull --ff-only`
- **卸载**：「🗑️ 卸载」会删除插件目录

---

## 发布模板仓库

参考最小骨架（当前仓库 `examples/plugin-template/` 目录）：
- [mqttmountain-plugin.json](../examples/plugin-template/mqttmountain-plugin.json)
- [index.js](../examples/plugin-template/index.js)
