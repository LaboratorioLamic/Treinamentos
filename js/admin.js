// Painel administrativo (UniAdmin).
// Vive dentro da index principal, na <section id="cfg-root">.
// A senha de acesso e validada em js/auth.js ANTES deste painel ser exibido.
(function () {

const U = window.UniAdmin;
const ref = U.ref, get = U.get, set = U.set;
const db = U.db, dbRoot = U.dbRoot, getCategoryDbPath = U.getCategoryDbPath;
const showWarning = U.showWarning, showLoadingBar = U.showLoadingBar;
const hideLoadingBar = U.hideLoadingBar, cancelLoadingBar = U.cancelLoadingBar;

let currentDbPath = null;
let currentCategory = null;
let data = { trainingData: {}, quizData: {} };
let currentSubjectId = null;
let currentThemeId = null;
let currentModuleIndex = null;
let currentQuizIndex = null;

function initializeTabs() {
    const allTabButtons = document.querySelectorAll('#cfg-root .tab-btn');
    const allTabContents = document.querySelectorAll('#cfg-root .tab-content');
    allTabButtons.forEach(btn => btn.classList.remove('active'));
    allTabContents.forEach(content => content.classList.remove('active'));
    const subjectsBtn = document.querySelector('#cfg-root .tab-btn[data-tab="subjects"]');
    const subjectsTab = document.getElementById('cfg-subjects-tab');
    if (subjectsBtn) subjectsBtn.classList.add('active');
    if (subjectsTab) subjectsTab.classList.add('active');
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

document.getElementById('cfg-category-submit').addEventListener('click', async () => {
    const category = document.getElementById('cfg-category-select').value;
    if (!category) { showWarning('Por favor, selecione uma categoria.'); return; }

    showLoadingBar();
    try {
        currentCategory = category;
        currentDbPath = getCategoryDbPath(category);
        const catBadge = document.getElementById('cfg-category-badge-display');
        const catLabel = document.getElementById('cfg-current-category-label');
        if (catBadge && catLabel) { catLabel.textContent = currentCategory; catBadge.classList.remove('inactive'); }
        hideModal();
        await fetchData();
    } catch (error) {
        cancelLoadingBar();
        throw error;
    } finally {
        hideLoadingBar();
    }
});

document.getElementById('cfg-category-select').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); document.getElementById('cfg-category-submit').click(); }
});

        document.getElementById('cfg-backup-btn').addEventListener('click', () => {
            if (!currentDbPath) { showWarning('Selecione uma categoria primeiro.'); return; }
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

        document.getElementById('cfg-upload-btn').addEventListener('click', async () => {
            const fileInput = document.getElementById('cfg-upload-file');
            if (!fileInput.files[0]) { showWarning('Selecione um arquivo JSON primeiro.'); return; }
            const confirmation = prompt('Digite "SIM" para confirmar o upload e substituição de todos os dados:');
            if (confirmation !== 'SIM') { showWarning('Upload cancelado.'); return; }
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

        document.getElementById('cfg-backup-close').addEventListener('click', () => {
            document.getElementById('cfg-backup-modal').style.display = 'none';
        });

        document.getElementById('cfg-change-category-btn').addEventListener('click', () => {
            showModal();
            document.querySelectorAll('#cfg-root .tab-content').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('#cfg-root .tab-btn').forEach(btn => btn.classList.remove('active'));
        });

        function initializeOrderFields() {
            if (!data.order) { data.order = { subjects: [], themes: {}, modules: {} }; }
            if (data.order.subjects.length === 0) { data.order.subjects = Object.keys(data.trainingData); }
            Object.keys(data.trainingData).forEach(subjectId => {
                if (!data.order.themes[subjectId]) { data.order.themes[subjectId] = Object.keys(data.trainingData[subjectId].themes || {}); }
                Object.keys(data.trainingData[subjectId].themes || {}).forEach(themeId => {
                    if (!data.order.modules[subjectId]) { data.order.modules[subjectId] = {}; }
                    if (!data.order.modules[subjectId][themeId]) {
                        const moduleCount = data.trainingData[subjectId].themes[themeId].modules?.length || 0;
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
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                const subjectsBtn = document.querySelector('#cfg-root .tab-btn[data-tab="subjects"]');
                const subjectsTab = document.getElementById('cfg-subjects-tab');
                if (subjectsBtn) subjectsBtn.classList.add('active');
                if (subjectsTab) subjectsTab.classList.add('active');
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

        async function moveModule(subjectId, themeId, index, direction) {
            if (!data.order?.modules?.[subjectId]?.[themeId]) return false;
            const newIndex = direction === 'up' ? index - 1 : index + 1;
            if (newIndex < 0 || newIndex >= data.order.modules[subjectId][themeId].length) return false;
            [data.order.modules[subjectId][themeId][index], data.order.modules[subjectId][themeId][newIndex]] = [data.order.modules[subjectId][themeId][newIndex], data.order.modules[subjectId][themeId][index]];
            const modules = data.trainingData[subjectId].themes[themeId].modules || [];
            [modules[index], modules[newIndex]] = [modules[newIndex], modules[index]];
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

        const tabButtons = document.querySelectorAll('#cfg-root .tab-btn');
        const tabContents = document.querySelectorAll('#cfg-root .tab-content');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                if (!currentDbPath) { showWarning('Selecione uma categoria antes de continuar.'); return; }
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const targetTab = document.getElementById(`cfg-${btn.dataset.tab}-tab`);
                if (targetTab) targetTab.classList.add('active');
                if (btn.dataset.tab === 'subjects') populateSubjects();
                if (btn.dataset.tab === 'themes') populateThemes();
                if (btn.dataset.tab === 'modules') populateModules();
                if (btn.dataset.tab === 'quizzes') populateQuizzes();
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
                Object.keys(data.trainingData).forEach(id => {
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
                orderedIds = Object.keys(data.trainingData).sort();
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
            if (Object.keys(data.trainingData[id].themes).length > 0) { showWarning('Não é possível excluir o tema porque ele contém assuntos.'); return; }
            if (confirm(`Tem certeza que deseja excluir o tema "${data.trainingData[id].name}"?`)) {
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
        const themeSaveBtn = document.getElementById('cfg-theme-save');
        const themeDeleteBtn = document.getElementById('cfg-theme-delete');
        const themesContainer = document.getElementById('cfg-themes-container');

        themeSubjectSelect.addEventListener('change', () => {
            currentThemeId = null; themeNameInput.value = ''; themeDeleteBtn.style.display = 'none';
            document.getElementById('cfg-theme-migrate-container').classList.remove('active');
            populateModuleThemes(); populateQuizThemes(); populateThemes();
        });

        function populateThemes() {
            themesContainer.innerHTML = '';
            const subjectId = themeSubjectSelect.value;
            if (!subjectId || !data.trainingData[subjectId]) return;
            let orderedIds;
            if (data.order?.themes?.[subjectId] && data.order.themes[subjectId].length > 0) {
                orderedIds = data.order.themes[subjectId].filter(id => data.trainingData[subjectId].themes[id]);
            } else {
                orderedIds = Object.keys(data.trainingData[subjectId].themes || {}).sort();
            }
            orderedIds.forEach((id, index) => {
                const theme = data.trainingData[subjectId].themes[id];
                const card = document.createElement('div');
                card.className = 'theme-card';
                const isFirst = index === 0;
                const isLast = index === orderedIds.length - 1;
                card.innerHTML = `
                    <h3>${theme.name}</h3>
                    <div class="card-footer">
                        <div class="order-buttons">
                            <button class="order-btn" data-id="${id}" data-direction="up" ${isFirst ? 'disabled' : ''} title="Mover para cima"><i class="fas fa-chevron-up"></i></button>
                            <button class="order-btn" data-id="${id}" data-direction="down" ${isLast ? 'disabled' : ''} title="Mover para baixo"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-ghost btn-sm edit-theme" data-id="${id}"><i class="fas fa-pencil-alt"></i> Editar</button>
                            <button class="btn btn-danger btn-sm delete-theme" data-id="${id}"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                themesContainer.appendChild(card);
            });
            themesContainer.querySelectorAll('.edit-theme').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentThemeId = btn.dataset.id;
                    themeNameInput.value = data.trainingData[themeSubjectSelect.value].themes[currentThemeId].name;
                    themeDeleteBtn.style.display = 'flex';
                    const migrateContainer = document.getElementById('cfg-theme-migrate-container');
                    const newSubjectSelect = document.getElementById('cfg-theme-new-subject');
                    migrateContainer.classList.add('active');
                    newSubjectSelect.innerHTML = '<option value="">Selecione o novo tema</option>';
                    Object.keys(data.trainingData).forEach(id => {
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
            themesContainer.querySelectorAll('.order-btn').forEach(btn => {
                btn.addEventListener('click', async () => { await moveTheme(themeSubjectSelect.value, btn.dataset.id, btn.dataset.direction); });
            });
        }

        async function deleteTheme(subjectId, id) {
            if (!data.trainingData[subjectId]?.themes[id]) { showWarning('Assunto não encontrado.'); return; }
            if (data.trainingData[subjectId].themes[id].modules?.length > 0) { showWarning('Não é possível excluir o assunto porque ele contém módulos.'); return; }
            if (confirm(`Tem certeza que deseja excluir o assunto "${data.trainingData[subjectId].themes[id].name}"?`)) {
                showSpinner('cfg-theme-loading', true);
                try {
                    delete data.trainingData[subjectId].themes[id];
                    if (data.order?.themes?.[subjectId]) {
                        const idx = data.order.themes[subjectId].indexOf(id);
                        if (idx > -1) data.order.themes[subjectId].splice(idx, 1);
                    }
                    delete data.quizData[`${subjectId}_${id}`];
                    if (await saveData()) {
                        currentThemeId = null; themeNameInput.value = ''; themeDeleteBtn.style.display = 'none';
                        document.getElementById('cfg-theme-migrate-container').classList.remove('active');
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
            if (confirm(`Tem certeza que deseja migrar o assunto "${data.trainingData[oldSubjectId].themes[themeId].name}" e todos os seus módulos e avaliações para o tema "${data.trainingData[newSubjectId].name}"?`)) {
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
                        currentThemeId = null; themeNameInput.value = ''; themeDeleteBtn.style.display = 'none';
                        document.getElementById('cfg-theme-migrate-container').classList.remove('active');
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
            showSpinner('cfg-theme-loading', true);
            const id = currentThemeId || getNextId(data.trainingData[subjectId].themes);
            const isNew = !currentThemeId;
            data.trainingData[subjectId].themes[id] = { id, name, modules: data.trainingData[subjectId].themes[id]?.modules || [] };
            if (isNew) {
                if (!data.order) data.order = { subjects: [], themes: {}, modules: {} };
                if (!data.order.themes[subjectId]) data.order.themes[subjectId] = [];
                data.order.themes[subjectId].push(id);
            }
            try {
                if (await saveData()) {
                    currentThemeId = null; themeNameInput.value = ''; themeDeleteBtn.style.display = 'none';
                    document.getElementById('cfg-theme-migrate-container').classList.remove('active');
                    populateModuleThemes(); populateQuizThemes(); populateThemes(); showWarning('Assunto salvo com sucesso!');
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
                Object.keys(data.trainingData[subjectId].themes).forEach(id => {
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
            if (!subjectId || !themeId || !data.trainingData[subjectId]?.themes[themeId]) return;
            const modules = data.trainingData[subjectId].themes[themeId].modules || [];
            let orderedModules;
            if (data.order?.modules?.[subjectId]?.[themeId] && data.order.modules[subjectId][themeId].length > 0) {
                const orderArray = data.order.modules[subjectId][themeId];
                orderedModules = orderArray.map(index => modules[index]).filter(m => m);
            } else {
                orderedModules = modules;
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
                    if (confirm(`Tem certeza que deseja excluir o módulo "${orderedModules[index].title}"?`)) {
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
                    const actualIndex = modules.indexOf(orderedModules[index]);
                    await moveModule(subjectId, themeId, actualIndex, btn.dataset.direction);
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
            if (confirm(`Tem certeza que deseja excluir o módulo "${data.trainingData[subjectId].themes[themeId].modules[currentModuleIndex].title}"?`)) {
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
                Object.keys(data.trainingData[subjectId].themes).forEach(id => {
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
                const card = document.createElement('div');
                card.className = 'quiz-card';
                const isFirst = index === 0;
                const isLast = index === quizzes.length - 1;
                card.innerHTML = `
                    <h3>${quiz.question}</h3>
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
                    quizDeleteBtn.style.display = 'flex';
                });
            });
            quizzesContainer.querySelectorAll('.delete-quiz').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const index = parseInt(btn.dataset.index);
                    if (!data.quizData[quizKey][index]) { showWarning('Questão não encontrada.'); return; }
                    if (confirm(`Tem certeza que deseja excluir a questão "${data.quizData[quizKey][index].question}"?`)) {
                        showSpinner('cfg-quiz-loading', true);
                        try {
                            data.quizData[quizKey].splice(index, 1);
                            if (await saveData()) {
                                currentQuizIndex = null;
                                quizQuestionInput.value = ''; quizOption1Input.value = ''; quizOption2Input.value = '';
                                quizOption3Input.value = ''; quizOption4Input.value = ''; quizCorrectSelect.value = '0';
                                quizDeleteBtn.style.display = 'none';
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
            try {
                if (currentQuizIndex !== null) { data.quizData[quizKey][currentQuizIndex] = quiz; }
                else { data.quizData[quizKey].push(quiz); }
                if (await saveData()) {
                    currentQuizIndex = null;
                    quizQuestionInput.value = ''; quizOption1Input.value = ''; quizOption2Input.value = '';
                    quizOption3Input.value = ''; quizOption4Input.value = ''; quizCorrectSelect.value = '0';
                    quizDeleteBtn.style.display = 'none';
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
            if (confirm(`Tem certeza que deseja excluir a questão "${data.quizData[quizKey][currentQuizIndex].question}"?`)) {
                showSpinner('cfg-quiz-loading', true);
                try {
                    data.quizData[quizKey].splice(currentQuizIndex, 1);
                    if (data.quizData[quizKey].length === 0) delete data.quizData[quizKey];
                    if (await saveData()) {
                        currentQuizIndex = null;
                        quizQuestionInput.value = ''; quizOption1Input.value = ''; quizOption2Input.value = '';
                        quizOption3Input.value = ''; quizOption4Input.value = ''; quizCorrectSelect.value = '0';
                        quizDeleteBtn.style.display = 'none';
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
    // Sem categoria escolhida ainda: pede a categoria.
    if (!currentDbPath) showModal();
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

})();
