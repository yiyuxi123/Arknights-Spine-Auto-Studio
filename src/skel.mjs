// Spine 3.8 binary (.skel) parser — byte-exact port of the official
// spine-runtimes 3.8 SkeletonBinary (spine-ts/core/src/SkeletonBinary.ts).
// Zero dependencies; extracts metadata + full animation list (names, durations).

const VERSION_PREFIX = '3.8';

const TRANSFORM_MODES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND_MODES = ['normal', 'additive', 'multiply', 'screen'];
const POSITION_MODES = ['fixed', 'percent'];
const SPACING_MODES = ['length', 'fixed', 'percent'];
const ROTATE_MODES = ['tangent', 'chain', 'chainScale'];
const ATTACHMENT_TYPES = ['region', 'boundingbox', 'mesh', 'linkedmesh', 'path', 'point', 'clipping'];

class BinaryReader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pos = 0;
    this.strings = []; // string reference pool (1-based)
  }

  // Official readByte uses signed int8.
  readByte() {
    return this.buf.readInt8(this.pos++);
  }

  readUByte() {
    return this.buf[this.pos++];
  }

  readBoolean() {
    return this.readByte() !== 0;
  }

  // Unsigned 7-bit-per-byte little-endian varint (high bit = continue).
  readVarintRaw() {
    let b = this.readByte();
    let result = b & 0x7f;
    let shift = 7;
    while (b & 0x80) {
      b = this.readByte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    }
    return result >>> 0;
  }

  // Official readInt(optimizePositive): varint; zigzag when not positive-optimized.
  readInt(optimizePositive) {
    const result = this.readVarintRaw();
    return optimizePositive ? result : ((result >>> 1) ^ -(result & 1));
  }

  readInt32() {
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  readFloat() {
    const value = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return value;
  }

  readShort() {
    const value = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  // Official readString: length varint (0 = null, 1 = ""), then byteCount-1
  // bytes decoded with the runtimes' UTF-8-ish switch.
  readString() {
    const byteCount = this.readInt(true);
    if (byteCount === 0) return null;
    if (byteCount === 1) return '';
    let chars = '';
    for (let i = 0; i < byteCount - 1; ) {
      const b = this.readUByte();
      switch (b >> 4) {
        case 12:
        case 13:
          chars += String.fromCharCode(((b & 0x1f) << 6) | (this.readUByte() & 0x3f));
          i += 2;
          break;
        case 14:
          chars += String.fromCharCode(((b & 0x0f) << 12) | ((this.readUByte() & 0x3f) << 6) | (this.readUByte() & 0x3f));
          i += 3;
          break;
        default:
          chars += String.fromCharCode(b);
          i++;
      }
    }
    return chars;
  }

  // Official readStringRef: 1-based index into the strings pool; 0 = null.
  readStringRef() {
    const index = this.readInt(true);
    return index === 0 ? null : this.strings[index - 1];
  }

  readFloatArray(count, scale = 1) {
    const values = new Array(count);
    for (let i = 0; i < count; i++) values[i] = this.readFloat() * scale;
    return values;
  }

  readShortArray() {
    const count = this.readInt(true);
    const values = new Array(count);
    for (let i = 0; i < count; i++) values[i] = this.readShort();
    return values;
  }

  // Official readVertices: bool "weighted" then either float pairs or
  // per-vertex (boneCount, per bone: boneIndex + x + y + weight).
  readVertices(vertexCount, scale) {
    if (!this.readBoolean()) {
      return { weighted: false, vertices: this.readFloatArray(vertexCount * 2, scale), bones: null };
    }
    const weights = [];
    const bones = [];
    for (let i = 0; i < vertexCount; i++) {
      const boneCount = this.readInt(true);
      bones.push(boneCount);
      for (let ii = 0; ii < boneCount; ii++) {
        bones.push(this.readInt(true));
        weights.push(this.readFloat() * scale);
        weights.push(this.readFloat() * scale);
        weights.push(this.readFloat());
      }
    }
    return { weighted: true, vertices: weights, bones };
  }

  // Official readCurve: byte; 0 linear (nothing), 1 stepped, 2 bezier + 4 floats.
  readCurve() {
    const type = this.readUByte();
    if (type === 2) {
      this.readFloat();
      this.readFloat();
      this.readFloat();
      this.readFloat();
    }
  }
}

function rgba8888(value) {
  return {
    r: (value & 0xff) / 255,
    g: ((value >>> 8) & 0xff) / 255,
    b: ((value >>> 16) & 0xff) / 255,
    a: ((value >>> 24) & 0xff) / 255,
  };
}

function rgb888(value) {
  return {
    r: (value & 0xff) / 255,
    g: ((value >>> 8) & 0xff) / 255,
    b: ((value >>> 16) & 0xff) / 255,
  };
}

function readAttachment(input, skeletonData, skin, slotIndex, attachmentName) {
  let name = input.readStringRef();
  if (name === null) name = attachmentName;
  const typeIndex = input.readUByte();
  const type = ATTACHMENT_TYPES[typeIndex];
  const scale = 1;
  const base = { kind: type, name, path: null, color: null };

  switch (type) {
    case 'region': {
      base.path = input.readStringRef();
      base.rotation = input.readFloat();
      base.x = input.readFloat() * scale;
      base.y = input.readFloat() * scale;
      base.scaleX = input.readFloat();
      base.scaleY = input.readFloat();
      base.width = input.readFloat() * scale;
      base.height = input.readFloat() * scale;
      base.color = rgba8888(input.readInt32());
      break;
    }
    case 'boundingbox': {
      const vertexCount = input.readInt(true);
      base.verticesData = input.readVertices(vertexCount, scale);
      base.color = skeletonData.nonessential ? rgba8888(input.readInt32()) : null;
      break;
    }
    case 'mesh': {
      base.path = input.readStringRef();
      base.color = rgba8888(input.readInt32());
      const vertexCount = input.readInt(true);
      base.uvs = input.readFloatArray(vertexCount * 2, 1);
      base.triangles = input.readShortArray();
      base.verticesData = input.readVertices(vertexCount, scale);
      base.hullLength = input.readInt(true);
      if (skeletonData.nonessential) {
        base.edges = input.readShortArray();
        base.width = input.readFloat() * scale;
        base.height = input.readFloat() * scale;
      }
      break;
    }
    case 'linkedmesh': {
      base.path = input.readStringRef();
      base.color = rgba8888(input.readInt32());
      base.skinName = input.readStringRef();
      base.parentName = input.readStringRef();
      base.inheritDeform = input.readBoolean();
      if (skeletonData.nonessential) {
        base.width = input.readFloat() * scale;
        base.height = input.readFloat() * scale;
      }
      break;
    }
    case 'path': {
      base.closed = input.readBoolean();
      base.constantSpeed = input.readBoolean();
      const vertexCount = input.readInt(true);
      base.verticesData = input.readVertices(vertexCount, scale);
      const lengthCount = vertexCount / 3;
      base.lengths = new Array(lengthCount);
      for (let i = 0; i < lengthCount; i++) base.lengths[i] = input.readFloat() * scale;
      base.color = skeletonData.nonessential ? rgba8888(input.readInt32()) : null;
      break;
    }
    case 'point': {
      base.rotation = input.readFloat();
      base.x = input.readFloat() * scale;
      base.y = input.readFloat() * scale;
      base.color = skeletonData.nonessential ? rgba8888(input.readInt32()) : null;
      break;
    }
    case 'clipping': {
      base.endSlotIndex = input.readInt(true);
      const vertexCount = input.readInt(true);
      base.verticesData = input.readVertices(vertexCount, scale);
      base.color = skeletonData.nonessential ? rgba8888(input.readInt32()) : null;
      break;
    }
    default:
      throw new Error(`Unknown attachment type index ${typeIndex} (name=${name})`);
  }
  skin.attachments.push({ slotIndex, name, attachment: base });
  return base;
}

function readSkin(input, skeletonData, defaultSkin) {
  const skin = { name: 'default', bones: [], constraints: [], attachments: [] };
  let slotCount;
  if (defaultSkin) {
    slotCount = input.readInt(true);
    if (slotCount === 0) return null;
  } else {
    skin.name = input.readStringRef();
    const boneCount = input.readInt(true);
    for (let i = 0; i < boneCount; i++) skin.bones.push(input.readInt(true));
    for (let i = 0, n = input.readInt(true); i < n; i++) skin.constraints.push({ type: 'ik', index: input.readInt(true) });
    for (let i = 0, n = input.readInt(true); i < n; i++) skin.constraints.push({ type: 'transform', index: input.readInt(true) });
    for (let i = 0, n = input.readInt(true); i < n; i++) skin.constraints.push({ type: 'path', index: input.readInt(true) });
    slotCount = input.readInt(true);
  }
  for (let i = 0; i < slotCount; i++) {
    const slotIndex = input.readInt(true);
    const attachmentCount = input.readInt(true);
    for (let ii = 0; ii < attachmentCount; ii++) {
      const attachmentName = input.readStringRef();
      readAttachment(input, skeletonData, skin, slotIndex, attachmentName);
    }
  }
  return skin;
}

function findAttachment(skin, slotIndex, name) {
  if (!skin) return null;
  for (const entry of skin.attachments) {
    if (entry.slotIndex === slotIndex && entry.name === name) return entry.attachment;
  }
  return null;
}

function readAnimation(input, name, skeletonData) {
  trace(input, 'animation');
  let duration = 0;
  const timelines = [];

  // Slot timelines.
  trace(input, 'slotTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const slotIndex = input.readInt(true);
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const timelineType = input.readUByte();
      const frameCount = input.readInt(true);
      const timeline = { type: ['attachment', 'color', 'twoColor'][timelineType], slotIndex, frames: [] };
      trace(input, '  slot ' + slotIndex + ' type ' + timelineType + ' fc ' + frameCount);
      if (timelineType === 0) {
        for (let f = 0; f < frameCount; f++) {
          timeline.frames.push({ time: input.readFloat(), attachmentName: input.readStringRef() });
        }
      } else if (timelineType === 1) {
        for (let f = 0; f < frameCount; f++) {
          const frame = { time: input.readFloat(), color: rgba8888(input.readInt32()) };
          if (f < frameCount - 1) input.readCurve();
          timeline.frames.push(frame);
        }
      } else {
        for (let f = 0; f < frameCount; f++) {
          const frame = { time: input.readFloat(), color: rgba8888(input.readInt32()), darkColor: null };
          const dark = input.readInt32();
          if (dark !== -1) frame.darkColor = rgb888(dark);
          if (f < frameCount - 1) input.readCurve();
          timeline.frames.push(frame);
        }
      }
      if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
      timelines.push(timeline);
    }
  }

  // Bone timelines.
  trace(input, 'boneTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const boneIndex = input.readInt(true);
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const timelineType = input.readUByte();
      const frameCount = input.readInt(true);
      const timeline = { type: ['rotate', 'translate', 'scale', 'shear'][timelineType], boneIndex, frames: [] };
      trace(input, '  bone ' + boneIndex + ' type ' + timelineType + ' fc ' + frameCount);
      for (let f = 0; f < frameCount; f++) {
        const frame = { time: input.readFloat() };
        if (timelineType === 0) {
          frame.angle = input.readFloat();
        } else {
          frame.x = input.readFloat() * (timelineType === 1 ? 1 : 1);
          frame.y = input.readFloat() * (timelineType === 1 ? 1 : 1);
        }
        if (f < frameCount - 1) input.readCurve();
        timeline.frames.push(frame);
      }
      if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
      timelines.push(timeline);
    }
  }

  // IK constraint timelines (no type byte).
  trace(input, 'ikTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const index = input.readInt(true);
    const frameCount = input.readInt(true);
    const timeline = { type: 'ik', index, frames: [] };
    for (let f = 0; f < frameCount; f++) {
      const frame = {
        time: input.readFloat(),
        mix: input.readFloat(),
        softness: input.readFloat(),
        bendDirection: input.readByte(),
        compress: input.readBoolean(),
        stretch: input.readBoolean(),
      };
      if (f < frameCount - 1) input.readCurve();
      timeline.frames.push(frame);
    }
    if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
    timelines.push(timeline);
  }

  // Transform constraint timelines (no type byte).
  trace(input, 'transformTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const index = input.readInt(true);
    const frameCount = input.readInt(true);
    const timeline = { type: 'transform', index, frames: [] };
    for (let f = 0; f < frameCount; f++) {
      const frame = {
        time: input.readFloat(),
        rotateMix: input.readFloat(),
        translateMix: input.readFloat(),
        scaleMix: input.readFloat(),
        shearMix: input.readFloat(),
      };
      if (f < frameCount - 1) input.readCurve();
      timeline.frames.push(frame);
    }
    if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
    timelines.push(timeline);
  }

  // Path constraint timelines.
  trace(input, 'pathTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const index = input.readInt(true);
    const pathData = skeletonData.pathConstraints[index];
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const timelineType = input.readUByte();
      const frameCount = input.readInt(true);
      const timeline = { type: ['position', 'spacing', 'mix'][timelineType], index, frames: [] };
      for (let f = 0; f < frameCount; f++) {
        const frame = { time: input.readFloat() };
        if (timelineType === 2) {
          frame.rotateMix = input.readFloat();
          frame.translateMix = input.readFloat();
        } else if (timelineType === 0) {
          frame.position = input.readFloat();
          if (pathData && pathData.positionMode === 'fixed') frame.position *= 1;
        } else {
          frame.spacing = input.readFloat();
          if (pathData && (pathData.spacingMode === 'length' || pathData.spacingMode === 'fixed')) frame.spacing *= 1;
        }
        if (f < frameCount - 1) input.readCurve();
        timeline.frames.push(frame);
      }
      if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
      timelines.push(timeline);
    }
  }

  // Deform timelines.
  trace(input, 'deformTimelines');
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    const skinIndex = input.readInt(true);
    const skin = skeletonData.skins[skinIndex];
    for (let ii = 0, nn = input.readInt(true); ii < nn; ii++) {
      const slotIndex = input.readInt(true);
      for (let iii = 0, nnn = input.readInt(true); iii < nnn; iii++) {
        const attachmentName = input.readStringRef();
        const attachment = findAttachment(skin, slotIndex, attachmentName);
        const weighted = attachment ? !!attachment.verticesData && attachment.verticesData.weighted : false;
        const frameCount = input.readInt(true);
        const timeline = { type: 'deform', skinIndex, slotIndex, attachmentName, frames: [] };
        trace(input, '  deform skin ' + skinIndex + ' slot ' + slotIndex + ' att ' + attachmentName + ' fc ' + frameCount);
        for (let f = 0; f < frameCount; f++) {
          const time = input.readFloat();
          trace(input, '    frame ' + f + ' time');
          trace(input, '    frame ' + f + ' endByte=0x' + input.buf[input.pos].toString(16));
          let end = input.readInt(true);
          trace(input, '    frame ' + f + ' end=' + end);
          if (end !== 0) {
            const start = input.readInt(true);
            trace(input, '    frame ' + f + ' start=' + start);
            end += start;
            for (let v = start; v < end; v++) { input.readFloat(); trace(input, '    frame ' + f + ' float#' + (v - start)); }
            trace(input, '    frame ' + f + ' floats done');
          }
          const frame = { time };
          if (f < frameCount - 1) { input.readCurve(); trace(input, '    frame ' + f + ' curve'); }
          timeline.frames.push(frame);
        }
        if (frameCount > 0) duration = Math.max(duration, timeline.frames[frameCount - 1].time);
        timelines.push(timeline);
      }
    }
  }

  // Draw order timeline.
  trace(input, 'drawOrder');
  const drawOrderCount = input.readInt(true);
  if (drawOrderCount > 0) {
    const timeline = { type: 'drawOrder', frames: [] };
    for (let i = 0; i < drawOrderCount; i++) {
      const time = input.readFloat();
      const offsetCount = input.readInt(true);
      const offsets = [];
      for (let ii = 0; ii < offsetCount; ii++) {
        offsets.push({ slotIndex: input.readInt(true), offset: input.readInt(true) });
      }
      timeline.frames.push({ time, offsets });
    }
    duration = Math.max(duration, timeline.frames[drawOrderCount - 1].time);
    timelines.push(timeline);
  }

  // Event timeline.
  trace(input, 'eventTimeline');
  const eventCount = input.readInt(true);
  if (eventCount > 0) {
    const timeline = { type: 'events', frames: [] };
    for (let i = 0; i < eventCount; i++) {
      const time = input.readFloat();
      const eventData = skeletonData.events[input.readInt(true)];
      const frame = {
        time,
        intValue: input.readInt(false),
        floatValue: input.readFloat(),
        stringValue: input.readBoolean() ? input.readString() : (eventData ? eventData.stringValue : null),
      };
      if (eventData && eventData.audioPath !== null) {
        frame.volume = input.readFloat();
        frame.balance = input.readFloat();
      }
      timeline.frames.push(frame);
    }
    duration = Math.max(duration, timeline.frames[eventCount - 1].time);
    timelines.push(timeline);
  }

  return { name, duration, timelines };
}

