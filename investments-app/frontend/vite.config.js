import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../backend/public'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
