# Arknights Spine Auto-Studio（明日方舟 Spine 自然语言动画生成系统）

把一句自然语言（"先睡觉，然后起来跑步，最后累趴下"）变成明日方舟角色的 **GIF/MP4 动画**。
纯 Node.js 实现，**零 npm 依赖**（只用到系统 Chrome/Edge、可选 FFmpeg 与可选 AI 超分引擎）。

```
[自然语言] → [choreograph 动作编排] → [高清化 atlas+PNG] → [无头 Chrome 渲染] → [GIF/MP4]
```

## 快速开始

```powershell
# 1. 检查现有角色动画（阿米娅资源已内置在 assets/amiya）
node src/pipeline.mjs inspect --skel assets/amiya/amiya.skel

# 2. 生成动画 GIF（离线 mock 编排，无需 API Key）
node src/pipeline.mjs run --prompt "先睡觉，然后起来跑步，最后累趴下" --skel assets/amiya/amiya.skel --mock --out out/demo.gif

# 3. 自动抓取其他角色并生成（网络可用时）
node src/pipeline.mjs run --prompt "站着挥手，然后坐下休息" --character 能天使 --mock

# 4. 从 PRTS Wiki 抓取三件套并生成（官方模型源，网络可用时）
node src/pipeline.mjs run --source prts --character "阿米娅" --prompt "睡觉，然后起来跑步" --mock

# 5. 列出某角色在 PRTS 的全部皮肤与视图
node src/pipeline.mjs fetch --source prts --character "阿米娅" --list-skins

# 6. 指定皮肤/视图（如报童皮肤、基建视图），或强制重新下载
node src/pipeline.mjs fetch --source prts --character "阿米娅" --skin "报童" --view "基建" --force
# 7. 抓取敌人模型（如 霜星 / 爱国者）：PRTS 敌人页无 meta.json，自动解析内嵌 SPINEDATA
node src/pipeline.mjs fetch --source prts --enemy "霜星"

# 8. 敌人端到端：攻击，然后倒地（敌人动画含 Attack/Die/Idle/Move/Skill_1/Skill_2）
node src/pipeline.mjs run --source prts --enemy "霜星" --prompt "攻击，然后倒地" --mock

# 异格干员与多皮肤：按名称自动命中（近卫阿米娅 → char_1001_amiya2），或 --key 直达
node src/pipeline.mjs fetch --source prts --key char_1001_amiya2 --list-skins

# 9. 使用 DeepSeek 智能编排（设置 DEEPSEEK_API_KEY 后自动启用）
$env:DEEPSEEK_API_KEY = "sk-..."
node src/pipeline.mjs run --prompt "先睡觉，然后起来跑步，最后累趴下" --skel assets/amiya/amiya.skel

# 10. 高清化：atlas + PNG 同步放大 2 倍（Lanczos3，离线零依赖）
node src/pipeline.mjs run --prompt "睡觉，然后起来挥手" --skel assets/amiya/amiya.skel --mock --upscale 2

# 11. 最强画质：AI 超分引擎（Real-ESRGAN anime6B，首次自动下载约 43MB）
node src/pipeline.mjs run --prompt "睡觉，然后起来挥手" --skel assets/amiya/amiya.skel --mock --upscale 2 --sr
# 12. 切片高清化（推荐）：先按 atlas 拆片、逐片放大后重组，AI 放大聚焦单片、零串色
node src/pipeline.mjs upscale --atlas assets/amiya/amiya.atlas --png assets/amiya/amiya.png --scale 2 --slice --sr

# 13. 桌面端软件（GUI）：双击 start-desktop.cmd 启动
#     可选 Electron 版：先运行 install-desktop.cmd 安装，再双击 start-desktop.cmd

```

## 最快跑通（桌面版，约 5 分钟）

