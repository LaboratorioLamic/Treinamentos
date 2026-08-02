// Painel de Colaboradores (Configurações): mostra a lista de nomes elegíveis
// para cadastro de conta, alimentada automaticamente pela planilha do Google
// Sheets (ver js/colaboradores-sync.js). A lista é acumulativa: quem some da
// planilha continua aqui até ser excluído à mão, e cada item pode ser corrigido
// à mão quando a linha de origem vem errada. Global — não depende da categoria
// escolhida (diferente de Temas/Assuntos/etc).
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, db = U.db, dbRoot = U.dbRoot;
    const showWarning = U.showWarning, showConfirm = U.showConfirm;
    const normalizeName = U.normalizeName;
    const { fetchColaboradores, syncFromSheets } = U.ColaboradoresSync;

    const COLABS_PATH = `/${dbRoot}/colaboradores`;
    const USERS_PATH = `/${dbRoot}/users`;
    const RESULTS_PATH = `/${dbRoot}/results`;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    function colabInitials(name) {
        const clean = (name || '').trim();
        if (!clean) return '?';
        const words = clean.split(/\s+/).filter(w => /[a-zA-ZÀ-ÿ0-9]/.test(w));
        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
        return clean.slice(0, 2).toUpperCase();
    }

    let colaboradoresCache = {};

    function renderList(filterTerm = '') {
        const container = document.getElementById('cfg-colab-container');
        if (!container) return;
        const term = normalizeName(filterTerm);
        const entries = Object.keys(colaboradoresCache)
            .map(id => ({ id, ...colaboradoresCache[id] }))
            .filter(c => c && c.fullName)
            .filter(c => !term || normalizeName(c.fullName).includes(term))
            .sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'));

        if (entries.length === 0) {
            container.innerHTML = '<p class="form-hint">Nenhum colaborador sincronizado ainda.</p>';
            return;
        }

        container.innerHTML = entries.map(c => {
            const metaParts = [];
            if (c.unit) metaParts.push(`<i class="fas fa-building"></i> ${escapeHtml(c.unit)}`);
            if (c.role) metaParts.push(`<i class="fas fa-id-badge"></i> ${escapeHtml(c.role)}`);
            const metaLine = metaParts.length ? `<p class="card-desc">${metaParts.join(' &nbsp;&bull;&nbsp; ')}</p>` : '';
            const edited = c.editedFields && Object.keys(c.editedFields).length > 0;
            return `
            <div class="theme-card" data-colab-id="${escapeHtml(c.id)}">
                <div class="theme-card-head">
                    <span class="theme-card-thumb is-initials">${escapeHtml(colabInitials(c.fullName))}</span>
                    <div class="theme-card-title">
                        <h3>${escapeHtml(c.fullName)}</h3>
                        ${metaLine}
                        <p class="card-desc">
                            ${c.accountUserId
                                ? '<i class="fas fa-circle-check" style="color:var(--success);"></i> Conta criada'
                                : '<i class="fas fa-circle" style="color:var(--text-3);"></i> Sem conta associada'}
                            ${edited ? ' &nbsp;&bull;&nbsp; <i class="fas fa-pen"></i> Corrigido manualmente' : ''}
                        </p>
                    </div>
                </div>
                <div class="card-footer">
                    <div class="card-actions">
                        <button class="btn btn-ghost btn-sm colab-edit" data-colab-id="${escapeHtml(c.id)}" title="Corrigir dados">
                            <i class="fas fa-pencil-alt"></i><span class="btn-label"> Editar</span>
                        </button>
                        <button class="btn btn-danger btn-sm colab-delete" data-colab-id="${escapeHtml(c.id)}" title="Excluir da lista">
                            <i class="fas fa-trash"></i><span class="btn-label"> Excluir</span>
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.colab-edit').forEach(btn => {
            btn.addEventListener('click', () => openColabForm(btn.dataset.colabId));
        });
        container.querySelectorAll('.colab-delete').forEach(btn => {
            btn.addEventListener('click', () => handleDeleteColab(btn.dataset.colabId));
        });
    }

    function currentFilterTerm() {
        return document.getElementById('cfg-colab-filter')?.value || '';
    }

    // ─── Edição manual (corrige o que veio errado da planilha) ───
    // O que é alterado aqui fica marcado em editedFields e passa a ser
    // preservado pelo sync (js/colaboradores-sync.js), senão a próxima
    // sincronização traria de volta o dado inválido da origem.
    const colabFormModal = document.getElementById('cfg-colab-form-modal');
    const colabFormName = document.getElementById('cfg-colab-form-name');
    const colabFormUnit = document.getElementById('cfg-colab-form-unit');
    const colabFormRole = document.getElementById('cfg-colab-form-role');
    const colabFormError = document.getElementById('cfg-colab-form-error');
    const colabFormOk = document.getElementById('cfg-colab-form-ok');
    const colabFormCancel = document.getElementById('cfg-colab-form-cancel');

    let editingColabId = null;
    // Contas de aluno — só para completar as sugestões de setor/função com o
    // que já existe nelas (elas seguem a planilha, mas podem ter valores
    // antigos que ainda são válidos).
    let usersCache = {};

    async function ensureUsers() {
        if (Object.keys(usersCache).length > 0) return;
        try {
            const snapshot = await get(ref(db, USERS_PATH));
            usersCache = snapshot.exists() ? snapshot.val() : {};
        } catch (error) {
            usersCache = {};
        }
    }

    // Setor/Função vêm da própria lista sincronizada (e das contas, que a
    // seguem): digitar continua livre — é o campo que conserta o valor
    // inválido —, mas a lista evita criar variações do mesmo setor
    // ("Adminstrativo" x "Administrativo").
    function distinctValues(field) {
        const set = new Set();
        Object.values(colaboradoresCache).forEach(c => { if (c?.[field]) set.add(String(c[field]).trim()); });
        Object.values(usersCache).forEach(u => { if (u?.[field]) set.add(String(u[field]).trim()); });
        return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    }

    // Combobox leve: input digitável + popover com os valores existentes.
    function setupCombobox({ input, popover, getItems, emptyText }) {
        if (!input || !popover) return;
        let items = [];
        let activeIndex = -1;

        function close() {
            popover.classList.remove('active');
            input.setAttribute('aria-expanded', 'false');
            activeIndex = -1;
        }

        function highlight(index) {
            const nodes = [...popover.querySelectorAll('.user-combobox-item')];
            if (nodes.length === 0) return;
            activeIndex = (index + nodes.length) % nodes.length;
            nodes.forEach((node, i) => node.classList.toggle('is-active', i === activeIndex));
            nodes[activeIndex].scrollIntoView({ block: 'nearest' });
        }

        function choose(value) {
            input.value = value;
            close();
        }

        function open(term = '') {
            const query = normalizeName(term);
            items = getItems().filter(value => !query || normalizeName(value).includes(query)).slice(0, 60);
            popover.innerHTML = items.length === 0
                ? `<div class="user-combobox-empty">${escapeHtml(emptyText)}</div>`
                : items.map((value, i) => `
                    <button type="button" class="user-combobox-item" data-index="${i}">
                        <span class="user-combobox-item-label">${escapeHtml(value)}</span>
                    </button>`).join('');

            popover.querySelectorAll('.user-combobox-item').forEach(node => {
                // mousedown: o blur do input não pode matar o clique antes dele.
                node.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    choose(items[Number(node.dataset.index)]);
                });
            });

            popover.classList.add('active');
            input.setAttribute('aria-expanded', 'true');
            activeIndex = -1;
        }

        input.addEventListener('focus', () => open(''));
        input.addEventListener('input', () => open(input.value));
        input.addEventListener('blur', () => setTimeout(close, 120));
        input.addEventListener('mousedown', () => { if (document.activeElement === input) open(input.value); });
        input.addEventListener('keydown', (event) => {
            const isOpen = popover.classList.contains('active');
            if (event.key === 'ArrowDown') { event.preventDefault(); if (!isOpen) open(input.value); else highlight(activeIndex + 1); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); if (isOpen) highlight(activeIndex - 1); return; }
            if (event.key === 'Escape' && isOpen) { event.stopPropagation(); close(); return; }
            if (event.key === 'Enter' && isOpen && activeIndex >= 0) {
                // Enter escolhendo na lista não pode salvar o formulário junto.
                event.preventDefault(); event.stopPropagation();
                choose(items[activeIndex]);
            }
        });
    }

    setupCombobox({
        input: colabFormUnit,
        popover: document.getElementById('cfg-colab-form-unit-popover'),
        emptyText: 'Nenhum setor na lista sincronizada.',
        getItems: () => distinctValues('unit')
    });

    setupCombobox({
        input: colabFormRole,
        popover: document.getElementById('cfg-colab-form-role-popover'),
        emptyText: 'Nenhuma função na lista sincronizada.',
        getItems: () => distinctValues('role')
    });

    function formError(message) {
        if (!colabFormError) return;
        colabFormError.textContent = message || '';
        colabFormError.classList.toggle('active', !!message);
    }

    function closeColabForm() {
        if (colabFormModal) colabFormModal.style.display = 'none';
        editingColabId = null;
    }

    function openColabForm(colabId) {
        const colab = colaboradoresCache[colabId];
        if (!colab || !colabFormModal) return;
        editingColabId = colabId;
        formError('');
        colabFormName.value = colab.fullName || '';
        colabFormUnit.value = colab.unit || '';
        colabFormRole.value = colab.role || '';
        colabFormModal.style.display = 'flex';
        setTimeout(() => colabFormName.focus(), 60);
        // Sugestões de setor/função: carregam em segundo plano, o popover só
        // é montado quando o campo recebe foco.
        ensureUsers();
    }

    // Registros de histórico avulsos (importados de planilha e os de Estágios
    // sem conta) guardam nome/unidade/cargo no próprio registro, e não por
    // referência ao colaborador — o vínculo é o nome. Ao corrigir o
    // colaborador, esses registros precisam ser reescritos, senão o histórico
    // continua exibindo o dado errado e o nome corrigido deixa de casar com
    // as avaliações antigas.
    async function resultUpdatesForRename(oldNameKey, { fullName, unit, role }) {
        const snapshot = await get(ref(db, RESULTS_PATH));
        if (!snapshot.exists()) return { updates: {}, count: 0 };
        const results = snapshot.val() || {};
        const updates = {};
        let count = 0;

        Object.entries(results.imported || {}).forEach(([slug, entries]) => {
            Object.entries(entries || {}).forEach(([entryId, r]) => {
                if (normalizeName(r?.name || '') !== oldNameKey) return;
                const base = `${RESULTS_PATH}/imported/${slug}/${entryId}`;
                updates[`${base}/name`] = fullName;
                updates[`${base}/unit`] = unit || '';
                updates[`${base}/role`] = role || '';
                count++;
            });
        });

        // estagiosLivre: results/estagiosLivre/{slug}/{subjectId}/{themeId}/{entryId}
        Object.entries(results.estagiosLivre || {}).forEach(([slug, subjects]) => {
            Object.entries(subjects || {}).forEach(([subjectId, themes]) => {
                Object.entries(themes || {}).forEach(([themeId, entries]) => {
                    Object.entries(entries || {}).forEach(([entryId, r]) => {
                        if (normalizeName(r?.name || '') !== oldNameKey) return;
                        updates[`${RESULTS_PATH}/estagiosLivre/${slug}/${subjectId}/${themeId}/${entryId}/name`] = fullName;
                        count++;
                    });
                });
            });
        });

        return { updates, count };
    }

    async function submitColabForm() {
        const colabId = editingColabId;
        const colab = colaboradoresCache[colabId];
        if (!colab) return;

        const fullName = colabFormName.value.trim();
        const unit = colabFormUnit.value.trim();
        const role = colabFormRole.value.trim();
        if (!fullName) { formError('Informe o nome completo.'); return; }

        const nameKey = normalizeName(fullName);
        const duplicate = Object.keys(colaboradoresCache).some(id =>
            id !== colabId && colaboradoresCache[id]?.fullNameKey === nameKey
        );
        if (duplicate) { formError('Já existe outro colaborador com este nome.'); return; }

        const editedFields = { ...(colab.editedFields || {}) };
        if (fullName !== (colab.fullName || '')) editedFields.name = true;
        if ((unit || null) !== (colab.unit || null)) editedFields.unit = true;
        if ((role || null) !== (colab.role || null)) editedFields.role = true;

        colabFormOk.disabled = true;
        try {
            const updates = {};
            updates[`${COLABS_PATH}/${colabId}/fullName`] = fullName;
            updates[`${COLABS_PATH}/${colabId}/fullNameKey`] = nameKey;
            updates[`${COLABS_PATH}/${colabId}/unit`] = unit || null;
            updates[`${COLABS_PATH}/${colabId}/role`] = role || null;
            updates[`${COLABS_PATH}/${colabId}/editedFields`] = editedFields;
            // A âncora do sync é o nome como veio da planilha; se o registro
            // ainda não tem uma, o nome atual (pré-correção) vira a âncora.
            if (!colab.sourceKey) updates[`${COLABS_PATH}/${colabId}/sourceKey`] = colab.fullNameKey || nameKey;
            // A conta vinculada acompanha a correção — é o mesmo dado.
            if (colab.accountUserId) {
                updates[`${USERS_PATH}/${colab.accountUserId}/fullName`] = fullName;
                updates[`${USERS_PATH}/${colab.accountUserId}/fullNameKey`] = nameKey;
                updates[`${USERS_PATH}/${colab.accountUserId}/unit`] = unit || null;
                updates[`${USERS_PATH}/${colab.accountUserId}/role`] = role || null;
            }
            // Histórico avulso ligado pelo nome ANTIGO (o novo já é este).
            const { updates: resultUpdates, count } = await resultUpdatesForRename(
                colab.fullNameKey || normalizeName(colab.fullName || ''),
                { fullName, unit, role }
            );
            Object.assign(updates, resultUpdates);

            await db.ref().update(updates);
            closeColabForm();
            colaboradoresCache = await fetchColaboradores();
            renderList(currentFilterTerm());
            // O histórico em memória (aba Histórico / Dashboard) fica defasado
            // depois de reescrever os registros — força a releitura.
            await U.refreshHistoryRows?.();
            showWarning(count > 0
                ? `Colaborador atualizado — ${count} registro(s) de histórico também foram corrigidos.`
                : 'Colaborador atualizado com sucesso.');
        } catch (error) {
            formError('Erro ao salvar: ' + error.message);
        } finally {
            colabFormOk.disabled = false;
        }
    }

    colabFormOk?.addEventListener('click', submitColabForm);
    colabFormCancel?.addEventListener('click', closeColabForm);
    colabFormModal?.addEventListener('click', (event) => { if (event.target === colabFormModal) closeColabForm(); });
    colabFormModal?.addEventListener('keydown', (event) => {
        // Com um popover de sugestão aberto, Enter/Esc pertencem ao combobox.
        const comboOpen = !!colabFormModal.querySelector('.user-combobox-popover.active');
        if (event.key === 'Enter' && !comboOpen) { event.preventDefault(); submitColabForm(); }
        if (event.key === 'Escape' && !comboOpen) closeColabForm();
    });

    // ─── Exclusão manual ───
    // Único jeito de um nome sair da lista. Se ele ainda estiver na planilha,
    // o próximo sync o traz de volta — o aviso deixa isso explícito.
    async function handleDeleteColab(colabId) {
        const colab = colaboradoresCache[colabId];
        if (!colab) return;

        const details = ['Se o nome ainda estiver na planilha, ele voltará na próxima sincronização.'];
        if (colab.accountUserId) {
            details.push({ text: 'Este colaborador tem conta de aluno; a conta NÃO é excluída, apenas perde o vínculo.', alert: true });
        }
        details.push({ text: 'Esta ação não pode ser desfeita.', alert: true });

        const confirmed = await showConfirm({
            title: 'Excluir colaborador',
            message: `${colab.fullName} será removido da lista de colaboradores.`,
            icon: 'fa-trash-can',
            details,
            confirmText: 'Excluir'
        });
        if (!confirmed) return;

        try {
            const updates = {};
            updates[`${COLABS_PATH}/${colabId}`] = null;
            if (colab.accountUserId) {
                updates[`${USERS_PATH}/${colab.accountUserId}/colaboradorId`] = null;
            }
            await db.ref().update(updates);
            colaboradoresCache = await fetchColaboradores();
            renderList(currentFilterTerm());
            showWarning('Colaborador excluído da lista.');
        } catch (error) {
            showWarning('Erro ao excluir colaborador: ' + error.message);
        }
    }

    function setSyncStatus(text) {
        const el = document.getElementById('cfg-colab-sync-status');
        if (el) el.textContent = text;
    }

    async function populateColaboradores() {
        showSpinner(true);
        try {
            // Sincroniza da planilha antes de mostrar a lista — a fonte oficial
            // é o Google Sheets, então cada visita à aba busca o que há de novo.
            const syncResult = await syncFromSheets({ silent: true });
            colaboradoresCache = await fetchColaboradores();
            renderList(currentFilterTerm());
            const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const parts = [];
            if (syncResult?.added) parts.push(`${syncResult.added} novo(s)`);
            if (syncResult?.updated) parts.push(`${syncResult.updated} atualizado(s)`);
            if (syncResult?.usersUpdated) parts.push(`${syncResult.usersUpdated} conta(s) com setor/função atualizado(s)`);
            setSyncStatus(`Última sincronização às ${now} — ${parts.length ? parts.join(', ') : 'nenhuma mudança'}.`);
        } catch (error) {
            showWarning('Erro ao sincronizar com a planilha: ' + error.message);
            setSyncStatus('Falha na última sincronização.');
        } finally {
            showSpinner(false);
        }
    }
    U.populateColaboradores = populateColaboradores;

    function showSpinner(show) {
        const el = document.getElementById('cfg-colab-loading');
        if (el) el.style.display = show ? 'block' : 'none';
    }

    document.getElementById('cfg-colab-filter')?.addEventListener('input', (event) => {
        renderList(event.target.value);
    });

    document.getElementById('cfg-colab-sync-btn')?.addEventListener('click', populateColaboradores);
})();
