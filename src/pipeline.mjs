// Arknights Spine Auto-Studio — unified CLI.
//
// Commands:
//   node src/pipeline.mjs fetch  [--enemy 霜星 | --key enemy_1505_frstar]
//   node src/pipeline.mjs fetch  [--character 阿米娅 | --key 002_amiya] [--refresh-manifest]
//   node src/pipeline.mjs inspect [--skel assets/amiya/amiya.skel]
//   node src/pipeline.mjs run    --prompt "先睡觉，然后跑步" [--skel ... | --character ...]
//                                [--mock] [--fps 30] [--size 640x640] [--format gif|png|mp4|all]
//   node src/pipeline.mjs --help
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSkeleton } from './skel.mjs';
import { choreograph, validateTimeline, timelineTotal } from './choreograph.mjs';
import { renderTimelineToGif } from './render.mjs';
import { encodePng } from './png.mjs';
import { loadManifest, findCharacter, downloadCharacter } from './download.mjs';
import { fetchCharacterFromPrts, listSkinsFromPrts } from './prts.mjs';
import { prepareUpscaledAssets } from './upscale.mjs';
import { ensureFfmpeg, renderMp4, ffmpegVersion, createMp4Writer } from './ffmpeg.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      let value = eq >= 0 ? arg.slice(eq + 1) : null;
      if (value === null && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      }
      args[key] = value === null ? true : value;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

const HELP = `
Arknights Spine Auto-Studio — 自然语言生成明日方舟角色动画 GIF/MP4

用法:
  node src/pipeline.mjs fetch  --character 阿米娅 [--source arkmodels|prts] [--refresh-manifest] [--out DIR]
  node src/pipeline.mjs fetch  --source prts --enemy 霜星 [--list-skins]
  node src/pipeline.mjs fetch  --source prts --character 阿米娅 [--skin 报童] [--view 基建] [--list-skins]
  node src/pipeline.mjs inspect [--skel assets/amiya/amiya.skel]
  node src/pipeline.mjs run    --prompt "先睡觉，然后起来跑步，最后累趴下"
                              [--skel assets/amiya/amiya.skel | --character 阿米娅 | --enemy 霜星]
                              [--source arkmodels|prts] [--skin 皮肤名] [--view 基建|正面|背面]
                              [--mock] [--fps 30] [--size 640x640] [--format gif|png|mp4|all]
                              [--out out/result.gif] [--mix 0.2] [--bg 00000000]
                              [--upscale 2] [--sr] [--sr-engine realesrgan]
  node src/pipeline.mjs upscale --atlas a.atlas --png a.png --scale 2 [--sr] [--out DIR]

选项:
  --source          角色资源来源: arkmodels（默认，GitHub 镜像）或 prts（PRTS Wiki 官方模型）
  --skin 皮肤名      仅 --source prts 时有效，如 --skin 报童；缺省用「默认」皮肤
  --view 视图        仅 --source prts 时有效: 基建（默认）/ 正面 / 背面
  --enemy 敌人名      仅 --source prts 时有效：抓取敌方模型（如 霜星 / 爱国者），可与 --list-skins 联用
  --list-skins       仅 fetch 时有效：列出该角色在 PRTS 的全部皮肤与视图
  --mock            离线关键词编排（默认：无 DEEPSEEK_API_KEY 时自动降级）
  --fps N           视频帧率（默认 30）
  --size WxH        输出画布尺寸（默认 640x640）
  --format          输出格式: gif（默认）、png（帧序列目录）、mp4、all
  --ffmpeg PATH     指定 ffmpeg 可执行文件（缺省时自动下载静态版到 vendor/ffmpeg）
  --bg RRGGBBAA     背景色（默认 00000000 透明）
  --mix SECONDS     动作过渡时长（默认 0.2）
  --out PATH        输出文件路径
  --timeline FILE   使用已保存的时间轴 JSON 渲染（跳过编排，可手动微调后复用）

高清化（atlas 与 PNG 同步放大，防止"放大 PNG 但裁切 atlas"导致的错位）:
  --upscale N       放大倍数（默认 1 不放大）；同时缩放 atlas 的 size/xy/orig/offset
                    与 PNG 贴图（Lanczos3 高质量重采样）
  --sr              启用 AI 超分引擎放大 PNG（默认 Real-ESRGAN anime6B；
                    首次使用自动下载约 43MB 到 vendor/realesrgan/，需要 Vulkan 显卡）
  --sr-engine NAME|PATH  引擎名（realesrgan/waifu2x/realcugan）或已下载的 exe 路径
  --sr-scale N      引擎自身放大倍数（默认用引擎原生倍数；与 --upscale 不一致时
                    自动用 Lanczos3 桥接，保证 atlas/PNG 始终同步）
  --sr-gpu N        GPU 编号（多卡机器用，默认 0）
  --sr-tile N       引擎分块大小（显存不足时如 256；默认 0 自动）
`;

