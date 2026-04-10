import sharp from 'sharp';
import { readFileSync } from 'fs';

const svg = readFileSync('./public/icon.svg');

await sharp(svg).resize(512).png().toFile('./public/icon-512.png');
await sharp(svg).resize(192).png().toFile('./public/icon-192.png');
await sharp(svg).resize(512).png().toFile('./public/icon-maskable-512.png');
await sharp(svg).resize(192).png().toFile('./public/icon-maskable-192.png');
await sharp(svg).resize(180).png().toFile('./public/apple-touch-icon.png');
await sharp(svg).resize(32).png().toFile('./public/favicon-32.png');

console.log('Icons generated.');
