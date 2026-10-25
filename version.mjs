import fs from 'node:fs';
const pkg=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8'));
export const release=Object.freeze({version:pkg.version,productName:pkg.productName});
