// Aba "Cursos" — camada de apresentação que unifica as antigas abas
// Temas / Assuntos / Módulos / Avaliações em uma única tela.
//
// IMPORTANTE — nomenclatura invertida herdada de js/admin.js:
//   subject  (subjectId)  = rótulo visível "Tema"     (nível 1, só nome)
//   theme    (themeId)    = rótulo visível "Assunto"  (nível 2 — é o "curso":
//                            nome, descrição, imagem, prazo, roles, certificado)
//   module                = "Módulo"   (aula: vídeo/pdf/anexos)
//   quiz                  = "Avaliação" (array de questões)
// Hierarquia: Tema → Assunto/curso → Módulos[] + Avaliação.
//
// Este arquivo NÃO duplica lógica de dados/Firebase: toda leitura vem de
// window.UniAdminCoursesData.getData() (a mesma variável `data` de admin.js)
// e toda escrita é feita clicando/disparando os mesmos botões e inputs que
// o formulário legado já usa (eles só mudaram de lugar no HTML, de painel
// inline para dentro de modais — os IDs são idênticos).
(function () {

function C() { return window.UniAdminCoursesData; }

// ─── Modal Stack: empilhamento de modais com fechar-só-o-topo ───
const ModalStack = (() => {
    const stack = []; // [{ el, onClose }]
    const BASE_Z = 2000, STEP = 25;

    function applyDimming() {
        stack.forEach((entry, i) => {
            entry.el.classList.toggle('cfg-mstack-dimmed', i < stack.length - 1);
        });
    }

    function open(el, { onClose } = {}) {
        if (!el) return;
        if (stack.some(e => e.el === el)) return; // já aberto, evita duplicar no stack
        stack.push({ el, onClose });
        el.style.zIndex = String(BASE_Z + stack.length * STEP);
        el.style.display = 'flex';
        document.body.classList.add('cfg-mstack-open');
        applyDimming();
    }

    function closeTop() {
        const top = stack.pop();
        if (!top) return;
        top.el.style.display = 'none';
        top.el.classList.remove('cfg-mstack-dimmed');
        try { top.onClose?.(); } catch (e) { console.error(e); }
        if (stack.length === 0) document.body.classList.remove('cfg-mstack-open');
        applyDimming();
    }

    function closeAll() { while (stack.length) closeTop(); }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && stack.length) closeTop();
    });

    return { open, closeTop, closeAll, get depth() { return stack.length; } };
})();

