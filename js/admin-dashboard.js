// Dashboard (Configurações): indicadores por colaborador e por curso,
// usando Chart.js. Também abriga a ação "Desconsiderar atraso" (perdão de
// prazo), para não duplicar UI de listagem de resultados em outro lugar.
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, db = U.db, dbRoot = U.dbRoot;
    const showWarning = U.showWarning, showConfirm = U.showConfirm;
    const normalizeName = U.normalizeName;

    const CATEGORY_LABELS = { treinamentos: 'Treinamentos', educacao_continuada: 'Educação Continuada', estagios: 'Estágios' };
    const CHART_COLORS = {
        accent: '#4f8ef7', success: '#10b981', danger: '#ef4444', warning: '#f59e0b',
        muted: '#94a3b8', purple: '#8b5cf6'
    };

    let initialized = false;
    let allUsers = {};
    // Linhas do histórico (mesma fonte que a aba Histórico: results/byUser +
    // estagiosLivre + imported, já com nomes de assunto/tema resolvidos) —
    // o dashboard não lê mais results/byUser diretamente, para não ficar
    // dessincronizado dos dados que o histórico mostra (ex.: registros
    // importados de planilha antiga ficavam de fora dos gráficos).
    let historyRows = [];
    let allTrainingData = {}; // allTrainingData[slug] = trainingData
    let allQuizData = {};     // allQuizData[slug] = quizData (contagem de questões nos cards)
    const chartInstances = {};

    function destroyChart(key) {
        if (chartInstances[key]) { chartInstances[key].destroy(); delete chartInstances[key]; }
    }

    function renderChart(key, canvasId, config) {
        destroyChart(key);
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        chartInstances[key] = new Chart(canvas, config);
    }

    // ─── Carga inicial (uma vez por sessão do painel) ───
    async function loadBaseData() {
        const slugs = Object.keys(CATEGORY_LABELS);
        const [usersSnap, rows, ...snaps] = await Promise.all([
            get(ref(db, `/${dbRoot}/users`)),
            U.getHistoryRows(),
            ...slugs.map(slug => get(ref(db, `/${dbRoot}/${slug}/trainingData`))),
            ...slugs.map(slug => get(ref(db, `/${dbRoot}/${slug}/quizData`)))
        ]);
        allUsers = usersSnap.exists() ? usersSnap.val() : {};
        historyRows = rows;
        allTrainingData = {};
        allQuizData = {};
        slugs.forEach((slug, i) => {
            allTrainingData[slug] = snaps[i].exists() ? snaps[i].val() : {};
            allQuizData[slug] = snaps[slugs.length + i].exists() ? snaps[slugs.length + i].val() : {};
        });
    }

    // ─── Modo: por colaborador ───
    const userSearchInput = document.getElementById('cfg-dash-user-search');
    const userPopover = document.getElementById('cfg-dash-user-popover');
    let selectedUserId = null;

    function renderUserPopover(term) {
        const query = normalizeName(term);
        const matches = Object.keys(allUsers)
            .map(userId => ({ userId, ...allUsers[userId] }))
            .filter(u => u.fullName && (!query || normalizeName(u.fullName).includes(query)))
            .sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'))
            .slice(0, 30);

        userPopover.innerHTML = '';
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'student-name-popover-empty';
            empty.textContent = 'Nenhum colaborador encontrado.';
            userPopover.appendChild(empty);
        } else {
            matches.forEach(u => {
                const item = document.createElement('div');
                item.className = 'student-name-popover-item';
                item.textContent = u.fullName;
                item.onclick = () => {
                    userSearchInput.value = u.fullName;
                    selectedUserId = u.userId;
                    userPopover.classList.remove('active');
                    renderUserDashboard(u.userId);
                };
                userPopover.appendChild(item);
            });
        }
        userPopover.classList.add('active');
    }

    userSearchInput?.addEventListener('input', () => { selectedUserId = null; renderUserPopover(userSearchInput.value); });
    userSearchInput?.addEventListener('focus', () => renderUserPopover(userSearchInput.value));
    document.addEventListener('click', (event) => {
        if (userPopover && !userPopover.contains(event.target) && event.target !== userSearchInput) {
            userPopover.classList.remove('active');
        }
    });

    function flattenUserResults(userId) {
        return historyRows
            .filter(r => r.userId === userId)
            .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
    }

    function renderUserDashboard(userId) {
        document.getElementById('cfg-dash-empty').style.display = 'none';
        document.getElementById('cfg-dash-user-panel').style.display = 'flex';

        const rows = flattenUserResults(userId);
        const labels = rows.map(r => new Date(r.submittedAt || 0).toLocaleDateString('pt-BR'));
        const scores = rows.map(r => r.score);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        renderChart('userScores', 'cfg-dash-user-scores-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { type: 'bar', label: 'Nota', data: scores, backgroundColor: CHART_COLORS.accent, borderRadius: 4 },
                    { type: 'line', label: 'Média', data: labels.map(() => avg), borderColor: CHART_COLORS.danger, borderDash: [6, 4], pointRadius: 0 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 10 } } }
        });

        const onTime = rows.filter(r => r.deadlineStatus === 'on_time' || r.deadlineStatus === 'livre' || r.deadlineStatus === 'forgiven').length;
        const late = rows.length - onTime;
        renderChart('userDeadline', 'cfg-dash-user-deadline-chart', {
            type: 'pie',
            data: { labels: ['No prazo', 'Fora do prazo'], datasets: [{ data: [onTime, late], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false }
        });

        const approved = rows.filter(r => r.approved).length;
        const reproved = rows.length - approved;
        renderChart('userApproval', 'cfg-dash-user-approval-chart', {
            type: 'pie',
            data: { labels: ['Aprovação', 'Reprovação'], datasets: [{ data: [approved, reproved], backgroundColor: [CHART_COLORS.success, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    // ─── Modo: por curso ───
    // A categoria não é mais escolhida aqui: vale sempre a que está selecionada
    // nas Configurações. O tema (assunto-pai) vem de um popover e os assuntos
    // do tema aparecem como cards, no mesmo formato da plataforma do aluno.
    const subjectTrigger = document.getElementById('cfg-dash-subject-trigger');
    const subjectPopover = document.getElementById('cfg-dash-subject-popover');
    const subjectLabel = document.getElementById('cfg-dash-subject-label');
    const categoryLabel = document.getElementById('cfg-dash-category-label');
    const courseCardsBox = document.getElementById('cfg-dash-course-cards');

    let selectedSubjectId = null;
    let selectedCourseKey = null;

    function currentSlug() {
        return U.currentCategorySlug || 'treinamentos';
    }

    function currentTrainingData() {
        return allTrainingData[currentSlug()] || {};
    }

    function orderedSubjectIds() {
        const trainingData = currentTrainingData();
        return Object.keys(trainingData)
            .sort((a, b) => (trainingData[a]?.name || a).localeCompare(trainingData[b]?.name || b, 'pt-BR'));
    }

    function orderedThemes(subjectId) {
        const themes = currentTrainingData()[subjectId]?.themes || {};
        return Object.keys(themes)
            .map(themeId => ({ id: themeId, ...themes[themeId] }))
            .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'pt-BR'));
    }

    function updateCategoryChip() {
        const slug = currentSlug();
        const name = U.currentCategoryName || CATEGORY_LABELS[slug] || slug;
        if (categoryLabel) categoryLabel.textContent = name;
    }

    function closeSubjectPopover() {
        subjectPopover?.classList.remove('active');
        subjectTrigger?.classList.remove('is-open');
    }

    function renderSubjectPopover() {
        subjectPopover.innerHTML = '';
        const subjectIds = orderedSubjectIds();
        if (subjectIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dash-theme-popover-empty';
            empty.textContent = 'Nenhum tema cadastrado nesta categoria.';
            subjectPopover.appendChild(empty);
        } else {
            subjectIds.forEach(subjectId => {
                const subject = currentTrainingData()[subjectId] || {};
                const count = Object.keys(subject.themes || {}).length;
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'dash-theme-popover-item';
                if (subjectId === selectedSubjectId) item.classList.add('is-selected');
                item.innerHTML = `<span class="dash-theme-popover-name">${escapeHtml(subject.name || subjectId)}</span>
                    <span class="dash-theme-popover-count">${count} ${count === 1 ? 'assunto' : 'assuntos'}</span>`;
                item.onclick = () => {
                    selectSubject(subjectId);
                    closeSubjectPopover();
                };
                subjectPopover.appendChild(item);
            });
        }
        subjectPopover.classList.add('active');
        subjectTrigger?.classList.add('is-open');
    }

    subjectTrigger?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (subjectPopover.classList.contains('active')) closeSubjectPopover();
        else renderSubjectPopover();
    });
    document.addEventListener('click', (event) => {
        if (subjectPopover && !subjectPopover.contains(event.target) && !subjectTrigger?.contains(event.target)) {
            closeSubjectPopover();
        }
    });

    function selectSubject(subjectId) {
        selectedSubjectId = subjectId;
        selectedCourseKey = null;
        const subject = currentTrainingData()[subjectId] || {};
        subjectLabel.textContent = subject.name || subjectId;
        document.getElementById('cfg-dash-course-panel').style.display = 'none';
        renderCourseCards();
    }

    // Números do card: quantos fizeram, média e aprovação — do mesmo
    // historyRows usado pelos gráficos, para não divergir.
    function courseStats(subjectId, themeId) {
        const rows = fetchCourseResults(currentSlug(), subjectId, themeId);
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const approved = rows.filter(r => r.approved).length;
        return {
            attempts: rows.length,
            avg,
            approvalPct: rows.length ? Math.round((approved / rows.length) * 100) : null
        };
    }

    function themeInitials(name) {
        return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
    }

    function buildCourseCard(subjectId, theme) {
        const slug = currentSlug();
        const courseKey = `${subjectId}_${theme.id}`;
        const stats = courseStats(subjectId, theme.id);
        const modules = (theme.modules || []).length;
        const questions = (allQuizData[slug]?.[courseKey] || []).length;

        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'dash-course-card';
        if (courseKey === selectedCourseKey) card.classList.add('is-selected');

        const thumb = document.createElement('div');
        thumb.className = 'dash-course-thumb';
        const imageSrc = window.UniAdminImages
            ? window.UniAdminImages.resolve(slug, subjectId, theme.id, theme)
            : (theme.image || null);
        if (imageSrc) {
            const img = document.createElement('img');
            img.src = imageSrc;
            img.alt = theme.name || '';
            img.loading = 'lazy';
            img.onerror = () => { thumb.textContent = themeInitials(theme.name); };
            thumb.appendChild(img);
        } else {
            thumb.textContent = themeInitials(theme.name);
        }

        const body = document.createElement('div');
        body.className = 'dash-course-body';
        body.innerHTML = `
            <h3>${escapeHtml(theme.name || theme.id)}</h3>
            <p class="dash-course-desc${theme.description ? '' : ' is-empty'}">${escapeHtml(theme.description || 'Sem descrição cadastrada para este curso.')}</p>
            <div class="dash-course-meta">
                <span><i class="fas fa-play-circle"></i> ${modules} ${modules === 1 ? 'módulo' : 'módulos'}</span>
                <span><i class="fas fa-clipboard-list"></i> ${questions} ${questions === 1 ? 'questão' : 'questões'}</span>
            </div>
            <div class="dash-course-stats">
                <span><i class="fas fa-users"></i> ${stats.attempts} ${stats.attempts === 1 ? 'realização' : 'realizações'}</span>
                <span><i class="fas fa-star"></i> Média ${stats.avg === null ? '—' : stats.avg.toFixed(1).replace('.', ',')}</span>
                <span><i class="fas fa-circle-check"></i> ${stats.approvalPct === null ? '—' : stats.approvalPct + '% aprovação'}</span>
            </div>`;

        card.appendChild(thumb);
        card.appendChild(body);
        card.onclick = () => {
            selectedCourseKey = courseKey;
            courseCardsBox.querySelectorAll('.dash-course-card').forEach(c => c.classList.remove('is-selected'));
            card.classList.add('is-selected');
            renderCourseDashboard(slug, courseKey);
        };
        return card;
    }

    function renderCourseCards() {
        if (!courseCardsBox) return;
        courseCardsBox.innerHTML = '';
        const inCourseMode = document.getElementById('cfg-dash-course-picker')?.style.display !== 'none';
        if (!selectedSubjectId || !inCourseMode) { courseCardsBox.style.display = 'none'; return; }

        const themes = orderedThemes(selectedSubjectId);
        courseCardsBox.style.display = themes.length ? 'grid' : 'block';
        // Com os cards na tela o estado vazio vira ruído: o próprio grid já diz
        // o que falta fazer (escolher um assunto).
        const empty = document.getElementById('cfg-dash-empty');
        if (empty) empty.style.display = 'none';
        if (themes.length === 0) {
            courseCardsBox.innerHTML = '<p class="dashboard-table-empty">Nenhum assunto cadastrado neste tema.</p>';
            return;
        }
        themes.forEach(theme => courseCardsBox.appendChild(buildCourseCard(selectedSubjectId, theme)));
    }

    // Troca de categoria nas Configurações: o dashboard acompanha.
    document.addEventListener('uniadmin:category-changed', () => {
        selectedSubjectId = null;
        selectedCourseKey = null;
        if (subjectLabel) subjectLabel.textContent = 'Selecione um tema';
        closeSubjectPopover();
        updateCategoryChip();
        renderCourseCards();
        const panel = document.getElementById('cfg-dash-course-panel');
        if (panel) panel.style.display = 'none';
    });

    // Linhas do curso selecionado — casadas por IDs (contas reais e
    // estágios livres, que têm subjectId/themeId) ou, na falta deles, pelo
    // nome normalizado de assunto/tema (registros importados de planilha,
    // que não têm vínculo com trainingData).
    function fetchCourseResults(slug, subjectId, themeId) {
        const theme = allTrainingData[slug]?.[subjectId]?.themes?.[themeId];
        const subject = allTrainingData[slug]?.[subjectId];
        const nameKey = theme ? normalizeName(`${subject?.name || ''}|${theme.name || ''}`) : null;

        return historyRows.filter(r => {
            if (r.slug !== slug) return false;
            if (r.subjectId && r.themeId) return r.subjectId === subjectId && r.themeId === themeId;
            return nameKey && normalizeName(`${r.subject}|${r.theme}`) === nameKey;
        });
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function renderCommentsTable(rows) {
        const container = document.getElementById('cfg-dash-course-comments');
        const withComments = rows.filter(r => r.comment);
        if (withComments.length === 0) {
            container.innerHTML = '<p class="dashboard-table-empty">Nenhum comentário registrado para este curso.</p>';
            return;
        }
        container.innerHTML = `<table>
            <thead><tr><th>Nome</th><th>Nota</th><th>Comentário</th></tr></thead>
            <tbody>${withComments.map(r => `
                <tr><td>${escapeHtml(r.fullName)}</td><td>${r.rating || '—'}/5 ★</td><td>${escapeHtml(r.comment)}</td></tr>
            `).join('')}</tbody>
        </table>`;
    }

    function renderReprovalsTable(rows, slug, subjectId, themeId) {
        const container = document.getElementById('cfg-dash-course-reprovals');
        const reproved = rows.filter(r => !r.approved);
        if (reproved.length === 0) {
            container.innerHTML = '<p class="dashboard-table-empty">Nenhuma reprovação registrada para este curso.</p>';
            return;
        }
        container.innerHTML = `<table>
            <thead><tr><th>Nome</th><th>Nota</th><th>Data</th><th>Status do prazo</th><th></th></tr></thead>
            <tbody>${reproved.map(r => {
                const dateLabel = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('pt-BR') : '—';
                const statusLabel = U.Deadlines.STATUS_LABELS[r.deadlineStatus] || r.deadlineStatus || '—';
                const canForgive = r.userId && (r.deadlineStatus === 'late' || r.deadlineStatus === 'closed');
                return `<tr>
                    <td>${escapeHtml(r.fullName)}</td><td>${r.score}/10</td><td>${dateLabel}</td><td>${escapeHtml(statusLabel)}</td>
                    <td>${canForgive ? `<button class="dash-forgive-btn" data-user-id="${escapeHtml(r.userId)}" data-slug="${slug}" data-subject-id="${subjectId}" data-theme-id="${themeId}">Desconsiderar atraso</button>` : ''}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;

        container.querySelectorAll('.dash-forgive-btn').forEach(btn => {
            btn.addEventListener('click', () => handleForgiveDeadline(btn.dataset));
        });
    }

    async function handleForgiveDeadline({ userId, slug, subjectId, themeId }) {
        const confirmed = await showConfirm({
            title: 'Desconsiderar atraso',
            message: 'O status de prazo deste resultado passa a ser "Atraso desconsiderado".',
            icon: 'fa-calendar-check',
            tone: 'neutral',
            confirmText: 'Confirmar'
        });
        if (!confirmed) return;

        try {
            const updates = {};
            updates[`/${dbRoot}/results/byUser/${userId}/${slug}/${subjectId}/${themeId}/deadlineStatus`] = 'forgiven';
            updates[`/${dbRoot}/results/byCourse/${slug}/${subjectId}/${themeId}/${userId}/deadlineStatus`] = 'forgiven';
            await db.ref().update(updates);
            showWarning('Atraso desconsiderado com sucesso.');
            historyRows = await U.refreshHistoryRows();
            renderCourseCards();
            renderCourseDashboard(slug, `${subjectId}_${themeId}`);
        } catch (error) {
            showWarning('Erro ao atualizar o resultado: ' + error.message);
        }
    }

    async function renderCourseDashboard(slug, courseKey) {
        const [subjectId, themeId] = courseKey.split('_');
        document.getElementById('cfg-dash-empty').style.display = 'none';
        document.getElementById('cfg-dash-course-panel').style.display = 'flex';

        const rows = await fetchCourseResults(slug, subjectId, themeId);

        const ratingCounts = [1, 2, 3, 4, 5].map(star => rows.filter(r => r.rating === star).length);
        renderChart('courseSatisfaction', 'cfg-dash-course-satisfaction-chart', {
            type: 'bar',
            data: { labels: ['1★', '2★', '3★', '4★', '5★'], datasets: [{ data: ratingCounts, backgroundColor: CHART_COLORS.warning, borderRadius: 4 }] },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } } }
        });

        // "Realização do curso": denominador = total de usuários cadastrados
        // (decisão registrada no plano — sem campo de público-alvo por curso).
        const totalUsers = Object.keys(allUsers).length;
        const realizou = rows.filter(r => r.userId).length; // só contas reais entram no denominador de usuários
        const faltaram = Math.max(0, totalUsers - realizou);
        renderChart('courseCompletion', 'cfg-dash-course-completion-chart', {
            type: 'pie',
            data: { labels: ['Realizou', 'Falta'], datasets: [{ data: [realizou, faltaram], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false }
        });

        const onTime = rows.filter(r => ['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)).length;
        const late = rows.length - onTime;
        renderChart('courseDeadline', 'cfg-dash-course-deadline-chart', {
            type: 'pie',
            data: { labels: ['No prazo', 'Fora do prazo'], datasets: [{ data: [onTime, late], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false }
        });

        renderCommentsTable(rows);
        renderReprovalsTable(rows, slug, subjectId, themeId);
    }

    // ─── Alternância de modo ───
    const modeUserBtn = document.getElementById('cfg-dash-mode-user');
    const modeCourseBtn = document.getElementById('cfg-dash-mode-course');

    function setDashMode(mode) {
        modeUserBtn.classList.toggle('active', mode === 'user');
        modeCourseBtn.classList.toggle('active', mode === 'course');
        document.getElementById('cfg-dash-user-picker').style.display = mode === 'user' ? 'flex' : 'none';
        document.getElementById('cfg-dash-course-picker').style.display = mode === 'course' ? 'flex' : 'none';
        document.getElementById('cfg-dash-user-panel').style.display = 'none';
        document.getElementById('cfg-dash-course-panel').style.display = 'none';
        document.getElementById('cfg-dash-empty').style.display = 'flex';
        closeSubjectPopover();
        if (mode === 'course') { updateCategoryChip(); renderCourseCards(); }
        else if (courseCardsBox) { courseCardsBox.style.display = 'none'; }
    }
    modeUserBtn?.addEventListener('click', () => setDashMode('user'));
    modeCourseBtn?.addEventListener('click', () => setDashMode('course'));

    async function initDashboard() {
        if (!initialized) {
            initialized = true;
            setDashMode('user');
        }
        try {
            await loadBaseData();
            // Os cards leem allTrainingData/allQuizData, só disponíveis depois
            // de loadBaseData() — renderizar antes deixava a lista vazia no
            // primeiro carregamento (nada para escolher, dashboard em branco).
            updateCategoryChip();
            if (selectedSubjectId && !currentTrainingData()[selectedSubjectId]) {
                selectedSubjectId = null; selectedCourseKey = null;
                subjectLabel.textContent = 'Selecione um tema';
            }
            renderCourseCards();
            if (selectedCourseKey) renderCourseDashboard(currentSlug(), selectedCourseKey);
            if (selectedUserId) renderUserDashboard(selectedUserId);
        } catch (error) {
            showWarning('Erro ao carregar dados do dashboard: ' + error.message);
        }
    }
    U.initDashboard = initDashboard;
})();
