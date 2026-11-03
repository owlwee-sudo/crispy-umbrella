// Thin wrappers that use native Android APIs (via Capacitor) when running as an app,
// and regular web APIs when running in a browser.
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Clipboard } from '@capacitor/clipboard';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = Capacitor.isNativePlatform();

export async function copyText(text) {
  if (isNative) return Clipboard.write({ string: text });
  return navigator.clipboard.writeText(text);
}

export async function pasteText() {
  if (isNative) {
    const { value } = await Clipboard.read();
    return value ?? '';
  }
  return navigator.clipboard.readText();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Save a blob: on Android it is written to the cache and handed to the share sheet. */
export async function saveFile(blob, filename) {
  if (isNative) {
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    await Share.share({ title: filename, files: [uri], dialogTitle: `Save ${filename}` });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function onBackButton(handler) {
  if (!isNative) return;
  App.addListener('backButton', () => {
    if (!handler()) App.minimizeApp();
  });
}

export function setSystemBarsTheme(theme) {
  if (!isNative) return;
  SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
}
