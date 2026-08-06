        let trainingData = {};
        let quizData = {};
        let orderData = {};
        let quizStatus = {};
        let nameOptions = [];

        // Formata nota com 1 casa decimal (vírgula), ex.: 8,2/10
        function formatScore(score) {
            const n = Number(score);
            if (!Number.isFinite(n)) return score;
            return n.toFixed(1).replace('.', ',');
        }

        // Categoria escolhida na home (index.html). Sem escolha, cai em Treinamentos.
        const CATEGORY_PATHS = {
            'Treinamentos': 'treinamentos',
            'Educação Continuada': 'educacao_continuada',
            'Estágios': 'estagios'
        };

        function resolveCategory() {
            const fromQuery = new URLSearchParams(location.search).get('cat');
            let stored = null;
            try { stored = localStorage.getItem('uniadmin.category'); } catch (error) { /* indisponível */ }
            const category = fromQuery || stored;
            return CATEGORY_PATHS[category] ? category : 'Treinamentos';
        }

        const currentCategory = resolveCategory();
        const currentCategorySlug = CATEGORY_PATHS[currentCategory];

        async function fetchNames() {
            // URL centralizada em js/colaboradores-sync.js (mesma fonte usada
            // para sincronizar /uniadmin/colaboradores) — evita duas cópias.
            const url = window.UniAdmin?.ColaboradoresSync?.SHEETS_NAMES_URL;
            if (!url) return;
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                const payload = await response.json();
                // A planilha devolve objetos ({colunaB: nome, ...}); o combobox
                // só usa o nome — normalização compartilhada com o sync.
                const normalize = window.UniAdmin.ColaboradoresSync.normalizeEntry;
                const names = (Array.isArray(payload) ? payload : [])
                    .map(entry => normalize(entry)?.name)
                    .filter(Boolean);
                nameOptions = names;
                const select = document.getElementById('name');
                if (select) {
                    names.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        select.appendChild(option);
                    });
                }
            } catch (error) {
                console.error('Erro ao carregar nomes da planilha:', error);
            }
        }

        function sortItems(items, orderConfig, itemKey = 'id') {
            if (!orderConfig || !Array.isArray(orderConfig)) {
                return items.map((item, index) => ({
                    key: itemKey === 'index' ? index : item[itemKey] || index,
                    item,
                    order: index
                }));
            }
            const orderMap = new Map();
            orderConfig.forEach((orderItem, index) => {
                if (typeof orderItem === 'object' && orderItem.id !== undefined) {
                    orderMap.set(String(orderItem.id), orderItem.order || index);
                } else {
                    orderMap.set(String(orderItem), index);
                }
            });
            return items.map((item, index) => {
                const key = itemKey === 'index' ? index : (item[itemKey] || index);
                return {
                    key,
                    item,
                    order: orderMap.has(String(key)) ? orderMap.get(String(key)) : Infinity
                };
            }).sort((a, b) => a.order - b.order);
        }

        async function fetchFirebaseData() {
            try {
                const response = await fetch(`https://uniadmin-708f5-default-rtdb.firebaseio.com/uniadmin/${currentCategorySlug}.json`);
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                // Categoria ainda sem conteudo no banco: o Firebase devolve null.
                const data = (await response.json()) || {};
                orderData = data.order || {};
                quizData = data.quizData || {};
                quizStatus = data.quizStatus || {};
                trainingData = data.trainingData || {};
                populateDropdown();
                loadProgression();
                document.getElementById('loading-overlay').style.display = 'none';
            } catch (error) {
                console.error('Erro ao carregar dados do Firebase:', error);
                showWarning('Não foi possível carregar os dados. Tente novamente.');
                document.getElementById('loading-overlay').style.display = 'none';
            }
        }

        const btn = document.getElementById('dropdownBtn');
        const dropdownContent = document.getElementById('dropdownContent');
        const dropdownList = document.getElementById('dropdownList');
        const themeBtn = document.getElementById('themeBtn');
        const themeDropdown = document.getElementById('themeDropdown');
        const backToCoursesBtn = document.getElementById('back-to-courses');
        const selectionDivider = document.getElementById('selection-divider');
        const courseGallery = document.getElementById('course-gallery');
        const courseGrid = document.getElementById('course-grid');
        const galleryEmpty = document.getElementById('gallery-empty');
        const galleryFilter = document.getElementById('gallery-filter');
        const gallerySub = document.getElementById('gallery-sub');
        const galleryTitle = document.getElementById('gallery-title');
        const contentDiv = document.getElementById('content');
        const video = document.getElementById('video');
        const customPlayerContainer = document.getElementById('custom-player');
        const ytFrameContainer = document.getElementById('yt-frame');
        const playPauseBtn = document.getElementById('play-pause-btn');
        const muteBtn = document.getElementById('mute-btn');
        const progressRange = document.getElementById('progress-range');
        const volumeRange = document.getElementById('volume-range');
        const speedSelect = document.getElementById('speed-select');
        const timeLabels = document.getElementById('time-labels');
        const pdfContainer = document.getElementById('pdf-container');
        const pdfCanvas = document.getElementById('pdf-canvas');
        const pdfNavigation = document.getElementById('pdf-navigation');
        const titleEl = document.getElementById('title');
        const captionEl = document.getElementById('caption');
        const attachmentContainer = document.getElementById('attachment-container');
        const modulesDiv = document.getElementById('modules');
        const quizContainer = document.getElementById('quiz-container');
        const resultContainer = document.getElementById('result-container');
        const formContainer = document.getElementById('form-container');
        const warningMessage = document.getElementById('warning-message');
        const warningText = document.getElementById('warning-text');
        const quizSubmit = document.createElement('button');
        quizSubmit.id = 'quiz-submit';
        quizSubmit.textContent = 'Enviar Avaliação';

        let currentTrainingId = null;
        let currentThemeId = null;
        let selectedAnswers = {};
        let pdfDoc = null;
        let currentPage = 1;
        let totalPages = 0;
        let ytPlayer = null;
        let progressTimer = null;
        let currentModuleIndex = null;
        let moduleIndexMapping = new Map();
        const completionStatus = {};
        let currentVideoId = null;
        let assessmentResults = {};

        function loadProgression() {
            const savedCompletion = localStorage.getItem('completionStatus');
            const savedAssessments = localStorage.getItem('assessmentResults');
            if (savedCompletion) Object.assign(completionStatus, JSON.parse(savedCompletion));
            if (savedAssessments) Object.assign(assessmentResults, JSON.parse(savedAssessments));
            loadRemoteProgression();
        }

        function saveProgression() {
            localStorage.setItem('completionStatus', JSON.stringify(completionStatus));
            localStorage.setItem('assessmentResults', JSON.stringify(assessmentResults));
            syncCourseProgressToCloud();
        }

        // Progressão do curso (% de módulos assistidos) associada à conta do
        // aluno logado, exceto em Estágios (fluxo sem conta, nome livre).
        // Grava em uniadmin/progress/byUser — irmão de results/byUser/byCourse
        // (mesmo padrão de fan-out), assim aparece tanto no Perfil quanto em
        // Configurações > Usuários mesmo trocando de navegador/dispositivo.
        function isProgressSyncEligible() {
            return currentCategory !== 'Estágios' && !!window.UniAdmin?.StudentAuth?.getSession();
        }

        function progressPathFor(userId) {
            const U = window.UniAdmin;
            return `/${U.dbRoot}/progress/byUser/${userId}/${currentCategorySlug}`;
        }

        // Sincroniza só o curso atualmente aberto (o que acabou de mudar) —
        // evita reescrever a árvore inteira a cada módulo concluído.
        function syncCourseProgressToCloud() {
            if (!isProgressSyncEligible() || !currentTrainingId || !currentThemeId) return;
            const U = window.UniAdmin;
            const session = U.StudentAuth.getSession();
            const theme = trainingData[currentTrainingId]?.themes?.[currentThemeId];
            if (!theme) return;
            const { total, done, pct } = courseProgress(currentTrainingId, theme);
            const approved = assessmentResults[currentTrainingId]?.[currentThemeId];
            const record = {
                total, done, pct,
                approved: approved !== undefined ? approved : null,
                updatedAt: Date.now()
            };
            const path = `${progressPathFor(session.userId)}/${currentTrainingId}/${currentThemeId}`;
            U.ref(U.db, path).set(record).catch(error => {
                console.error('Erro ao sincronizar progressão do curso:', error);
            });
        }

        // Ao logar (ou recarregar já logado), sincroniza completionStatus/
        // assessmentResults locais com a progressão gravada na nuvem — cobre
        // tanto continuar o curso em outro navegador/dispositivo quanto um
        // reset feito pelo admin (Configurações > Dashboard > Resetar curso),
        // que apaga o registro em progress/byUser e precisa "puxar" o card do
        // aluno de volta para 0%/sem nota, não só somar progresso.
        function loadRemoteProgression() {
            if (!isProgressSyncEligible()) return;
            const U = window.UniAdmin;
            const session = U.StudentAuth.getSession();
            U.get(U.ref(U.db, progressPathFor(session.userId))).then(snapshot => {
                const remote = snapshot.exists() ? (snapshot.val() || {}) : {};
                let changed = false;

                Object.keys(trainingData).forEach(subjectId => {
                    Object.keys(trainingData[subjectId]?.themes || {}).forEach(themeId => {
                        const theme = trainingData[subjectId].themes[themeId];
                        const entry = remote[subjectId]?.[themeId];
                        const localDone = (completionStatus[subjectId]?.[themeId] || []).filter(Boolean).length;
                        const remoteDone = entry?.done || 0;

                        // Reconstrói o array de booleans do tamanho certo sempre que a
                        // progressão remota diverge da local (para mais OU para menos).
                        if (remoteDone !== localDone) {
                            if (!completionStatus[subjectId]) completionStatus[subjectId] = {};
                            const arr = new Array((theme.modules || []).length).fill(false);
                            for (let i = 0; i < Math.min(remoteDone, arr.length); i++) arr[i] = true;
                            completionStatus[subjectId][themeId] = arr;
                            changed = true;
                        }

                        const remoteApproved = (entry?.approved !== undefined && entry?.approved !== null) ? entry.approved : undefined;
                        const localApproved = assessmentResults[subjectId]?.[themeId];
                        if (remoteApproved !== localApproved) {
                            if (remoteApproved !== undefined) {
                                if (!assessmentResults[subjectId]) assessmentResults[subjectId] = {};
                                assessmentResults[subjectId][themeId] = remoteApproved;
                            } else if (assessmentResults[subjectId]) {
                                delete assessmentResults[subjectId][themeId];
                                if (Object.keys(assessmentResults[subjectId]).length === 0) delete assessmentResults[subjectId];
                            }
                            changed = true;
                        }
                    });
                });

                if (changed) {
                    localStorage.setItem('completionStatus', JSON.stringify(completionStatus));
                    localStorage.setItem('assessmentResults', JSON.stringify(assessmentResults));
                    if (currentTrainingId && courseGallery.style.display === 'block') showCourseGallery(currentTrainingId);
                }
            }).catch(error => console.error('Erro ao carregar progressão da nuvem:', error));
        }

        // Login feito depois da página já carregada (modal de avaliação): traz
        // a progressão da nuvem e atualiza os cards com o % correto.
        document.addEventListener('uniadmin:session-updated', () => loadRemoteProgression());

        function resetCourseProgression() {
            if (currentTrainingId && currentThemeId) {
                if (completionStatus[currentTrainingId]) {
                    delete completionStatus[currentTrainingId][currentThemeId];
                    if (Object.keys(completionStatus[currentTrainingId]).length === 0) {
                        delete completionStatus[currentTrainingId];
                    }
                }
                if (assessmentResults[currentTrainingId]) {
                    delete assessmentResults[currentTrainingId][currentThemeId];
                    if (Object.keys(assessmentResults[currentTrainingId]).length === 0) {
                        delete assessmentResults[currentTrainingId];
                    }
                }
                saveProgression();
                loadTraining(currentTrainingId, currentThemeId);
                showWarning('Progressão do curso reiniciada com sucesso.');
            }
        }

        function loadYouTubeAPI() {
            return new Promise((resolve) => {
                if (window.YT && window.YT.Player) { resolve(); return; }
                const tag = document.createElement('script');
                tag.src = 'https://www.youtube.com/iframe_api';
                const firstScriptTag = document.getElementsByTagName('script')[0];
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
                window.onYouTubeIframeAPIReady = () => resolve();
            });
        }

        function formatTime(seconds) {
            seconds = Math.max(0, Math.floor(seconds || 0));
            const m = Math.floor(seconds / 60).toString().padStart(2, '0');
            const s = (seconds % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }

        function initOrLoadVideo(videoId) {
            loadYouTubeAPI().then(() => {
                customPlayerContainer.style.display = 'block';
                video.style.display = 'none';
                currentVideoId = videoId;
                if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
                ytPlayer = new YT.Player('yt-frame', {
                    height: '390',
                    width: '640',
                    videoId: videoId,
                    playerVars: { controls: 0, modestbranding: 1, rel: 0, fs: 1, iv_load_policy: 3 },
                    events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
                });
            });
        }

        function onPlayerReady() {
            bindControls();
            updateTimeUI();
            const ytInnerIframe = document.querySelector('#yt-frame iframe');
            if (ytInnerIframe) {
                ytInnerIframe.setAttribute('allowfullscreen', '');
                const currentAllow = ytInnerIframe.getAttribute('allow') || '';
                if (!/fullscreen/i.test(currentAllow)) {
                    ytInnerIframe.setAttribute('allow', (currentAllow + '; fullscreen; autoplay').replace(/^;\s*/, ''));
                }
            }
        }

        function onPlayerStateChange(event) {
            const YT_STATE = window.YT.PlayerState;
            if (event.data === YT_STATE.PLAYING) {
                playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                startProgressTimer();
            } else if (event.data === YT_STATE.PAUSED || event.data === YT_STATE.ENDED) {
                playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                stopProgressTimer();
                if (event.data === YT_STATE.ENDED) {
                    progressRange.value = 100;
                    updateTimeUI();
                    markCurrentModuleCompleted();
                }
            }
        }

        function markCurrentModuleCompleted() {
            if (currentTrainingId && currentThemeId != null && currentModuleIndex != null) {
                const theme = trainingData[currentTrainingId].themes[currentThemeId];
                if (!theme) return;
                if (!completionStatus[currentTrainingId]) completionStatus[currentTrainingId] = {};
                if (!completionStatus[currentTrainingId][currentThemeId]) completionStatus[currentTrainingId][currentThemeId] = [];
                const originalIndex = moduleIndexMapping.has(currentModuleIndex) ? moduleIndexMapping.get(currentModuleIndex) : currentModuleIndex;
                if (!completionStatus[currentTrainingId][currentThemeId][originalIndex]) {
                    completionStatus[currentTrainingId][currentThemeId][originalIndex] = true;
                    saveProgression();
                    const moduleTiles = modulesDiv.querySelectorAll('.module');
                    const tile = moduleTiles[currentModuleIndex];
                    if (tile) {
                        const modules = theme.modules;
                        let moduleTitle = '';
                        if (moduleIndexMapping.has(currentModuleIndex)) {
                            const origIdx = moduleIndexMapping.get(currentModuleIndex);
                            moduleTitle = modules[origIdx]?.title || '';
                        } else {
                            moduleTitle = modules[currentModuleIndex]?.title || '';
                        }
                        tile.innerHTML = renderModuleTitle(moduleTitle, true);
                        tile.classList.add('completed');
                        tile.classList.remove('active');
                    }
                }
            }
        }

        function bindControls() {
            playPauseBtn.onclick = () => {
                if (!ytPlayer) return;
                const state = ytPlayer.getPlayerState();
                const YT_STATE = window.YT.PlayerState;
                if (state !== YT_STATE.PLAYING) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
            };
            muteBtn.onclick = () => {
                if (!ytPlayer) return;
                if (ytPlayer.isMuted()) { ytPlayer.unMute(); muteBtn.innerHTML = '<i class="fas fa-volume-high"></i>'; }
                else { ytPlayer.mute(); muteBtn.innerHTML = '<i class="fas fa-volume-xmark"></i>'; }
            };
            volumeRange.oninput = () => {
                if (!ytPlayer) return;
                ytPlayer.setVolume(parseInt(volumeRange.value, 10));
                if (ytPlayer.isMuted() && parseInt(volumeRange.value, 10) > 0) {
                    ytPlayer.unMute();
                    muteBtn.innerHTML = '<i class="fas fa-volume-high"></i>';
                }
            };
            progressRange.oninput = () => {
                if (!ytPlayer) return;
                const duration = ytPlayer.getDuration() || 0;
                const seekTo = (parseFloat(progressRange.value) / 100) * duration;
                ytPlayer.seekTo(seekTo, true);
                updateTimeUI();
            };
            speedSelect.onchange = () => {
                if (!ytPlayer) return;
                ytPlayer.setPlaybackRate(parseFloat(speedSelect.value));
            };
            const fullscreenBtn = document.getElementById('fullscreen-btn');
            if (fullscreenBtn) {
                fullscreenBtn.onclick = () => {
                    const container = document.getElementById('custom-player');
                    if (!container.classList.contains('is-fullscreen')) {
                        container.classList.add('is-fullscreen');
                        const req = container.requestFullscreen || container.webkitRequestFullscreen;
                        if (req) req.call(container).catch(() => {});
                        fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i>';
                    } else {
                        container.classList.remove('is-fullscreen');
                        const exit = document.exitFullscreen || document.webkitExitFullscreen;
                        if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
                            try { exit.call(document); } catch(e) {}
                        }
                        fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i>';
                    }
                };
                const onFsChange = () => {
                    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                        document.getElementById('custom-player').classList.remove('is-fullscreen');
                        const fsBtn = document.getElementById('fullscreen-btn');
                        if (fsBtn) fsBtn.innerHTML = '<i class="fas fa-expand"></i>';
                    }
                };
                document.addEventListener('fullscreenchange', onFsChange);
                document.addEventListener('webkitfullscreenchange', onFsChange);
            }
        }

        function startProgressTimer() {
            stopProgressTimer();
            progressTimer = setInterval(() => {
                if (!ytPlayer) return;
                const current = ytPlayer.getCurrentTime() || 0;
                const duration = ytPlayer.getDuration() || 0;
                if (duration > 0) progressRange.value = (current / duration) * 100;
                updateTimeUI();
            }, 250);
        }

        function stopProgressTimer() {
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        }

        function updateTimeUI() {
            if (!ytPlayer) { timeLabels.textContent = '00:00 / 00:00'; return; }
            const current = ytPlayer.getCurrentTime() || 0;
            const duration = ytPlayer.getDuration() || 0;
            timeLabels.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
        }

        function applyCategoryToHeader() {
            const label = document.getElementById('header-category-label');
            const badge = document.getElementById('header-category-badge');
            if (label) label.textContent = 'Plataforma de ' + currentCategory;
            if (badge) badge.textContent = currentCategory;
            document.title = `Universidade LAMIC - ${currentCategory}`;
        }

        window.onload = () => {
            applyCategoryToHeader();
            warningMessage.style.display = 'none';
            resetContent();
            document.getElementById('loading-overlay').style.display = 'flex';
            fetchFirebaseData();
            fetchNames();
            courseGallery.style.display = 'none';
            courseGrid.innerHTML = '';
            themeBtn.textContent = 'Escolha um Assunto';
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';

            const commentToggleBtn = document.getElementById('comment-toggle-btn');
            const commentSection = document.getElementById('comment-section');
            if (commentToggleBtn) {
                commentToggleBtn.onclick = () => {
                    const isVisible = commentSection.style.display === 'block';
                    commentSection.style.display = isVisible ? 'none' : 'block';
                    commentToggleBtn.innerHTML = isVisible
                        ? '<i class="fas fa-comment-alt" style="margin-right:6px;"></i>Deixe um Comentário'
                        : '<i class="fas fa-times" style="margin-right:6px;"></i>Fechar Comentário';
                };
            }
        };

        function populateDropdown() {
            dropdownList.innerHTML = '';
            const subjects = Object.keys(trainingData)
                .filter(id => trainingData[id] && trainingData[id].name && trainingData[id].name.trim() !== '')
                .map(id => ({ id, ...trainingData[id] }));
            const sortedSubjects = sortItems(subjects, orderData.subjects, 'id');
            sortedSubjects.forEach(({item: subject}) => {
                const courseCount = Object.keys(subject.themes || {})
                    .filter(id => subject.themes[id] && subject.themes[id].name)
                    .filter(id => subject.themes[id].active !== false)
                    .filter(id => themeVisibleForSession(subject.themes[id])).length;
                if (courseCount === 0) return;

                const subjectLi = document.createElement('li');
                subjectLi.className = 'subject';
                subjectLi.dataset.subjectId = subject.id;
                subjectLi.setAttribute('role', 'option');
                if (subject.id === currentTrainingId) subjectLi.classList.add('is-selected');

                const icon = document.createElement('span');
                icon.className = 'subject-icon';
                icon.style.setProperty('--subject-hue', initialsHue(subject.name));
                icon.innerHTML = '<i class="fas fa-bookmark"></i>';

                const name = document.createElement('span');
                name.className = 'subject-name';
                name.textContent = subject.name;

                const count = document.createElement('span');
                count.className = 'subject-count';
                count.textContent = courseCount;
                count.title = courseCount === 1 ? '1 curso' : `${courseCount} cursos`;

                const check = document.createElement('i');
                check.className = 'fas fa-check subject-check';

                subjectLi.append(icon, name, count, check);
                subjectLi.onclick = (e) => {
                    e.stopPropagation();
                    setSubjectLabel(subject.name);
                    closeSubjectDropdown();
                    currentTrainingId = subject.id;
                    dropdownList.querySelectorAll('li.subject').forEach(li => {
                        li.classList.toggle('is-selected', li.dataset.subjectId === subject.id);
                    });
                    themeBtn.textContent = 'Escolha um Assunto';
                    contentDiv.style.display = 'none';
                    resetContent();
                    showCourseGallery(subject.id);
                };
                dropdownList.appendChild(subjectLi);
            });
        }

        // O rótulo do botão vive num span próprio; o ícone e a seta ficam fixos.
        function setSubjectLabel(text) {
            const label = btn.querySelector('.dropdown-btn-label');
            if (label) label.textContent = text;
            else btn.textContent = text;
        }

        function getSubjectLabel() {
            const label = btn.querySelector('.dropdown-btn-label');
            return label ? label.textContent : btn.textContent;
        }

        function openSubjectDropdown() {
            dropdownContent.style.display = 'block';
            btn.setAttribute('aria-expanded', 'true');
        }

        function closeSubjectDropdown() {
            dropdownContent.style.display = 'none';
            btn.setAttribute('aria-expanded', 'false');
        }

        /* ─── GALERIA DE CURSOS (cards) ─── */

        // Visibilidade por função (cargo). O assunto sem `roles` aparece para
        // todos; com `roles`, só para quem está logado com uma dessas funções
        // (a função vem da conta, sincronizada da planilha via Colaboradores).
        // Gestor (isManager na conta) ignora essa restrição e vê tudo.
        function themeVisibleForSession(theme) {
            const roles = Array.isArray(theme?.roles) ? theme.roles.filter(Boolean) : [];
            if (roles.length === 0) return true;
            const session = window.UniAdmin?.StudentAuth?.getSession();
            if (session?.isManager) return true;
            const role = (session?.role || '').trim();
            if (!role) return false;
            const key = window.UniAdmin.normalizeName(role);
            return roles.some(r => window.UniAdmin.normalizeName(r) === key);
        }

        // Lista de assuntos do tema, já na ordem definida no painel.
        function getSortedThemes(subjectId) {
            const themes = trainingData[subjectId]?.themes || {};
            const themeArray = Object.keys(themes)
                .filter(id => themes[id] && themes[id].name && themes[id].name.trim() !== '')
                .filter(id => themes[id].active !== false)
                .filter(id => themeVisibleForSession(themes[id]))
                .map(id => ({ id, ...themes[id] }));
            return sortItems(themeArray, orderData.themes?.[subjectId], 'id').map(({ item }) => item);
        }

        function courseInitials(name) {
            const clean = (name || '').trim();
            if (!clean) return '?';
            const words = clean.split(/\s+/).filter(w => /[a-zA-ZÀ-ÿ0-9]/.test(w));
            if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
            return clean.slice(0, 2).toUpperCase();
        }

        // Cor estável derivada do nome: cursos sem imagem ficam distinguíveis entre si.
        function initialsHue(name) {
            let hash = 0;
            for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
            return hash;
        }

        function courseProgress(subjectId, theme) {
            const total = (theme.modules || []).length;
            const done = (completionStatus[subjectId]?.[theme.id] || []).filter(Boolean).length;
            const approved = assessmentResults[subjectId]?.[theme.id];
            const pct = total === 0 ? 0 : Math.round((Math.min(done, total) / total) * 100);
            return { total, done: Math.min(done, total), pct, approved };
        }

        function buildCourseCard(subjectId, theme) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'course-card';
            card.dataset.themeId = theme.id;
            card.dataset.search = (theme.name + ' ' + (theme.description || '')).toLowerCase();

            const { total, done, pct, approved } = courseProgress(subjectId, theme);

            const thumb = document.createElement('div');
            thumb.className = 'course-thumb';
            const imageSrc = window.UniAdminImages
                ? window.UniAdminImages.resolve(currentCategorySlug, subjectId, theme.id, theme)
                : (theme.image || null);
            if (imageSrc) {
                const img = document.createElement('img');
                img.src = imageSrc;
                img.alt = theme.name;
                img.width = 128; img.height = 128;
                img.loading = 'lazy';
                img.decoding = 'async';
                // Imagem quebrada no banco: cai nas iniciais em vez de deixar o card vazio.
                img.onerror = () => { thumb.innerHTML = ''; thumb.appendChild(buildInitials(theme.name)); };
                thumb.appendChild(img);
            } else {
                thumb.appendChild(buildInitials(theme.name));
            }
            if (approved !== undefined) {
                const badge = document.createElement('span');
                badge.className = 'course-badge-done';
                badge.innerHTML = '<i class="fas fa-circle-check"></i>';
                badge.title = `Aprovado com nota ${formatScore(approved)}`;
                thumb.appendChild(badge);
            }

            const body = document.createElement('div');
            body.className = 'course-body';

            const h3 = document.createElement('h3');
            h3.textContent = theme.name;
            body.appendChild(h3);

            const desc = document.createElement('p');
            desc.className = 'course-desc';
            desc.textContent = theme.description || 'Sem descrição cadastrada para este curso.';
            if (!theme.description) desc.classList.add('is-empty');
            body.appendChild(desc);

            const meta = document.createElement('div');
            meta.className = 'course-meta';
            meta.innerHTML = `
                <span><i class="fas fa-play-circle"></i> ${total} ${total === 1 ? 'módulo' : 'módulos'}</span>
                <span><i class="fas fa-clipboard-list"></i> ${quizData[`${subjectId}_${theme.id}`]?.length || 0} questões</span>`;
            body.appendChild(meta);

            const certTag = document.createElement('div');
            certTag.className = theme.certificateEnabled ? 'course-cert-tag has-cert' : 'course-cert-tag no-cert';
            certTag.innerHTML = theme.certificateEnabled
                ? '<i class="fas fa-award"></i> Emite certificado'
                : '<i class="fas fa-ban"></i> Não emite certificado';
            body.appendChild(certTag);

            const progress = document.createElement('div');
            progress.className = 'course-progress';
            progress.innerHTML = `
                <div class="course-progress-bar"><span style="width:${pct}%"></span></div>
                <div class="course-progress-label">${done}/${total} concluídos${approved !== undefined ? ` &bull; nota ${formatScore(approved)}` : ''}</div>`;
            if (pct === 100) progress.classList.add('is-complete');
            body.appendChild(progress);

            card.appendChild(thumb);
            card.appendChild(body);
            card.onclick = () => openCourse(subjectId, theme.id, theme.name);
            return card;
        }

        // O atalho de volta (e a seta que o antecede) só faz sentido com um curso aberto.
        function setBackToCoursesVisible(visible) {
            backToCoursesBtn.style.display = visible ? 'inline-flex' : 'none';
            if (selectionDivider) selectionDivider.style.display = visible ? 'block' : 'none';
        }

        function buildInitials(name) {
            const span = document.createElement('span');
            span.className = 'course-initials';
            span.textContent = courseInitials(name);
            span.style.setProperty('--initials-hue', initialsHue(name));
            return span;
        }

        function showCourseGallery(subjectId) {
            currentTrainingId = subjectId;
            currentThemeId = null;
            courseGrid.innerHTML = '';
            const themes = getSortedThemes(subjectId);
            themes.forEach(theme => courseGrid.appendChild(buildCourseCard(subjectId, theme)));

            galleryTitle.textContent = trainingData[subjectId]?.name || 'Cursos disponíveis';
            gallerySub.textContent = themes.length === 1
                ? '1 curso disponível — clique no card para começar'
                : `${themes.length} cursos disponíveis — clique no card para começar`;
            galleryEmpty.style.display = themes.length ? 'none' : 'flex';
            if (galleryFilter) galleryFilter.value = '';

            document.getElementById('welcome-screen').style.display = 'none';
            contentDiv.style.display = 'none';
            courseGallery.style.display = 'block';
            setBackToCoursesVisible(false);
            themeBtn.textContent = 'Escolha um Assunto';
        }

        function openCourse(subjectId, themeId, themeName) {
            themeBtn.textContent = themeName;
            courseGallery.style.display = 'none';
            setBackToCoursesVisible(true);
            loadTraining(subjectId, themeId);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        if (backToCoursesBtn) {
            backToCoursesBtn.onclick = () => {
                if (!currentTrainingId) return;
                if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
                resetContent();
                showCourseGallery(currentTrainingId);
            };
        }

        // Login/logout ou mudança de função na planilha: a lista de cursos
        // visíveis muda, então dropdown e galeria são remontados.
        document.addEventListener('uniadmin:session-updated', () => {
            populateDropdown();
            if (currentTrainingId && courseGallery.style.display === 'block') {
                showCourseGallery(currentTrainingId);
            }
        });

        if (galleryFilter) {
            galleryFilter.addEventListener('input', () => {
                const term = galleryFilter.value.trim().toLowerCase();
                let visible = 0;
                courseGrid.querySelectorAll('.course-card').forEach(card => {
                    const match = !term || card.dataset.search.includes(term);
                    card.style.display = match ? '' : 'none';
                    if (match) visible++;
                });
                galleryEmpty.style.display = visible ? 'none' : 'flex';
            });
        }

        function validateEmail(email) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        }

        document.getElementById('email').addEventListener('input', function() {
            if (!validateEmail(this.value)) this.classList.add('invalid');
            else this.classList.remove('invalid');
        });

        function showWarning(message) {
            warningText.textContent = message;
            warningMessage.style.display = 'flex';
            setTimeout(() => { warningMessage.style.display = 'none'; }, 3000);
        }

        // Modal de confirmação para avaliação <= 4 estrelas sem comentário.
        // Não bloqueia o envio — apenas confirma que o aluno quer publicar
        // sem explicar o motivo da nota baixa.
        function openLowRatingModal({ onBack, onConfirm }) {
            const modal = document.getElementById('low-rating-modal');
            const backBtn = document.getElementById('low-rating-back-btn');
            const confirmBtn = document.getElementById('low-rating-confirm-btn');

            const close = () => { modal.classList.remove('active'); cleanup(); };
            const handleBack = () => { close(); onBack?.(); };
            const handleConfirm = () => { close(); onConfirm?.(); };
            const handleOverlayClick = (e) => { if (e.target === modal) handleBack(); };

            function cleanup() {
                backBtn.removeEventListener('click', handleBack);
                confirmBtn.removeEventListener('click', handleConfirm);
                modal.removeEventListener('click', handleOverlayClick);
            }

            backBtn.addEventListener('click', handleBack);
            confirmBtn.addEventListener('click', handleConfirm);
            modal.addEventListener('click', handleOverlayClick);

            modal.classList.add('active');
        }

        function renderPage(pageNum) {
            pdfDoc.getPage(pageNum).then(page => {
                const viewport = page.getViewport({ scale: 1.5 });
                pdfCanvas.height = viewport.height;
                pdfCanvas.width = viewport.width;
                const context = pdfCanvas.getContext('2d');
                page.render({ canvasContext: context, viewport: viewport });
                currentPage = pageNum;
                renderPagination();
                if (currentPage === totalPages) markCurrentModuleCompleted();
            });
        }

        function renderPagination() {
            pdfNavigation.innerHTML = '';
            const maxButtons = 3;
            let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
            let endPage = Math.min(totalPages, startPage + maxButtons - 1);
            if (endPage - startPage + 1 < maxButtons) startPage = Math.max(1, endPage - maxButtons + 1);

            const firstBtn = document.createElement('button');
            firstBtn.innerHTML = '<i class="fas fa-fast-backward"></i>';
            firstBtn.disabled = currentPage === 1;
            firstBtn.onclick = () => { if (currentPage !== 1) renderPage(1); };
            pdfNavigation.appendChild(firstBtn);

            for (let i = startPage; i <= endPage; i++) {
                const b = document.createElement('button');
                b.textContent = i;
                b.className = i === currentPage ? 'active' : '';
                b.onclick = () => renderPage(i);
                pdfNavigation.appendChild(b);
            }

            const lastBtn = document.createElement('button');
            lastBtn.innerHTML = '<i class="fas fa-fast-forward"></i>';
            let originalIndexForPDF = currentModuleIndex;
            if (currentTrainingId && currentThemeId != null && currentModuleIndex != null) {
                originalIndexForPDF = moduleIndexMapping.has(currentModuleIndex) ? moduleIndexMapping.get(currentModuleIndex) : currentModuleIndex;
            }
            lastBtn.disabled = currentPage === totalPages ||
                (currentTrainingId && currentThemeId != null && currentModuleIndex != null &&
                !completionStatus[currentTrainingId]?.[currentThemeId]?.[originalIndexForPDF]);
            lastBtn.onclick = () => {
                if (currentPage !== totalPages) {
                    if (currentTrainingId && currentThemeId != null && currentModuleIndex != null) {
                        const origIdx = moduleIndexMapping.has(currentModuleIndex) ? moduleIndexMapping.get(currentModuleIndex) : currentModuleIndex;
                        if (!completionStatus[currentTrainingId]?.[currentThemeId]?.[origIdx]) {
                            showWarning('Visualize todas as páginas antes de usar este atalho.');
                            return;
                        }
                    }
                    renderPage(totalPages);
                }
            };
            pdfNavigation.appendChild(lastBtn);
        }

        function loadPDF(pdfPath) {
            const baseUrl = 'https://dl.dropboxusercontent.com/s/';
            const fullUrl = `${baseUrl}${pdfPath}`;
            fetch(fullUrl, { method: 'HEAD' })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return pdfjsLib.getDocument(fullUrl).promise;
                })
                .then(doc => {
                    pdfDoc = doc;
                    totalPages = doc.numPages;
                    currentPage = 1;
                    renderPage(currentPage);
                })
                .catch(error => {
                    console.error('Erro ao carregar PDF:', error);
                    showWarning('Não foi possível carregar o PDF.');
                });
        }

        btn.onclick = (e) => {
            e.stopPropagation();
            if (dropdownContent.style.display === 'block') closeSubjectDropdown();
            else openSubjectDropdown();
        };

        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !dropdownContent.contains(e.target)) closeSubjectDropdown();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dropdownContent.style.display === 'block') {
                closeSubjectDropdown();
                btn.focus();
            }
        });

        function loadTraining(subjectId, themeId) {
            if (!subjectId || !themeId) return;
            currentTrainingId = subjectId;
            currentThemeId = themeId;
            const theme = trainingData[subjectId].themes[themeId];
            if (!theme || !theme.modules || theme.modules.length === 0) return;

            document.getElementById('welcome-screen').style.display = 'none';
            courseGallery.style.display = 'none';
            setBackToCoursesVisible(true);
            contentDiv.style.display = 'block';

            const sidebarName = document.getElementById('sidebar-course-name');
            if (sidebarName) sidebarName.textContent = themeBtn.textContent;

            if (!completionStatus[subjectId]) completionStatus[subjectId] = {};
            if (!completionStatus[subjectId][themeId] || completionStatus[subjectId][themeId].length !== theme.modules.length) {
                completionStatus[subjectId][themeId] = new Array(theme.modules.length).fill(false);
                saveProgression();
            }

            const modulesWithIndex = theme.modules.map((mod, idx) => ({ mod, idx }));
            const sortedModules = sortItems(modulesWithIndex, orderData.modules?.[subjectId]?.[themeId], 'idx');
            const modules = sortedModules.map(({item}) => item.mod);
            moduleIndexMapping.clear();
            sortedModules.forEach(({item}, newIndex) => { moduleIndexMapping.set(newIndex, item.idx); });

            loadModule(modules[0], modules, 0);
            modulesDiv.innerHTML = '';

            modules.forEach((mod, displayIndex) => {
                const originalIndex = moduleIndexMapping.get(displayIndex);
                const div = document.createElement('div');
                div.className = 'module';
                div.innerHTML = renderModuleTitle(mod.title, completionStatus[subjectId][themeId][originalIndex]);
                if (completionStatus[subjectId][themeId][originalIndex]) div.classList.add('completed');
                div.onclick = () => {
                    document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
                    div.classList.add('active');
                    loadModule(mod, modules, displayIndex);
                };
                if (displayIndex === 0) div.classList.add('active');
                modulesDiv.appendChild(div);
            });

            const assessmentDiv = document.createElement('div');
            assessmentDiv.className = 'module';
            assessmentDiv.id = 'assessment-module';
            assessmentDiv.innerHTML = renderAssessmentTitle(assessmentResults[subjectId]?.[themeId] !== undefined);
            if (assessmentResults[subjectId] && assessmentResults[subjectId][themeId]) assessmentDiv.classList.add('completed');

            assessmentDiv.onclick = () => {
                document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
                assessmentDiv.classList.add('active');
                if (assessmentResults[subjectId] && assessmentResults[subjectId][themeId]) {
                    showAssessmentResult(assessmentResults[subjectId][themeId]);
                    return;
                }
                const allDone = completionStatus[subjectId][themeId].every(Boolean);
                if (!allDone) { showWarning('Conclua todos os módulos antes da avaliação.'); return; }

                // Prazo encerrado bloqueia a avaliação; o conteúdo continua
                // acessível normalmente (só este clique é barrado).
                const theme = trainingData[subjectId]?.themes?.[themeId];
                if (window.UniAdmin?.Deadlines?.isAssessmentBlocked(theme?.deadline)) {
                    showWarning('O prazo deste curso foi encerrado. Fale com o administrador.');
                    return;
                }

                // Login obrigatório para realizar a avaliação, exceto em Estágios
                // (mantém o fluxo de nome digitado livremente, sem conta).
                if (currentCategory !== 'Estágios' && !window.UniAdmin?.StudentAuth?.getSession()) {
                    window.UniAdmin.StudentAuth.openModal({
                        intent: 'assessment',
                        onSuccess: () => openQuiz(subjectId, themeId)
                    });
                    return;
                }
                openQuiz(subjectId, themeId);
            };
            modulesDiv.appendChild(assessmentDiv);
        }

        function openQuiz(subjectId, themeId) {
            if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            customPlayerContainer.style.display = 'none';
            video.style.display = 'none';
            video.src = '';
            pdfContainer.style.display = 'none';
            document.body.classList.remove('cinema-active');
            loadQuiz(subjectId, themeId);
        }

        function renderAssessmentTitle(completed) {
            return completed
                ? '<i class="fas fa-clipboard-check" style="color:var(--success);margin-right:8px;"></i>Avaliação <i class="fas fa-circle-check status-icon" aria-hidden="true"></i>'
                : '<i class="fas fa-clipboard-list" style="color:#92400e;margin-right:8px;"></i>Avaliação Final';
        }

        function renderModuleTitle(title, completed) {
            return completed
                ? `${title} <i class="fas fa-circle-check status-icon" aria-hidden="true"></i>`
                : title;
        }

        function loadModule(mod, modules, moduleIndex) {
            resetContent();
            currentModuleIndex = moduleIndex;
            if (mod.pdfUrl) {
                if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
                pdfContainer.style.display = 'block';
                video.style.display = 'none';
                customPlayerContainer.style.display = 'none';
                loadPDF(mod.pdfUrl);
            } else {
                initOrLoadVideo(mod.videoId);
                customPlayerContainer.style.display = 'block';
                video.style.display = 'none';
                pdfContainer.style.display = 'none';
            }
            titleEl.textContent = mod.title;
            captionEl.textContent = mod.caption;
            titleEl.style.display = 'block';
            captionEl.style.display = 'block';

            attachmentContainer.innerHTML = '';
            if (mod.attachments && mod.attachments.length > 0) {
                mod.attachments.forEach(attachment => {
                    const b = document.createElement('button');
                    b.className = 'attachment-btn';
                    b.textContent = attachment.title;
                    b.onclick = () => window.open(attachment.url, '_blank');
                    attachmentContainer.appendChild(b);
                });
                attachmentContainer.style.display = 'flex';
            } else {
                attachmentContainer.style.display = 'none';
            }
        }

        function loadQuiz(subjectId, themeId) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            resetContent();
            const quizKey = `${subjectId}_${themeId}`;
            if (quizStatus[quizKey] === false) { showWarning('Avaliação indisponível no momento.'); return; }
            const questions = quizData[quizKey];
            if (!questions) { showWarning('Nenhuma avaliação disponível para este tema.'); return; }

            quizContainer.innerHTML = '';
            selectedAnswers = {};

            const header = document.createElement('div');
            header.className = 'quiz-header-section';
            header.innerHTML = `<h2><i class="fas fa-clipboard-list" style="margin-right:10px;"></i>Avaliação Final</h2><p>${questions.length} questões &bull; Mínimo 8,0 para aprovação</p>`;
            quizContainer.appendChild(header);

            questions.forEach((q, index) => {
                const card = document.createElement('div');
                card.className = 'quiz-card';
                card.id = `quiz-card-${index}`;
                const h3 = document.createElement('h3');
                h3.textContent = `${index + 1}. ${q.question}`;
                card.appendChild(h3);
                if (q.image) {
                    const img = document.createElement('img');
                    img.className = 'quiz-card-image';
                    img.src = q.image;
                    img.alt = 'Imagem da questão';
                    img.loading = 'lazy';
                    card.appendChild(img);
                }
                const order = Array.from({ length: q.options.length }, (_, i) => i);
                for (let i = order.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [order[i], order[j]] = [order[j], order[i]];
                }
                order.forEach((optIndex) => {
                    const opt = q.options[optIndex];
                    const label = document.createElement('label');
                    label.className = 'quiz-option';
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = `q${index}`;
                    input.value = optIndex;
                    input.onchange = () => {
                        selectedAnswers[index] = parseInt(input.value, 10);
                        card.querySelectorAll('.quiz-option').forEach(o => o.classList.remove('selected'));
                        label.classList.add('selected');
                        card.classList.remove('missing');
                    };
                    label.appendChild(input);
                    label.appendChild(document.createTextNode(opt));
                    card.appendChild(label);
                });
                quizContainer.appendChild(card);
            });

            quizContainer.appendChild(quizSubmit);
            quizContainer.style.display = 'flex';
            quizSubmit.onclick = () => calculateScore(subjectId, themeId);
        }

        function calculateScore(subjectId, themeId) {
            const quizKey = `${subjectId}_${themeId}`;
            const questions = quizData[quizKey];
            let allAnswered = true;

            questions.forEach((q, index) => {
                if (!(index in selectedAnswers)) {
                    allAnswered = false;
                    const card = document.getElementById(`quiz-card-${index}`);
                    card.classList.add('missing');
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    document.getElementById(`quiz-card-${index}`).classList.remove('missing');
                }
            });

            if (!allAnswered) { showWarning('Por favor, responda todas as questões.'); return; }

            let correctCount = 0;
            questions.forEach((q, index) => { if (selectedAnswers[index] === q.correct) correctCount++; });
            const score = Math.round((correctCount / questions.length) * 100) / 10;
            const erros = getDetailedIncorrectAnswers(subjectId, themeId);
            const answerSnapshot = buildAnswerSnapshot(subjectId, themeId);
            showForm(score, erros, answerSnapshot);
        }

        // Snapshot completo do quiz respondido (todas as questões, com gabarito
        // e a opção escolhida) — usado pelo modal de detalhe do Histórico
        // (Configurações), que mostra certas/erradas com filtro.
        function buildAnswerSnapshot(subjectId, themeId) {
            const quizKey = `${subjectId}_${themeId}`;
            const questions = quizData[quizKey] || [];
            return questions.map((q, index) => ({
                question: q.question,
                options: q.options,
                correct: q.correct,
                selected: index in selectedAnswers ? selectedAnswers[index] : null
            }));
        }

        function getDetailedIncorrectAnswers(subjectId, themeId) {
            const quizKey = `${subjectId}_${themeId}`;
            const questions = quizData[quizKey];
            const errors = [];
            questions.forEach((q, index) => {
                if (selectedAnswers[index] !== q.correct) {
                    const userAnswer = q.options[selectedAnswers[index]] || '(não respondido)';
                    const correctAnswer = q.options[q.correct];
                    errors.push(
                        `${index + 1}) ${q.question}\n ` +
                        `;Resposta: ${userAnswer}\n` +
                        `;Gabarito: ${correctAnswer}\n` +
                        `---`
                    );
                }
            });
            return errors.length > 0 ? errors.join('\n') : '';
        }

        function getIncorrectQuestions(subjectId, themeId) {
            const quizKey = `${subjectId}_${themeId}`;
            const questions = quizData[quizKey];
            const incorrect = [];
            questions.forEach((q, index) => {
                if (selectedAnswers[index] !== q.correct) incorrect.push(q.question.trim());
            });
            return incorrect.length > 0 ? incorrect.join('\n') : '';
        }

        // Estágios usa o nome digitado livremente (select alimentado por fetchNames);
        // as demais categorias exigem sessão e mostram o nome já travado, sem input.
        function isFreeNameCategory() {
            return currentCategory === 'Estágios';
        }

        function showForm(score, erros = '', answerSnapshot = []) {
            resetContent();
            formContainer.style.display = 'flex';
            const submitButton = document.getElementById('submit-form');
            const loadingSpinner = document.getElementById('loading-spinner');
            const newSubmitButton = submitButton.cloneNode(true);
            submitButton.parentNode.replaceChild(newSubmitButton, submitButton);
            loadingSpinner.style.display = 'none';
            newSubmitButton.disabled = false;
            newSubmitButton.style.opacity = '1';

            const freeGroup = document.getElementById('form-name-free-group');
            const loggedGroup = document.getElementById('form-name-logged-group');
            if (isFreeNameCategory()) {
                freeGroup.style.display = 'block';
                loggedGroup.style.display = 'none';
            } else {
                freeGroup.style.display = 'none';
                loggedGroup.style.display = 'block';
                const session = window.UniAdmin?.StudentAuth?.getSession();
                document.getElementById('form-logged-user-name').textContent = session ? session.fullName : '—';
            }

            const ratingContainer = document.getElementById('rating-container');
            const commentToggleBtn = document.getElementById('comment-toggle-btn');
            const commentSection = document.getElementById('comment-section');
            ratingContainer.style.display = 'block';
            commentToggleBtn.style.display = 'inline-flex';
            commentSection.style.display = 'block';
            commentToggleBtn.innerHTML = '<i class="fas fa-times" style="margin-right:6px;"></i>Fechar Comentário';
            document.getElementById('comment').value = '';

            newSubmitButton.onclick = function(e) { e.preventDefault(); submitForm(score, erros, answerSnapshot); };
        }

        function submitForm(score, erros = '', answerSnapshot = [], skipLowRatingCheck = false) {
            const loadingSpinner = document.getElementById('loading-spinner');
            const submitButton = document.getElementById('submit-form');
            const ratingContainer = document.getElementById('rating-container');
            const commentSection = document.getElementById('comment-section');

            const freeName = isFreeNameCategory();
            const name = document.getElementById('name');
            const email = document.getElementById('email');
            const session = freeName ? null : window.UniAdmin?.StudentAuth?.getSession();

            if (freeName) {
                name.classList.remove('invalid');
                email.classList.remove('invalid');
                if (!name.value) {
                    name.classList.add('invalid');
                    name.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    showWarning('Por favor, selecione o Nome.');
                    return;
                }
                if (!email.value || !validateEmail(email.value)) {
                    email.classList.add('invalid');
                    email.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    showWarning('Por favor, insira um email válido.');
                    return;
                }
            } else if (!session) {
                // Sessão pode ter expirado/sido limpa entre abrir o quiz e enviar.
                showWarning('Sua sessão expirou. Faça login novamente.');
                window.UniAdmin.StudentAuth.openModal({ intent: 'assessment', onSuccess: () => submitForm(score, erros) });
                return;
            }

            const rating = document.querySelector('input[name="rating"]:checked');
            if (!rating) {
                showWarning('Por favor, avalie o curso com estrelas.');
                ratingContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            const commentField = document.getElementById('comment');
            const commentValue = commentField?.value.trim() || '';
            const ratingValue = parseInt(rating.value);
            if (ratingValue <= 4 && commentValue.length <= 3 && !skipLowRatingCheck) {
                openLowRatingModal({
                    onBack: () => {
                        commentSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        commentField.focus();
                    },
                    onConfirm: () => submitForm(score, erros, answerSnapshot, true)
                });
                return;
            }

            loadingSpinner.style.display = 'block';
            submitButton.disabled = true;
            submitButton.style.opacity = '0.6';

            // Grava o status calculado no momento da submissão (não recalcula
            // depois) — necessário para os indicadores de prazo do dashboard
            // ficarem estáveis mesmo que o prazo do curso mude posteriormente.
            const theme = trainingData[currentTrainingId]?.themes?.[currentThemeId];
            const deadlineStatus = window.UniAdmin?.Deadlines?.computeDeadlineStatus(theme?.deadline) || 'livre';

            const resultPayload = {
                score,
                approved: score >= 8,
                rating: ratingValue,
                comment: commentValue,
                errors: erros || '',
                answers: answerSnapshot || [],
                submittedAt: Date.now(),
                deadlineStatus
            };

            const finishSubmit = () => {
                loadingSpinner.style.display = 'none';
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
                showResult(score);
            };

            const saveResult = freeName
                ? saveEstagioResult({ name: name.value, email: email.value, ...resultPayload })
                : saveLoggedResult({ session, ...resultPayload });

            saveResult
                .then(finishSubmit)
                .catch((error) => {
                    console.error('Erro ao salvar resultado:', error);
                    showWarning('Não foi possível registrar sua avaliação. Tente novamente.');
                    loadingSpinner.style.display = 'none';
                    submitButton.disabled = false;
                    submitButton.style.opacity = '1';
                });
        }

        // Grava o resultado de um aluno logado nos dois caminhos de fan-out
        // (por usuário e por curso) numa única atualização atômica — ver
        // js/student-auth.js e o plano de dados em Configurações > Usuários.
        function saveLoggedResult({ session, ...result }) {
            const U = window.UniAdmin;
            const attemptCount = ((assessmentResults[currentTrainingId]?.[currentThemeId] !== undefined) ? 2 : 1);
            const record = { ...result, attempt: attemptCount };
            const basePath = `results/byUser/${session.userId}/${currentCategorySlug}/${currentTrainingId}/${currentThemeId}`;
            const mirrorPath = `results/byCourse/${currentCategorySlug}/${currentTrainingId}/${currentThemeId}/${session.userId}`;
            const updates = {};
            updates[`/${U.dbRoot}/${basePath}`] = record;
            updates[`/${U.dbRoot}/${mirrorPath}`] = record;
            return U.db.ref().update(updates);
        }

        // Estágios: sem conta, cada submissão vira um registro solto (nome
        // digitado livremente, pode haver homônimos — aceito para este fluxo).
        function saveEstagioResult({ name, email, ...result }) {
            const U = window.UniAdmin;
            const record = { name, email: email || null, ...result };
            const path = `/${U.dbRoot}/results/estagiosLivre/${currentCategorySlug}/${currentTrainingId}/${currentThemeId}`;
            const newRef = U.ref(U.db, path).push();
            return U.set(newRef, record);
        }

        // Certificado só aparece para aluno logado, aprovado e em curso com
        // emissão habilitada no cadastro do assunto (Configurações).
        function appendCertificateButton(score) {
            const U = window.UniAdmin;
            const session = U?.StudentAuth?.getSession();
            const theme = trainingData[currentTrainingId]?.themes?.[currentThemeId];
            if (!session || score < 8 || !U?.Certificate?.isEnabled(theme)) return;

            const btn = document.createElement('button');
            btn.className = 'certificate-download-btn';
            btn.innerHTML = '<i class="fas fa-award" style="margin-right:8px;"></i>Baixar certificado';
            btn.onclick = () => U.Certificate.download({
                studentName: session.fullName,
                course: theme,
                courseName: theme?.name,
                submittedAt: Date.now()
            });
            resultContainer.appendChild(btn);
        }

        function showResult(score) {
            resetContent();
            contentDiv.style.display = 'block';
            resultContainer.innerHTML = '';

            const scoreCard = document.createElement('div');
            scoreCard.className = 'result-score-card';
            const h2 = document.createElement('h2');
            h2.textContent = `${formatScore(score)}/10`;
            scoreCard.appendChild(h2);
            const scoreLabel = document.createElement('p');
            scoreLabel.textContent = score >= 8 ? 'Aprovado' : 'Reprovado';
            scoreLabel.style.color = score >= 8 ? 'var(--success)' : 'var(--danger)';
            scoreLabel.style.fontWeight = '600';
            scoreCard.appendChild(scoreLabel);
            resultContainer.appendChild(scoreCard);

            if (score < 8) {
                const p = document.createElement('p');
                p.textContent = 'Você não atingiu a nota mínima. Tente novamente!';
                p.style.color = 'var(--text-muted)';
                resultContainer.appendChild(p);
                const retryBtn = document.createElement('button');
                retryBtn.id = 'retry-btn';
                retryBtn.style.display = 'inline-block';
                retryBtn.innerHTML = '<i class="fas fa-redo" style="margin-right:8px;"></i>Tentar Novamente';
                retryBtn.onclick = () => loadQuiz(currentTrainingId, currentThemeId);
                resultContainer.appendChild(retryBtn);
            } else {
                const successDiv = document.createElement('div');
                successDiv.className = 'success-message';
                successDiv.innerHTML = '<i class="fas fa-trophy"></i> Parabéns pela aprovação!';
                resultContainer.appendChild(successDiv);

                appendCertificateButton(score);

                const errors = getDetailedIncorrectAnswers(currentTrainingId, currentThemeId);
                if (errors) {
                    const incorrectDiv = document.createElement('div');
                    incorrectDiv.className = 'incorrect-answers';
                    incorrectDiv.innerHTML = '<h3><i class="fas fa-info-circle" style="margin-right:6px;color:var(--accent);"></i>Gabarito das Questões Incorretas</h3><ul></ul>';
                    const ul = incorrectDiv.querySelector('ul');
                    const errorList = errors.split('---').filter(e => e.trim());
                    errorList.forEach(error => {
                        const lines = error.trim().split(';').map(l => l.trim());
                        const li = document.createElement('li');
                        li.innerHTML = `<strong>${lines[0]}</strong><br>${lines[1]}<br>${lines[2]}`;
                        ul.appendChild(li);
                    });
                    resultContainer.appendChild(incorrectDiv);
                }

                if (!assessmentResults[currentTrainingId]) assessmentResults[currentTrainingId] = {};
                assessmentResults[currentTrainingId][currentThemeId] = score;
                saveProgression();

                const assessmentModule = document.getElementById('assessment-module');
                if (assessmentModule) {
                    assessmentModule.classList.add('completed');
                    assessmentModule.innerHTML = renderAssessmentTitle(true);
                }
            }

            resultContainer.style.display = 'flex';
        }

        function showAssessmentResult(score) {
            resetContent();
            contentDiv.style.display = 'block';
            if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            customPlayerContainer.style.display = 'none';
            video.style.display = 'none';
            video.src = '';
            pdfContainer.style.display = 'none';
            titleEl.style.display = 'none';
            captionEl.style.display = 'none';
            attachmentContainer.style.display = 'none';

            resultContainer.innerHTML = '';
            const scoreCard = document.createElement('div');
            scoreCard.className = 'result-score-card';
            const h2 = document.createElement('h2');
            h2.textContent = `${formatScore(score)}/10`;
            scoreCard.appendChild(h2);
            const scoreLabel = document.createElement('p');
            scoreLabel.textContent = 'Aprovado';
            scoreLabel.style.color = 'var(--success)';
            scoreLabel.style.fontWeight = '600';
            scoreCard.appendChild(scoreLabel);
            resultContainer.appendChild(scoreCard);

            const successDiv = document.createElement('div');
            successDiv.className = 'success-message';
            successDiv.innerHTML = '<i class="fas fa-trophy"></i> Parabéns pela aprovação!';
            resultContainer.appendChild(successDiv);
            appendCertificateButton(score);
            resultContainer.style.display = 'flex';
        }

        function resetContent() {
            video.src = '';
            video.style.display = 'none';
            pdfContainer.style.display = 'none';
            pdfCanvas.width = 0;
            pdfCanvas.height = 0;
            pdfNavigation.innerHTML = '';
            titleEl.style.display = 'none';
            captionEl.style.display = 'none';
            attachmentContainer.style.display = 'none';
            quizContainer.style.display = 'none';
            resultContainer.style.display = 'none';
            formContainer.style.display = 'none';
            warningMessage.style.display = 'none';
            document.getElementById('rating-container').style.display = 'none';
            document.getElementById('comment-toggle-btn').style.display = 'none';
            document.getElementById('comment-section').style.display = 'none';
        }

        // Refazer avaliação e reiniciar curso foram removidos deste fluxo:
        // reiniciar é ação exclusiva do admin (reseta progresso de todos os
        // alunos), não algo que o próprio aluno deva poder fazer sozinho.
