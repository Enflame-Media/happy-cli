import { logger } from '@/ui/logger';
import httpProxy from 'http-proxy';
import { createServer, IncomingMessage, ServerResponse, ClientRequest } from 'node:http';

/**
 * Represents a running HTTP proxy server with lifecycle management.
 */
export interface HTTPProxy {
    /** The URL where the proxy is listening (e.g., "http://127.0.0.1:12345") */
    url: string;
    /** Closes the proxy server and releases all resources */
    close: () => Promise<void>;
}

export interface HTTPProxyOptions {
    target: string;
    verbose?: boolean;
    onRequest?: (req: IncomingMessage, proxyReq: ClientRequest) => void;
    onResponse?: (req: IncomingMessage, proxyRes: IncomingMessage) => void;
}

export async function startHTTPDirectProxy(options: HTTPProxyOptions): Promise<HTTPProxy> {
    const proxy = httpProxy.createProxyServer({
        target: options.target,
        changeOrigin: true,
        secure: false
    });

    let _requestId = 0;

    // Handle proxy errors
    proxy.on('error', (err, req, res) => {
        logger.debug(`[HTTPProxy] Proxy error: ${err.message} for ${req.method} ${req.url}`);
        if (res instanceof ServerResponse && !res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Proxy error');
        }
    });

    // Trace outgoing proxy requests
    proxy.on('proxyReq', (proxyReq, req, _res) => {
        // const id = ++requestId;
        // (req as any)._proxyRequestId = id;
        
        // logger.debug(`[HTTPProxy] [${id}] --> ${req.method} ${req.url}`);
        // if (options.verbose) {
        //     logger.debug(`[HTTPProxy] [${id}] --> Target: ${options.target}${req.url}`);
        //     logger.debug(`[HTTPProxy] [${id}] --> Headers: ${JSON.stringify(req.headers)}`);
        // }
        
        // Allow custom request handler
        if (options.onRequest) {
            options.onRequest(req, proxyReq);
        }
    });

    // Trace proxy responses
    proxy.on('proxyRes', (proxyRes, req, _res) => {
        // const id = (req as any)._proxyRequestId || 0;
        
        // logger.debug(`[HTTPProxy] [${id}] <-- ${proxyRes.statusCode} ${proxyRes.statusMessage} for ${req.method} ${req.url}`);
        // if (options.verbose) {
        //     logger.debug(`[HTTPProxy] [${id}] <-- Headers: ${JSON.stringify(proxyRes.headers)}`);
        // }
        
        // Allow custom response handler
        if (options.onResponse) {
            options.onResponse(req, proxyRes);
        }
    });

    // Create HTTP server
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // const id = requestId + 1; // Preview what the ID will be
        // logger.debug(`[HTTPProxy] [${id}] Incoming: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        
        proxy.web(req, res);
    });

    // Start server on random port
    const url = await new Promise<string>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                const proxyUrl = `http://127.0.0.1:${addr.port}`;
                logger.debug(`[HTTPProxy] Started on ${proxyUrl} --> ${options.target}`);
                resolve(proxyUrl);
            } else {
                reject(new Error('Failed to get server address'));
            }
        });
    });

    return {
        url,
        close: async () => {
            return new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        proxy.close();
                        logger.debug(`[HTTPProxy] Closed proxy on ${url}`);
                        resolve();
                    }
                });
            });
        }
    };
}