import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const primary = resolve('..', 'api', 'wwwroot');
const output = process.env.INTERVIEW_PREP_WEBROOT ? resolve(process.env.INTERVIEW_PREP_WEBROOT) : primary;
const assets = join(output,'assets');
await mkdir(assets, { recursive:true });
await Promise.all([
  build({entryPoints:['src/main.tsx'],bundle:true,minify:true,outfile:join(assets,'app.js')}),
  build({entryPoints:['src/ExperienceDocumentReader.tsx'],bundle:true,format:'esm',minify:true,outfile:join(assets,'experience-reader.js')}),
  copyFile(resolve('node_modules','pdfjs-dist','build','pdf.worker.min.mjs'), join(assets,'experience-pdf.worker.js')),
  ...(output === primary ? [] : [copyFile(join(primary,'index.html'), join(output,'index.html'))])
]);
