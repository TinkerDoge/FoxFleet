// Dev/screenshot helper (not a test): a hub + a REAL connector + a mock Hermes whose reply carries MEDIA: tags for files in a temp dir.
//   node server/test/media-demo-hub.js <dir-with-chart.png,demo.webm,note.ogg,report.pdf>   -> prints the hub URL, runs until killed
import path from 'node:path';
import { setup, REAL } from './ui-helpers.js';
const dir = path.resolve(process.argv[2] ?? '/tmp/demo-media'), cleanups = [], t = { after: (f) => cleanups.push(f), skip() {} };
const reply = `Here is the chart and the recording you asked for.\nMEDIA:${dir}/chart.png\nMEDIA:${dir}/demo.webm\n[[audio_as_voice]]\nMEDIA:${dir}/note.ogg\nMEDIA:${dir}/report.pdf\nThe last one is missing: MEDIA:${dir}/gone.png`;
const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const filler = process.env.DEMO_SLOW ? Array.from({ length: 60 }, (_, i) => `thinking about it, part ${i}. `) : [];
const x = REAL && !process.env.DEMO_SLOW ? await setup(t) /* the REAL Hermes gateway + a fake model (see media-real.test.js): ask it "send-media <paths>" */ : await setup(t, { gateway: false, mock: { streamFrames: [...filler, ...reply.split(/(?<=\n)/)].map(frame), streamDelayMs: 120 } });
console.log('HUB ' + x.base);
process.on('SIGTERM', async () => { for (const f of cleanups.reverse()) await f(); process.exit(0); });
setInterval(() => {}, 1 << 30);