const trace = (reader, label) => { if (process.env.SKEL_TRACE) console.error(String(reader.pos).padStart(5), label); };

export function parseSkeleton(bytes) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new Error('parseSkeleton expects a Uint8Array/Buffer');
  }
  const input = new BinaryReader(bytes);

  const hash = input.readString();
  const version = input.readString();
  if (!version || !version.startsWith(VERSION_PREFIX)) {
    throw new Error(`Unsupported skeleton version "${version}" (only Spine 3.8 is supported)`);
  }
  const x = input.readFloat();
  const y = input.readFloat();
  const width = input.readFloat();
  const height = input.readFloat();
  const nonessential = input.readBoolean();
  let fps = 30;
  let imagesPath = null;
  let audioPath = null;
  if (nonessential) {
    fps = input.readFloat();
    imagesPath = input.readString();
    audioPath = input.readString();
  }

  // Strings pool (used by readStringRef, 1-based).
  for (let i = 0, n = input.readInt(true); i < n; i++) {
    input.strings.push(input.readString());
  }

  const skeleton = {
    hash,
    version,
    x,
    y,
    width,
    height,
    fps,
    imagesPath,
    audioPath,
    nonessential,
    bones: [],
    slots: [],
    ikConstraints: [],
    transformConstraints: [],
    pathConstraints: [],
    skins: [],
    events: [],
    animations: [],
  };

  // Bones: parent is an index (0 for root = null).
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const name = input.readString();
      const parentIndex = i === 0 ? null : input.readInt(true);
      const bone = {
        index: i,
        name,
        parentIndex,
        rotation: input.readFloat(),
        x: input.readFloat(),
        y: input.readFloat(),
        scaleX: input.readFloat(),
        scaleY: input.readFloat(),
        shearX: input.readFloat(),
        shearY: input.readFloat(),
        length: input.readFloat(),
        transformMode: TRANSFORM_MODES[input.readInt(true)],
        skinRequired: input.readBoolean(),
      };
      if (nonessential) bone.color = rgba8888(input.readInt32());
      skeleton.bones.push(bone);
    }
  }

  // Slots: bone index, packed colors, attachment name ref, blend mode.
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const name = input.readString();
      const boneIndex = input.readInt(true);
      const color = rgba8888(input.readInt32());
      const dark = input.readInt32();
      const slot = {
        index: i,
        name,
        boneIndex,
        color,
        darkColor: dark === -1 ? null : rgb888(dark),
        attachmentName: input.readStringRef(),
        blendMode: BLEND_MODES[input.readInt(true)],
      };
      skeleton.slots.push(slot);
    }
  }

  // IK constraints.
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const constraint = {
        name: input.readString(),
        order: input.readInt(true),
        skinRequired: input.readBoolean(),
        bones: [],
        target: null,
      };
      const boneCount = input.readInt(true);
      for (let ii = 0; ii < boneCount; ii++) constraint.bones.push(input.readInt(true));
      constraint.target = input.readInt(true);
      constraint.mix = input.readFloat();
      constraint.softness = input.readFloat();
      constraint.bendDirection = input.readByte();
      constraint.compress = input.readBoolean();
      constraint.stretch = input.readBoolean();
      constraint.uniform = input.readBoolean();
      skeleton.ikConstraints.push(constraint);
    }
  }

  // Transform constraints.
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const constraint = {
        name: input.readString(),
        order: input.readInt(true),
        skinRequired: input.readBoolean(),
        bones: [],
        target: null,
      };
      const boneCount = input.readInt(true);
      for (let ii = 0; ii < boneCount; ii++) constraint.bones.push(input.readInt(true));
      constraint.target = input.readInt(true);
      constraint.local = input.readBoolean();
      constraint.relative = input.readBoolean();
      constraint.offsetRotation = input.readFloat();
      constraint.offsetX = input.readFloat();
      constraint.offsetY = input.readFloat();
      constraint.offsetScaleX = input.readFloat();
      constraint.offsetScaleY = input.readFloat();
      constraint.offsetShearY = input.readFloat();
      constraint.rotateMix = input.readFloat();
      constraint.translateMix = input.readFloat();
      constraint.scaleMix = input.readFloat();
      constraint.shearMix = input.readFloat();
      skeleton.transformConstraints.push(constraint);
    }
  }

  // Path constraints.
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const constraint = {
        name: input.readString(),
        order: input.readInt(true),
        skinRequired: input.readBoolean(),
        bones: [],
        target: null,
      };
      const boneCount = input.readInt(true);
      for (let ii = 0; ii < boneCount; ii++) constraint.bones.push(input.readInt(true));
      constraint.target = input.readInt(true);
      constraint.positionMode = POSITION_MODES[input.readInt(true)];
      constraint.spacingMode = SPACING_MODES[input.readInt(true)];
      constraint.rotateMode = ROTATE_MODES[input.readInt(true)];
      constraint.offsetRotation = input.readFloat();
      constraint.position = input.readFloat();
      constraint.spacing = input.readFloat();
      constraint.rotateMix = input.readFloat();
      constraint.translateMix = input.readFloat();
      skeleton.pathConstraints.push(constraint);
    }
  }

  // Default skin, then additional skins.
  {
    const defaultSkin = readSkin(input, skeleton, true);
    if (defaultSkin) skeleton.skins.push(defaultSkin);
    const extraCount = input.readInt(true);
    for (let i = 0; i < extraCount; i++) skeleton.skins.push(readSkin(input, skeleton, false));
  }

  // Resolve linked meshes so deform lookups see the parent's weight layout.
  for (const skin of skeleton.skins) {
    for (const entry of skin.attachments) {
      const attachment = entry.attachment;
      if (attachment.kind !== 'linkedmesh') continue;
      const parentSkin = attachment.skinName === null ? skeleton.skins[0] : skeleton.skins.find((s) => s.name === attachment.skinName);
      const parent = parentSkin ? findAttachment(parentSkin, entry.slotIndex, attachment.parentName) : null;
      if (parent && parent.verticesData) attachment.verticesData = parent.verticesData;
    }
  }

  // Events.
  {
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      const event = {
        name: input.readStringRef(),
        intValue: input.readInt(false),
        floatValue: input.readFloat(),
        stringValue: input.readString(),
        audioPath: input.readString(),
      };
      if (event.audioPath !== null) {
        event.volume = input.readFloat();
        event.balance = input.readFloat();
      }
      skeleton.events.push(event);
    }
  }

  // Animations.
  {
    trace(input, 'animCount');
    const n = input.readInt(true);
    for (let i = 0; i < n; i++) {
      skeleton.animations.push(readAnimation(input, input.readString(), skeleton));
    }
  }

  return skeleton;
}

export { BinaryReader };