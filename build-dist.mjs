// ============================================================================
// 发布包构建：node build-dist.mjs [--full]
//   默认：精简版（代码 + Spine 播放器 + 内置阿米娅 + 启动器，约 1~2MB；
//         ffmpeg / AI 超分引擎首次运行时自动下载）
//   --full：额外打包 vendor/ffmpeg 与全部 AI 超分引擎（体积约 200MB）
//   输出：dist/ArknightsSpineStudio-<版本>[-full]-<日期>.zip
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes('--full');

// ---------- 安全闸：禁止把本机 API Key 打进发布包 ----------
const configFile = path.join(root, 'config.json');
if (fs.existsSync(configFile)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (cfg.deepseekApiKey || process.env.DEEPSEEK_API_KEY || cfg.visionApiKey || process.env.DASHSCOPE_API_KEY) {
      console.error('[安全] 检测到本机已配置 DeepSeek / 千问视觉 API Key（config.json 或环境变量）。');
      console.error('[安全] 为防止 Key 随发布包泄露，构建已中止。请先运行桌面版「设置 → 清除 Key」');
      console.error('[安全] 或删除 config.json 中的 deepseekApiKey / visionApiKey 字段后再打包。');
      process.exit(1);
    }
  } catch { /* config.json 损坏时忽略 */ }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const name = `ArknightsSpineStudio-v${pkg.version}${full ? '-full' : ''}-${stamp}`;
const distDir = path.join(root, 'dist');
const stage = path.join(distDir, name);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

function copy(relSrc, relDst = relSrc) {
  const src = path.join(root, relSrc);
  const dst = path.join(stage, relDst);
  if (!fs.existsSync(src)) {
    console.log(`  [skip] 不存在: ${relSrc}`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  const stat = fs.statSync(dst);
  console.log(`  [copy] ${relSrc}${stat.isDirectory() ? '/' : ''}`);
}

console.log(`构建发布包: ${name}`);
console.log(`模式: ${full ? '完整版（含 ffmpeg + AI 超分引擎）' : '精简版（ffmpeg/超分引擎按需自动下载）'}`);

// ---- 核心代码 ----
copy('package.json');
copy('README.md');
copy('start-desktop.cmd');
copy('install-desktop.cmd');
copy('src');
copy('render');
copy('scripts');
copy('desktop/server.mjs');
copy('desktop/electron-main.cjs');
copy('desktop/electron-preload.cjs');
copy('desktop/wait-ready.mjs');
copy('desktop/package.json');
copy('desktop/ui');

// ---- 运行时 ----
copy('vendor/spine-player.js');
copy('vendor/spine-core.js');
copy('vendor/SkeletonBinary.3.8.ts');
if (full) {
  copy('vendor/ffmpeg');
  copy('vendor/realesrgan');
  copy('vendor/waifu2x');
  copy('vendor/realcugan');
}

// ---- 内置示例资源 ----
copy('assets/amiya');

// ---- 使用说明 ----
const readme = `明日方舟 Spine 自动动画工作室 v${pkg.version} 使用说明
====================================================

一、启动
  双击 start-desktop.cmd 即可打开桌面版窗口。
  - 已安装 Electron 时：使用独立桌面窗口（更完整，可一键打开输出目录）。
  - 未安装时：自动使用 Chrome 应用窗口（零安装，推荐）。
  - 可选：双击 install-desktop.cmd 安装 Electron 桌面版（约 100MB，国内自动走镜像）。

二、API Key（可选，不填也能用）
  DeepSeek 智能编排：设置 → DeepSeek 卡片填 Key（platform.deepseek.com 创建）→ 测试 → 保存；
    模型默认 deepseek-v4-flash，地址默认 https://api.deepseek.com。
  千问视觉标注：设置 → 千问视觉卡片填 DashScope Key（bailian.console.aliyun.com 创建）→ 测试 → 保存；
    模型默认 qwen-vl-max。不填则用离线规则猜测 + 手动标注。
  三档模式：不配 Key = 纯离线；只配 DeepSeek = 半自动；双 Key = 全自动（千问看图打标 + DeepSeek 编排）。
  说明：Key 仅保存在本机 config.json，不会上传、不会打进发布包（打包有安全闸）。

三、基本流程（四步：拉取 → 高清化(可选) → 编排时间轴 → 生成动画）
  1. 拉取模型：输入干员/异格/敌人名称 →「解析」→ 选皮肤/视图 →「拉取三件套」；
     拉取后不会自动跳转，点击「下一步」进入高清化，或「跳过」直接去编排时间轴；
  2. 高清化（可选）：选模型与倍数 →「生成方案对比」→ 4 格并排对比
     （灰=原图 蓝=Lanczos 绿=Real-ESRGAN 紫=Waifu2x）→ 点选满意方案 →「开始高清化」；
     完成后点「采用这套高清化资源」，后续预览与生成都会用高清资源（不会重复放大）；
     也可以直接「跳过高清化」用原图；
  3. 编排时间轴：先「生成动作预览」看每个动作长什么样（⚡单帧 或 🎬完整动画 GIF，默认 GIF），
     动作名看不懂可点「🤖 AI 自动标注」（千问视觉 + 离线规则，结果存本地动作字典）；
     然后两种排法任选：① 写自然语言（如「先睡觉，然后起来跑步」）让 DeepSeek 编排；
     ② 在预览卡上点「＋ 加入时间轴」手动排布；下方 PR 式色块条可改时长/循环/倍速/顺序；
  4. 生成动画：确认资源与时间轴 →「开始生成」；任意输出卡片可点击放大预览。

四、常见问题
  - 首次生成 MP4 会自动下载 ffmpeg（约 77MB，仅精简版需要）；
  - AI 超分需要 Vulkan 显卡，首次使用自动下载引擎（约 40MB）；
  - 渲染使用本机 Chrome/Edge，请确保已安装；
  - 服务仅监听 127.0.0.1，数据不出本机。

五、目录说明
  assets/       角色资源缓存（三件套）
  out/          生成的 GIF/MP4 与时间轴 JSON
  config.json   DeepSeek API Key（本机保存，首次保存后生成）
`;
fs.writeFileSync(path.join(stage, 'USAGE.txt'), readme, 'utf8');
console.log('  [gen] USAGE.txt');

// ---- 打包 zip ----
const zipFile = path.join(distDir, `${name}.zip`);
fs.rmSync(zipFile, { force: true });
execFileSync('tar', ['-a', '-c', '-f', zipFile, '-C', distDir, name], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true }); // 清理暂存目录
const size = fs.statSync(zipFile).size;
console.log(`\n完成: ${zipFile}`);
console.log(`体积: ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log('\n发布前请自检：');
console.log('  1. 解压到全新目录（不要覆盖现有 config.json，避免 Key 混淆）');
console.log('  2. 双击 start-desktop.cmd 启动');
console.log('  3. 在「模型资源」拉取一个模型并生成一段动画');