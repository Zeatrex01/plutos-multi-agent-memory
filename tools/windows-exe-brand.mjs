// Apply and verify PLUT_OS-owned Windows resources before Node's SEA blob is injected.
// Doing this before postject follows Node's SEA order: the copied, signed node.exe first
// becomes our unsigned application binary; only then is NODE_SEA_BLOB added.
import fs from 'fs';
import * as ResEdit from 'resedit';
import { ICON_SIZES, readIconSizes } from './plutos-icon.mjs';

function windowsVersion(version) {
    const core = String(version || '').split('-', 1)[0];
    const parts = core.split('.');
    if (!parts.length || parts.length > 4 || parts.some(part => !/^\d+$/.test(part))) {
        throw new Error(`invalid package version for Windows resources: ${version}`);
    }
    const numbers = parts.map(Number);
    if (numbers.some(part => part > 65535)) throw new Error(`Windows version component exceeds 65535: ${version}`);
    while (numbers.length < 4) numbers.push(0);
    return numbers;
}

function parseExecutable(buffer) {
    // Official Node Windows binaries carry an Authenticode certificate. It cannot remain
    // valid after either branding or SEA injection, so parse it explicitly as removable.
    return ResEdit.NtExecutable.from(buffer, { ignoreCert: true });
}

function normalizedGroupSizes(group) {
    return group.icons.map(icon => icon.width || 256).sort((a, b) => a - b);
}

function equalSizes(actual, expected = ICON_SIZES) {
    return actual.length === expected.length && actual.every((size, index) => size === expected[index]);
}

export function inspectWindowsBrand(file) {
    const exe = parseExecutable(fs.readFileSync(file));
    const resources = ResEdit.NtExecutableResource.from(exe);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    const iconSizes = groups.length === 1 ? normalizedGroupSizes(groups[0]) : [];
    let strings = {};
    if (versions.length === 1) {
        const languages = versions[0].getAllLanguagesForStringValues();
        if (languages.length) strings = versions[0].getStringValues(languages[0]);
    }
    return {
        iconGroups: groups.length,
        iconSizes,
        productName: strings.ProductName || '',
        fileDescription: strings.FileDescription || '',
        originalFilename: strings.OriginalFilename || ''
    };
}

export function assertWindowsBrand(file) {
    const summary = inspectWindowsBrand(file);
    if (summary.iconGroups !== 1) throw new Error(`expected one Windows icon group, found ${summary.iconGroups}`);
    if (!equalSizes(summary.iconSizes)) {
        throw new Error(`embedded icon sizes are ${summary.iconSizes.join(', ') || 'missing'}; expected ${ICON_SIZES.join(', ')}`);
    }
    if (summary.productName !== 'PLUT_OS' || summary.originalFilename !== 'PLUT_OS.exe') {
        throw new Error('PLUT_OS Windows version metadata did not survive packaging');
    }
    return summary;
}

export function brandWindowsExecutable(sourceFile, destinationFile, { iconFile, version } = {}) {
    if (!iconFile) throw new Error('a PLUT_OS .ico source is required');
    const iconBuffer = fs.readFileSync(iconFile);
    const sizes = readIconSizes(iconBuffer).sort((a, b) => a - b);
    if (!equalSizes(sizes)) throw new Error(`PLUT_OS.ico is missing required sizes: ${sizes.join(', ')}`);

    const exe = parseExecutable(fs.readFileSync(sourceFile));
    const resources = ResEdit.NtExecutableResource.from(exe);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
    if (groups.length !== 1) throw new Error(`base Node executable has ${groups.length} icon groups; refusing to guess`);

    const icon = ResEdit.Data.IconFile.from(iconBuffer);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        resources.entries,
        groups[0].id,
        groups[0].lang,
        icon.icons.map(item => item.data)
    );

    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
    if (versions.length !== 1) throw new Error(`base Node executable has ${versions.length} version resources; refusing to guess`);
    const [major, minor, patch, build] = windowsVersion(version);
    const versionInfo = versions[0];
    versionInfo.setFileVersion(major, minor, patch, build);
    versionInfo.setProductVersion(major, minor, patch, build);
    const languages = versionInfo.getAllLanguagesForStringValues();
    if (languages.length !== 1) throw new Error(`base Node executable has ${languages.length} version languages; refusing to guess`);
    versionInfo.setStringValues(languages[0], {
        ProductName: 'PLUT_OS',
        FileDescription: 'PLUT_OS local AI project memory and coordination',
        InternalName: 'PLUT_OS',
        OriginalFilename: 'PLUT_OS.exe'
    });
    versionInfo.outputToResourceEntries(resources.entries);

    resources.outputResource(exe);
    fs.writeFileSync(destinationFile, Buffer.from(exe.generate()));
    return assertWindowsBrand(destinationFile);
}
