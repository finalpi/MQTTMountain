# MQTTMountain Plugin Template

一个最小可用的 MQTTMountain 插件骨架。**复制这个目录到单独的 Git 仓库**即可开始开发你自己的插件。

## 结构

```
.
├── mqttmountain-plugin.json   # 插件元信息 + 声明式 sender
├── index.js                    # runtime（decode / topicLabel / 动态 sender）
└── README.md
```

## 快速开始

1. fork / copy 本目录到一个独立 git 仓库
2. 修改 `mqttmountain-plugin.json` 的 `id`、`name`、`author`
3. 改 `index.js` 的 `decode` 函数解析你关心的厂商协议
4. `git init && git add -A && git commit -m init && git remote add origin <YOUR_URL> && git push`
5. 在 MQTTMountain 的「🧩 插件」面板填入你的仓库 URL 安装

## 开发调试

最快的本地调试方式：

```bash
# 直接拷贝到插件目录，不走 git
# Windows
cp -r ./your-plugin  %APPDATA%/MQTTMountain/plugins/your-plugin-id
# macOS
cp -r ./your-plugin  ~/Library/Application\ Support/MQTTMountain/plugins/your-plugin-id
```

然后在「🧩 插件」面板点 🔄 刷新即可。改代码后点「🔄 重载」热更新（无需重启 app）。

## API 参考

见 [docs/PLUGIN.md](https://github.com/finalpi/MQTTMountain/blob/main/docs/PLUGIN.md)