// ─── Utilidades compartilhadas (lêem de admin.js via bridge) ───
function escapeHtml(value) {
    return window.UniAdminCoursesData?.escapeHtml
        ? C().escapeHtml(value)
        : String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function themeInitials(name) {
    if (C()?.themeInitials) return C().themeInitials(name);
    const clean = (name || '').trim();
    return clean ? clean.slice(0, 2).toUpperCase() : '?';
}

function validKeys(collection) {
    if (!collection || typeof collection !== 'object') return [];
    return Object.keys(collection).filter(key => collection[key] && typeof collection[key] === 'object');
}

// ─── Estado local da UI (não é dado de negócio, não vai pro Firebase) ───
let selectedSubjectFilter = null; // null = todos os temas; senão, 1 subjectId
let selectedStatusFilter = 'active'; // 'active' | 'inactive' | 'all' — padrão: só ativos
let currentDetailSubjectId = null;
let currentDetailThemeId = null;

// ══════════════════════════════════════════════════════════════════
// Popover de filtro por Tema
// ══════════════════════════════════════════════════════════════════
const filterBtn = document.getElementById('cfg-courses-filter-btn');
const filterPopover = document.getElementById('cfg-courses-filter-popover');
const filterListEl = document.getElementById('cfg-courses-filter-list');
const filterSearchInput = document.getElementById('cfg-courses-filter-search');
const filterClearBtn = document.getElementById('cfg-courses-filter-clear');
const filterSummaryEl = document.getElementById('cfg-courses-filter-summary');

function refreshFilterSummary() {
    filterSummaryEl.textContent = selectedSubjectFilter
        ? (C().getData().trainingData[selectedSubjectFilter]?.name || 'Tema selecionado')
        : 'Todos os temas';
    filterBtn.classList.toggle('is-on', !!selectedSubjectFilter);
}

function renderFilterList() {
    if (!filterListEl) return;
    const term = (filterSearchInput?.value || '').trim().toLowerCase();
    const data = C().getData();
    const subjectIds = (data.order?.subjects?.length ? data.order.subjects : validKeys(data.trainingData))
        .filter(id => data.trainingData[id]);
    const visible = subjectIds.filter(id => !term || data.trainingData[id].name.toLowerCase().includes(term));
    if (visible.length === 0) {
        filterListEl.innerHTML = subjectIds.length === 0
            ? '<p class="filter-popover-empty">Nenhum tema cadastrado ainda.</p>'
            : '<p class="filter-popover-empty">Nada encontrado.</p>';
        refreshFilterSummary();
        positionFilterPopover();
        return;
    }
    const allOn = !selectedSubjectFilter;
    const allOptionHtml = `
        <button type="button" class="filter-popover-option ${allOn ? 'is-selected' : ''}" data-subject-id="" role="radio" aria-checked="${allOn}">
            <span class="filter-popover-option-mark"><i class="fas fa-layer-group"></i></span>
            <span class="filter-popover-option-label">Todos os temas</span>
        </button>`;
    filterListEl.innerHTML = allOptionHtml + visible.map(id => {
        const on = selectedSubjectFilter === id;
        return `
        <button type="button" class="filter-popover-option ${on ? 'is-selected' : ''}" data-subject-id="${id}" role="radio" aria-checked="${on}">
            <span class="filter-popover-option-mark"><i class="fas fa-bookmark"></i></span>
            <span class="filter-popover-option-label">${escapeHtml(data.trainingData[id].name)}</span>
        </button>`;
    }).join('');
    filterListEl.querySelectorAll('.filter-popover-option').forEach(option => {
        option.addEventListener('click', () => {
            selectedSubjectFilter = option.dataset.subjectId || null;
            renderFilterList();
            renderCoursesGrid();
            closeFilterPopover();
        });
    });
    refreshFilterSummary();
    positionFilterPopover();
}

function positionFilterPopover() {
    if (!filterPopover || filterPopover.hidden) return;
    const rect = filterBtn.getBoundingClientRect();
    const gap = 6, margin = 10;
    filterPopover.style.width = `${Math.max(rect.width, 260)}px`;
    filterPopover.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 260) - margin))}px`;
    filterPopover.style.top = '0px';
    const height = filterPopover.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const openUp = spaceBelow < height && rect.top - gap - margin > spaceBelow;
    const available = Math.max(180, openUp ? rect.top - gap - margin : spaceBelow);
    const chrome = height - filterListEl.offsetHeight;
    filterListEl.style.maxHeight = `${Math.max(120, available - chrome)}px`;
    const finalHeight = Math.min(filterPopover.offsetHeight, available);
    filterPopover.style.top = openUp ? `${rect.top - gap - finalHeight}px` : `${rect.bottom + gap}px`;
}

function closeFilterPopover() {
    if (!filterPopover || filterPopover.hidden) return;
    filterPopover.hidden = true;
    filterBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onFilterOutsideClick, true);
    window.removeEventListener('resize', positionFilterPopover);
    window.removeEventListener('scroll', positionFilterPopover, true);
}
function onFilterOutsideClick(event) {
    if (!filterPopover.contains(event.target) && !filterBtn.contains(event.target)) closeFilterPopover();
}

filterBtn?.addEventListener('click', () => {
    const willOpen = filterPopover.hidden;
    if (!willOpen) { closeFilterPopover(); return; }
    const cfgRoot = document.getElementById('cfg-root') || document.body;
    if (filterPopover.parentElement !== cfgRoot) cfgRoot.appendChild(filterPopover);
    filterPopover.hidden = false;
    filterBtn.setAttribute('aria-expanded', 'true');
    filterSearchInput.value = '';
    renderFilterList();
    positionFilterPopover();
    document.addEventListener('click', onFilterOutsideClick, true);
    window.addEventListener('resize', positionFilterPopover);
    window.addEventListener('scroll', positionFilterPopover, true);
    setTimeout(() => filterSearchInput.focus(), 40);
});
filterSearchInput?.addEventListener('input', renderFilterList);
filterClearBtn?.addEventListener('click', () => {
    selectedSubjectFilter = null;
    renderFilterList();
    renderCoursesGrid();
});

// ══════════════════════════════════════════════════════════════════
// Modal "Gerenciar Temas"
// ══════════════════════════════════════════════════════════════════
const subjectManageModal = document.getElementById('cfg-subject-manage-modal');

function openSubjectManageModal() {
    ModalStack.open(subjectManageModal, {
        onClose: () => {
            document.getElementById('cfg-subject-delete').style.display = 'none';
            document.getElementById('cfg-subject-name').value = '';
        }
    });
    renderFilterList(); // temas podem ter mudado — mantém popover em dia
}
document.getElementById('cfg-courses-manage-themes-btn')?.addEventListener('click', openSubjectManageModal);
document.getElementById('cfg-subject-manage-close')?.addEventListener('click', () => ModalStack.closeTop());
subjectManageModal?.addEventListener('click', (event) => { if (event.target === subjectManageModal) ModalStack.closeTop(); });

document.getElementById('cfg-courses-status-segment')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.status-segment-btn[data-status]');
    if (!btn) return;
    selectedStatusFilter = btn.dataset.status;
    document.querySelectorAll('#cfg-courses-status-segment .status-segment-btn').forEach(b => {
        b.classList.toggle('is-active', b === btn);
    });
    renderCoursesGrid();
});

// ══════════════════════════════════════════════════════════════════
// Modal de formulário de Assunto (curso)
// ══════════════════════════════════════════════════════════════════
const themeFormModal = document.getElementById('cfg-theme-form-modal');
const themeFormTitle = document.getElementById('cfg-theme-form-title');

function openThemeFormModal({ subjectId, themeId } = {}) {
    const subjectSelect = document.getElementById('cfg-theme-subject');
    if (subjectId) {
        subjectSelect.value = subjectId;
        subjectSelect.dispatchEvent(new Event('change'));
    }
    if (themeId) {
        // populateThemes() (chamada pelo 'change' acima) já re-renderiza os
        // cards legados escondidos; simulamos o clique "Editar" existente.
        const editBtn = document.querySelector(`#cfg-themes-container .edit-theme[data-id="${themeId}"]`);
        editBtn?.click();
        themeFormTitle.innerHTML = '<i class="fas fa-layer-group"></i> Editar Curso';
    } else {
        C().resetThemeForm?.();
        themeFormTitle.innerHTML = '<i class="fas fa-layer-group"></i> Novo Curso';
    }
    ModalStack.open(themeFormModal, {
        onClose: () => { C().resetThemeForm?.(); renderCoursesGrid(); }
    });
}
document.getElementById('cfg-theme-form-close')?.addEventListener('click', () => ModalStack.closeTop());
themeFormModal?.addEventListener('click', (event) => { if (event.target === themeFormModal) ModalStack.closeTop(); });