function printHelp() {
  console.log(HELP);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdFetch(args) {
  const outDir = path.resolve(args.out || path.join(root, 'assets'));
  const source = String(args.source || 'arkmodels').toLowerCase();
  if (source === 'prts') {
    if (args['list-skins']) {
      await listSkinsFromPrts({ character: args.character, key: args.key, enemy: args.enemy });
      return null;
    }
    const result = await fetchCharacterFromPrts({
      character: args.character,
      key: args.key,
      enemy: args.enemy,
      skin: args.skin,
      view: args.view,
      outDir,
      force: !!args.force,
    });
    console.log(`已下载 ${result.characterName}（PRTS ${result.charId} / ${result.skin} / ${result.view}）→ ${outDir}`);
    for (const file of [result.skel, result.atlas, result.png]) console.log('  ', file);
    return [result.skel, result.atlas, result.png];
  }
  const manifest = await loadManifest({ refresh: !!args['refresh-manifest'] });
  const entry = findCharacter(manifest, { character: args.character, key: args.key });
  if (!entry) {
    throw new Error(`未找到角色（character=${args.character ?? ''} key=${args.key ?? ''}），先执行 --refresh-manifest`);
  }
  const files = await downloadCharacter(entry, { outDir });
  console.log(`已下载 ${entry.key} (${entry.assetId}) → ${outDir}`);
  for (const file of files) console.log('  ', file);
  return files;
}

async function cmdInspect(args) {
  const skelPath = path.resolve(args.skel || 'assets/amiya/amiya.skel');
  const skeleton = parseSkeleton(new Uint8Array(fs.readFileSync(skelPath)));
  console.log(`Skeleton: ${skeleton.hash}  spine ${skeleton.version}`);
  console.log(`Bones: ${skeleton.bones.length}  Slots: ${skeleton.slots.length}  Skins: ${skeleton.skins.length}  Events: ${skeleton.events.length}`);
  console.log('');
  console.log('Animations:');
  for (const animation of skeleton.animations) {
    console.log(`  ${animation.name.padEnd(12)} ${animation.duration.toFixed(3).padStart(8)}s  (${animation.timelines.length} timelines)`);
  }
  console.log('');
  console.log(`Total: ${skeleton.animations.length} animation clips`);
  return skeleton;
}

async function cmdUpscale(args) {
  if (!args.atlas || !args.png) throw new Error('upscale 命令必须同时指定 --atlas 与 --png，例如：--atlas a.atlas --png a.png --scale 2');
  const atlasPath = path.resolve(args.atlas);
  const pngPath = path.resolve(args.png);
  const scale = Math.max(1, parseInt(args.scale || '2', 10) || 2);
  const outDir = args.out
    ? path.resolve(args.out)
    : path.join(path.dirname(pngPath), path.basename(pngPath, path.extname(pngPath)) + '-hi');
  // 先对齐 atlas 声明尺寸与实际 PNG 尺寸，避免高清化在错误基准上叠加
  {
    const { alignAssetsInPlace } = await import('./align.mjs');
    try { alignAssetsInPlace({ atlasPath, pngPath, onLog: (m) => console.log(m) }); } catch (e) { console.log('[align] 跳过对齐: ' + e.message); }
  }
  let srHandle = null;
  if (args.sr || args['sr-engine']) {
    const { resolveEngine } = await import('./sr.mjs');
    srHandle = await resolveEngine(args['sr-engine'] || (typeof args.sr === 'string' ? args.sr : null), {
      onLog: (m) => console.log(m),
    });
  }
  const result = await prepareUpscaledAssets({
    atlasPath,
    pngPath,
    scale,
    outDir,
    sr: srHandle,
    srScale: parseInt(args['sr-scale'] || '0', 10) || 0,
    srGpu: parseInt(args['sr-gpu'] || '0', 10) || 0,
    srTile: parseInt(args['sr-tile'] || '0', 10) || 0,
    slice: !!args.slice,
    onLog: (m) => console.log(m),
  });
  console.log(`[done] 高清化完成 x${scale}：atlas 与 PNG 同步缩放${args.slice ? '（切片模式）' : ''}`);
  console.log('  ', result.atlas);
  console.log('  ', result.png);
  return [result.atlas, result.png];
}

async function resolveAssets(args) {
  const source = String(args.source || 'arkmodels').toLowerCase();
  if (source === 'prts') {
    const result = await fetchCharacterFromPrts({
      character: args.character,
      key: args.key,
      enemy: args.enemy,
      skin: args.skin,
      view: args.view,
      outDir: path.resolve(args['assets-dir'] || path.join(root, 'assets')),
      force: !!args.force,
    });
    return {
      skel: result.skel,
      atlas: result.atlas,
      png: result.png,
      dir: result.dir,
      characterName: result.characterName,
      source: 'prts',
      prts: { charId: result.charId, skin: result.skin, view: result.view, version: result.version },
    };
  }
  if (args.skel) {
    const skel = path.resolve(args.skel);
    const base = skel.slice(0, skel.lastIndexOf('.'));
    const atlas = path.resolve(args.atlas || base + '.atlas');
    const png = path.resolve(args.png || base + '.png');
    for (const file of [skel, atlas, png]) {
      if (!fs.existsSync(file)) throw new Error(`缺少资源文件: ${file}`);
    }
    return { skel, atlas, png, dir: path.dirname(skel), characterName: path.basename(skel).replace(/\.skel$/, '') };
  }
  const manifest = await loadManifest({ refresh: !!args['refresh-manifest'] });
  const entry = findCharacter(manifest, { character: args.character, key: args.key });
  if (!entry) {
    throw new Error(`未找到角色（character=${args.character ?? ''} key=${args.key ?? ''}）`);
  }
  const outDir = path.resolve(args['assets-dir'] || path.join(root, 'assets'));
  await downloadCharacter(entry, { outDir });
  const assetRoot = path.join(outDir, entry.key);
  const assetId = entry.assetId;
  return {
    skel: path.join(assetRoot, assetId + '.skel'),
    atlas: path.join(assetRoot, assetId + '.atlas'),
    png: path.join(assetRoot, assetId + '.png'),
    dir: assetRoot,
    characterName: entry.name || entry.appellation || entry.key,
  };
}

function parseSize(text) {
  const match = String(text).match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) throw new Error(`无法解析尺寸: ${text}（应为 WxH，如 640x640）`);
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

async function cmdRun(args) {
  const prompt = String(args.prompt ?? '');
  if (!prompt && !args.timeline) throw new Error('run 需要 --prompt（例如：--prompt "先睡觉，然后跑步"）');
  const fps = Math.min(60, Math.max(1, parseInt(args.fps || '30', 10) || 30));
  const { width, height } = parseSize(args.size || '640x640');
  const mix = parseFloat(args.mix || '0.2') || 0.2;
  const background = String(args.bg || '00000000');
  const format = String(args.format || 'gif').toLowerCase();

  const assets = await resolveAssets(args);
  let assetsList = null;
  if (args['assets-list']) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args['assets-list']), 'utf8'));
    assetsList = raw.map((a) => ({
      name: a.name || 'default',
      skel: path.resolve(a.skel),
      atlas: path.resolve(a.atlas),
      png: path.resolve(a.png),
    }));
    for (const a of assetsList) {
      for (const k of ['skel', 'atlas', 'png']) {
        if (!fs.existsSync(a[k])) throw new Error('视图 ' + a.name + ' 缺少文件: ' + a[k]);
      }
    }
  }
  // 对齐 atlas 声明尺寸与实际 PNG 尺寸（PRTS 贴图可能被降采样，不修复会渲染散架）
  {
    const { alignAssetsInPlace } = await import('./align.mjs');
    const targets = assetsList || [{ atlas: assets.atlas, png: assets.png }];
    for (const t of targets) {
      try { alignAssetsInPlace({ atlasPath: t.atlas, pngPath: t.png, onLog: (m) => console.log(m) }); } catch (e) { console.log('[align] 跳过对齐: ' + e.message); }
    }
  }
  const animationsByView = assetsList
    ? Object.fromEntries(assetsList.map((a) => [a.name, parseSkeleton(new Uint8Array(fs.readFileSync(a.skel))).animations.map((x) => ({ name: x.name, duration: x.duration }))]))
    : null;
  const skeleton = parseSkeleton(new Uint8Array(fs.readFileSync(assets.skel)));
  const animations = animationsByView ? Object.values(animationsByView).flat() : skeleton.animations.map((a) => ({ name: a.name, duration: a.duration }));

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const useMock = !!args.mock || !apiKey;
  if (!useMock && args.mock === false) {
    // explicit --mock=false and key present -> llm
  }
  let plan;
  if (args.timeline) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(args.timeline), 'utf8'));
    if (!Array.isArray(saved.timeline) || saved.timeline.length === 0) {
      throw new Error('时间轴文件缺少 timeline 数组: ' + args.timeline);
    }
    plan = validateTimeline({
      character: saved.character ?? assets.characterName,
      fps: saved.fps ?? fps,
      timeline: saved.timeline,
      mode: 'edited',
    }, animations, animationsByView);
    console.log('[choreograph] mode=edited 使用时间轴 ' + path.resolve(args.timeline));
  } else {
    plan = await choreograph({
      prompt,
      animations,
      character: assets.characterName,
      fps,
      mock: useMock,
      apiKey,
      model: process.env.DEEPSEEK_MODEL,
      baseURL: process.env.DEEPSEEK_BASE_URL,
    });
  }
  console.log(`[choreograph] mode=${plan.mode} 角色=${plan.character} 总时长=${timelineTotal(plan).toFixed(2)}s`);
  for (const seg of plan.timeline) {
    console.log(`  - ${seg.action.padEnd(10)} loop=${seg.loop} ${seg.duration.toFixed(2)}s x${seg.timeScale}  ${seg.description || ''}`.trim());
  }

  const outBase = args.out ? path.resolve(args.out) : path.join(root, 'out', `${plan.character}-${Date.now()}`);
  const outDir = path.dirname(outBase);
  fs.mkdirSync(outDir, { recursive: true });
  const stem = outBase.endsWith('.gif') || outBase.endsWith('.png') || outBase.endsWith('.mp4') ? outBase.slice(0, outBase.lastIndexOf('.')) : outBase;

  // save timeline JSON
  const timelineFile = stem + '.timeline.json';
  fs.writeFileSync(timelineFile, JSON.stringify({ character: plan.character, fps, timeline: plan.timeline, mode: plan.mode }, null, 2));
  console.log(`[plan] ${timelineFile}`);

  // ---- 高清化：同步放大 atlas 与 PNG（可选 AI 超分） ----
  let renderAssets = assets;
  let renderAssetsList = assetsList;
  const upscale = Math.min(8, Math.max(1, parseInt(args.upscale || '1', 10) || 1));
  const wantSr = !!args.sr || !!args['sr-engine'];
  if (upscale > 1 || wantSr) {
    const targetScale = upscale > 1 ? upscale : 4; // 仅 --sr 时默认按引擎原生 4x
    let srHandle = null;
    if (wantSr) {
      const { resolveEngine } = await import('./sr.mjs');
      const spec = args['sr-engine'] || (typeof args.sr === 'string' ? args.sr : null);
      srHandle = await resolveEngine(spec, { onLog: (m) => console.log(m) });
    }
    if (renderAssetsList) {
      renderAssetsList = [];
      for (const a of assetsList) {
        const hiDir = path.join(outDir, path.basename(stem) + '-hi-' + a.name);
        const prepared = await prepareUpscaledAssets({
          atlasPath: a.atlas,
          pngPath: a.png,
          scale: targetScale,
          outDir: hiDir,
          sr: srHandle,
          srScale: parseInt(args['sr-scale'] || '0', 10) || 0,
          srGpu: parseInt(args['sr-gpu'] || '0', 10) || 0,
          srTile: parseInt(args['sr-tile'] || '0', 10) || 0,
          onLog: (m) => console.log(m),
        });
        console.log(`[hi-res] 视图 ${a.name} 高清化 x${targetScale}： -> ${hiDir}`);
        renderAssetsList.push({ name: a.name, skel: a.skel, atlas: prepared.atlas, png: prepared.png });
      }
    } else {
      const hiDir = path.join(outDir, path.basename(stem) + '-hi');
      const prepared = await prepareUpscaledAssets({
        atlasPath: assets.atlas,
        pngPath: assets.png,
        scale: targetScale,
        outDir: hiDir,
        sr: srHandle,
        srScale: parseInt(args['sr-scale'] || '0', 10) || 0,
        srGpu: parseInt(args['sr-gpu'] || '0', 10) || 0,
        srTile: parseInt(args['sr-tile'] || '0', 10) || 0,
        onLog: (m) => console.log(m),
      });
      console.log(`[hi-res] 高清化 x${targetScale}：atlas + PNG -> ${hiDir}`);
      renderAssets = { skel: assets.skel, atlas: prepared.atlas, png: prepared.png };
    }
  }

  const relAsset = (p) => path.relative(root, p).replace(/\\/g, '/');
  const wantGif = format === 'gif' || format === 'all';
  const wantPng = format === 'png' || format === 'all';
  const wantMp4 = format === 'mp4' || format === 'all';
  const outputs = [];
  if (wantGif) {
    const gifFile = stem + '.gif';
    console.log(`[render] 启动无头浏览器渲染 ${width}x${height} @${fps}fps ...`);
    const result = await renderTimelineToGif({
      rootDir: root,
      assets: { skel: relAsset(renderAssets.skel), atlas: relAsset(renderAssets.atlas), png: relAsset(renderAssets.png) },
      assetsList: renderAssetsList ? renderAssetsList.map((a) => ({ name: a.name, skel: relAsset(a.skel), atlas: relAsset(a.atlas), png: relAsset(a.png) })) : undefined,
      timeline: plan,
      outFile: gifFile,
      width,
      height,
      fps,
      background,
      mix,
      onFrame: (f, n) => {
        if (f === 1 || f % Math.max(1, Math.round(n / 10)) === 0 || f === n) {
          console.log(`  [render] ${f}/${n} 帧`);
        }
      },
    });
    console.log(`[done] ${gifFile} (${(result.bytes / 1024).toFixed(1)} KB, ${result.frames} 帧, ${result.seconds.toFixed(2)}s)`);
    outputs.push(gifFile);
  }
  if (wantPng || wantMp4) {
    const pngDir = wantPng ? stem + '-frames' : null;
    if (pngDir) fs.mkdirSync(pngDir, { recursive: true });
    let mp4Writer = null;
    let mp4File = null;
    if (wantMp4) {
      let ffmpeg;
      if (args.ffmpeg) {
        const version = ffmpegVersion(path.resolve(args.ffmpeg));
        if (!version) throw new Error(`--ffmpeg 指定的程序无法运行: ${args.ffmpeg}`);
        ffmpeg = { path: path.resolve(args.ffmpeg), version };
      } else {
        console.log('[ffmpeg] 未检测到系统 FFmpeg，准备下载静态版（约 81MB）...');
        let lastPct = 0;
        ffmpeg = await ensureFfmpeg({
          onProgress: (received, total) => {
            const pct = total ? Math.floor((received / total) * 100) : 0;
            if (pct >= lastPct + 10) {
              lastPct = pct;
              console.log(`  [ffmpeg] ${pct}% (${(received / 1048576).toFixed(0)} MB)`);
            }
          },
        });
        console.log(`[ffmpeg] ${ffmpeg.version} -> ${ffmpeg.path}`);
      }
      // MP4 无透明通道：使用背景色的 RGB 通道合成（默认 00000000 -> 黑色底）
      const bgMatch = String(background).replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
      const bg = bgMatch ? [parseInt(bgMatch[1], 16), parseInt(bgMatch[2], 16), parseInt(bgMatch[3], 16)] : [255, 255, 255];
      mp4File = stem + '.mp4';
      console.log(`[mp4] 合成背景 RGB(${bg.join(',')}) 并编码 ...`);
      mp4Writer = createMp4Writer({ width, height, fps, outFile: mp4File, background: bg, ffmpegPath: ffmpeg.path });
    }
    const result = await renderFramesToPng({
      rootDir: root,
      assets: { skel: relAsset(renderAssets.skel), atlas: relAsset(renderAssets.atlas), png: relAsset(renderAssets.png) },
      assetsList: renderAssetsList ? renderAssetsList.map((a) => ({ name: a.name, skel: relAsset(a.skel), atlas: relAsset(a.atlas), png: relAsset(a.png) })) : undefined,
      timeline: plan,
      width,
      height,
      fps,
      background,
      mix,
      onFrame: async (rgba, idx, n) => {
        if (pngDir) fs.writeFileSync(path.join(pngDir, `frame-${String(idx - 1).padStart(4, '0')}.png`), encodePng(rgba, width, height));
        if (mp4Writer) await mp4Writer.write(rgba);
        if (idx % Math.max(1, Math.round(n / 10)) === 0 || idx === n) console.log(`  [frames] ${idx}/${n}`);
      },
    });
    if (pngDir) {
      console.log(`[done] ${pngDir} (${result.frames} ? PNG)`);
      outputs.push(pngDir);
    }
    if (mp4Writer) {
      await mp4Writer.end();
      const sizeKb = (fs.statSync(mp4File).size / 1024).toFixed(1);
      console.log(`[done] ${mp4File} (${sizeKb} KB)`);
      outputs.push(mp4File);
    }
  }
  return outputs;
}

