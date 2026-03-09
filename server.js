const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// CORS total — necessário para o player funcionar
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

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

// Reescreve todas as URLs do M3U8 (segmentos, playlists, chaves) pelo proxy
function rewriteM3U8(content, sourceUrl, proxyOrigin) {
    const lines = content.split('\n');

    return lines.map(line => {
        const trimmed = line.trim();

        // Linha vazia
        if (!trimmed) return line;

        // Linhas de diretiva com URI= (como EXT-X-KEY, EXT-X-MAP)
        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                const abs = resolveUrl(uri, sourceUrl);
                if (isAdUrl(abs)) return `URI=""`;
                return `URI="${proxyOrigin}/proxy?url=${encodeURIComponent(abs)}"`;
            });
        }

        // Outras linhas de comentário — manter
        if (trimmed.startsWith('#')) return line;

        // Linha de URL (segmento ou sub-playlist)
        const abs = resolveUrl(trimmed, sourceUrl);

        if (isAdUrl(abs)) {
            console.log(`[AD BLOCKED] ${abs.substring(0, 80)}`);
            return ''; // segmento bloqueado
        }

        return `${proxyOrigin}/proxy?url=${encodeURIComponent(abs)}`;
    }).join('\n');
}

// Domínios CDN conhecidos do WarezCDN que requerem referer do provider
const WAREZ_PROVIDER_REFERERS = new Map([
    // Mapeamento automático: CDN do provider usa o mesmo domínio como referer
    // Detectado dinamicamente via proxy
]);

// Monta headers realistas de browser
function makeBrowserHeaders(targetUrl, refererOverride) {
    let origin = '';
    let referer = '';

    try {
        const parsed = new URL(targetUrl);
        origin = parsed.origin;
        referer = refererOverride || WAREZ_PROVIDER_REFERERS.get(parsed.hostname) || `${parsed.origin}/`;
    } catch { }

    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'identity', // evitar compressão que o pipe pode não lidar
        'Origin': origin,
        'Referer': referer,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
    };
}

// ===========================================================
//  /proxy?url=<encoded>&ref=<referer_opcional>
// ===========================================================
app.get('/proxy', async (req, res) => {
    const { url: rawUrl, ref } = req.query;

    if (!rawUrl) {
        return res.status(400).json({ error: 'Parâmetro "url" obrigatório.' });
    }

    if (isAdUrl(rawUrl)) {
        console.log(`[BLOCKED] ${rawUrl.substring(0, 80)}`);
        return res.status(403).json({ error: 'URL bloqueada (anúncio).' });
    }

    const targetUrl = stripTrackers(rawUrl);

    try {
        const headers = makeBrowserHeaders(targetUrl, ref);

        // Para URLs do CDN do WarezCDN provider: usar o referer da página do provider
        // (o CDN valida que o request vem do player do provider)
        if (!ref) {
            try {
                const h = new URL(targetUrl).hostname;
                const provRef = WAREZ_PROVIDER_REFERERS.get(h);
                if (provRef) {
                    headers['Referer'] = provRef;
                    headers['Origin'] = new URL(provRef).origin;
                    headers['Sec-Fetch-Site'] = 'same-origin';
                    console.log(`[PROXY] Using provider referer: ${provRef.substring(0, 60)}`);
                }
            } catch { }
        }

        // Repassar Range header para suporte a seek em MP4 progressivo
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        console.log(`[PROXY] ${targetUrl.substring(0, 100)}`);

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

        // Headers da resposta
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', isM3U8 ? 'application/vnd.apple.mpegurl' : contentType);

        const forwardHeaders = ['content-range', 'content-length', 'accept-ranges'];
        forwardHeaders.forEach(h => {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        });

        res.status(upstream.status);

        if (isM3U8) {
            // Playlists não devem ser cacheadas (sempre frescas)
            res.setHeader('Cache-Control', 'no-cache, no-store');
            const text = await upstream.text();
            const proxyOrigin = `${req.protocol}://${req.get('host')}`;
            return res.send(rewriteM3U8(text, targetUrl, proxyOrigin));
        }

        // Para tudo mais: streaming direto
        res.setHeader('Cache-Control', 'public, max-age=3600');
        upstream.body.pipe(res);

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Falha ao buscar recurso.', details: err.message });
        }
    }
});