document.getElementById('cfg-courses-add-btn')?.addEventListener('click', () => {
    const data = C().getData();
    const subjectIds = validKeys(data.trainingData);
    if (subjectIds.length === 0) {
        window.UniAdmin?.showWarning?.('Cadastre um tema antes de adicionar um curso.');
        openSubjectManageModal();
        return;
    }
    // Se houver um tema selecionado no filtro, já pré-seleciona.
    openThemeFormModal({ subjectId: selectedSubjectFilter || '' });
});

// ══════════════════════════════════════════════════════════════════
// Modal de detalhe do curso (drawer): hero + abas Módulos/Avaliação
// ══════════════════════════════════════════════════════════════════
const detailModal = document.getElementById('cfg-course-detail-modal');
const detailThumb = document.getElementById('cfg-course-detail-thumb');
const detailTitle = document.getElementById('cfg-course-detail-title');
const detailTags = document.getElementById('cfg-course-detail-tags');

function refreshDetailTabCounts() {
    if (!currentDetailSubjectId || !currentDetailThemeId) return;
    const data = C().getData();
    const theme = data.trainingData[currentDetailSubjectId]?.themes?.[currentDetailThemeId];
    if (!theme) return;
    const modules = theme.modules || [];
    const quizKey = `${currentDetailSubjectId}_${currentDetailThemeId}`;
    const quizCount = data.quizData?.[quizKey]?.length || 0;
    const modCountEl = document.getElementById('cfg-course-detail-tabcount-modules');
    const quizCountEl = document.getElementById('cfg-course-detail-tabcount-quiz');
    if (modCountEl) modCountEl.textContent = String(modules.length);
    if (quizCountEl) quizCountEl.textContent = String(quizCount);
    renderCourseInfo(currentDetailSubjectId, currentDetailThemeId, theme);
}

