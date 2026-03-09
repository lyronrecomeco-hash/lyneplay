const fetch = require('node-fetch');

// Padrões conhecidos de anúncios e trackers
const AD_PATTERNS = [
    /doubleclick\.net/i,
    /googlesyndication\.com/i,
    /googleadservices\.com/i,
    /adservice\.google\./i,
    /amazon-adsystem\.com/i,
    /imasdk\.googleapis\.com/i,
    /adnxs\.com/i,
    /moatads\.com/i,
    /advertising\.com/i,
    /scorecardresearch\.com/i,
    /omtrdc\.net/i,
    /2mdn\.net/i,
];

const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbclid', 'gclid', 'msclkid', '_ga', '_gl', 'ad', 'ads', 'tracker', 'adid',
];

function isAdUrl(u) {
    return AD_PATTERNS.some(p => p.test(u));
}

function stripTrackers(rawUrl) {
    try {
        const u = new URL(rawUrl);
        TRACKING_PARAMS.forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch {
        return rawUrl;
    }
}

function resolveUrl(relative, base) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return relative;
    }
}

function rewriteM3U8(content, sourceUrl, proxyOrigin) {
    const lines = content.split('\n');
    return lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                const abs = resolveUrl(uri, sourceUrl);
                if (isAdUrl(abs)) return `URI=""`;
                return `URI="${proxyOrigin}/proxy?url=${encodeURIComponent(abs)}"`;
            });
        }

        if (trimmed.startsWith('#')) return line;

        const abs = resolveUrl(trimmed, sourceUrl);
        if (isAdUrl(abs)) return '';

        return `${proxyOrigin}/proxy?url=${encodeURIComponent(abs)}`;
    }).join('\n');
}

function makeBrowserHeaders(targetUrl, refererOverride) {
    let origin = '';
    let referer = '';
    try {
        const parsed = new URL(targetUrl);
        origin = parsed.origin;
        referer = refererOverride || `${parsed.origin}/`;
    } catch { }

    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'identity',
        'Origin': origin,
        'Referer': referer,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
    };
}

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { url: rawUrl, ref } = req.query;

    if (!rawUrl) {
        return res.status(400).json({ error: 'Parâmetro "url" obrigatório.' });
    }

    if (isAdUrl(rawUrl)) {
        return res.status(403).json({ error: 'URL bloqueada (anúncio).' });
    }

    const targetUrl = stripTrackers(rawUrl);

    try {
        const headers = makeBrowserHeaders(targetUrl, ref);

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const upstream = await fetch(targetUrl, {
            headers,
            redirect: 'follow',
            timeout: 20000,
        });

        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

        const isM3U8 =
            contentType.includes('mpegurl') ||
            contentType.includes('x-mpegurl') ||
            /\.m3u8?(\?|$)/i.test(targetUrl);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', isM3U8 ? 'application/vnd.apple.mpegurl' : contentType);

        const forwardHeaders = ['content-range', 'content-length', 'accept-ranges'];
        forwardHeaders.forEach(h => {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        });

        res.status(upstream.status);

        if (isM3U8) {
            res.setHeader('Cache-Control', 'no-cache, no-store');
            const text = await upstream.text();
            const proxyOrigin = `https://${req.headers.host}`;
            return res.send(rewriteM3U8(text, targetUrl, proxyOrigin));
        }

        res.setHeader('Cache-Control', 'public, max-age=3600');

        // Na Vercel (serverless), não há suporte a pipe longo — ler buffer
        const buffer = await upstream.buffer();
        return res.send(buffer);

    } catch (err) {
        if (!res.headersSent) {
            return res.status(502).json({ error: 'Falha ao buscar recurso.', details: err.message });
        }
    }
};
