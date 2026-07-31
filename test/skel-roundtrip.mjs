// Round-trip test for the official Spine 3.8 binary parser.
// Builds a synthetic .skel with a writer mirroring the byte layout of
// spine-runtimes 3.8 SkeletonBinary, parses it back and verifies
// bones / slots / constraints / skins / events / animations.

import { parseSkeleton } from '../src/skel.mjs';

// Strings referenced via readStringRef, in order of first use.
const POOL = [
  'body_region', 'head_mesh', 'limb_mesh', 'head_mesh2',
  'body_region.png', 'head_mesh.png', 'head_mesh2.png', 'limb_mesh.png',
  'default', 'skin2', 'body_region2', 'body_region2.png',
  'ev_a', 'ev_b',
];

class BinaryWriter {
  constructor() {
    this.chunks = [];
  }
  u8(value) {
    this.chunks.push(Buffer.from([value & 0xff]));
  }
  i8(value) {
    const b = Buffer.alloc(1);
    b.writeInt8(value);
    this.chunks.push(b);
  }
  bool(value) {
    this.u8(value ? 1 : 0);
  }
  varint(value) {
    const bytes = [];
    let v = value >>> 0;
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      bytes.push(b);
    } while (v > 0);
    this.chunks.push(Buffer.from(bytes));
  }
  // Zigzag varint (readInt(false)).
  zint(value) {
    this.varint((value << 1) ^ (value >> 31));
  }
  i32(value) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value);
    this.chunks.push(b);
  }
  f32(value) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(value);
    this.chunks.push(b);
  }
  i16(value) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value);
    this.chunks.push(b);
  }
  str(value) {
    if (value === null || value === undefined) {
      this.varint(0);
      return;
    }
    const bytes = Buffer.from(String(value), 'utf8');
    this.varint(bytes.length + 1);
    this.chunks.push(bytes);
  }
  // 1-based string ref into POOL; 0 = null.
  ref(name) {
    if (name === null || name === undefined) {
      this.varint(0);
      return;
    }
    const index = POOL.indexOf(name);
    if (index < 0) throw new Error(`string not in pool: ${name}`);
    this.varint(index + 1);
  }
  rgba(r, g, b, a) {
    this.i32((Math.round(r * 255) & 0xff) | ((Math.round(g * 255) & 0xff) << 8) | ((Math.round(b * 255) & 0xff) << 16) | ((Math.round(a * 255) & 0xff) << 24));
  }
  rgb(r, g, b) {
    this.i32((Math.round(r * 255) & 0xff) | ((Math.round(g * 255) & 0xff) << 8) | ((Math.round(b * 255) & 0xff) << 16));
  }
  curve(type, c1, c2, c3, c4) {
    this.u8(type);
    if (type === 2) {
      this.f32(c1); this.f32(c2); this.f32(c3); this.f32(c4);
    }
  }
  bytes() {
    return Buffer.concat(this.chunks);
  }
}