// PNG frame export path (same browser pipeline, returns RGBA frames instead of GIF)
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { decodePng } from './png.mjs';
async function renderFramesToPng({ rootDir, assets, assetsList, timeline, width, height, fps, background = '00000000', mix = 0.2, chromePath, onFrame }) {
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(await import('node:os').then((m) => m.tmpdir()), 'spine-studio-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });

  let cdp = null;
  try {
    cdp = new CdpClient(await chrome.wsUrl());
    await cdp.open();
    const rel = (p) => '/' + String(p).replace(/\\/g, '/').replace(/^\/?/, '');
    const views = Array.isArray(assetsList) && assetsList.length
      ? assetsList.map((a) => ({ name: a.name || 'default', skel: rel(a.skel), atlas: rel(a.atlas), png: rel(a.png) }))
      : [{ name: 'default', skel: rel(assets.skel), atlas: rel(assets.atlas), png: rel(assets.png) }];
    const query = new URLSearchParams({ skel: views[0].skel, atlas: views[0].atlas, png: views[0].png, views: JSON.stringify(views), w: String(width), h: String(height), bg: background, mix: String(mix) });
    const { sessionId } = await newPageSession(cdp, `${server.origin}/render/index.html?${query}`);
    const send = (m, p) => cdp.send(m, p, sessionId);
    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    const segments = timeline.timeline;
    const segDuration = (seg) => (seg.duration || 0) * Math.max(1, parseInt(seg.repeat, 10) || 1);
    const total = segments.reduce((sum, seg) => sum + segDuration(seg), 0);
    const frameCount = Math.max(1, Math.round(total * fps));
    let segIndex = 0, segmentStart = 0, lastCycle = -1;
    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      while (segIndex < segments.length - 1 && t >= segmentStart + segDuration(segments[segIndex])) {
        segmentStart += segDuration(segments[segIndex]);
        segIndex++;
        lastCycle = -1;
      }
      const seg = segments[segIndex];
      const repeatN = Math.max(1, parseInt(seg.repeat, 10) || 1);
      const cycleDur = seg.duration > 0 ? seg.duration : 1;
      const cycle = Math.min(Math.floor((t - segmentStart) / cycleDur), repeatN - 1);
      const restart = cycle !== lastCycle;
      lastCycle = cycle;
      await evalJs(send, `studio.step(${JSON.stringify({ action: seg.action, view: seg.view || 'default', loop: seg.loop, delta: 1 / fps, timeScale: seg.timeScale || 1, restart })})`);
      const dataUrl = await evalJs(send, 'studio.snapshot()');
      const dec = decodePng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      if (onFrame) await onFrame(dec.rgba, f + 1, frameCount, seg.action);
    }
    return { frames: frameCount };
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || (args.help ? 'help' : null);
  if (args.help || args.h || command === 'help') {
    printHelp();
    return;
  }
  switch (command) {
    case 'fetch':
      return cmdFetch(args);
    case 'inspect':
      return cmdInspect(args);
    case 'run':
      return cmdRun(args);
    case 'upscale':
      return cmdUpscale(args);
    default:
      printHelp();
      throw new Error(`未知命令: ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('\n[error]', err.stack || err.message || err);
      process.exit(1);
    },
  );
}
