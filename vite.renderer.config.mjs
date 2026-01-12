import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    root: path.resolve(__dirname, '.'),
    base: './', // important so packaged builds can load assets from file://
});