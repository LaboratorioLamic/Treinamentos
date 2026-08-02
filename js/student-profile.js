// Painel de perfil do aluno: cursos concluídos, notas e histórico de
// tentativas — visão do próprio usuário. Usa a mesma fonte agregada do
// painel admin (U.getHistoryRows, de js/admin-history.js — carregado antes
// deste script na mesma página) em vez de ler só results/byUser/{userId}:
// isso garante que registros associados por NOME (planilha importada,
// estágio sem conta) também apareçam aqui, igual aparecem em Configurações
// > Usuários > histórico do aluno.
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, db = U.db, dbRoot = U.dbRoot;
    const normalizeName = U.normalizeName;

    const modal = document.getElementById('student-profile-modal');
    if (!modal) return; // portal.html sem o modal (ainda não integrado)

    const closeBtn = document.getElementById('student-profile-close');
    const nameEl = document.getElementById('student-profile-name');
    const approvedCountEl = document.getElementById('student-profile-approved-count');
    const avgScoreEl = document.getElementById('student-profile-avg-score');
    const listEl = document.getElementById('student-profile-list');
    const logoutBtn = document.getElementById('student-profile-logout');
    const infoNameEl = document.getElementById('student-profile-info-name');
    const infoCreatedEl = document.getElementById('student-profile-info-created');
    const infoUnitEl = document.getElementById('student-profile-info-unit');
    const infoRoleEl = document.getElementById('student-profile-info-role');

    const CATEGORY_LABELS = {
        treinamentos: 'Treinamentos',
        educacao_continuada: 'Educação Continuada',
        estagios: 'Estágios'
    };

    function closeModal() {
        modal.classList.remove('active');
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    function starsHtml(rating) {
        if (!rating) return '<span class="student-course-no-rating">Sem avaliação</span>';
        let html = '<span class="star-rating">';
        for (let i = 1; i <= 5; i++) html += `<i class="fas fa-star ${i <= rating ? 'is-on' : 'is-off'}"></i>`;
        return html + '</span>';
    }

    function courseInitials(name) {
        const clean = (name || '').trim();
        if (!clean) return '?';
        const words = clean.split(/\s+/).filter(w => /[a-zA-ZÀ-ÿ0-9]/.test(w));
        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
        return clean.slice(0, 2).toUpperCase();
    }

    function initialsHue(name) {
        let hash = 0;
        for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return hash;
    }

    // Linhas do histórico associadas à sessão atual: por userId (conta
    // vinculada) OU por nome completo igual (registros avulsos/importados
    // sem conta) — mesma regra usada em Configurações > Usuários.
    function rowsForSession(allHistoryRows, session) {
        const nameKey = normalizeName(session.fullName);
        return allHistoryRows
            .filter(r => r.userId === session.userId || (r.userId == null && normalizeName(r.fullName) === nameKey))
            .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    }

    // Os resultados só guardam subjectId/themeId; nome, imagem e descrição
    // do curso vivem em trainingData de cada categoria. Busca as 3
    // categorias para montar um mapa de exibição usado nos cards.
    async function fetchCourseNames() {
        const slugs = Object.keys(CATEGORY_LABELS);
        const snapshots = await Promise.all(
            slugs.map(slug => get(ref(db, `/${dbRoot}/${slug}/trainingData`)))
        );
        const names = {}; // names[slug][subjectId][themeId] = { name, image, imageVersion, description, moduleCount }
        slugs.forEach((slug, i) => {
            const trainingData = snapshots[i].exists() ? snapshots[i].val() : {};
            names[slug] = {};
            Object.keys(trainingData).forEach(subjectId => {
                const themes = trainingData[subjectId]?.themes || {};
                names[slug][subjectId] = {};
                Object.keys(themes).forEach(themeId => {
                    const theme = themes[themeId] || {};
                    names[slug][subjectId][themeId] = {
                        name: theme.name || `Curso ${themeId}`,
                        image: theme.image || null,
                        imageVersion: theme.imageVersion || 0,
                        description: theme.description || '',
                        moduleCount: (theme.modules || []).length,
                        certificateEnabled: !!theme.certificateEnabled,
                        certificateTitle: theme.certificateTitle || '',
                        certificateHours: theme.certificateHours || null,
                        certificateTopics: theme.certificateTopics || ''
                    };
                });
            });
        });
        return names;
    }

    function courseThumbHtml(course, name, slug, subjectId, themeId) {
        const imageSrc = window.UniAdminImages && course && subjectId && themeId
            ? window.UniAdminImages.resolve(slug, subjectId, themeId, course)
            : (course?.image || null);
        if (imageSrc) return `<img src="${escapeHtml(imageSrc)}" alt="">`;
        const hue = initialsHue(name);
        return `<span class="student-course-initials" style="--initials-hue:${hue};">${escapeHtml(courseInitials(name))}</span>`;
    }

    function formatDate(ts) {
        return ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
    }

    function formatDateTime(ts) {
        return ts ? new Date(ts).toLocaleString('pt-BR') : '—';
    }

    function courseOf(row) {
        return courseImagesCache?.[row.slug]?.[row.subjectId]?.[row.themeId];
    }

    function courseNameOf(row) {
        return row.theme || courseOf(row)?.name || 'Curso';
    }

    // Agrupa as avaliações por curso (categoria+disciplina+tema): o card
    // mostra a tentativa mais recente e o detalhe lista todas.
    function groupRowsByCourse(rows) {
        const groups = new Map();
        rows.forEach(r => {
            const key = `${r.slug}|${r.subjectId ?? normalizeName(r.subject)}|${r.themeId ?? normalizeName(r.theme)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r);
        });
        return [...groups.values()]
            .map(attempts => attempts.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0)))
            .sort((a, b) => (b[0].submittedAt || 0) - (a[0].submittedAt || 0));
    }

    // Estado da aba Histórico: linhas carregadas, cursos e grupos exibidos.
    let courseImagesCache = null;
    let courseGroups = [];
    let visibleCache = [];

    function downloadCertificate(row) {
        U.Certificate.download({
            studentName: row.fullName,
            course: courseOf(row),
            courseName: row.theme,
            submittedAt: row.submittedAt
        });
    }

    function renderRows(rows, courseImages) {
        courseImagesCache = courseImages;

        if (rows.length === 0) {
            courseGroups = [];
            visibleCache = [];
            renderFilterBar(false);
            listEl.innerHTML = '<p class="form-hint">Você ainda não concluiu nenhuma avaliação.</p>';
            approvedCountEl.textContent = '0';
            avgScoreEl.textContent = '—';
            return;
        }

        const approvedCount = rows.filter(r => r.approved).length;
        const avgScore = rows.reduce((sum, r) => sum + (r.score || 0), 0) / rows.length;
        approvedCountEl.textContent = String(approvedCount);
        avgScoreEl.textContent = avgScore.toFixed(1);

        courseGroups = groupRowsByCourse(rows);
        renderGrid();
    }

    // ─── Filtros da aba Histórico ───
    // `themes`: disciplinas (subject) selecionadas — vazio = todas.
    const filterState = { themes: new Set(), onlyCertificate: false };

    function themeKeyOf(row) {
        return `${row.slug}|${normalizeName(row.subject || '')}`;
    }

    function availableThemes() {
        const map = new Map();
        courseGroups.forEach(attempts => {
            const r = attempts[0];
            const key = themeKeyOf(r);
            if (!map.has(key)) {
                map.set(key, { key, label: r.subject || 'Sem disciplina', category: CATEGORY_LABELS[r.slug] || r.slug, count: 0 });
            }
            map.get(key).count++;
        });
        return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
    }

    function groupHasCertificate(attempts) {
        return attempts.some(r => r.approved && U.Certificate?.isEnabled(courseOf(r)));
    }

    function visibleGroups() {
        return courseGroups.filter(attempts => {
            if (filterState.themes.size > 0 && !filterState.themes.has(themeKeyOf(attempts[0]))) return false;
            if (filterState.onlyCertificate && !groupHasCertificate(attempts)) return false;
            return true;
        });
    }

    function filterBarHtml() {
        const themes = availableThemes();
        const selected = filterState.themes.size;
        const certCount = courseGroups.filter(groupHasCertificate).length;
        return `
            <div class="student-filter-bar">
                <div class="student-filter-popover-wrap">
                    <button type="button" class="student-filter-chip ${selected ? 'is-active' : ''}" id="student-filter-theme-btn"
                            aria-haspopup="true" aria-expanded="false">
                        <i class="fas fa-sliders"></i> Tema
                        ${selected ? `<span class="student-filter-count">${selected}</span>` : ''}
                        <i class="fas fa-chevron-down student-filter-caret"></i>
                    </button>
                    <div class="student-filter-popover" id="student-filter-theme-popover" hidden>
                        <div class="student-filter-popover-head">
                            <span>Temas dos cursos</span>
                            <button type="button" class="student-filter-clear" id="student-filter-theme-clear">Limpar</button>
                        </div>
                        <div class="student-filter-options">
                            ${themes.length === 0 ? '<p class="student-filter-empty">Nenhum tema disponível.</p>' : themes.map(t => {
                                const on = filterState.themes.has(t.key);
                                return `
                                <button type="button" class="student-filter-option ${on ? 'is-selected' : ''}"
                                        data-theme-key="${escapeHtml(t.key)}" aria-pressed="${on}">
                                    <span class="student-filter-option-mark"><i class="fas fa-check"></i></span>
                                    <span class="student-filter-option-text">
                                        <strong>${escapeHtml(t.label)}</strong>
                                        <small>${escapeHtml(t.category)}</small>
                                    </span>
                                    <span class="student-filter-option-count">${t.count}</span>
                                </button>`;
                            }).join('')}
                        </div>
                    </div>
                </div>

                <button type="button" class="student-filter-chip ${filterState.onlyCertificate ? 'is-active' : ''}" id="student-filter-cert-btn"
                        aria-pressed="${filterState.onlyCertificate}" title="Mostrar apenas cursos com certificado disponível">
                    <i class="fas fa-award"></i> Com certificado
                    <span class="student-filter-count">${certCount}</span>
                </button>
            </div>`;
    }

    // A barra de filtros fica FORA de #student-profile-list: a lista tem
    // overflow-y auto e recortaria o popover.
    function filterHost() {
        const panel = document.getElementById('student-profile-history-panel');
        if (!panel) return null;
        let host = panel.querySelector('#student-filter-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'student-filter-host';
            panel.insertBefore(host, listEl);
        }
        return host;
    }

    function renderFilterBar(visible) {
        const host = filterHost();
        if (!host) return;
        host.hidden = !visible;
        host.innerHTML = visible ? filterBarHtml() : '';
        if (visible) bindFilterBar();
    }

    function bindFilterBar() {
        const host = filterHost();
        const themeBtn = host.querySelector('#student-filter-theme-btn');
        const popover = host.querySelector('#student-filter-theme-popover');

        function closePopover() {
            if (!popover || popover.hidden) return;
            popover.hidden = true;
            themeBtn?.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onOutsideClick, true);
        }
        function onOutsideClick(event) {
            if (!popover.contains(event.target) && event.target !== themeBtn && !themeBtn.contains(event.target)) closePopover();
        }

        themeBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            const willOpen = popover.hidden;
            popover.hidden = !willOpen;
            themeBtn.setAttribute('aria-expanded', String(willOpen));
            if (willOpen) document.addEventListener('click', onOutsideClick, true);
            else document.removeEventListener('click', onOutsideClick, true);
        });

        // Marcar/desmarcar mantém o popover aberto: a grade atualiza atrás dele.
        popover?.querySelectorAll('.student-filter-option[data-theme-key]').forEach(option => {
            option.addEventListener('click', (event) => {
                event.stopPropagation();
                const key = option.dataset.themeKey;
                if (filterState.themes.has(key)) filterState.themes.delete(key);
                else filterState.themes.add(key);
                renderGrid({ keepPopoverOpen: true });
            });
        });

        host.querySelector('#student-filter-theme-clear')?.addEventListener('click', () => {
            filterState.themes.clear();
            renderGrid({ keepPopoverOpen: true });
        });

        host.querySelector('#student-filter-cert-btn')?.addEventListener('click', () => {
            filterState.onlyCertificate = !filterState.onlyCertificate;
            renderGrid();
        });
    }

    function renderGrid(options = {}) {
        listEl.classList.remove('is-detail');
        renderFilterBar(true);
        const groups = visibleGroups();

        if (groups.length === 0) {
            visibleCache = [];
            listEl.innerHTML = '<p class="form-hint">Nenhum curso corresponde aos filtros selecionados.</p>';
            if (options.keepPopoverOpen === true) reopenThemePopover();
            return;
        }

        listEl.innerHTML = `<div class="student-course-grid">${groups.map((attempts, i) => {
            const r = attempts[0];
            const course = courseOf(r);
            const courseName = courseNameOf(r);
            const categoryLabel = CATEGORY_LABELS[r.slug] || r.slug;
            const isLate = r.deadlineStatus === 'late' || r.deadlineStatus === 'closed';
            return `
                <button type="button" class="student-course-card" data-group-index="${i}" style="--card-i:${i};"
                        title="Ver histórico de ${escapeHtml(courseName)}">
                    <div class="student-course-thumb">
                        ${courseThumbHtml(course, courseName, r.slug, r.subjectId, r.themeId)}
                        ${r.approved ? '<span class="student-course-badge"><i class="fas fa-circle-check"></i></span>' : ''}
                        <span class="student-course-hover"><i class="fas fa-clock-rotate-left"></i> Ver histórico</span>
                    </div>
                    <div class="student-course-body">
                        <h4 title="${escapeHtml(courseName)}">${escapeHtml(courseName)}</h4>
                        <p class="student-course-category">${escapeHtml(categoryLabel)} &bull; ${formatDate(r.submittedAt)}</p>
                        <div class="student-course-stats">
                            ${starsHtml(r.rating)}
                            <span class="student-course-score ${r.approved ? 'is-approved' : 'is-reproved'}">${r.score}/10</span>
                        </div>
                        <div class="student-course-foot">
                            <span class="student-profile-item-score ${r.approved ? 'is-approved' : 'is-reproved'}" style="padding:3px 9px;font-size:0.78em;">${r.approved ? 'Aprovado' : 'Reprovado'}</span>
                            <span class="student-course-attempt">${attempts.length > 1
                                ? `${attempts.length} tentativas`
                                : `tentativa ${r.attempt || 1}`}</span>
                        </div>
                        ${isLate ? `<div class="student-course-late"><i class="fas fa-triangle-exclamation"></i> ${U.Deadlines?.STATUS_LABELS?.[r.deadlineStatus] || 'Fora do prazo'}</div>` : ''}
                        ${(r.approved && U.Certificate?.isEnabled(course)) ? `
                            <span class="student-cert-btn" role="button" tabindex="0" data-cert-index="${i}">
                                <i class="fas fa-award"></i> Baixar certificado
                            </span>` : ''}
                    </div>
                </button>`;
        }).join('')}</div>`;

        // Os índices dos cards apontam para a lista filtrada, não para
        // courseGroups — guardada aqui para os handlers e para o detalhe.
        visibleCache = groups;

        if (options.keepPopoverOpen === true) reopenThemePopover();

        listEl.querySelectorAll('.student-course-card').forEach(card => {
            card.addEventListener('click', () => openCourseDetail(Number(card.dataset.groupIndex)));
        });

        // O certificado vive dentro do card (que é um botão): o clique nele
        // não deve também abrir o detalhe do curso.
        listEl.querySelectorAll('.student-cert-btn').forEach(el => {
            el.addEventListener('click', (event) => {
                event.stopPropagation();
                downloadCertificate(visibleCache[Number(el.dataset.certIndex)][0]);
            });
            el.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                downloadCertificate(visibleCache[Number(el.dataset.certIndex)][0]);
            });
        });
    }

    // Reabre o popover de temas depois de um re-render disparado por ele
    // mesmo, para não fechar a lista a cada marcação.
    function reopenThemePopover() {
        filterHost()?.querySelector('#student-filter-theme-btn')?.click();
    }

    // ─── Detalhe do curso (dentro da própria aba Histórico) ───
    function openCourseDetail(groupIndex, attemptIndex = 0) {
        const attempts = visibleCache[groupIndex];
        if (!attempts) return;
        const row = attempts[attemptIndex] || attempts[0];
        const course = courseOf(row);
        const courseName = courseNameOf(row);
        const categoryLabel = CATEGORY_LABELS[row.slug] || row.slug;
        const showDeadline = row.deadlineStatus
            && !['livre', 'on_time', 'not_started'].includes(row.deadlineStatus);

        listEl.classList.add('is-detail');
        renderFilterBar(false);
        listEl.innerHTML = `
            <div class="student-course-detail">
                <button type="button" class="student-detail-back">
                    <i class="fas fa-arrow-left"></i> Voltar aos cursos
                </button>

                <div class="student-detail-hero">
                    <div class="student-detail-thumb">
                        ${courseThumbHtml(course, courseName, row.slug, row.subjectId, row.themeId)}
                    </div>
                    <div class="student-detail-heading">
                        <h4>${escapeHtml(courseName)}</h4>
                        <p>${escapeHtml(categoryLabel)}${row.subject ? ` &bull; ${escapeHtml(row.subject)}` : ''}</p>
                        ${course?.moduleCount ? `<p class="student-detail-modules"><i class="fas fa-layer-group"></i> ${course.moduleCount} módulo(s)</p>` : ''}
                    </div>
                </div>

                ${course?.description ? `<p class="student-detail-desc">${escapeHtml(course.description)}</p>` : ''}

                ${attempts.length > 1 ? `
                    <div class="student-detail-attempts">
                        ${attempts.map((a, i) => `
                            <button type="button" class="student-attempt-pill ${i === attemptIndex ? 'is-active' : ''}" data-attempt="${i}">
                                ${formatDate(a.submittedAt)} &bull; ${a.score}/10
                            </button>`).join('')}
                    </div>` : ''}

                <div class="student-detail-stats">
                    <div class="student-detail-stat"><span class="label">Nota</span><span class="value ${row.approved ? 'is-approved' : 'is-reproved'}">${row.score}/10</span></div>
                    <div class="student-detail-stat"><span class="label">Situação</span><span class="value ${row.approved ? 'is-approved' : 'is-reproved'}">${row.approved ? 'Aprovado' : 'Reprovado'}</span></div>
                    <div class="student-detail-stat"><span class="label">Tentativa</span><span class="value">${row.attempt || 1}</span></div>
                    <div class="student-detail-stat"><span class="label">Data</span><span class="value">${formatDateTime(row.submittedAt)}</span></div>
                    ${showDeadline ? `<div class="student-detail-stat"><span class="label">Prazo</span><span class="value">${escapeHtml(U.Deadlines?.STATUS_LABELS?.[row.deadlineStatus] || row.deadlineStatus)}</span></div>` : ''}
                </div>

                ${(row.rating || row.comment) ? `
                    <div class="student-detail-block">
                        <span class="student-detail-block-title">Sua avaliação</span>
                        ${row.rating ? `<div class="student-detail-rating">${starsHtml(row.rating)}</div>` : ''}
                        <p class="student-detail-comment">${row.comment ? escapeHtml(row.comment) : 'Sem comentário.'}</p>
                    </div>` : ''}

                ${(row.approved && U.Certificate?.isEnabled(course)) ? `
                    <button type="button" class="student-cert-btn student-detail-cert">
                        <i class="fas fa-award"></i> Baixar certificado
                    </button>` : ''}
            </div>`;

        listEl.querySelector('.student-detail-back')?.addEventListener('click', renderGrid);
        listEl.querySelectorAll('.student-attempt-pill').forEach(pill => {
            pill.addEventListener('click', () => openCourseDetail(groupIndex, Number(pill.dataset.attempt)));
        });
        listEl.querySelector('.student-detail-cert')?.addEventListener('click', () => downloadCertificate(row));
        listEl.scrollTop = 0;
    }

    // Dados principais da conta. Setor/função são mantidos em dia pelo sync
    // de Colaboradores (js/colaboradores-sync.js espelha planilha →
    // colaborador → conta vinculada); aqui basta rodar o sync silencioso
    // antes de ler a conta.
    async function loadUserInfo(session) {
        infoNameEl.textContent = session.fullName || '—';
        infoCreatedEl.textContent = '—';
        infoUnitEl.textContent = '—';
        infoRoleEl.textContent = '—';

        try {
            // Silencioso: planilha fora do ar não impede de mostrar o que já
            // está gravado na conta.
            await U.ColaboradoresSync?.syncFromSheets({ silent: true });
            const userSnap = await get(ref(db, `/${dbRoot}/users/${session.userId}`));
            const user = userSnap.exists() ? userSnap.val() : null;
            if (!user) return;

            infoNameEl.textContent = user.fullName || session.fullName || '—';
            infoCreatedEl.textContent = formatDate(user.createdAt);
            infoUnitEl.textContent = user.unit || 'Não informado';
            infoRoleEl.textContent = user.role || 'Não informado';
        } catch (error) {
            console.error('Erro ao carregar dados do usuário:', error);
        }
    }

    async function loadProfile() {
        const session = U.StudentAuth.getSession();
        if (!session) { closeModal(); return; }

        nameEl.textContent = session.fullName;
        loadUserInfo(session);
        renderFilterBar(false);
        listEl.classList.remove('is-detail');
        listEl.innerHTML = '<p class="form-hint">Carregando histórico...</p>';

        try {
            const [allHistoryRows, courseImages] = await Promise.all([
                U.getHistoryRows(),
                fetchCourseNames()
            ]);
            const rows = rowsForSession(allHistoryRows, session);
            renderRows(rows, courseImages);
        } catch (error) {
            listEl.innerHTML = '<p class="form-hint">Não foi possível carregar seu histórico agora.</p>';
        }
    }

    // ─── Alterar senha ───
    const passwordToggle = document.getElementById('student-profile-password-toggle');
    const passwordPanel = document.getElementById('student-profile-password-panel');
    const passwordError = document.getElementById('student-profile-password-error');
    const currentPasswordInput = document.getElementById('student-profile-current-password');
    const newPasswordInput = document.getElementById('student-profile-new-password');
    const confirmPasswordInput = document.getElementById('student-profile-confirm-password');
    const passwordSubmitBtn = document.getElementById('student-profile-password-submit');

    function resetPasswordPanel() {
        if (passwordPanel) passwordPanel.style.display = 'none';
        if (passwordError) { passwordError.textContent = ''; passwordError.classList.remove('active'); }
        if (currentPasswordInput) currentPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (confirmPasswordInput) confirmPasswordInput.value = '';
    }

    passwordToggle?.addEventListener('click', () => {
        const isOpen = passwordPanel.style.display !== 'none';
        if (isOpen) { resetPasswordPanel(); return; }
        passwordPanel.style.display = 'block';
    });

    passwordSubmitBtn?.addEventListener('click', async () => {
        passwordError.textContent = '';
        passwordError.classList.remove('active');
        passwordSubmitBtn.disabled = true;
        try {
            await U.StudentAuth.changePassword({
                currentPassword: currentPasswordInput.value,
                newPassword: newPasswordInput.value,
                confirmation: confirmPasswordInput.value
            });
            resetPasswordPanel();
            U.showWarning?.('Senha alterada com sucesso.');
        } catch (error) {
            passwordError.textContent = error.message;
            passwordError.classList.add('active');
        } finally {
            passwordSubmitBtn.disabled = false;
        }
    });

    // ─── Abas: Visão geral / Histórico ───
    const tabOverviewBtn = document.getElementById('student-profile-tab-overview');
    const tabHistoryBtn = document.getElementById('student-profile-tab-history');
    const overviewPanel = document.getElementById('student-profile-overview-panel');
    const historyPanel = document.getElementById('student-profile-history-panel');

    function setProfileTab(tab) {
        tabOverviewBtn?.classList.toggle('active', tab === 'overview');
        tabHistoryBtn?.classList.toggle('active', tab === 'history');
        if (overviewPanel) overviewPanel.style.display = tab === 'overview' ? 'block' : 'none';
        if (historyPanel) historyPanel.style.display = tab === 'history' ? 'block' : 'none';
    }
    tabOverviewBtn?.addEventListener('click', () => setProfileTab('overview'));
    tabHistoryBtn?.addEventListener('click', () => setProfileTab('history'));

    function openModal() {
        modal.classList.add('active');
        resetPasswordPanel();
        setProfileTab('overview');
        loadProfile();
    }
    U.StudentProfile = { openModal };

    closeBtn?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('active')) closeModal();
    });

    logoutBtn?.addEventListener('click', async () => {
        const session = U.StudentAuth.getSession();
        const confirmed = await U.showConfirm({
            title: 'Sair da conta',
            message: session ? `Você está logado como ${session.fullName}.` : '',
            icon: 'fa-right-from-bracket',
            tone: 'neutral',
            confirmText: 'Sair'
        });
        if (confirmed) {
            U.StudentAuth.logout();
            U.refreshStudentHeader?.();
            closeModal();
        }
    });
})();
