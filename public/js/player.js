/**
 * LynePlayer — custom video player
 * Suporte a HLS (via hls.js) e formatos nativos
 */
class LynePlayer {
    constructor() {
        this.video = document.getElementById('vid');
        this.wrap = document.getElementById('player-wrap');
        this.loadLayer = document.getElementById('loading-layer');
        this.errorLayer = document.getElementById('error-layer');
        this.ctrlLayer = document.getElementById('controls-layer');
        this.loaderTxt = document.getElementById('loader-txt');
        this.errMsg = document.getElementById('err-msg');
        this.ctrlTitle = document.getElementById('ctrl-title');

        this.progressWrap = document.getElementById('progress-wrap');
        this.progBuf = document.getElementById('prog-buf');
        this.progPlay = document.getElementById('prog-play');
        this.progThumb = document.getElementById('prog-thumb');
        this.progTip = document.getElementById('prog-tip');
        this.tCur = document.getElementById('t-cur');
        this.tDur = document.getElementById('t-dur');

        this.ppBtn = document.getElementById('pp-btn');
        this.bigPlayBtn = document.getElementById('big-play-btn');
        this.muteBtn = document.getElementById('mute-btn');
        this.volSlider = document.getElementById('vol-slider');
        this.fsBtn = document.getElementById('fs-btn');
        this.pipBtn = document.getElementById('pip-btn');
        this.speedBtn = document.getElementById('speed-btn');
        this.speedPop = document.getElementById('speed-pop');
        this.backBtn = document.getElementById('back-btn');
        this.retryBtn = document.getElementById('retry-btn');
        this.errBackBtn = document.getElementById('err-back-btn');

        this.hls = null;
        this.currentUrl = null;
        this._hideTimer = null;
        this._dragging = false;
        this._hasPlayed = false;        // true assim que o vídeo reproduzir de fato
        this._recovering = false;       // true durante recoverMediaError
        this._recoveryAttempts = 0;     // contador de tentativas de recuperação

        this._initEvents();
        this._initKeyboard();
    }

    // ─── Public API ──────────────────────────────

    load(url, title = '') {
        this.currentUrl = url;
        this.ctrlTitle.textContent = title || this._titleFromUrl(url);
        this._reset();
        this._showLoading('Preparando stream…');

        const isHLS = /\.m3u8?(\?|$)/i.test(url) || url.includes('m3u8');

        // URLs pré-assinadas por IP (CDN com md5+expires) não podem ser proxiadas
        // pois a assinatura é vinculada ao IP do cliente, não do servidor
        const isSignedUrl = /[?&]md5=[^&]+.*[?&]expires=\d+/i.test(url) ||
            /[?&]expires=\d+.*[?&]md5=[^&]+/i.test(url);

        // URLs relativas já proxiadas (começam com /proxy)
        const isAlreadyProxy = url.startsWith('/proxy') || url.startsWith('/api/');

        // Decidir se usar proxy ou não
        const finalUrl = (isSignedUrl || isAlreadyProxy) ? url : this._proxy(url);

        if (isHLS) {
            this._loadHLS(finalUrl);
        } else {
            this._loadNative(finalUrl);
        }
    }

    // ─── Source loading ───────────────────────────

    _loadHLS(proxyUrl) {
        if (typeof Hls === 'undefined') {
            this._showError('HLS.js não carregou. Verifique a conexão.');
            return;
        }

        if (Hls.isSupported()) {
            this.hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                lowLatencyMode: false,
                enableWorker: true,
            });

            this.hls.loadSource(proxyUrl);
            this.hls.attachMedia(this.video);

            this.hls.once(Hls.Events.MANIFEST_PARSED, () => {
                this._hideLoading();
                this.video.play().catch(() => { });
            });

            this.hls.on(Hls.Events.ERROR, (_, data) => {
                if (!data.fatal) return;

                // Se o vídeo já estava tocando, tentar recuperar silenciosamente
                if (this._hasPlayed) {
                    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this._recoveryAttempts < 3) {
                        this._recovering = true;
                        this._recoveryAttempts++;
                        this.hls.recoverMediaError();
                        setTimeout(() => { this._recovering = false; }, 2000);
                    } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this._recoveryAttempts < 3) {
                        this._recoveryAttempts++;
                        try { this.hls.startLoad(); } catch { }
                    }
                    // Nunca mostra overlay se já reproduziu
                    return;
                }