function buildSkeleton() {
  const w = new BinaryWriter();
  // header (nonessential = true)
  w.str('test-hash');
  w.str('3.8.99');
  w.f32(0); w.f32(0); w.f32(512); w.f32(512);
  w.bool(true); // nonessential
  w.f32(30); // fps
  w.str('images');
  w.str('audio');

  // strings pool
  w.varint(POOL.length);
  for (const s of POOL) w.str(s);

  // bones: root, arm (parent 0), leg (parent 0, transformMode onlyTranslation, skinRequired)
  w.varint(3);
  // root (no parent index for i==0)
  w.str('root');
  w.f32(10); w.f32(20); w.f32(30); w.f32(1); w.f32(1); w.f32(0); w.f32(0); w.f32(40);
  w.varint(0); // transformMode normal
  w.bool(false); // skinRequired
  w.rgba(1, 0, 0, 1); // nonessential color
  // arm (parent root)
  w.str('arm');
  w.varint(0);
  w.f32(0); w.f32(0); w.f32(0); w.f32(1); w.f32(1); w.f32(0); w.f32(0); w.f32(20);
  w.varint(0);
  w.bool(false);
  w.rgba(0, 1, 0, 1);
  // leg (parent root)
  w.str('leg');
  w.varint(0);
  w.f32(0); w.f32(0); w.f32(0); w.f32(1); w.f32(1); w.f32(0); w.f32(0); w.f32(20);
  w.varint(1); // transformMode onlyTranslation
  w.bool(true); // skinRequired
  w.rgba(0, 0, 1, 1);

  // slots: body(root), head(arm), limb(leg)
  w.varint(3);
  for (const slot of [
    ['body', 0, 'body_region'],
    ['head', 1, 'head_mesh'],
    ['limb', 2, 'limb_mesh'],
  ]) {
    w.str(slot[0]);
    w.varint(slot[1]);
    w.rgba(1, 1, 1, 1);
    w.i32(-1); // darkColor = null
    w.ref(slot[2]);
    w.varint(0); // blend mode normal
  }

  // ik constraint: bones=[arm], target=root
  w.varint(1);
  w.str('ik1'); w.varint(0); w.bool(false);
  w.varint(1); w.varint(1);
  w.varint(0); // target root
  w.f32(0.5); w.f32(1); w.i8(1); w.bool(false); w.bool(false); w.bool(false);

  // transform constraint: bones=[arm], target=root
  w.varint(1);
  w.str('tc1'); w.varint(0); w.bool(false);
  w.varint(1); w.varint(1);
  w.varint(0);
  w.bool(true); w.bool(false);
  w.f32(0); w.f32(5); w.f32(6); w.f32(1); w.f32(1); w.f32(0);
  w.f32(0.8); w.f32(0.7); w.f32(0.6); w.f32(0.5);

  // path constraint: bones=[arm], target slot 0
  w.varint(1);
  w.str('pc1'); w.varint(0); w.bool(false);
  w.varint(1); w.varint(1);
  w.varint(0); // target slot body
  w.varint(0); w.varint(0); w.varint(0); // position/spacing/rotate modes
  w.f32(0); w.f32(1); w.f32(2); w.f32(0.5); w.f32(0.4);

  // default skin: body->body_region(region), head->head_mesh(mesh weighted),
  // head->head_mesh2(linked), limb->limb_mesh(mesh non-weighted)
  w.varint(3); // slot count
  // slot body
  w.varint(0); w.varint(1);
  w.ref('body_region');
  w.ref('body_region'); // attachment name
  w.u8(0); // region
  w.ref('body_region.png');
  w.f32(100); w.f32(50); w.f32(1); w.f32(1); w.f32(0); w.f32(80); w.f32(60);
  w.rgba(1, 1, 1, 1);
  // slot head
  w.varint(1); w.varint(2);
  w.ref('head_mesh');
  w.ref('head_mesh');
  w.u8(2); // mesh
  w.ref('head_mesh.png');
  w.rgba(1, 1, 1, 1);
  w.varint(2); // vertexCount
  w.f32(0); w.f32(0); w.f32(0.5); w.f32(0.5); // uvs (2 verts)
  w.varint(3); w.i16(0); w.i16(1); w.i16(2); // triangles
  w.bool(true); // weighted
  w.varint(1); w.varint(0); w.f32(1); w.f32(2); w.f32(3); // vert0: 1 bone (x,y,w)
  w.varint(2); w.varint(0); w.f32(3); w.f32(4); w.f32(5); w.varint(1); w.f32(5); w.f32(6); w.f32(7); // vert1: 2 bones
  w.varint(4); // hull length
  w.varint(2); w.i16(0); w.i16(1); // edges (nonessential)
  w.f32(0.5); w.f32(0.5); // width/height (nonessential)
  w.ref('head_mesh2');
  w.ref('head_mesh2');
  w.u8(3); // linked mesh
  w.ref('head_mesh2.png');
  w.rgba(1, 1, 1, 1);
  w.ref('default'); // skin name
  w.ref('head_mesh'); // parent name
  w.bool(true); // inherit deform
  w.f32(0.5); w.f32(0.5); // width/height (nonessential)
  // slot limb
  w.varint(2); w.varint(1);
  w.ref('limb_mesh');
  w.ref('limb_mesh');
  w.u8(2); // mesh
  w.ref('limb_mesh.png');
  w.rgba(1, 1, 1, 1);
  w.varint(2); // vertexCount
  w.f32(0); w.f32(0); w.f32(0.5); w.f32(0.5); // uvs
  w.varint(1); w.i16(0); // triangles
  w.bool(false); // non-weighted
  w.f32(0); w.f32(0); w.f32(1); w.f32(1); // 2 verts x,y
  w.varint(4); // hull
  w.varint(2); w.i16(0); w.i16(1); // edges
  w.f32(1); w.f32(1); // width/height

  // extra skin "skin2"
  w.varint(1);
  w.ref('skin2');
  w.varint(0); // bones
  w.varint(0); w.varint(0); w.varint(0); // ik/transform/path constraints
  w.varint(1); // slot count
  w.varint(0); w.varint(1);
  w.ref('body_region2');
  w.ref('body_region2');
  w.u8(0);
  w.ref('body_region2.png');
  w.f32(10); w.f32(10); w.f32(1); w.f32(1); w.f32(0); w.f32(8); w.f32(6);
  w.rgba(1, 1, 1, 1);

  // events
  w.varint(2);
  w.ref('ev_a'); w.zint(42); w.f32(1.5); w.str('str-a'); w.str('audio-a'); w.f32(0.8); w.f32(-0.2);
  w.ref('ev_b'); w.zint(-7); w.f32(0); w.str(''); w.str(''); w.f32(0); w.f32(0);

  // animations
  w.varint(2);

  // ---- animation "idle" ----
  w.str('idle');
  // slot timelines: body (attachment), head (color), limb (twoColor)
  w.varint(3);
  w.varint(0); w.varint(1); // slot body, 1 timeline
  w.u8(0); w.varint(2); // attachment, 2 frames
  w.f32(0); w.ref('body_region');
  w.f32(1.5); w.ref('body_region2');
  w.varint(1); w.varint(1); // slot head, 1 timeline
  w.u8(1); w.varint(2); // color, 2 frames
  w.f32(0); w.rgba(1, 1, 1, 1); w.curve(2, 0, 0, 1, 1); // bezier after frame0
  w.f32(2); w.rgba(0.5, 0.5, 0.5, 1); // last frame: no curve
  w.varint(2); w.varint(1); // slot limb, 1 timeline
  w.u8(2); w.varint(1); // twoColor, 1 frame
  w.f32(0.5); w.rgba(1, 0, 0, 1); w.rgb(0, 1, 0);

  // bone timelines: root (rotate, translate), arm (shear), leg (scale)
  w.varint(3);
  w.varint(0); w.varint(2); // root, 2 timelines
  w.u8(0); w.varint(2); // rotate
  w.f32(0); w.f32(10); w.curve(1); // stepped after frame0
  w.f32(2); w.f32(20); // last frame: no curve
  w.u8(1); w.varint(2); // translate
  w.f32(0); w.f32(0); w.f32(0); w.curve(0);
  w.f32(2); w.f32(10); w.f32(20); // last frame: no curve
  w.varint(1); w.varint(1); // arm, 1 timeline
  w.u8(3); w.varint(1); // shear
  w.f32(1); w.f32(2); w.f32(3); // single frame: no curve
  w.varint(2); w.varint(1); // leg, 1 timeline
  w.u8(2); w.varint(2); // scale
  w.f32(0); w.f32(1); w.f32(1); w.curve(0);
  w.f32(1.5); w.f32(2); w.f32(2); // last frame: no curve

  // ik timeline
  w.varint(1);
  w.varint(0); w.varint(2);
  w.f32(0); w.f32(0.5); w.f32(1); w.i8(1); w.bool(false); w.bool(false); w.curve(0);
  w.f32(2.5); w.f32(1); w.f32(2); w.i8(-1); w.bool(true); w.bool(true); // last frame: no curve

  // transform timeline
  w.varint(1);
  w.varint(0); w.varint(1);
  w.f32(1); w.f32(0.8); w.f32(0.7); w.f32(0.6); w.f32(0.5); // single frame: no curve

  // path timelines: position + mix
  w.varint(1);
  w.varint(0); w.varint(2);
  w.u8(0); w.varint(1); // position
  w.f32(0); w.f32(1); // single frame: no curve
  w.u8(2); w.varint(1); // mix
  w.f32(0); w.f32(0.5); w.f32(0.4); // single frame: no curve

  // deform timelines: skin 0 (default), slot head (head_mesh weighted, head_mesh2 linked), slot limb (limb_mesh)
  w.varint(1);
  w.varint(0); // skin index 0
  w.varint(2); // slots
  w.varint(1); w.varint(2); // slot head, 2 attachments
  w.ref('head_mesh'); w.varint(2);
  w.f32(0); w.varint(4); w.varint(0); w.f32(0); w.f32(1); w.f32(2); w.f32(3); w.curve(0); // curve after frame0
  w.f32(2); w.varint(4); w.varint(0); w.f32(4); w.f32(5); w.f32(6); w.f32(7); // last frame: no curve
  w.ref('head_mesh2'); w.varint(1);
  w.f32(1); w.varint(2); w.varint(0); w.f32(0); w.f32(1); // single frame: no curve
  w.varint(2); w.varint(1); // slot limb, 1 attachment
  w.ref('limb_mesh'); w.varint(1);
  w.f32(0.5); w.varint(4); w.varint(0); w.f32(0); w.f32(1); w.f32(2); w.f32(3); // single frame: no curve

  // draw order
  w.varint(1);
  w.f32(0); w.varint(1); w.varint(2); w.varint(0);

  // events
  w.varint(2);
  w.f32(0); w.varint(0); w.zint(42); w.f32(1.5); w.bool(true); w.str('ev-str-a'); w.f32(0.8); w.f32(-0.2);
  w.f32(3); w.varint(1); w.zint(-7); w.f32(0); w.bool(true); w.str(''); w.f32(0); w.f32(0); // audioPath '' -> volume/balance still read

  // ---- animation "walk" (all counts zero -> duration 0) ----
  w.str('walk');
  w.varint(0); // slots
  w.varint(0); // bones
  w.varint(0); // ik
  w.varint(0); // transform
  w.varint(0); // path
  w.varint(0); // deform
  w.varint(0); // draw order
  w.varint(0); // events

  return w.bytes();
}

