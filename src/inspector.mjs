// Spine Skeleton Inspector: lists every usable animation clip of a .skel file.
// Usage:
//   node src/inspector.mjs <character.skel>            -> human table
//   node src/inspector.mjs <character.skel> --json     -> machine JSON

import { readFileSync } from 'node:fs';
import { parseSkeleton } from './skel.mjs';

export function inspectSkeleton(skelPath) {
  const skeleton = parseSkeleton(readFileSync(skelPath));
  const animations = skeleton.animations.map((animation) => ({
    name: animation.name,
    duration: animation.duration,
  }));
  return { skeleton, animations };
}

function formatDuration(seconds) {
  if (seconds >= 1) return `${seconds.toFixed(2)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

export function main(argv) {
  const json = argv.includes('--json');
  const skelPath = argv.find((arg) => !arg.startsWith('-'));
  if (!skelPath) {
    console.error('Usage: node src/inspector.mjs <character.skel> [--json]');
    process.exit(2);
  }

  const { skeleton, animations } = inspectSkeleton(skelPath);

  if (json) {
    process.stdout.write(JSON.stringify({ skeleton: { ...skeleton, bones: undefined, slots: undefined, skins: undefined }, animations }, null, 2) + '\n');
    return;
  }

  console.log(`Skeleton: ${skeleton.hash || '(no hash)'}  spine ${skeleton.version}`);
  console.log(`Size: ${skeleton.width.toFixed(0)}x${skeleton.height.toFixed(0)}  FPS: ${skeleton.fps}`);
  console.log(`Bones: ${skeleton.bones.length}  Slots: ${skeleton.slots.length}  Skins: ${skeleton.skins.map((s) => s.name).join(', ')}  Events: ${skeleton.events.length}`);
  console.log('');
  console.log('Animations:');
  for (const animation of animations) {
    console.log(`  ${animation.name.padEnd(24)} ${formatDuration(animation.duration)}`);
  }
  console.log('');
  console.log(`Total: ${animations.length} animation clips`);
}

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}