                // Vídeo ainda não chegou a tocar — tentar recuperar uma vez
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this._recoveryAttempts < 2) {
                    this._recovering = true;
                    this._recoveryAttempts++;
                    this.hls.recoverMediaError();
                    setTimeout(() => { this._recovering = false; }, 2000);
                } else if (!this._recovering) {
                    this._showError('Falha ao carregar o stream. O link pode estar expirado ou bloqueado.');
                }
            });

        } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari: suporte nativo a HLS
            this.video.src = proxyUrl;
            this.video.addEventListener('loadedmetadata', () => {
                this._hideLoading();
                this.video.play().catch(() => { });
            }, { once: true });

        } else {
            this._showError('Seu browser não suporta HLS. Use Chrome, Firefox ou Edge.');
        }
    }

    _loadNative(proxyUrl) {
        this.video.src = proxyUrl;
        this.video.load();

        let settled = false;

        const onReady = () => {
            if (settled) return;
            settled = true;
            this.video.removeEventListener('error', onError);
            this._hideLoading();
            this.video.play().catch(() => { });
        };

        const onError = () => {
            if (settled) return;
            settled = true;
            this.video.removeEventListener('canplay', onReady);
            this._showError('Não foi possível carregar. Verifique se o link é válido.');
        };

        this.video.addEventListener('canplay', onReady);
        this.video.addEventListener('error', onError);
    }

    // ─── Events ───────────────────────────────────

    _initEvents() {
        const v = this.video;

        // Playback
        v.addEventListener('play', () => this._setPlayState(true));
        v.addEventListener('pause', () => this._setPlayState(false));
        v.addEventListener('ended', () => this._setPlayState(false));
        v.addEventListener('waiting', () => this.loaderTxt.textContent = 'Buffering…');
        v.addEventListener('playing', () => {
            // Vídeo rodando = sem overlay. Limpa loading E erro.
            this._hasPlayed = true;
            this._recovering = false;
            this._recoveryAttempts = 0; // reset ao reproduzir com sucesso
            this.loadLayer.hidden = true;
            this.errorLayer.hidden = true;
        });

        // Time / buffer
        v.addEventListener('timeupdate', () => this._onTimeUpdate());
        v.addEventListener('progress', () => this._onBufferUpdate());
        v.addEventListener('durationchange', () => {
            this.tDur.textContent = this._fmt(v.duration);
        });

        // Volume
        v.addEventListener('volumechange', () => this._updateVolumeUI());

        // Controls visibility
        this.wrap.addEventListener('mousemove', () => this._showControls());
        this.wrap.addEventListener('mouseleave', () => this._scheduleHide(1200));
        this.wrap.addEventListener('touchstart', () => this._showControls(), { passive: true });

        // Click play/pause
        this.video.addEventListener('click', () => this.togglePlay());

        // Double click fullscreen
        this.video.addEventListener('dblclick', () => this.toggleFS());

        // Buttons
        this.ppBtn.addEventListener('click', () => this.togglePlay());
        this.bigPlayBtn.addEventListener('click', () => this.togglePlay());
        this.muteBtn.addEventListener('click', () => this.toggleMute());
        this.fsBtn.addEventListener('click', () => this.toggleFS());
        this.pipBtn.addEventListener('click', () => this.togglePiP());
        this.backBtn.addEventListener('click', () => window.App?.goHome());
        this.retryBtn.addEventListener('click', () => this.retry());
        this.errBackBtn.addEventListener('click', () => window.App?.goHome());

        // Volume slider
        this.volSlider.addEventListener('input', e => {
            const vol = parseInt(e.target.value) / 100;
            v.volume = vol;
            v.muted = vol === 0;
        });

        // Speed menu
        this.speedBtn.addEventListener('click', e => {
            e.stopPropagation();
            this.speedPop.classList.toggle('open');
        });
        this.speedPop.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const s = parseFloat(btn.dataset.speed);
                v.playbackRate = s;
                this.speedBtn.textContent = s === 1 ? '1×' : `${s}×`;
                this.speedPop.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.speedPop.classList.remove('open');
            });
        });
        document.addEventListener('click', () => this.speedPop.classList.remove('open'));

        // Fullscreen change
        document.addEventListener('fullscreenchange', () => {
            const isFS = !!document.fullscreenElement;
            this.wrap.classList.toggle('is-fullscreen', isFS);
        });

        // Progress bar
        this._initProgress();
    }

    _initProgress() {
        const wrap = this.progressWrap;
        const v = this.video;

        const getRatio = (e) => {
            const rect = wrap.getBoundingClientRect();
            return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        };

        wrap.addEventListener('mousemove', e => {
            const ratio = getRatio(e);
            const t = ratio * (v.duration || 0);
            this.progTip.textContent = this._fmt(t);
            this.progTip.style.left = `${ratio * 100}%`;
            this.progTip.style.opacity = '1';
        });

        wrap.addEventListener('mouseleave', () => {
            if (!this._dragging) this.progTip.style.opacity = '0';
        });

        wrap.addEventListener('mousedown', e => {
            this._dragging = true;
            wrap.classList.add('dragging');
            const ratio = getRatio(e);
            v.currentTime = ratio * (v.duration || 0);
            this._updatePlayhead(ratio);
        });

        document.addEventListener('mousemove', e => {
            if (!this._dragging) return;
            const ratio = getRatio(e);
            v.currentTime = ratio * (v.duration || 0);
            this._updatePlayhead(ratio);
            this.progTip.textContent = this._fmt(v.currentTime);
            this.progTip.style.left = `${ratio * 100}%`;
        });

        document.addEventListener('mouseup', () => {
            if (!this._dragging) return;
            this._dragging = false;
            wrap.classList.remove('dragging');
            this.progTip.style.opacity = '0';
        });
    }

    _initKeyboard() {
        document.addEventListener('keydown', e => {
            if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            const playerActive = document.getElementById('view-player').classList.contains('active');
            if (!playerActive) return;

            switch (e.key.toLowerCase()) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    this.togglePlay();
                    break;
                case 'f':
                    this.toggleFS();
                    break;
                case 'm':
                    this.toggleMute();
                    break;
                case 'arrowleft':
                    e.preventDefault();
                    this.video.currentTime = Math.max(0, this.video.currentTime - 10);
                    this._flashSkip(-10);
                    break;
                case 'arrowright':
                    e.preventDefault();
                    this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10);
                    this._flashSkip(+10);
                    break;
                case 'arrowup':
                    e.preventDefault();
                    this._adjustVol(+0.1);
                    break;
                case 'arrowdown':
                    e.preventDefault();
                    this._adjustVol(-0.1);
                    break;
                case 'escape':
                    if (!document.fullscreenElement) window.App?.goHome();
                    break;
            }
        });
    }

    // ─── Controls ─────────────────────────────────

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(() => { });
        } else {
            this.video.pause();
        }
    }

    toggleMute() {
        const v = this.video;
        v.muted = !v.muted;
        if (!v.muted && v.volume === 0) v.volume = 0.5;
    }

    async toggleFS() {
        const el = this.wrap;
        if (!document.fullscreenElement) {
            await el.requestFullscreen().catch(() => { });
        } else {
            await document.exitFullscreen();
        }
    }

    async togglePiP() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else {
                await this.video.requestPictureInPicture();
            }
        } catch { }
    }

    retry() {
        if (this.currentUrl) {
            this.load(this.currentUrl, this.ctrlTitle.textContent);
        }
    }

    // ─── UI helpers ───────────────────────────────

    _reset() {
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        this.video.src = '';
        this.errorLayer.hidden = true;
        this.loadLayer.hidden = false;
        this.tCur.textContent = '0:00';
        this.tDur.textContent = '0:00';
        this._updatePlayhead(0);
        this.progBuf.style.width = '0%';
        // Resetar flags de estado
        this._hasPlayed = false;
        this._recovering = false;
        this._recoveryAttempts = 0;
    }

    _showLoading(msg = 'Carregando…') {
        this.loaderTxt.textContent = msg;
        this.loadLayer.hidden = false;
        this.errorLayer.hidden = true;
    }

    _hideLoading() {
        this.loadLayer.hidden = true;
    }

    _showError(msg) {
        // Nunca mostrar erro se o vídeo já reproduziu ou está em recuperação
        if (this._hasPlayed || this._recovering) {
            console.warn('[LynePlayer] Erro ignorado — vídeo já em reprodução ou em recuperação:', msg);
            return;
        }
        // Também ignorar se o vídeo tem dados suficientes para tocar
        if (this.video.readyState >= 3 || this.video.currentTime > 0) {
            console.warn('[LynePlayer] Erro ignorado — vídeo com dados disponíveis:', msg);
            return;
        }
        this._hideLoading();
        this.errMsg.textContent = msg;
        this.errorLayer.hidden = false;
    }

    _setPlayState(playing) {
        this.wrap.classList.toggle('is-playing', playing);
        if (playing) this._scheduleHide(3000);
        else this._showControls();
    }

    _onTimeUpdate() {
        if (this._dragging) return;
        const v = this.video;
        const dur = v.duration || 0;
        const ratio = dur > 0 ? v.currentTime / dur : 0;
        this.tCur.textContent = this._fmt(v.currentTime);
        this._updatePlayhead(ratio);
    }

    _onBufferUpdate() {
        const v = this.video;
        if (!v.duration) return;
        let bufEnd = 0;
        for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime) {
                bufEnd = Math.max(bufEnd, v.buffered.end(i));
            }
        }
        this.progBuf.style.width = `${(bufEnd / v.duration) * 100}%`;
    }

    _updatePlayhead(ratio) {
        const pct = `${ratio * 100}%`;
        this.progPlay.style.width = pct;
        this.progThumb.style.left = pct;
    }

    _updateVolumeUI() {
        const v = this.video;
        const muted = v.muted || v.volume === 0;
        this.wrap.classList.toggle('is-muted', muted);
        if (!muted) this.volSlider.value = Math.round(v.volume * 100);
        else this.volSlider.value = 0;
    }

    _adjustVol(delta) {
        const v = this.video;
        v.volume = Math.min(1, Math.max(0, v.volume + delta));
        v.muted = v.volume === 0;
    }

    _showControls() {
        clearTimeout(this._hideTimer);
        this.ctrlLayer.classList.add('visible');
        this.wrap.classList.add('controls-visible');

        // Auto-hide quando em reprodução
        if (!this.video.paused) {
            this._scheduleHide(3000);
        }
    }

    _scheduleHide(ms) {
        clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => {
            if (!this.video.paused) {
                this.ctrlLayer.classList.remove('visible');
                this.wrap.classList.remove('controls-visible');
            }
        }, ms);
    }

    _flashSkip(secs) {
        const existing = this.wrap.querySelectorAll('.skip-flash');
        existing.forEach(el => el.remove());

        const el = document.createElement('div');
        el.className = `skip-flash ${secs < 0 ? 'left' : 'right'}`;
        el.textContent = secs < 0 ? `−${Math.abs(secs)}s` : `+${secs}s`;
        this.wrap.appendChild(el);

        el.addEventListener('animationend', () => el.remove());
    }

    // ─── Utilities ────────────────────────────────

    _proxy(url) {
        // Se a URL já está proxiada ou é relativa (já é rota local), retornar como está
        if (url.startsWith('/proxy') || url.startsWith('/api/') || !url.startsWith('http')) {
            return url;
        }
        return `/proxy?url=${encodeURIComponent(url)}`;
    }

    _titleFromUrl(url) {
        try {
            const path = new URL(url).pathname;
            const name = path.split('/').filter(Boolean).pop() || 'Stream';
            return decodeURIComponent(name).replace(/\.[^.]+$/, '');
        } catch {
            return 'Stream';
        }
    }

    _fmt(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }
}

window.player = new LynePlayer();
