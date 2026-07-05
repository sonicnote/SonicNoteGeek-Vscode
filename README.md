# SonicNoteGeek 🎤

VS Code 扩展 — 音频转写、说话人识别、智能总结与妙记云同步。

📖 官方使用文档：[ainote.easylinkin.com/#/resources/docs](https://ainote.easylinkin.com/#/resources/docs)

🎬 视频教程：[B站 BV1XmJ36BEYb](https://www.bilibili.com/video/BV1XmJ36BEYb/)

## 功能

### 音频转写（ASR）

从 Markdown 文件中提取 MP3 链接，自动转写为文字，支持 **8 种 ASR 引擎**：

| 引擎 | 协议标识 | 说明 |
|------|----------|------|
| OpenAI Whisper | `openai-whisper` | 云端 Whisper API |
| 火山引擎 | `volcengine` | 豆包 BigModel ASR |
| 阿里百炼 | `aliyun-dashscope` | DashScope 语音识别 |
| 讯飞 | `xunfei` | 讯飞语音听写 |
| 腾讯云 | `tencent` | 腾讯云 ASR |
| 百度 | `baidu` | 百度语音识别 |
| 华为云 | `huawei` | 华为云语音识别 |
| 本地 OpenAI | `local-openai` | 兼容 OpenAI 协议的本地服务 |

### 说话人识别

- **内置**：基于转写结果元数据的启发式分离
- **自定义**：通过声纹 API 进行说话人匹配
- 声纹样本采集与库管理

### LLM 智能总结

支持 16+ LLM 提供商（Anthropic、OpenAI、智谱、DeepSeek、Mistral 等），**19 套内置中文模板**：

| 类别 | 模板 |
|------|------|
| 会议 | 商务会议、每日站会、项目复盘、一般会议 |
| 学习 | 课堂总结、读书笔记 |
| 访谈 | 访谈记录、用户调研 |
| 诊疗 | 医患沟通、心理咨询 |
| 法律 | 庭审记录、合同谈判 |
| 通用 | 通用总结、快速摘要 |

每种模板包含定制化的 system prompt 和输出格式，输出内容可直接使用。

### 妙记云同步

从 [妙记](https://ainote.easylinkin.com) 服务器同步录音、转录文本和 AI 总结到本地 Markdown 文件。

- 增量同步（仅下载新录音）
- 智能重命名（标题变更时自动更新文件名）
- 定时自动同步
- 侧边栏文件浏览与登录状态指示

## 安装

```bash
npm install
npm run build
```

然后复制到 VS Code 扩展目录，或在 VS Code 中按 F5 启动扩展开发主机。

## 使用

### 转写流程

1. 在 VS Code 中打开一个 Markdown 文件
2. 在文件中写入 MP3 音频链接（URL 或本地路径）
3. 点击工具栏的 SonicNoteGeek 图标，或右键选择「音频转写」
4. 选择 ASR 引擎、说话人识别方式、总结模板
5. 点击「开始处理」— 结果会写入当前 Markdown 文件

### 妙记同步

1. 点击左侧活动栏的 SonicNoteGeek 图标
2. 打开同步设置面板，填写服务器地址和 API Key
3. 点击「同步」按钮拉取最新录音

## 项目结构

```
SonicNoteGeek-Vscode/
├── src/
│   ├── extension.ts          # 入口：激活、命令注册、Webview 面板
│   ├── processor.ts           # AudioProcessor — 8 种 ASR 协议实现 + LLM 调用
│   ├── types.ts               # TypeScript 类型定义
│   ├── settings.ts            # 设置持久化（VS Code config + globalState）
│   ├── templates.ts           # 19 套中文总结模板
│   ├── sync/                  # 妙记云同步模块
│   │   ├── api.ts             # SonicNoteApiClient（登录、列表、详情）
│   │   ├── sync.ts            # SyncService（增量同步、重命名）
│   │   ├── formatter.ts       # 文件名处理 + Markdown 生成
│   │   ├── integration.ts     # 命令注册、全局状态、定时器
│   │   ├── sidebar.ts         # 侧边栏 Webview
│   │   ├── settings-panel.ts  # 同步设置 Webview 面板
│   │   └── types.ts           # 同步数据类型
│   └── utils/
│       ├── mp3-extractor.ts   # 从 Markdown 提取 MP3 链接
│       ├── output-generator.ts # 最终 Markdown 输出组装
│       ├── model-list.ts      # [无用代码] Obsidian 模型列表
│       ├── asr-model-list.ts  # [无用代码] Obsidian ASR 模型列表
│       ├── asr-guide.ts        # [无用代码] Obsidian ASR 指南
│       └── voiceprint-guide.ts # [无用代码] Obsidian 声纹指南
├── dist/                       # 构建产物
├── media/                      # 扩展图标
├── esbuild.config.mjs          # esbuild 打包配置
├── tsconfig.json
└── package.json
```

## 开发

```bash
npm run build        # 生产构建
npm run watch        # 开发监视
npm run lint         # 类型检查
```

## 配置

所有设置通过 VS Code 标准配置界面管理，前缀 `sonicnoteGeek.*`：

- `sonicnoteGeek.asr.*` — ASR 引擎配置
- `sonicnoteGeek.speaker.*` — 说话人识别配置
- `sonicnoteGeek.llm.*` — LLM 总结配置
- `sonicnoteGeek.sync.*` — 妙记同步配置

## 许可

MIT
