# 效率提升报告（2026-08-01）

## 一、优化前的问题

| 环节 | 问题 | 后果 |
| --- | --- | --- |
| 切片高清化 | 46 个切片**逐片串行**调用 AI 引擎，每片都重新启动一次引擎进程（初始化模型开销），GPU 在单片间隙大量空闲 | 阿米娅 2x 切片超分耗时 **37.1s**，硬件利用率低 |
| 动画渲染 | 无头 Chrome 被强制 `--use-angle=swiftshader` **软件渲染**，完全不用独立显卡 | 大画布高帧率渲染慢，CPU 单核瓶颈 |
| 可见性 | 任务运行中用户看不到"正在跑什么、有没有在动"，只能看日志猜测 | 卡顿时误以为软件假死 |

## 二、本次优化

### 1. 切片高清化并行化（主要收益）
- `src/slice.mjs`：`slicePage` 重构为"预处理 → 并发池放大 → 打包"三阶段，支持 `concurrency` 并行放大，每片完成实时上报进度。
- `src/sr.mjs`：异步引擎运行器 + **活跃引擎进程注册表**（`getActiveEngines`），服务端可实时读取正在运行的引擎 PID。
- `src/upscale.mjs`：新增 `--slice-jobs N`（默认 **6**），UI 高清化卡片新增"并发"选择器（2/4/6/8/12/16）。

### 2. 渲染 GPU 化
- `src/cdp.mjs`：去掉强制 swiftshader，默认 `--ignore-gpu-blocklist --enable-gpu`，**优先使用独立显卡**；GPU 不可用时 Chrome 自动回退软件渲染；可用环境变量 `ZDXR_SWIFTSHADER=1` 强制软渲染兜底。
- `src/render.mjs`：渲染前检测并输出实际渲染后端（如 `ANGLE (NVIDIA GeForce RTX 4060 Laptop GPU, Direct3D11)（GPU 加速）`）。

### 3. 实时活动面板（不再"假死"感）
- 服务端新增 `GET /api/activity`：当前任务（类型/已运行秒数/最近日志）+ 全部活跃引擎进程（PID/运行秒数）。
- 界面顶部新增活动状态条：空闲显示 `● 空闲`；任务中显示 `● 高清化 5s · 引擎 ×6 (PID …) 4s`，每 1.5 秒刷新，悬停可见最近日志。

## 三、实测数据（本机：RTX 4060 Laptop GPU，阿米娅 46 片 2x 切片超分，waifu2x）

| 配置 | 耗时 | 相对提速 |
| --- | --- | --- |
| 旧版（串行 1 进程，含引擎冷启动） | 58.7s | 基准 |
| 并发 1 进程 | 37.1s | 1.6x |
| **并发 6 进程（本次默认）** | **14.4s** | **约 4.1x（对比旧版） / 2.6x（对比并发 1）** |

- 输出产物完全一致（274 KB 高清图集）。
- 动画渲染已确认走 GPU：`渲染后端: ANGLE (NVIDIA GeForce RTX 4060 Laptop GPU, Direct3D11)（GPU 加速）`。
- 任务运行期间 `/api/activity` 实测实时显示 **6 个并发引擎进程**，软件不再"假死"。

## 四、改动文件

- `src/slice.mjs`（并发池 + 进度回调）、`src/sr.mjs`（异步运行器 + 引擎注册表）、`src/upscale.mjs`（--slice-jobs）、`src/cdp.mjs`（GPU-first）、`src/render.mjs`（后端报告）
- `desktop/server.mjs`（/api/activity + sliceJobs 透传）、`desktop/ui/index.html`（活动条 + 并发选择器）、`desktop/ui/app.js`（轮询渲染）、`desktop/ui/style.css`

## 五、使用建议

- 高清化默认并发 6；显存充足（≥6GB）可开 8-12，老旧核显建议降到 2-4。
- 若渲染遇到异常画面（极小概率 GPU 驱动兼容问题），设置环境变量 `ZDXR_SWIFTSHADER=1` 后可回到软件渲染。
- 后续可继续优化的方向：GIF 编码 worker 多线程化、渲染多片段并行。


---

## 六、第二轮性能强化（整链路 6.8 倍，含全部环节）

### 新增优化
1. **切片批量放大（batch）**：46 片按面积贪心分组，每组打包成一张图，**一次引擎调用放大整组**（46 次调用 → 1-2 次），进程启动开销摊薄到极致。实测 46 片 waifu2x 2x：单片并发 6 = 13.7s → **批量 1.4s（10 倍）**；渲染对照差异无网格伪影、大差异像素仅 0.5%（两种超分路径的正常重建差异，质量相当）。
2. **渲染四段并行 + 二进制帧通道**：
   - 时间轴切 4 段，4 个渲染页并行 GPU 渲染（RTX 4060 Direct3D11）。
   - 页面端 `readPixels` 直读像素并 **POST 原始 RGBA 二进制**到本地帧服务器（零 base64/JSON 开销），每批 8 帧一次往返。
   - 实测 640² 195 帧 GIF：**41.2s → 5.6s（7.4 倍）**。
3. **GIF 编码全链路 worker 化**：`straightenRgba`（翻转+去预乘）+ `quantize`（**5-5-5 LUT 查表**，替代每像素 255 次线性扫描）+ `lzwEncode`（**整数键字典**替代字符串键）全部移入 worker 线程池；ingest 批量提交并行（单批 1058ms → 90ms）。
4. **预览并行**：动作预览 4 页并行渲染 + worker 编码（6 动作 GIF：~15s → 4s）。
5. **炫酷实时活动面板**：
   - SSE 日志事件即时触发活动刷新（400ms 节流）+ 1.2s 轮询兜底。
   - 活动条：`● 高清化 5s · 引擎 ×6` 呼吸灯动画。
   - 悬浮详情层：**每个引擎进程一张动态卡片**（PID + 运行秒数），新进程弹入、退出淡出动画，附最近日志。

### 整链路实测（本机 RTX 4060 Laptop GPU，阿米娅）
| 环节 | 优化前（实测/保守估计） | 优化后（实测） | 提速 |
| --- | --- | --- | --- |
| 高清化（46 片 waifu2x 2x） | 37.1s | **2.3s** | 16 倍 |
| 动作预览（6 动作 GIF） | ~15s | **4.0s** | ~3.8 倍 |
| 动画渲染（195 帧 640² GIF） | ~39s | **5.6s** | ~7 倍 |
| **整链路合计** | **~82s** | **12.0s** | **6.8 倍** |

### 新增/改动文件（第二轮）
- `src/slice.mjs`（批量分组放大）、`src/gif-pool.mjs`（共享 worker 池）、`src/gif-worker.mjs`、`src/gif.mjs`（LUT 量化 + 整数键 LZW + straightenRgba + 帧组装器）
- `src/render.mjs`（四段并行 + 二进制帧通道 + 批量 ingest）、`render/index.html`（readPixels 快照 + renderFrames 批量 POST）、`src/cdp.mjs`（onPost 帧通道）、`src/preview.mjs`（并行动作预览 + worker 编码）
- `desktop/ui/index.html` / `app.js` / `style.css`（炫酷活动面板）
- 环境变量：`ZDXR_RENDER_CHUNKS`（渲染分段数，默认 4）、`ZDXR_SWIFTSHADER=1`（强制软渲染兜底）