// Aba "Informações": mostra tudo que foi cadastrado no formulário de Assunto
// (descrição, status, prazo, funções, certificado) em formato de leitura.
function renderCourseInfo(subjectId, themeId, theme) {
    const infoEl = document.getElementById('cfg-course-detail-info');
    if (!infoEl) return;
    const data = C().getData();
    const subjectName = data.trainingData[subjectId]?.name || '—';

    // Prazo
    const deadlineStatus = window.UniAdmin?.Deadlines?.computeDeadlineStatus?.(theme.deadline) || 'livre';
    const deadlineLabel = window.UniAdmin?.Deadlines?.STATUS_LABELS?.[deadlineStatus] || 'Sem prazo';
    const fmtDate = window.UniAdmin?.Deadlines?.formatDeadlineDate;
    const deadlineRows = theme.deadline?.mode === 'prazo' && fmtDate ? `
        <div class="course-info-subrow"><span>Início</span><strong>${fmtDate(theme.deadline.startAt)}</strong></div>
        <div class="course-info-subrow"><span>Prazo final</span><strong>${fmtDate(theme.deadline.endAt)}</strong></div>
        <div class="course-info-subrow"><span>Encerramento</span><strong>${fmtDate(theme.deadline.closeAt)}</strong></div>`
        : '';

    // Funções com acesso
    const roles = Array.isArray(theme.roles) ? theme.roles.filter(Boolean) : [];
    const rolesHtml = roles.length
        ? `<div class="course-info-pills">${roles.map(r => `<span class="course-info-pill">${escapeHtml(r)}</span>`).join('')}</div>`
        : '<p class="course-info-muted">Visível para todas as funções.</p>';

    // Certificado
    const certTopics = theme.certificateEnabled ? (window.UniAdmin?.Certificate?.parseTopics?.(theme.certificateTopics) || []) : [];
    const certHtml = theme.certificateEnabled ? `
        <div class="course-info-subrow"><span>Título</span><strong>${escapeHtml(theme.certificateTitle || subjectName)}</strong></div>
        <div class="course-info-subrow"><span>Carga horária</span><strong>${theme.certificateHours || 10}h</strong></div>
        <div class="course-info-subrow"><span>Tópicos</span><strong>${certTopics.length ? `${certTopics.length} tópico(s)` : 'Nenhum tópico cadastrado'}</strong></div>`
        : '<p class="course-info-muted">Emissão de certificado desativada para este curso.</p>';

    // Módulos e avaliação (resumo — o detalhe fica nas próprias abas)
    const moduleCount = theme.modules?.length || 0;
    const quizKey = `${subjectId}_${themeId}`;
    const quizCount = data.quizData?.[quizKey]?.length || 0;
    const quizEnabled = data.quizStatus?.[quizKey] !== false;

    infoEl.innerHTML = `
        <div class="course-info-card">
            <div class="course-info-card-head"><i class="fas fa-align-left"></i> Descrição</div>
            <p class="course-info-desc">${theme.description ? escapeHtml(theme.description) : '<span class="course-info-muted">Nenhuma descrição cadastrada.</span>'}</p>
        </div>

        <div class="course-info-card">
            <div class="course-info-card-head"><i class="fas fa-toggle-on"></i> Status</div>
            <div class="course-info-row">
                <span class="course-info-status ${theme.active === false ? 'is-inactive' : 'is-active'}">
                    <i class="fas ${theme.active === false ? 'fa-ban' : 'fa-check-circle'}"></i>
                    ${theme.active === false ? 'Inativo' : 'Ativo'}
                </span>
                <span class="deadline-badge deadline-${deadlineStatus}">${deadlineLabel}</span>
            </div>
            ${deadlineRows}
        </div>

        <div class="course-info-card">
            <div class="course-info-card-head"><i class="fas fa-bookmark"></i> Organização</div>
            <div class="course-info-subrow"><span>Tema</span><strong>${escapeHtml(subjectName)}</strong></div>
            <div class="course-info-subrow"><span>Módulos</span><strong>${moduleCount}</strong></div>
            <div class="course-info-subrow"><span>Avaliação</span><strong>${quizCount ? `${quizCount} questão(ões) — ${quizEnabled ? 'habilitada' : 'desabilitada'}` : 'Sem questões cadastradas'}</strong></div>
        </div>

        <div class="course-info-card">
            <div class="course-info-card-head"><i class="fas fa-user-tag"></i> Funções que veem este curso</div>
            ${rolesHtml}
        </div>

        <div class="course-info-card">
            <div class="course-info-card-head"><i class="fas fa-award"></i> Certificado</div>
            ${certHtml}
        </div>`;
}

