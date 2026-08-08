// Painel administrativo (UniAdmin).
// Vive dentro da index principal, na <section id="cfg-root">.
// A senha de acesso e validada em js/auth.js ANTES deste painel ser exibido.
(function () {

const U = window.UniAdmin;
const ref = U.ref, get = U.get, set = U.set;
const db = U.db, dbRoot = U.dbRoot, getCategoryDbPath = U.getCategoryDbPath;
const showWarning = U.showWarning, showLoadingBar = U.showLoadingBar;
const hideLoadingBar = U.hideLoadingBar, cancelLoadingBar = U.cancelLoadingBar;
const showConfirm = U.showConfirm;
const normalizeName = U.normalizeName; // js/crypto-utils.js

let currentDbPath = null;
let currentCategory = null;
let data = { trainingData: {}, quizData: {} };
let currentSubjectId = null;
let currentThemeId = null;
let currentModuleIndex = null;
let currentQuizIndex = null;

function initializeTabs() {
    // Escopado à nav da sidebar/aos tab-content de topo — ver comentário em
    // 'tabButtons'/'tabContents' mais abaixo sobre por que não usar
    // '#cfg-root .tab-btn'/'#cfg-root .tab-content' sem escopo aqui.
    const allTabButtons = document.querySelectorAll('#cfg-root .sidebar-nav .tab-btn');
    const allTabContents = document.querySelectorAll('#cfg-root .content-area > .tab-content');
    allTabButtons.forEach(btn => btn.classList.remove('active'));
    allTabContents.forEach(content => content.classList.remove('active'));
    const coursesBtn = document.querySelector('#cfg-root .sidebar-nav .tab-btn[data-tab="courses"]');
    const coursesTab = document.getElementById('cfg-courses-tab');
    if (coursesBtn) coursesBtn.classList.add('active');
    if (coursesTab) coursesTab.classList.add('active');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function getNextId(obj) {
    if (!obj || Object.keys(obj).length === 0) return '1';
    const maxId = Math.max(...Object.keys(obj).map(Number));
    return String(maxId + 1);
}

function showModal() {
    document.getElementById('cfg-category-modal').style.display = 'flex';
    const select = document.getElementById('cfg-category-select');
    // Sugere a plataforma escolhida na home; o usuário ainda confirma.
    const suggested = new URLSearchParams(location.search).get('cat');
    select.value = (suggested && [...select.options].some(o => o.value === suggested)) ? suggested : '';
    document.getElementById('cfg-modal-content').classList.remove('error');
}

function hideModal() {
    document.getElementById('cfg-category-modal').style.display = 'none';
}

// Plataforma vinda da home (?cat=), quando é uma opção válida do seletor.
function categoryFromUrl() {
    const suggested = new URLSearchParams(location.search).get('cat');
    const select = document.getElementById('cfg-category-select');
    if (!suggested || !select) return null;
    return [...select.options].some(o => o.value === suggested) ? suggested : null;
}

async function applyCategory(category) {
    showLoadingBar();
    try {
        currentCategory = category;
        currentDbPath = getCategoryDbPath(category);
        const catBadge = document.getElementById('cfg-category-badge-display');
        const catLabel = document.getElementById('cfg-current-category-label');
        if (catBadge && catLabel) { catLabel.textContent = currentCategory; catBadge.classList.remove('inactive'); }
        hideModal();
        // Outras abas (Histórico, Usuários) seguem a categoria/plataforma
        // escolhida aqui em vez de terem um seletor próprio.
        U.currentCategorySlug = U.categoryPaths[currentCategory] || null;
        U.currentCategoryName = currentCategory;
        document.dispatchEvent(new CustomEvent('uniadmin:category-changed', { detail: { slug: U.currentCategorySlug } }));
        await fetchData();
    } catch (error) {
        cancelLoadingBar();
        throw error;
    } finally {
        hideLoadingBar();
    }
}

document.getElementById('cfg-category-submit').addEventListener('click', () => {
    const category = document.getElementById('cfg-category-select').value;
    if (!category) { showWarning('Por favor, selecione uma categoria.'); return; }
    return applyCategory(category);
});

document.getElementById('cfg-category-select').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); document.getElementById('cfg-category-submit').click(); }
});

        document.getElementById('cfg-backup-btn').addEventListener('click', () => {
            if (!currentDbPath) { showWarning('Selecione uma categoria primeiro.'); return; }
            refreshWipeSection();
            document.getElementById('cfg-backup-modal').style.display = 'flex';
        });

        document.getElementById('cfg-download-btn').addEventListener('click', async () => {
            if (!currentDbPath) { showWarning('Selecione uma categoria primeiro.'); return; }
            try {
                const snapshot = await get(ref(db, currentDbPath));
                const result = snapshot.exists() ? snapshot.val() : { trainingData: {}, quizData: {} };
                const jsonData = JSON.stringify(result, null, 2);
                const date = new Date().toISOString().split('T')[0];
                const filename = `${currentCategory.replace(/\s+/g, '_')}_backup_${date}.json`;
                const blob = new Blob([jsonData], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(url);
                showWarning('Backup baixado com sucesso!');
            } catch (error) { showWarning('Erro ao baixar backup: ' + error.message); }
        });

        // O input de arquivo fica escondido; o nome escolhido aparece na linha.
        document.getElementById('cfg-upload-file').addEventListener('change', (event) => {
            const label = document.getElementById('cfg-upload-filename');
            const file = event.target.files[0];
            label.textContent = file ? file.name : 'Nenhum arquivo escolhido';
        });

        document.getElementById('cfg-upload-btn').addEventListener('click', async () => {
            const fileInput = document.getElementById('cfg-upload-file');
            if (!fileInput.files[0]) { showWarning('Selecione um arquivo JSON primeiro.'); return; }
            const confirmed = await showConfirm({
                title: 'Restaurar backup',
                message: `O conteúdo atual de ${currentCategory} será substituído pelo arquivo selecionado.`,
                icon: 'fa-upload',
                details: [
                    `Arquivo: ${fileInput.files[0].name}`,
                    'Temas, assuntos, módulos e avaliações serão sobrescritos.',
                    { text: 'A versão atual será perdida se não houver backup.', alert: true }
                ],
                requireWord: 'SIM',
                confirmText: 'Restaurar'
            });
            if (!confirmed) { showWarning('Upload cancelado.'); return; }
            try {
                const file = fileInput.files[0];
                const text = await file.text();
                const newData = JSON.parse(text);
                data = newData;
                initializeOrderFields();
                await saveData();
                populateSubjectSelects(); populateSubjects(); populateThemes(); populateModules(); populateQuizzes();
                document.getElementById('cfg-backup-modal').style.display = 'none';
                showWarning('Backup carregado com sucesso!');
            } catch (error) { showWarning('Erro ao carregar backup: ' + error.message); }
        });

        // Outras categorias que gravam no MESMO caminho do banco que a atual.
        // Apagar os dados atinge todas elas, então o aviso precisa ser explícito.
        function sharedCategories() {
            const paths = U.categoryPaths || {};
            const currentSlug = paths[currentCategory];
            return Object.keys(paths).filter(c => c !== currentCategory && paths[c] === currentSlug);
        }

        function refreshWipeSection() {
            // A zona de perigo volta recolhida a cada abertura do modal.
            document.querySelector('#cfg-backup-modal .danger-details')?.removeAttribute('open');

            const label = document.getElementById('cfg-wipe-category');
            if (label) label.textContent = currentCategory || '—';

            const box = document.getElementById('cfg-wipe-shared');
            const text = document.getElementById('cfg-wipe-shared-text');
            if (!box || !text) return;

            const shared = currentCategory ? sharedCategories() : [];
            if (shared.length === 0) { box.style.display = 'none'; return; }
            text.textContent = `Atenção: mesmo banco de ${shared.join(', ')} — esses dados também serão apagados.`;
            box.style.display = 'flex';
        }

        document.getElementById('cfg-wipe-btn').addEventListener('click', async () => {
            if (!currentDbPath) { showWarning('Selecione uma categoria primeiro.'); return; }

            const shared = sharedCategories();
            const details = ['Temas, assuntos, módulos e avaliações serão removidos.'];
            if (shared.length) {
                details.push({ text: `Isso também apaga: ${shared.join(', ')} (mesmo banco de dados).`, alert: true });
            }
            details.push({ text: 'Não há como desfazer — baixe um backup antes.', alert: true });

            const confirmed = await showConfirm({
                title: `Apagar dados de ${currentCategory}`,
                message: 'Todo o conteúdo desta categoria será removido do banco.',
                icon: 'fa-trash-can',
                details,
                requireWord: 'SIM',
                confirmText: 'Apagar tudo'
            });
            if (!confirmed) { showWarning('Exclusão cancelada.'); return; }

            const wipeBtn = document.getElementById('cfg-wipe-btn');
            wipeBtn.disabled = true;
            showLoadingBar();
            try {
                // Grava a estrutura vazia no caminho da categoria; as outras ficam intactas.
                const emptyData = { trainingData: {}, quizData: {}, quizStatus: {}, order: { subjects: [], themes: {}, modules: {} } };
                await set(ref(db, currentDbPath), emptyData);
                data = emptyData;
                currentSubjectId = null;
                currentThemeId = null;
                initializeOrderFields();
                populateSubjectSelects(); populateSubjects(); populateThemes(); populateModules(); populateQuizzes();
                document.getElementById('cfg-backup-modal').style.display = 'none';
                showWarning(`Dados da categoria ${currentCategory} apagados.`);
            } catch (error) {
                cancelLoadingBar();
                showWarning('Erro ao apagar os dados: ' + error.message);
            } finally {
                hideLoadingBar();
                wipeBtn.disabled = false;
            }
        });

        document.getElementById('cfg-backup-close').addEventListener('click', () => {
            document.getElementById('cfg-backup-modal').style.display = 'none';
        });

        document.getElementById('cfg-change-category-btn').addEventListener('click', () => {
            showModal();
            document.querySelectorAll('#cfg-root .tab-content').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('#cfg-root .tab-btn').forEach(btn => btn.classList.remove('active'));
        });

        // O Firebase devolve arrays com buracos (índice 0 nulo, ids removidos).
        // Só interessam as chaves que apontam para um objeto real.
        function validKeys(collection) {
            if (!collection || typeof collection !== 'object') return [];
            return Object.keys(collection).filter(key => collection[key] && typeof collection[key] === 'object');
        }

        function initializeOrderFields() {
            if (!data.trainingData || typeof data.trainingData !== 'object') { data.trainingData = {}; }
            if (!data.quizData || typeof data.quizData !== 'object') { data.quizData = {}; }
            if (!data.order || typeof data.order !== 'object') { data.order = { subjects: [], themes: {}, modules: {} }; }
            if (!Array.isArray(data.order.subjects)) { data.order.subjects = []; }
            if (!data.order.themes || typeof data.order.themes !== 'object') { data.order.themes = {}; }
            if (!data.order.modules || typeof data.order.modules !== 'object') { data.order.modules = {}; }

            const subjectIds = validKeys(data.trainingData);
            if (data.order.subjects.length === 0) { data.order.subjects = subjectIds; }

            subjectIds.forEach(subjectId => {
                const themes = data.trainingData[subjectId].themes;
                const themeIds = validKeys(themes);
                if (!data.order.themes[subjectId]) { data.order.themes[subjectId] = themeIds; }
                themeIds.forEach(themeId => {
                    if (!data.order.modules[subjectId]) { data.order.modules[subjectId] = {}; }
                    if (!data.order.modules[subjectId][themeId]) {
                        const moduleCount = themes[themeId].modules?.length || 0;
                        data.order.modules[subjectId][themeId] = Array.from({length: moduleCount}, (_, i) => i);
                    }
                });
            });
        }

        async function fetchData() {
            if (!currentDbPath) { console.error('currentDbPath não definido'); return; }
            try {
                const snapshot = await get(ref(db, currentDbPath));
                data = snapshot.exists() ? snapshot.val() : { trainingData: {}, quizData: {} };
                initializeOrderFields();
                populateSubjectSelects(); populateSubjects(); populateThemes(); populateModules(); populateQuizzes();
                window.UniAdminCourses?.refresh?.();
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                const coursesBtn = document.querySelector('#cfg-root .tab-btn[data-tab="courses"]');
                const coursesTab = document.getElementById('cfg-courses-tab');
                if (coursesBtn) coursesBtn.classList.add('active');
                if (coursesTab) coursesTab.classList.add('active');
            } catch (error) {
                console.error('Erro ao carregar dados:', error.message);
                showWarning('Não foi possível carregar os dados. Tente novamente.');
                showModal();
            }
        }

        async function saveData() {
            if (!currentDbPath) { console.error('currentDbPath não definido'); showWarning('Nenhuma categoria selecionada.'); return false; }
            try {
                await set(ref(db, currentDbPath), data);
                // Ponte para a camada de apresentação da aba "Cursos" (js/admin-courses.js):
                // qualquer save bem-sucedido (Tema/Assunto/Módulo/Avaliação) atualiza o grid.
                window.UniAdminCourses?.refresh?.();
                return true;
            } catch (error) {
                console.error('Erro ao salvar dados:', error.message);
                showWarning(`Não foi possível salvar os dados: ${error.message}`);
                return false;
            }
        }

        function showSpinner(id, show) { document.getElementById(id).style.display = show ? 'block' : 'none'; }

        async function moveSubject(id, direction) {
            if (!data.order?.subjects) return false;
            const currentIndex = data.order.subjects.indexOf(id);
            if (currentIndex === -1) return false;
            const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
            if (newIndex < 0 || newIndex >= data.order.subjects.length) return false;
            [data.order.subjects[currentIndex], data.order.subjects[newIndex]] = [data.order.subjects[newIndex], data.order.subjects[currentIndex]];
            if (await saveData()) { populateSubjectSelects(); populateSubjects(); showWarning('Ordem dos temas atualizada!'); return true; }
            return false;
        }

        async function moveTheme(subjectId, themeId, direction) {
            if (!data.order?.themes?.[subjectId]) return false;
            const currentIndex = data.order.themes[subjectId].indexOf(themeId);
            if (currentIndex === -1) return false;
            const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
            if (newIndex < 0 || newIndex >= data.order.themes[subjectId].length) return false;
            [data.order.themes[subjectId][currentIndex], data.order.themes[subjectId][newIndex]] = [data.order.themes[subjectId][newIndex], data.order.themes[subjectId][currentIndex]];
            if (await saveData()) { populateModuleThemes(); populateQuizThemes(); populateThemes(); showWarning('Ordem dos assuntos atualizada!'); return true; }
            return false;
        }

        async function moveModule(subjectId, themeId, position, direction) {
            // Ensure order array exists for this subject/theme. The UI passes
            // `position` as the displayed position (0..n-1) in the ordered list,
            // so we must swap entries in the order array (not the modules array
            // directly).
            const modules = data.trainingData[subjectId]?.themes?.[themeId]?.modules || [];
            if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
            if (!data.order.modules) data.order.modules = {};
            if (!data.order.modules[subjectId]) data.order.modules[subjectId] = {};
            if (!data.order.modules[subjectId][themeId]) {
                data.order.modules[subjectId][themeId] = Array.from({ length: modules.length }, (_, i) => i);
            }
            const orderArray = data.order.modules[subjectId][themeId];
            const currentIndex = position;
            const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
            if (currentIndex < 0 || currentIndex >= orderArray.length) return false;
            if (newIndex < 0 || newIndex >= orderArray.length) return false;
            [orderArray[currentIndex], orderArray[newIndex]] = [orderArray[newIndex], orderArray[currentIndex]];
            if (await saveData()) { populateModules(); showWarning('Ordem dos módulos atualizada!'); return true; }
            return false;
        }

        async function moveQuiz(subjectId, themeId, index, direction) {
            const quizKey = `${subjectId}_${themeId}`;
            if (!data.quizData[quizKey]) return false;
            const quizzes = data.quizData[quizKey];
            const newIndex = direction === 'up' ? index - 1 : index + 1;
            if (newIndex < 0 || newIndex >= quizzes.length) return false;
            [quizzes[index], quizzes[newIndex]] = [quizzes[newIndex], quizzes[index]];
            if (await saveData()) { populateQuizzes(); showWarning('Ordem das questões atualizada!'); return true; }
            return false;
        }

        // Escopado à nav da sidebar: '#cfg-root .tab-btn' sozinho pegaria também
        // os botões de aba internos do drawer de curso (.course-drawer-tabs) e
        // dos modais de dashboard, que reaproveitam a mesma classe .tab-btn.
        const tabButtons = document.querySelectorAll('#cfg-root .sidebar-nav .tab-btn');
        const tabContents = document.querySelectorAll('#cfg-root .content-area > .tab-content');
        // Colaboradores e Usuários são globais (não dependem de categoria) —
        // as demais abas gerenciam conteúdo de curso e continuam exigindo
        // uma categoria escolhida.
        const CATEGORY_INDEPENDENT_TABS = ['colaboradores', 'users', 'dashboard', 'history'];

        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const isCategoryIndependent = CATEGORY_INDEPENDENT_TABS.includes(btn.dataset.tab);
                if (!currentDbPath && !isCategoryIndependent) { showWarning('Selecione uma categoria antes de continuar.'); return; }
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const targetTab = document.getElementById(`cfg-${btn.dataset.tab}-tab`);
                if (targetTab) targetTab.classList.add('active');
                if (btn.dataset.tab === 'courses') window.UniAdminCourses?.refresh?.();
                if (btn.dataset.tab === 'colaboradores') window.UniAdmin.populateColaboradores?.();
                if (btn.dataset.tab === 'users') window.UniAdmin.populateUsers?.();
                if (btn.dataset.tab === 'dashboard') window.UniAdmin.initDashboard?.();
                if (btn.dataset.tab === 'history') window.UniAdmin.populateHistory?.();
            });
        });

        const subjectNameInput = document.getElementById('cfg-subject-name');
        const subjectSaveBtn = document.getElementById('cfg-subject-save');
        const subjectDeleteBtn = document.getElementById('cfg-subject-delete');
        const subjectsContainer = document.getElementById('cfg-subjects-container');

        function populateSubjectSelects() {
            const selects = [document.getElementById('cfg-theme-subject'), document.getElementById('cfg-module-subject'), document.getElementById('cfg-quiz-subject')];
            selects.forEach(select => {
                select.innerHTML = '<option value="">Selecione um tema</option>';
                validKeys(data.trainingData).forEach(id => {
                    const option = document.createElement('option');
                    option.value = id; option.textContent = data.trainingData[id].name;
                    select.appendChild(option);
                });
            });
        }

        function populateSubjects() {
            if (!subjectsContainer) return;
            subjectsContainer.innerHTML = '';
            if (!data.trainingData || Object.keys(data.trainingData).length === 0) return;
            let orderedIds;
            if (data.order?.subjects && data.order.subjects.length > 0) {
                orderedIds = data.order.subjects.filter(id => data.trainingData[id]);
            } else {
                orderedIds = validKeys(data.trainingData).sort();
            }
            orderedIds.forEach((id, index) => {
                const subject = data.trainingData[id];
                if (!subject) return;
                const card = document.createElement('div');
                card.className = 'subject-card';
                const isFirst = index === 0;
                const isLast = index === orderedIds.length - 1;
                card.innerHTML = `
                    <h3>${subject.name}</h3>
                    <div class="card-footer">
                        <div class="order-buttons">
                            <button class="order-btn" data-id="${id}" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                            <button class="order-btn" data-id="${id}" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-ghost btn-sm edit-subject" data-id="${id}"><i class="fas fa-pencil-alt"></i> Editar</button>
                            <button class="btn btn-danger btn-sm delete-subject" data-id="${id}"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                subjectsContainer.appendChild(card);
            });
            subjectsContainer.querySelectorAll('.edit-subject').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentSubjectId = btn.dataset.id;
                    subjectNameInput.value = data.trainingData[currentSubjectId].name;
                    subjectDeleteBtn.style.display = 'flex';
                });
            });
            subjectsContainer.querySelectorAll('.delete-subject').forEach(btn => {
                btn.addEventListener('click', () => { deleteSubject(btn.dataset.id); });
            });
            subjectsContainer.querySelectorAll('.order-btn').forEach(btn => {
                btn.addEventListener('click', async () => { await moveSubject(btn.dataset.id, btn.dataset.direction); });
            });
        }

        async function deleteSubject(id) {
            if (!data.trainingData[id]) { showWarning('Tema não encontrado.'); return; }
            if (validKeys(data.trainingData[id].themes).length > 0) { showWarning('Não é possível excluir o tema porque ele contém assuntos.'); return; }
            if (await showConfirm({
                title: 'Excluir tema',
                message: `O tema "${data.trainingData[id].name}" será removido.`,
                icon: 'fa-bookmark',
                confirmText: 'Excluir'
            })) {
                showSpinner('cfg-subject-loading', true);
                try {
                    delete data.trainingData[id];
                    if (data.order?.subjects) {
                        const idx = data.order.subjects.indexOf(id);
                        if (idx > -1) data.order.subjects.splice(idx, 1);
                    }
                    Object.keys(data.quizData).forEach(key => { if (key.startsWith(`${id}_`)) delete data.quizData[key]; });
                    if (await saveData()) {
                        currentSubjectId = null; subjectNameInput.value = ''; subjectDeleteBtn.style.display = 'none';
                        populateSubjectSelects(); populateSubjects(); showWarning('Tema excluído com sucesso!');
                    }
                } catch (error) { showWarning('Erro ao excluir tema. Tente novamente.'); }
                finally { showSpinner('cfg-subject-loading', false); }
            }
        }

        subjectSaveBtn.addEventListener('click', async () => {
            const name = subjectNameInput.value.trim();
            if (!name) { showWarning('Por favor, insira o nome do tema.'); return; }
            showSpinner('cfg-subject-loading', true);
            const id = currentSubjectId || getNextId(data.trainingData);
            const isNew = !currentSubjectId;
            data.trainingData[id] = { id, name, themes: data.trainingData[id]?.themes || {} };
            if (isNew) {
                if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
                data.order.subjects.push(id);
            }
            try {
                if (await saveData()) {
                    currentSubjectId = null; subjectNameInput.value = ''; subjectDeleteBtn.style.display = 'none';
                    populateSubjectSelects(); populateSubjects(); showWarning('Tema salvo com sucesso!');
                }
            } catch (error) { showWarning('Erro ao salvar tema. Tente novamente.'); }
            finally { showSpinner('cfg-subject-loading', false); }
        });

        subjectDeleteBtn.addEventListener('click', () => {
            if (currentSubjectId) deleteSubject(currentSubjectId);
            else showWarning('Selecione um tema para excluir.');
        });

        const themeSubjectSelect = document.getElementById('cfg-theme-subject');
        const themeNameInput = document.getElementById('cfg-theme-name');
        const themeDescriptionInput = document.getElementById('cfg-theme-description');
        const themeDescCount = document.getElementById('cfg-theme-desc-count');
        const themeImageFile = document.getElementById('cfg-theme-image-file');
        const themeImageClear = document.getElementById('cfg-theme-image-clear');
        const themeImagePreview = document.getElementById('cfg-theme-image-preview');
        const themeImageInfo = document.getElementById('cfg-theme-image-info');
        const themeSaveBtn = document.getElementById('cfg-theme-save');
        const themeDeleteBtn = document.getElementById('cfg-theme-delete');
        const themesContainer = document.getElementById('cfg-themes-container');
        const themeStatusActiveBtn = document.getElementById('cfg-theme-status-active');
        const themeStatusInactiveBtn = document.getElementById('cfg-theme-status-inactive');
        let themeActive = true;

        function setThemeActive(isActive) {
            themeActive = isActive;
            themeStatusActiveBtn.classList.toggle('active', isActive);
            themeStatusInactiveBtn.classList.toggle('active', !isActive);
        }
        themeStatusActiveBtn.addEventListener('click', () => setThemeActive(true));
        themeStatusInactiveBtn.addEventListener('click', () => setThemeActive(false));

        // Imagem em edição no formulário de assunto.
        // null = sem alteração pendente; { dataUrl, version } = nova; { removed: true } = apagar.
        let pendingThemeImage = null;

        // ─── Prazo (deadline) do assunto ───
        const deadlineLivreBtn = document.getElementById('cfg-theme-deadline-livre');
        const deadlinePrazoBtn = document.getElementById('cfg-theme-deadline-prazo');
        const deadlineFields = document.getElementById('cfg-theme-deadline-fields');
        const deadlineStartInput = document.getElementById('cfg-theme-deadline-start');
        const deadlineEndInput = document.getElementById('cfg-theme-deadline-end');
        const deadlineCloseInput = document.getElementById('cfg-theme-deadline-close');
        const deadlineErrorEl = document.getElementById('cfg-theme-deadline-error');
        let deadlineMode = 'livre';

        // datetime-local não trabalha com timestamp direto; local (não UTC).
        function timestampToLocalInput(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        function localInputToTimestamp(value) {
            if (!value) return null;
            const ts = new Date(value).getTime();
            return Number.isNaN(ts) ? null : ts;
        }

        function setDeadlineMode(mode) {
            deadlineMode = mode;
            deadlineLivreBtn.classList.toggle('active', mode === 'livre');
            deadlinePrazoBtn.classList.toggle('active', mode === 'prazo');
            deadlineFields.style.display = mode === 'prazo' ? 'block' : 'none';
            deadlineErrorEl.style.display = 'none';
        }
        deadlineLivreBtn.addEventListener('click', () => setDeadlineMode('livre'));
        deadlinePrazoBtn.addEventListener('click', () => setDeadlineMode('prazo'));

        function resetDeadlineFields() {
            setDeadlineMode('livre');
            deadlineStartInput.value = '';
            deadlineEndInput.value = '';
            deadlineCloseInput.value = '';
        }

        function loadDeadlineFields(deadline) {
            if (!deadline || deadline.mode !== 'prazo') { resetDeadlineFields(); return; }
            setDeadlineMode('prazo');
            deadlineStartInput.value = timestampToLocalInput(deadline.startAt);
            deadlineEndInput.value = timestampToLocalInput(deadline.endAt);
            deadlineCloseInput.value = timestampToLocalInput(deadline.closeAt);
        }

        // Valida e monta o objeto deadline a salvar. Retorna null (modo livre)
        // ou lança erro de validação exibido no próprio card do formulário.
        function buildDeadlineFromForm() {
            if (deadlineMode !== 'prazo') return null;
            const startAt = localInputToTimestamp(deadlineStartInput.value);
            const endAt = localInputToTimestamp(deadlineEndInput.value);
            const closeAt = localInputToTimestamp(deadlineCloseInput.value);
            if (!startAt || !endAt || !closeAt) {
                throw new Error('Preencha início, prazo final e encerramento.');
            }
            if (!(startAt < endAt && endAt <= closeAt)) {
                throw new Error('As datas devem seguir: início < prazo final ≤ encerramento.');
            }
            return { mode: 'prazo', startAt, endAt, closeAt };
        }

        // ─── Funções (cargos) que enxergam o assunto ───
        // Lista vinda dos cargos de /colaboradores (planilha, mesma fonte da
        // aba Colaboradores) somada aos das contas (/users). Seleção vazia =
        // curso visível para todos (inclusive quem não tem cargo definido).
        const rolesBtn = document.getElementById('cfg-theme-roles-btn');
        const rolesPopover = document.getElementById('cfg-theme-roles-popover');
        const rolesListEl = document.getElementById('cfg-theme-roles-list');
        const rolesSearchInput = document.getElementById('cfg-theme-roles-search');
        const rolesClearBtn = document.getElementById('cfg-theme-roles-clear');
        const rolesSummaryEl = document.getElementById('cfg-theme-roles-summary');

        let selectedRoles = new Set();
        let availableRoles = [];

        // Cargos distintos dos colaboradores (planilha) + das contas + os já
        // gravados no assunto em edição (um cargo pode ter sumido da planilha,
        // mas a regra do curso continua valendo até o admin mudar).
        async function loadAvailableRoles() {
            try {
                const [colabsSnap, usersSnap] = await Promise.all([
                    U.get(U.ref(U.db, `/${U.dbRoot}/colaboradores`)),
                    U.get(U.ref(U.db, `/${U.dbRoot}/users`))
                ]);
                const colaboradores = colabsSnap.exists() ? colabsSnap.val() : {};
                const users = usersSnap.exists() ? usersSnap.val() : {};
                const roles = new Set();
                [colaboradores, users].forEach(source => {
                    Object.keys(source).forEach(id => {
                        const role = (source[id]?.role || '').trim();
                        if (role) roles.add(role);
                    });
                });
                selectedRoles.forEach(role => roles.add(role));
                availableRoles = [...roles].sort((a, b) => a.localeCompare(b, 'pt-BR'));
            } catch (error) {
                availableRoles = [...selectedRoles];
            }
            renderRolesList();
        }

        function refreshRolesSummary() {
            const count = selectedRoles.size;
            rolesSummaryEl.textContent = count === 0
                ? 'Todas as funções'
                : count === 1 ? [...selectedRoles][0] : `${count} funções selecionadas`;
            rolesBtn.classList.toggle('is-on', count > 0);
        }

        function renderRolesList() {
            const term = normalizeName(rolesSearchInput?.value || '');
            const visible = availableRoles.filter(role => !term || normalizeName(role).includes(term));
            if (visible.length === 0) {
                rolesListEl.innerHTML = availableRoles.length === 0
                    ? '<p class="roles-popover-empty">Nenhuma função encontrada na lista de colaboradores.</p>'
                    : '<p class="roles-popover-empty">Nada encontrado.</p>';
                refreshRolesSummary();
                positionRolesPopover();
                return;
            }
            // Cada função é um botão selecionável (seleção múltipla, sem
            // checkbox): o próprio pill mostra o estado.
            rolesListEl.innerHTML = visible.map(role => {
                const on = selectedRoles.has(role);
                return `
                <button type="button" class="roles-popover-option ${on ? 'is-selected' : ''}"
                        data-role="${escapeHtml(role)}" aria-pressed="${on}">
                    <span class="roles-popover-option-mark"><i class="fas fa-check"></i></span>
                    <span class="roles-popover-option-label">${escapeHtml(role)}</span>
                </button>`;
            }).join('');
            rolesListEl.querySelectorAll('.roles-popover-option[data-role]').forEach(option => {
                option.addEventListener('click', () => {
                    const role = option.dataset.role;
                    const on = !selectedRoles.has(role);
                    if (on) selectedRoles.add(role); else selectedRoles.delete(role);
                    option.classList.toggle('is-selected', on);
                    option.setAttribute('aria-pressed', String(on));
                    refreshRolesSummary();
                });
            });
            refreshRolesSummary();
            positionRolesPopover();
        }

        // O card do formulário tem overflow:hidden, então o popover é movido
        // para o fim de #cfg-root e posicionado em coordenadas de viewport
        // (CSS position:fixed) — assim nunca fica cortado nem por baixo.
        function positionRolesPopover() {
            if (!rolesPopover || rolesPopover.hidden) return;
            const rect = rolesBtn.getBoundingClientRect();
            const gap = 6;
            const margin = 10;
            rolesPopover.style.width = `${rect.width}px`;
            rolesPopover.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
            // Mede a altura real para decidir se abre para baixo ou para cima.
            rolesPopover.style.top = '0px';
            const height = rolesPopover.offsetHeight;
            const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
            const openUp = spaceBelow < height && rect.top - gap - margin > spaceBelow;
            const available = Math.max(180, openUp ? rect.top - gap - margin : spaceBelow);
            // Só a lista rola; o resto do popover (busca) fica sempre visível.
            const chrome = height - rolesListEl.offsetHeight;
            rolesListEl.style.maxHeight = `${Math.max(120, available - chrome)}px`;
            const finalHeight = Math.min(rolesPopover.offsetHeight, available);
            rolesPopover.style.top = openUp
                ? `${rect.top - gap - finalHeight}px`
                : `${rect.bottom + gap}px`;
        }

        function closeRolesPopover() {
            if (!rolesPopover || rolesPopover.hidden) return;
            rolesPopover.hidden = true;
            rolesBtn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onRolesOutsideClick, true);
            window.removeEventListener('resize', positionRolesPopover);
            window.removeEventListener('scroll', positionRolesPopover, true);
        }
        function onRolesOutsideClick(event) {
            if (!rolesPopover.contains(event.target) && !rolesBtn.contains(event.target)) closeRolesPopover();
        }

        rolesBtn?.addEventListener('click', () => {
            const willOpen = rolesPopover.hidden;
            if (!willOpen) { closeRolesPopover(); return; }
            const cfgRoot = document.getElementById('cfg-root') || document.body;
            if (rolesPopover.parentElement !== cfgRoot) cfgRoot.appendChild(rolesPopover);
            rolesPopover.hidden = false;
            rolesBtn.setAttribute('aria-expanded', 'true');
            rolesSearchInput.value = '';
            renderRolesList();
            positionRolesPopover();
            loadAvailableRoles();
            document.addEventListener('click', onRolesOutsideClick, true);
            window.addEventListener('resize', positionRolesPopover);
            window.addEventListener('scroll', positionRolesPopover, true);
            setTimeout(() => rolesSearchInput.focus(), 40);
        });
        rolesSearchInput?.addEventListener('input', renderRolesList);
        rolesClearBtn?.addEventListener('click', () => {
            selectedRoles.clear();
            renderRolesList();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeRolesPopover();
        });

        function resetRolesConfig() {
            selectedRoles = new Set();
            closeRolesPopover();
            renderRolesList();
        }

        function loadRolesConfig(theme) {
            selectedRoles = new Set(Array.isArray(theme?.roles) ? theme.roles.filter(Boolean) : []);
            closeRolesPopover();
            renderRolesList();
        }

        // ─── Certificado do assunto (modal de configuração) ───
        // `certConfig` é o estado confirmado (gravado junto com o assunto ao
        // salvar); `certDraftTopics` é a lista em edição dentro do modal, que
        // só substitui a original quando o usuário clica em "Aplicar".
        let certConfig = { enabled: false, title: '', hours: null, topics: [] };
        let certDraftTopics = [];

        const certOpenBtn = document.getElementById('cfg-theme-cert-open');
        const certSummaryEl = document.getElementById('cfg-theme-cert-summary');
        const certModal = document.getElementById('cfg-cert-modal');
        const certEnabledInput = document.getElementById('cfg-theme-cert-enabled');
        const certFieldsEl = document.getElementById('cfg-theme-cert-fields');
        const certTitleInput = document.getElementById('cfg-theme-cert-title');
        const certHoursInput = document.getElementById('cfg-theme-cert-hours');
        const certTopicInput = document.getElementById('cfg-theme-cert-topic-input');
        const certTopicAddBtn = document.getElementById('cfg-theme-cert-topic-add');
        const certTopicListEl = document.getElementById('cfg-theme-cert-topic-list');
        const certTopicsCount = document.getElementById('cfg-theme-cert-topics-count');

        function refreshCertSummary() {
            certSummaryEl.textContent = certConfig.enabled
                ? `Ativo — ${certConfig.hours || 10}h, ${certConfig.topics.length} tema(s)`
                : 'Emissão desativada';
            certOpenBtn.classList.toggle('is-on', certConfig.enabled);
        }

        function resetCertConfig() {
            certConfig = { enabled: false, title: '', hours: null, topics: [] };
            refreshCertSummary();
        }

        function loadCertConfig(theme) {
            certConfig = {
                enabled: !!theme?.certificateEnabled,
                title: theme?.certificateTitle || '',
                hours: theme?.certificateHours || null,
                topics: U.Certificate?.parseTopics(theme?.certificateTopics) || []
            };
            refreshCertSummary();
        }

        function syncCertFieldsVisibility() {
            certFieldsEl.classList.toggle('is-visible', certEnabledInput.checked);
        }

        function renderCertTopics() {
            certTopicsCount.textContent = String(certDraftTopics.length);
            if (certDraftTopics.length === 0) {
                certTopicListEl.innerHTML = '<div class="cert-topic-empty">Nenhum tema adicionado ainda.</div>';
                return;
            }
            certTopicListEl.innerHTML = certDraftTopics.map((topic, i) => `
                <div class="cert-topic-item">
                    <span class="cert-topic-item-num">${String(i + 1).padStart(2, '0')}</span>
                    <span class="cert-topic-item-text" title="${escapeHtml(topic)}">${escapeHtml(topic)}</span>
                    <button type="button" class="cert-topic-item-remove" data-index="${i}" title="Remover">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>`).join('');

            certTopicListEl.querySelectorAll('.cert-topic-item-remove').forEach(btn => {
                btn.addEventListener('click', () => {
                    certDraftTopics.splice(Number(btn.dataset.index), 1);
                    renderCertTopics();
                });
            });
        }

        function addCertTopic() {
            const value = certTopicInput.value.trim();
            if (!value) return;
            certDraftTopics.push(value);
            certTopicInput.value = '';
            certTopicInput.focus();
            renderCertTopics();
        }

        certOpenBtn?.addEventListener('click', () => {
            certEnabledInput.checked = certConfig.enabled;
            certTitleInput.value = certConfig.title;
            certHoursInput.value = certConfig.hours || '';
            certTopicInput.value = '';
            certDraftTopics = [...certConfig.topics];
            syncCertFieldsVisibility();
            renderCertTopics();
            certModal.style.display = 'flex';
        });
        certEnabledInput?.addEventListener('change', syncCertFieldsVisibility);
        certTopicAddBtn?.addEventListener('click', addCertTopic);
        certTopicInput?.addEventListener('keydown', (event) => {
            // Enter adiciona o tema em vez de submeter/fechar o modal.
            if (event.key === 'Enter') { event.preventDefault(); addCertTopic(); }
        });

        function closeCertModal() { certModal.style.display = 'none'; }
        document.getElementById('cfg-cert-close')?.addEventListener('click', closeCertModal);
        document.getElementById('cfg-cert-cancel')?.addEventListener('click', closeCertModal);
        // Clique fora do card não fecha o modal (evita perda acidental de edição).

        document.getElementById('cfg-cert-apply')?.addEventListener('click', () => {
            // Um tema digitado e não adicionado ainda não se perde ao aplicar.
            const pending = certTopicInput.value.trim();
            if (pending) certDraftTopics.push(pending);

            certConfig = {
                enabled: certEnabledInput.checked,
                title: certTitleInput.value.trim(),
                hours: Number(certHoursInput.value) || null,
                topics: [...certDraftTopics]
            };
            refreshCertSummary();
            closeCertModal();
        });

        function themeInitials(name) {
            const clean = (name || '').trim();
            if (!clean) return '?';
            const words = clean.split(/\s+/).filter(w => /[a-zA-ZÀ-ÿ0-9]/.test(w));
            if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
            return clean.slice(0, 2).toUpperCase();
        }

        function renderThemeImagePreview(dataUrl, infoText) {
            themeImagePreview.innerHTML = '';
            if (dataUrl) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'Prévia da imagem do curso';
                themeImagePreview.appendChild(img);
            } else {
                const span = document.createElement('span');
                span.className = 'image-initials';
                span.textContent = themeInitials(themeNameInput.value);
                themeImagePreview.appendChild(span);
            }
            themeImageInfo.textContent = infoText;
        }

        function updateDescCount() {
            themeDescCount.textContent = String(themeDescriptionInput.value.length);
        }

        // Volta o formulário de assunto ao estado "novo cadastro".
        function resetThemeForm() {
            currentThemeId = null;
            themeNameInput.value = '';
            themeDescriptionInput.value = '';
            themeImageFile.value = '';
            pendingThemeImage = null;
            updateDescCount();
            renderThemeImagePreview(null, 'Sem imagem — o card mostra as iniciais.');
            setThemeActive(true);
            resetDeadlineFields();
            resetRolesConfig();
            resetCertConfig();
            themeDeleteBtn.style.display = 'none';
            document.getElementById('cfg-theme-migrate-container').classList.remove('active');
        }

        themeDescriptionInput.addEventListener('input', updateDescCount);
        themeNameInput.addEventListener('input', () => {
            if (!themeImagePreview.querySelector('img')) {
                const span = themeImagePreview.querySelector('.image-initials');
                if (span) span.textContent = themeInitials(themeNameInput.value);
            }
        });

        themeImageFile.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            try {
                themeImageInfo.textContent = 'Processando imagem...';
                const result = await window.UniAdminImages.processFile(file);
                pendingThemeImage = { dataUrl: result.dataUrl, version: result.version };
                renderThemeImagePreview(result.dataUrl, `${window.UniAdminImages.MAX_SIZE}×${window.UniAdminImages.MAX_SIZE} • ${(result.bytes / 1024).toFixed(1)} KB • ${result.mime}`);
            } catch (error) {
                themeImageFile.value = '';
                renderThemeImagePreview(pendingThemeImage?.dataUrl || null, 'Sem imagem — o card mostra as iniciais.');
                showWarning(error.message || 'Não foi possível processar a imagem.');
            }
        });

        themeImageClear.addEventListener('click', () => {
            themeImageFile.value = '';
            pendingThemeImage = { removed: true };
            renderThemeImagePreview(null, 'A imagem será removida ao salvar.');
        });

        resetThemeForm();

        themeSubjectSelect.addEventListener('change', () => {
            resetThemeForm();
            populateModuleThemes(); populateQuizThemes(); populateThemes();
        });

        function populateThemes() {
            themesContainer.innerHTML = '';
            const subjectId = themeSubjectSelect.value;
            if (!subjectId || !data.trainingData[subjectId]) return;
            let orderedIds;
            if (data.order?.themes?.[subjectId] && data.order.themes[subjectId].length > 0) {
                orderedIds = data.order.themes[subjectId].filter(id => data.trainingData[subjectId].themes?.[id]);
            } else {
                orderedIds = validKeys(data.trainingData[subjectId].themes).sort();
            }
            orderedIds.forEach((id, index) => {
                const theme = data.trainingData[subjectId].themes[id];
                if (!theme) return;
                const card = document.createElement('div');
                card.className = 'theme-card';
                const isFirst = index === 0;
                const isLast = index === orderedIds.length - 1;
                const thumb = theme.image
                    ? `<img class="theme-card-thumb" src="${escapeHtml(theme.image)}" alt="">`
                    : `<span class="theme-card-thumb is-initials">${escapeHtml(themeInitials(theme.name))}</span>`;
                const deadlineStatus = U.Deadlines.computeDeadlineStatus(theme.deadline);
                const deadlineBadge = theme.deadline
                    ? `<span class="deadline-badge deadline-${deadlineStatus}">${U.Deadlines.STATUS_LABELS[deadlineStatus]}</span>`
                    : '';
                const roles = Array.isArray(theme.roles) ? theme.roles.filter(Boolean) : [];
                const rolesBadge = roles.length
                    ? `<span class="roles-badge" title="Visível apenas para: ${escapeHtml(roles.join(', '))}"><i class="fas fa-user-tag"></i> ${roles.length} função(ões)</span>`
                    : '';
                const statusBadge = theme.active === false
                    ? `<span class="user-status-badge">Inativo</span>`
                    : '';
                card.innerHTML = `
                    <div class="theme-card-head">
                        ${thumb}
                        <div class="theme-card-title">
                            <h3>${escapeHtml(theme.name)} ${statusBadge} ${deadlineBadge} ${rolesBadge}</h3>
                            ${theme.description ? `<p class="card-desc">${escapeHtml(theme.description)}</p>` : ''}
                        </div>
                    </div>
                    <div class="card-footer">
                        <div class="order-buttons">
                            <button class="order-btn" data-id="${id}" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                            <button class="order-btn" data-id="${id}" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="card-actions">
                            <label class="toggle-switch" title="${theme.active === false ? 'Ativar assunto' : 'Desativar assunto'}">
                                <input type="checkbox" class="toggle-theme-active" data-id="${id}" ${theme.active === false ? '' : 'checked'}>
                                <span class="toggle-slider"></span>
                            </label>
                            <button class="btn btn-ghost btn-sm edit-theme" data-id="${id}"><i class="fas fa-pencil-alt"></i> Editar</button>
                            <button class="btn btn-danger btn-sm delete-theme" data-id="${id}"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                themesContainer.appendChild(card);
            });
            themesContainer.querySelectorAll('.edit-theme').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentThemeId = btn.dataset.id;
                    const editing = data.trainingData[themeSubjectSelect.value].themes[currentThemeId];
                    themeNameInput.value = editing.name;
                    themeDescriptionInput.value = editing.description || '';
                    updateDescCount();
                    themeImageFile.value = '';
                    pendingThemeImage = null;
                    renderThemeImagePreview(
                        editing.image || null,
                        editing.image ? 'Imagem atual do curso.' : 'Sem imagem — o card mostra as iniciais.'
                    );
                    setThemeActive(editing.active !== false);
                    loadDeadlineFields(editing.deadline);
                    loadRolesConfig(editing);
                    loadCertConfig(editing);
                    themeDeleteBtn.style.display = 'flex';
                    const migrateContainer = document.getElementById('cfg-theme-migrate-container');
                    const newSubjectSelect = document.getElementById('cfg-theme-new-subject');
                    migrateContainer.classList.add('active');
                    newSubjectSelect.innerHTML = '<option value="">Selecione o novo tema</option>';
                    validKeys(data.trainingData).forEach(id => {
                        if (id !== themeSubjectSelect.value) {
                            const option = document.createElement('option');
                            option.value = id; option.textContent = data.trainingData[id].name;
                            newSubjectSelect.appendChild(option);
                        }
                    });
                });
            });
            themesContainer.querySelectorAll('.delete-theme').forEach(btn => {
                btn.addEventListener('click', () => { deleteTheme(themeSubjectSelect.value, btn.dataset.id); });
            });
            themesContainer.querySelectorAll('.toggle-theme-active').forEach(input => {
                input.addEventListener('change', () => { toggleThemeActive(themeSubjectSelect.value, input.dataset.id, input.checked); });
            });
            themesContainer.querySelectorAll('.order-btn').forEach(btn => {
                btn.addEventListener('click', async () => { await moveTheme(themeSubjectSelect.value, btn.dataset.id, btn.dataset.direction); });
            });
        }

        async function toggleThemeActive(subjectId, id, isActive) {
            const theme = data.trainingData[subjectId]?.themes[id];
            if (!theme) { showWarning('Assunto não encontrado.'); return; }
            const wasActive = theme.active !== false;
            if (isActive) delete theme.active;
            else theme.active = false;
            try {
                if (await saveData()) {
                    if (currentThemeId === id) setThemeActive(isActive);
                } else {
                    if (wasActive) delete theme.active; else theme.active = false;
                }
            } catch (error) {
                if (wasActive) delete theme.active; else theme.active = false;
                showWarning('Erro ao atualizar status do assunto. Tente novamente.');
            } finally {
                populateThemes();
            }
        }

        async function deleteTheme(subjectId, id) {
            if (!data.trainingData[subjectId]?.themes[id]) { showWarning('Assunto não encontrado.'); return; }
            if (data.trainingData[subjectId].themes[id].modules?.length > 0) { showWarning('Não é possível excluir o assunto porque ele contém módulos.'); return; }
            if (await showConfirm({
                title: 'Excluir assunto',
                message: `O assunto "${data.trainingData[subjectId].themes[id].name}" será removido.`,
                icon: 'fa-layer-group',
                details: ['As questões vinculadas a este assunto também serão apagadas.'],
                confirmText: 'Excluir'
            })) {
                showSpinner('cfg-theme-loading', true);
                try {
                    delete data.trainingData[subjectId].themes[id];
                    if (data.order?.themes?.[subjectId]) {
                        const idx = data.order.themes[subjectId].indexOf(id);
                        if (idx > -1) data.order.themes[subjectId].splice(idx, 1);
                    }
                    delete data.quizData[`${subjectId}_${id}`];
                    window.UniAdminImages?.clearCache(U.categoryPaths?.[currentCategory], subjectId, id);
                    if (await saveData()) {
                        resetThemeForm();
                        populateModuleThemes(); populateQuizThemes(); populateThemes(); showWarning('Assunto excluído com sucesso!');
                    }
                } catch (error) { showWarning('Erro ao excluir assunto. Tente novamente.'); }
                finally { showSpinner('cfg-theme-loading', false); }
            }
        }

        async function migrateTheme(oldSubjectId, themeId, newSubjectId) {
            if (!data.trainingData[oldSubjectId]?.themes[themeId]) { showWarning('Assunto não encontrado.'); return false; }
            if (!data.trainingData[newSubjectId]) { showWarning('Novo tema não encontrado.'); return false; }
            if (oldSubjectId === newSubjectId) { showWarning('O assunto já está neste tema.'); return false; }
            if (await showConfirm({
                title: 'Migrar assunto',
                message: `"${data.trainingData[oldSubjectId].themes[themeId].name}" será movido para o tema "${data.trainingData[newSubjectId].name}".`,
                icon: 'fa-arrow-right-arrow-left',
                tone: 'neutral',
                details: ['Os módulos e as avaliações acompanham o assunto.'],
                confirmText: 'Migrar'
            })) {
                showSpinner('cfg-theme-loading', true);
                try {
                    const themeData = { ...data.trainingData[oldSubjectId].themes[themeId] };
                    const newThemeId = getNextId(data.trainingData[newSubjectId].themes);
                    data.trainingData[newSubjectId].themes[newThemeId] = themeData;
                    if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
                    if (!data.order.themes[newSubjectId]) data.order.themes[newSubjectId] = [];
                    data.order.themes[newSubjectId].push(newThemeId);
                    const oldQuizKey = `${oldSubjectId}_${themeId}`;
                    const newQuizKey = `${newSubjectId}_${newThemeId}`;
                    if (data.quizData[oldQuizKey]) { data.quizData[newQuizKey] = [...data.quizData[oldQuizKey]]; delete data.quizData[oldQuizKey]; }
                    if (data.order?.modules?.[oldSubjectId]?.[themeId]) {
                        if (!data.order.modules[newSubjectId]) data.order.modules[newSubjectId] = {};
                        data.order.modules[newSubjectId][newThemeId] = [...data.order.modules[oldSubjectId][themeId]];
                        delete data.order.modules[oldSubjectId][themeId];
                    }
                    delete data.trainingData[oldSubjectId].themes[themeId];
                    if (data.order?.themes?.[oldSubjectId]) {
                        const idx = data.order.themes[oldSubjectId].indexOf(themeId);
                        if (idx > -1) data.order.themes[oldSubjectId].splice(idx, 1);
                    }
                    if (await saveData()) {
                        showWarning(`Assunto migrado com sucesso para "${data.trainingData[newSubjectId].name}"!`);
                        window.UniAdminImages?.clearCache(U.categoryPaths?.[currentCategory], oldSubjectId, themeId);
                        resetThemeForm();
                        populateSubjectSelects(); populateModuleThemes(); populateQuizThemes(); populateThemes();
                        return true;
                    }
                    return false;
                } catch (error) { showWarning(`Erro ao migrar assunto: ${error.message}`); return false; }
                finally { showSpinner('cfg-theme-loading', false); }
            }
            return false;
        }

        themeSaveBtn.addEventListener('click', async () => {
            const subjectId = themeSubjectSelect.value;
            if (!subjectId) { showWarning('Por favor, selecione um tema.'); return; }
            const name = themeNameInput.value.trim();
            if (!name) { showWarning('Por favor, insira o nome do assunto.'); return; }

            let deadline;
            try {
                deadline = buildDeadlineFromForm();
            } catch (error) {
                deadlineErrorEl.textContent = error.message;
                deadlineErrorEl.style.display = 'block';
                deadlineFields.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            showSpinner('cfg-theme-loading', true);
            const id = currentThemeId || getNextId(data.trainingData[subjectId].themes);
            const isNew = !currentThemeId;
            const previous = data.trainingData[subjectId].themes[id] || {};
            const description = themeDescriptionInput.value.trim();

            // Sem alteração pendente a imagem anterior permanece; "removed" apaga.
            let image = previous.image || null;
            let imageVersion = previous.imageVersion || null;
            if (pendingThemeImage?.removed) { image = null; imageVersion = null; }
            else if (pendingThemeImage?.dataUrl) { image = pendingThemeImage.dataUrl; imageVersion = pendingThemeImage.version; }

            data.trainingData[subjectId].themes[id] = {
                id,
                name,
                modules: previous.modules || [],
                ...(!themeActive && { active: false }),
                ...(description && { description }),
                ...(image && { image, imageVersion }),
                ...(deadline && { deadline }),
                // Sem funções escolhidas o campo nem é gravado — assunto sem
                // `roles` é visível para todos (comportamento dos já existentes).
                ...(selectedRoles.size > 0 && { roles: [...selectedRoles] }),
                ...(certConfig.enabled && {
                    certificateEnabled: true,
                    ...(certConfig.title && { certificateTitle: certConfig.title }),
                    ...(certConfig.hours && { certificateHours: certConfig.hours }),
                    ...(certConfig.topics.length > 0 && { certificateTopics: certConfig.topics })
                })
            };
            // O portal guarda a imagem por versão; sem imagem, o cache local sai de cena.
            if (!image) window.UniAdminImages?.clearCache(U.categoryPaths?.[currentCategory], subjectId, id);
            if (isNew) {
                if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
                if (!data.order.themes[subjectId]) data.order.themes[subjectId] = [];
                data.order.themes[subjectId].push(id);
            }
            try {
                if (await saveData()) {
                    resetThemeForm();
                    populateModuleThemes(); populateQuizThemes(); populateThemes(); showWarning('Assunto salvo com sucesso!');
                    // Fecha o modal "Editar/Novo Curso" — clica no X em vez de
                    // chamar ModalStack direto (vive em admin-courses.js, sem
                    // acesso daqui) para reaproveitar o mesmo fechamento
                    // (dimming/onClose) que o resto da tela já usa.
                    document.getElementById('cfg-theme-form-close')?.click();
                }
            } catch (error) { showWarning('Erro ao salvar assunto. Tente novamente.'); }
            finally { showSpinner('cfg-theme-loading', false); }
        });

        themeDeleteBtn.addEventListener('click', () => {
            const subjectId = themeSubjectSelect.value;
            if (!subjectId || !currentThemeId) { showWarning('Selecione um tema e um assunto para excluir.'); return; }
            deleteTheme(subjectId, currentThemeId);
        });

        document.getElementById('cfg-theme-migrate').addEventListener('click', async () => {
            const oldSubjectId = themeSubjectSelect.value;
            const newSubjectId = document.getElementById('cfg-theme-new-subject').value;
            if (!oldSubjectId || !newSubjectId || !currentThemeId) { showWarning('Por favor, selecione um tema e um assunto para migrar, e escolha o novo tema de destino.'); return; }
            await migrateTheme(oldSubjectId, currentThemeId, newSubjectId);
        });

        const moduleSubjectSelect = document.getElementById('cfg-module-subject');
        const moduleThemeSelect = document.getElementById('cfg-module-theme');
        const moduleTitleInput = document.getElementById('cfg-module-title');
        const moduleCaptionInput = document.getElementById('cfg-module-caption');
        const moduleVideoInput = document.getElementById('cfg-module-video');
        const modulePdfInput = document.getElementById('cfg-module-pdf');
        const moduleAttachmentsInput = document.getElementById('cfg-module-attachments');
        const moduleSaveBtn = document.getElementById('cfg-module-save');
        const moduleDeleteBtn = document.getElementById('cfg-module-delete');
        const modulesContainer = document.getElementById('cfg-modules-container');

        function populateModuleThemes() {
            const subjectId = moduleSubjectSelect.value;
            moduleThemeSelect.innerHTML = '<option value="">Selecione um assunto</option>';
            if (subjectId && data.trainingData[subjectId]) {
                validKeys(data.trainingData[subjectId].themes).forEach(id => {
                    const option = document.createElement('option');
                    option.value = id; option.textContent = data.trainingData[subjectId].themes[id].name;
                    moduleThemeSelect.appendChild(option);
                });
            }
            populateModules();
        }

        moduleSubjectSelect.addEventListener('change', populateModuleThemes);
        moduleThemeSelect.addEventListener('change', populateModules);

        function populateModules() {
            modulesContainer.innerHTML = '';
            const subjectId = moduleSubjectSelect.value;
            const themeId = moduleThemeSelect.value;
            if (!subjectId || !themeId || !data.trainingData[subjectId]?.themes?.[themeId]) return;
            const modules = data.trainingData[subjectId].themes[themeId].modules || [];
            let orderedModules;
            if (data.order?.modules?.[subjectId]?.[themeId] && data.order.modules[subjectId][themeId].length > 0) {
                const orderArray = data.order.modules[subjectId][themeId];
                orderedModules = orderArray.map(index => modules[index]).filter(m => m);
            } else {
                orderedModules = modules.filter(m => m);
            }
            orderedModules.forEach((mod, index) => {
                const card = document.createElement('div');
                card.className = 'module-card';
                const isFirst = index === 0;
                const isLast = index === orderedModules.length - 1;
                card.innerHTML = `
                    <h3>${mod.title}</h3>
                    ${mod.caption ? `<p class="card-desc">${mod.caption}</p>` : ''}
                    <div class="card-footer">
                        <div class="order-buttons">
                            <button class="order-btn" data-index="${index}" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                            <button class="order-btn" data-index="${index}" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-ghost btn-sm edit-module" data-index="${index}"><i class="fas fa-pencil-alt"></i> Editar</button>
                            <button class="btn btn-danger btn-sm delete-module" data-index="${index}"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                modulesContainer.appendChild(card);
            });
            modulesContainer.querySelectorAll('.edit-module').forEach(btn => {
                btn.addEventListener('click', () => {
                    const index = parseInt(btn.dataset.index);
                    currentModuleIndex = index;
                    const mod = orderedModules[index];
                    moduleTitleInput.value = mod.title;
                    moduleCaptionInput.value = mod.caption || '';
                    moduleVideoInput.value = mod.videoId || '';
                    modulePdfInput.value = mod.pdfUrl || '';
                    moduleAttachmentsInput.value = mod.attachments?.map(a => `${a.title};${a.url}`).join('\n') || '';
                    moduleDeleteBtn.style.display = 'flex';
                });
            });
            modulesContainer.querySelectorAll('.delete-module').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const index = parseInt(btn.dataset.index);
                    if (await showConfirm({
                        title: 'Excluir módulo',
                        message: `O módulo "${orderedModules[index].title}" será removido.`,
                        icon: 'fa-play-circle',
                        confirmText: 'Excluir'
                    })) {
                        showSpinner('cfg-module-loading', true);
                        try {
                            const actualIndex = modules.indexOf(orderedModules[index]);
                            modules.splice(actualIndex, 1);
                            if (data.order?.modules?.[subjectId]?.[themeId]) {
                                data.order.modules[subjectId][themeId] = data.order.modules[subjectId][themeId]
                                    .filter(i => i !== actualIndex).map(i => i > actualIndex ? i - 1 : i);
                            }
                            if (await saveData()) {
                                currentModuleIndex = null;
                                moduleTitleInput.value = ''; moduleCaptionInput.value = ''; moduleVideoInput.value = '';
                                modulePdfInput.value = ''; moduleAttachmentsInput.value = '';
                                moduleDeleteBtn.style.display = 'none';
                                populateModules(); showWarning('Módulo excluído com sucesso!');
                            } else { populateModules(); }
                        } catch (error) { showWarning(`Erro ao excluir módulo: ${error.message}`); populateModules(); }
                        finally { showSpinner('cfg-module-loading', false); }
                    }
                });
            });
            modulesContainer.querySelectorAll('.order-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const index = parseInt(btn.dataset.index);
                    // `index` here is the position in the displayed (ordered)
                    // list; pass it directly to moveModule which operates on
                    // the order array positions.
                    await moveModule(subjectId, themeId, index, btn.dataset.direction);
                });
            });
        }

        moduleSaveBtn.addEventListener('click', async () => {
            const subjectId = moduleSubjectSelect.value;
            const themeId = moduleThemeSelect.value;
            if (!subjectId || !themeId) { showWarning('Por favor, selecione tema e assunto.'); return; }
            const title = moduleTitleInput.value.trim();
            if (!title) { showWarning('Por favor, insira o título do módulo.'); return; }
            const attachments = moduleAttachmentsInput.value.trim().split('\n').filter(line => line).map(line => {
                const [t, url] = line.split(';');
                return { title: t?.trim(), url: url?.trim() };
            }).filter(a => a.title && a.url);
            const module = {
                title,
                ...(moduleCaptionInput.value.trim() && { caption: moduleCaptionInput.value.trim() }),
                ...(moduleVideoInput.value.trim() && { videoId: moduleVideoInput.value.trim() }),
                ...(modulePdfInput.value.trim() && { pdfUrl: modulePdfInput.value.trim() }),
                attachments: attachments.length ? attachments : []
            };
            showSpinner('cfg-module-loading', true);
            const modules = data.trainingData[subjectId].themes[themeId].modules || [];
            if (currentModuleIndex !== null) {
                modules[currentModuleIndex] = module;
            } else {
                modules.push(module);
                if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
                if (!data.order.modules[subjectId]) data.order.modules[subjectId] = {};
                if (!data.order.modules[subjectId][themeId]) data.order.modules[subjectId][themeId] = [];
                data.order.modules[subjectId][themeId].push(modules.length - 1);
            }
            data.trainingData[subjectId].themes[themeId].modules = modules;
            try {
                if (await saveData()) {
                    currentModuleIndex = null;
                    moduleTitleInput.value = ''; moduleCaptionInput.value = ''; moduleVideoInput.value = '';
                    modulePdfInput.value = ''; moduleAttachmentsInput.value = '';
                    moduleDeleteBtn.style.display = 'none';
                    populateModules(); showWarning('Módulo salvo com sucesso!');
                } else { populateModules(); }
            } catch (error) { showWarning(`Erro ao salvar módulo: ${error.message}`); populateModules(); }
            finally { showSpinner('cfg-module-loading', false); }
        });

        moduleDeleteBtn.addEventListener('click', async () => {
            const subjectId = moduleSubjectSelect.value;
            const themeId = moduleThemeSelect.value;
            if (!subjectId || !themeId || currentModuleIndex === null) { showWarning('Selecione um tema, assunto e módulo para excluir.'); return; }
            if (await showConfirm({
                title: 'Excluir módulo',
                message: `O módulo "${data.trainingData[subjectId].themes[themeId].modules[currentModuleIndex].title}" será removido.`,
                icon: 'fa-play-circle',
                confirmText: 'Excluir'
            })) {
                showSpinner('cfg-module-loading', true);
                try {
                    data.trainingData[subjectId].themes[themeId].modules.splice(currentModuleIndex, 1);
                    if (await saveData()) {
                        currentModuleIndex = null;
                        moduleTitleInput.value = ''; moduleCaptionInput.value = ''; moduleVideoInput.value = '';
                        modulePdfInput.value = ''; moduleAttachmentsInput.value = '';
                        moduleDeleteBtn.style.display = 'none';
                        populateModules(); showWarning('Módulo excluído com sucesso!');
                    } else { populateModules(); }
                } catch (error) { showWarning(`Erro ao excluir módulo: ${error.message}`); populateModules(); }
                finally { showSpinner('cfg-module-loading', false); }
            }
        });

        const quizSubjectSelect = document.getElementById('cfg-quiz-subject');
        const quizThemeSelect = document.getElementById('cfg-quiz-theme');
        const quizQuestionInput = document.getElementById('cfg-quiz-question');
        const quizOption1Input = document.getElementById('cfg-quiz-option1');
        const quizOption2Input = document.getElementById('cfg-quiz-option2');
        const quizOption3Input = document.getElementById('cfg-quiz-option3');
        const quizOption4Input = document.getElementById('cfg-quiz-option4');
        const quizCorrectSelect = document.getElementById('cfg-quiz-correct');
        const quizSaveBtn = document.getElementById('cfg-quiz-save');
        const quizDeleteBtn = document.getElementById('cfg-quiz-delete');
        const quizzesContainer = document.getElementById('cfg-quizzes-container');
        const quizToggleWrapper = document.getElementById('cfg-quiz-toggle-wrapper');
        const quizStatusToggle = document.getElementById('cfg-quiz-status-toggle');
        const quizStatusText = document.getElementById('cfg-quiz-status-text');
        const quizImageFile = document.getElementById('cfg-quiz-image-file');
        const quizImageClear = document.getElementById('cfg-quiz-image-clear');
        const quizImagePreview = document.getElementById('cfg-quiz-image-preview');
        const quizImageInfo = document.getElementById('cfg-quiz-image-info');
        const QUIZ_IMAGE_EMPTY_HINT = 'Sem imagem — a questão mostra apenas o texto.';

        // Imagem em edição no formulário; null = a questão fica sem imagem.
        let pendingQuizImage = null;

        function renderQuizImagePreview(dataUrl, infoText) {
            quizImagePreview.innerHTML = '';
            if (dataUrl) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'Prévia da imagem da questão';
                quizImagePreview.appendChild(img);
            } else {
                const span = document.createElement('span');
                span.className = 'image-initials';
                span.innerHTML = '<i class="fas fa-image"></i>';
                quizImagePreview.appendChild(span);
            }
            quizImageInfo.textContent = infoText;
        }

        function resetQuizForm() {
            currentQuizIndex = null;
            quizQuestionInput.value = ''; quizOption1Input.value = ''; quizOption2Input.value = '';
            quizOption3Input.value = ''; quizOption4Input.value = ''; quizCorrectSelect.value = '0';
            quizImageFile.value = '';
            pendingQuizImage = null;
            renderQuizImagePreview(null, QUIZ_IMAGE_EMPTY_HINT);
            quizDeleteBtn.style.display = 'none';
        }

        quizImageFile.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            try {
                quizImageInfo.textContent = 'Processando imagem...';
                const result = await window.UniAdminImages.processQuestionFile(file);
                pendingQuizImage = result.dataUrl;
                renderQuizImagePreview(result.dataUrl, `${result.width}×${result.height} • ${(result.bytes / 1024).toFixed(1)} KB • ${result.mime}`);
            } catch (error) {
                quizImageFile.value = '';
                renderQuizImagePreview(pendingQuizImage, pendingQuizImage ? 'Imagem atual mantida.' : QUIZ_IMAGE_EMPTY_HINT);
                showWarning(error.message || 'Não foi possível processar a imagem.');
            }
        });

        quizImageClear.addEventListener('click', () => {
            quizImageFile.value = '';
            pendingQuizImage = null;
            renderQuizImagePreview(null, QUIZ_IMAGE_EMPTY_HINT);
        });

        renderQuizImagePreview(null, QUIZ_IMAGE_EMPTY_HINT);

        function initializeQuizStatus() { if (!data.quizStatus) data.quizStatus = {}; }

        function updateToggleStatus() {
            if (quizStatusToggle.checked) {
                quizStatusText.textContent = 'Habilitada'; quizStatusText.classList.remove('disabled'); quizStatusText.classList.add('enabled');
            } else {
                quizStatusText.textContent = 'Desabilitada'; quizStatusText.classList.remove('enabled'); quizStatusText.classList.add('disabled');
            }
        }

        quizStatusToggle.addEventListener('change', async () => {
            const subjectId = quizSubjectSelect.value;
            const themeId = quizThemeSelect.value;
            if (!subjectId || !themeId) return;
            const quizKey = `${subjectId}_${themeId}`;
            initializeQuizStatus();
            data.quizStatus[quizKey] = quizStatusToggle.checked;
            updateToggleStatus();
            try {
                if (await saveData()) { showWarning(`Avaliação ${quizStatusToggle.checked ? 'habilitada' : 'desabilitada'}`); }
            } catch (error) { showWarning(`Erro ao salvar status: ${error.message}`); }
        });

        function populateQuizThemes() {
            const subjectId = quizSubjectSelect.value;
            quizThemeSelect.innerHTML = '<option value="">Selecione um assunto</option>';
            if (subjectId && data.trainingData[subjectId]) {
                validKeys(data.trainingData[subjectId].themes).forEach(id => {
                    const option = document.createElement('option');
                    option.value = id; option.textContent = data.trainingData[subjectId].themes[id].name;
                    quizThemeSelect.appendChild(option);
                });
            }
            populateQuizzes();
        }

        quizSubjectSelect.addEventListener('change', populateQuizThemes);
        quizThemeSelect.addEventListener('change', populateQuizzes);

        function populateQuizzes() {
            quizzesContainer.innerHTML = '';
            const subjectId = quizSubjectSelect.value;
            const themeId = quizThemeSelect.value;
            if (!subjectId || !themeId) { quizToggleWrapper.style.display = 'none'; return; }
            const quizKey = `${subjectId}_${themeId}`;
            quizToggleWrapper.style.display = 'block';
            initializeQuizStatus();
            quizStatusToggle.checked = data.quizStatus[quizKey] !== false;
            updateToggleStatus();
            if (!data.quizData[quizKey]) return;
            const quizzes = data.quizData[quizKey];
            quizzes.forEach((quiz, index) => {
                if (!quiz) return;
                const card = document.createElement('div');
                card.className = 'quiz-card';
                const isFirst = index === 0;
                const isLast = index === quizzes.length - 1;
                card.innerHTML = `
                    <h3><span class="quiz-card-number">${index + 1}.</span> ${quiz.question}</h3>
                    ${quiz.image ? `<img class="quiz-card-image" src="${quiz.image}" alt="Imagem da questão">` : ''}
                    <div class="card-footer">
                        <div class="order-buttons">
                            <button class="order-btn" data-index="${index}" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                            <button class="order-btn" data-index="${index}" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-ghost btn-sm edit-quiz" data-index="${index}"><i class="fas fa-pencil-alt"></i> Editar</button>
                            <button class="btn btn-danger btn-sm delete-quiz" data-index="${index}"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                quizzesContainer.appendChild(card);
            });
            quizzesContainer.querySelectorAll('.edit-quiz').forEach(btn => {
                btn.addEventListener('click', () => {
                    const index = parseInt(btn.dataset.index);
                    currentQuizIndex = index;
                    const quiz = data.quizData[quizKey][index];
                    quizQuestionInput.value = quiz.question;
                    quizOption1Input.value = quiz.options[0]; quizOption2Input.value = quiz.options[1];
                    quizOption3Input.value = quiz.options[2]; quizOption4Input.value = quiz.options[3];
                    quizCorrectSelect.value = quiz.correct;
                    quizImageFile.value = '';
                    pendingQuizImage = quiz.image || null;
                    renderQuizImagePreview(pendingQuizImage, pendingQuizImage ? 'Imagem atual da questão.' : QUIZ_IMAGE_EMPTY_HINT);
                    quizDeleteBtn.style.display = 'flex';
                });
            });
            quizzesContainer.querySelectorAll('.delete-quiz').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const index = parseInt(btn.dataset.index);
                    if (!data.quizData[quizKey][index]) { showWarning('Questão não encontrada.'); return; }
                    if (await showConfirm({
                        title: 'Excluir questão',
                        message: data.quizData[quizKey][index].question,
                        icon: 'fa-clipboard-list',
                        confirmText: 'Excluir'
                    })) {
                        showSpinner('cfg-quiz-loading', true);
                        try {
                            data.quizData[quizKey].splice(index, 1);
                            if (await saveData()) {
                                resetQuizForm();
                                populateQuizzes(); showWarning('Questão excluída com sucesso!');
                            } else { populateQuizzes(); }
                        } catch (error) { showWarning(`Erro ao excluir questão: ${error.message}`); populateQuizzes(); }
                        finally { showSpinner('cfg-quiz-loading', false); }
                    }
                });
            });
            quizzesContainer.querySelectorAll('.order-btn').forEach(btn => {
                btn.addEventListener('click', async () => { await moveQuiz(subjectId, themeId, parseInt(btn.dataset.index), btn.dataset.direction); });
            });
        }

        quizSaveBtn.addEventListener('click', async () => {
            const subjectId = quizSubjectSelect.value;
            const themeId = quizThemeSelect.value;
            if (!subjectId || !themeId) { showWarning('Por favor, selecione tema e assunto.'); return; }
            const question = quizQuestionInput.value.trim();
            const option1 = quizOption1Input.value.trim();
            const option2 = quizOption2Input.value.trim();
            const option3 = quizOption3Input.value.trim();
            const option4 = quizOption4Input.value.trim();
            const correct = parseInt(quizCorrectSelect.value);
            if (!question || !option1 || !option2 || !option3 || !option4) { showWarning('Por favor, preencha todos os campos da questão.'); return; }
            showSpinner('cfg-quiz-loading', true);
            const quizKey = `${subjectId}_${themeId}`;
            if (!data.quizData[quizKey]) data.quizData[quizKey] = [];
            const quiz = { question, options: [option1, option2, option3, option4], correct };
            if (pendingQuizImage) quiz.image = pendingQuizImage;
            try {
                if (currentQuizIndex !== null) { data.quizData[quizKey][currentQuizIndex] = quiz; }
                else { data.quizData[quizKey].push(quiz); }
                if (await saveData()) {
                    resetQuizForm();
                    populateQuizzes(); showWarning('Questão salva com sucesso!');
                } else { populateQuizzes(); }
            } catch (error) { showWarning(`Erro ao salvar questão: ${error.message}`); populateQuizzes(); }
            finally { showSpinner('cfg-quiz-loading', false); }
        });

        quizDeleteBtn.addEventListener('click', async () => {
            const subjectId = quizSubjectSelect.value;
            const themeId = quizThemeSelect.value;
            const quizKey = `${subjectId}_${themeId}`;
            if (!subjectId || !themeId || currentQuizIndex === null) { showWarning('Selecione um tema, assunto e questão para excluir.'); return; }
            if (!data.quizData[quizKey] || !data.quizData[quizKey][currentQuizIndex]) { showWarning('Questão não encontrada.'); return; }
            if (await showConfirm({
                title: 'Excluir questão',
                message: data.quizData[quizKey][currentQuizIndex].question,
                icon: 'fa-clipboard-list',
                confirmText: 'Excluir'
            })) {
                showSpinner('cfg-quiz-loading', true);
                try {
                    data.quizData[quizKey].splice(currentQuizIndex, 1);
                    if (data.quizData[quizKey].length === 0) delete data.quizData[quizKey];
                    if (await saveData()) {
                        resetQuizForm();
                        populateQuizzes(); showWarning('Questão excluída com sucesso!');
                    } else { populateQuizzes(); }
                } catch (error) { showWarning(`Erro ao excluir questão: ${error.message}`); populateQuizzes(); }
                finally { showSpinner('cfg-quiz-loading', false); }
            }
        });

