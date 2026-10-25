import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
export default defineConfig({ publicDir: '.build/public', plugins: [cloudflare()] });