function openCourseDetail(subjectId, themeId) {
    const data = C().getData();
    const theme = data.trainingData[subjectId]?.themes?.[themeId];
    if (!theme) return;
    currentDetailSubjectId = subjectId;
    currentDetailThemeId = themeId;

    detailTitle.textContent = theme.name;
    detailThumb.innerHTML = theme.image
        ? `<img src="${escapeHtml(theme.image)}" alt="">`
        : escapeHtml(themeInitials(theme.name));
    const subjectName = data.trainingData[subjectId]?.name || '';
    detailTags.innerHTML = `
        <span class="dash-course-subject-tag"><i class="fas fa-bookmark"></i> ${escapeHtml(subjectName)}</span>
        ${theme.active === false ? '<span class="user-status-badge">Inativo</span>' : ''}`;

    renderCourseInfo(subjectId, themeId, theme);

    // Contexto para as funções legadas de populateModules()/populateQuizzes(),
    // que leem dos <select> ocultos cfg-module-subject/theme e cfg-quiz-subject/theme.
    C().setModuleContext(subjectId, themeId);
    C().setQuizContext(subjectId, themeId);
    refreshDetailTabCounts();

    // Sempre abre na aba Informações.
    detailModal.querySelectorAll('.course-drawer-tabs .tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === 0));
    detailModal.querySelectorAll('.course-drawer-body .tab-content').forEach((tab, i) => tab.classList.toggle('active', i === 0));

    ModalStack.open(detailModal, { onClose: () => { currentDetailSubjectId = null; currentDetailThemeId = null; } });
}

detailModal?.querySelectorAll('.course-drawer-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        detailModal.querySelectorAll('.course-drawer-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.courseDetailTab;
        detailModal.querySelectorAll('.course-drawer-body .tab-content').forEach(tab => {
            tab.classList.toggle('active', tab.id === `cfg-course-detail-tab-${target}`);
        });
    });
});
document.getElementById('cfg-course-detail-close')?.addEventListener('click', () => ModalStack.closeTop());
detailModal?.addEventListener('click', (event) => { if (event.target === detailModal) ModalStack.closeTop(); });
document.getElementById('cfg-course-detail-edit')?.addEventListener('click', () => {
    if (currentDetailSubjectId && currentDetailThemeId) {
        openThemeFormModal({ subjectId: currentDetailSubjectId, themeId: currentDetailThemeId });
    }
});

