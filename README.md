---
title: Echo Study
emoji: 🎧
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Echo Study

一个支持公网部署的视频英语精听网站。视频解析、YouTube 搜索、Whisper 字幕识别和英译中均由网站服务端完成。

## 启动

在 PowerShell 中进入本目录后运行：

```powershell
.\start.ps1
```

然后访问 <http://127.0.0.1:4173>。默认账号为 `111`，密码必须通过环境变量配置。

## 公网部署

项目已包含 `Dockerfile` 和 `render.yaml`，可部署到支持 Docker 的 Render、Railway、Fly.io 或云服务器。容器构建时会安装 Node.js、Python、FFmpeg、yt-dlp、faster-whisper、Argos Translate，并下载所需模型。

必要环境变量：

```text
APP_USERNAME=111
APP_PASSWORD=请设置登录密码
SESSION_SECRET=一段足够长的随机字符串
```

推荐至少使用 2 GB 内存的实例。首次构建需要下载语音识别与翻译模型，因此会比普通静态网站更久。

Render Blueprint 发布步骤：

1. 将目录推送至 GitHub 或 GitLab。
2. 在 Render 选择 **New Blueprint Instance** 并连接仓库。
3. 在部署表单中将 `APP_PASSWORD` 设置为约定的登录密码（不要提交到仓库）。
4. 等待 Docker 镜像构建完成，使用 Render 分配的 HTTPS 地址访问。

## 已实现

- 本地上传或拖入视频，文件在浏览器页面内播放
- 输入视频直链，或从普通网页的公开 `video`、`source`、Open Graph 信息中提取媒体
- 搜索 YouTube 公开学习视频，点击结果后自动加载视频与字幕
- 导入 SRT/VTT 字幕，动态字幕与视频进度同步
- YouTube 链接优先读取作者字幕或平台自动字幕；没有字幕时使用服务器内的 Whisper 从音频生成
- 逐句跳转、上一句、下一句、重播、单句循环、倍速播放
- 中英翻译显隐、字幕字号切换、浏览器语音朗读与句子收藏
- 翻译开关：优先读取平台翻译轨，没有时使用服务器内的离线翻译模型
- 服务端登录会话、错误登录限速和退出登录
- 学习分钟、最近学习日期和收藏保存在浏览器本地
- 桌面双栏和移动端单栏响应式布局

## 使用边界

网页提取功能只读取页面公开声明的媒体地址，不会绕过登录、付费墙、DRM 或站点访问限制。视频只有画面内烧录字幕时，服务器会尝试通过音频识别生成英文字幕。关键词搜索、视频解析和首次模型构建需要网络连接。

如果云端运行时出现 `Sign in to confirm you’re not a bot`，登录网站后打开“添加视频 → YouTube 授权”，上传 Netscape 格式的 `cookies.txt`。文件只保存在服务端的 `media-cache/` 忽略目录，不会提交到 GitHub。建议使用专门的非主账号 Cookie，并在不再需要时从页面清除。

字幕的中英文可在同一条字幕中用 `|`、`｜` 或 ` / ` 分隔；只有英文时也可以正常使用。
