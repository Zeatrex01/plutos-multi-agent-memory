// One tiny, deterministic source for the PLUT_OS mark used by Windows packaging.
//
// The product UI keeps the same SVG inline so its first paint has no asset request. This
// module exists for the part a browser cannot do for us: produce a multi-resolution .ico
// file that Windows can embed in PLUT_OS.exe. No native image tool or global program is
// required, so a clean checkout builds the same icon on every machine.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

export const ICON_SIZES = Object.freeze([16, 32, 48, 64, 128, 256]);

// The mark: a lit planet with two tilted orbits on a night-navy tile. The orbits pass behind
// the planet and in front of it, so the front half of each ring is drawn over the planet.
// Units are a 100 x 100 canvas; the art sits in a group scaled to 0.88 around the centre.
export const PLUTOS_MARK = Object.freeze({
    canvas: 100,
    radius: 24,
    tile: '#0B1120',
    inset: 6,
    scale: 0.88,
    planet: Object.freeze({ r: 21, light: '#FFD08A', dark: '#E8892B', fx: 0.38, fy: 0.32 }),
    orbit: Object.freeze({ rx: 45, ry: 15, stroke: 5 }),
    orbits: Object.freeze([
        Object.freeze({ tilt: -24, color: '#8B7CF6' }),
        Object.freeze({ tilt: 24, color: '#3BB3A3' })
    ])
});

function xmlAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

export function createBrandSvg({ className = '', label = '' } = {}) {
    const m = PLUTOS_MARK;
    const klass = className ? ` class="${xmlAttribute(className)}"` : '';
    const accessibility = label
        ? ` role="img" aria-label="${xmlAttribute(label)}"`
        : ' aria-hidden="true"';
    const { rx, ry, stroke } = m.orbit;
    const ring = o => `<ellipse cx="50" cy="50" rx="${rx}" ry="${ry}" fill="none" stroke="${o.color}" stroke-width="${stroke}" transform="rotate(${o.tilt} 50 50)"/>`;
    const clips = m.orbits.map((o, i) => `<clipPath id="pm${i}"><rect x="-10" y="50" width="120" height="60" transform="rotate(${o.tilt} 50 50)"/></clipPath>`).join('');
    const p = m.planet;
    return `<svg${klass}${accessibility} xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 100 100">`
        + `<rect width="100" height="100" rx="${m.radius}" fill="${m.tile}"/>`
        + `<g transform="translate(${m.inset} ${m.inset}) scale(${m.scale})">`
        + `<defs><radialGradient id="pmg" cx="${p.fx * 100}%" cy="${p.fy * 100}%"><stop offset="0" stop-color="${p.light}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>${clips}</defs>`
        + m.orbits.map(ring).join('')
        + `<circle cx="50" cy="50" r="${p.r}" fill="url(#pmg)"/>`
        + m.orbits.map((o, i) => `<g clip-path="url(#pm${i})">${ring(o)}</g>`).join('')
        + '</g></svg>';
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
    if (x < left || y < top || x >= left + width || y >= top + height) return false;
    const closestX = Math.max(left + radius, Math.min(left + width - radius, x));
    const closestY = Math.max(top + radius, Math.min(top + height - radius, y));
    return (x - closestX) ** 2 + (y - closestY) ** 2 <= radius ** 2;
}

// Whether an orbit's stroke covers a point in the art's own coordinates: { front } or null.
function orbitAt(u, v, orbit) {
    const { rx, ry, stroke } = PLUTOS_MARK.orbit;
    const a = -orbit.tilt * Math.PI / 180;
    const dx = u - 50, dy = v - 50;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const f = (lx / rx) ** 2 + (ly / ry) ** 2 - 1;
    const grad = Math.hypot(2 * lx / rx ** 2, 2 * ly / ry ** 2) || 1;
    return Math.abs(f) / grad <= stroke / 2 ? { front: ly > 0 } : null;
}

// The colour at one sample point, painted in the SVG's order: rings, planet, front halves.
function markColor(x, y) {
    const m = PLUTOS_MARK;
    const u = (x - m.inset) / m.scale, v = (y - m.inset) / m.scale;
    const hits = m.orbits.filter(o => orbitAt(u, v, o)).map(o => ({ o, front: orbitAt(u, v, o).front }));
    const front = hits.filter(h => h.front);
    if (front.length) return hexRgb(front[front.length - 1].o.color);
    const p = m.planet;
    if ((u - 50) ** 2 + (v - 50) ** 2 <= p.r ** 2) {
        const fx = 50 - p.r + p.fx * 2 * p.r, fy = 50 - p.r + p.fy * 2 * p.r;
        const t = Math.min(1, Math.hypot(u - fx, v - fy) / p.r);
        const [a, c] = [hexRgb(p.light), hexRgb(p.dark)];
        return a.map((value, i) => value + (c[i] - value) * t);
    }
    if (hits.length) return hexRgb(hits[hits.length - 1].o.color);
    return hexRgb(m.tile);
}

function hexRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// Four samples per axis keeps the 16 px mark crisp while remaining cheap enough to generate
// on every build. Colors are accumulated premultiplied, then un-premultiplied for the PNG.
function renderRgba(size, sampleScale = 4) {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
        throw new Error(`icon size must be an integer from 1 to 256 (received ${size})`);
    }
    const rgba = Buffer.alloc(size * size * 4);
    const samples = sampleScale * sampleScale;
    const unit = PLUTOS_MARK.canvas / size;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let covered = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            for (let sy = 0; sy < sampleScale; sy++) {
                for (let sx = 0; sx < sampleScale; sx++) {
                    const x = (px + (sx + 0.5) / sampleScale) * unit;
                    const y = (py + (sy + 0.5) / sampleScale) * unit;
                    if (!insideRoundedRect(
                        x, y, 0, 0, PLUTOS_MARK.canvas, PLUTOS_MARK.canvas, PLUTOS_MARK.radius
                    )) continue;
                    covered++;
                    const color = markColor(x, y);
                    red += color[0];
                    green += color[1];
                    blue += color[2];
                }
            }
            if (!covered) continue;
            const at = (py * size + px) * 4;
            rgba[at] = Math.round(red / covered);
            rgba[at + 1] = Math.round(green / covered);
            rgba[at + 2] = Math.round(blue / covered);
            rgba[at + 3] = Math.round(covered * 255 / samples);
        }
    }
    return rgba;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    return crc >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const name = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    name.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
    return chunk;
}

export function createBrandPng(size) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;       // bit depth
    header[9] = 6;       // RGBA

    const rgba = renderRgba(size);
    const stride = size * 4;
    const scanlines = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
        pngChunk('IEND')
    ]);
}

export function createWindowsIcon(sizes = ICON_SIZES) {
    const unique = [...new Set(sizes)];
    if (!unique.length || unique.some(size => !ICON_SIZES.includes(size))) {
        throw new Error(`icon sizes must come from ${ICON_SIZES.join(', ')}`);
    }
    const images = unique.map(size => ({ size, png: createBrandPng(size) }));
    const directory = Buffer.alloc(6 + images.length * 16);
    directory.writeUInt16LE(0, 0);                 // reserved
    directory.writeUInt16LE(1, 2);                 // ICO, not cursor
    directory.writeUInt16LE(images.length, 4);

    let offset = directory.length;
    images.forEach(({ size, png }, index) => {
        const at = 6 + index * 16;
        directory[at] = size === 256 ? 0 : size;
        directory[at + 1] = size === 256 ? 0 : size;
        directory[at + 2] = 0;                    // true color
        directory[at + 3] = 0;
        directory.writeUInt16LE(1, at + 4);        // color planes
        directory.writeUInt16LE(32, at + 6);       // RGBA
        directory.writeUInt32LE(png.length, at + 8);
        directory.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([directory, ...images.map(image => image.png)]);
}

export function readIconSizes(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readUInt16LE(0) !== 0
        || buffer.readUInt16LE(2) !== 1) throw new Error('not a Windows ICO file');
    const count = buffer.readUInt16LE(4);
    if (!count || 6 + count * 16 > buffer.length) throw new Error('truncated Windows ICO directory');
    const sizes = [];
    for (let index = 0; index < count; index++) {
        const at = 6 + index * 16;
        const size = buffer[at] || 256;
        const height = buffer[at + 1] || 256;
        const bytes = buffer.readUInt32LE(at + 8);
        const offset = buffer.readUInt32LE(at + 12);
        if (size !== height || !bytes || offset + bytes > buffer.length) {
            throw new Error(`invalid Windows ICO entry ${index}`);
        }
        sizes.push(size);
    }
    return sizes;
}

// Running this file refreshes the human-visible source assets. The build verifies that these
// files still equal the deterministic output before embedding them; stale artwork cannot ship.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
    const root = path.resolve(path.dirname(thisFile), '..');
    const assetDir = path.join(root, 'assets');
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, 'plutos-mark.svg'), createBrandSvg() + '\n', 'utf8');
    fs.writeFileSync(path.join(assetDir, 'plutos.ico'), createWindowsIcon());
    console.log(`PLUT_OS brand assets refreshed in ${assetDir}`);
}