// ══════════════════════════════════════════════════════════════════
// Modal de formulário de Módulo (empilhado sobre o drawer)
// ══════════════════════════════════════════════════════════════════
const moduleFormModal = document.getElementById('cfg-module-form-modal');
const moduleFormTitle = document.getElementById('cfg-module-form-title');

document.getElementById('cfg-course-detail-add-module')?.addEventListener('click', () => {
    C().resetModuleForm();
    moduleFormTitle.innerHTML = '<i class="fas fa-play-circle"></i> Novo Módulo';
    ModalStack.open(moduleFormModal, { onClose: () => { C().resetModuleForm(); refreshDetailTabCounts(); } });
});
document.getElementById('cfg-module-form-close')?.addEventListener('click', () => ModalStack.closeTop());
moduleFormModal?.addEventListener('click', (event) => { if (event.target === moduleFormModal) ModalStack.closeTop(); });

// Delegação: os botões "Editar" dos module-cards (renderizados pela função
// legada populateModules()) continuam existindo; aqui só interceptamos o
// clique para também abrir o modal empilhado por cima do drawer.
document.getElementById('cfg-modules-container')?.addEventListener('click', (event) => {
    if (event.target.closest('.edit-module')) {
        moduleFormTitle.innerHTML = '<i class="fas fa-play-circle"></i> Editar Módulo';
        ModalStack.open(moduleFormModal, { onClose: () => { C().resetModuleForm(); refreshDetailTabCounts(); } });
    }
});
// O handler legado (admin.js) é async: valida, salva, e só então limpa o
// form (título fica vazio de novo). Só fechamos o modal quando o título
// realmente esvaziar — se a validação falhar (showWarning), o form mantém
// o texto digitado e o modal permanece aberto para o usuário corrigir.
function watchAndAutoClose(inputEl, modalEl, resetFn) {
    const titleBefore = inputEl.value.trim();
    if (!titleBefore) return; // nada preenchido, não há o que salvar
    const check = () => {
        if (modalEl.style.display !== 'flex') return; // já foi fechado por outro caminho
        if (inputEl.value.trim() === '') ModalStack.closeTop();
    };
    // Duas tentativas cobrem tanto o caminho rápido (validação síncrona)
    // quanto o caminho com upload de imagem/spinner (levemente mais lento).
    setTimeout(check, 120);
    setTimeout(check, 500);
}
document.getElementById('cfg-module-save')?.addEventListener('click', () => {
    watchAndAutoClose(document.getElementById('cfg-module-title'), moduleFormModal);
});

// ══════════════════════════════════════════════════════════════════
// Modal de formulário de Avaliação (empilhado sobre o drawer)
// ══════════════════════════════════════════════════════════════════
const quizFormModal = document.getElementById('cfg-quiz-form-modal');
const quizFormTitle = document.getElementById('cfg-quiz-form-title');

document.getElementById('cfg-course-detail-add-quiz')?.addEventListener('click', () => {
    C().resetQuizForm();
    quizFormTitle.innerHTML = '<i class="fas fa-clipboard-list"></i> Nova Questão';
    ModalStack.open(quizFormModal, { onClose: () => { C().resetQuizForm(); refreshDetailTabCounts(); } });
});
document.getElementById('cfg-quiz-form-close')?.addEventListener('click', () => ModalStack.closeTop());
quizFormModal?.addEventListener('click', (event) => { if (event.target === quizFormModal) ModalStack.closeTop(); });

