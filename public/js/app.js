/**
 * LynePlay — App controller
 * ─────────────────────────────────────────────────────────────
 * Como funciona:
 *
 * 1. O usuário cola qualquer URL no campo de input.
 *
 * 2. Se a URL for um link direto (m3u8, mp4, etc.):
 *    → vai direto pro player via /proxy (que adiciona headers e reescreve o m3u8).
 *
 * 3. Se a URL for do WarezCDN (ex: warezcdn.site/filme/tt0468569):
 *    → detectamos automaticamente e chamamos nosso endpoint /resolve no servidor.
 *    → o servidor faz todo o trabalho: extrai tokens CSRF e contentId da página,
 *      chama /player/options e /player/source, segue o redirect pro provider,
 *      chama getVideo e decripta o AES → retorna a URL bruta do .m3u8.
 *    → exibimos a URL extraída com botões "Copiar" e "Reproduzir".
 *
 * Isso é tudo client-side de interface; a extração real acontece em server.js.
 */

const App = (() => {
    // ─── Constantes ───────────────────────────────────────────

    const HISTORY_KEY = 'lyneplay_history';
    const MAX_HISTORY = 12;

    // Padrão para detectar URLs do WarezCDN no campo de input
    // Ex: https://warezcdn.site/filme/tt0468569
    //     https://warezcdn.site/serie/1396/1/1
    //     warezcdn.site/anime/123
    const WAREZ_URL_RE = /(?:https?:\/\/)?warezcdn\.site\/(filme|serie|anime)\/([^\s/?#]+)(?:\/(\d+)(?:\/(\d+))?)?/i;

    // ─── Elementos do DOM ─────────────────────────────────────

    const homeView = document.getElementById('view-home');
    const playerView = document.getElementById('view-player');
    const urlInput = document.getElementById('url-input');
    const urlWrap = document.getElementById('url-field-wrap');
    const fmtBadge = document.getElementById('fmt-badge');
    const playBtn = document.getElementById('play-btn');
    const pasteBtn = document.getElementById('paste-btn');
    const historyWrap = document.getElementById('history-wrap');
    const historyList = document.getElementById('history-list');
    const clearBtn = document.getElementById('clear-btn');

    // Painel de resultado da extração WarezCDN
    const extractResult = document.getElementById('extract-result');
    const extractLabel = document.getElementById('extract-label');
    const extractList = document.getElementById('extract-list');
    const extractClear = document.getElementById('extract-clear');

    // ─── Detecção de formato ──────────────────────────────────

    const FORMATS = [
        { re: /\.m3u8?(\?|$)/i, label: 'HLS', cls: 'chip-hls' },
        { re: /\.mp4(\?|$)/i, label: 'MP4', cls: 'chip-mp4' },
        { re: /\.webm(\?|$)/i, label: 'WebM', cls: '' },
        { re: /\.mkv(\?|$)/i, label: 'MKV', cls: '' },
        { re: /\.ogv(\?|$)/i, label: 'OGG', cls: '' },
        { re: /\.ts(\?|$)/i, label: 'TS', cls: '' },
        { re: /m3u8/i, label: 'HLS', cls: 'chip-hls' },
    ];

    function detectFormat(url) {
        for (const f of FORMATS) {
            if (f.re.test(url)) return f;
        }
        return null;
    }

    // Atualiza o badge de formato ao lado do input
    function updateBadge(url) {
        // URL do WarezCDN → badge especial
        if (WAREZ_URL_RE.test(url)) {
            fmtBadge.textContent = 'WarezCDN';
            fmtBadge.className = 'fmt-badge chip-warez';
            fmtBadge.style.display = '';
            return;
        }
        const fmt = detectFormat(url);
        if (fmt) {
            fmtBadge.textContent = fmt.label;
            fmtBadge.className = `fmt-badge ${fmt.cls}`;
            fmtBadge.style.display = '';
        } else {
            fmtBadge.style.display = 'none';
        }
    }

    // ─── Navegação entre views ────────────────────────────────

    function goPlayer(rawUrl) {
        const url = rawUrl.trim();
        if (!url) { shake(); return; }

        // Aceita URLs relativas (ex: /proxy?url=...) ou absolutas
        const isRelative = url.startsWith('/');
        if (!isRelative && !isValidUrl(url)) {
            shake();
            urlInput.focus();
            return;
        }

        saveHistory(url);
        renderHistory();

        homeView.classList.remove('active');
        playerView.classList.add('active');
        document.body.style.overflow = 'hidden';

        window.player.load(url);
    }

    function goHome() {
        playerView.classList.remove('active');
        homeView.classList.add('active');
        document.body.style.overflow = '';

        // Limpar player
        const vid = document.getElementById('vid');
        vid.pause();
        vid.src = '';
        if (window.player.hls) {
            window.player.hls.destroy();
            window.player.hls = null;
        }

        urlInput.focus();
    }

    function shake() {
        urlWrap.classList.add('has-error');
        setTimeout(() => urlWrap.classList.remove('has-error'), 600);
    }

    function isValidUrl(str) {
        try {
            const u = new URL(str);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
            return false;
        }
    }

    // ─── Ação principal do botão "Assistir agora" ─────────────
    //
    // Detecta se a URL colada é do WarezCDN.
    // Se for → chama resolveWarez() para extrair o stream bruto.
    // Se não for → vai direto pro player.

    async function handlePlay() {
        const raw = urlInput.value.trim();
        if (!raw) { shake(); return; }

        // Detectar URL do WarezCDN
        const warezMatch = raw.match(WAREZ_URL_RE);
        if (warezMatch) {
            await resolveWarez(raw, warezMatch);
            return;
        }

        // Link direto — vai pro player normalmente
        goPlayer(raw);
    }

    // ─── Extração WarezCDN ────────────────────────────────────
    //
    // Quando o usuário cola uma URL do tipo warezcdn.site/filme/tt0468569,
    // chamamos o endpoint /resolve que faz todo o processo server-side:
    //   1. Busca a página do embed → extrai CSRF_TOKEN, INITIAL_CONTENT_ID, PAGE_TOKEN
    //   2. POST /player/options → obtém video_id
    //   3. POST /player/source → obtém URL de redirect
    //   4. Segue redirect → chega na página do provider (ex: llanfairpwllgwyngy.com)
    //   5. POST /player/index.php?do=getVideo → retorna JSON com videoSource (AES) + ck
    //   6. Decripta AES → URL bruta do .m3u8
    // Retorna { urls: [...], embedUrl, providerUrl }

    async function resolveWarez(rawUrl, match) {
        // Extrair type, id, season, episode da URL colada
        const type = match[1].toLowerCase(); // filme | serie | anime
        const id = match[2];               // tt0468569 ou 1396
        const season = match[3] || '1';
        const episode = match[4] || '1';

        // Mostrar o painel de resultado com estado de loading
        showExtractLoading();

        const params = new URLSearchParams({ type, id });
        if (type !== 'filme') {
            params.set('season', season);
            params.set('episode', episode);
        }

        try {
            const res = await fetch(`/resolve?${params.toString()}`);
            const data = await res.json();

            if (!res.ok || !data.urls || data.urls.length === 0) {
                // Mostrar mensagem de erro detalhada
                showExtractError(data.error || 'Nenhuma URL encontrada.', data.debug);
                return;
            }

            // Mostrar os streams encontrados com botões Copiar e Reproduzir
            showExtractResults(data.urls, data.providerUrl);

        } catch (err) {
            showExtractError('Falha de rede: ' + err.message, null);
        }
    }

    // Exibe estado de loading no painel de extração
    function showExtractLoading() {
        extractResult.style.display = 'block';
        extractLabel.textContent = 'Extraindo stream…';
        extractList.innerHTML = `
            <div class="extract-loading">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Buscando URL bruta no WarezCDN…
            </div>`;
    }

    // Exibe erro no painel de extração
    function showExtractError(msg, debug) {
        extractLabel.textContent = 'Erro na extração';
        let html = `<div class="extract-error">${escHtml(msg)}`;
        if (debug) {
            // Informações de debug para o desenvolvedor entender o que falhou
            html += `<small style="opacity:.5;display:block;margin-top:6px">
                csrfToken: ${debug.csrfToken ? '✓' : '✗'} &nbsp;
                contentid: ${debug.contentid ? '✓' : '✗'} &nbsp;
                pageToken: ${debug.pageToken ? '✓' : '✗'}
            </small>`;
        }
        html += `</div>`;
        extractList.innerHTML = html;
    }

    // Exibe os streams extraídos com botões de ação
    function showExtractResults(urls, providerUrl) {
        extractLabel.textContent = `${urls.length} stream${urls.length > 1 ? 's' : ''} encontrado${urls.length > 1 ? 's' : ''}`;
        extractList.innerHTML = '';

        urls.forEach((url, i) => {
            const isHls = url.includes('.m3u8');
            const isMp4 = url.includes('.mp4');
            const badgeCls = isHls ? 'hls' : isMp4 ? 'mp4' : '';
            const badgeTxt = isHls ? 'HLS' : isMp4 ? 'MP4' : 'Stream';

            const item = document.createElement('div');
            item.className = 'extract-item';
            item.style.animationDelay = `${i * 50}ms`;

            // data-ref guarda a página do provider (usada como Referer no proxy)
            item.innerHTML = `
                <span class="extract-badge ${badgeCls}">${badgeTxt}</span>
                <span class="extract-url" title="${escHtml(url)}">${escHtml(url)}</span>
                <div class="extract-actions">
                    <button class="ex-btn copy-btn" data-url="${escHtml(url)}">Copiar</button>
                    <button class="ex-btn play-btn-ex" data-url="${escHtml(url)}" data-ref="${escHtml(providerUrl || '')}">▶ Reproduzir</button>
                </div>`;

            extractList.appendChild(item);
        });

        // ── Botão Copiar ──
        // Copia a URL bruta extraída para o clipboard
        extractList.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(btn.dataset.url);
                    btn.textContent = '✓ Copiado!';
                    setTimeout(() => btn.textContent = 'Copiar', 2000);
                } catch {
                    btn.textContent = 'Erro';
                }
            });
        });

        // ── Botão Reproduzir ──
        // Passa a URL pelo nosso proxy com o ref= da página do provider.
        // O proxy no servidor seta o header Referer correto para o CDN.
        // O player.js detecta URLs /proxy e não faz double-proxy.
        extractList.querySelectorAll('.play-btn-ex').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                const ref = btn.dataset.ref;

                // Monta URL proxiada: /proxy?url=<stream>&ref=<pagina_do_provider>
                const proxyUrl = `/proxy?url=${encodeURIComponent(url)}${ref ? '&ref=' + encodeURIComponent(ref) : ''}`;

                // Preenche o input com a URL original (para histórico legível)
                urlInput.value = url;
                updateBadge(url);

                // Reproduz via proxy (resolve o CORS e hotlink do CDN)
                goPlayer(proxyUrl);
            });
        });
    }

    // ─── Histórico ────────────────────────────────────────────

    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
        catch { return []; }
    }

    function saveHistory(url) {
        // Não salvar URLs /proxy no histórico — salva a URL real
        if (url.startsWith('/proxy')) return;
        let list = loadHistory().filter(i => i.url !== url);
        list.unshift({ url, ts: Date.now() });
        if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    }

    function clearHistory() {
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
    }

    function renderHistory() {
        const list = loadHistory();
        if (list.length === 0) {
            historyWrap.style.display = 'none';
            return;
        }

        historyWrap.style.display = '';
        historyList.innerHTML = '';

        list.forEach(({ url, ts }, i) => {
            const fmt = detectFormat(url);
            const item = document.createElement('button');
            item.className = 'history-item';
            item.style.animationDelay = `${i * 40}ms`;
            item.innerHTML = `
                <div class="history-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
                <div class="history-info">
                    <div class="history-url">${escHtml(truncateUrl(url))}</div>
                    <div class="history-meta">${fmt ? fmt.label + ' · ' : ''}${timeAgo(ts)}</div>
                </div>
                <div class="history-play">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>`;

            item.addEventListener('click', () => {
                urlInput.value = url;
                updateBadge(url);
                goPlayer(url);
            });

            historyList.appendChild(item);
        });
    }

    // ─── Utilitários ──────────────────────────────────────────

    function truncateUrl(url) {
        if (url.length <= 70) return url;
        return url.substring(0, 40) + '…' + url.substring(url.length - 25);
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function timeAgo(ts) {
        const diff = (Date.now() - ts) / 1000;
        if (diff < 60) return 'agora mesmo';
        if (diff < 3600) return `${Math.floor(diff / 60)} min atrás`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
        return `${Math.floor(diff / 86400)}d atrás`;
    }

    // ─── Eventos ──────────────────────────────────────────────

    // Botão principal → detecta WarezCDN ou link direto
    playBtn.addEventListener('click', handlePlay);

    // Enter no input também aciona
    urlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') handlePlay();
    });

    // Atualizar badge enquanto digita/cola
    urlInput.addEventListener('input', () => updateBadge(urlInput.value));
    urlInput.addEventListener('paste', () => setTimeout(() => updateBadge(urlInput.value), 0));

    // Botão colar do clipboard
    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                urlInput.value = text.trim();
                updateBadge(urlInput.value);
                urlInput.focus();
                urlInput.setSelectionRange(urlInput.value.length, urlInput.value.length);
            }
        } catch {
            urlInput.focus(); // Permissão negada → deixar o usuário colar manualmente
        }
    });

    // Limpar histórico
    clearBtn.addEventListener('click', clearHistory);

    // Limpar resultado de extração
    extractClear.addEventListener('click', () => {
        extractResult.style.display = 'none';
        extractList.innerHTML = '';
    });

    // ─── Init ─────────────────────────────────────────────────

    function init() {
        renderHistory();

        // Deep link via hash: #play?url=https://...
        const hash = window.location.hash;
        if (hash.startsWith('#play?')) {
            try {
                const params = new URLSearchParams(hash.slice(6));
                const url = params.get('url');
                if (url) {
                    urlInput.value = url;
                    handlePlay();
                }
            } catch { }
        }

        // Foco automático
        setTimeout(() => urlInput.focus(), 300);
    }

    init();

    // Expor para o player.js
    return { goHome, goPlayer };
})();

window.App = App;
