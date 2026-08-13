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

    // Reconstrói uma data local (meia-noite) a partir do formato "dd/mm/aaaa"
    // usado pelas labels de dia dos gráficos — evita reparsing ambíguo do
    // toLocaleDateString('pt-BR') pelo construtor padrão de Date.
    function parseBrDate(brDate) {
        const [day, month, year] = brDate.split('/').map(Number);
        return new Date(year, month - 1, day).getTime();
    }

    // Duração da avaliação (segundos) em mm:ss — ausente em registros
    // anteriores ao timer da prova.
    function formatDuration(seconds) {
        const n = Number(seconds);
        if (!Number.isFinite(n) || n < 0) return '—';
        const m = Math.floor(n / 60).toString().padStart(2, '0');
        const s = Math.floor(n % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    // Balão colorido da nota (mesmo padrão visual do Histórico).
    function scoreBadgeHtml(score) {
        const n = Number(score);
        if (!Number.isFinite(n)) return '—';
        const cls = n >= 8 ? 'is-high' : n >= 6 ? 'is-mid' : 'is-low';
        return `<span class="hist-score ${cls}"><b>${formatScore(n)}</b><small>/10</small></span>`;
    }

    // Balão colorido da nota numa escala CONTÍNUA vermelho→amarelo→verde
    // (0 a 10), em vez de 3 faixas fixas — usado onde a variação fina de
    // nota importa mais (ex.: comentários da pesquisa de satisfação). Cor
    // calculada inline (não depende de classes CSS) para nunca ficar sem
    // estilo por escopo de seletor.
    function scoreBadgeGradientHtml(score) {
        const n = Number(score);
        if (!Number.isFinite(n)) return '—';
        const t = Math.max(0, Math.min(1, n / 10));
        // vermelho (0) -> amarelo (0.5) -> verde (1), interpolado em HSL
        // (hue 0=vermelho, 50=amarelo, 142=verde) para uma transição suave.
        const hue = t <= 0.5 ? (t / 0.5) * 50 : 50 + ((t - 0.5) / 0.5) * 92;
        const bg = `hsl(${hue.toFixed(0)}, 88%, 94%)`;
        const fg = `hsl(${hue.toFixed(0)}, 70%, 32%)`;
        return `<span class="hist-score" style="background:${bg};color:${fg};"><b>${formatScore(n)}</b><small>/10</small></span>`;
    }

    const CATEGORY_LABELS = { treinamentos: 'Treinamentos', educacao_continuada: 'Educação Continuada', estagios: 'Estágios' };
    const CHART_COLORS = {
        accent: '#4f8ef7', success: '#10b981', danger: '#ef4444', warning: '#f59e0b',
        muted: '#94a3b8', purple: '#8b5cf6', yellow: '#eab308', orange: '#f97316', lime: '#84cc16'
    };
    const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

    // Média de duração de prova (segundos), ignorando linhas sem timer
    // (registros anteriores ao recurso, ver formatDuration).
    function avgDuration(rows) {
        const durations = rows.map(r => Number(r.durationSeconds)).filter(Number.isFinite);
        if (!durations.length) return null;
        return durations.reduce((a, b) => a + b, 0) / durations.length;
    }

    // Agrupa linhas por mês (YYYY-MM de submittedAt), retorna os últimos
    // `months` meses em ordem cronológica, mesmo os sem nenhuma linha (para
    // a tendência não "pular" períodos vazios).
    function groupByMonth(rows, dateField = 'submittedAt', months = 6) {
        const now = new Date();
        const buckets = [];
        for (let i = months - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            buckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: `${MONTH_LABELS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`, count: 0 });
        }
        const byKey = new Map(buckets.map(b => [b.key, b]));
        rows.forEach(r => {
            const ts = r[dateField];
            if (!ts) return;
            const d = new Date(ts);
            const bucket = byKey.get(`${d.getFullYear()}-${d.getMonth()}`);
            if (bucket) bucket.count++;
        });
        return buckets;
    }

    // Agrupa linhas por pessoa+curso (mesma chave de personKeysOfRow) para
    // contar quantas tentativas cada um teve e se aprovou ao final —
    // usado no gráfico de retentativas.
    function attemptsByPerson(rows) {
        const byPerson = new Map();
        rows.forEach(row => {
            const keys = personKeysOfRow(row);
            const key = keys[0];
            if (!key) return;
            if (!byPerson.has(key)) byPerson.set(key, []);
            byPerson.get(key).push(row);
        });
        return [...byPerson.values()].map(personRows => {
            const sorted = personRows.slice().sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
            const last = sorted[sorted.length - 1];
            return { attempts: sorted.length, approved: !!last.approved };
        });
    }

    // Última tentativa de cada pessoa — usado por gráficos que devem refletir
    // a situação final do curso, não repetir cada tentativa (ex.: prazo de
    // realização não deve contar 2x quem tentou e reenviou).
    function lastAttemptByPerson(rows) {
        const byPerson = new Map();
        rows.forEach(row => {
            const key = personKeysOfRow(row)[0];
            if (!key) return;
            if (!byPerson.has(key)) byPerson.set(key, []);
            byPerson.get(key).push(row);
        });
        return [...byPerson.values()].map(personRows =>
            personRows.slice().sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0)).pop()
        );
    }

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
    let allProgress = {};     // allProgress[userId][slug][subjectId][themeId] = { total, done, pct, startedAt, activeMs, updatedAt }
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

    // Charts desenhados enquanto a aba deles ainda está display:none (ex.:
    // abas "Gráficos" dos modais de curso/usuário, que não são a aba ativa
    // por padrão) nascem medindo altura 0 e o Chart.js congela um layout
    // achatado — as coordenadas internas (ex.: as usadas pelo
    // stddevWhiskerPlugin pra desenhar a barra de erro) ficam fora de
    // sincronia com o tamanho real que a barra passa a ter quando a aba
    // fica visível. Chamado ao entrar na aba: resize() força o Chart.js a
    // remedir o canvas agora visível e realinha tudo.
    function resizeChartsIn(container) {
        if (!container) return;
        container.querySelectorAll('canvas').forEach(canvas => {
            const instance = Object.values(chartInstances).find(c => c.canvas === canvas);
            instance?.resize();
        });
    }

    // Tooltip padrão "valor (xx%)" para gráficos de pizza — % sobre o total
    // do dataset.
    function pieTooltipLabel(ctx) {
        const total = ctx.dataset.data.reduce((a, b) => a + (Number(b) || 0), 0);
        const value = Number(ctx.parsed) || 0;
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return `${ctx.label}: ${value} (${pct}%)`;
    }

    // Tooltip padrão "valor (xx%)" para barras empilhadas — % sobre a soma de
    // todos os datasets naquele índice (a categoria inteira), não o total do
    // gráfico.
    function percentTooltipLabel(ctx) {
        const index = ctx.dataIndex;
        const total = ctx.chart.data.datasets.reduce((sum, ds) => sum + (Number(ds.data[index]) || 0), 0);
        const value = Number(ctx.parsed.x ?? ctx.parsed.y) || 0;
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return `${ctx.dataset.label}: ${value} (${pct}%)`;
    }

    // Tooltip padrão "valor (xx%)" para barra com um único dataset (não
    // empilhado) — % sobre a soma de todas as categorias do próprio dataset.
    function singleSeriesTooltipLabel(ctx) {
        const total = ctx.dataset.data.reduce((sum, v) => sum + (Number(v) || 0), 0);
        const value = Number(ctx.parsed.x ?? ctx.parsed.y) || 0;
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return `${value} (${pct}%)`;
    }

    // ─── Carga inicial + sincronização ao vivo ───
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

    // Chave de curso de uma linha do histórico: prefere os ids (mais
    // precisos), cai para o nome normalizado quando a linha é de importação
    // de planilha/estágio livre e não tem subjectId/themeId.
    function rowCourseKey(row) {
        if (row.slug && row.subjectId && row.themeId) return `${row.slug}_${row.subjectId}_${row.themeId}`;
        return normalizeName(`${row.subject || ''}|${row.theme || ''}`);
    }

    // Última tentativa de cada curso — usado nos gráficos do colaborador, que
    // olham vários cursos de uma só pessoa e não devem repetir cada
    // tentativa/reenvio, só a situação final de cada curso.
    function lastAttemptByCourse(rows) {
        const byCourse = new Map();
        rows.forEach(row => {
            const key = rowCourseKey(row);
            if (!byCourse.has(key)) byCourse.set(key, []);
            byCourse.get(key).push(row);
        });
        return [...byCourse.values()].map(courseRows =>
            courseRows.slice().sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0)).pop()
        );
    }

    function userCardStats(colab) {
        const rows = flattenColaboradorResults(colab);
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        // "Com atraso" conta cursos, não tentativas: um curso entra na conta
        // uma única vez, mesmo que tenha mais de um resultado atrasado.
        const lateCourseKeys = new Set();
        rows.forEach(r => {
            if (!['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)) lateCourseKeys.add(rowCourseKey(r));
        });
        const late = lateCourseKeys.size;
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
                    ${stats.late > 0 ? `<span class="is-warn"><i class="fas fa-triangle-exclamation"></i> ${stats.late} concluído com atraso</span>` : ''}
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
            // Ver comentário de resizeChartsIn: aba "charts" some no
            // primeiro paint, gráficos nascem achatados.
            if (target === 'charts') resizeChartsIn(userModal);
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
            <thead><tr><th>Data</th><th>Curso</th><th>Nota</th><th>Tempo</th><th>Prazo</th><th>Situação</th></tr></thead>
            <tbody>${sorted.map((r, i) => {
                const dateLabel = r.submittedAt ? new Date(r.submittedAt).toLocaleString('pt-BR') : '—';
                const situationOk = !!r.approved;
                return `<tr style="--row-i:${i}">
                    <td>${dateLabel}</td>
                    <td>${escapeHtml(r.theme || r.subject || '—')}</td>
                    <td>${scoreBadgeHtml(r.score)}</td>
                    <td>${formatDuration(r.durationSeconds)}</td>
                    <td>${deadlineBadgeHtml(r.deadlineStatus)}</td>
                    <td><span class="conclusion-situation ${situationOk ? 'is-ok' : 'is-bad'}"><i class="fas ${situationOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${situationOk ? 'Aprovado' : 'Reprovado'}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    // Média móvel simples (janela de 3 tentativas) — mostra tendência de
    // melhora/piora ao longo do tempo em vez de uma média fixa horizontal.
    function movingAverage(values, window = 3) {
        return values.map((_, i) => {
            const start = Math.max(0, i - window + 1);
            const slice = values.slice(start, i + 1);
            return slice.reduce((a, b) => a + b, 0) / slice.length;
        });
    }

    let userChartRowsCache = [];
    let userChartColabCache = null;
    const userChartYearChip = createYearFilterChip('cfg-dash-user-year-chip', 'cfg-dash-user-year-list', () => {
        if (userChartColabCache) renderUserCharts(userChartColabCache, userChartRowsCache);
    });

    // Parte da aba Gráficos que depende de data (Notas, Realização dos
    // Cursos, Tentativas, Prazo por Mês) — respeita o filtro de ano.
    // "Progresso em Cursos Pendentes" fica de fora: é sobre cursos ainda não
    // feitos, sem data de conclusão para recortar.
    function renderUserCharts(colab, allRows) {
        const rows = filterRowsByYear(allRows, userChartYearChip.getValue());
        const labels = rows.map(r => new Date(r.submittedAt || 0).toLocaleDateString('pt-BR'));
        const scores = rows.map(r => r.score);
        const trend = movingAverage(scores);

        renderChart('userScores', 'cfg-dash-user-scores-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { type: 'bar', label: 'Nota', data: scores, backgroundColor: CHART_COLORS.accent, borderRadius: 4 },
                    { type: 'line', label: 'Média móvel', data: trend, borderColor: CHART_COLORS.danger, pointRadius: 0, tension: 0.3 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 10 } } }
        });

        // "Realização dos Cursos": situação final por curso (última
        // tentativa), não uma linha por tentativa/reenvio.
        const lastAttempts = lastAttemptByCourse(rows);
        const onTime = lastAttempts.filter(r => r.deadlineStatus === 'on_time' || r.deadlineStatus === 'livre' || r.deadlineStatus === 'forgiven').length;
        const late = lastAttempts.length - onTime;
        renderChart('userDeadline', 'cfg-dash-user-deadline-chart', {
            type: 'pie',
            data: { labels: ['No prazo', 'Fora do prazo'], datasets: [{ data: [onTime, late], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: (ctx) => pieTooltipLabel(ctx) } } } }
        });

        const approved = rows.filter(r => r.approved).length;
        const reproved = rows.length - approved;
        renderChart('userApproval', 'cfg-dash-user-approval-chart', {
            type: 'pie',
            data: { labels: ['Aprovação', 'Reprovação'], datasets: [{ data: [approved, reproved], backgroundColor: [CHART_COLORS.success, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: (ctx) => pieTooltipLabel(ctx) } } } }
        });

        renderUserPendingChart(colab, allRows);

        // "Prazo por Mês" segue o mesmo critério: 1 barra por curso concluído
        // (situação final), agrupado pelo mês da última tentativa.
        const monthBuckets = groupByMonth(lastAttempts);
        const onTimeByMonth = groupByMonth(lastAttempts.filter(r => ['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)));
        const lateByMonth = groupByMonth(lastAttempts.filter(r => !['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)));
        renderChart('userDeadlineTrend', 'cfg-dash-user-deadlinetrend-chart', {
            type: 'bar',
            data: {
                labels: monthBuckets.map(b => b.label),
                datasets: [
                    { label: 'No prazo', data: onTimeByMonth.map(b => b.count), backgroundColor: CHART_COLORS.accent },
                    { label: 'Fora do prazo', data: lateByMonth.map(b => b.count), backgroundColor: CHART_COLORS.danger }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { tooltip: { callbacks: { label: (ctx) => percentTooltipLabel(ctx) } } },
                scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } }
            }
        });
    }

    function renderUserDashboard(colab, heroStatsEl) {
        const rows = flattenColaboradorResults(colab);
        const scores = rows.map(r => r.score);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        // O hero (topo do modal) e a aba Histórico sempre mostram o total —
        // só a aba Gráficos recorta por ano.
        const lastAttemptsAll = lastAttemptByCourse(rows);
        const lateAll = lastAttemptsAll.filter(r => !['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)).length;

        userChartColabCache = colab;
        userChartRowsCache = rows;
        userChartYearChip.setYears(yearsFromRows(rows));
        renderUserCharts(colab, rows);

        if (heroStatsEl) {
            const avgLabel = scores.length ? avg.toFixed(1).replace('.', ',') : '—';
            const durationLabel = formatDuration(avgDuration(rows));
            heroStatsEl.innerHTML = `
                <span class="hero-stat is-ok"><i class="fas fa-circle-check"></i> ${rows.length} ${rows.length === 1 ? 'curso realizado' : 'cursos realizados'}</span>
                <span class="hero-stat"><i class="fas fa-star"></i> Média ${avgLabel}</span>
                <span class="hero-stat"><i class="fas fa-clock"></i> Tempo médio de prova ${durationLabel}</span>
                ${lateAll > 0 ? `<span class="hero-stat is-warn"><i class="fas fa-triangle-exclamation"></i> ${lateAll} concluído com atraso</span>` : ''}
            `;
        }
        renderUserHistoryTable(rows);
    }

    // Cursos exigidos pelo cargo do colaborador que ele ainda não concluiu,
    // com o % de módulos já assistidos (progress/byUser) — o gráfico mais
    // acionável para o gestor: mostra onde a pessoa está travada, não só o
    // que já foi feito.
    function renderUserPendingChart(colab, doneRows) {
        const slug = currentSlug();
        const doneThemeKeys = new Set(doneRows.filter(r => r.subjectId && r.themeId).map(r => `${r.slug}_${r.subjectId}_${r.themeId}`));
        const roleKey = normalizeName(colab.role || '');
        const pending = [];
        if (!AUDIENCE_EXEMPT_SLUGS.includes(slug)) {
            const trainingData = allTrainingData[slug] || {};
            Object.keys(trainingData).forEach(subjectId => {
                const themes = trainingData[subjectId]?.themes || {};
                Object.keys(themes).forEach(themeId => {
                    const theme = themes[themeId];
                    if (theme?.active === false) return;
                    const roles = Array.isArray(theme?.roles) ? theme.roles.filter(Boolean) : [];
                    const targeted = roles.length === 0 || roles.some(role => normalizeName(role) === roleKey);
                    if (!targeted) return;
                    if (doneThemeKeys.has(`${slug}_${subjectId}_${themeId}`)) return;
                    const pct = progressPctFor(colab, slug, subjectId, themeId);
                    pending.push({ name: theme.name || themeId, pct });
                });
            });
        }
        pending.sort((a, b) => b.pct - a.pct);

        renderChart('userPending', 'cfg-dash-user-pending-chart', {
            type: 'bar',
            data: {
                labels: pending.map(p => p.name),
                datasets: [{ data: pending.map(p => p.pct), backgroundColor: CHART_COLORS.warning, borderRadius: 4 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x}% assistido` } } },
                scales: { x: { min: 0, max: 100 } }
            }
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
            // Inativo (colab.active === false, mesmo critério da aba
            // Colaboradores) ou desvinculado da planilha (inSheet === false,
            // "inválido" — saiu da base oficial) não conta como público-alvo:
            // infla o denominador dos gráficos de conclusão com gente que já
            // não deveria mais fazer o curso.
            .filter(colab => colab.active !== false && colab.inSheet !== false)
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
        // O gráfico "Progresso em Cursos Pendentes" do colaborador é
        // filtrado pela categoria atual (ver renderUserPendingChart) —
        // fecha o modal para não ficar mostrando dados da categoria antiga.
        closeUserModal();
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

        container.innerHTML = `<div class="comment-cards">${pageRows.map((r, i) => {
            const n = Number(r.rating) || 0;
            const ratingClass = n >= 4 ? 'rating-high' : n === 3 ? 'rating-mid' : 'rating-low';
            return `
            <div class="comment-card ${ratingClass} is-clickable" data-row-i="${start + i}" title="Ver detalhes da avaliação">
                <div class="comment-card-head">
                    <span class="comment-card-name"><i class="fas fa-user-circle"></i> ${escapeHtml(r.fullName)}</span>
                    <span class="comment-card-rating">${scoreBadgeGradientHtml(r.score)}${starsHtml(r.rating)}</span>
                </div>
                <p class="comment-card-text ${r.comment ? '' : 'is-empty'}">${r.comment ? escapeHtml(r.comment) : 'Em branco'}</p>
                ${r.comment ? '<span class="comment-card-more" data-action="toggle-comment">Ver mais</span>' : ''}
            </div>`;
        }).join('')}</div>`;
        container.querySelectorAll('.comment-card-more').forEach(btn => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const text = btn.previousElementSibling;
                const expanded = text.classList.toggle('is-expanded');
                btn.textContent = expanded ? 'Ver menos' : 'Ver mais';
            });
        });
        container.querySelectorAll('.comment-card.is-clickable').forEach(card => {
            card.addEventListener('click', () => {
                const row = commentsRowsCache[Number(card.dataset.rowI)];
                if (row) openReviewModal(row);
            });
        });
        renderCommentsPagination(totalPages);
    }

    function renderCommentsTable(rows) {
        const container = document.getElementById('cfg-dash-course-comments');
        const pager = document.getElementById('cfg-dash-course-comments-pagination');
        // Entra todo mundo que deixou comentário (qualquer nota) e, além
        // disso, quem deixou o campo em branco mas avaliou com nota baixa
        // (≤3★) — campo em branco com nota alta não precisa de atenção.
        commentsRowsCache = rows.filter(r => r.comment || (Number(r.rating) || 0) <= 3)
            .sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0));
        commentsPage = 1;
        if (commentsRowsCache.length === 0) {
            container.innerHTML = '<p class="dashboard-table-empty">Nenhum comentário registrado para este curso.</p>';
            if (pager) pager.innerHTML = '';
            return;
        }
        paintCommentsPage();
    }

    // ─── Modal de detalhe da avaliação (clique num comentário) ───
    // Mostra quem é o aluno (unidade, cargo, média geral e total de cursos
    // entre TODOS os cursos que já fez) ao lado da avaliação específica deste
    // curso (nota, estrelas, comentário e as questões que errou/acertou).
    const reviewModal = document.getElementById('cfg-dash-review-modal');
    const reviewModalClose = document.getElementById('cfg-dash-review-modal-close');

    function closeReviewModal() { if (reviewModal) reviewModal.style.display = 'none'; }

    // Cadastro do curso (certificateEnabled/Title/Hours/Topics), lido direto
    // de allTrainingData (já carregado em memória) — mesma fonte usada pelo
    // resto do painel, sem precisar de fetch assíncrono como em admin-history.js.
    function courseCadastroForRow(row) {
        if (!row.slug || !row.subjectId || !row.themeId) return null;
        return allTrainingData[row.slug]?.[row.subjectId]?.themes?.[row.themeId] || null;
    }

    function renderReviewCertificateButton(row) {
        const holder = document.getElementById('cfg-dash-review-cert');
        if (!holder) return;
        holder.innerHTML = '';
        if (!row.approved) return;

        const course = courseCadastroForRow(row);
        if (!U.Certificate?.isEnabled(course)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-cert-btn';
        btn.innerHTML = '<i class="fas fa-award"></i> Baixar certificado';
        btn.addEventListener('click', () => U.Certificate.download({
            studentName: row.fullName,
            course,
            courseName: row.theme,
            submittedAt: row.submittedAt
        }));
        holder.appendChild(btn);
    }

    // Acha o cadastro do colaborador dono de uma linha de histórico, pela
    // mesma chave (conta ou nome normalizado) usada no resto do dashboard.
    function findColaboradorForRow(row) {
        const keys = new Set(personKeysOfRow(row));
        const entry = Object.entries(allColaboradores).find(([, colab]) => personKeysOfColaborador(colab).some(key => keys.has(key)));
        return entry ? { id: entry[0], colab: entry[1] } : null;
    }

    function openReviewModal(row) {
        if (!reviewModal) return;
        const found = findColaboradorForRow(row);
        const colab = found?.colab || { fullName: row.fullName, unit: row.unit, role: row.role };

        const allRows = found ? flattenColaboradorResults(colab) : [row];
        const scores = allRows.map(r => Number(r.score) || 0);
        const overallAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const ratedRows = allRows.filter(r => r.rating);
        const ratingAvg = ratedRows.length ? ratedRows.reduce((a, r) => a + (Number(r.rating) || 0), 0) / ratedRows.length : null;
        const courseCount = new Set(allRows.map(rowCourseKey)).size;

        const titleEl = document.getElementById('cfg-dash-review-modal-title');
        if (titleEl) titleEl.textContent = colab.fullName || 'Colaborador';
        const avatarEl = document.getElementById('cfg-dash-review-avatar');
        if (avatarEl) avatarEl.textContent = themeInitials(colab.fullName || '?');
        const tagsEl = document.getElementById('cfg-dash-review-student-tags');
        if (tagsEl) {
            tagsEl.innerHTML = `
                ${colab.role ? `<span class="dash-course-subject-tag"><i class="fas fa-briefcase"></i> ${escapeHtml(colab.role)}</span>` : ''}
                ${colab.unit ? `<span class="dash-course-subject-tag"><i class="fas fa-building"></i> ${escapeHtml(colab.unit)}</span>` : ''}`;
        }
        const statsEl = document.getElementById('cfg-dash-review-stats');
        if (statsEl) {
            statsEl.innerHTML = `
                <div class="dash-review-stat"><i class="fas fa-layer-group"></i><div><b>${courseCount}</b><span>${courseCount === 1 ? 'curso realizado' : 'cursos realizados'}</span></div></div>
                <div class="dash-review-stat"><i class="fas fa-chart-line"></i><div><b>${overallAvg === null ? '—' : formatScore(overallAvg)}</b><span>média geral</span></div></div>
                <div class="dash-review-stat"><i class="fas fa-star"></i><div><b>${ratingAvg === null ? '—' : ratingAvg.toFixed(1).replace('.', ',')}</b><span>média de avaliação</span></div></div>`;
        }

        const courseNameEl = document.getElementById('cfg-dash-review-course-name');
        if (courseNameEl) courseNameEl.textContent = row.theme || row.subject || '';
        const summaryEl = document.getElementById('cfg-dash-review-summary-grid');
        if (summaryEl) {
            const dateLabel = row.submittedAt ? new Date(row.submittedAt).toLocaleString('pt-BR') : '—';
            const activeMs = row.userId ? allProgress[row.userId]?.[row.slug]?.[row.subjectId]?.[row.themeId]?.activeMs : null;
            const completionLabel = formatHHMMSS(activeMs);
            summaryEl.innerHTML = `
                <div class="dash-review-summary-item">${scoreBadgeHtml(row.score)}<span>Nota da prova</span></div>
                <div class="dash-review-summary-item">${starsHtml(row.rating)}<span>Avaliação do curso</span></div>
                <div class="dash-review-summary-item"><span class="conclusion-situation ${row.approved ? 'is-ok' : 'is-bad'}"><i class="fas ${row.approved ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${row.approved ? 'Aprovado' : 'Reprovado'}</span><span>Situação</span></div>
                <div class="dash-review-summary-item"><span class="dash-review-date"><i class="fas fa-calendar"></i> ${dateLabel}</span><span>Data</span></div>
                <div class="dash-review-summary-item"><span class="dash-review-date"><i class="fas fa-stopwatch"></i> ${formatDuration(row.durationSeconds)}</span><span>Tempo de prova</span></div>
                <div class="dash-review-summary-item"><span class="dash-review-date"><i class="fas fa-hourglass-end"></i> ${completionLabel}</span><span>Tempo de conclusão</span></div>`;
        }
        const commentEl = document.getElementById('cfg-dash-review-comment');
        if (commentEl) {
            commentEl.innerHTML = row.comment
                ? `<i class="fas fa-quote-left"></i><p>${escapeHtml(row.comment)}</p>`
                : `<p class="dash-review-no-comment">Nenhum comentário deixado.</p>`;
        }

        renderReviewCertificateButton(row);

        const questionsSection = document.getElementById('cfg-dash-review-questions-section');
        const questionsEl = document.getElementById('cfg-dash-review-questions');
        if (questionsEl) {
            const answers = row.answers || [];
            const wrongAnswers = answers
                .map((a, idx) => ({ a, idx }))
                .filter(({ a }) => a.selected !== a.correct);

            // Só mostra questões erradas — quem acertou tudo não tem nada a
            // revisar aqui, então a seção inteira fica oculta.
            if (questionsSection) questionsSection.style.display = wrongAnswers.length === 0 ? 'none' : '';

            questionsEl.innerHTML = wrongAnswers.map(({ a, idx }) => `
                <div class="history-detail-question is-wrong">
                    <div class="q-title wrong">
                        <i class="fas fa-circle-xmark"></i>
                        <span>${idx + 1}. ${escapeHtml(a.question)}</span>
                    </div>
                    ${(a.options || []).map((opt, optIdx) => {
                        const wasSelected = optIdx === a.selected;
                        const isKey = optIdx === a.correct;
                        let cls = 'q-option';
                        if (wasSelected && isKey) cls += ' was-selected is-right';
                        else if (wasSelected && !isKey) cls += ' was-selected is-wrong';
                        else if (isKey) cls += ' is-answer-key';
                        const marker = wasSelected ? '<i class="fas fa-arrow-right" style="margin-right:6px;"></i>' : '';
                        const keyMarker = isKey ? ' <i class="fas fa-check" style="margin-left:6px;"></i>' : '';
                        return `<div class="${cls}">${marker}${escapeHtml(opt)}${keyMarker}</div>`;
                    }).join('')}
                </div>`).join('');
        }

        reviewModal.style.display = 'flex';
    }

    reviewModalClose?.addEventListener('click', closeReviewModal);
    reviewModal?.addEventListener('click', (event) => { if (event.target === reviewModal) closeReviewModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && reviewModal?.style.display === 'flex') closeReviewModal();
    });

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

    // "Aprovados" / "Reprovados": uma linha por realização, ordenado da mais
    // recente para a mais antiga, com busca por nome — cada situação com sua
    // própria tabela (antes era uma lista só com filtro de situação).
    let completedRowsCache = [];
    let completedSearchTerm = '';
    let reprovedRowsCache = [];
    let reprovedSearchTerm = '';
    let reprovedCriticalOnly = false;
    let conclusionsCourseIds = { slug: '', subjectId: '', themeId: '' };

    function conclusionRowHtml(r, i) {
        const dateLabel = r.submittedAt ? new Date(r.submittedAt).toLocaleString('pt-BR') : '—';
        const situationOk = !!r.approved;
        const { slug, subjectId, themeId } = conclusionsCourseIds;
        const canForgive = !situationOk && r.userId && (r.deadlineStatus === 'late' || r.deadlineStatus === 'closed');
        const activeMs = r.userId ? allProgress[r.userId]?.[r.slug]?.[r.subjectId]?.[r.themeId]?.activeMs : null;
        return `<tr style="--row-i:${i}" class="is-clickable" data-row-i="${i}" title="Ver detalhes">
            <td>${dateLabel}</td>
            <td><span class="row-name">${avatarHtml(r.fullName)} ${escapeHtml(r.fullName)}</span></td>
            <td>${escapeHtml(r.unit || '—')}</td>
            <td>${escapeHtml(r.role || '—')}</td>
            <td>${deadlineBadgeHtml(r.deadlineStatus)}</td>
            <td>${scoreBadgeHtml(r.score)}</td>
            <td>${formatDuration(r.durationSeconds)}</td>
            <td>${formatHHMMSS(activeMs)}</td>
            <td><span class="conclusion-situation ${situationOk ? 'is-ok' : 'is-bad'}"><i class="fas ${situationOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${situationOk ? 'Aprovado' : 'Reprovado'}</span></td>
            <td>${canForgive ? `<button class="dash-forgive-btn" data-user-id="${escapeHtml(r.userId)}" data-slug="${slug}" data-subject-id="${subjectId}" data-theme-id="${themeId}">Desconsiderar atraso</button>` : ''}</td>
        </tr>`;
    }

    function paintConclusionsTable(containerId, rowsCache, searchTerm, emptyIcon, emptyMessage) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const filtered = searchTerm
            ? rowsCache.filter(r => normalizeName(r.fullName || '').includes(normalizeName(searchTerm)))
            : rowsCache;

        if (rowsCache.length === 0) {
            container.innerHTML = emptyStateHtml(emptyIcon, emptyMessage);
            return;
        }
        if (filtered.length === 0) {
            container.innerHTML = emptyStateHtml('fa-search', 'Nenhum resultado para essa busca.');
            return;
        }

        container.innerHTML = `<table class="is-sticky">
            <thead><tr><th>Data/Hora</th><th>Nome</th><th>Unidade</th><th>Cargo</th><th>Prazo</th><th>Nota</th><th>Tempo</th><th>Conclusão</th><th>Situação</th><th></th></tr></thead>
            <tbody>${filtered.map((r, i) => conclusionRowHtml(r, i)).join('')}</tbody>
        </table>`;

        container.querySelectorAll('.dash-forgive-btn').forEach(btn => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                handleForgiveDeadline(btn.dataset);
            });
        });
        container.querySelectorAll('tr.is-clickable').forEach(tr => {
            tr.addEventListener('click', () => openReviewModal(filtered[Number(tr.dataset.rowI)]));
        });
    }

    function paintCompletedPage() {
        paintConclusionsTable('cfg-dash-course-completed', completedRowsCache, completedSearchTerm, 'fa-clipboard-check', 'Ninguém foi aprovado neste curso ainda.');
    }

    function paintReprovedPage() {
        const rows = reprovedCriticalOnly ? reprovedRowsCache.filter(r => Number(r.score) < 6) : reprovedRowsCache;
        const emptyMessage = reprovedCriticalOnly ? 'Nenhuma reprovação crítica (nota abaixo de 6) registrada para este curso.' : 'Nenhuma reprovação registrada para este curso.';
        paintConclusionsTable('cfg-dash-course-reproved', rows, reprovedSearchTerm, 'fa-circle-xmark', emptyMessage);
    }

    function renderCompletedTable(rows, slug, subjectId, themeId) {
        conclusionsCourseIds = { slug, subjectId, themeId };
        const sorted = rows.slice().sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        completedRowsCache = sorted.filter(r => r.approved);
        reprovedRowsCache = sorted.filter(r => !r.approved);
        reprovedCriticalOnly = false;
        document.getElementById('cfg-dash-course-reproved-critical')?.classList.remove('is-active');
        paintCompletedPage();
        paintReprovedPage();
    }

    document.getElementById('cfg-dash-course-completed-search')?.addEventListener('input', (e) => {
        completedSearchTerm = e.target.value;
        paintCompletedPage();
    });

    document.getElementById('cfg-dash-course-reproved-search')?.addEventListener('input', (e) => {
        reprovedSearchTerm = e.target.value;
        paintReprovedPage();
    });

    document.getElementById('cfg-dash-course-reproved-critical')?.addEventListener('click', (e) => {
        reprovedCriticalOnly = !reprovedCriticalOnly;
        e.currentTarget.classList.toggle('is-active', reprovedCriticalOnly);
        paintReprovedPage();
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

    // Anos com dados em `rows` (ordem decrescente) — só entram anos que
    // realmente têm pelo menos um resultado, nunca uma faixa fixa.
    function yearsFromRows(rows) {
        const years = new Set();
        rows.forEach(r => { if (r.submittedAt) years.add(new Date(r.submittedAt).getFullYear()); });
        return [...years].sort((a, b) => b - a);
    }

    function filterRowsByYear(rows, year) {
        if (!year) return rows;
        return rows.filter(r => r.submittedAt && new Date(r.submittedAt).getFullYear() === Number(year));
    }

    // Chip de filtro por ano: botão redondo com popover de lista, mesmo
    // padrão visual/comportamental dos chips de Unidade/Função. `onChange` é
    // chamado com o ano selecionado ("" = todos) sempre que o valor muda.
    function createYearFilterChip(chipId, listId, onChange) {
        const chip = document.getElementById(chipId);
        const listEl = document.getElementById(listId);
        const btn = chip?.querySelector('.hfilter-chip-btn');
        const label = chip?.querySelector('.hfilter-chip-label');
        let value = '';

        function closePopover() { chip?.classList.remove('is-open'); }

        function paint(years) {
            if (!listEl) return;
            listEl.innerHTML = [`<div class="hfilter-chip-item ${!value ? 'is-selected' : ''}" data-value="">Todos os anos</div>`]
                .concat(years.map(y => `<div class="hfilter-chip-item ${String(y) === value ? 'is-selected' : ''}" data-value="${y}">${y}</div>`))
                .join('');
            listEl.querySelectorAll('.hfilter-chip-item').forEach(item => {
                item.addEventListener('click', () => {
                    value = item.dataset.value;
                    closePopover();
                    refresh(years);
                    onChange(value);
                });
            });
        }

        function refresh(years) {
            if (label) label.textContent = value || label.dataset.default;
            chip?.classList.toggle('is-active', !!value);
            paint(years);
        }

        btn?.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = chip.classList.contains('is-open');
            document.querySelectorAll('.dash-year-chip.is-open').forEach(c => c.classList.remove('is-open'));
            if (!isOpen) chip.classList.add('is-open');
        });
        chip?.addEventListener('click', (event) => event.stopPropagation());
        document.addEventListener('click', closePopover);

        return {
            // Repopula com os anos disponíveis para o curso/colaborador atual;
            // se o ano selecionado não existir mais nesse conjunto, volta a
            // "Todos os anos" (mesmo critério do resto do painel).
            setYears(years) {
                if (value && !years.some(y => String(y) === value)) value = '';
                refresh(years);
            },
            getValue() { return value; }
        };
    }

    let courseChartRowsCache = [];
    let courseChartAudienceCache = [];
    let courseChartCompletionTimeCache = [];
    let courseChartEvalTimeCache = [];
    // Slug do curso aberto no modal — "Tempo para Conclusão" precisa dele pra
    // ler progress/byUser/<user>/<slug>/... (allProgress é organizado por
    // slug de categoria; currentSlug() aqui apontaria pra categoria
    // selecionada no topo do painel, não pra do curso aberto, que pode ser
    // outra).
    let courseChartSlugCache = null;
    let courseChartSubjectIdCache = null;
    let courseChartThemeIdCache = null;
    const courseChartYearChip = createYearFilterChip('cfg-dash-course-year-chip', 'cfg-dash-course-year-list', () => renderCourseCharts(courseChartRowsCache));

    // Popover de seleção múltipla (checkbox) — mesmo visual do chip de ano,
    // mas permite marcar várias opções ao mesmo tempo (ex.: comparar a
    // conclusão de várias unidades juntas no gráfico de tendência).
    // `onPaint(values)`, se passado, roda a cada (re)pintura — usado pelo chip
    // de "Tempo para Conclusão" pra listar os colaboradores das unidades
    // marcadas logo abaixo das opções, dentro do mesmo popover.
    function createMultiFilterChip(chipId, listId, onChange, onPaint) {
        const chip = document.getElementById(chipId);
        const listEl = document.getElementById(listId);
        const btn = chip?.querySelector('.hfilter-chip-btn');
        const label = chip?.querySelector('.hfilter-chip-label');
        let values = new Set();
        let options = [];

        // Botão "Marcar/desmarcar todos" fica em elemento próprio, injetado
        // antes da lista (ver `paint`), pra não competir com o `.hfilter-chip-list`
        // que já é sobrescrito por inteiro a cada pintura.
        const toggleAllEl = listEl ? document.createElement('button') : null;
        if (toggleAllEl) {
            toggleAllEl.type = 'button';
            toggleAllEl.className = 'hfilter-chip-toggle-all';
            listEl.insertAdjacentElement('beforebegin', toggleAllEl);
            toggleAllEl.addEventListener('click', (event) => {
                event.stopPropagation();
                values = values.size === options.length ? new Set() : new Set(options);
                refresh();
                onChange(values);
            });
        }

        function closePopover() { chip?.classList.remove('is-open'); }

        function paint() {
            if (!listEl) return;
            if (toggleAllEl) {
                toggleAllEl.style.display = options.length === 0 ? 'none' : '';
                const allSelected = options.length > 0 && values.size === options.length;
                toggleAllEl.innerHTML = allSelected
                    ? `<i class="fas fa-square-minus"></i> Desmarcar todos`
                    : `<i class="fas fa-square-check"></i> Marcar todos`;
            }
            if (options.length === 0) {
                listEl.innerHTML = `<div class="hfilter-chip-empty">Nenhuma unidade disponível.</div>`;
            } else {
                listEl.innerHTML = options.map(opt => `
                    <div class="hfilter-chip-item ${values.has(opt) ? 'is-selected' : ''}" data-value="${escapeHtml(opt)}">
                        <i class="fas ${values.has(opt) ? 'fa-square-check' : 'fa-square'}"></i> ${escapeHtml(opt)}
                    </div>`).join('');
                listEl.querySelectorAll('.hfilter-chip-item').forEach(item => {
                    item.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const value = item.dataset.value;
                        if (values.has(value)) values.delete(value); else values.add(value);
                        refresh();
                        onChange(values);
                    });
                });
            }
            onPaint?.(values);
        }

        function refresh() {
            if (label) {
                label.textContent = values.size === 0 ? label.dataset.default
                    : values.size === 1 ? [...values][0]
                    : `${values.size} unidades`;
            }
            chip?.classList.toggle('is-active', values.size > 0);
            paint();
        }

        btn?.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = chip.classList.contains('is-open');
            document.querySelectorAll('.hfilter-chip.is-open').forEach(c => c.classList.remove('is-open'));
            if (!isOpen) chip.classList.add('is-open');
        });
        chip?.addEventListener('click', (event) => event.stopPropagation());
        document.addEventListener('click', closePopover);

        return {
            // Repopula com as unidades disponíveis para o curso atual; remove
            // da seleção qualquer unidade que não exista mais nesse conjunto.
            setOptions(newOptions) {
                options = newOptions;
                values = new Set([...values].filter(v => options.includes(v)));
                refresh();
            },
            getValues() { return values; }
        };
    }

    const courseChartUnitChip = createMultiFilterChip('cfg-dash-course-unit-chip', 'cfg-dash-course-unit-list', () => renderCourseCompletionTrendChart(courseChartRowsCache, courseChartAudienceCache));

    // Chip de unidade do gráfico "Tempo para Conclusão" — além de filtrar o
    // gráfico, lista os colaboradores das unidades marcadas dentro do
    // próprio popover (pedido explícito: selecionar unidade mostra quem é
    // dela, podendo marcar mais de uma ao mesmo tempo).
    const completionTimeUnitUsersEl = document.getElementById('cfg-dash-course-completiontime-unit-users');
    function paintCompletionTimeUnitUsers(values) {
        if (!completionTimeUnitUsersEl) return;
        if (values.size === 0) { completionTimeUnitUsersEl.innerHTML = ''; return; }
        const people = courseChartAudienceCache
            .filter(c => values.has(c.unit))
            .slice()
            .sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', 'pt-BR'));
        completionTimeUnitUsersEl.innerHTML = `
            <div class="hfilter-chip-unit-users-title">${people.length} colaborador${people.length === 1 ? '' : 'es'}</div>
            <div class="hfilter-chip-unit-users-list">${
                people.length
                    ? people.map(p => `<div class="hfilter-chip-unit-user"><i class="fas fa-user"></i> ${escapeHtml(p.fullName)}</div>`).join('')
                    : `<div class="hfilter-chip-empty">Nenhum colaborador nessa unidade.</div>`
            }</div>`;
    }
    const courseChartCompletionTimeUnitChip = createMultiFilterChip(
        'cfg-dash-course-completiontime-unit-chip', 'cfg-dash-course-completiontime-unit-list',
        () => renderCourseCompletionTimeChart(courseChartCompletionTimeCache),
        paintCompletionTimeUnitUsers
    );

    // Chip de unidade do gráfico "Tempo para Conclusão da Avaliação" — usa
    // courseChartEvalTimeCache (duração da prova, campo durationSeconds,
    // mesmo valor da coluna "Tempo" do histórico), não o tempo até a
    // aprovação usado pelo gráfico "Tempo para Conclusão" acima.
    const courseChartEvalTimeUnitChip = createMultiFilterChip(
        'cfg-dash-course-evaltime-unit-chip', 'cfg-dash-course-evaltime-unit-list',
        () => renderCourseEvalTimeChart(courseChartEvalTimeCache)
    );

    // Parte da aba Gráficos que depende de data (Satisfação, Prazo,
    // Retentativas, Por Unidade) — respeita o filtro de ano. "Realização do
    // Curso" fica de fora: compara com o público-alvo total, não faz sentido
    // recortar por ano.
    function renderCourseCharts(allRows) {
        const rows = filterRowsByYear(allRows, courseChartYearChip.getValue());

        const ratingCounts = [1, 2, 3, 4, 5].map(star => rows.filter(r => r.rating === star).length);
        renderChart('courseSatisfaction', 'cfg-dash-course-satisfaction-chart', {
            type: 'bar',
            data: { labels: ['1★', '2★', '3★', '4★', '5★'], datasets: [{ data: ratingCounts, backgroundColor: CHART_COLORS.warning, borderRadius: 4 }] },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => singleSeriesTooltipLabel(ctx) } } }
            }
        });

        const lastAttempts = lastAttemptByPerson(rows);
        const onTime = lastAttempts.filter(r => ['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)).length;
        const late = lastAttempts.length - onTime;
        renderChart('courseDeadline', 'cfg-dash-course-deadline-chart', {
            type: 'pie',
            data: { labels: ['No prazo', 'Fora do prazo'], datasets: [{ data: [onTime, late], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: (ctx) => pieTooltipLabel(ctx) } } } }
        });

        renderCourseRetriesChart(rows);
        renderCourseByUnitChart(rows);
        renderCourseMistakesChart(rows);
        renderCourseScoresChart(rows);
        renderCourseScoresByUnitChart(rows);

        // Só entram unidades com nome de verdade — vazio, "—" ou "Sem
        // unidade" viram ruído no filtro (não dá pra segmentar por elas).
        const invalidUnit = (u) => !u || !u.trim() || u.trim() === '—' || normalizeName(u) === normalizeName('Sem unidade');
        const units = [...new Set(courseChartAudienceCache.map(c => c.unit).filter(u => !invalidUnit(u)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        courseChartUnitChip.setOptions(units);
        renderCourseCompletionTrendChart(allRows, courseChartAudienceCache);
        renderCourseUnitCompletionChart(allRows, courseChartAudienceCache);

        courseChartCompletionTimeUnitChip.setOptions(units);
        courseChartCompletionTimeCache = buildCompletionTimeData(allRows, courseChartSlugCache);
        renderCourseCompletionTimeChart(courseChartCompletionTimeCache);

        courseChartEvalTimeUnitChip.setOptions(units);
        courseChartEvalTimeCache = buildEvalTimeData(allRows);
        renderCourseEvalTimeChart(courseChartEvalTimeCache);
    }

    // Tempo ATIVO com o curso aberto até a aprovação (campo activeMs de
    // progress/byUser, gravado por resumeActiveCourseTimer/
    // pauseActiveCourseTimer em js/main.js): soma só o tempo em que o aluno
    // esteve de fato com o curso na tela (aba visível), não o tempo corrido
    // — fechar o curso por dias não infla o número. Contador some ao aprovar.
    // Registros antigos (gravados antes dessa métrica existir) não têm
    // activeMs e são excluídos — não há tempo ativo real para mostrar.
    // Ordenado do maior tempo para o menor.
    function buildCompletionTimeData(rows, slug) {
        const approved = lastAttemptByPerson(rows).filter(r => r.approved && r.submittedAt);
        return approved
            .map(r => {
                const activeMs = r.userId ? allProgress[r.userId]?.[slug]?.[r.subjectId]?.[r.themeId]?.activeMs : null;
                if (!Number.isFinite(activeMs) || activeMs <= 0) return null;
                return { fullName: r.fullName, unit: r.unit, durationMs: activeMs };
            })
            .filter(Boolean)
            .sort((a, b) => b.durationMs - a.durationMs);
    }

    // Tempo de duração da PROVA em si (mesmo campo `durationSeconds` exibido
    // na coluna "Tempo" do histórico) — não confundir com buildCompletionTimeData,
    // que mede o tempo desde o início do curso até a aprovação. Usado só pelo
    // gráfico "Tempo para Conclusão da Avaliação".
    function buildEvalTimeData(rows) {
        const approved = lastAttemptByPerson(rows).filter(r => r.approved && r.submittedAt);
        return approved
            .map(r => {
                const seconds = Number(r.durationSeconds);
                if (!Number.isFinite(seconds)) return null;
                return { fullName: r.fullName, unit: r.unit, durationMs: seconds * 1000 };
            })
            .filter(Boolean)
            .sort((a, b) => b.durationMs - a.durationMs);
    }

    // HH:MM a partir de ms — HH não tem teto (curso aberto por 30h vira
    // "30:00", não volta para "06:00" do dia seguinte).
    function formatHHMM(ms) {
        const totalMinutes = Math.round(ms / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    // HH:MM:SS a partir de ms — mesmo formato da coluna "Conclusão" do
    // histórico (ver formatHHMMSS em admin-history.js), HH sem teto.
    function formatHHMMSS(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return '—';
        const totalSeconds = Math.round(n / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    // Mesmo formato MM:SS da coluna "Tempo" do histórico (ver formatDuration),
    // mas a partir de ms — usado no gráfico "Tempo para Conclusão da
    // Avaliação", que mede duração de prova (curta, minutos), não dias.
    function formatMsAsDuration(ms) {
        return formatDuration(ms / 1000);
    }

    // Mesmo modelo do gráfico "Tempo para Conclusão da Avaliação" (ver
    // paintEvalTimePage/renderCourseEvalTimeChart): sem filtro, uma barra por
    // unidade com média±desvio padrão, ordenada da maior média para a menor;
    // marcando uma ou mais unidades, troca para uma barra por pessoa daquelas
    // unidades. Barra "Geral" (cinza, fixa no topo) com média±desvio de todos
    // os aprovados, ignorando o filtro. Paginado igual aos outros gráficos
    // "por unidade".
    // 5 (+ "Geral" fixo = 6 barras no canvas) — 7 deixava as barras achatadas
    // no card de altura fixa (260px).
    const COMPLETION_TIME_PAGE_SIZE = 9;
    let completionTimePage = 1;
    let completionTimeDataCache = [];

    function paintCompletionTimePage() {
        // "Geral" (1ª posição do cache, ver renderCourseCompletionTimeChart)
        // não entra na paginação normal — fica fixa no topo de toda página, o
        // resto das barras pagina em torno dela.
        const generalRow = completionTimeDataCache[0];
        const rest = completionTimeDataCache.slice(1);
        const totalPages = Math.max(1, Math.ceil(rest.length / COMPLETION_TIME_PAGE_SIZE));
        completionTimePage = Math.min(Math.max(1, completionTimePage), totalPages);
        const start = (completionTimePage - 1) * COMPLETION_TIME_PAGE_SIZE;
        const pageRows = generalRow ? [generalRow, ...rest.slice(start, start + COMPLETION_TIME_PAGE_SIZE)] : [];

        const canvas = document.getElementById('cfg-dash-course-completiontime-chart');
        const emptyEl = document.getElementById('cfg-dash-course-completiontime-empty');
        const pager = document.getElementById('cfg-dash-course-completiontime-pagination');

        // Sem dado nenhum (ninguém com activeMs registrado ainda) o Chart.js
        // desenha um eixo numérico "fantasma" com o canvas vazio — em vez
        // disso mostra mensagem e não renderiza o gráfico.
        if (completionTimeDataCache.length === 0) {
            destroyChart('courseCompletionTime');
            if (canvas) canvas.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'flex';
            if (pager) pager.innerHTML = '';
            return;
        }
        if (canvas) canvas.style.display = '';
        if (emptyEl) emptyEl.style.display = 'none';

        renderChart('courseCompletionTime', 'cfg-dash-course-completiontime-chart', {
            type: 'bar',
            data: {
                labels: pageRows.map(r => r.label),
                datasets: [{
                    data: pageRows.map(r => r.avgMs),
                    backgroundColor: pageRows.map(r => r.isGeneral ? CHART_COLORS.muted : CHART_COLORS.accent),
                    borderRadius: 4,
                    // Sem isso o Chart.js reparte a altura toda entre poucas
                    // barras mas deixa cada uma fina (categoryPercentage
                    // baixo por padrão) — resultado "achatado" mesmo com
                    // canvas alto. Sem maxBarThickness (o cap de 34px travava
                    // a barra fina mesmo sobrando espaço) — deixa
                    // barPercentage/categoryPercentage engordarem livre até
                    // preencher o canvas, igual ao gráfico "Taxa de Conclusão
                    // por Unidade" que nunca teve esse problema.
                    barPercentage: 0.9, categoryPercentage: 0.85
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => {
                        const r = pageRows[ctx.dataIndex];
                        const base = `Média: ${formatHHMMSS(r.avgMs)}`;
                        return r.n > 1 ? `${base} (±${formatHHMMSS(r.stddevMs)}, ${r.n} pessoas)` : `${base} (1 pessoa)`;
                    } } }
                },
                scales: { x: { ticks: { callback: (v) => formatHHMM(v) } } }
            },
            plugins: [stddevWhiskerPlugin]
        });
        chartInstances.courseCompletionTime.$stddevs = [pageRows.map(r => r.stddevMs)];

        // O pager é montado ANTES do resize() de propósito: ele fica no mesmo
        // flex column do canvas, então injetá-lo encolhe o canvas. Se o
        // Chart.js medisse antes disso, as coordenadas internas ficariam
        // referentes ao canvas alto e a hitbox de hover/click sairia
        // deslocada pra baixo (hover na última barra acusava a anterior).
        if (pager) {
            if (totalPages <= 1) {
                pager.innerHTML = '';
            } else {
                pager.innerHTML = `<button type="button" class="comments-page-btn" data-page="prev" ${completionTimePage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>` +
                    `<span class="comments-page-info">Página ${completionTimePage} de ${totalPages}</span>` +
                    `<button type="button" class="comments-page-btn" data-page="next" ${completionTimePage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
                pager.querySelectorAll('.comments-page-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        completionTimePage += btn.dataset.page === 'prev' ? -1 : 1;
                        paintCompletionTimePage();
                    });
                });
            }
        }

        // resize() depois do pager e antes do update: o card ganhou altura
        // maior (ver .dashboard-chart-card-tall) mas o Chart.js mede o canvas
        // só na construção — sem isso a hitbox de hover/click das barras fica
        // travada no tamanho antigo, descolada da barra desenhada visualmente.
        chartInstances.courseCompletionTime.resize();
        chartInstances.courseCompletionTime.update('none');
    }

    function renderCourseCompletionTimeChart(data) {
        const selectedUnits = courseChartCompletionTimeUnitChip.getValues();

        if (selectedUnits.size > 0) {
            // Unidade(s) marcada(s): uma barra por pessoa, maior tempo primeiro.
            completionTimeDataCache = data
                .filter(d => selectedUnits.has(d.unit))
                .map(d => ({ label: d.fullName, avgMs: d.durationMs, stddevMs: 0, n: 1 }))
                .sort((a, b) => b.avgMs - a.avgMs);
        } else {
            // Sem filtro: uma barra por unidade, média ± desvio padrão.
            const byUnit = new Map();
            data.forEach(d => {
                const unit = d.unit || 'Sem unidade';
                if (!byUnit.has(unit)) byUnit.set(unit, []);
                byUnit.get(unit).push(d.durationMs);
            });
            completionTimeDataCache = [...byUnit.entries()]
                .map(([unit, durations]) => {
                    const avg = mean(durations);
                    return { label: unit, avgMs: avg, stddevMs: stddev(durations, avg), n: durations.length };
                })
                .sort((a, b) => b.avgMs - a.avgMs);
        }

        // Barra "Geral" (cinza, sempre em 1º): média±desvio de TODOS os
        // aprovados, ignorando filtro de unidade — fica fixa mesmo com
        // unidade(s) marcada(s), pra servir de referência de comparação.
        // Sem dado nenhum não entra, senão o cache nunca fica vazio de
        // verdade e o card de "sem dados suficientes" nunca aparece.
        if (data.length > 0) {
            const allDurations = data.map(d => d.durationMs);
            const generalAvg = mean(allDurations);
            completionTimeDataCache.unshift({
                label: 'Geral', avgMs: generalAvg, stddevMs: stddev(allDurations, generalAvg),
                n: allDurations.length, isGeneral: true
            });
        }

        completionTimePage = 1;
        paintCompletionTimePage();
    }

    // Plugin Chart.js que desenha a "barra de erro" (desvio padrão) sobre
    // cada barra horizontal: um traço central + travessões nas pontas, no
    // valor médio ± stddev. Não há plugin de error bar carregado no projeto
    // (só chart.js@4 puro), então desenha à mão no afterDatasetsDraw.
    // `chart.$stddevs[datasetIndex][dataIndex]` guarda o desvio de cada
    // barra — setado por quem monta o gráfico, já que o Chart.js não tem
    // onde guardar esse dado por ponto além do próprio array de `data`.
    const stddevWhiskerPlugin = {
        id: 'stddevWhisker',
        afterDatasetsDraw(chart) {
            const stddevs = chart.$stddevs;
            if (!stddevs) return;
            const { ctx, scales: { x: xScale } } = chart;
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                if (meta.hidden) return;
                meta.data.forEach((bar, index) => {
                    const sd = stddevs[datasetIndex]?.[index];
                    if (!sd) return;
                    const value = dataset.data[index];
                    const y = bar.y;
                    const xLo = xScale.getPixelForValue(Math.max(0, value - sd));
                    const xHi = xScale.getPixelForValue(value + sd);
                    const cap = Math.min(6, bar.height ? bar.height / 3 : 6);
                    ctx.save();
                    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(xLo, y); ctx.lineTo(xHi, y);
                    ctx.moveTo(xLo, y - cap); ctx.lineTo(xLo, y + cap);
                    ctx.moveTo(xHi, y - cap); ctx.lineTo(xHi, y + cap);
                    ctx.stroke();
                    ctx.restore();
                });
            });
        }
    };

    function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
    function stddev(values, avg) {
        if (values.length < 2) return 0;
        const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
        return Math.sqrt(variance);
    }

    // Tempo médio de DURAÇÃO DA PROVA (campo durationSeconds, mesmo dado da
    // coluna "Tempo" no histórico — não confundir com "Tempo para Conclusão",
    // que mede início do curso até a aprovação), agregado por unidade —
    // ordenado da maior média para a menor. Marcando uma ou mais
    // unidades no filtro, troca a agregação para uma barra por pessoa
    // daquelas unidades (pedido explícito), mantendo média±desvio por barra
    // (desvio de 1 pessoa sozinha é 0, não aparece traço). Paginado como os
    // outros gráficos "por unidade".
    // 5 (+ "Geral" fixo = 6 barras no canvas) — 7 deixava as barras achatadas
    // no card de altura fixa (260px).
    const EVALTIME_PAGE_SIZE = 9;
    let evalTimePage = 1;
    let evalTimeDataCache = [];

    function paintEvalTimePage() {
        // "Geral" (1ª posição do cache, ver renderCourseEvalTimeChart) não
        // entra na paginação normal — fica fixa no topo de toda página, o
        // resto das barras pagina em torno dela.
        const generalRow = evalTimeDataCache[0];
        const rest = evalTimeDataCache.slice(1);
        const totalPages = Math.max(1, Math.ceil(rest.length / EVALTIME_PAGE_SIZE));
        evalTimePage = Math.min(Math.max(1, evalTimePage), totalPages);
        const start = (evalTimePage - 1) * EVALTIME_PAGE_SIZE;
        const pageRows = generalRow ? [generalRow, ...rest.slice(start, start + EVALTIME_PAGE_SIZE)] : [];

        const canvas = document.getElementById('cfg-dash-course-evaltime-chart');
        const emptyEl = document.getElementById('cfg-dash-course-evaltime-empty');
        const pager = document.getElementById('cfg-dash-course-evaltime-pagination');

        if (evalTimeDataCache.length === 0) {
            destroyChart('courseEvalTime');
            if (canvas) canvas.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'flex';
            if (pager) pager.innerHTML = '';
            return;
        }
        if (canvas) canvas.style.display = '';
        if (emptyEl) emptyEl.style.display = 'none';

        renderChart('courseEvalTime', 'cfg-dash-course-evaltime-chart', {
            type: 'bar',
            data: {
                labels: pageRows.map(r => r.label),
                datasets: [{
                    data: pageRows.map(r => r.avgMs),
                    backgroundColor: pageRows.map(r => r.isGeneral ? CHART_COLORS.muted : CHART_COLORS.accent),
                    borderRadius: 4,
                    // Ver comentário equivalente em renderCourseCompletionTimeChart.
                    barPercentage: 0.9, categoryPercentage: 0.85
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => {
                        const r = pageRows[ctx.dataIndex];
                        const base = `Média: ${formatMsAsDuration(r.avgMs)}`;
                        return r.n > 1 ? `${base} (±${formatMsAsDuration(r.stddevMs)}, ${r.n} pessoas)` : `${base} (1 pessoa)`;
                    } } }
                },
                scales: { x: { ticks: { callback: (v) => formatMsAsDuration(v) } } }
            },
            plugins: [stddevWhiskerPlugin]
        });
        chartInstances.courseEvalTime.$stddevs = [pageRows.map(r => r.stddevMs)];

        // Pager antes do resize — ver comentário equivalente em
        // paintCompletionTimePage.
        if (pager) {
            if (totalPages <= 1) {
                pager.innerHTML = '';
            } else {
                pager.innerHTML = `<button type="button" class="comments-page-btn" data-page="prev" ${evalTimePage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>` +
                    `<span class="comments-page-info">Página ${evalTimePage} de ${totalPages}</span>` +
                    `<button type="button" class="comments-page-btn" data-page="next" ${evalTimePage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
                pager.querySelectorAll('.comments-page-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        evalTimePage += btn.dataset.page === 'prev' ? -1 : 1;
                        paintEvalTimePage();
                    });
                });
            }
        }

        chartInstances.courseEvalTime.resize();
        chartInstances.courseEvalTime.update('none');
    }

    function renderCourseEvalTimeChart(data) {
        const selectedUnits = courseChartEvalTimeUnitChip.getValues();

        if (selectedUnits.size > 0) {
            // Unidade(s) marcada(s): uma barra por pessoa, maior tempo primeiro.
            evalTimeDataCache = data
                .filter(d => selectedUnits.has(d.unit))
                .map(d => ({ label: d.fullName, avgMs: d.durationMs, stddevMs: 0, n: 1 }))
                .sort((a, b) => b.avgMs - a.avgMs);
        } else {
            // Sem filtro: uma barra por unidade, média ± desvio padrão.
            const byUnit = new Map();
            data.forEach(d => {
                const unit = d.unit || 'Sem unidade';
                if (!byUnit.has(unit)) byUnit.set(unit, []);
                byUnit.get(unit).push(d.durationMs);
            });
            evalTimeDataCache = [...byUnit.entries()]
                .map(([unit, durations]) => {
                    const avg = mean(durations);
                    return { label: unit, avgMs: avg, stddevMs: stddev(durations, avg), n: durations.length };
                })
                .sort((a, b) => b.avgMs - a.avgMs);
        }

        // Barra "Geral" (cinza, sempre em 1º): média±desvio de TODOS os
        // aprovados, ignorando filtro de unidade — fica fixa mesmo com
        // unidade(s) marcada(s), pra servir de referência de comparação.
        // Sem dado nenhum não entra, senão o cache nunca fica vazio de
        // verdade e o card de "sem dados suficientes" nunca aparece.
        if (data.length > 0) {
            const allDurations = data.map(d => d.durationMs);
            const generalAvg = mean(allDurations);
            evalTimeDataCache.unshift({
                label: 'Geral', avgMs: generalAvg, stddevMs: stddev(allDurations, generalAvg),
                n: allDurations.length, isGeneral: true
            });
        }

        evalTimePage = 1;
        paintEvalTimePage();
    }

    // Taxa de conclusão do curso ao longo do tempo, em % do público-alvo:
    // acumula quem concluiu (última tentativa de cada pessoa) dia a dia e
    // divide pelo total de pessoas elegíveis. Não respeita o filtro de ano
    // do card (a curva precisa do histórico completo pra fazer sentido como
    // acumulado) — só o filtro de unidade, que também recalcula o total.
    function renderCourseCompletionTrendChart(allRows, audience) {
        const selectedUnits = courseChartUnitChip.getValues();
        const scopedRows = selectedUnits.size > 0
            ? allRows.filter(r => selectedUnits.has(r.unit))
            : allRows;
        const scopedAudience = selectedUnits.size > 0
            ? audience.filter(c => selectedUnits.has(c.unit))
            : audience;
        const total = scopedAudience.length || 1;

        // Só conta quem está no público-alvo válido do curso (mesmo critério
        // de courseAudience: ativo, vinculado à planilha, cargo compatível).
        // Sem esse filtro, gente inativa/inválida/de outro cargo que apareceu
        // no histórico inflava o acumulado além do denominador e passava de
        // 100% no gráfico.
        const audienceKeys = new Set();
        scopedAudience.forEach(colab => personKeysOfColaborador(colab).forEach(key => audienceKeys.add(key)));

        // "Concluiu" = data da 1ª tentativa APROVADA de cada pessoa, não a
        // última tentativa registrada — lastAttemptByPerson pegava a tentativa
        // mais recente mesmo quando era uma reprovação depois de já ter
        // passado, ou quando a pessoa refez o curso bem depois de concluído;
        // isso empurrava a data de conclusão pra frente (ou fazia sumir do
        // dia certo) e sub-contava o dia real de aprovação no gráfico.
        const byPerson = new Map();
        scopedRows.forEach(row => {
            if (!row.approved || !row.submittedAt) return;
            const keys = personKeysOfRow(row);
            const key = keys[0];
            if (!key) return;
            if (!keys.some(k => audienceKeys.has(k))) return;
            const current = byPerson.get(key);
            if (!current || row.submittedAt < current.submittedAt) byPerson.set(key, row);
        });
        const last = [...byPerson.values()].sort((a, b) => a.submittedAt - b.submittedAt);

        // Agrupa por dia (data local, sem hora) e acumula. Guarda também
        // quem concluiu em cada dia (nome/unidade/nota) pro clique no ponto.
        const byDay = new Map();
        last.forEach(r => {
            const day = new Date(r.submittedAt).toLocaleDateString('pt-BR');
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push({ fullName: r.fullName || 'Sem nome', unit: r.unit || 'Sem unidade', score: Number(r.score) });
        });

        // Eixo X em dias corridos desde o dia 1. Curso com prazo definido:
        // dia 1 é o início do prazo, não o dia da 1ª conclusão — se ninguém
        // concluiu nos primeiros dias, o gráfico começa "achatado" em vez de
        // já pular pra quando alguém passou, refletindo a adesão real dentro
        // da janela de prazo. Sem prazo definido: cai de volta pro 1º dia
        // com dado, como antes.
        const theme = allTrainingData[courseChartSlugCache]?.[courseChartSubjectIdCache]?.themes?.[courseChartThemeIdCache];
        const deadline = theme?.deadline;
        const dayKeys = [...byDay.keys()];
        // Zera a hora do início do prazo (mesmo critério de parseBrDate) —
        // senão um prazo começando às 14h deslocava a diferença em dias por
        // causa da fração de horas entre ele e a meia-noite das conclusões.
        const firstDay = (deadline?.mode === 'prazo' && deadline.startAt)
            ? parseBrDate(new Date(deadline.startAt).toLocaleDateString('pt-BR'))
            : (dayKeys.length ? parseBrDate(dayKeys[0]) : null);

        let running = 0;
        const labels = [];
        const dateLabels = [];
        const data = [];
        const runningCounts = [];
        const peopleByDay = [];
        dayKeys.forEach(day => {
            const people = byDay.get(day);
            running += people.length;
            const dayNum = firstDay ? Math.round((parseBrDate(day) - firstDay) / 86400000) + 1 : 1;
            labels.push(`${dayNum}º dia`);
            dateLabels.push(day);
            data.push(Math.min(100, Math.round((running / total) * 100)));
            runningCounts.push(running);
            peopleByDay.push(people);
        });

        renderChart('courseCompletionTrend', 'cfg-dash-course-completion-trend-chart', {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Taxa de conclusão', data,
                    borderColor: CHART_COLORS.accent, backgroundColor: CHART_COLORS.accent + '22',
                    fill: true, tension: 0.25, pointRadius: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    const i = elements[0].index;
                    openPeopleModal(`Conclusões — ${labels[i]}`, `Data: ${dateLabels[i]}`, peopleByDay[i],
                        `${peopleByDay[i].length} concluíram neste dia (${runningCounts[i]} de ${total} no acumulado, ${data[i]}%)`);
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: (items) => `${items[0].label} · ${dateLabels[items[0].dataIndex]}`,
                        label: (ctx) => `${runningCounts[ctx.dataIndex]} de ${total} concluíram (${ctx.parsed.y}%)`
                    } }
                },
                scales: { y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } }
            }
        });
    }

    // % de conclusão por unidade — denominador é o total de pessoas do
    // público-alvo daquela unidade (não só quem já concluiu), então a barra
    // mostra o quanto falta de fato. Paginado e ordenado da maior taxa para
    // a menor, mesmo critério visual do gráfico "Realização por Unidade".
    const UNIT_COMPLETION_PAGE_SIZE = 7;
    let unitCompletionPage = 1;
    let unitCompletionDataCache = [];

    function paintUnitCompletionPage() {
        const totalPages = Math.max(1, Math.ceil(unitCompletionDataCache.length / UNIT_COMPLETION_PAGE_SIZE));
        unitCompletionPage = Math.min(Math.max(1, unitCompletionPage), totalPages);
        const start = (unitCompletionPage - 1) * UNIT_COMPLETION_PAGE_SIZE;
        const pageUnits = unitCompletionDataCache.slice(start, start + UNIT_COMPLETION_PAGE_SIZE);

        renderChart('courseUnitCompletion', 'cfg-dash-course-unit-completion-chart', {
            type: 'bar',
            data: {
                labels: pageUnits.map(u => u.unit),
                datasets: [{ data: pageUnits.map(u => u.pct), backgroundColor: CHART_COLORS.accent, borderRadius: 4 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    const u = pageUnits[elements[0].index];
                    openProgressModal(u.unit, '', u.people, `${u.done} de ${u.total} concluíram (${u.pct}%)`);
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => {
                        const u = pageUnits[ctx.dataIndex];
                        return `${u.done} de ${u.total} concluíram (${u.pct}%)`;
                    } } }
                },
                scales: { x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } }
            }
        });

        const pager = document.getElementById('cfg-dash-course-unit-completion-pagination');
        if (!pager) return;
        if (totalPages <= 1) { pager.innerHTML = ''; return; }
        pager.innerHTML = `<button type="button" class="comments-page-btn" data-page="prev" ${unitCompletionPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>` +
            `<span class="comments-page-info">Página ${unitCompletionPage} de ${totalPages}</span>` +
            `<button type="button" class="comments-page-btn" data-page="next" ${unitCompletionPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
        pager.querySelectorAll('.comments-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                unitCompletionPage += btn.dataset.page === 'prev' ? -1 : 1;
                paintUnitCompletionPage();
            });
        });
    }

    function renderCourseUnitCompletionChart(allRows, audience) {
        const doneKeys = new Set();
        lastAttemptByPerson(allRows).forEach(row => personKeysOfRow(row).forEach(key => doneKeys.add(key)));

        const byUnit = new Map();
        audience.forEach(colab => {
            const unit = colab.unit || 'Sem unidade';
            if (!byUnit.has(unit)) byUnit.set(unit, { total: 0, done: 0, people: [] });
            const entry = byUnit.get(unit);
            entry.total++;
            if (personKeysOfColaborador(colab).some(key => doneKeys.has(key))) entry.done++;
            // Progresso (% de módulos assistidos) de cada colaborador —
            // mesmo dado usado pela tabela "Faltam realizar", só que aqui
            // pra unidade inteira (concluídos entram com 100%).
            entry.people.push({
                fullName: colab.fullName,
                unit,
                pct: progressPctFor(colab, courseChartSlugCache, courseChartSubjectIdCache, courseChartThemeIdCache)
            });
        });

        unitCompletionDataCache = [...byUnit.entries()]
            .map(([unit, e]) => ({ unit, total: e.total, done: e.done, pct: e.total ? Math.round((e.done / e.total) * 100) : 0, people: e.people }))
            .sort((a, b) => b.pct - a.pct);
        unitCompletionPage = 1;
        paintUnitCompletionPage();
    }

    // Distribuição das notas de prova, arredondadas sem casa decimal (0-10),
    // coloridas por faixa: 10 verde, 8-9 limão, 6-7 amarelo, 4-5 laranja,
    // <4 vermelho.
    function scoreBarColor(score) {
        if (score >= 10) return CHART_COLORS.success;
        if (score >= 8) return CHART_COLORS.lime;
        if (score >= 6) return CHART_COLORS.yellow;
        if (score >= 4) return CHART_COLORS.orange;
        return CHART_COLORS.danger;
    }

    function renderCourseScoresChart(rows) {
        const counts = new Array(11).fill(0); // índice 0..10
        const peopleByScore = Array.from({ length: 11 }, () => []); // pessoas por nota, pra clique na barra
        let total = 0;
        rows.forEach(r => {
            const score = Number(r.score);
            if (!Number.isFinite(score)) return;
            // Arredonda pra baixo, não pro mais próximo — nota 9,5 é nota 9,
            // não deve inflar a barra do 10 (critério de aprovação é por
            // nota cheia, não por proximidade).
            const rounded = Math.min(10, Math.max(0, Math.floor(score)));
            counts[rounded]++;
            peopleByScore[rounded].push({ fullName: r.fullName || 'Sem nome', unit: r.unit || 'Sem unidade', score });
            total++;
        });

        renderChart('courseScores', 'cfg-dash-course-scores-chart', {
            type: 'bar',
            data: {
                labels: counts.map((_, score) => String(score)),
                datasets: [{ data: counts, backgroundColor: counts.map((_, score) => scoreBarColor(score)), borderRadius: 4 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    const score = elements[0].index;
                    const pct = total > 0 ? Math.round((counts[score] / total) * 100) : 0;
                    openPeopleModal(`Nota ${score}`, '', peopleByScore[score],
                        `${counts[score]} de ${total} colaboradores tiraram nota ${score} (${pct}%)`);
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => {
                        // Chart vertical: valor real vem de parsed.y, não .x
                        // (singleSeriesTooltipLabel assume barra horizontal e
                        // pegaria o rótulo do eixo x — a própria nota — como
                        // se fosse a contagem).
                        const value = Number(ctx.parsed.y) || 0;
                        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
                        return `${value} (${pct}%)`;
                    } } }
                },
                scales: { x: { title: { display: true, text: 'Nota' } }, y: { ticks: { precision: 0 } } }
            }
        });
    }

    // Faixa de nota para o empilhado por unidade: 10 verde, 8-9 limão, 6-7
    // laranja, <6 crítico (vermelho) — critério pedido explicitamente,
    // diferente das 5 faixas de scoreBarColor (que tem uma faixa a mais,
    // 4-5, usada só no histograma "Notas").
    const SCORE_BAND_DEFS = [
        { key: 'nota10', label: 'Nota 10', color: CHART_COLORS.success, test: (s) => s >= 10 },
        { key: 'nota89', label: 'Nota 8-9', color: CHART_COLORS.lime, test: (s) => s >= 8 },
        { key: 'nota67', label: 'Nota 6-7', color: CHART_COLORS.orange, test: (s) => s >= 6 },
        { key: 'critico', label: 'Crítico (<6)', color: CHART_COLORS.danger, test: () => true }
    ];
    function scoreBand(score) { return SCORE_BAND_DEFS.find(b => b.test(score)); }

    // Notas por unidade, empilhadas por faixa (uma pessoa conta pela sua
    // última tentativa, mesmo critério dos demais gráficos "por pessoa") e
    // normalizadas em % da unidade — dá pra comparar unidades com números
    // de gente bem diferentes. Ordenado pela pior situação primeiro (maior %
    // crítico) pra chamar atenção de quem precisa de reforço. Paginado como
    // os outros gráficos "por unidade".
    const SCORES_BYUNIT_PAGE_SIZE = 7;
    let scoresByUnitPage = 1;
    let scoresByUnitDataCache = [];

    function paintScoresByUnitPage() {
        const totalPages = Math.max(1, Math.ceil(scoresByUnitDataCache.length / SCORES_BYUNIT_PAGE_SIZE));
        scoresByUnitPage = Math.min(Math.max(1, scoresByUnitPage), totalPages);
        const start = (scoresByUnitPage - 1) * SCORES_BYUNIT_PAGE_SIZE;
        const pageUnits = scoresByUnitDataCache.slice(start, start + SCORES_BYUNIT_PAGE_SIZE);

        renderChart('courseScoresByUnit', 'cfg-dash-course-scores-byunit-chart', {
            type: 'bar',
            data: {
                labels: pageUnits.map(u => u.unit),
                datasets: SCORE_BAND_DEFS.map(band => ({
                    label: band.label, backgroundColor: band.color,
                    data: pageUnits.map(u => u.total ? (u.counts[band.key] / u.total) * 100 : 0)
                }))
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    const { datasetIndex, index } = elements[0];
                    const u = pageUnits[index];
                    const band = SCORE_BAND_DEFS[datasetIndex];
                    const count = u.counts[band.key];
                    const pct = u.total > 0 ? Math.round((count / u.total) * 100) : 0;
                    openPeopleModal(`${band.label} — ${u.unit}`, '', u.people[band.key],
                        `${count} de ${u.total} colaboradores da unidade (${pct}%)`);
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                plugins: {
                    tooltip: { callbacks: { label: (ctx) => {
                        const u = pageUnits[ctx.dataIndex];
                        const band = SCORE_BAND_DEFS[ctx.datasetIndex];
                        const count = u.counts[band.key];
                        return `${band.label}: ${count} (${Math.round(ctx.parsed.x)}%)`;
                    } } }
                },
                scales: { x: { stacked: true, min: 0, max: 100, ticks: { callback: (v) => `${v}%` } }, y: { stacked: true } }
            }
        });

        const pager = document.getElementById('cfg-dash-course-scores-byunit-pagination');
        if (!pager) return;
        if (totalPages <= 1) { pager.innerHTML = ''; return; }
        pager.innerHTML = `<button type="button" class="comments-page-btn" data-page="prev" ${scoresByUnitPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>` +
            `<span class="comments-page-info">Página ${scoresByUnitPage} de ${totalPages}</span>` +
            `<button type="button" class="comments-page-btn" data-page="next" ${scoresByUnitPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
        pager.querySelectorAll('.comments-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                scoresByUnitPage += btn.dataset.page === 'prev' ? -1 : 1;
                paintScoresByUnitPage();
            });
        });
    }

    function renderCourseScoresByUnitChart(rows) {
        const byUnit = new Map();
        lastAttemptByPerson(rows).forEach(r => {
            const score = Number(r.score);
            if (!Number.isFinite(score)) return;
            const unit = r.unit || 'Sem unidade';
            if (!byUnit.has(unit)) byUnit.set(unit, {
                total: 0,
                counts: { nota10: 0, nota89: 0, nota67: 0, critico: 0 },
                people: { nota10: [], nota89: [], nota67: [], critico: [] }
            });
            const entry = byUnit.get(unit);
            entry.total++;
            const band = scoreBand(score).key;
            entry.counts[band]++;
            entry.people[band].push({ fullName: r.fullName || 'Sem nome', unit, score });
        });

        scoresByUnitDataCache = [...byUnit.entries()]
            .map(([unit, e]) => ({ unit, total: e.total, counts: e.counts, people: e.people }))
            .sort((a, b) => (b.total ? b.counts.critico / b.total : 0) - (a.total ? a.counts.critico / a.total : 0));
        scoresByUnitPage = 1;
        paintScoresByUnitPage();
    }

    // Ranking das questões com mais erros, do maior para o menor — ajuda a
    // localizar perguntas mal formuladas ou conteúdo pouco compreendido.
    // Agrupa por enunciado (mesma questão pode mudar de índice entre
    // versões do quiz) e mostra só o trecho inicial no eixo, enunciado
    // completo no tooltip.
    const MISTAKES_TOP_N = 8;

    function renderCourseMistakesChart(rows) {
        const canvas = document.getElementById('cfg-dash-course-mistakes-chart');
        if (!canvas) return;

        // Conta por PESSOA, não por tentativa — quem errou a mesma questão
        // em várias retentativas entra só uma vez (senão retentativa infla
        // artificialmente a taxa de erro de uma questão fácil).
        // Denominador da % é o total de pessoas que concluíram o curso
        // (universo fixo, igual pra todas as questões) — não só quem
        // respondeu aquela questão específica, senão quem pulou/não chegou
        // nela infla a taxa de erro artificialmente.
        const totalPeople = new Set();
        const stats = new Map(); // enunciado -> { number, question, options, correct, wrongPeople: Map<personKey, {fullName, unit, selected}> }
        rows.forEach(r => {
            const personKey = personKeysOfRow(r)[0];
            if (!personKey) return;
            totalPeople.add(personKey);
            (r.answers || []).forEach((a, index) => {
                if (!a || !a.question) return;
                const key = a.question;
                const entry = stats.get(key) || {
                    number: index + 1, question: a.question,
                    options: Array.isArray(a.options) ? a.options : [], correct: a.correct,
                    wrongPeople: new Map()
                };
                if (a.selected !== a.correct) entry.wrongPeople.set(personKey, { fullName: r.fullName || 'Sem nome', unit: r.unit || 'Sem unidade', selected: a.selected });
                stats.set(key, entry);
            });
        });

        const ranked = Array.from(stats.values())
            .map(e => ({
                number: e.number, question: e.question, options: e.options, correct: e.correct,
                wrong: e.wrongPeople.size, total: totalPeople.size, wrongPeople: Array.from(e.wrongPeople.values())
            }))
            .filter(e => e.wrong > 0)
            .sort((a, b) => b.wrong - a.wrong)
            .slice(0, MISTAKES_TOP_N);

        if (ranked.length === 0) {
            renderChart('courseMistakes', 'cfg-dash-course-mistakes-chart', {
                type: 'bar', data: { labels: [], datasets: [] },
                options: { responsive: true, maintainAspectRatio: false }
            });
            return;
        }

        // Quebra o enunciado em linhas curtas por palavra inteira — Chart.js
        // renderiza um array de strings do callback `label` como um tooltip
        // multi-linha.
        const wrapText = (text, maxLen = 42) => {
            const words = text.trim().split(/\s+/);
            const lines = [];
            let line = '';
            words.forEach(word => {
                const candidate = line ? `${line} ${word}` : word;
                if (candidate.length > maxLen && line) {
                    lines.push(line);
                    line = word;
                } else {
                    line = candidate;
                }
            });
            if (line) lines.push(line);
            return lines;
        };

        const errorPct = (e) => e.total > 0 ? (e.wrong / e.total) * 100 : 0;

        // Cor pela TAXA de erro (% de alunos que erraram), não pelo nº
        // absoluto de erros que o eixo x mostra — amarelo até 5%, laranja até
        // 10%, vermelho acima disso. Quando a barra cruza um desses limiares
        // (ex.: taxa de 39% numa barra que representa 0%–39%), o degradê
        // marca a transição de faixa dentro do próprio trecho da barra;
        // acima de 10% a barra já nasce vermelha (sem faixas anteriores pra
        // mostrar).
        const mistakeGradient = (ctx) => {
            const { chart, dataIndex } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea || dataIndex == null) return CHART_COLORS.danger;
            const entry = ranked[dataIndex];
            const pct = errorPct(entry);

            // Gradiente tem que cobrir só o trecho da barra (0 até o valor
            // dela no eixo x), não o chartArea inteiro — senão a barra mais
            // curta mostra uma fatia do degradê pensado pra barra mais longa
            // e as faixas de cor saem desalinhadas com a % real de erro.
            const xScale = chart.scales.x;
            const barStart = chartArea.left;
            const barEnd = xScale ? xScale.getPixelForValue(entry.wrong) : chartArea.right;

            if (pct <= 5) return CHART_COLORS.yellow;

            // Transição levemente suave entre faixas (blend de ~4% da barra
            // em vez de corte seco) — evita degradê brusco entre as cores.
            const BLEND = 0.04;
            const blendAround = (stop) => [Math.max(0, stop - BLEND), Math.min(1, stop + BLEND)];

            const gradient = c.createLinearGradient(barStart, 0, barEnd, 0);
            if (pct <= 10) {
                // Cruza só o limiar amarelo→laranja: sólida até proporção
                // 5/pct da barra, laranja no resto.
                const split = 5 / pct;
                const [a, b] = blendAround(split);
                gradient.addColorStop(0, CHART_COLORS.yellow);
                gradient.addColorStop(a, CHART_COLORS.yellow);
                gradient.addColorStop(b, CHART_COLORS.orange);
                gradient.addColorStop(1, CHART_COLORS.orange);
                return gradient;
            }
            // Acima de 10%: cruza as duas faixas — amarelo até 5%, laranja
            // até 10%, vermelho no resto (posições proporcionais a pct).
            const yellowSplit = 5 / pct;
            const orangeSplit = 10 / pct;
            const [ya, yb] = blendAround(yellowSplit);
            const [oa, ob] = blendAround(orangeSplit);
            gradient.addColorStop(0, CHART_COLORS.yellow);
            gradient.addColorStop(ya, CHART_COLORS.yellow);
            gradient.addColorStop(Math.min(yb, oa - 0.001), CHART_COLORS.orange);
            gradient.addColorStop(oa, CHART_COLORS.orange);
            gradient.addColorStop(ob, CHART_COLORS.danger);
            gradient.addColorStop(1, CHART_COLORS.danger);
            return gradient;
        };

        renderChart('courseMistakes', 'cfg-dash-course-mistakes-chart', {
            type: 'bar',
            data: {
                labels: ranked.map(e => `Questão ${e.number}`),
                datasets: [{ data: ranked.map(e => e.wrong), backgroundColor: mistakeGradient, borderRadius: 4 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    openMistakeModal(ranked[elements[0].index]);
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: (items) => `Questão ${ranked[items[0].dataIndex].number}`,
                        label: (ctx) => wrapText(ranked[ctx.dataIndex].question),
                        afterLabel: (ctx) => {
                            const e = ranked[ctx.dataIndex];
                            return `Erros: ${e.wrong} de ${e.total} (${Math.round(errorPct(e))}%)`;
                        }
                    } }
                },
                scales: { x: { ticks: { precision: 0 } } }
            }
        });
    }

    // ─── Modal "quem errou": colaboradores por unidade que erraram a
    // questão clicada no gráfico "Principais Erros" ───
    const mistakeModal = document.getElementById('cfg-dash-mistake-modal');
    const mistakeModalTitle = document.getElementById('cfg-dash-mistake-modal-title');
    const mistakeModalClose = document.getElementById('cfg-dash-mistake-modal-close');
    const mistakeModalSubtitle = document.getElementById('cfg-dash-mistake-modal-subtitle');
    const mistakeModalBody = document.getElementById('cfg-dash-mistake-modal-body');

    function closeMistakeModal() { if (mistakeModal) mistakeModal.style.display = 'none'; }

    // Modal genérico "lista de colaboradores por unidade" — usado pelo
    // clique nas barras de Principais Erros, Notas e Notas por Unidade.
    // `people`: array de {fullName, unit, score?} — `score`, quando presente
    // (gráficos de nota), mostra a nota exata do aluno ao lado do nome.
    // `countLabel`: texto do resumo no topo (já pronto, cada gráfico formata o seu).
    function openPeopleModal(title, subtitle, people, countLabel) {
        if (!mistakeModal) return;
        if (mistakeModalTitle) mistakeModalTitle.textContent = title;
        if (mistakeModalSubtitle) mistakeModalSubtitle.textContent = subtitle || '';
        if (mistakeModalBody) {
            const byUnit = new Map();
            people
                .slice()
                .sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'))
                .forEach(p => {
                    const unit = p.unit || 'Sem unidade';
                    if (!byUnit.has(unit)) byUnit.set(unit, []);
                    byUnit.get(unit).push(p);
                });
            const units = Array.from(byUnit.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
            mistakeModalBody.innerHTML = (countLabel ? `<p class="dash-mistake-modal-count">${countLabel}</p>` : '') +
                (units.length === 0 ? emptyStateHtml('fa-users', 'Nenhum colaborador encontrado.') :
                units.map(([unit, unitPeople]) => `
                    <div class="dash-mistake-unit-group">
                        <h3><i class="fas fa-building"></i> ${escapeHtml(unit)} <span class="tab-count">${unitPeople.length}</span></h3>
                        <ul class="dash-mistake-name-list">${unitPeople.map(p => `<li><span class="row-name">${avatarHtml(p.fullName)} ${escapeHtml(p.fullName)}</span>${Number.isFinite(p.score) ? scoreBadgeHtml(p.score) : ''}</li>`).join('')}</ul>
                    </div>
                `).join(''));
        }
        mistakeModal.style.display = 'flex';
    }

    // Letra da alternativa (0 -> a, 1 -> b, ...) usada no Gabarito e no balão
    // ao lado do nome de quem errou (mostra qual alternativa a pessoa marcou).
    function optionLetter(index) {
        return String.fromCharCode(97 + index);
    }

    // Modal "Questão N": mostra o gabarito completo (todas as alternativas,
    // correta destacada em verde) com uma barra de volume por alternativa —
    // só contando quem ERROU (a base de dados só guarda quem errou cada
    // questão, ver renderCourseMistakesChart; a alternativa correta nunca
    // aparece na barra pois por definição ninguém que a marcou está em
    // wrongPeople) — seguida da lista de colaboradores que erraram, por
    // unidade, como já era.
    function openMistakeModal(entry) {
        const pct = entry.total > 0 ? Math.round((entry.wrong / entry.total) * 100) : 0;
        if (!mistakeModal) return;
        if (mistakeModalTitle) mistakeModalTitle.textContent = `Questão ${entry.number}`;
        if (mistakeModalSubtitle) mistakeModalSubtitle.textContent = entry.question || '';

        // Volume de erros por alternativa escolhida (índice -> contagem).
        const countsByOption = new Map();
        entry.wrongPeople.forEach(p => {
            if (!Number.isFinite(p.selected)) return;
            countsByOption.set(p.selected, (countsByOption.get(p.selected) || 0) + 1);
        });
        const maxCount = Math.max(1, ...countsByOption.values());

        const answerKeyHtml = (entry.options || []).length === 0 ? '' : `
            <div class="dash-mistake-answerkey">
                <h3>Gabarito</h3>
                ${entry.options.map((opt, i) => {
                    const isCorrect = i === entry.correct;
                    const count = countsByOption.get(i) || 0;
                    const barPct = isCorrect ? 0 : Math.round((count / maxCount) * 100);
                    return `
                        <div class="dash-mistake-option ${isCorrect ? 'is-correct' : ''}">
                            <div class="dash-mistake-option-row">
                                <span class="dash-mistake-option-text">${isCorrect ? '<i class="fas fa-check-circle"></i> ' : ''}<b class="dash-mistake-option-letter">${optionLetter(i)}.</b> ${escapeHtml(opt)}</span>
                                <span class="dash-mistake-option-count">${isCorrect ? 'Correta' : `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`}</span>
                            </div>
                            ${isCorrect ? '' : `<div class="dash-mistake-option-bar"><span style="width:${count > 0 ? Math.max(barPct, 4) : 0}%"></span></div>`}
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        if (mistakeModalBody) {
            const byUnit = new Map();
            entry.wrongPeople
                .slice()
                .sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'))
                .forEach(p => {
                    const unit = p.unit || 'Sem unidade';
                    if (!byUnit.has(unit)) byUnit.set(unit, []);
                    byUnit.get(unit).push(p);
                });
            const units = Array.from(byUnit.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
            mistakeModalBody.innerHTML = answerKeyHtml +
                `<p class="dash-mistake-modal-count">${entry.wrong} de ${entry.total} colaboradores erraram (${pct}%)</p>` +
                (units.length === 0 ? emptyStateHtml('fa-users', 'Nenhum colaborador encontrado.') :
                units.map(([unit, unitPeople]) => `
                    <div class="dash-mistake-unit-group">
                        <h3><i class="fas fa-building"></i> ${escapeHtml(unit)} <span class="tab-count">${unitPeople.length}</span></h3>
                        <ul class="dash-mistake-name-list">${unitPeople.map(p => `<li><span class="row-name">${avatarHtml(p.fullName)} ${escapeHtml(p.fullName)}</span>${Number.isFinite(p.selected) ? `<span class="dash-mistake-option-chip">${optionLetter(p.selected)}</span>` : ''}</li>`).join('')}</ul>
                    </div>
                `).join(''));
        }
        mistakeModal.style.display = 'flex';
    }

    // Modal de PROGRESSO por unidade — mesma estrutura do modal de pessoas,
    // mas cada linha mostra a barra de % assistido em vez da nota (usado
    // pelo clique nas barras de "Taxa de Conclusão por Unidade", mesmo
    // visual da tabela "Faltam realizar").
    // `people`: array de {fullName, unit, pct}.
    function openProgressModal(title, subtitle, people, countLabel) {
        if (!mistakeModal) return;
        if (mistakeModalTitle) mistakeModalTitle.textContent = title;
        if (mistakeModalSubtitle) mistakeModalSubtitle.textContent = subtitle || '';
        if (mistakeModalBody) {
            const byUnit = new Map();
            people
                .slice()
                .sort((a, b) => b.pct - a.pct || a.fullName.localeCompare(b.fullName, 'pt-BR'))
                .forEach(p => {
                    const unit = p.unit || 'Sem unidade';
                    if (!byUnit.has(unit)) byUnit.set(unit, []);
                    byUnit.get(unit).push(p);
                });
            const units = Array.from(byUnit.entries()).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
            mistakeModalBody.innerHTML = (countLabel ? `<p class="dash-mistake-modal-count">${countLabel}</p>` : '') +
                (units.length === 0 ? emptyStateHtml('fa-users', 'Nenhum colaborador encontrado.') :
                units.map(([unit, unitPeople]) => `
                    <div class="dash-mistake-unit-group">
                        <h3><i class="fas fa-building"></i> ${escapeHtml(unit)} <span class="tab-count">${unitPeople.length}</span></h3>
                        <ul class="dash-mistake-name-list">${unitPeople.map(p => `
                            <li>
                                <span class="row-name">${avatarHtml(p.fullName)} ${escapeHtml(p.fullName)}</span>
                                <div class="missing-progress" title="${p.pct}% assistido">
                                    <div class="missing-progress-bar"><span class="${progressToneClass(p.pct)}" style="width:${p.pct}%"></span></div>
                                    <span class="missing-progress-pct">${p.pct}%</span>
                                </div>
                            </li>
                        `).join('')}</ul>
                    </div>
                `).join(''));
        }
        mistakeModal.style.display = 'flex';
    }

    mistakeModalClose?.addEventListener('click', closeMistakeModal);
    mistakeModal?.addEventListener('click', (event) => { if (event.target === mistakeModal) closeMistakeModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && mistakeModal?.style.display === 'flex') closeMistakeModal();
    });

    async function renderCourseDashboard(slug, courseKey) {
        const [subjectId, themeId] = courseKey.split('_');
        courseChartSlugCache = slug;
        courseChartSubjectIdCache = subjectId;
        courseChartThemeIdCache = themeId;

        const rows = await fetchCourseResults(slug, subjectId, themeId);

        // "Realização do curso": denominador = público-alvo do curso (mesma
        // base de courseAudience usada nos cards e na tabela "Faltam
        // realizar"), não só contas de login — evita subestimar "Realizou"
        // quando boa parte das conclusões vem de colaboradores sem conta
        // própria (estágio livre, importados).
        const theme = allTrainingData[slug]?.[subjectId]?.themes?.[themeId];
        let realizou, faltaram;
        if (theme && !AUDIENCE_EXEMPT_SLUGS.includes(slug)) {
            const doneKeys = new Set();
            rows.forEach(row => personKeysOfRow(row).forEach(key => doneKeys.add(key)));
            const audience = courseAudience(theme);
            realizou = audience.filter(colab => personKeysOfColaborador(colab).some(key => doneKeys.has(key))).length;
            faltaram = Math.max(0, audience.length - realizou);
            courseChartAudienceCache = audience;
        } else {
            // Sem público-alvo definido (ex.: estágios): volta ao total de
            // contas cadastradas, mesmo critério de antes.
            const totalUsers = Object.keys(allUsers).length;
            realizou = rows.filter(r => r.userId).length;
            faltaram = Math.max(0, totalUsers - realizou);
            courseChartAudienceCache = Object.keys(allColaboradores)
                .map(id => ({ id, ...allColaboradores[id] }))
                .filter(c => c.fullName && c.active !== false && c.inSheet !== false);
        }
        renderChart('courseCompletion', 'cfg-dash-course-completion-chart', {
            type: 'pie',
            data: { labels: ['Realizou', 'Falta'], datasets: [{ data: [realizou, faltaram], backgroundColor: [CHART_COLORS.accent, CHART_COLORS.danger] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: (ctx) => pieTooltipLabel(ctx) } } } }
        });

        renderCommentsTable(rows);

        renderCompletedTable(rows, slug, subjectId, themeId);
        if (theme) renderMissingTable(rows, slug, subjectId, { id: themeId, ...theme });

        courseChartRowsCache = rows;
        courseChartYearChip.setYears(yearsFromRows(rows));
        renderCourseCharts(rows);

        renderCourseHero(rows, theme, realizou);
        updateTabCounts(rows);
    }

    // Quantos precisaram de mais de uma tentativa para passar — sinaliza
    // dificuldade real do curso (prova mal calibrada, conteúdo confuso etc).
    function renderCourseRetriesChart(rows) {
        const people = attemptsByPerson(rows);
        const firstTry = people.filter(p => p.approved && p.attempts === 1).length;
        const retried = people.filter(p => p.approved && p.attempts > 1).length;
        const stillFailed = people.filter(p => !p.approved).length;
        renderChart('courseRetries', 'cfg-dash-course-retries-chart', {
            type: 'bar',
            data: {
                labels: ['Retentativas'],
                datasets: [
                    { label: 'Aprovado na 1ª tentativa', data: [firstTry], backgroundColor: CHART_COLORS.success },
                    { label: 'Aprovado após retentativa', data: [retried], backgroundColor: CHART_COLORS.warning },
                    { label: 'Ainda reprovado', data: [stillFailed], backgroundColor: CHART_COLORS.danger }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: { tooltip: { callbacks: { label: (ctx) => percentTooltipLabel(ctx) } } },
                scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } }
            }
        });
    }

    // Comparativo de realização por unidade — ajuda o gestor a identificar
    // qual unidade está atrasada para cobrar localmente. Paginado: com muitas
    // unidades o gráfico ficava espremido demais para ler.
    const BYUNIT_PAGE_SIZE = 7;
    let byUnitPage = 1;
    let byUnitDataCache = [];

    function paintByUnitPage() {
        const totalPages = Math.max(1, Math.ceil(byUnitDataCache.length / BYUNIT_PAGE_SIZE));
        byUnitPage = Math.min(Math.max(1, byUnitPage), totalPages);
        const start = (byUnitPage - 1) * BYUNIT_PAGE_SIZE;
        const pageUnits = byUnitDataCache.slice(start, start + BYUNIT_PAGE_SIZE);

        renderChart('courseByUnit', 'cfg-dash-course-byunit-chart', {
            type: 'bar',
            data: {
                labels: pageUnits.map(u => u.unit),
                datasets: [
                    { label: 'No prazo', data: pageUnits.map(u => u.onTime), backgroundColor: CHART_COLORS.accent },
                    { label: 'Fora do prazo', data: pageUnits.map(u => u.late), backgroundColor: CHART_COLORS.danger }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: { tooltip: { callbacks: { label: (ctx) => percentTooltipLabel(ctx) } } },
                scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } }
            }
        });

        const pager = document.getElementById('cfg-dash-course-byunit-pagination');
        if (!pager) return;
        if (totalPages <= 1) { pager.innerHTML = ''; return; }
        pager.innerHTML = `<button type="button" class="comments-page-btn" data-page="prev" ${byUnitPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>` +
            `<span class="comments-page-info">Página ${byUnitPage} de ${totalPages}</span>` +
            `<button type="button" class="comments-page-btn" data-page="next" ${byUnitPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
        pager.querySelectorAll('.comments-page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                byUnitPage += btn.dataset.page === 'prev' ? -1 : 1;
                paintByUnitPage();
            });
        });
    }

    function renderCourseByUnitChart(rows) {
        const byUnit = new Map();
        lastAttemptByPerson(rows).forEach(r => {
            const unit = r.unit || 'Sem unidade';
            if (!byUnit.has(unit)) byUnit.set(unit, { onTime: 0, late: 0 });
            const entry = byUnit.get(unit);
            if (['on_time', 'livre', 'forgiven'].includes(r.deadlineStatus)) entry.onTime++; else entry.late++;
        });
        const units = [...byUnit.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        byUnitDataCache = units.map(unit => ({ unit, ...byUnit.get(unit) }));
        byUnitPage = 1;
        paintByUnitPage();
    }

    function formatShortDate(timestamp) {
        if (!timestamp) return '—';
        return new Date(timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    // Resumo rápido no topo do modal: concluídos, pendentes, média, tempo
    // médio de prova, tempo médio de conclusão (do início ao aprovado) e o
    // prazo do curso (quando configurado) — panorama sem trocar de aba.
    function renderCourseHero(rows, theme, realizou) {
        if (!courseHeroStats) return;
        const scores = rows.map(r => Number(r.score) || 0);
        const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1).replace('.', ',') : '—';
        const pendentes = missingRowsCache.length;
        const durationLabel = formatDuration(avgDuration(rows));

        const completionTimes = buildCompletionTimeData(rows, courseChartSlugCache);
        const avgCompletionLabel = completionTimes.length
            ? formatHHMMSS(completionTimes.reduce((sum, d) => sum + d.durationMs, 0) / completionTimes.length)
            : '—';

        const deadline = theme?.deadline;
        const deadlineLabel = deadline?.mode === 'prazo' && (deadline.startAt || deadline.endAt)
            ? `${formatShortDate(deadline.startAt)} - ${formatShortDate(deadline.endAt)}`
            : null;

        // "Concluídos" = pessoas únicas, não rows.length — rows.length conta
        // cada tentativa, então quem se reavalia depois de já ter passado
        // inflava o número além da quantidade real de gente (destoando do
        // gráfico "Taxa de Conclusão do Curso", que já dedupa por pessoa).
        const concluidos = realizou ?? new Set(rows.flatMap(r => personKeysOfRow(r))).size;

        courseHeroStats.innerHTML = `
            <span class="hero-stat is-ok"><i class="fas fa-circle-check"></i> ${concluidos} ${concluidos === 1 ? 'concluído' : 'concluídos'}</span>
            <span class="hero-stat is-warn"><i class="fas fa-hourglass-half"></i> ${pendentes} ${pendentes === 1 ? 'pendente' : 'pendentes'}</span>
            <span class="hero-stat"><i class="fas fa-star"></i> Média ${avg}</span>
            <span class="hero-stat"><i class="fas fa-clock"></i> Tempo médio de prova ${durationLabel}</span>
            <span class="hero-stat"><i class="fas fa-hourglass-end"></i> Tempo médio de conclusão ${avgCompletionLabel}</span>
            ${deadlineLabel ? `<span class="hero-stat"><i class="fas fa-calendar-days"></i> Prazo: ${deadlineLabel}</span>` : ''}
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
            // Os gráficos da aba "Gráficos" (incl. "Tempo para Conclusão" e
            // "...da Avaliação") são desenhados enquanto essa aba ainda está
            // display:none (tab não ativa por padrão) — o Chart.js mede
            // altura 0 nesse momento e congela um layout achatado, cujas
            // coordenadas internas (usadas pelo stddevWhiskerPlugin pra
            // posicionar a barra de erro) ficam fora de sincronia com o que
            // a barra aparenta ocupar depois que a aba fica visível. Forçar
            // resize() ao entrar na aba corrige a medida real e realinha o
            // whisker com a barra.
            if (target === 'charts') resizeChartsIn(courseModal);
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
            message: `Todo o progresso, as avaliações e o contador de tentativas de "${openCourseName || 'este curso'}" serão apagados para todos os colaboradores. Eles poderão assistir e avaliar o curso novamente, sem nenhum bloqueio. Esta ação não pode ser desfeita.`,
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

            // attempts/byUser (js/attempts.js) é o contador de tentativas
            // deste curso — reseta o histórico, então o bloqueio também some
            // (senão o aluno ficaria travado num curso sem nenhum resultado).
            if (byCourseSnap.exists()) {
                Object.keys(byCourseSnap.val()).forEach(userId => {
                    updates[`/${dbRoot}/attempts/byUser/${userId}/${openCourseSlug}/${subjectId}/${themeId}`] = null;
                });
            }

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

    // Redesenha tudo que está na tela a partir do estado já carregado. Isolado
    // de loadBaseData() para que uma atualização vinda de listener não precise
    // rebaixar tudo de novo — o listener já trouxe o dado novo.
    function renderEverything() {
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
    }

    // ─── Sincronização ao vivo ───
    // Sem isto, o painel só relia os dados ao trocar de aba: um administrador
    // com as Configurações abertas via os números do momento em que entrou,
    // enquanto alunos concluíam cursos do outro lado. Números velhos numa tela
    // que parece atual é a pior forma de errar — daí os listeners.
    //
    // Ficam ligados apenas enquanto a aba Dashboard está aberta (ver
    // stopLiveSync): cada listener é uma assinatura permanente no RTDB e
    // manter todas ligadas o tempo todo custaria banda e quota à toa.
    let liveRefs = [];
    let liveRenderTimer = null;

    // As atualizações chegam em rajada (uma escrita de resultado dispara
    // vários caminhos). Redesenhar a cada evento piscaria os gráficos várias
    // vezes seguidas, então as mudanças são agrupadas numa janela curta.
    function scheduleLiveRender() {
        clearTimeout(liveRenderTimer);
        liveRenderTimer = setTimeout(() => {
            liveRenderTimer = null;
            try { renderEverything(); }
            catch (error) { console.error('Erro ao atualizar o dashboard ao vivo:', error); }
        }, 300);
    }

    // Resultados vivem fora do estado local do dashboard (as linhas vêm do
    // Histórico, que tem o próprio cache). Ao ver mudança em /results, o cache
    // do Histórico é invalidado e refeito antes de redesenhar — caso contrário
    // os cards mostrariam a conclusão nova com as notas antigas.
    let historyReloadPending = false;
    async function reloadHistoryThenRender() {
        if (historyReloadPending) return;
        historyReloadPending = true;
        try {
            historyRows = await U.refreshHistoryRows();
            scheduleLiveRender();
        } catch (error) {
            console.error('Erro ao recarregar o histórico ao vivo:', error);
        } finally {
            historyReloadPending = false;
        }
    }

    function watch(path, handler) {
        const reference = ref(db, path);
        const callback = reference.on('value', handler, error => {
            console.error(`Listener de ${path} interrompido:`, error.message);
        });
        liveRefs.push({ reference, callback });
    }

    function startLiveSync() {
        if (liveRefs.length) return;
        // O primeiro disparo de cada listener chega logo após o attach e traz
        // o mesmo dado que loadBaseData() acabou de ler; o render agrupado
        // absorve essa repetição sem custo visível.
        watch(`/${dbRoot}/progress/byUser`, snapshot => {
            allProgress = snapshot.exists() ? snapshot.val() : {};
            scheduleLiveRender();
        });
        watch(`/${dbRoot}/colaboradores`, snapshot => {
            allColaboradores = snapshot.exists() ? snapshot.val() : {};
            refreshUserFilterChips();
            scheduleLiveRender();
        });
        watch(`/${dbRoot}/users`, snapshot => {
            allUsers = snapshot.exists() ? snapshot.val() : {};
            scheduleLiveRender();
        });
        // Só a raiz de /results — assinar cada categoria separadamente daria os
        // mesmos eventos com mais assinaturas para administrar.
        watch(`/${dbRoot}/results`, () => { reloadHistoryThenRender(); });
        Object.keys(CATEGORY_LABELS).forEach(slug => {
            watch(`/${dbRoot}/${slug}/trainingData`, snapshot => {
                allTrainingData[slug] = snapshot.exists() ? snapshot.val() : {};
                scheduleLiveRender();
            });
            watch(`/${dbRoot}/${slug}/quizData`, snapshot => {
                allQuizData[slug] = snapshot.exists() ? snapshot.val() : {};
                scheduleLiveRender();
            });
        });
    }

    function stopLiveSync() {
        liveRefs.forEach(({ reference, callback }) => reference.off('value', callback));
        liveRefs = [];
        clearTimeout(liveRenderTimer);
        liveRenderTimer = null;
    }
    U.stopDashboardLiveSync = stopLiveSync;

    async function initDashboard() {
        if (!initialized) {
            initialized = true;
            setDashMode('course');
        }
        try {
            await loadBaseData();
            // Os cards leem allTrainingData/allQuizData, só disponíveis depois
            // de loadBaseData() — renderizar antes deixava a lista vazia no
            // primeiro carregamento (nada para escolher, dashboard em branco).
            renderEverything();
            startLiveSync();
        } catch (error) {
            showWarning('Erro ao carregar dados do dashboard: ' + error.message);
        }
    }
    U.initDashboard = initDashboard;

    // Volta da rede: o que estava na tela é anterior à queda, e os listeners
    // ficaram sem receber eventos. Recarrega do zero em vez de confiar no que
    // sobrou em memória.
    document.addEventListener('uniadmin:connection-restored', () => {
        if (!liveRefs.length) return;
        loadBaseData()
            .then(renderEverything)
            .catch(error => console.error('Erro ao ressincronizar o dashboard:', error));
    });
})();
