import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

interface OutputRequest {
    sessionId?: unknown;
    files?: unknown;
}

function isSafeSessionId(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(value);
}

function isSafeRelativeFile(value: unknown): value is string {
    return typeof value === 'string'
        && /^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:csv|json)$/i.test(value);
}

/** Only Vite's local development server may write benchmark captures. */
function localPerformanceOutput(): Plugin {
    return {
        name: 'local-performance-output',
        configureServer(server) {
            const outputRoot = resolve(process.cwd(), 'output');
            server.middlewares.use('/__performance-capture', (request, response, next) => {
                if (request.method !== 'POST') {
                    next();
                    return;
                }
                const chunks: Buffer[] = [];
                let bytes = 0;
                request.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes <= 16 * 1024 * 1024) chunks.push(chunk);
                });
                request.on('end', () => {
                    void (async () => {
                        if (bytes > 16 * 1024 * 1024) throw new Error('Capture request is too large.');
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OutputRequest;
                        if (!isSafeSessionId(body.sessionId) || !Array.isArray(body.files) || body.files.length === 0) {
                            throw new Error('Invalid capture request.');
                        }
                        const sessionRoot = resolve(outputRoot, body.sessionId);
                        for (const file of body.files) {
                            if (!file || typeof file !== 'object') throw new Error('Invalid capture file.');
                            const { relativePath, contents } = file as { relativePath?: unknown; contents?: unknown };
                            if (!isSafeRelativeFile(relativePath) || typeof contents !== 'string') throw new Error('Invalid capture file.');
                            const destination = resolve(sessionRoot, relativePath);
                            if (!destination.startsWith(sessionRoot + sep)) throw new Error('Capture path escapes its session.');
                            await mkdir(dirname(destination), { recursive: true });
                            await writeFile(destination, contents, 'utf8');
                        }
                        response.statusCode = 204;
                        response.end();
                    })().catch(error => {
                        response.statusCode = 400;
                        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        response.end(error instanceof Error ? error.message : String(error));
                    });
                });
            });
        },
    };
}

export default defineConfig(({ command }) => ({
    build: {
        target: 'esnext',
    },
    base: process.env.GITHUB_ACTIONS_BASE || undefined,
    // The endpoint is intentionally absent from build/preview and production.
    plugins: command === 'serve' ? [localPerformanceOutput()] : [],
}));
