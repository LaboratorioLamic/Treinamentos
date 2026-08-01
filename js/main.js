        let trainingData = {};
        let quizData = {};
        let orderData = {};
        let quizStatus = {};
        let nameOptions = [];

        // Categoria escolhida na home (index.html). Sem escolha, cai em Treinamentos.
        const CATEGORY_PATHS = {
            'Treinamentos': 'treinamentos',
            'Educação Continuada': 'educacao_continuada',
            'Estágios': 'treinamentos'
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
            const url = 'https://script.google.com/macros/s/AKfycbzUd6efhfzkCmYd88_eIIL6dGIQxIINsw-6Y_qM3PRemUbZ06obtF9xKY1S8WRfvXyq9Q/exec';
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                const names = await response.json();
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
                const data = await response.json();
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
        const themeDropdownContent = document.getElementById('themeDropdownContent');
        const themeDropdownList = document.getElementById('themeDropdownList');
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
        }

        function saveProgression() {
            localStorage.setItem('completionStatus', JSON.stringify(completionStatus));
            localStorage.setItem('assessmentResults', JSON.stringify(assessmentResults));
        }

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
            themeDropdownContent.style.display = 'none';
            themeDropdownList.innerHTML = '';
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
                const subjectLi = document.createElement('li');
                subjectLi.className = 'subject';
                subjectLi.dataset.subjectId = subject.id;
                subjectLi.textContent = subject.name;
                subjectLi.onclick = (e) => {
                    e.stopPropagation();
                    btn.textContent = subject.name;
                    dropdownContent.style.display = 'none';
                    currentTrainingId = subject.id;
                    populateThemeDropdown(subject.id);
                    themeBtn.textContent = 'Escolha um Assunto';
                    contentDiv.style.display = 'none';
                    document.getElementById('welcome-screen').style.display = 'flex';
                    resetContent();
                };
                dropdownList.appendChild(subjectLi);
            });
        }

        function populateThemeDropdown(subjectId) {
            themeDropdownList.innerHTML = '';
            const themes = trainingData[subjectId].themes;
            const themeArray = Object.keys(themes)
                .filter(id => themes[id] && themes[id].name && themes[id].name.trim() !== '')
                .map(id => ({ id, ...themes[id] }));
            const sortedThemes = sortItems(themeArray, orderData.themes?.[subjectId], 'id');
            sortedThemes.forEach(({item: theme}) => {
                const themeLi = document.createElement('li');
                themeLi.className = 'theme';
                themeLi.dataset.themeId = theme.id;
                themeLi.textContent = theme.name;
                themeLi.onclick = (e) => {
                    e.stopPropagation();
                    themeBtn.textContent = theme.name;
                    themeDropdownContent.style.display = 'none';
                    loadTraining(subjectId, theme.id);
                };
                themeDropdownList.appendChild(themeLi);
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
            dropdownContent.style.display = dropdownContent.style.display === 'block' ? 'none' : 'block';
        };

        themeBtn.onclick = (e) => {
            e.stopPropagation();
            if (!currentTrainingId) { showWarning('Selecione o Tema primeiro.'); return; }
            themeDropdownContent.style.display = themeDropdownContent.style.display === 'block' ? 'none' : 'block';
        };

        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !dropdownContent.contains(e.target)) dropdownContent.style.display = 'none';
            if (!themeBtn.contains(e.target) && !themeDropdownContent.contains(e.target)) themeDropdownContent.style.display = 'none';
        });

        function loadTraining(subjectId, themeId) {
            if (!subjectId || !themeId) return;
            currentTrainingId = subjectId;
            currentThemeId = themeId;
            const theme = trainingData[subjectId].themes[themeId];
            if (!theme || !theme.modules || theme.modules.length === 0) return;

            document.getElementById('welcome-screen').style.display = 'none';
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
                if (typeof ytPlayer !== 'undefined' && ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
                customPlayerContainer.style.display = 'none';
                video.style.display = 'none';
                video.src = '';
                pdfContainer.style.display = 'none';
                document.body.classList.remove('cinema-active');
                loadQuiz(subjectId, themeId);
            };
            modulesDiv.appendChild(assessmentDiv);
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
            const score = Math.round((correctCount / questions.length) * 10);
            const erros = getDetailedIncorrectAnswers(subjectId, themeId);
            showForm(score, erros);
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

        function showForm(score, erros = '') {
            resetContent();
            formContainer.style.display = 'flex';
            const submitButton = document.getElementById('submit-form');
            const loadingSpinner = document.getElementById('loading-spinner');
            const newSubmitButton = submitButton.cloneNode(true);
            submitButton.parentNode.replaceChild(newSubmitButton, submitButton);
            loadingSpinner.style.display = 'none';
            newSubmitButton.disabled = false;
            newSubmitButton.style.opacity = '1';

            const ratingContainer = document.getElementById('rating-container');
            const commentToggleBtn = document.getElementById('comment-toggle-btn');
            const commentSection = document.getElementById('comment-section');
            ratingContainer.style.display = 'block';
            commentToggleBtn.style.display = 'inline-flex';
            commentSection.style.display = 'block';
            commentToggleBtn.innerHTML = '<i class="fas fa-times" style="margin-right:6px;"></i>Fechar Comentário';
            document.getElementById('comment').value = '';

            newSubmitButton.onclick = function(e) { e.preventDefault(); submitForm(score, erros); };
        }

        function submitForm(score, erros = '') {
            const name = document.getElementById('name');
            const email = document.getElementById('email');
            const loadingSpinner = document.getElementById('loading-spinner');
            const submitButton = document.getElementById('submit-form');
            const ratingContainer = document.getElementById('rating-container');
            const commentSection = document.getElementById('comment-section');

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

            const rating = document.querySelector('input[name="rating"]:checked');
            if (!rating) {
                showWarning('Por favor, avalie o curso com estrelas.');
                ratingContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            const commentField = document.getElementById('comment');
            const commentValue = commentField?.value.trim() || '';
            const ratingValue = parseInt(rating.value);
            if (ratingValue <= 4 && !commentValue) {
                showWarning('Escreva um comentário explicando sua avaliação.');
                commentSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                commentField.focus();
                return;
            }

            loadingSpinner.style.display = 'block';
            submitButton.disabled = true;
            submitButton.style.opacity = '0.6';

            const errosSeguros = erros.replace(/\n/g, '').replace(/---/g, ';');

            const data = {
                'dateTime': new Date().toLocaleString('pt-BR'),
                'email': email.value,
                'tema': themeBtn.textContent !== 'Escolha um Assunto' ? themeBtn.textContent : '',
                'assunto': btn.textContent !== 'Escolha um Tema' ? btn.textContent : '',
                'nome': name.value,
                'nota': score,
                'erros': errosSeguros,
                'rating': rating.value,
                'comentario': document.getElementById('comment')?.value.trim() || ''
            };

            fetch('https://script.google.com/macros/s/AKfycbzks7XbkiFoLJyCptsDht7e6K5ZYODkV3oD8xYm6gfHCxdpCrSivjol2tLIQPcemFat/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(data).toString()
            })
            .then(response => response.text())
            .then(() => {
                loadingSpinner.style.display = 'none';
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
                showResult(score);
            })
            .catch(() => {
                loadingSpinner.style.display = 'none';
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
                showResult(score);
            });
        }

        function showResult(score) {
            resetContent();
            contentDiv.style.display = 'block';
            resultContainer.innerHTML = '';

            const scoreCard = document.createElement('div');
            scoreCard.className = 'result-score-card';
            const h2 = document.createElement('h2');
            h2.textContent = `${score}/10`;
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

            addFinalButtons();
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
            h2.textContent = `${score}/10`;
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
            addFinalButtons();
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

        function addFinalButtons() {
            let refazerBtn = document.getElementById('refazer-btn');
            if (!refazerBtn) {
                refazerBtn = document.createElement('button');
                refazerBtn.id = 'refazer-btn';
                refazerBtn.innerHTML = '<i class="fas fa-redo" style="margin-right:8px;"></i>Refazer Avaliação';
                refazerBtn.style.cssText = `
                    background: var(--success); color: white; padding: 11px 22px;
                    border: none; border-radius: var(--radius); cursor: pointer;
                    font-size: 0.9em; font-weight: 600; font-family: 'Inter', sans-serif;
                    transition: all 0.2s; margin: 4px;
                `;
                refazerBtn.onmouseenter = () => { refazerBtn.style.background = 'var(--success-hover)'; refazerBtn.style.transform = 'translateY(-1px)'; };
                refazerBtn.onmouseleave = () => { refazerBtn.style.background = 'var(--success)'; refazerBtn.style.transform = 'none'; };
                refazerBtn.onclick = () => loadQuiz(currentTrainingId, currentThemeId);
                resultContainer.appendChild(refazerBtn);
            }

            let resetCourseBtn = document.getElementById('reset-course-btn');
            if (!resetCourseBtn) {
                resetCourseBtn = document.createElement('button');
                resetCourseBtn.id = 'reset-course-btn';
                resetCourseBtn.innerHTML = '<i class="fas fa-rotate-left" style="margin-right:8px;"></i>Reiniciar Curso';
                resetCourseBtn.style.cssText = `
                    background: transparent; color: var(--danger); padding: 11px 22px;
                    border: 1.5px solid var(--danger); border-radius: var(--radius); cursor: pointer;
                    font-size: 0.9em; font-weight: 600; font-family: 'Inter', sans-serif;
                    transition: all 0.2s; margin: 4px;
                `;
                resetCourseBtn.onmouseenter = () => { resetCourseBtn.style.background = 'var(--danger)'; resetCourseBtn.style.color = 'white'; };
                resetCourseBtn.onmouseleave = () => { resetCourseBtn.style.background = 'transparent'; resetCourseBtn.style.color = 'var(--danger)'; };
                resetCourseBtn.onclick = () => {
                    if (confirm('Reiniciar o curso? Todo o progresso será perdido.')) resetCourseProgression();
                };
                resultContainer.appendChild(resetCourseBtn);
            }
        }