document.getElementById('cfg-quizzes-container')?.addEventListener('click', (event) => {
    if (event.target.closest('.edit-quiz')) {
        quizFormTitle.innerHTML = '<i class="fas fa-clipboard-list"></i> Editar Questão';
        ModalStack.open(quizFormModal, { onClose: () => { C().resetQuizForm(); refreshDetailTabCounts(); } });
    }
});
document.getElementById('cfg-quiz-save')?.addEventListener('click', () => {
    watchAndAutoClose(document.getElementById('cfg-quiz-question'), quizFormModal);
});

// ══════════════════════════════════════════════════════════════════
// Grid de cards de Assunto/curso
// ══════════════════════════════════════════════════════════════════
const gridEl = document.getElementById('cfg-courses-grid');

function orderedSubjectIds(data) {
    return (data.order?.subjects?.length ? data.order.subjects : validKeys(data.trainingData))
        .filter(id => data.trainingData[id]);
}

function orderedThemeIds(data, subjectId) {
    const themes = data.trainingData[subjectId]?.themes;
    if (!themes) return [];
    const order = data.order?.themes?.[subjectId];
    return (order?.length ? order : validKeys(themes)).filter(id => themes[id]);
}

function buildCourseCard(subjectId, subjectName, themeId, theme, index, total, canReorder) {
    const card = document.createElement('div');
    card.className = 'admin-course-card' + (theme.active === false ? ' is-inactive' : '');
    const media = theme.image
        ? `<img src="${escapeHtml(theme.image)}" alt="">`
        : `<span class="image-initials">${escapeHtml(themeInitials(theme.name))}</span>`;
    const data = C().getData();
    const deadlineStatus = window.UniAdmin?.Deadlines?.computeDeadlineStatus?.(theme.deadline);
    const deadlineBadge = theme.deadline && deadlineStatus
        ? `<span class="deadline-badge deadline-${deadlineStatus}">${window.UniAdmin.Deadlines.STATUS_LABELS[deadlineStatus]}</span>`
        : '';
    const roles = Array.isArray(theme.roles) ? theme.roles.filter(Boolean) : [];
    const rolesBadge = roles.length
        ? `<span class="roles-badge" title="Visível apenas para: ${escapeHtml(roles.join(', '))}"><i class="fas fa-user-tag"></i> ${roles.length}</span>`
        : '';
    const moduleCount = theme.modules?.length || 0;
    const quizKey = `${subjectId}_${themeId}`;
    const quizCount = data.quizData?.[quizKey]?.length || 0;
    const quizEnabled = data.quizStatus?.[quizKey] !== false;
    const isFirst = index === 0, isLast = index === total - 1;

    card.innerHTML = `
        <div class="admin-course-card-media">
            ${media}
            <span class="admin-course-card-subject-tag"><i class="fas fa-bookmark"></i> ${escapeHtml(subjectName)}</span>
            ${theme.active === false ? '<span class="admin-course-card-status">Inativo</span>' : ''}
        </div>
        <div class="admin-course-card-body">
            <h3>${escapeHtml(theme.name)}</h3>
            <p class="admin-course-card-desc">${escapeHtml(theme.description || 'Sem descrição.')}</p>
            <div class="admin-course-card-badges">
                ${deadlineBadge}${rolesBadge}
                <span class="modules-count"><i class="fas fa-play-circle"></i> ${moduleCount} módulo(s)</span>
                <span class="quiz-status-badge ${quizCount ? (quizEnabled ? 'is-on' : 'is-off') : ''}">
                    <i class="fas fa-clipboard-list"></i> ${quizCount ? (quizEnabled ? 'Avaliação ativa' : 'Avaliação desativada') : 'Sem avaliação'}
                </span>
            </div>
        </div>
        <div class="admin-course-card-footer">
            ${canReorder ? `
            <div class="order-buttons">
                <button type="button" class="order-btn" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                <button type="button" class="order-btn" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
            </div>` : '<div></div>'}
            <div class="card-actions">
                <label class="toggle-switch" title="${theme.active === false ? 'Ativar curso' : 'Desativar curso'}">
                    <input type="checkbox" class="admin-course-card-toggle" ${theme.active === false ? '' : 'checked'}>
                    <span class="toggle-slider"></span>
                </label>
                <button type="button" class="btn btn-ghost btn-sm admin-course-card-edit" title="Editar"><i class="fas fa-pencil-alt"></i></button>
                <button type="button" class="btn btn-danger btn-sm admin-course-card-delete" title="Excluir"><i class="fas fa-trash"></i></button>
            </div>
        </div>`;

    card.querySelector('.order-btn[data-direction="up"]')?.addEventListener('click', (e) => {
        e.stopPropagation(); C().moveTheme(subjectId, themeId, 'up');
    });
    card.querySelector('.order-btn[data-direction="down"]')?.addEventListener('click', (e) => {
        e.stopPropagation(); C().moveTheme(subjectId, themeId, 'down');
    });
    card.querySelector('.admin-course-card-toggle')?.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.admin-course-card-toggle')?.addEventListener('change', (e) => {
        C().toggleThemeActive(subjectId, themeId, e.target.checked);
    });
    card.querySelector('.admin-course-card-edit')?.addEventListener('click', (e) => {
        e.stopPropagation(); openThemeFormModal({ subjectId, themeId });
    });
    card.querySelector('.admin-course-card-delete')?.addEventListener('click', (e) => {
        e.stopPropagation(); C().deleteTheme(subjectId, themeId);
    });
    card.addEventListener('click', () => openCourseDetail(subjectId, themeId));
    return card;
}