1. **启动**：双击 `start-desktop.cmd`（自动用 Chrome 应用窗口打开；想用独立窗口可先运行 `install-desktop.cmd`）。
2. **（可选）配 Key**：右上角 ⚙ 设置 → 填入 DeepSeek API Key →「测试连接」→「保存」。不填也能跑，自动用离线关键词编排。
3. **选模型**：内置阿米娅开箱即用——直接在「模型资源」点下方「阿米娅」卡片；或输入名称（如 阿米娅 / 霜星 / 弑君者）→「解析」→ 选皮肤/视图 →「拉取三件套」。
4. **生成**：切到「动画生成」→ 输入动作描述（如 `先睡觉，然后起来跑步，最后累趴下`）→ 点「▶ 开始生成」。
5. **预览**：完成后在「任务与输出」直接播放 GIF/MP4；成品也保存在项目 `out/` 目录。

命令行最快跑通（无需桌面、无需 Key）：

```powershell
node src/pipeline.mjs run --prompt "睡觉，然后跑步" --skel assets/amiya/amiya.skel --mock --out out/demo.gif
```

## 桌面端软件（GUI）

项目自带完整桌面界面，按「① 拉取模型 → ② 高清化（可选）→ ③ 编排时间轴 → ④ 生成动画」四步流程组织，
顶部有全局流程条，每步都有明确的下一步按钮，避免误操作：

```powershell
# 方式一：Chrome 窗口模式（零额外安装，推荐先试这个）
start-desktop.cmd          # 双击即可，自动启动本地服务并用 Chrome 应用窗口打开界面

# 方式二：Electron 桌面版（独立窗口，可一键打开输出目录）
install-desktop.cmd        # 首次安装 Electron（约 100MB，国内自动走 npmmirror 镜像）
start-desktop.cmd          # 已装 Electron 时自动以桌面窗口启动
```

四个流程页 + 任务与输出页：

- **① 拉取模型**：按名称/ID 从 PRTS 拉取干员、异格、敌人、敌方领袖三件套；支持多皮肤/多视图
  （先「解析」→ 选皮肤/视图 →「拉取三件套」）；本地模型库卡片带动画列表。
  拉取完成后**不会自动跳转**，由你选择「下一步：高清化」或「跳过，直接去编排时间轴」。
- **② 高清化（可选）**：一键生成「四格方案对比图」（原图 / Lanczos3 / Real-ESRGAN / Waifu2x 同一局部
  放大并排对比，带彩色标识条）→ 点选满意方案 →「开始高清化」执行整图；完成后「采用这套高清化资源」，
  后续动画生成**直接使用高清资源（不会重复放大）**；也可「跳过高清化」用原图。
  资源双目录隔离：原始三件套永存 `assets/<模型ID>/`，高清化产物在 `out/hi/`，互不覆盖。 勾选「按切片高清化」后改为先按 atlas 拆片、逐片放大再重组回图集（推荐：AI 放大聚焦单片、边缘零串色，`out/hi/` 中同时保留整图放大与切片两套产物）。
- **③ 编排时间轴**：先「生成动作预览」把每个动作渲染成预览（⚡单帧快照 或 🎬完整动画 GIF，
  默认 GIF，一眼看清每个动作；预览固定用原始资源，快）。动作名看不懂？点「🤖 AI 自动标注」：
  离线规则先猜（Idle/Move/Attack/Sleep…），千问 Qwen-VL 看图补全 `special_01` 这类乱码动作，
  结果存入本地动作字典，可继续在卡片上微调；然后二选一排时间轴：写一句自然语言让 DeepSeek（有 Key）
  或离线关键词编排；或在预览卡上「＋ 加入时间轴」手动勾选；下方 PR 式色块时间轴可改每段时长/循环/倍速、↑↓ 调顺序、✕ 删除。
- **④ 生成动画**：顶部确认「模型 + 资源（原图/高清化）+ 时间轴」状态 → 设置帧率/画布/格式/背景/过渡
  →「开始生成」；实时进度条 + 滚动日志；完成后直接预览 GIF/MP4，可点「放大预览」。
- **任务与输出**：任务历史（含日志）与输出文件网格；任意输出卡片可点击放大预览（灯箱）。

架构：`desktop/server.mjs`（零依赖 Node HTTP + SSE 进度流）驱动 `src/pipeline.mjs`，
`desktop/ui/` 为原生 HTML/CSS/JS 界面；`desktop/electron-main.cjs` 为可选 Electron 外壳。
服务只绑定 `127.0.0.1`，仅本机访问。