const bytes = buildSkeleton();
import { writeFileSync } from 'node:fs';
writeFileSync('test/fixture.skel', bytes);
{ const d = bytes; const hex = (f, n) => Array.from(d.subarray(f, f + n)).map((v) => v.toString(16).padStart(2, '0')).join(' '); console.log('WRITER 1045..1100:', hex(1045, 55)); }
const skeleton = parseSkeleton(bytes);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`);
}

check('version', skeleton.version, '3.8.99');
check('fps', skeleton.fps, 30);
check('bone count', skeleton.bones.length, 3);
check('bone names', skeleton.bones.map((b) => b.name), ['root', 'arm', 'leg']);
check('bone parentIndex', skeleton.bones.map((b) => b.parentIndex), [null, 0, 0]);
check('leg transformMode', skeleton.bones[2].transformMode, 'onlyTranslation');
check('leg skinRequired', skeleton.bones[2].skinRequired, true);
check('slot count', skeleton.slots.length, 3);
check('slot darkColor', skeleton.slots[0].darkColor, null);
check('ik count', skeleton.ikConstraints.length, 1);
check('transform count', skeleton.transformConstraints.length, 1);
check('path count', skeleton.pathConstraints.length, 1);
check('skin count', skeleton.skins.length, 2);
check('default skin entries', skeleton.skins[0].attachments.map((a) => `${a.slotIndex}:${a.name}:${a.attachment.kind}`), ['0:body_region:region', '1:head_mesh:mesh', '1:head_mesh2:linkedmesh', '2:limb_mesh:mesh']);
check('head_mesh weighted', skeleton.skins[0].attachments[1].attachment.verticesData.weighted, true);
check('limb_mesh weighted', skeleton.skins[0].attachments[3].attachment.verticesData.weighted, false);
check('linked mesh resolved', skeleton.skins[0].attachments[2].attachment.verticesData.weighted, true);
check('event count', skeleton.events.length, 2);
check('event intValue', skeleton.events[0].intValue, 42);
check('event negative intValue', skeleton.events[1].intValue, -7);
check('event audio', skeleton.events[0].audioPath, 'audio-a');
check('animation count', skeleton.animations.length, 2);
check('animation names', skeleton.animations.map((a) => a.name), ['idle', 'walk']);
check('idle duration', skeleton.animations[0].duration, 3);
check('walk duration', skeleton.animations[1].duration, 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);