// ===========================================================
//  /resolve?type=filme&id=tt0468569
//  /resolve?type=serie&id=1396&season=1&episode=1
// ===========================================================

const CryptoJS = require('crypto-js');

// Headers que simulam um browser real dentro de um iframe
function warezHeaders(referer, extra = {}) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'identity',
        'Referer': referer || 'https://warezcdn.site/',
        'Origin': 'https://warezcdn.site',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        ...extra,
    };
}

function xhrHeaders(referer, pageToken) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': referer,
        'Origin': 'https://warezcdn.site',
        'X-Requested-With': 'XMLHttpRequest',
        ...(pageToken ? { 'X-Page-Token': pageToken } : {}),
    };
}

// AES decrypt — mesmo algoritmo do player do provedor
function aesDecrypt(encryptedData, key) {
    try {
        // O player usa CryptoJS AES com formato JSON {"ct":"...","iv":"...","s":"..."}
        const parsed = JSON.parse(encryptedData);
        const salt = CryptoJS.enc.Hex.parse(parsed.s);
        const iv = CryptoJS.enc.Hex.parse(parsed.iv);
        const ct = CryptoJS.enc.Base64.parse(parsed.ct);
        const keyPass = CryptoJS.enc.Utf8.parse(key);

        // Derivação de chave via PBKDF2 (modo do CryptoJSAesJson)
        const derivedKey = CryptoJS.PBKDF2(keyPass, salt, {
            keySize: 256 / 32,
            iterations: 999,
            hasher: CryptoJS.algo.SHA512,
        });

        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext: ct },
            derivedKey,
            { iv, padding: CryptoJS.pad.Pkcs7 }
        );

        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch {
        return null;
    }
}

