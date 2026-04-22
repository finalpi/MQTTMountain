import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import path from 'node:path';

export default defineConfig(({ command }) => {
    const isBuild = command === 'build';
    return {
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src'),
                '@shared': path.resolve(__dirname, 'shared')
            }
        },
        plugins: [
            vue(),
            electron({
                main: {
                    entry: 'electron/main/index.ts',
                    vite: {
                        build: {
                            sourcemap: !isBuild,
                            minify: isBuild,
                            outDir: 'dist-electron/main',
                            rollupOptions: {
                                external: ['electron', 'better-sqlite3', 'mqtt']
                            }
                        }
                    }
                },
                preload: {
                    input: 'electron/preload/index.ts',
                    vite: {
                        build: {
                            sourcemap: !isBuild ? 'inline' : false,
                            minify: isBuild,
                            outDir: 'dist-electron/preload',
                            rollupOptions: {
                                external: ['electron']
                            }
                        }
                    }
                }
            }),
            renderer()
        ],
        build: {
            outDir: 'dist',
            chunkSizeWarningLimit: 1500,
            rollupOptions: {
                output: {
                    manualChunks: {
                        vue: ['vue', 'pinia'],
                        vendor: ['jszip']
                    }
                }
            }
        },
        server: {
            port: 5179,
            strictPort: true
        },
        css: {
            preprocessorOptions: {
                scss: {
                    api: 'modern-compiler',
                    silenceDeprecations: ['legacy-js-api']
                }
            }
        }
    };
});