**DeepSeek API Key 在哪里填？**

- 桌面版：点击窗口右上角 **⚙ 设置** 按钮 → 填入 API Key（`platform.deepseek.com` 创建，格式 `sk-...`）
  → 「测试连接」→「保存」。Key 仅保存在本机 `config.json`（不会明文回显、不会上传），
  状态栏的「DeepSeek」徽标会实时显示是否已配置；不填也能用（自动离线关键词编排）。
- 也可在设置面板修改模型（默认 `deepseek-v4-flash`）与 API 地址（默认 `https://api.deepseek.com`）。
- CLI 方式：设置环境变量 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`）。

**千问视觉标注（Qwen-VL）在哪里填？**

- 设置面板新增「千问视觉标注（可选）」卡片：填入 DashScope API Key（bailian.console.aliyun.com 创建，
  格式 `sk-...`）→「测试连接」→「保存」。Key 仅保存在本机 `config.json`。
- 视觉模型默认 `qwen-vl-max`，也可用 `qwen-vl-plus` / `qwen2.5-vl-72b-instruct`；
  API 地址默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- **三档运行模式**：① 不配置任何 Key = 纯离线（规则猜测 + 手动标注 + 手动排时间轴）；
  ② 只配 DeepSeek = 半自动（规则/手动标注 + AI 编排）；③ 双 Key = 全自动（千问看图打标 + DeepSeek 编排）。
- 动作字典保存在 `assets/<模型ID>/actions.json`，只标注一次、永久复用；编排时 DeepSeek 会自动读取字典，
  看懂 `special_01` 这类乱码动作名。


**发布包安全闸**：运行 `node build-dist.mjs` 打包时，若检测到本机 `config.json` 已保存 DeepSeek / 千问视觉 API Key（或存在 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` 环境变量），构建会立即中止并提示，防止 Key 随发布包泄露；打包前请先清除 Key。
## CLI 命令

## PRTS Wiki 官方模型源

