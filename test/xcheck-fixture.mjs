import fs from 'node:fs';
const code = fs.readFileSync('vendor/spine-core.js', 'utf8');
const needle = '\t\treturn BinaryInput;\n\t}());\n\tvar LinkedMesh';
const patched = code.replace(needle, '\t\treturn BinaryInput;\n\t}());\n\tspine.BinaryInput = BinaryInput;\n\tvar LinkedMesh');
const spine = new Function(patched + '\n;return spine;')();
const { parseSkeleton } = await import('../src/skel.mjs');

const fakeRegion = () => ({ u: 0, v: 0, u2: 1, v2: 1, width: 100, height: 100, originalWidth: 100, originalHeight: 100, offsetX: 0, offsetY: 0, rotate: false });
const loader = {
  newRegionAttachment(skin, name, path) { const a = new spine.RegionAttachment(name); a.region = fakeRegion(); return a; },
  newMeshAttachment(skin, name, path) { const a = new spine.MeshAttachment(name); a.region = fakeRegion(); return a; },
  newBoundingBoxAttachment(skin, name) { return new spine.BoundingBoxAttachment(name); },
  newClippingAttachment(skin, name) { return new spine.ClippingAttachment(name); },
  newPointAttachment(skin, name) { return new spine.PointAttachment(name); },
  newPathAttachment(skin, name) { return new spine.PathAttachment(name); },
};
const sb = new spine.SkeletonBinary(loader);
const bytes = new Uint8Array(fs.readFileSync('test/fixture.skel'));
let offData;
try {
  offData = sb.readSkeletonData(bytes);
  console.log('OFFICIAL parsed fixture.skel OK');
} catch (e) {
  console.log('OFFICIAL FAILED:', e.message);
  process.exit(1);
}
const mine = parseSkeleton(bytes);
console.log('official animations:', offData.animations.map((a) => `${a.name}=${a.duration}`).join(', '));
console.log('mine     animations:', mine.animations.map((a) => `${a.name}=${a.duration}`).join(', '));
console.log('official bones:', offData.bones.map((b) => b.name).join(','));
console.log('mine     bones:', mine.bones.map((b) => b.name).join(','));
console.log('official slots:', offData.slots.length, 'mine slots:', mine.slots.length);
console.log('official skins:', offData.skins.length, 'mine skins:', mine.skins.length);
console.log('official events:', offData.events.length, 'mine events:', mine.events.length);
console.log('official ik:', offData.ikConstraints.length, 'mine ik:', mine.ikConstraints.length);
console.log('official transform:', offData.transformConstraints.length, 'mine transform:', mine.transformConstraints.length);
console.log('official path:', offData.pathConstraints.length, 'mine path:', mine.pathConstraints.length);
