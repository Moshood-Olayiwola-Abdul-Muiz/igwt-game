import { readFileSync, writeFileSync } from 'fs';
let content = readFileSync('src/app/app.ts', 'utf8');
content = content.replace(/\(ctx as any\)\.roundRect/g, 'ctx.roundRect');
writeFileSync('src/app/app.ts', content);
