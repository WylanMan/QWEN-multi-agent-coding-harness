import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/virtual-chat.js'],
  outfile: 'public/virtual-chat.js',
  bundle: true,
  format: 'iife',
  globalName: 'VChat',
  // No footer — VChat is assigned to window inside the module itself
  sourcemap: false,
  minify: false,
  platform: 'browser',
  target: ['es2020'],
});

console.log('✓ Built public/virtual-chat.js');
