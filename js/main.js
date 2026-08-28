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

        // Endpoint REST do Realtime Database — usado no carregamento dos cursos
        // e na gravação de saída da página via sendBeacon (flushProgressBeacon),
        // que não pode passar pelo SDK. Os caminhos montados por
        // progressPathFor já começam com "/", então a base não leva barra final.
        const PROGRESS_REST_BASE = 'https://uniadmin-708f5-default-rtdb.firebaseio.com';

        let initialContentLoaded = false;
        let stopContentLive = null;

        // A tela de boas-vindas vira o ranking assim que o conteúdo carrega.
        // O texto "Selecione um tema para começar" continua servindo Estágios
        // (sem ranking) e o caso de o módulo não ter carregado.
        function showWelcomeRanking() {
            const host = document.getElementById('welcome-ranking');
            const fallback = document.getElementById('welcome-fallback');
            const Ranking = window.UniAdmin?.Ranking;
            if (!host || !Ranking || !Ranking.isEnabledFor(currentCategorySlug)) return;
            if (fallback) fallback.style.display = 'none';
            document.getElementById('welcome-screen')?.classList.add('has-ranking');
            Ranking.renderInto(host, { mode: 'inline', slug: currentCategorySlug });
        }

        function applyCategoryContent(payload) {
            // Categoria ainda sem conteudo no banco: o Firebase devolve null.
            const data = payload || {};
            orderData = data.order || {};
            quizData = data.quizData || {};
            quizStatus = data.quizStatus || {};
            trainingData = data.trainingData || {};
            // Publicado para js/ranking.js, que precisa dos `roles` de cada
            // assunto para saber quantos cursos cada função deveria ter feito.
            if (window.UniAdmin) window.UniAdmin.portalTrainingData = trainingData;
        }

        // Redesenha o que já está na tela depois de uma alteração publicada
        // pelo administrador. A galeria pode ser refeita à vontade; um curso
        // aberto, não — arrancar o vídeo ou a avaliação de quem está no meio
        // dela para mostrar conteúdo novo troca um problema por outro pior. Os
        // dados novos já estão em memória e valem na próxima navegação.
        function refreshOpenContent() {
            const quizOpen = quizContainer && quizContainer.style.display !== 'none';
            const courseOpen = contentDiv && contentDiv.style.display !== 'none';
            if (quizOpen || courseOpen) return;
            if (courseGallery && courseGallery.style.display !== 'none' && currentTrainingId) {
                showCourseGallery(currentTrainingId);
            }
        }

        // Escuta ao vivo em vez de leitura única.
        //
        // Com a leitura única, o portal servia pelo resto da sessão o conteúdo
        // do instante em que a página abriu: um curso publicado, corrigido ou
        // desativado no painel só aparecia para quem recarregasse. Aluno com a
        // aba aberta o dia todo fazia avaliação de uma versão que já não era a
        // vigente. Agora cada alteração chega sozinha.
        function fetchFirebaseData() {
            const U = window.UniAdmin;
            const path = `/uniadmin/${currentCategorySlug}`;

            function finishInitialLoad() {
                document.getElementById('loading-overlay').style.display = 'none';
                if (initialContentLoaded) return;
                initialContentLoaded = true;
                // Progressão é lida uma vez por sessão: ela reflete o que o
                // aluno fez, não o que o administrador publicou, e reaplicá-la
                // a cada evento sobrescreveria o avanço da tela atual.
                loadProgression();
                showWelcomeRanking();
            }

            // Sem o SDK (ex.: página aberta de um contexto onde firebase-config
            // não carregou), o caminho REST antigo ainda serve o primeiro paint.
            if (!U || !U.live) {
                fetch(`${PROGRESS_REST_BASE}/uniadmin/${currentCategorySlug}.json`)
                    .then(response => {
                        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                        return response.json();
                    })
                    .then(payload => { applyCategoryContent(payload); populateDropdown(); finishInitialLoad(); })
                    .catch(error => {
                        console.error('Erro ao carregar dados do Firebase:', error);
                        showWarning('Não foi possível carregar os dados. Tente novamente.');
                        document.getElementById('loading-overlay').style.display = 'none';
                    });
                return;
            }

            if (stopContentLive) stopContentLive();
            stopContentLive = U.live(path, snapshot => {
                applyCategoryContent(snapshot.exists() ? snapshot.val() : {});
                populateDropdown();
                const wasFirst = !initialContentLoaded;
                finishInitialLoad();
                if (!wasFirst) refreshOpenContent();
            }, error => {
                console.error('Erro ao carregar dados do Firebase:', error);
                showWarning('Não foi possível carregar os dados. Tente novamente.');
                document.getElementById('loading-overlay').style.display = 'none';
            });
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
        const playerCard = document.querySelector('.player-card');
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

        // Cache do startedAt já gravado na nuvem por curso (subjectId/themeId)
        // — precisa ser preservado entre syncs (não sobrescrito), pois é a
        // referência usada no gráfico "Tempo para Conclusão" do dashboard.
        let remoteProgressStartedAt = {};

        // Cache do tempo ativo já acumulado e gravado na nuvem por curso
        // (subjectId/themeId), em ms — igual ao startedAt acima, preservado
        // entre syncs e somado à sessão em andamento (ver activeCourseTimer).
        let remoteProgressActiveMs = {};

        // "Contador oculto" do tempo com o curso aberto: soma só o tempo em
        // que a aba está visível com o curso carregado (loadTraining) — pausa
        // ao trocar de curso, sair para a galeria, trocar de aba/minimizar ou
        // fechar a página, e retoma na próxima abertura. Finaliza (para de
        // vez) quando a avaliação é aprovada. Guiado por timestamp real do
        // início da sessão corrente, não por contador incremental, para não
        // perder tempo em caso de recarregar a página no meio de uma sessão.
        let activeCourseTimer = { subjectId: null, themeId: null, sessionStartedAt: null };

        // Cursos já aprovados nesta carga da página — o contador não volta a
        // rodar neles (aluno pode reabrir só para revisar). Só isso trava a
        // recontagem: antes ela dependia de reler assessmentResults com a nota
        // de corte 8 repetida aqui, que saía de sincronia com a regra real da
        // avaliação se o corte mudasse.
        const finishedCourseTimers = new Set();
        const courseTimerKey = (subjectId, themeId) => `${subjectId}_${themeId}`;

        // Nota mínima de aprovação — mesma regra exibida na intro da avaliação
        // (ver loadQuiz) e usada para decidir se o contador já foi encerrado.
        const PASSING_SCORE = 8;

        // Trava por vídeo: em módulo de vídeo o tempo só corre com o vídeo
        // tocando (deixar a aula aberta sem assistir não conta). Em módulo sem
        // vídeo (PDF/slide) não há como medir consumo, então a contagem é
        // livre enquanto a aba estiver visível.
        // 'free'    — módulo sem vídeo, conta livremente.
        // 'playing' — módulo de vídeo com o vídeo rodando, conta.
        // 'waiting' — módulo de vídeo parado/pausado, NÃO conta.
        let moduleTimerGate = 'free';

        // Módulo atual é PDF/slide? Muda o texto do painel de tempo quando a
        // trava está ativa (no PDF a trava é a página 1, não o play do vídeo).
        let currentModuleIsPdf = false;

        // Trava por inatividade: 5 min sem interação de estudo (play de vídeo
        // ou virada de página do PDF) param a contagem. Fica separada de
        // moduleTimerGate porque as duas travas somam — o tempo só corre com o
        // gate liberado E sem inatividade. Só as duas interações acima soltam a
        // trava: mexer o mouse ou voltar para a aba não conta como estudo.
        const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
        let idlePaused = false;
        let idleTimer = null;

        function clearIdleTimer() {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        // Rearma a contagem regressiva de inatividade. Só faz sentido com uma
        // sessão aberta — sem sessão não há o que pausar, e o próximo evento de
        // estudo rearma de qualquer forma.
        function armIdleTimer() {
            clearIdleTimer();
            if (!activeCourseTimer.sessionStartedAt) return;
            idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS);
        }

        // Estourou o tempo ocioso: fecha a sessão (o tempo já corrido é somado)
        // e pausa o vídeo, para o aluno não seguir "assistindo" sem contar.
        function onIdleTimeout() {
            idleTimer = null;
            if (!activeCourseTimer.sessionStartedAt) return;
            idlePaused = true;
            pauseVideoIfPlaying();
            pauseActiveCourseTimer();
            paintExpectedTimePanel();
        }

        // Chamado pelas interações que caracterizam estudo ativo: play do vídeo
        // e troca de página do PDF. Solta a trava de inatividade e retoma a
        // sessão (respeitando a trava de vídeo, que segue valendo).
        function registerStudyActivity() {
            const wasIdle = idlePaused;
            idlePaused = false;
            if (wasIdle && currentTrainingId && currentThemeId != null) {
                resumeActiveCourseTimer(currentTrainingId, currentThemeId);
            }
            armIdleTimer();
        }

        function setModuleTimerGate(gate) {
            if (moduleTimerGate === gate) return;
            moduleTimerGate = gate;
            if (gate === 'waiting') {
                // Fecha a sessão somando o que já correu, sem esquecer o curso
                // — o play retoma de onde parou.
                pauseActiveCourseTimer();
            } else if (currentTrainingId && currentThemeId != null) {
                resumeActiveCourseTimer(currentTrainingId, currentThemeId);
            }
            paintExpectedTimePanel();
        }

        // Grava o parcial da sessão em andamento sem fechá-la: o tempo até
        // agora entra no acumulado e o marco da sessão anda para frente, então
        // nada é contado duas vezes. Usado pelo autosave periódico, que evita
        // perder uma sessão longa inteira em queda de conexão/crash.
        function flushActiveCourseTimer() {
            const { subjectId, themeId, sessionStartedAt } = activeCourseTimer;
            if (!subjectId || !themeId || !sessionStartedAt) return;
            const now = Date.now();
            const elapsed = now - sessionStartedAt;
            if (elapsed <= 0) return;
            activeCourseTimer.sessionStartedAt = now;
            if (!remoteProgressActiveMs[subjectId]) remoteProgressActiveMs[subjectId] = {};
            remoteProgressActiveMs[subjectId][themeId] = (remoteProgressActiveMs[subjectId][themeId] || 0) + elapsed;
            syncCourseProgressToCloud(subjectId, themeId);
        }

        // Autosave a cada minuto enquanto há sessão aberta. Só roda com a aba
        // visível (aba escondida já pausou o contador via visibilitychange, e
        // o navegador estrangula timers em segundo plano de qualquer forma).
        const ACTIVE_TIMER_AUTOSAVE_MS = 60000;
        setInterval(() => {
            if (document.hidden) return;
            flushActiveCourseTimer();
        }, ACTIVE_TIMER_AUTOSAVE_MS);

        // ─── Painel "Tempo mínimo projetado" (sidebar do curso) ───
        // Espelha o contador de tempo ativo: barra de progresso contra o
        // expectedCompletionMs do curso e cronômetro que segue correndo mesmo
        // depois de 100% (o objetivo é registrar dedicação real, não parar no
        // alvo). Só aparece em curso com tempo esperado configurado.
        const expectedTimeCard = document.getElementById('expected-time-card');
        const expectedTimeTargetEl = document.getElementById('expected-time-target');
        const expectedTimeElapsedEl = document.getElementById('expected-time-elapsed');
        const expectedTimePctEl = document.getElementById('expected-time-pct');
        const expectedTimeFillEl = document.getElementById('expected-time-fill');
        const expectedTimeNoteEl = document.getElementById('expected-time-note');
        let expectedTimeTicker = null;

        function formatElapsedHHMMSS(ms) {
            const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
            const pad = v => String(v).padStart(2, '0');
            return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
        }

        // Tempo total do curso agora: o que já foi gravado na nuvem mais a
        // sessão em andamento (que ainda não foi somada ao acumulado).
        function currentActiveMsOf(subjectId, themeId) {
            const stored = remoteProgressActiveMs[subjectId]?.[themeId] || 0;
            const isRunning = activeCourseTimer.subjectId === subjectId
                && activeCourseTimer.themeId === themeId
                && activeCourseTimer.sessionStartedAt;
            return isRunning ? stored + (Date.now() - activeCourseTimer.sessionStartedAt) : stored;
        }

        function expectedMsOfCourse(subjectId, themeId) {
            const ms = Number(trainingData[subjectId]?.themes?.[themeId]?.expectedCompletionMs);
            return Number.isFinite(ms) && ms > 0 ? ms : null;
        }

        function paintExpectedTimePanel() {
            if (!expectedTimeCard) return;
            const subjectId = currentTrainingId;
            const themeId = currentThemeId;
            const expectedMs = (subjectId && themeId != null) ? expectedMsOfCourse(subjectId, themeId) : null;
            if (!expectedMs) { expectedTimeCard.style.display = 'none'; return; }

            expectedTimeCard.style.display = '';
            const elapsedMs = currentActiveMsOf(subjectId, themeId);
            const rawPct = (elapsedMs / expectedMs) * 100;
            const isComplete = rawPct >= 100;

            expectedTimeTargetEl.textContent = `Meta ${formatElapsedHHMMSS(expectedMs)}`;
            expectedTimeElapsedEl.textContent = formatElapsedHHMMSS(elapsedMs);
            // O texto passa de 100% (mostra a dedicação real), mas a barra
            // satura em 100% para não transbordar do trilho.
            expectedTimePctEl.textContent = `${Math.floor(rawPct)}%`;
            expectedTimeFillEl.style.width = `${Math.min(100, rawPct)}%`;
            expectedTimeCard.classList.toggle('is-complete', isComplete);

            const finished = isCourseTimerFinished(subjectId, themeId);
            const running = !!activeCourseTimer.sessionStartedAt
                && activeCourseTimer.subjectId === subjectId
                && activeCourseTimer.themeId === themeId;
            expectedTimeCard.classList.toggle('is-paused', !running);

            // Ícone + texto explicando por que está (ou não) contando. O ícone
            // de pausa é o sinal mais rápido de "seu tempo não está correndo".
            let icon, note;
            if (finished) {
                icon = 'fa-circle-check';
                note = 'Curso concluído — contagem encerrada.';
            } else if (!running && idlePaused) {
                icon = 'fa-circle-pause';
                note = 'Pausado por inatividade — dê play no vídeo ou passe uma página para retomar.';
            } else if (!running && moduleTimerGate === 'waiting') {
                // Caso mais comum da trava por vídeo: aula aberta, vídeo parado.
                // No PDF a trava equivalente é a capa (página 1).
                icon = 'fa-circle-pause';
                note = currentModuleIsPdf
                    ? 'Pausado — avance para a página 2 para contar o tempo.'
                    : 'Pausado — dê play no vídeo para contar o tempo.';
            } else if (!running) {
                icon = 'fa-circle-pause';
                note = 'Pausado — a contagem volta ao retomar o curso.';
            } else if (isComplete) {
                icon = 'fa-circle-play';
                note = 'Tempo projetado atingido — a contagem continua.';
            } else {
                icon = 'fa-circle-play';
                note = 'Contando o tempo de estudo.';
            }
            expectedTimeNoteEl.innerHTML = `<i class="fas ${icon}"></i> ${note}`;
        }

        // Tick de 1s só para a interface — o valor real vem sempre de
        // timestamps (currentActiveMsOf), então um tick perdido com a aba em
        // segundo plano não desalinha a contagem.
        function startExpectedTimeTicker() {
            if (expectedTimeTicker) return;
            expectedTimeTicker = setInterval(paintExpectedTimePanel, 1000);
        }

        function stopExpectedTimeTicker() {
            if (!expectedTimeTicker) return;
            clearInterval(expectedTimeTicker);
            expectedTimeTicker = null;
        }

        function hideExpectedTimePanel() {
            stopExpectedTimeTicker();
            if (expectedTimeCard) expectedTimeCard.style.display = 'none';
        }

        // Fecha a sessão corrente (se houver) somando o tempo decorrido ao
        // acumulado em nuvem e sincronizando. Chamado ao trocar de curso, sair
        // para a galeria, esconder a aba ou aprovar na avaliação. `forget`
        // limpa subjectId/themeId do timer (usado ao sair para a galeria) —
        // sem isso, um simples minimizar/restaurar a aba na galeria faria o
        // visibilitychange achar que ainda há curso aberto e retomar a conta.
        function pauseActiveCourseTimer(forget = false) {
            clearIdleTimer();
            const { subjectId, themeId, sessionStartedAt } = activeCourseTimer;
            if (forget) { activeCourseTimer = { subjectId: null, themeId: null, sessionStartedAt: null }; }
            if (!subjectId || !themeId || !sessionStartedAt) { paintExpectedTimePanel(); return; }
            const elapsed = Date.now() - sessionStartedAt;
            if (!forget) activeCourseTimer.sessionStartedAt = null;
            if (elapsed <= 0) { paintExpectedTimePanel(); return; }
            if (!remoteProgressActiveMs[subjectId]) remoteProgressActiveMs[subjectId] = {};
            remoteProgressActiveMs[subjectId][themeId] = (remoteProgressActiveMs[subjectId][themeId] || 0) + elapsed;
            // Args explícitos: currentTrainingId/currentThemeId podem já
            // apontar para outro curso neste momento (ex.: loadTraining seta
            // o novo curso antes de pausar o anterior via resumeActiveCourseTimer).
            syncCourseProgressToCloud(subjectId, themeId);
            // Repinta já com o acumulado atualizado — o cronômetro precisa
            // congelar no valor certo ao pausar, sem esperar o próximo tick.
            paintExpectedTimePanel();
        }

        // Abre (ou retoma) a sessão do curso informado — chamado sempre que um
        // módulo é carregado dentro dele. Se já havia sessão ativa para outro
        // curso, fecha antes. Não reabre se o curso já foi aprovado (contador
        // final, não deve voltar a contar).
        function resumeActiveCourseTimer(subjectId, themeId) {
            if (activeCourseTimer.subjectId === subjectId && activeCourseTimer.themeId === themeId && activeCourseTimer.sessionStartedAt) return;
            pauseActiveCourseTimer();
            if (isCourseTimerFinished(subjectId, themeId)) { paintExpectedTimePanel(); return; }
            // Vídeo parado segura a contagem: o timer fica "armado" no curso
            // (subjectId/themeId setados) mas sem sessão aberta, então o play
            // é o que efetivamente inicia a contagem.
            // Idem para a trava de inatividade: timer armado no curso, mas sem
            // sessão até a próxima interação de estudo (ver registerStudyActivity).
            if (moduleTimerGate === 'waiting' || idlePaused) {
                activeCourseTimer = { subjectId, themeId, sessionStartedAt: null };
                paintExpectedTimePanel();
                return;
            }
            activeCourseTimer = { subjectId, themeId, sessionStartedAt: Date.now() };
            armIdleTimer();
            paintExpectedTimePanel();
        }

        // Curso já aprovado (nesta sessão ou em qualquer uma anterior, via
        // assessmentResults sincronizado da nuvem) não volta a contar.
        function isCourseTimerFinished(subjectId, themeId) {
            if (finishedCourseTimers.has(courseTimerKey(subjectId, themeId))) return true;
            const score = assessmentResults[subjectId]?.[themeId];
            return score !== undefined && score !== null && score >= PASSING_SCORE;
        }

        // Encerra de vez o contador do curso aprovado — soma a sessão corrente
        // e impede que ele volte a contar (aluno pode reabrir o curso depois
        // só para revisar módulos, isso não deve inflar o tempo registrado).
        function finishActiveCourseTimer(subjectId, themeId) {
            finishedCourseTimers.add(courseTimerKey(subjectId, themeId));
            if (activeCourseTimer.subjectId === subjectId && activeCourseTimer.themeId === themeId) {
                // `forget` limpa subjectId/themeId: sem isso o visibilitychange
                // ao restaurar a aba reabriria a sessão do curso recém-aprovado.
                pauseActiveCourseTimer(true);
            }
            // Congela o painel no total final, com a nota de encerrado.
            stopExpectedTimeTicker();
            paintExpectedTimePanel();
        }

        // Pausa o vídeo se ele estiver rodando — usado ao minimizar/trocar de
        // aba, para o aluno não "assistir" com a página escondida (o YouTube
        // continua tocando o áudio em segundo plano). Silencioso quando não há
        // player ou a API ainda não carregou.
        function pauseVideoIfPlaying() {
            if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
            const YT_STATE = window.YT?.PlayerState;
            if (!YT_STATE) return;
            let state;
            // getPlayerState lança se o iframe já foi destruído no meio de uma
            // troca de módulo — nesse caso não há vídeo a pausar.
            try { state = ytPlayer.getPlayerState(); } catch { return; }
            // BUFFERING entra junto: o vídeo está em reprodução, só carregando.
            if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
                try { ytPlayer.pauseVideo(); } catch { /* player indisponível */ }
            }
        }

        document.addEventListener('visibilitychange', () => {
            // Pausar o vídeo dispara onPlayerStateChange → gate 'waiting', que
            // já fecha a sessão do contador. O pause explícito abaixo continua
            // necessário para módulos sem vídeo (contagem livre).
            if (document.hidden) {
                pauseVideoIfPlaying();
                pauseActiveCourseTimer();
            } else if (activeCourseTimer.subjectId && activeCourseTimer.themeId && !activeCourseTimer.sessionStartedAt) {
                resumeActiveCourseTimer(activeCourseTimer.subjectId, activeCourseTimer.themeId);
            }
            paintExpectedTimePanel();
        });
        // Saída da página: tenta o sendBeacon primeiro (única forma de a
        // gravação sobreviver ao fechamento da aba). Se ele não estiver
        // disponível ou não houver sessão aberta, cai no pause normal.
        function flushOnPageExit() {
            if (!flushProgressBeacon()) pauseActiveCourseTimer();
        }
        window.addEventListener('beforeunload', flushOnPageExit);
        window.addEventListener('pagehide', flushOnPageExit);

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

        // Sincroniza só o curso informado (por padrão, o atualmente aberto) —
        // evita reescrever a árvore inteira a cada módulo concluído. Aceita
        // subjectId/themeId explícitos porque pauseActiveCourseTimer pode
        // precisar sincronizar um curso que acabou de deixar de ser o atual
        // (ex.: trocando de curso ou saindo para a galeria).
        // Monta o registro de progressão a gravar e o caminho no banco, sem
        // enviar nada — separado de syncCourseProgressToCloud porque a
        // gravação de saída da página (sendBeacon, ver flushProgressBeacon)
        // precisa do mesmo payload por outro transporte.
        function buildCourseProgressRecord(subjectId, themeId) {
            if (!isProgressSyncEligible() || !subjectId || !themeId) return null;
            const U = window.UniAdmin;
            const session = U.StudentAuth.getSession();
            const theme = trainingData[subjectId]?.themes?.[themeId];
            if (!theme) return null;
            const { total, done, pct } = courseProgress(subjectId, theme);
            const approved = assessmentResults[subjectId]?.[themeId];
            const existingStartedAt = remoteProgressStartedAt[subjectId]?.[themeId];
            const startedAt = existingStartedAt || Date.now();
            const activeMs = remoteProgressActiveMs[subjectId]?.[themeId] || 0;
            const record = {
                total, done, pct,
                approved: approved !== undefined ? approved : null,
                startedAt,
                activeMs,
                updatedAt: Date.now()
            };
            if (!remoteProgressStartedAt[subjectId]) remoteProgressStartedAt[subjectId] = {};
            remoteProgressStartedAt[subjectId][themeId] = startedAt;
            if (!remoteProgressActiveMs[subjectId]) remoteProgressActiveMs[subjectId] = {};
            remoteProgressActiveMs[subjectId][themeId] = activeMs;
            return { record, path: `${progressPathFor(session.userId)}/${subjectId}/${themeId}` };
        }

        // Gravação de última chance ao sair da página: o .set() do SDK é
        // assíncrono e o navegador mata a requisição ao fechar a aba, então o
        // tempo da sessão em andamento se perdia. sendBeacon é entregue pelo
        // navegador mesmo depois da página morrer. PUT via REST do Realtime
        // Database (mesmo endpoint já usado no carregamento dos cursos), com
        // o método forçado por query string porque sendBeacon só faz POST.
        function flushProgressBeacon() {
            const { subjectId, themeId, sessionStartedAt } = activeCourseTimer;
            if (!subjectId || !themeId || !sessionStartedAt) return false;
            if (!navigator.sendBeacon) return false;
            const elapsed = Date.now() - sessionStartedAt;
            if (elapsed <= 0) return false;

            if (!remoteProgressActiveMs[subjectId]) remoteProgressActiveMs[subjectId] = {};
            remoteProgressActiveMs[subjectId][themeId] = (remoteProgressActiveMs[subjectId][themeId] || 0) + elapsed;
            activeCourseTimer.sessionStartedAt = null;

            const built = buildCourseProgressRecord(subjectId, themeId);
            if (!built) return false;
            const url = `${PROGRESS_REST_BASE}${built.path}.json?x-http-method-override=PUT`;
            // text/plain evita o preflight CORS, que o sendBeacon não faz.
            const blob = new Blob([JSON.stringify(built.record)], { type: 'text/plain;charset=UTF-8' });
            return navigator.sendBeacon(url, blob);
        }

        function syncCourseProgressToCloud(subjectId = currentTrainingId, themeId = currentThemeId) {
            if (!isProgressSyncEligible() || !subjectId || !themeId) return;
            const U = window.UniAdmin;
            // startedAt é gravado só na primeira sync do curso e preservado
            // depois — marca (aproximadamente) o início do 1º módulo. activeMs
            // é o tempo ativo acumulado (contador oculto, ver
            // resumeActiveCourseTimer/pauseActiveCourseTimer) — ambos usados
            // no gráfico "Tempo para Conclusão" do dashboard (Config >
            // Dashboard > curso > Gráficos), que exibe o activeMs.
            const built = buildCourseProgressRecord(subjectId, themeId);
            if (!built) return;
            const { record, path } = built;
            // Transação, não `set`: o mesmo aluno pode estar com o curso aberto
            // em duas abas ou dois aparelhos, e cada um carrega o activeMs de
            // quando entrou. Com `set`, quem gravasse por último devolvia o
            // contador ao valor dele e o tempo assistido no outro sumia —
            // junto com os módulos concluídos lá. A transação lê o valor no
            // servidor no momento da escrita e nunca deixa a progressão andar
            // para trás; só um reset do administrador (que apaga o nó) zera.
            U.ref(U.db, path).transaction(current => {
                if (!current) return record;
                return {
                    ...record,
                    total: record.total,
                    done: Math.max(record.done || 0, current.done || 0),
                    pct: Math.max(record.pct || 0, current.pct || 0),
                    approved: record.approved !== null && record.approved !== undefined
                        ? record.approved
                        : (current.approved !== undefined ? current.approved : null),
                    startedAt: Math.min(record.startedAt || Date.now(), current.startedAt || record.startedAt || Date.now()),
                    activeMs: Math.max(record.activeMs || 0, current.activeMs || 0),
                    updatedAt: Date.now()
                };
            }).catch(error => {
                console.error('Erro ao sincronizar progressão do curso:', error);
            });
        }

        // Aprovações já registradas no histórico do aluno, por curso.
        // Fonte: as mesmas linhas da aba Histórico (U.getHistoryRows), que
        // reúne results/byUser (avaliações feitas no portal) E
        // results/imported (histórico antigo trazido por planilha, sem
        // userId — casa pelo nome, mesmo critério do Perfil do aluno,
        // ver rowsForSession em js/student-profile.js).
        // Devolve Map "subjectId_themeId" -> maior nota aprovada.
        function fetchApprovedHistory(session) {
            const U = window.UniAdmin;
            if (!U.getHistoryRows) return Promise.resolve(new Map());
            const nameKey = U.normalizeName(session.fullName || '');
            return U.getHistoryRows().then(rows => {
                const byCourse = new Map();
                (rows || []).forEach(r => {
                    if (r.slug !== currentCategorySlug) return;
                    if (!r.subjectId || !r.themeId) return;
                    // Linha do próprio aluno: pela conta, ou — no histórico
                    // avulso/importado, que não tem conta — pelo nome.
                    const isMine = r.userId === session.userId
                        || (r.userId == null && U.normalizeName(r.fullName || '') === nameKey);
                    if (!isMine || !r.approved) return;
                    const score = Number(r.score);
                    if (!Number.isFinite(score)) return;
                    const key = `${r.subjectId}_${r.themeId}`;
                    const best = byCourse.get(key);
                    if (best === undefined || score > best) byCourse.set(key, score);
                });
                return byCourse;
            }).catch(error => {
                console.error('Erro ao carregar histórico aprovado:', error);
                return new Map();
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
            Promise.all([
                U.get(U.ref(U.db, progressPathFor(session.userId))),
                fetchApprovedHistory(session)
            ]).then(([snapshot, approvedHistory]) => {
                const remote = snapshot.exists() ? (snapshot.val() || {}) : {};
                let changed = false;

                Object.keys(trainingData).forEach(subjectId => {
                    Object.keys(trainingData[subjectId]?.themes || {}).forEach(themeId => {
                        const theme = trainingData[subjectId].themes[themeId];
                        const entry = remote[subjectId]?.[themeId];
                        if (entry?.startedAt) {
                            if (!remoteProgressStartedAt[subjectId]) remoteProgressStartedAt[subjectId] = {};
                            remoteProgressStartedAt[subjectId][themeId] = entry.startedAt;
                        }
                        if (Number.isFinite(entry?.activeMs)) {
                            if (!remoteProgressActiveMs[subjectId]) remoteProgressActiveMs[subjectId] = {};
                            remoteProgressActiveMs[subjectId][themeId] = entry.activeMs;
                        }
                        // Curso aprovado no histórico (inclusive o importado
                        // por planilha, que não gera registro em
                        // progress/byUser) conta como concluído: o card mostra
                        // 100% e a nota, sem exigir reassistir os módulos.
                        // Só o reset do curso zera isso — ele apaga também as
                        // linhas de results/imported (ver resetCourse em
                        // js/admin-dashboard.js), então a aprovação some daqui
                        // junto com o resto.
                        const moduleCount = (theme.modules || []).length;
                        const historyScore = approvedHistory.get(`${subjectId}_${themeId}`);
                        const hasHistoryApproval = historyScore !== undefined;

                        const localDone = (completionStatus[subjectId]?.[themeId] || []).filter(Boolean).length;
                        const remoteDone = hasHistoryApproval
                            ? Math.max(entry?.done || 0, moduleCount)
                            : (entry?.done || 0);

                        // Reconstrói o array de booleans do tamanho certo sempre que a
                        // progressão remota diverge da local (para mais OU para menos).
                        if (remoteDone !== localDone) {
                            if (!completionStatus[subjectId]) completionStatus[subjectId] = {};
                            const arr = new Array(moduleCount).fill(false);
                            for (let i = 0; i < Math.min(remoteDone, arr.length); i++) arr[i] = true;
                            completionStatus[subjectId][themeId] = arr;
                            changed = true;
                        }

                        const entryApproved = (entry?.approved !== undefined && entry?.approved !== null) ? entry.approved : undefined;
                        // Entre a nota da nuvem e a do histórico vale a maior —
                        // o histórico importado costuma ser a única fonte de
                        // cursos feitos antes do portal.
                        const remoteApproved = hasHistoryApproval
                            ? (entryApproved !== undefined ? Math.max(entryApproved, historyScore) : historyScore)
                            : entryApproved;
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
                // O acumulado da nuvem chega depois da abertura do curso —
                // repinta para o cronômetro sair de 00:00:00 e mostrar o
                // tempo real já dedicado.
                paintExpectedTimePanel();
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
                // Play libera a contagem do tempo de curso (ver moduleTimerGate)
                // e conta como interação, soltando a trava de inatividade.
                registerStudyActivity();
                setModuleTimerGate('playing');
            } else if (event.data === YT_STATE.PAUSED || event.data === YT_STATE.ENDED) {
                playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                stopProgressTimer();
                // Pausou/terminou: para de contar até o próximo play.
                setModuleTimerGate('waiting');
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
                .map(id => ({ ...trainingData[id], id }));
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
                    if (currentTrainingId && currentThemeId != null && loadQuizAttempt(currentTrainingId, currentThemeId)) {
                        closeSubjectDropdown();
                        showWarning('Termine a avaliação em andamento antes de trocar de tema.');
                        return;
                    }
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
            // Correspondência hierárquica (js/ranking.js:roleMatches): o cargo
            // da planilha traz a especialização ("Analista - Biomédico") e o
            // curso é marcado pelo nome-base ("Analista"). Igualdade exata
            // escondia o curso de quem tem cargo especializado.
            const matches = window.UniAdmin?.Ranking?.roleMatches;
            if (matches) return roles.some(r => matches(r, role));
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
                .map(id => ({ ...themes[id], id }));
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

            const tagRow = document.createElement('div');
            tagRow.className = 'course-tag-row';

            const certTag = document.createElement('div');
            certTag.className = theme.certificateEnabled ? 'course-cert-tag has-cert' : 'course-cert-tag no-cert';
            certTag.innerHTML = theme.certificateEnabled
                ? '<i class="fas fa-award"></i> Emite certificado'
                : '<i class="fas fa-ban"></i> Não emite certificado';
            tagRow.appendChild(certTag);

            // Balão do tempo estimado: só aparece em curso com
            // expectedCompletionMs configurado (mesmo campo do painel
            // "Tempo mínimo projetado" da sidebar).
            const expectedMs = Number(theme.expectedCompletionMs);
            if (Number.isFinite(expectedMs) && expectedMs > 0) {
                const timeTag = document.createElement('div');
                timeTag.className = 'course-cert-tag course-time-tag';
                timeTag.innerHTML = `<i class="fas fa-clock"></i> Tempo estimado ${formatElapsedHHMMSS(expectedMs)}`;
                timeTag.title = `Tempo estimado para conclusão: ${formatElapsedHHMMSS(expectedMs)}`;
                tagRow.appendChild(timeTag);
            }

            body.appendChild(tagRow);

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
            pauseActiveCourseTimer(true);
            hideExpectedTimePanel();
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
                if (currentThemeId != null && loadQuizAttempt(currentTrainingId, currentThemeId)) {
                    showWarning('Termine a avaliação em andamento antes de sair do curso.');
                    return;
                }
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
            // Página 1 é capa: não conta tempo. A contagem começa na página 2.
            // Exceção: PDF curto (até 6 páginas) — aí a página 1 já é conteúdo.
            setModuleTimerGate(pageNum === 1 && totalPages > 6 ? 'waiting' : 'free');
            // Virar página é a interação de estudo do módulo de PDF: rearma (ou
            // solta) a trava de inatividade de 10 min.
            registerStudyActivity();
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
            if (!theme) return;
            // Contador começa na ABERTURA do curso, antes de qualquer checagem
            // de conteúdo — curso ainda sem módulos cadastrados também conta o
            // tempo em que ficou aberto na tela.
            resumeActiveCourseTimer(subjectId, themeId);
            // Painel de tempo projetado acompanha o curso aberto (some sozinho
            // se este não tiver expectedCompletionMs configurado).
            startExpectedTimeTicker();
            paintExpectedTimePanel();
            if (!theme.modules || theme.modules.length === 0) return;

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
                    // Avaliação em andamento: nada de módulo destrava o aluno
                    // dela — nem reload nem clique na sidebar.
                    if (loadQuizAttempt(subjectId, themeId)) {
                        showWarning('Termine a avaliação em andamento antes de voltar ao conteúdo.');
                        return;
                    }
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
                        onSuccess: () => openQuizGuarded(subjectId, themeId)
                    });
                    return;
                }
                openQuizGuarded(subjectId, themeId);
            };
            modulesDiv.appendChild(assessmentDiv);

            // Prova em andamento (não finalizada) para este curso: força a
            // retomada direto na tela do quiz, mesmo após recarregar a página
            // — impede "escapar" da avaliação voltando para os módulos.
            if (loadQuizAttempt(subjectId, themeId)) {
                assessmentDiv.classList.add('active');
                document.querySelectorAll('.module').forEach(m => { if (m !== assessmentDiv) m.classList.remove('active'); });
                openQuiz(subjectId, themeId);
            }
        }

        // ─── TENTATIVA DE AVALIAÇÃO PERSISTENTE (localStorage) ───
        // Guarda início real (timestamp) + respostas parciais, para o timer
        // sobreviver a reload/fechar a página e para forçar o envio ao expirar
        // sem depender da aba continuar aberta.
        function quizAttemptKey(subjectId, themeId) {
            return `quizAttempt_${subjectId}_${themeId}`;
        }

        function loadQuizAttempt(subjectId, themeId) {
            try {
                const raw = localStorage.getItem(quizAttemptKey(subjectId, themeId));
                return raw ? JSON.parse(raw) : null;
            } catch (error) { return null; }
        }

        function saveQuizAttempt(subjectId, themeId, attempt) {
            try { localStorage.setItem(quizAttemptKey(subjectId, themeId), JSON.stringify(attempt)); }
            catch (error) { /* indisponível */ }
        }

        function clearQuizAttempt(subjectId, themeId) {
            try { localStorage.removeItem(quizAttemptKey(subjectId, themeId)); }
            catch (error) { /* indisponível */ }
        }

        // Minutos da prova = 2 min por questão.
        function quizDurationMs(questionCount) {
            return questionCount * 2 * 60 * 1000;
        }

        function formatClock(ms) {
            const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
            const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
            const s = (totalSeconds % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }

        // Trava de tentativas (js/attempts.js): confere o bloqueio na nuvem
        // antes de abrir a prova, para valer mesmo se o aluno trocar de
        // dispositivo. Estágios não tem conta, então não entra nesta trava.
        async function openQuizGuarded(subjectId, themeId) {
            const session = window.UniAdmin?.StudentAuth?.getSession();
            if (!session || !window.UniAdmin?.Attempts) { openQuiz(subjectId, themeId); return; }

            const state = await window.UniAdmin.Attempts.getState(session.userId, currentCategorySlug, subjectId, themeId);
            if (state.locked) { showAttemptsLockedAlert(state); return; }
            openQuiz(subjectId, themeId, state);
        }

        // Alerta elegante exibido quando as tentativas disponíveis foram
        // usadas sem aprovação. Substitui a tela normal de conteúdo — não é
        // um toast, pois a ação (falar com admin) precisa ficar visível até
        // o aluno sair.
        function showAttemptsLockedAlert(state) {
            const A = window.UniAdmin?.Attempts;
            const limit = A ? A.limitFor(state) : 3;
            resetContent();
            contentDiv.style.display = 'block';
            resultContainer.innerHTML = `
                <div class="attempts-locked-card">
                    <div class="attempts-locked-icon"><i class="fas fa-lock"></i></div>
                    <h2>Limite de tentativas atingido</h2>
                    <p>Você usou as ${limit} tentativas disponíveis para esta avaliação e não atingiu a nota mínima.</p>
                    <p>Fale com um administrador para liberar novas tentativas.</p>
                </div>`;
            resultContainer.style.display = 'flex';
        }

        function openQuiz(subjectId, themeId, attemptsState = null) {
            if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            customPlayerContainer.style.display = 'none';
            video.style.display = 'none';
            video.src = '';
            pdfContainer.style.display = 'none';
            document.body.classList.remove('cinema-active');

            const quizKey = `${subjectId}_${themeId}`;
            if (quizStatus[quizKey] === false) { showWarning('Avaliação indisponível no momento.'); return; }
            const questions = quizData[quizKey];
            if (!questions) { showWarning('Nenhuma avaliação disponível para este tema.'); return; }

            // Tentativa já em andamento (reload/reabertura): pula intro e
            // confirmação, retoma direto no ponto (bloqueia "voltar" da prova).
            const existing = loadQuizAttempt(subjectId, themeId);
            if (existing) { loadQuiz(subjectId, themeId); return; }

            openQuizIntro(subjectId, themeId, questions.length, attemptsState);
        }

        function openQuizIntro(subjectId, themeId, questionCount, attemptsState = null) {
            resetContent();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            const minutes = questionCount * 2;
            document.getElementById('quiz-intro-count').textContent = `${questionCount} questões`;
            document.getElementById('quiz-intro-time').textContent = `${minutes} minutos`;

            // Contador de tentativas (js/attempts.js): só aparece para aluno
            // logado com pelo menos 1 reprovação já registrada neste curso —
            // na primeira tentativa não há o que avisar ainda. O limite
            // exibido já reflete tentativas extras liberadas pelo admin.
            const attemptsFact = document.getElementById('quiz-intro-attempts-fact');
            const attemptsNote = document.getElementById('quiz-intro-attempts-note');
            const A = window.UniAdmin?.Attempts;
            const usedAttempts = attemptsState?.count || 0;
            const limit = A && attemptsState ? A.limitFor(attemptsState) : (A ? A.MAX_ATTEMPTS : 3);
            if (usedAttempts > 0) {
                const isLastChance = usedAttempts + 1 >= limit;
                const hasExtra = attemptsState?.extraAttempts > 0;
                document.getElementById('quiz-intro-attempts').textContent = `Tentativa ${usedAttempts + 1} de ${limit}${hasExtra ? ' (+1 extra liberada)' : ''}`;
                attemptsFact.style.display = 'flex';
                attemptsFact.classList.toggle('quiz-intro-fact--last-chance', isLastChance);
                attemptsNote.style.display = isLastChance ? 'block' : 'none';
            } else {
                attemptsFact.style.display = 'none';
                attemptsNote.style.display = 'none';
            }

            const modal = document.getElementById('quiz-intro-modal');
            const startBtn = document.getElementById('quiz-intro-start-btn');
            const cancelBtn = document.getElementById('quiz-intro-cancel-btn');

            const close = () => { modal.classList.remove('active'); cleanup(); };
            const handleStart = () => { close(); openQuizConfirm(subjectId, themeId, attemptsState); };
            const handleCancel = () => close();
            const handleOverlayClick = (e) => { if (e.target === modal) handleCancel(); };

            function cleanup() {
                startBtn.removeEventListener('click', handleStart);
                cancelBtn.removeEventListener('click', handleCancel);
                modal.removeEventListener('click', handleOverlayClick);
            }

            startBtn.addEventListener('click', handleStart);
            cancelBtn.addEventListener('click', handleCancel);
            modal.addEventListener('click', handleOverlayClick);

            modal.classList.add('active');
        }

        function openQuizConfirm(subjectId, themeId, attemptsState = null) {
            const modal = document.getElementById('quiz-confirm-modal');
            const startBtn = document.getElementById('quiz-confirm-start-btn');
            const backBtn = document.getElementById('quiz-confirm-back-btn');

            const close = () => { modal.classList.remove('active'); cleanup(); };
            const handleStart = () => {
                close();
                const questions = quizData[`${subjectId}_${themeId}`] || [];
                saveQuizAttempt(subjectId, themeId, {
                    startedAt: Date.now(),
                    durationMs: quizDurationMs(questions.length),
                    selectedAnswers: {}
                });
                loadQuiz(subjectId, themeId);
            };
            const handleBack = () => { close(); openQuizIntro(subjectId, themeId, (quizData[`${subjectId}_${themeId}`] || []).length, attemptsState); };
            const handleOverlayClick = (e) => { if (e.target === modal) handleBack(); };

            function cleanup() {
                startBtn.removeEventListener('click', handleStart);
                backBtn.removeEventListener('click', handleBack);
                modal.removeEventListener('click', handleOverlayClick);
            }

            startBtn.addEventListener('click', handleStart);
            backBtn.addEventListener('click', handleBack);
            modal.addEventListener('click', handleOverlayClick);

            modal.classList.add('active');
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
            // Define a trava ANTES de retomar: módulo de vídeo entra em
            // 'waiting' (só conta ao dar play), módulo de PDF/slide conta
            // livremente. Sem isso, abrir uma aula de vídeo já contaria tempo
            // antes do primeiro play.
            // Vídeo: 'waiting' até o play. PDF: também 'waiting' — a página 1
            // é capa e não conta; renderPage libera ao sair dela (ou já na
            // página 1 se o PDF tiver só uma página).
            moduleTimerGate = 'waiting';
            currentModuleIsPdf = !!mod.pdfUrl;
            // Abrir um módulo é interação: nunca cair num módulo novo já
            // pausado por inatividade anterior.
            idlePaused = false;
            // Fecha a sessão que vinha do módulo anterior: sem isso
            // resumeActiveCourseTimer sai cedo (mesmo curso, sessão aberta) e
            // a trava do novo módulo nunca chegaria a pausar a contagem.
            pauseActiveCourseTimer();
            // Retoma o contador ao voltar para o conteúdo — cobre tanto o
            // primeiro módulo quanto a volta depois de uma prova (loadQuiz
            // pausa e esquece o curso).
            if (currentTrainingId && currentThemeId != null) {
                resumeActiveCourseTimer(currentTrainingId, currentThemeId);
            }
            if (playerCard) playerCard.style.display = '';
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
            // A avaliação tem cronômetro próprio (durationSeconds, gráfico
            // "Tempo para Conclusão da Avaliação"), então o contador de tempo
            // de ESTUDO pausa aqui e só volta ao retornar para os módulos
            // (ver loadModule). `forget` para que restaurar a aba durante a
            // prova não retome a contagem pelo visibilitychange.
            pauseActiveCourseTimer(true);
            resetContent();
            const quizKey = `${subjectId}_${themeId}`;
            if (quizStatus[quizKey] === false) { showWarning('Avaliação indisponível no momento.'); return; }
            const questions = quizData[quizKey];
            if (!questions) { showWarning('Nenhuma avaliação disponível para este tema.'); return; }

            // Tentativa deve existir neste ponto (criada na confirmação, ou
            // retomada de um reload/reabertura anterior). Sem ela não há como
            // saber o prazo real — recria defensivamente para não travar o aluno.
            let attempt = loadQuizAttempt(subjectId, themeId);
            if (!attempt) {
                attempt = { startedAt: Date.now(), durationMs: quizDurationMs(questions.length), selectedAnswers: {} };
                saveQuizAttempt(subjectId, themeId, attempt);
            }
            selectedAnswers = { ...attempt.selectedAnswers };

            const deadline = attempt.startedAt + attempt.durationMs;
            if (Date.now() >= deadline) {
                // Prazo já esgotado (fechou a página e voltou depois): envia
                // automaticamente com o que estava marcado, sem reabrir a prova.
                finalizeQuizAttempt(subjectId, themeId, questions, true);
                return;
            }

            quizContainer.innerHTML = '';

            const timerBox = document.createElement('div');
            timerBox.className = 'quiz-timer-box';
            timerBox.id = 'quiz-timer-box';
            timerBox.innerHTML = `
                <div class="quiz-timer-icon"><i class="fas fa-hourglass-half"></i></div>
                <div class="quiz-timer-body">
                    <div class="quiz-timer-top">
                        <span class="quiz-timer-label">Tempo restante</span>
                        <span class="quiz-timer-clock" id="quiz-timer-clock">--:--</span>
                    </div>
                    <div class="quiz-timer-track"><div class="quiz-timer-fill" id="quiz-timer-fill"></div></div>
                </div>`;
            quizContainer.appendChild(timerBox);

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
                    if (selectedAnswers[index] === optIndex) { input.checked = true; label.classList.add('selected'); }
                    input.onchange = () => {
                        selectedAnswers[index] = parseInt(input.value, 10);
                        card.querySelectorAll('.quiz-option').forEach(o => o.classList.remove('selected'));
                        label.classList.add('selected');
                        card.classList.remove('missing');
                        // Persiste a resposta parcial — sobrevive a reload/fechar aba.
                        const current = loadQuizAttempt(subjectId, themeId);
                        if (current) {
                            current.selectedAnswers = { ...selectedAnswers };
                            saveQuizAttempt(subjectId, themeId, current);
                        }
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

            startQuizTimer(subjectId, themeId, questions, deadline);
        }

        // Timer baseado em timestamp real (deadline fixo), não em contador
        // incremental — assim recarregar a página não "ganha" tempo extra e o
        // valor exibido sempre reflete o tempo restante real.
        function stopQuizTimer() {
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        }

        function startQuizTimer(subjectId, themeId, questions, deadline) {
            stopQuizTimer();
            const totalMs = deadline - (loadQuizAttempt(subjectId, themeId)?.startedAt || Date.now());

            const tick = () => {
                const remaining = deadline - Date.now();
                const clockEl = document.getElementById('quiz-timer-clock');
                const fillEl = document.getElementById('quiz-timer-fill');
                const boxEl = document.getElementById('quiz-timer-box');
                if (!clockEl || !fillEl || !boxEl) { stopQuizTimer(); return; }

                if (remaining <= 0) {
                    clockEl.textContent = '00:00';
                    fillEl.style.width = '100%';
                    stopQuizTimer();
                    finalizeQuizAttempt(subjectId, themeId, questions, true);
                    return;
                }

                clockEl.textContent = formatClock(remaining);
                const elapsedPct = Math.min(100, Math.max(0, ((totalMs - remaining) / totalMs) * 100));
                fillEl.style.width = `${elapsedPct}%`;
                boxEl.classList.toggle('is-urgent', remaining <= 60000);
            };

            tick();
            progressTimer = setInterval(tick, 1000);
        }

        // Envio automático ao esgotar o tempo — questões sem resposta contam
        // como incorretas. Usado tanto pelo timer ativo quanto ao reabrir a
        // página já com o prazo vencido.
        function finalizeQuizAttempt(subjectId, themeId, questions, auto) {
            stopQuizTimer();
            const attempt = loadQuizAttempt(subjectId, themeId);
            const startedAt = attempt?.startedAt || Date.now();
            // Mescla (storage primeiro, memória por último): o clique mais
            // recente pode não ter chegado ao localStorage (write falhou em
            // silêncio, ou o attempt foi limpo em outra aba) — sobrescrever
            // pelo storage descartaria a resposta que o aluno vê marcada.
            selectedAnswers = { ...(attempt?.selectedAnswers || {}), ...selectedAnswers };

            let correctCount = 0;
            questions.forEach((q, index) => { if (selectedAnswers[index] === q.correct) correctCount++; });
            const score = Math.round((correctCount / questions.length) * 100) / 10;
            const erros = getDetailedIncorrectAnswers(subjectId, themeId);
            const answerSnapshot = buildAnswerSnapshot(subjectId, themeId);
            const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

            if (auto) showWarning('Tempo esgotado! Sua avaliação foi enviada com as respostas selecionadas.');
            showForm(score, erros, answerSnapshot, durationSeconds);
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

            stopQuizTimer();
            const attempt = loadQuizAttempt(subjectId, themeId);
            const startedAt = attempt?.startedAt || Date.now();
            const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

            let correctCount = 0;
            questions.forEach((q, index) => { if (selectedAnswers[index] === q.correct) correctCount++; });
            const score = Math.round((correctCount / questions.length) * 100) / 10;
            const erros = getDetailedIncorrectAnswers(subjectId, themeId);
            const answerSnapshot = buildAnswerSnapshot(subjectId, themeId);
            showForm(score, erros, answerSnapshot, durationSeconds);
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
                // -1 (e não null) para não respondida: o Realtime Database
                // apaga chaves com null, e o detalhe do Histórico leria
                // `selected` como undefined.
                selected: index in selectedAnswers ? selectedAnswers[index] : -1
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

        function showForm(score, erros = '', answerSnapshot = [], durationSeconds = null) {
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

            newSubmitButton.onclick = function(e) { e.preventDefault(); submitForm(score, erros, answerSnapshot, false, durationSeconds); };
        }

        function submitForm(score, erros = '', answerSnapshot = [], skipLowRatingCheck = false, durationSeconds = null) {
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
                window.UniAdmin.StudentAuth.openModal({ intent: 'assessment', onSuccess: () => submitForm(score, erros, answerSnapshot, false, durationSeconds) });
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
                    onConfirm: () => submitForm(score, erros, answerSnapshot, true, durationSeconds)
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
                deadlineStatus,
                durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null
            };

            // Trava de tentativas (js/attempts.js): só conta para aluno logado
            // (Estágios não tem conta para associar o contador). Reprovação
            // soma 1 tentativa; aprovação zera o contador do curso.
            const updateAttemptsCounter = async () => {
                if (freeName || !session || !window.UniAdmin?.Attempts) return { locked: false };
                const A = window.UniAdmin.Attempts;
                if (score >= 8) { await A.resetOnPass(session.userId, currentCategorySlug, currentTrainingId, currentThemeId); return { locked: false }; }
                return A.registerFailedAttempt(session.userId, currentCategorySlug, currentTrainingId, currentThemeId);
            };

            const finishSubmit = () => {
                loadingSpinner.style.display = 'none';
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
                // Tentativa concluída e registrada: libera o localStorage. Só
                // agora, pois falha no envio deve manter o estado para retry.
                clearQuizAttempt(currentTrainingId, currentThemeId);
                updateAttemptsCounter().then(attemptsState => showResult(score, attemptsState));
            };

            // Promise.resolve().then(...) para que a checagem de conexão, que
            // lança de forma síncrona, caia no mesmo .catch() dos erros de
            // gravação em vez de escapar da função.
            Promise.resolve()
                .then(() => (freeName
                    ? saveEstagioResult({ name: name.value, email: email.value, ...resultPayload })
                    : saveLoggedResult({ session, ...resultPayload })))
                .then(() => {
                    // Avisa as Configurações (cache do Histórico) de que há
                    // resultado novo — relevante quando aluno e administrador
                    // usam a mesma aba do navegador.
                    document.dispatchEvent(new CustomEvent('uniadmin:results-changed'));
                })
                .then(finishSubmit)
                .catch((error) => {
                    console.error('Erro ao salvar resultado:', error);
                    showWarning(error?.message?.includes('Sem conexão')
                        ? error.message
                        : 'Não foi possível registrar sua avaliação. Tente novamente.');
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
            // Sem rede, o SDK aceitaria a escrita e a resolveria contra o cache
            // local: o aluno veria "avaliação registrada" para algo que ainda
            // não saiu do navegador. Falhar aqui devolve o erro ao fluxo de
            // submissão, que reabilita o botão e pede para tentar de novo.
            U.Connection?.assertOnline();
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

        function showResult(score, attemptsState = null) {
            const locked = !!attemptsState?.locked;
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

            if (score < 8 && locked) {
                // 3ª reprovação: sem botão de tentar de novo, só o aviso de
                // que precisa de liberação do administrador.
                const lockCard = document.createElement('div');
                lockCard.className = 'attempts-locked-card attempts-locked-card--inline';
                const limit = window.UniAdmin?.Attempts?.limitFor(attemptsState) || 3;
                lockCard.innerHTML = `
                    <div class="attempts-locked-icon"><i class="fas fa-lock"></i></div>
                    <p><strong>Limite de ${limit} tentativas atingido.</strong></p>
                    <p>Fale com um administrador para liberar novas tentativas.</p>`;
                resultContainer.appendChild(lockCard);
            } else if (score < 8) {
                const p = document.createElement('p');
                p.textContent = 'Você não atingiu a nota mínima. Tente novamente!';
                p.style.color = 'var(--text-muted)';
                resultContainer.appendChild(p);
                const retryBtn = document.createElement('button');
                retryBtn.id = 'retry-btn';
                retryBtn.style.display = 'inline-block';
                retryBtn.innerHTML = '<i class="fas fa-redo" style="margin-right:8px;"></i>Tentar Novamente';
                retryBtn.onclick = () => openQuizGuarded(currentTrainingId, currentThemeId);
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
                // Aprovado: encerra de vez o contador de tempo do curso antes
                // de sincronizar, para o activeMs final já incluir esta
                // última sessão e não voltar a contar se o aluno reabrir o
                // curso só para revisar módulos.
                finishActiveCourseTimer(currentTrainingId, currentThemeId);
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
            stopQuizTimer();
            video.src = '';
            video.style.display = 'none';
            pdfContainer.style.display = 'none';
            pdfCanvas.width = 0;
            pdfCanvas.height = 0;
            pdfNavigation.innerHTML = '';
            titleEl.style.display = 'none';
            captionEl.style.display = 'none';
            attachmentContainer.style.display = 'none';
            // Some por padrão: fica vazio (fundo escuro + module-info branco
            // colapsados) atrás de quiz/resultado/formulário, criando um 2º
            // container fantasma acima. loadModule() reexibe explicitamente
            // ao voltar para vídeo/PDF.
            if (playerCard) playerCard.style.display = 'none';
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
