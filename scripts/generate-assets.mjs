import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import pngjs from 'pngjs';
const { PNG } = pngjs;
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BACKGROUND = '#E4E2DA';
export const FOREGROUND = '#2F5D3A';
// Vector reconstruction of the existing TrainOracle geometric brand mark.
// Reference: pinned source app/public/icons/icon-512.png, not a new brand design.
export function markSvg({size=512, paddingScale=1, canvas=512}={}) {
  const offset = (512 - 512 * paddingScale) / 2;
  const inset = (canvas - 512) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${canvas} ${canvas}"><rect width="${canvas}" height="${canvas}" fill="${BACKGROUND}"/><g transform="translate(${inset+offset} ${inset+offset}) scale(${paddingScale})" fill="${FOREGROUND}"><circle cx="256" cy="256" r="180" fill="none" stroke="${FOREGROUND}" stroke-width="24"/><circle cx="256" cy="256" r="81"/><rect x="248" y="41" width="16" height="96"/></g></svg>`;
}
export function renderRgb(svg) {
  const png = PNG.sync.read(new Resvg(svg).render().asPng());
  const bytes = PNG.sync.write(png, {colorType:2, inputHasAlpha:true});
  if (bytes[25] !== 2) throw Error('Opaque RGB PNG required');
  return bytes;
}
async function save(root, relative, bytes) {
  const dest = join(root, relative); await mkdir(dirname(dest), {recursive:true}); await writeFile(dest, bytes);
}
export async function generateAssets(root=ROOT) {
  const entries=[];
  const emit=async(relative,bytes)=>{await save(root,relative,bytes);entries.push({path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});};
  const images=[];
  const iconRows=[['iphone',20,'2x',40],['iphone',20,'3x',60],['iphone',29,'2x',58],['iphone',29,'3x',87],['iphone',40,'2x',80],['iphone',40,'3x',120],['iphone',60,'2x',120],['iphone',60,'3x',180],['ipad',20,'1x',20],['ipad',20,'2x',40],['ipad',29,'1x',29],['ipad',29,'2x',58],['ipad',40,'1x',40],['ipad',40,'2x',80],['ipad',76,'1x',76],['ipad',76,'2x',152],['ipad',83.5,'2x',167],['ios-marketing',1024,'1x',1024]];
  for (const pixels of [...new Set(iconRows.map(x=>x[3]))]) await emit(`resources/ios/AppIcon.appiconset/icon-${pixels}.png`,renderRgb(markSvg({size:pixels})));
  for (const [idiom,points,scale,pixels] of iconRows) images.push({idiom,size:`${points}x${points}`,scale,filename:`icon-${pixels}.png`});
  await emit('resources/ios/AppIcon.appiconset/Contents.json',Buffer.from(JSON.stringify({images,info:{version:1,author:'xcode'}},null,2)));
  await emit('resources/ios/Splash.imageset/splash.png',renderRgb(markSvg({size:2732,canvas:2732})));
  await emit('resources/ios/Splash.imageset/Contents.json',Buffer.from(JSON.stringify({images:[{idiom:'universal',filename:'splash.png','scale':'1x'},{idiom:'universal',scale:'2x'},{idiom:'universal',scale:'3x'}],info:{version:1,author:'xcode'}},null,2)));
  for (const [density,pixels] of [['mdpi',48],['hdpi',72],['xhdpi',96],['xxhdpi',144],['xxxhdpi',192]]) {
    const bytes=renderRgb(markSvg({size:pixels}));
    await emit(`resources/android/res/mipmap-${density}/ic_launcher.png`,bytes);
    await emit(`resources/android/res/mipmap-${density}/ic_launcher_round.png`,bytes);
  }
  const vector=`<?xml version="1.0" encoding="utf-8"?><vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512"><group android:scaleX="0.72" android:scaleY="0.72" android:translateX="71.68" android:translateY="71.68"><path android:fillColor="${FOREGROUND}" android:fillType="evenOdd" android:pathData="M256,64 a192,192 0,1 0,0 384 a192,192 0,1 0,0 -384 M256,88 a168,168 0,1 0,0 336 a168,168 0,1 0,0 -336"/><path android:fillColor="${FOREGROUND}" android:pathData="M256,175 a81,81 0,1 0,0 162 a81,81 0,1 0,0 -162 M248,41 H264 V137 H248 Z"/></group></vector>`;
  await emit('resources/android/res/drawable/ic_launcher_foreground.xml',Buffer.from(vector));
  await emit('resources/android/res/drawable-v24/ic_launcher_foreground.xml',Buffer.from(vector));
  await emit('resources/android/res/values/ic_launcher_background.xml',Buffer.from(`<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">${BACKGROUND}</color></resources>`));
  const adaptive='<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>';
  await emit('resources/android/res/mipmap-anydpi-v26/ic_launcher.xml',Buffer.from(adaptive));
  await emit('resources/android/res/mipmap-anydpi-v26/ic_launcher_round.xml',Buffer.from(adaptive));
  await emit('resources/android/res/drawable/splash.xml',Buffer.from(`<?xml version="1.0" encoding="utf-8"?><layer-list xmlns:android="http://schemas.android.com/apk/res/android"><item android:drawable="@color/ic_launcher_background"/><item android:width="144dp" android:height="144dp" android:gravity="center" android:drawable="@drawable/ic_launcher_foreground"/></layer-list>`));
  await emit('resources/store/icon-512.png',renderRgb(markSvg({size:512})));
  await emit('resources/brand/mark.svg',Buffer.from(markSvg()));
  await emit('resources/brand/provenance.json',Buffer.from(JSON.stringify({sourceRepository:'hojune0330/TRAINORACLE',sourceSha:'0b3c12f67617ff610005dbb558388c4b5899bb83',sourcePath:'app/public/icons/icon-512.png',method:'existing geometric brand mark reconstructed as vector; no 512px upscaling',androidAdaptiveScale:0.72,opaqueRGB:true},null,2)));
  await save(root,'resources/assets-receipt.json',JSON.stringify({schemaVersion:1,entries},null,2));
  return entries;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify({assets:(await generateAssets()).length,opaqueRGB:true}));
