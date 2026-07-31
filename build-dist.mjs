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
    if (cfg.deepseekApiKey || process.env.DEEPSEEK_API_KEY) {
      console.error('[安全] 检测到本机已配置 DeepSeek API Key（config.json 或环境变量）。');
      console.error('[安全] 为防止 Key 随发布包泄露，构建已中止。请先运行桌面版「设置 → 清除 Key」');
      console.error('[安全] 或删除 config.json 中的 deepseekApiKey 字段后再打包。');
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

二、DeepSeek API Key（可选，不填也能用）
  1. 点击窗口右上角「⚙ 设置」按钮；
  2. 填入 API Key（在 platform.deepseek.com 创建，格式 sk-...）；
  3. 点「保存」（可先点「测试连接」验证）。
  说明：Key 仅保存在本机 config.json，不会上传；不填则自动使用离线关键词编排。
  模型默认为 deepseek-v4-flash，地址默认为 https://api.deepseek.com，均可修改。

三、基本流程
  1. 模型资源：输入干员/异格/敌人名称 →「解析」→ 选皮肤/视图 →「拉取三件套」；
  2. 动画生成：选择模型 → 写下动作描述（如「先睡觉，然后起来跑步」）→「开始生成」；
  3. 时间轴：可修改每段动作的时长/循环/倍速 →「仅重渲染」；
  4. 高清化：选模型与倍数 →「生成方案对比」→ 看 4 格效果（灰=原图 蓝=Lanczos 绿=Real-ESRGAN
     紫=Waifu2x）→ 点选方案 →「开始高清化」；方案自动同步到动画生成参数。

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