// ─── Abertura do painel (chamada pelo portal apos validar a senha) ───
let adminInitialized = false;

function openAdminPanel() {
    const root = document.getElementById('cfg-root');
    if (!root) return;
    root.hidden = false;
    document.body.classList.add('admin-mode');
    if (!adminInitialized) {
        adminInitialized = true;
        initializeTabs();
    }
    if (currentDbPath) return;
    // Abrindo a partir de uma plataforma (?cat=), o painel já entra nela;
    // o seletor só aparece quando não dá para saber qual é.
    const fromPortal = categoryFromUrl();
    if (fromPortal) applyCategory(fromPortal);
    else showModal();
}

function closeAdminPanel() {
    const root = document.getElementById('cfg-root');
    if (root) root.hidden = true;
    document.body.classList.remove('admin-mode');
    hideModal();
    document.getElementById('cfg-backup-modal').style.display = 'none';
    // Volta a exigir a senha na próxima vez que abrirem as configurações.
    U.lock();
}

document.getElementById('cfg-back-to-portal')?.addEventListener('click', closeAdminPanel);

// Ponte usada por js/portal-auth.js para abrir o painel apos validar a senha.
window.__openAdmin = openAdminPanel;
window.__closeAdmin = closeAdminPanel;

// ─── Ponte de dados/lógica usada pela camada de apresentação da aba
// "Cursos" (js/admin-courses.js). Expõe leitura do estado e as mesmas
// funções de CRUD/ordenação já usadas pelo painel legado — a camada nova
// não duplica lógica, só monta a UI em cima disto.
window.UniAdminCoursesData = {
    getData: () => data,
    getCurrentCategory: () => currentCategory,
    // Contexto (Tema/Assunto) selecionado nos formulários de Módulo/Avaliação.
    // A camada de apresentação seta os <select> ocultos e dispara 'change'
    // antes de abrir os modais de Módulo/Avaliação; ela não chama estas
    // funções de posicionamento diretamente.
    setModuleContext(subjectId, themeId) {
        moduleSubjectSelect.value = subjectId || '';
        moduleSubjectSelect.dispatchEvent(new Event('change'));
        moduleThemeSelect.value = themeId || '';
        moduleThemeSelect.dispatchEvent(new Event('change'));
    },
    setQuizContext(subjectId, themeId) {
        quizSubjectSelect.value = subjectId || '';
        quizSubjectSelect.dispatchEvent(new Event('change'));
        quizThemeSelect.value = themeId || '';
        quizThemeSelect.dispatchEvent(new Event('change'));
    },
    resetModuleForm() {
        currentModuleIndex = null;
        moduleTitleInput.value = ''; moduleCaptionInput.value = ''; moduleVideoInput.value = '';
        modulePdfInput.value = ''; moduleAttachmentsInput.value = '';
        moduleDeleteBtn.style.display = 'none';
    },
    resetQuizForm,
    resetThemeForm,
    themeInitials,
    escapeHtml,
    moveSubject, moveTheme, moveModule, moveQuiz,
    deleteSubject, deleteTheme, toggleThemeActive,
};

})();