app.get('/resolve', async (req, res) => {
    const { type, id, season, episode } = req.query;
    if (!type || !id) {
        return res.status(400).json({ error: 'Parâmetros "type" e "id" são obrigatórios.' });
    }

    // Monta URL do embed
    let embedUrl = `https://warezcdn.site/${type}/${id}`;
    if (type === 'serie' && season) {
        embedUrl += `/${season}`;
        if (episode) embedUrl += `/${episode}`;
    }
    embedUrl = embedUrl.replace(/([^:])\/\/+/g, '$1/');

    console.log(`[RESOLVE] ${embedUrl}`);

    try {
        // ── PASSO 1: Buscar o HTML do embed ──────────────────────
        const pageRes = await fetch(embedUrl, {
            headers: warezHeaders('https://warezcdn.site/'),
            redirect: 'follow',
            timeout: 20000,
        });
        const pageHtml = await pageRes.text();

        // Extrair CSRF_TOKEN — formato: var CSRF_TOKEN = "..."
        const tokenMatch = pageHtml.match(/var\s+CSRF_TOKEN\s*=\s*["']([^"']+)["']/i)
            || pageHtml.match(/CSRF_TOKEN\s*=\s*["']([^"']+)["']/i)
            || pageHtml.match(/'_token'\s*:\s*'([^']+)'/i)
            || pageHtml.match(/"_token"\s*:\s*"([^"]+)"/i)
            || pageHtml.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);

        // Extrair contentId — formato: var INITIAL_CONTENT_ID = 184;
        const contentidMatch = pageHtml.match(/var\s+INITIAL_CONTENT_ID\s*=\s*(\d+)/i)
            || pageHtml.match(/INITIAL_CONTENT_ID\s*=\s*(\d+)/i)
            || pageHtml.match(/getOptions\s*\(\s*(\d+)/i)
            || pageHtml.match(/contentid\s*[=:]\s*["']?(\d+)/i)
            || pageHtml.match(/data-id=["'](\d+)["']/i)
            || pageHtml.match(/var\s+contentId\s*=\s*(\d+)/i)
            || pageHtml.match(/['"]contentid['"\s]*[,:]+\s*(\d+)/i);

        // Extrair PAGE_TOKEN — formato: var PAGE_TOKEN = "..."
        const pageTokenMatch = pageHtml.match(/var\s+PAGE_TOKEN\s*=\s*["']([^"']+)["']/i)
            || pageHtml.match(/PAGE_TOKEN\s*=\s*["']([^"']+)["']/i)
            || pageHtml.match(/page_token\s*[:=]\s*["']([^"']+)["']/i);

        const csrfToken = tokenMatch ? tokenMatch[1] : null;
        const contentid = contentidMatch ? contentidMatch[1] : null;
        const pageToken = pageTokenMatch ? (pageTokenMatch[1]) : null;

        console.log(`[RESOLVE] csrfToken=${csrfToken ? 'ok' : 'NOT FOUND'} contentid=${contentid} pageToken=${pageToken ? 'ok' : 'NOT FOUND'}`);

        if (!csrfToken || !contentid) {
            return res.status(404).json({
                error: 'Não foi possível extrair os tokens da página. O WarezCDN pode ter bloqueado o acesso.',
                embedUrl,
                debug: { csrfToken: !!csrfToken, contentid: !!contentid, pageToken: !!pageToken },
            });
        }

        // ── PASSO 2: POST /player/options ────────────────────────
        const optBody = new URLSearchParams({
            contentid,
            type,
            _token: csrfToken,
            ...(pageToken ? { page_token: pageToken } : {}),
        }).toString();

        const optRes = await fetch('https://warezcdn.site/player/options', {
            method: 'POST',
            headers: xhrHeaders(embedUrl, pageToken),
            body: optBody,
            timeout: 15000,
        });
        const optJson = await optRes.json();

        const options = optJson?.data?.options || [];
        if (!options.length) {
            return res.status(404).json({
                error: 'Nenhum servidor disponível retornado pelo WarezCDN.',
                embedUrl,
                optResponse: optJson,
            });
        }

        // Pegar o primeiro servidor (Servidor Principal)
        const videoId = options[0]?.ID || options[0]?.id;
        console.log(`[RESOLVE] video_id=${videoId}`);

        // ── PASSO 3: POST /player/source ─────────────────────────
        const srcBody = new URLSearchParams({
            video_id: String(videoId),
            _token: csrfToken,
            ...(pageToken ? { page_token: pageToken } : {}),
        }).toString();

        const srcRes = await fetch('https://warezcdn.site/player/source', {
            method: 'POST',
            headers: xhrHeaders(embedUrl, pageToken),
            body: srcBody,
            timeout: 15000,
        });
        const srcJson = await srcRes.json();

        const redirectUrl = srcJson?.data?.video_url;
        if (!redirectUrl) {
            return res.status(404).json({
                error: 'URL de redirecionamento não encontrada.',
                embedUrl,
                srcResponse: srcJson,
            });
        }

        console.log(`[RESOLVE] redirect_url=${redirectUrl.substring(0, 80)}`);

        // ── PASSO 4: Seguir o redirect → página do provedor ──────
        const redirectRes = await fetch(redirectUrl, {
            headers: warezHeaders(embedUrl),
            redirect: 'follow',
            timeout: 15000,
        });
        const providerUrl = redirectRes.url;
        const providerHtml = await redirectRes.text();

        console.log(`[RESOLVE] provider_url=${providerUrl.substring(0, 80)}`);

        // Extrair o hash/data da URL do provider
        // Ex: https://llanfairpwllgwyngy.com/video/82ed7c6b71033c32eb01b6e549d58a4f
        const providerHashMatch = providerUrl.match(/\/video\/([a-f0-9]{32,})/i)
            || providerHtml.match(/data\s*=\s*['"]([a-f0-9]{32,})['"]/i)
            || providerHtml.match(/[?&]data=([a-f0-9]{32,})/i);

        if (!providerHashMatch) {
            // Tentar extrair URL diretamente do HTML do provider (fallback)
            const directUrls = extractDirectVideoUrls(providerHtml);
            if (directUrls.length > 0) {
                return res.json({ urls: directUrls, embedUrl, providerUrl });
            }
            return res.status(404).json({
                error: 'Hash do provider não encontrado.',
                embedUrl,
                providerUrl,
            });
        }

        const dataHash = providerHashMatch[1];
        const providerOrigin = new URL(providerUrl).origin;

        console.log(`[RESOLVE] data_hash=${dataHash} provider=${providerOrigin}`);

        // ── PASSO 5: POST getVideo no provider ───────────────────
        const getVideoUrl = `${providerOrigin}/player/index.php?data=${dataHash}&do=getVideo`;
        const getVideoRes = await fetch(getVideoUrl, {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': providerUrl,
                'Origin': providerOrigin,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: `r=${encodeURIComponent(embedUrl)}&d=${encodeURIComponent(new URL(providerOrigin).hostname)}`,
            timeout: 15000,
        });

        const getVideoText = await getVideoRes.text();
        console.log(`[RESOLVE] getVideo response: ${getVideoText.substring(0, 200)}`);

        let getVideoJson;
        try { getVideoJson = JSON.parse(getVideoText); } catch {
            // Tentar extrair URL bruta do texto mesmo sem JSON
            const rawUrls = extractDirectVideoUrls(getVideoText);
            if (rawUrls.length > 0) return res.json({ urls: rawUrls, embedUrl, providerUrl });
            return res.status(502).json({ error: 'Resposta do provider não é JSON válido.', raw: getVideoText.substring(0, 300) });
        }

        // ── PASSO 6: Decriptar AES → URL do vídeo ────────────────
        // Chaves reais retornadas: hls, videoSource, securedLink, ck
        const encFile = getVideoJson?.hls || getVideoJson?.videoSource || getVideoJson?.file;
        const ck = getVideoJson?.ck;

        let finalVideoUrl = null;

        if (encFile && ck) {
            const decrypted = aesDecrypt(encFile, ck);
            if (decrypted && decrypted.startsWith('http')) {
                finalVideoUrl = decrypted.trim();
            }
        }

        // Tentar securedLink diretamente (pode ser URL direta sem criptografia)
        if (!finalVideoUrl && getVideoJson?.securedLink) {
            const sl = getVideoJson.securedLink;
            if (sl.startsWith('http')) finalVideoUrl = sl;
        }

        // Fallback: qualquer campo string que seja URL
        if (!finalVideoUrl) {
            for (const val of Object.values(getVideoJson || {})) {
                if (typeof val === 'string' && val.startsWith('http') && (val.includes('.m3u8') || val.includes('.mp4'))) {
                    finalVideoUrl = val;
                    break;
                }
            }
        }

        if (!finalVideoUrl) {
            return res.status(404).json({
                error: 'Não foi possível obter a URL do vídeo. A decriptação falhou ou o formato mudou.',
                embedUrl,
                providerUrl,
                getVideoKeys: Object.keys(getVideoJson || {}),
            });
        }

        console.log(`[RESOLVE] ✅ URL encontrada: ${finalVideoUrl.substring(0, 80)}`);

        // Registrar o CDN do provider para que o proxy use o referer correto
        try {
            const cdnHostname = new URL(finalVideoUrl).hostname;
            WAREZ_PROVIDER_REFERERS.set(cdnHostname, providerUrl);
        } catch { }

        return res.json({ urls: [finalVideoUrl], embedUrl, providerUrl });

    } catch (err) {
        console.error('[RESOLVE ERROR]', err.message);
        return res.status(502).json({ error: 'Falha na extração.', details: err.message });
    }
});

// Extrai URLs de vídeo diretamente do HTML (fallback)
function extractDirectVideoUrls(html) {
    const found = new Set();
    const patterns = [
        /"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/gi,
        /"file"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/gi,
        /file\s*:\s*'(https?:\/\/[^']+\.m3u8[^']*)'/gi,
        /(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/gi,
        /(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/gi,
    ];
    for (const p of patterns) {
        p.lastIndex = 0;
        let m;
        while ((m = p.exec(html)) !== null) {
            if (m[1]?.startsWith('http')) found.add(m[1].trim());
        }
    }
    return [...found].sort((a, b) => (a.includes('.m3u8') ? 0 : 1) - (b.includes('.m3u8') ? 0 : 1));
}

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🎬  LynePlay rodando em http://localhost:${PORT}\n`);
});