function renderCoursesGrid() {
    if (!gridEl) return;
    const data = C()?.getData?.();
    if (!data) return;
    gridEl.innerHTML = '';
    const subjectIds = orderedSubjectIds(data).filter(id => !selectedSubjectFilter || selectedSubjectFilter === id);
    // Reordenar só faz sentido dentro de um único tema — com "todos os temas"
    // a lista mistura vários temas e a posição relativa perde o sentido.
    const canReorder = !!selectedSubjectFilter;
    let total = 0;
    const frag = document.createDocumentFragment();
    subjectIds.forEach(subjectId => {
        const subjectName = data.trainingData[subjectId].name;
        const themeIds = orderedThemeIds(data, subjectId);
        themeIds.forEach((themeId, index) => {
            const theme = data.trainingData[subjectId].themes[themeId];
            if (!theme) return;
            const isActive = theme.active !== false;
            if (selectedStatusFilter === 'active' && !isActive) return;
            if (selectedStatusFilter === 'inactive' && isActive) return;
            frag.appendChild(buildCourseCard(subjectId, subjectName, themeId, theme, index, themeIds.length, canReorder));
            total++;
        });
    });
    gridEl.appendChild(frag);
    if (total === 0) {
        const hasAnyCourse = subjectIds.some(id => orderedThemeIds(data, id).length > 0);
        const msg = hasAnyCourse
            ? (selectedStatusFilter === 'active' ? 'Nenhum curso ativo para os filtros selecionados.'
                : selectedStatusFilter === 'inactive' ? 'Nenhum curso inativo para os filtros selecionados.'
                : 'Nenhum curso para o tema selecionado.')
            : 'Nenhum curso cadastrado ainda. Clique em "Adicionar curso" para começar.';
        gridEl.innerHTML = `<div class="courses-empty">
            <i class="fas fa-graduation-cap"></i>
            <p>${msg}</p>
        </div>`;
    }
    refreshFilterSummary();
}

// Se o drawer de detalhe estiver aberto quando um refresh() acontecer
// (ex.: salvou módulo/avaliação), mantém os contadores da aba em dia.
function refresh() {
    renderCoursesGrid();
    if (currentDetailSubjectId && currentDetailThemeId) refreshDetailTabCounts();
}

window.UniAdminCourses = { refresh, openCourseDetail, openThemeFormModal, ModalStack };

})();
