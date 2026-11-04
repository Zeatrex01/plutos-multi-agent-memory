// Windows decides whether to attach a console window to a double-clicked binary from one
// 16-bit field in the PE header: Subsystem, 3 = console (CUI), 2 = windows (GUI). There is no
// runtime switch for it, so flipping that field is the only way a packaged app can start
// without a terminal behind it.
//
// Kept out of build.mjs so it can be tested on any platform: the byte layout is the risky
// part, and a corrupted exe is a far worse outcome than a visible console window.
import fs from 'fs';

export const SUBSYSTEM_CUI = 3;
export const SUBSYSTEM_GUI = 2;

// PE layout: the DOS header holds the PE offset at 0x3c; "PE\0\0" then a 20-byte COFF header;
// the optional header follows. Subsystem sits 68 bytes into the optional header in BOTH PE32
// and PE32+ — the ImageBase width difference is absorbed earlier in the struct.
const PE_OFFSET_POINTER = 0x3c;
const PE_SIGNATURE = 0x00004550;                 // "PE\0\0", little-endian
const OPTIONAL_HEADER_OFFSET = 24;               // 4 (signature) + 20 (COFF header)
const SUBSYSTEM_OFFSET = 68;
const PE32_MAGIC = 0x10b;
const PE32PLUS_MAGIC = 0x20b;

// Byte offset of the Subsystem field, or throws with a reason naming what did not match.
// Every check is a refusal to guess: this writes into an executable.
export function subsystemOffset(buf) {
    if (buf.length < PE_OFFSET_POINTER + 4) throw new Error('not a PE binary (file too small)');
    const peOffset = buf.readUInt32LE(PE_OFFSET_POINTER);
    const at = peOffset + OPTIONAL_HEADER_OFFSET + SUBSYSTEM_OFFSET;
    if (peOffset <= 0 || at + 2 > buf.length) throw new Error('not a PE binary (PE offset out of range)');
    if (buf.readUInt32LE(peOffset) !== PE_SIGNATURE) throw new Error('not a PE binary (no PE signature)');
    const magic = buf.readUInt16LE(peOffset + OPTIONAL_HEADER_OFFSET);
    if (magic !== PE32_MAGIC && magic !== PE32PLUS_MAGIC) {
        throw new Error(`unrecognised PE optional header magic 0x${magic.toString(16)}`);
    }
    return at;
}

export function readSubsystem(buf) {
    return buf.readUInt16LE(subsystemOffset(buf));
}

// → 'patched' | 'already-gui'. Throws rather than writing anything it does not recognise;
// the caller's fallback is simply to ship the console build.
export function markGuiSubsystem(file) {
    const buf = fs.readFileSync(file);
    const at = subsystemOffset(buf);
    const current = buf.readUInt16LE(at);
    if (current === SUBSYSTEM_GUI) return 'already-gui';
    if (current !== SUBSYSTEM_CUI) {
        throw new Error(`unexpected PE subsystem ${current} (expected ${SUBSYSTEM_CUI}, console)`);
    }
    buf.writeUInt16LE(SUBSYSTEM_GUI, at);
    fs.writeFileSync(file, buf);

    // Read back from disk, not from the buffer we just wrote: a short write or a filesystem
    // that silently dropped it must not be reported as success.
    if (readSubsystem(fs.readFileSync(file)) !== SUBSYSTEM_GUI) {
        throw new Error('subsystem patch did not take');
    }
    return 'patched';
}