`--source prts` 直接从 [PRTS Wiki](https://prts.wiki)（明日方舟官方中文 wiki）抓取角色三件套：

- **原理**：解析干员页面的 `<div id="spine-root" data-id="char_002_amiya">` 拿到模型 ID，再读取
  `https://torappu.prts.wiki/assets/char_spine/<id>/meta.json` 得到皮肤（默认/报童/……）与视图
  （基建/正面/背面）各自的资源路径，最后下载 `.skel + .atlas + .png` 三件套。
- **兼容性**：PRTS 的 `.skel` 为 Spine 3.8.99 二进制，与内置 3.8 播放器完全兼容；
  `inspect` 可直接列出该角色的全部动画。
- **皮肤与视图**：`--skin 报童`、`--view 基建|正面|背面`；不带参数时默认「默认皮肤 + 基建视图」。
  `--list-skins` 可先查看该角色有哪些可选组合（`fetch` 命令下使用）。
- **缓存与强制刷新**：三件套下载到 `assets/<charId>/`，已存在则跳过；`--force` 强制重新下载。
- **敌人模型**：`--enemy 霜星` 或 `--key enemy_1505_frstar`（`enemy_*` 前缀直达）。
  普通敌人（霜星/爱国者…）页面没有 meta.json，抓取器自动解析页面内嵌的
  `<span id="SPINEDATA">` JSON（`enemy_spine/<id>/` 前缀 + 「默认 → 战斗」视图）并下载三件套；
  敌方领袖/精英（如 弑君者 `char_1502_crosly`）走干员流程，同样支持 `--list-skins`/`--skin`。
- **异格与多皮肤**：异格干员（如 近卫阿米娅 `char_1001_amiya2`）有独立模型 ID，按名称搜索
  自动命中；多皮肤在 meta.json 的 `skin` 字段中枚举（阿米娅 4 套、弑君者 2 套…），
  `--skin` 指定、`--list-skins` 预览。
- **分辨率提示**：PRTS 官方贴图为 2/3 降采样（如 344x344 贴图配 516x516 atlas），比例自洽、
  渲染正确但偏糊——这正是本项目 `--upscale`/`--sr` 高清化功能的应用场景。
- **高清化方案对比（桌面版）**：「高清化」标签 → 选模型与倍数 → 「生成方案对比」→ 一次输出 4 格对比图
  （灰=原图 蓝=Lanczos 绿=Real-ESRGAN 紫=Waifu2x）→ 点选方案卡 → 「开始高清化」执行整图；
  选中的方案会自动同步到「动画生成」的放大/AI 超分参数，保证预览与成片一致。


| 命令 | 说明 |
| --- | --- |
| `inspect --skel <path>` | 解析 .skel，列出角色全部可用动画与时长 |
| `fetch --character 阿米娅` | 从 Ark-Models 镜像下载角色的 .png/.atlas/.skel |

| `fetch --source prts --character 阿米娅` | 从 PRTS Wiki 抓取官方三件套（`--skin`/`--view`/`--list-skins`/`--force`） |
| `fetch --source prts --enemy 霜星` | 抓取敌人三件套（普通敌人走 SPINEDATA，敌方领袖走干员流程，可 `--list-skins`） |

| `run --prompt "..."` | 端到端：编排 + 高清化 + 渲染 + 导出 |
| `upscale --atlas a.atlas --png a.png --scale 2` | 单独执行 atlas+PNG 同步放大（原工具的增强版 CLI） |
| `compare --atlas a.atlas --png a.png` | 生成原图/Lanczos3/AI 引擎四宫格画质对比图（scripts/make-compare.mjs） |

`run` 常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--skel <path>` | — | 使用本地资源（atlas/png 取同名文件） |
| `--character 阿米娅` / `--key 002_amiya` | — | 自动抓取指定角色 |
| `--enemy 霜星` / `--key enemy_1505_frstar` | — | 抓取敌人模型（`--enemy` 按名称搜索且优先于 `--character`；`enemy_*` key 直达） |
| `--mock` | 无 Key 时自动 | 离线关键词编排（中文/英文） |
| `--fps N` | 30 | 帧率 |
| `--size WxH` | 640x640 | 画布尺寸 |
| `--format gif\|png\|mp4\|all` | gif | 输出 GIF / PNG 帧序列 / MP4 / 全部 |
| `--bg RRGGBBAA` | 00000000 | 背景色（默认透明） |
| `--mix S` | 0.2 | 动作间平滑过渡时长（秒） |
| `--out <path>` | out/<角色>-<时间戳> | 输出路径（自动附带 .timeline.json） |
| `--timeline <file>` | — | 使用已保存的时间轴 JSON 渲染（跳过编排，配合桌面端时间轴微调） |
| `--assets-dir <dir>` | assets | 角色资源下载目录 |
| `--source arkmodels\|prts` | arkmodels | 角色资源来源：Ark-Models 镜像（默认）或 PRTS Wiki 官方模型 |
| `--skin 皮肤名` | 默认 | 仅 `--source prts`：选择皮肤（如 报童） |
| `--view 基建\|正面\|背面` | 基建 | 仅 `--source prts`：选择视图 |
| `--list-skins` | — | 仅 `fetch`：列出角色全部皮肤与视图组合 |
| `--force` | 关 | 强制重新下载已缓存的三件套 |

| `--ffmpeg <path>` | 自动下载 | 指定 ffmpeg；缺省时自动下载静态版到 `vendor/ffmpeg/` |
| `--upscale N` | 1 | 同步放大 atlas+PNG N 倍（atlas 的 size/xy/orig/offset/split/pad 与贴图一起缩放，杜绝"放大 PNG 但裁切 atlas"的错位） |
| `--sr` | 关 | 用 AI 超分引擎放大 PNG（默认 Real-ESRGAN anime6B；首次自动下载到 `vendor/realesrgan/`，需 Vulkan 显卡，失败自动回退 Lanczos3） |
| `--sr-engine NAME\|PATH` | realesrgan | 引擎名（realesrgan/waifu2x/realcugan）或已下载的 ncnn-vulkan exe 路径 |
| `--sr-scale N` | 引擎原生 | 引擎自身倍数；与 `--upscale` 不一致时自动用 Lanczos3 桥接保证 atlas/PNG 同步 |
| `--sr-gpu N` | 0 | GPU 编号（多卡机器用） |
| `--sr-tile N` | 0 | 引擎分块大小（显存不足时用 256，0 自动） |

## 高清化（atlas 与 PNG 同步放大）

明日方舟官方贴图分辨率不高，直接放大输出会糊；只放大 PNG 而裁切 atlas 又会对不上位。
本项目方案与 [yiyuxi123/Enlargement-software-for-Arknights-atlas-files](https://github.com/yiyuxi123/Enlargement-software-for-Arknights-atlas-files)
一脉相承，并做了三处增强：

- **atlas 数值同步缩放**：页面 `size` 与区域 `xy`/`size`/`orig`/`offset`/`split`/`pad` 全部按倍数缩放（原工具遗漏 `offset`，旋转/偏移打包的区域会对不齐）；`rotate`/`index`/`filter`/`repeat` 保持原样。
- **PNG 与 atlas 同步放大**：贴图页用 **Lanczos3**（alpha 预乘，避免半透明边缘发黑）重采样，写出的 atlas 页名同步改写，Spine 渲染器直接加载高清资源，无需改渲染逻辑。
- **可选 AI 超分**：用 **Real-ESRGAN anime6B**（二次元公认最强开源超分模型，ncnn-vulkan 便携版，自动下载约 43MB 到 `vendor/realesrgan/`）从原始贴图直接 4x 重建，再桥接到目标倍数；无 Vulkan 时自动回退 Lanczos3。

```powershell
# 渲染时直接高清化（推荐：2x + AI 超分）
node src/pipeline.mjs run --prompt "睡觉，然后起来挥手" --skel assets/amiya/amiya.skel --mock --upscale 2 --sr

# 单独生成高清资源（相当于原工具的增强版 CLI）
node src/pipeline.mjs upscale --atlas assets/amiya/amiya.atlas --png assets/amiya/amiya.png --scale 2 --out out/amiya-hi

# 引擎管理：列出可用引擎 / 单独跑某张图
node src/sr.mjs --help
node src/sr.mjs realesrgan assets/amiya/amiya.png out/amiya-4x.png

# 画质对比：生成带标注的四宫格对比图（原图 / Lanczos3 / 各 AI 引擎）
node scripts/make-compare.mjs --atlas assets/amiya/amiya.atlas --png assets/amiya/amiya.png --scale 4
```

放大后的资源保存在 `<输出名>-hi/` 目录（atlas+PNG 成对出现，可直接给 Spine/渲染器使用）。

三种 AI 引擎（ncnn-vulkan 便携版，均已实测）：

| 引擎 | 模型 | 原生倍数 | 特点 |
| --- | --- | --- | --- |
| `realesrgan`（默认） | RealESRGAN x4plus-anime 6B | 4x | 二次元公认最强细节重建 |
| `waifu2x` | cunet（2025-09 最新构建） | 2x | 经典动漫超分，速度快 |
| `realcugan` | models-se（up2x/3x/4x） | 4x | bilibili Real-CUGAN，多档降噪 |

全部支持 `--sr-engine <引擎名>` 或 `--sr-engine <exe路径>` 指定；首次使用自动下载并缓存到 `vendor/<引擎名>/`。

## 发布与分发

一条命令生成可直接分发的 zip 包（无需任何 npm 安装）：

```powershell
node build-dist.mjs            # 精简版 ~0.3MB：代码 + Spine 播放器 + 内置阿米娅 + 启动器
node build-dist.mjs --full     # 完整版 ~150MB：额外内置 ffmpeg 与全部 AI 超分引擎
# 输出: dist/ArknightsSpineStudio-v<版本>[-full]-<日期>.zip
```

- 包内含「使用说明.txt」，解压后双击 `start-desktop.cmd` 即可使用（Windows 10/11，需 Node.js v18+ 与 Chrome/Edge）；
- 发布包**不会**包含你本机的 `config.json`（API Key 不泄漏）与个人下载的模型缓存；
- Electron 桌面外壳（约 100MB）不打包进 zip，由用户运行 `install-desktop.cmd` 按需安装；
- 完整版体积大但完全离线可用（含 ffmpeg 与 Real-ESRGAN/waifu2x/Real-CUGAN）。

## 架构与模块

```
src/
  download.mjs     资源抓取（Ark-Models 镜像 + models_data.json 清单）
  prts.mjs         PRTS Wiki 抓取器（干员 #spine-root → meta.json；敌人 SPINEDATA；异格/多皮肤，含缓存与强制刷新）


desktop/
  server.mjs        桌面端本地服务（HTTP + SSE 进度流，零依赖，仅绑定 127.0.0.1）
  electron-main.cjs 可选 Electron 外壳（自动拉起服务 + 桌面窗口 + 打开目录 IPC）
  ui/               桌面界面（index.html / style.css / app.js，原生三件套）
  skel.mjs         Spine 3.8 二进制解析器（字节级移植官方 SkeletonBinary，大端序）
  inspector.mjs    动画列表提取（命令行入口）
  choreograph.mjs  自然语言 → Timeline JSON（LLM / 离线 mock 双模式）
  render.mjs       无头渲染编排（CDP 逐帧驱动 → GIF）
  cdp.mjs          静态服务器 + Chrome 启动 + CDP WebSocket 客户端（零依赖）
  png.mjs          纯 JS PNG 编解码
  gif.mjs          纯 JS GIF89a 编码（中位切分 + Floyd-Steinberg + LZW）
  upscale.mjs      atlas 同步放大 + Lanczos3 PNG 高清化（含 offset/split/pad 修正）
  sr.mjs           可选 AI 超分引擎（Real-ESRGAN/waifu2x/Real-CUGAN，自动下载+调用）
render/
  index.html       WebGL 渲染页（spine-player 3.8 内核 + SceneRenderer）
vendor/
  spine-player.js  官方 Spine 3.8 Web 运行时（含 core + webgl）
  spine-core.js    官方 Spine 3.8 核心（测试对照用）
  ffmpeg/          可选：FFmpeg 静态版（首次使用自动下载）
  realesrgan/      可选：Real-ESRGAN ncnn-vulkan（--sr 首次使用自动下载）
assets/amiya/      阿米娅内置资源（.skel/.atlas/.png，来自 lozye/Ark-Models）
```

## 工作原理

1. **编排（choreograph）**
   - **LLM 模式**：把角色真实动画列表（名称+时长）交给 DeepSeek（OpenAI 兼容 API），要求严格输出 Timeline JSON；没有完全对应的动作时做语义拟合（如"大喘气"→ `Sleep`/`Relax`）。
   - **Mock 模式**：离线关键词分词 + 语义别名 + Levenshtein 模糊匹配，确定性输出，可离线演示。
2. **高清化（upscale + sr）**
   - 解析 `.atlas`，把页面 `size` 与区域 `xy/size/orig/offset/split/pad` 同步乘以倍数（整数舍入，保留原格式）；`rotate/index/filter/repeat` 不动。
   - PNG 贴图页用 Lanczos3（alpha 预乘两遍分离卷积）放大；开启 `--sr` 时改用 Real-ESRGAN anime6B 从原图 4x 重建，再 Lanczos 桥接到目标倍数。
   - 写出的 atlas 页名与放大后的 PNG 一致，Spine 渲染器无需任何改动即可加载高清资源。
3. **渲染（render + CDP）**
   - `render/index.html` 用官方 Spine 3.8 WebGL 运行时加载 `.skel`（二进制）与 `.atlas/.png`。
   - 自动计算骨骼包围盒并适配画布；`AnimationStateData.defaultMix` 实现动作间 0.2s 平滑过渡。
   - Node 通过原生 WebSocket 连接 Chrome DevTools Protocol，逐帧 `state.update → apply → 渲染 → 快照`，最后用纯 JS 编码器合成 GIF。
4. **二进制解析（skel.mjs）**
   - 支持：字符串池、region/boundingbox/mesh/linkedmesh/path/point/clipping 附件、骨骼/槽位/IK/Transform/Path 约束、deform/drawOrder/event 时间轴、贝塞尔曲线。
   - 与官方 `SkeletonBinary` 逐字节对位验证（`test/align.mjs`：35593 次读取位置完全一致）。
   - **注意**：Spine 3.8 官方 TS 运行时的 `DataView` 默认大端读取，本解析器同样使用大端序，与官方行为一致。

## 测试

```powershell
npm test
# 或分别运行：
node test/skel-roundtrip.mjs   # 官方格式 fixture 往返（21 项断言）
node test/codecs.mjs           # PNG/GIF 编解码
node test/align.mjs            # 与官方 SkeletonBinary 逐字节对位
node test/xcheck-fixture.mjs   # 官方解析器交叉解析本仓库 fixture
node test/upscale.mjs          # atlas 同步放大 + Lanczos3 高清化（含端到端）
node test/zip.mjs              # 引擎安装器的 zip 解压与路径穿越防护
node test/prts.mjs            # PRTS 解析函数单测（parseCharId/SPINEDATA/isEnemyKey/pickSkinView/listAtlasPages）
node test/gif-transparency.mjs # GIF 透明+循环回归（GCE disposal=2、NETSCAPE2.0、LZW 独立解码）

node test/desktop-ui.mjs      # 桌面 UI 冒烟（需先启动 desktop/server.mjs，无头 Chrome 加载+解析敌人）
node test/gif-gdi.mjs          # GDI+ 像素级交叉验证 GIF（再跑 test/gif-gdi.ps1）
```

## 数据源与许可

- 高清化功能源于 [yiyuxi123/Enlargement-software-for-Arknights-atlas-files](https://github.com/yiyuxi123/Enlargement-software-for-Arknights-atlas-files)（atlas 放大思路 + GUI 参考），本仓库以纯 JS 重写并补齐 offset 缩放、PNG 同步放大与 AI 超分；原版源码留存于 `_ref/src/` 供对照。
- 角色资源来自开源项目 [lozye/Ark-Models](https://github.com/lozye/Ark-Models)
- 角色资源也可来自 PRTS Wiki 官方模型（`--source prts`，抓取器见 `src/prts.mjs`），仅用于个人学习研究。
（镜像 [isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models)），仅用于个人学习研究。
- 下载器自动适配新格式清单（`{data, storageDirectory}`），按 MD5/SHA256 自动识别校验；同名角色多皮肤时默认选初始皮肤，可用 `--key`（如 `103_angel`）精确指定。
- Spine 运行时为 Esoteric Software 官方 3.8 发行版，遵循 Spine Runtimes License Agreement（见 `vendor/SkeletonBinary.3.8.ts` 头部）。
- Real-ESRGAN 由 [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) 开源，ncnn-vulkan 便携版由 nihui 维护；明日方舟角色版权归上海鹰角网络所有，请勿用于商业用途。

## 已知限制

- MP4 无透明通道：透明背景会自动用背景色 RGB 合成（默认黑底）；如需白底用 `--bg ffffffff`。首次使用 MP4 会自动下载约 81MB 的静态 FFmpeg（缓存于 `vendor/ffmpeg/`）。
- GIF 为全帧编码，长动画文件较大（640x640@30fps 约 6.9MB/6.5s）。
- GIF 编码采用 GCE `disposal=2`（恢复背景）+ 透明色索引 + `NETSCAPE2.0` 无限循环块：
  背景保持透明、动画在 Chrome/Edge/Windows 相册等播放器中循环播放，不会停在最后一帧
  （`test/gif-transparency.mjs` 对此做结构回归）。

- `--sr` 需要 Vulkan 显卡（Intel/AMD/NVIDIA 现代驱动均支持）；无 Vulkan 时自动回退 Lanczos3。
- 依赖系统 Chrome/Edge；WebGL 使用 SwiftShader 软件渲染，无需显卡。
