// Dashboard (Configurações): indicadores por colaborador e por curso,
// usando Chart.js. Também abriga a ação "Desconsiderar atraso" (perdão de
// prazo), para não duplicar UI de listagem de resultados em outro lugar.
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, db = U.db, dbRoot = U.dbRoot;
    const showWarning = U.showWarning, showConfirm = U.showConfirm;
    const normalizeName = U.normalizeName;

    // Formata nota com 1 casa decimal (vírgula), ex.: 8,2/10
    function formatScore(score) {
        const n = Number(score);
        if (!Number.isFinite(n)) return score;
        return n.toFixed(1).replace('.', ',');
    }

    // Balão colorido da nota (mesmo padrão visual do Histórico).
    function scoreBadgeHtml(score) {
        const n = Number(score);
        if (!Number.isFinite(n)) return '—';
        const cls = n >= 8 ? 'is-high' : n >= 6 ? 'is-mid' : 'is-low';
        return `<span class="hist-score ${cls}"><b>${formatScore(n)}</b><small>/10</small></span>`;
    }

    const CATEGORY_LABELS = { treinamentos: 'Treinamentos', educacao_continuada: 'Educação Continuada', estagios: 'Estágios' };
    const CHART_COLORS = {
        accent: '#4f8ef7', success: '#10b981', danger: '#ef4444', warning: '#f59e0b',
        muted: '#94a3b8', purple: '#8b5cf6'
    };

    // Categorias sem público definido por função: estágio é individual, não
    // tem "quem falta fazer" a calcular.
    const AUDIENCE_EXEMPT_SLUGS = ['estagios'];

    let initialized = false;
    let allUsers = {};
    let allColaboradores = {};
    // Linhas do histórico (mesma fonte que a aba Histórico: results/byUser +
    // estagiosLivre + imported, já com nomes de assunto/tema resolvidos) —
    // o dashboard não lê mais results/byUser diretamente, para não ficar
    // dessincronizado dos dados que o histórico mostra (ex.: registros
    // importados de planilha antiga ficavam de fora dos gráficos).
    let historyRows = [];
    let allTrainingData = {}; // allTrainingData[slug] = trainingData
    let allQuizData = {};     // allQuizData[slug] = quizData (contagem de questões nos cards)
    let allProgress = {};     // allProgress[userId][slug][subjectId][themeId] = { total, done, pct, updatedAt }
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
        const [usersSnap, colabsSnap, progressSnap, rows, ...snaps] = await Promise.all([
            get(ref(db, `/${dbRoot}/users`)),
            get(ref(db, `/${dbRoot}/colaboradores`)),
            get(ref(db, `/${dbRoot}/progress/byUser`)),
            U.getHistoryRows(),
            ...slugs.map(slug => get(ref(db, `/${dbRoot}/${slug}/trainingData`))),
            ...slugs.map(slug => get(ref(db, `/${dbRoot}/${slug}/quizData`)))
        ]);
        allUsers = usersSnap.exists() ? usersSnap.val() : {};
        allColaboradores = colabsSnap.exists() ? colabsSnap.val() : {};
        allProgress = progressSnap.exists() ? progressSnap.val() : {};
        historyRows = rows;
        allTrainingData = {};
        allQuizData = {};
        slugs.forEach((slug, i) => {
            allTrainingData[slug] = snaps[i].exists() ? snaps[i].val() : {};
            allQuizData[slug] = snaps[slugs.length + i].exists() ? snaps[slugs.length + i].val() : {};
        });
    }

    // ─── Modo: por colaborador ───
    // Grade de cards (um por colaborador de /colaboradores, a mesma lista
    // que alimenta Usuários), com busca + filtros de unidade/função no
    // mesmo padrão dos chips usados em Usuários/Histórico. Clicar num card
    // abre um modal com histórico + gráficos, espelhando o modal "por curso".
    const userSearchInput = document.getElementById('cfg-dash-user-search');
    const userCardsBox = document.getElementById('cfg-dash-user-cards');
    const userFilterRow = document.getElementById('cfg-dash-user-filter-row');
    const userFilterClear = document.getElementById('cfg-dash-user-filter-clear');
    let selectedUserId = null; // colaboradorId do card/modal aberto
    const userListFilters = { unit: '', role: '' };
    let userSearchTerm = '';

    // Linhas de histórico de um colaborador — casadas pela conta
    // (accountUserId) ou, na falta dela, pelo nome normalizado (mesmo
    // critério de personKeysOfColaborador/personKeysOfRow usado no público
    // dos cursos), para incluir também registros importados sem conta.
    function flattenColaboradorResults(colab) {
        const keys = new Set(personKeysOfColaborador(colab));
        return historyRows
            .filter(r => personKeysOfRow(r).some(key => keys.has(key)))
            .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
    }

    function userCardStats(colab) {
        const rows = flattenColaboradorResults(colab);
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const onTime = rows.filter(r => ['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)).length;
        const late = rows.length - onTime;
        return { rows, avg, attempts: rows.length, late };
    }

    function userFilterOptions(field) {
        const values = new Set();
        Object.values(allColaboradores).forEach(c => { if (c?.[field]) values.add(String(c[field]).trim()); });
        return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    }

    function closeUserFilterPopovers() {
        userFilterRow?.querySelectorAll('.hfilter-chip.is-open').forEach(chip => chip.classList.remove('is-open'));
    }

    function refreshUserFilterChips() {
        ['unit', 'role'].forEach(field => {
            const chip = userFilterRow?.querySelector(`.hfilter-chip[data-field="${field}"]`);
            const label = chip?.querySelector('.hfilter-chip-label');
            if (!label) return;
            label.textContent = userListFilters[field] || label.dataset.default;
            chip.classList.toggle('is-active', !!userListFilters[field]);
        });
        const searchChip = userFilterRow?.querySelector('.hfilter-search-chip');
        searchChip?.classList.toggle('is-active', !!userSearchTerm);
        if (userFilterClear) userFilterClear.style.display = (userListFilters.unit || userListFilters.role) ? 'inline-flex' : 'none';
    }

    function renderUserFilterList(field, searchTerm = '') {
        const listEl = document.getElementById(`cfg-dash-user-filter-${field}-list`);
        if (!listEl) return;
        const term = normalizeName(searchTerm);
        const options = userFilterOptions(field).filter(v => !term || normalizeName(v).includes(term));
        const allLabel = field === 'unit' ? 'Todas' : 'Todas as funções';

        listEl.innerHTML = options.length === 0 && term
            ? '<div class="hfilter-chip-empty">Nada encontrado.</div>'
            : [`<div class="hfilter-chip-item ${!userListFilters[field] ? 'is-selected' : ''}" data-value="">${allLabel}</div>`]
                .concat(options.map(v => `<div class="hfilter-chip-item ${userListFilters[field] === v ? 'is-selected' : ''}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</div>`))
                .join('');

        listEl.querySelectorAll('.hfilter-chip-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                userListFilters[field] = item.dataset.value;
                closeUserFilterPopovers();
                refreshUserFilterChips();
                renderUserCards();
            });
        });
    }

    userFilterRow?.querySelectorAll('.hfilter-chip').forEach(chip => {
        const field = chip.dataset.field;
        const isSearchChip = field === 'search';
        const btn = chip.querySelector('.hfilter-chip-btn');
        const search = chip.querySelector('.hfilter-chip-search');

        btn?.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = chip.classList.contains('is-open');
            closeUserFilterPopovers();
            if (isOpen) return;
            chip.classList.add('is-open');
            if (isSearchChip) { search?.focus(); return; }
            if (search) search.value = '';
            renderUserFilterList(field, '');
            search?.focus();
        });
        chip.addEventListener('click', (event) => event.stopPropagation());
        if (!isSearchChip) search?.addEventListener('input', () => renderUserFilterList(field, search.value));
    });
    document.addEventListener('click', closeUserFilterPopovers);

    userFilterClear?.addEventListener('click', () => {
        userListFilters.unit = '';
        userListFilters.role = '';
        refreshUserFilterChips();
        renderUserCards();
    });

    userSearchInput?.addEventListener('input', () => {
        userSearchTerm = userSearchInput.value;
        refreshUserFilterChips();
        renderUserCards();
    });

    function buildUserCard(colabId, colab) {
        const stats = userCardStats(colab);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'dash-user-card';
        if (colabId === selectedUserId) card.classList.add('is-selected');

        card.innerHTML = `
            ${avatarHtml(colab.fullName)}
            <div class="dash-user-card-body">
                <h3>${escapeHtml(colab.fullName)}</h3>
                <div class="dash-user-card-tags">
                    ${colab.role ? `<span class="dash-user-card-tag"><i class="fas fa-briefcase"></i> ${escapeHtml(colab.role)}</span>` : ''}
                    ${colab.unit ? `<span class="dash-user-card-tag"><i class="fas fa-building"></i> ${escapeHtml(colab.unit)}</span>` : ''}
                </div>
                <div class="dash-user-card-stats">
                    <span><i class="fas fa-clipboard-list"></i> ${stats.attempts} ${stats.attempts === 1 ? 'curso' : 'cursos'}</span>
                    <span><i class="fas fa-star"></i> ${stats.avg === null ? '—' : 'Média ' + stats.avg.toFixed(1).replace('.', ',')}</span>
                    ${stats.late > 0 ? `<span class="is-warn"><i class="fas fa-triangle-exclamation"></i> ${stats.late} ${stats.late === 1 ? 'atraso' : 'atrasos'}</span>` : ''}
                </div>
            </div>`;
        card.onclick = () => {
            selectedUserId = colabId;
            userCardsBox.querySelectorAll('.dash-user-card').forEach(c => c.classList.remove('is-selected'));
            card.classList.add('is-selected');
            openUserModal(colabId, colab);
        };
        return card;
    }

    function renderUserCards() {
        if (!userCardsBox) return;
        const inUserMode = document.getElementById('cfg-dash-user-picker')?.style.display !== 'none';
        const empty = document.getElementById('cfg-dash-empty');
        if (!inUserMode) { userCardsBox.style.display = 'none'; return; }

        const term = normalizeName(userSearchTerm);
        const entries = Object.keys(allColaboradores)
            .map(id => ({ id, colab: allColaboradores[id] }))
            .filter(({ colab }) => colab?.fullName)
            .filter(({ colab }) => !term || normalizeName(colab.fullName).includes(term))
            .filter(({ colab }) => !userListFilters.unit || (colab.unit || '') === userListFilters.unit)
            .filter(({ colab }) => !userListFilters.role || (colab.role || '') === userListFilters.role)
            .sort((a, b) => a.colab.fullName.localeCompare(b.colab.fullName, 'pt-BR'));

        userCardsBox.style.display = entries.length ? 'grid' : 'block';
        if (empty) empty.style.display = 'none';
        if (entries.length === 0) {
            userCardsBox.innerHTML = '<p class="dashboard-table-empty">Nenhum colaborador encontrado.</p>';
            return;
        }
        userCardsBox.innerHTML = '';
        entries.forEach(({ id, colab }) => userCardsBox.appendChild(buildUserCard(id, colab)));
    }

    // ─── Modal do colaborador ───
    const userModal = document.getElementById('cfg-dash-user-modal');
    const userModalTitle = document.getElementById('cfg-dash-user-modal-title');
    const userModalClose = document.getElementById('cfg-dash-user-modal-close');
    const userHeroThumb = document.getElementById('cfg-dash-user-hero-thumb');
    const userHeroTags = document.getElementById('cfg-dash-user-hero-tags');
    const userHeroStats = document.getElementById('cfg-dash-user-hero-stats');

    function closeUserModal() { if (userModal) userModal.style.display = 'none'; }

    function openUserModal(colabId, colab) {
        if (!userModal) return;
        userModalTitle.textContent = colab.fullName || 'Colaborador';
        if (userHeroThumb) userHeroThumb.textContent = themeInitials(colab.fullName);
        if (userHeroTags) {
            userHeroTags.innerHTML = `
                ${colab.role ? `<span class="dash-course-subject-tag"><i class="fas fa-briefcase"></i> ${escapeHtml(colab.role)}</span>` : ''}
                ${colab.unit ? `<span class="dash-course-subject-tag"><i class="fas fa-building"></i> ${escapeHtml(colab.unit)}</span>` : ''}`;
        }

        userModal.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === 0));
        userModal.querySelectorAll('.dash-course-modal-body .tab-content').forEach((tab, i) => tab.classList.toggle('active', i === 0));
        userModal.style.display = 'flex';
        renderUserDashboard(colab, userHeroStats);
    }

    userModal?.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            userModal.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const target = btn.dataset.dashUserTab;
            userModal.querySelectorAll('.dash-course-modal-body .tab-content').forEach(tab => {
                tab.classList.toggle('active', tab.id === `cfg-dash-user-tab-${target}`);
            });
        });
    });
    userModalClose?.addEventListener('click', closeUserModal);
    userModal?.addEventListener('click', (event) => { if (event.target === userModal) closeUserModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && userModal?.style.display === 'flex') closeUserModal();
    });

    function renderUserHistoryTable(rows) {
        const container = document.getElementById('cfg-dash-user-history');
        const countEl = document.getElementById('cfg-dash-user-tabcount-history');
        if (countEl) countEl.textContent = String(rows.length);
        if (!container) return;
        if (rows.length === 0) {
            container.innerHTML = emptyStateHtml('fa-clipboard-list', 'Nenhum curso realizado ainda.');
            return;
        }
        const sorted = rows.slice().sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        container.innerHTML = `<table class="is-sticky">
            <thead><tr><th>Data</th><th>Curso</th><th>Nota</th><th>Prazo</th><th>Situação</th></tr></thead>
            <tbody>${sorted.map((r, i) => {
                const dateLabel = r.submittedAt ? new Date(r.submittedAt).toLocaleString('pt-BR') : '—';
                const situationOk = !!r.approved;
                return `<tr style="--row-i:${i}">
                    <td>${dateLabel}</td>
                    <td>${escapeHtml(r.theme || r.subject || '—')}</td>
                    <td>${scoreBadgeHtml(r.score)}</td>
                    <td>${deadlineBadgeHtml(r.deadlineStatus)}</td>
                    <td><span class="conclusion-situation ${situationOk ? 'is-ok' : 'is-bad'}"><i class="fas ${situationOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${situationOk ? 'Aprovado' : 'Reprovado'}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    function renderUserDashboard(colab, heroStatsEl) {
        const rows = flattenColaboradorResults(colab);
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

        if (heroStatsEl) {
            const avgLabel = scores.length ? avg.toFixed(1).replace('.', ',') : '—';
            heroStatsEl.innerHTML = `
                <span class="hero-stat is-ok"><i class="fas fa-circle-check"></i> ${rows.length} ${rows.length === 1 ? 'curso realizado' : 'cursos realizados'}</span>
                <span class="hero-stat"><i class="fas fa-star"></i> Média ${avgLabel}</span>
                ${late > 0 ? `<span class="hero-stat is-warn"><i class="fas fa-triangle-exclamation"></i> ${late} ${late === 1 ? 'atraso' : 'atrasos'}</span>` : ''}
            `;
        }
        renderUserHistoryTable(rows);
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

    const ALL_SUBJECTS_ID = '__all__';
    let selectedSubjectId = ALL_SUBJECTS_ID;
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
            const totalThemes = subjectIds.reduce((sum, id) => sum + Object.keys(currentTrainingData()[id]?.themes || {}).length, 0);
            const allItem = document.createElement('button');
            allItem.type = 'button';
            allItem.className = 'dash-theme-popover-item';
            if (selectedSubjectId === ALL_SUBJECTS_ID) allItem.classList.add('is-selected');
            allItem.innerHTML = `<span class="dash-theme-popover-name">Todos os temas</span>
                <span class="dash-theme-popover-count">${totalThemes} ${totalThemes === 1 ? 'curso' : 'cursos'}</span>`;
            allItem.onclick = () => {
                selectSubject(ALL_SUBJECTS_ID);
                closeSubjectPopover();
            };
            subjectPopover.appendChild(allItem);

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
        if (subjectId === ALL_SUBJECTS_ID) {
            subjectLabel.textContent = 'Todos os temas';
        } else {
            const subject = currentTrainingData()[subjectId] || {};
            subjectLabel.textContent = subject.name || subjectId;
        }
        closeCourseModal();
        renderCourseCards();
    }

    // ─── Público-alvo do curso (funções configuradas no assunto) ───
    // Sem funções marcadas = todos os colaboradores. A lista base é
    // /colaboradores (espelho da planilha), a mesma que alimenta o seletor
    // de funções do assunto.
    function courseAudience(theme) {
        const roles = Array.isArray(theme?.roles) ? theme.roles.filter(Boolean) : [];
        const roleKeys = new Set(roles.map(role => normalizeName(role)));
        return Object.keys(allColaboradores)
            .map(id => ({ id, ...allColaboradores[id] }))
            .filter(colab => colab.fullName)
            .filter(colab => roleKeys.size === 0 || roleKeys.has(normalizeName(colab.role || '')));
    }

    // Uma pessoa pode aparecer no histórico pela conta (userId) ou só pelo
    // nome (registros importados/sem conta) — as duas chaves são aceitas.
    function personKeysOfRow(row) {
        return [row.userId || null, row.fullName ? normalizeName(row.fullName) : null].filter(Boolean);
    }
    function personKeysOfColaborador(colab) {
        return [colab.accountUserId || null, normalizeName(colab.fullNameKey || colab.fullName || '')].filter(Boolean);
    }

    // Números do card: quantos fizeram, média e aprovação — do mesmo
    // historyRows usado pelos gráficos, para não divergir. Quando a
    // categoria tem público-alvo (tudo menos estágios), também conta
    // quantos do público já realizaram o curso.
    function courseStats(subjectId, theme) {
        const slug = currentSlug();
        const themeId = typeof theme === 'string' ? theme : theme?.id;
        const rows = fetchCourseResults(slug, subjectId, themeId);
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const approved = rows.filter(r => r.approved).length;

        let audienceTotal = null;
        let audienceDone = null;
        if (typeof theme === 'object' && theme && !AUDIENCE_EXEMPT_SLUGS.includes(slug)) {
            const doneKeys = new Set();
            rows.forEach(row => personKeysOfRow(row).forEach(key => doneKeys.add(key)));
            const audience = courseAudience(theme);
            audienceTotal = audience.length;
            audienceDone = audience.filter(colab => personKeysOfColaborador(colab).some(key => doneKeys.has(key))).length;
        }

        return {
            attempts: rows.length,
            avg,
            approvalPct: rows.length ? Math.round((approved / rows.length) * 100) : null,
            audienceTotal,
            audienceDone,
            audiencePct: audienceTotal ? Math.round((audienceDone / audienceTotal) * 100) : null
        };
    }

    // Barra "x de N do público já fizeram" + quem falta. O público vem das
    // funções configuradas no assunto (ou todos, se nenhuma foi marcada).
    function audienceHtml(theme, stats) {
        if (stats.audienceTotal === null) return '';
        const roles = Array.isArray(theme?.roles) ? theme.roles.filter(Boolean) : [];
        const scope = roles.length === 0
            ? 'todas as funções'
            : roles.length === 1 ? roles[0] : `${roles.length} funções`;
        if (stats.audienceTotal === 0) {
            return `<div class="dash-course-audience is-empty">
                <span class="dash-course-audience-label">Nenhum colaborador em ${escapeHtml(scope)}</span>
            </div>`;
        }
        const missing = stats.audienceTotal - stats.audienceDone;
        return `<div class="dash-course-audience">
            <div class="dash-course-audience-top">
                <span class="dash-course-audience-label"><i class="fas fa-user-check"></i> ${stats.audienceDone}/${stats.audienceTotal} assistiram &bull; ${escapeHtml(scope)}</span>
                <strong class="dash-course-audience-pct">${stats.audiencePct}%</strong>
            </div>
            <div class="dash-course-audience-bar"><span style="width:${stats.audiencePct}%"></span></div>
            <span class="dash-course-audience-missing">${missing === 0 ? 'Todos do público já realizaram.' : `${missing} ${missing === 1 ? 'pessoa falta' : 'pessoas faltam'} realizar`}</span>
        </div>`;
    }

    function themeInitials(name) {
        return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
    }

    function buildCourseCard(subjectId, theme, subjectName) {
        const slug = currentSlug();
        const courseKey = `${subjectId}_${theme.id}`;
        const stats = courseStats(subjectId, theme);
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
            ${subjectName ? `<span class="dash-course-subject-tag"><i class="fas fa-layer-group"></i> ${escapeHtml(subjectName)}</span>` : ''}
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
            </div>
            ${audienceHtml(theme, stats)}`;

        card.appendChild(thumb);
        card.appendChild(body);
        card.onclick = () => {
            selectedCourseKey = courseKey;
            courseCardsBox.querySelectorAll('.dash-course-card').forEach(c => c.classList.remove('is-selected'));
            card.classList.add('is-selected');
            openCourseModal(slug, courseKey, theme.name || theme.id, { theme, thumb: imageSrc || null });
        };
        return card;
    }

    function renderCourseCards() {
        if (!courseCardsBox) return;
        courseCardsBox.innerHTML = '';
        const inCourseMode = document.getElementById('cfg-dash-course-picker')?.style.display !== 'none';
        if (!selectedSubjectId || !inCourseMode) { courseCardsBox.style.display = 'none'; return; }

        const empty = document.getElementById('cfg-dash-empty');

        if (selectedSubjectId === ALL_SUBJECTS_ID) {
            const subjectIds = orderedSubjectIds();
            const cards = [];
            subjectIds.forEach(subjectId => {
                const subject = currentTrainingData()[subjectId] || {};
                orderedThemes(subjectId).forEach(theme => cards.push({ subjectId, theme, subjectName: subject.name || subjectId }));
            });
            courseCardsBox.style.display = cards.length ? 'grid' : 'block';
            if (empty) empty.style.display = 'none';
            if (cards.length === 0) {
                courseCardsBox.innerHTML = '<p class="dashboard-table-empty">Nenhum tema cadastrado nesta categoria.</p>';
                return;
            }
            cards.forEach(({ subjectId, theme, subjectName }) => courseCardsBox.appendChild(buildCourseCard(subjectId, theme, subjectName)));
            return;
        }

        const themes = orderedThemes(selectedSubjectId);
        courseCardsBox.style.display = themes.length ? 'grid' : 'block';
        // Com os cards na tela o estado vazio vira ruído: o próprio grid já diz
        // o que falta fazer (escolher um assunto).
        if (empty) empty.style.display = 'none';
        if (themes.length === 0) {
            courseCardsBox.innerHTML = '<p class="dashboard-table-empty">Nenhum assunto cadastrado neste tema.</p>';
            return;
        }
        themes.forEach(theme => courseCardsBox.appendChild(buildCourseCard(selectedSubjectId, theme)));
    }

    // Troca de categoria nas Configurações: o dashboard acompanha.
    document.addEventListener('uniadmin:category-changed', () => {
        selectedSubjectId = ALL_SUBJECTS_ID;
        selectedCourseKey = null;
        if (subjectLabel) subjectLabel.textContent = 'Todos os temas';
        closeSubjectPopover();
        updateCategoryChip();
        renderCourseCards();
        closeCourseModal();
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

    // Estrelas douradas, crescentes da esquerda para a direita (as
    // preenchidas vêm primeiro, as vazias completam até 5).
    function starsHtml(rating) {
        const n = Math.max(0, Math.min(5, Number(rating) || 0));
        let html = '<span class="comment-stars" aria-label="' + n + ' de 5 estrelas">';
        for (let i = 1; i <= 5; i++) {
            html += `<i class="fas fa-star ${i <= n ? 'is-filled' : 'is-empty'}"></i>`;
        }
        html += '</span>';
        return html;
    }

    const COMMENTS_PAGE_SIZE = 5;
    let commentsPage = 1;
    let commentsRowsCache = [];

    function renderCommentsPagination(totalPages) {
        const pager = document.getElementById('cfg-dash-course-comments-pagination');
        if (!pager) return;
        if (totalPages <= 1) { pager.innerHTML = ''; return; }
        let html = `<button type="button" class="comments-page-btn" data-page="prev" ${commentsPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>`;
        html += `<span class="comments-page-info">Página ${commentsPage} de ${totalPages}</span>`;
        html += `<button type="button" class="comments-page-btn" data-page="next" ${commentsPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
        pager.innerHTML = html;
        pager.querySelectorAll('.comments-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                commentsPage += btn.dataset.page === 'prev' ? -1 : 1;
                paintCommentsPage();
            });
        });
    }

    function paintCommentsPage() {
        const container = document.getElementById('cfg-dash-course-comments');
        const rows = commentsRowsCache;
        const totalPages = Math.max(1, Math.ceil(rows.length / COMMENTS_PAGE_SIZE));
        commentsPage = Math.min(Math.max(1, commentsPage), totalPages);
        const start = (commentsPage - 1) * COMMENTS_PAGE_SIZE;
        const pageRows = rows.slice(start, start + COMMENTS_PAGE_SIZE);

        container.innerHTML = `<div class="comment-cards">${pageRows.map(r => {
            const n = Number(r.rating) || 0;
            const ratingClass = n >= 4 ? 'rating-high' : n === 3 ? 'rating-mid' : 'rating-low';
            return `
            <div class="comment-card ${ratingClass}">
                <div class="comment-card-head">
                    <span class="comment-card-name"><i class="fas fa-user-circle"></i> ${escapeHtml(r.fullName)}</span>
                    ${starsHtml(r.rating)}
                </div>
                <p class="comment-card-text">${escapeHtml(r.comment)}</p>
                <span class="comment-card-more" data-action="toggle-comment">Ver mais</span>
            </div>`;
        }).join('')}</div>`;
        container.querySelectorAll('.comment-card-more').forEach(btn => {
            btn.addEventListener('click', () => {
                const text = btn.previousElementSibling;
                const expanded = text.classList.toggle('is-expanded');
                btn.textContent = expanded ? 'Ver menos' : 'Ver mais';
            });
        });
        renderCommentsPagination(totalPages);
    }

    function renderCommentsTable(rows) {
        const container = document.getElementById('cfg-dash-course-comments');
        const pager = document.getElementById('cfg-dash-course-comments-pagination');
        commentsRowsCache = rows.filter(r => r.comment).sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0));
        commentsPage = 1;
        if (commentsRowsCache.length === 0) {
            container.innerHTML = '<p class="dashboard-table-empty">Nenhum comentário registrado para este curso.</p>';
            if (pager) pager.innerHTML = '';
            return;
        }
        paintCommentsPage();
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
                    <td>${escapeHtml(r.fullName)}</td><td>${formatScore(r.score)}/10</td><td>${dateLabel}</td><td>${escapeHtml(statusLabel)}</td>
                    <td>${canForgive ? `<button class="dash-forgive-btn" data-user-id="${escapeHtml(r.userId)}" data-slug="${slug}" data-subject-id="${subjectId}" data-theme-id="${themeId}">Desconsiderar atraso</button>` : ''}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;

        container.querySelectorAll('.dash-forgive-btn').forEach(btn => {
            btn.addEventListener('click', () => handleForgiveDeadline(btn.dataset));
        });
    }

    // ─── Aba Conclusões: quem já concluiu x quem falta ───

    // Avatar com iniciais coloridas (mesmo critério de hash usado no card do
    // curso — cor estável por nome, sem precisar de foto).
    function avatarHtml(name) {
        let hash = 0;
        const str = name || '?';
        for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
        return `<span class="row-avatar" style="--avatar-hue:${hash};">${escapeHtml(themeInitials(name))}</span>`;
    }

    function deadlineBadgeHtml(status) {
        const label = U.Deadlines.STATUS_LABELS[status] || status || '—';
        const toneMap = { on_time: 'is-good', livre: 'is-neutral', forgiven: 'is-neutral', not_started: 'is-neutral', late: 'is-mid', closed: 'is-bad' };
        const tone = toneMap[status] || 'is-neutral';
        const iconMap = { on_time: 'fa-check', late: 'fa-triangle-exclamation', closed: 'fa-ban', forgiven: 'fa-calendar-check' };
        const icon = iconMap[status] || 'fa-circle-minus';
        return `<span class="deadline-pill ${tone}"><i class="fas ${icon}"></i> ${escapeHtml(label)}</span>`;
    }

    // "Concluídos": uma linha por realização, ordenado da mais recente para a
    // mais antiga, com busca por nome e paginação de 5 por página.
    let completedRowsCache = [];
    let completedSearchTerm = '';

    function paintCompletedPage() {
        const container = document.getElementById('cfg-dash-course-completed');
        if (!container) return;
        const filtered = completedSearchTerm
            ? completedRowsCache.filter(r => normalizeName(r.fullName || '').includes(normalizeName(completedSearchTerm)))
            : completedRowsCache;

        if (completedRowsCache.length === 0) {
            container.innerHTML = emptyStateHtml('fa-clipboard-check', 'Ninguém concluiu este curso ainda.');
            return;
        }
        if (filtered.length === 0) {
            container.innerHTML = emptyStateHtml('fa-search', 'Nenhum resultado para essa busca.');
            return;
        }

        container.innerHTML = `<table class="is-sticky">
            <thead><tr><th>Data/Hora</th><th>Nome</th><th>Unidade</th><th>Cargo</th><th>Prazo</th><th>Nota</th><th>Situação</th></tr></thead>
            <tbody>${filtered.map((r, i) => {
                const dateLabel = r.submittedAt ? new Date(r.submittedAt).toLocaleString('pt-BR') : '—';
                const situationOk = !!r.approved;
                return `<tr style="--row-i:${i}">
                    <td>${dateLabel}</td>
                    <td><span class="row-name">${avatarHtml(r.fullName)} ${escapeHtml(r.fullName)}</span></td>
                    <td>${escapeHtml(r.unit || '—')}</td>
                    <td>${escapeHtml(r.role || '—')}</td>
                    <td>${deadlineBadgeHtml(r.deadlineStatus)}</td>
                    <td>${scoreBadgeHtml(r.score)}</td>
                    <td><span class="conclusion-situation ${situationOk ? 'is-ok' : 'is-bad'}"><i class="fas ${situationOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${situationOk ? 'Aprovado' : 'Reprovado'}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    function renderCompletedTable(rows) {
        completedRowsCache = rows.slice().sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        paintCompletedPage();
    }

    document.getElementById('cfg-dash-course-completed-search')?.addEventListener('input', (e) => {
        completedSearchTerm = e.target.value;
        paintCompletedPage();
    });

    // Progresso (%) de um colaborador neste curso, lido de progress/byUser.
    function progressPctFor(colab, slug, subjectId, themeId) {
        const userId = colab.accountUserId;
        if (!userId) return 0;
        const entry = allProgress[userId]?.[slug]?.[subjectId]?.[themeId];
        return entry?.pct || 0;
    }

    function progressToneClass(pct) {
        if (pct >= 75) return 'is-high';
        if (pct >= 40) return 'is-mid';
        return 'is-low';
    }

    function emptyStateHtml(icon, message) {
        return `<div class="dashboard-empty-state"><i class="fas ${icon}"></i><p>${escapeHtml(message)}</p></div>`;
    }

    let missingRowsCache = [];
    let missingSearchTerm = '';

    function paintMissingTable() {
        const container = document.getElementById('cfg-dash-course-missing');
        if (!container) return;
        const filtered = missingSearchTerm
            ? missingRowsCache.filter(m => normalizeName(m.fullName || '').includes(normalizeName(missingSearchTerm)))
            : missingRowsCache;

        if (missingRowsCache.length === 0) {
            container.innerHTML = emptyStateHtml('fa-trophy', 'Todos do público-alvo já concluíram este curso.');
            return;
        }
        if (filtered.length === 0) {
            container.innerHTML = emptyStateHtml('fa-search', 'Nenhum resultado para essa busca.');
            return;
        }

        container.innerHTML = `<table class="is-sticky">
            <thead><tr><th>Nome</th><th>Unidade</th><th>Progresso</th></tr></thead>
            <tbody>${filtered.map((m, i) => `
                <tr style="--row-i:${i}">
                    <td><span class="row-name">${avatarHtml(m.fullName)} ${escapeHtml(m.fullName)}</span></td>
                    <td>${escapeHtml(m.unit)}</td>
                    <td>
                        <div class="missing-progress" title="${m.pct}% assistido">
                            <div class="missing-progress-bar"><span class="${progressToneClass(m.pct)}" style="width:${m.pct}%"></span></div>
                            <span class="missing-progress-pct">${m.pct}%</span>
                        </div>
                    </td>
                </tr>
            `).join('')}</tbody>
        </table>`;
    }

    // "Faltam realizar": público-alvo do curso que ainda não aparece nas
    // realizações (rows), com progresso de módulos assistidos, do maior
    // para o menor.
    function renderMissingTable(rows, slug, subjectId, theme) {
        const container = document.getElementById('cfg-dash-course-missing');
        if (!container) return;

        if (AUDIENCE_EXEMPT_SLUGS.includes(slug)) {
            container.innerHTML = '<p class="dashboard-table-empty">Esta categoria não possui público-alvo definido.</p>';
            missingRowsCache = [];
            return;
        }

        const doneKeys = new Set();
        rows.forEach(row => personKeysOfRow(row).forEach(key => doneKeys.add(key)));
        const audience = courseAudience(theme);
        missingRowsCache = audience
            .filter(colab => !personKeysOfColaborador(colab).some(key => doneKeys.has(key)))
            .map(colab => ({
                fullName: colab.fullName,
                unit: colab.unit || '—',
                pct: progressPctFor(colab, slug, subjectId, theme.id)
            }))
            .sort((a, b) => b.pct - a.pct || a.fullName.localeCompare(b.fullName, 'pt-BR'));

        paintMissingTable();
    }

    document.getElementById('cfg-dash-course-missing-search')?.addEventListener('input', (e) => {
        missingSearchTerm = e.target.value;
        paintMissingTable();
    });

    function handleCopyMissingList() {
        if (missingRowsCache.length === 0) {
            showWarning('Não há colaboradores pendentes para copiar.');
            return;
        }
        const byUnit = new Map();
        missingRowsCache.forEach(m => {
            const unit = m.unit || 'Sem unidade';
            if (!byUnit.has(unit)) byUnit.set(unit, []);
            byUnit.get(unit).push(`${m.fullName} (${m.pct}% completo)`);
        });
        const unitNames = Array.from(byUnit.keys()).sort((a, b) => a.localeCompare(b, 'pt-BR'));
        const text = unitNames.map(unit => `${unit}\n${byUnit.get(unit).join('\n')}`).join('\n\n');

        navigator.clipboard.writeText(text)
            .then(() => showWarning('Lista copiada para a área de transferência.'))
            .catch(() => showWarning('Não foi possível copiar a lista.'));
    }

    document.getElementById('cfg-dash-course-copy-missing')?.addEventListener('click', handleCopyMissingList);

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

        const theme = allTrainingData[slug]?.[subjectId]?.themes?.[themeId];
        renderCompletedTable(rows);
        if (theme) renderMissingTable(rows, slug, subjectId, { id: themeId, ...theme });

        renderCourseHero(rows);
        updateTabCounts(rows);
    }

    // Resumo rápido no topo do modal: concluídos, pendentes e média — dá o
    // panorama do curso sem precisar trocar de aba.
    function renderCourseHero(rows) {
        if (!courseHeroStats) return;
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1).replace('.', ',') : '—';
        const pendentes = missingRowsCache.length;
        courseHeroStats.innerHTML = `
            <span class="hero-stat is-ok"><i class="fas fa-circle-check"></i> ${rows.length} ${rows.length === 1 ? 'concluído' : 'concluídos'}</span>
            <span class="hero-stat is-warn"><i class="fas fa-hourglass-half"></i> ${pendentes} ${pendentes === 1 ? 'pendente' : 'pendentes'}</span>
            <span class="hero-stat"><i class="fas fa-star"></i> Média ${avg}</span>
        `;
    }

    function updateTabCounts(rows) {
        const conclusionsCount = document.getElementById('cfg-dash-course-tabcount-conclusions');
        const infoCount = document.getElementById('cfg-dash-course-tabcount-info');
        if (conclusionsCount) conclusionsCount.textContent = String(rows.length);
        if (infoCount) infoCount.textContent = String(rows.filter(r => r.comment).length);
    }

    // ─── Modal do curso: Informações / Gráficos + Resetar curso ───
    const courseModal = document.getElementById('cfg-dash-course-modal');
    const courseModalTitle = document.getElementById('cfg-dash-course-modal-title');
    const courseModalClose = document.getElementById('cfg-dash-course-modal-close');
    const courseResetBtn = document.getElementById('cfg-dash-course-reset-btn');
    const courseHeroThumb = document.getElementById('cfg-dash-course-hero-thumb');
    const courseHeroStats = document.getElementById('cfg-dash-course-hero-stats');
    let openCourseSlug = null;
    let openCourseKey = null;
    let openCourseName = null;

    function openCourseModal(slug, courseKey, themeName, extra) {
        openCourseSlug = slug;
        openCourseKey = courseKey;
        openCourseName = themeName;
        courseModalTitle.textContent = themeName || 'Curso';

        if (courseHeroThumb) {
            courseHeroThumb.innerHTML = '';
            if (extra?.thumb) {
                const img = document.createElement('img');
                img.src = extra.thumb;
                img.alt = '';
                img.onerror = () => { courseHeroThumb.textContent = themeInitials(themeName); };
                courseHeroThumb.appendChild(img);
            } else {
                courseHeroThumb.textContent = themeInitials(themeName);
            }
        }

        courseModal.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === 0));
        courseModal.querySelectorAll('.dash-course-modal-body .tab-content').forEach((tab, i) => tab.classList.toggle('active', i === 0));
        courseModal.style.display = 'flex';
        renderCourseDashboard(slug, courseKey);
    }

    function closeCourseModal() { courseModal.style.display = 'none'; }

    courseModal?.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            courseModal.querySelectorAll('.dash-course-modal-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const target = btn.dataset.dashCourseTab;
            courseModal.querySelectorAll('.dash-course-modal-body .tab-content').forEach(tab => {
                tab.classList.toggle('active', tab.id === `cfg-dash-course-tab-${target}`);
            });
        });
    });

    courseModalClose?.addEventListener('click', closeCourseModal);
    courseModal?.addEventListener('click', (event) => { if (event.target === courseModal) closeCourseModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && courseModal?.style.display === 'flex') closeCourseModal();
    });

    async function handleResetCourse() {
        if (!openCourseSlug || !openCourseKey) return;
        const [subjectId, themeId] = openCourseKey.split('_');

        const confirmed = await showConfirm({
            title: 'Resetar curso',
            message: `Todo o progresso e as avaliações de "${openCourseName || 'este curso'}" serão apagados para todos os colaboradores. Eles poderão assistir e avaliar o curso novamente. Esta ação não pode ser desfeita.`,
            icon: 'fa-rotate-left',
            requireWord: 'RESETAR',
            confirmText: 'Resetar'
        });
        if (!confirmed) return;

        try {
            const updates = {};
            updates[`/${dbRoot}/results/byCourse/${openCourseSlug}/${subjectId}/${themeId}`] = null;

            const byCourseSnap = await get(ref(db, `/${dbRoot}/results/byCourse/${openCourseSlug}/${subjectId}/${themeId}`));
            if (byCourseSnap.exists()) {
                Object.keys(byCourseSnap.val()).forEach(userId => {
                    updates[`/${dbRoot}/results/byUser/${userId}/${openCourseSlug}/${subjectId}/${themeId}`] = null;
                });
            }
            updates[`/${dbRoot}/results/estagiosLivre/${openCourseSlug}/${subjectId}/${themeId}`] = null;

            // Registros importados de planilha não têm subjectId/themeId, só
            // casam pelo nome (mesmo critério de fetchCourseResults) — cada um
            // precisa ser apagado individualmente pelo seu entryId.
            fetchCourseResults(openCourseSlug, subjectId, themeId)
                .filter(r => r.imported && r.entryId)
                .forEach(r => { updates[`/${dbRoot}/results/imported/${openCourseSlug}/${r.entryId}`] = null; });

            // progress/byUser é uma árvore separada de results/* (grava % de
            // módulos assistidos + nota, ver js/main.js:progressPathFor) —
            // sem isso o card do colaborador continuava mostrando 100%/nota
            // antiga mesmo depois do reset apagar a avaliação em results/*.
            Object.keys(allProgress).forEach(userId => {
                if (allProgress[userId]?.[openCourseSlug]?.[subjectId]?.[themeId] !== undefined) {
                    updates[`/${dbRoot}/progress/byUser/${userId}/${openCourseSlug}/${subjectId}/${themeId}`] = null;
                }
            });

            await db.ref().update(updates);

            Object.keys(allProgress).forEach(userId => {
                if (allProgress[userId]?.[openCourseSlug]?.[subjectId]) {
                    delete allProgress[userId][openCourseSlug][subjectId][themeId];
                }
            });

            showWarning('Curso resetado com sucesso.');
            historyRows = await U.refreshHistoryRows();
            renderCourseCards();
            renderCourseDashboard(openCourseSlug, openCourseKey);
        } catch (error) {
            showWarning('Erro ao resetar o curso: ' + error.message);
        }
    }
    courseResetBtn?.addEventListener('click', handleResetCourse);

    // ─── Alternância de modo ───
    const modeUserBtn = document.getElementById('cfg-dash-mode-user');
    const modeCourseBtn = document.getElementById('cfg-dash-mode-course');

    function setDashMode(mode) {
        modeUserBtn.classList.toggle('active', mode === 'user');
        modeCourseBtn.classList.toggle('active', mode === 'course');
        document.getElementById('cfg-dash-user-picker').style.display = mode === 'user' ? 'flex' : 'none';
        document.getElementById('cfg-dash-course-picker').style.display = mode === 'course' ? 'flex' : 'none';
        document.getElementById('cfg-dash-empty').style.display = 'flex';
        closeSubjectPopover();
        closeUserFilterPopovers();
        closeCourseModal();
        closeUserModal();
        if (mode === 'course') { updateCategoryChip(); renderCourseCards(); if (userCardsBox) userCardsBox.style.display = 'none'; }
        else { renderUserCards(); if (courseCardsBox) courseCardsBox.style.display = 'none'; }
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
            if (selectedSubjectId && selectedSubjectId !== ALL_SUBJECTS_ID && !currentTrainingData()[selectedSubjectId]) {
                selectedSubjectId = ALL_SUBJECTS_ID; selectedCourseKey = null;
                subjectLabel.textContent = 'Todos os temas';
            }
            renderCourseCards();
            if (selectedCourseKey) renderCourseDashboard(currentSlug(), selectedCourseKey);
            renderUserCards();
            if (selectedUserId && allColaboradores[selectedUserId]) {
                renderUserDashboard(allColaboradores[selectedUserId], userHeroStats);
            }
        } catch (error) {
            showWarning('Erro ao carregar dados do dashboard: ' + error.message);
        }
    }
    U.initDashboard = initDashboard;
})();
