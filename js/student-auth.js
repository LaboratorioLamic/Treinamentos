// Cadastro e login de aluno.
// Conta própria no Realtime Database (sem Firebase Auth): senha com o mesmo
// padrão SHA-256+salt de js/auth.js (ver js/crypto-utils.js), sessão guardada
// em localStorage (diferente do admin, que é só em memória de propósito —
// aqui o aluno precisa continuar logado entre visitas).
//
// Nome de cadastro só pode vir da lista de colaboradores sincronizada da
// planilha do Google Sheets (js/colaboradores-sync.js). Sem regras de
// segurança no console do Firebase (decisão do projeto), a garantia de
// "um nome, uma conta" é feita inteiramente no código via transaction()
// no nó do colaborador — ver registerStudent() abaixo.
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, set = U.set, db = U.db, dbRoot = U.dbRoot;
    const { randomSalt, hashWithSalt } = U.crypto;
    const normalizeName = U.normalizeName; // js/crypto-utils.js

    const USERS_PATH = `/${dbRoot}/users`;
    const COLABS_PATH = `/${dbRoot}/colaboradores`;
    const SESSION_KEY = 'uniadmin.studentSession';

    U.MIN_PASSWORD_LENGTH = U.MIN_PASSWORD_LENGTH || 6;

    // ─── Sessão (localStorage) ───
    function getSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (error) { return null; }
    }

    function setSession(session) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    function clearSession() {
        localStorage.removeItem(SESSION_KEY);
    }

    // A sessão guarda uma cópia de setor/função para o portal poder filtrar os
    // cursos por função sem uma leitura extra a cada render. A fonte continua
    // sendo a conta (mantida em dia pelo sync de Colaboradores), então esta
    // cópia é revalidada a cada carregamento da página — ver refreshSession().
    function updateSession(patch) {
        const session = getSession();
        if (!session) return null;
        const merged = { ...session, ...patch };
        setSession(merged);
        return merged;
    }

    // Relê a conta e atualiza a sessão local. Dispara `uniadmin:session-updated`
    // quando algo muda, para quem já renderizou (galeria de cursos) reagir.
    async function refreshSession() {
        const session = getSession();
        if (!session?.userId) return null;
        try {
            const snapshot = await get(ref(db, `${USERS_PATH}/${session.userId}`));
            if (!snapshot.exists()) return session;
            const user = snapshot.val();
            const changed = (session.role || null) !== (user.role || null)
                || (session.unit || null) !== (user.unit || null)
                || (session.isManager || false) !== (user.isManager || false)
                || session.fullName !== user.fullName;
            const merged = updateSession({
                fullName: user.fullName || session.fullName,
                unit: user.unit || null,
                role: user.role || null,
                isManager: !!user.isManager
            });
            if (changed) document.dispatchEvent(new CustomEvent('uniadmin:session-updated'));
            return merged;
        } catch (error) {
            return session; // offline: segue com o que já está guardado
        }
    }

    U.StudentAuth = { getSession, clearSession, refreshSession };

    // ─── Progressão do curso (% de módulos assistidos) ───
    // Gravada por js/main.js em uniadmin/progress/byUser/{userId}/{slug}/{subjectId}/{themeId}
    // (irmã de results/byUser e results/byCourse). Lida aqui para o Perfil do
    // aluno (js/student-profile.js) e para Configurações > Usuários
    // (js/admin-users.js) mostrarem o mesmo dado sem duplicar a leitura.
    const PROGRESS_PATH = `/${dbRoot}/progress/byUser`;

    async function getCourseProgressForUser(userId) {
        if (!userId) return [];
        try {
            const snapshot = await get(ref(db, `${PROGRESS_PATH}/${userId}`));
            if (!snapshot.exists()) return [];
            const bySlug = snapshot.val() || {};
            const rows = [];
            Object.keys(bySlug).forEach(slug => {
                Object.keys(bySlug[slug] || {}).forEach(subjectId => {
                    Object.keys(bySlug[slug][subjectId] || {}).forEach(themeId => {
                        const entry = bySlug[slug][subjectId][themeId] || {};
                        rows.push({
                            slug, subjectId, themeId,
                            total: entry.total || 0,
                            done: entry.done || 0,
                            pct: entry.pct || 0,
                            approved: entry.approved ?? null,
                            updatedAt: entry.updatedAt || null
                        });
                    });
                });
            });
            return rows;
        } catch (error) {
            console.error('Erro ao carregar progressão de cursos:', error);
            return [];
        }
    }
    U.StudentAuth.getCourseProgressForUser = getCourseProgressForUser;

    // ─── Dados de colaboradores ───
    // Sincronização com a planilha do Google Sheets (fonte oficial e
    // permanente) vive em js/colaboradores-sync.js, compartilhada com o
    // painel admin.
    const { fetchColaboradores, syncFromSheets } = U.ColaboradoresSync;

    async function fetchAvailableColaboradores() {
        // Garante a lista atualizada mesmo se o admin nunca abriu Configurações.
        await syncFromSheets({ silent: true });
        const colabs = await fetchColaboradores();
        return Object.keys(colabs)
            .filter(id => colabs[id] && colabs[id].active !== false && !colabs[id].accountUserId)
            .map(id => ({ id, ...colabs[id] }))
            .sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'));
    }

    // Login é o identificador único de conta (chave real de autenticação).
    // Formato forçado tanto no input (ver USERNAME_PATTERN abaixo) quanto
    // aqui, para nunca gravar algo fora do padrão mesmo se chamado de outro
    // lugar no futuro.
    const USERNAME_RULE = /^[a-z0-9]+$/;

    function sanitizeUsername(raw) {
        return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    async function findUserByUsername(username) {
        const snapshot = await get(ref(db, USERS_PATH));
        const users = snapshot.exists() ? snapshot.val() : {};
        for (const userId of Object.keys(users)) {
            if (users[userId] && users[userId].username === username) {
                return { userId, ...users[userId] };
            }
        }
        return null;
    }

    // ─── Cadastro ───
    // Sem regra de banco travando accountUserId (decisão do projeto: tudo
    // fica no código, nada no console do Firebase), a garantia anti-duplicidade
    // de NOME é feita com uma transação atômica no nó do colaborador: só
    // commita se o valor lido no momento da transação ainda for null. O SDK
    // do Realtime Database resolve isso no servidor (re-executa a função se
    // outro cliente escreveu no meio tempo), cobrindo corrida entre duas
    // abas/pessoas cadastrando o mesmo nome ao mesmo tempo. A duplicidade de
    // LOGIN é checada antes (findUserByUsername) — é a chave de autenticação,
    // então uma corrida rara nela só resultaria em erro de login ambíguo,
    // não em dado corrompido; não precisa do mesmo nível de transação.
    async function registerStudent({ colabId, fullName, username, password, confirmation }) {
        if (!colabId || !fullName) throw new Error('Selecione seu nome na lista.');
        const cleanUsername = sanitizeUsername(username);
        if (!cleanUsername || !USERNAME_RULE.test(cleanUsername)) {
            throw new Error('O login deve conter apenas letras minúsculas e números, sem espaços.');
        }
        if (!password || password.length < U.MIN_PASSWORD_LENGTH) {
            throw new Error(`A senha deve ter ao menos ${U.MIN_PASSWORD_LENGTH} caracteres.`);
        }
        if (password !== confirmation) throw new Error('As senhas não conferem.');

        const existingLogin = await findUserByUsername(cleanUsername);
        if (existingLogin) throw new Error('Este login já está em uso. Escolha outro.');

        const fullNameKey = normalizeName(fullName);
        const salt = randomSalt();
        const passwordHash = await hashWithSalt(password, salt);
        const userId = ref(db, USERS_PATH).push().key;

        // transaction() só efetiva a escrita se o valor lido bater com o que
        // a callback recebeu — reexecutada automaticamente pelo SDK em caso
        // de conflito, então é seguro contra dois cadastros simultâneos.
        const colabRef = ref(db, `${COLABS_PATH}/${colabId}`);
        const txResult = await colabRef.transaction(current => {
            if (!current) return current; // colaborador sumiu/foi removido
            if (current.accountUserId) return; // já tem conta: aborta a transação
            current.accountUserId = userId;
            return current;
        });

        if (!txResult.committed || !txResult.snapshot.exists()) {
            throw new Error('Este nome já possui conta associada. Atualize a lista e tente novamente.');
        }

        // Unidade/cargo vêm do colaborador (sincronizados da planilha) e são
        // copiados para a conta no momento do cadastro — usados no Histórico
        // (Configurações) sem precisar de join a cada consulta.
        const colabData = txResult.snapshot.val() || {};
        const userRecord = {
            fullName,
            fullNameKey,
            username: cleanUsername,
            passwordHash,
            passwordSalt: salt,
            colaboradorId: colabId,
            unit: colabData.unit || null,
            role: colabData.role || null,
            disabled: false,
            createdAt: Date.now()
        };

        try {
            await set(ref(db, `${USERS_PATH}/${userId}`), userRecord);
        } catch (error) {
            // Reverte a trava do colaborador se a gravação da conta falhar,
            // para não deixar o nome preso sem conta de fato criada.
            await colabRef.update({ accountUserId: null }).catch(() => {});
            throw new Error('Erro ao criar a conta. Tente novamente.');
        }

        setSession({
            userId, fullName, username: cleanUsername,
            unit: userRecord.unit, role: userRecord.role,
            loggedInAt: Date.now()
        });
        document.dispatchEvent(new CustomEvent('uniadmin:session-updated'));
        return { userId, fullName, username: cleanUsername };
    }

    // ─── Login ───
    async function loginStudent({ username, password }) {
        const cleanUsername = sanitizeUsername(username);
        if (!cleanUsername || !password) throw new Error('Preencha login e senha.');
        const user = await findUserByUsername(cleanUsername);
        if (!user) throw new Error('Login não encontrado.');
        if (user.disabled) throw new Error('Esta conta foi desativada. Fale com o administrador.');

        const candidate = await hashWithSalt(password, user.passwordSalt);
        if (candidate !== user.passwordHash) throw new Error('Senha incorreta.');

        setSession({
            userId: user.userId, fullName: user.fullName, username: user.username,
            unit: user.unit || null, role: user.role || null, isManager: !!user.isManager,
            loggedInAt: Date.now()
        });
        document.dispatchEvent(new CustomEvent('uniadmin:session-updated'));
        return { userId: user.userId, fullName: user.fullName, username: user.username };
    }

    function logoutStudent() {
        clearSession();
        document.dispatchEvent(new CustomEvent('uniadmin:session-updated'));
    }
    U.StudentAuth.logout = logoutStudent;

    // ─── Troca de senha (o próprio aluno, a partir do perfil) ───
    // Exige a senha atual antes de trocar — mesma verificação do login,
    // para não deixar quem pega uma sessão aberta trocar a senha sem provar
    // que conhece a atual.
    async function changePassword({ currentPassword, newPassword, confirmation }) {
        const session = getSession();
        if (!session) throw new Error('Sessão expirada. Faça login novamente.');
        if (!currentPassword) throw new Error('Informe sua senha atual.');
        if (!newPassword || newPassword.length < U.MIN_PASSWORD_LENGTH) {
            throw new Error(`A nova senha deve ter ao menos ${U.MIN_PASSWORD_LENGTH} caracteres.`);
        }
        if (newPassword !== confirmation) throw new Error('As senhas não conferem.');

        const snapshot = await get(ref(db, `${USERS_PATH}/${session.userId}`));
        const user = snapshot.exists() ? snapshot.val() : null;
        if (!user) throw new Error('Conta não encontrada.');

        const candidate = await hashWithSalt(currentPassword, user.passwordSalt);
        if (candidate !== user.passwordHash) throw new Error('Senha atual incorreta.');

        const salt = randomSalt();
        const passwordHash = await hashWithSalt(newPassword, salt);
        await ref(db, `${USERS_PATH}/${session.userId}`).update({ passwordHash, passwordSalt: salt });
    }
    U.StudentAuth.changePassword = changePassword;

    // ─── UI: modal de cadastro/login ───
    const modal = document.getElementById('student-auth-modal');
    if (!modal) { window.UniAdmin = U; return; } // portal.html ainda sem o modal (fase intermediária)

    const closeBtn = document.getElementById('student-auth-close');
    const tabLoginBtn = document.getElementById('student-auth-tab-login');
    const tabRegisterBtn = document.getElementById('student-auth-tab-register');
    const loginPanel = document.getElementById('student-auth-login-panel');
    const registerPanel = document.getElementById('student-auth-register-panel');
    const errorBox = document.getElementById('student-auth-error');

    // Login
    const loginUsernameInput = document.getElementById('student-login-username');
    const loginPasswordInput = document.getElementById('student-login-password');
    const loginSubmitBtn = document.getElementById('student-login-submit');

    // Cadastro
    const registerNameInput = document.getElementById('student-register-name');
    const registerNamePopover = document.getElementById('student-register-name-popover');
    const registerUsernameInput = document.getElementById('student-register-username');
    const registerPasswordInput = document.getElementById('student-register-password');
    const registerConfirmInput = document.getElementById('student-register-confirm');
    const registerSubmitBtn = document.getElementById('student-register-submit');

    // Força o formato do login em tempo real (minúsculas, sem espaço/especiais)
    // nos dois campos — o aluno digita livre, mas nunca vê caracteres inválidos.
    function forceUsernameFormat(input) {
        input?.addEventListener('input', () => {
            const formatted = sanitizeUsername(input.value);
            if (formatted !== input.value) {
                const pos = input.selectionStart - (input.value.length - formatted.length);
                input.value = formatted;
                input.setSelectionRange(pos, pos);
            }
        });
    }
    forceUsernameFormat(loginUsernameInput);
    forceUsernameFormat(registerUsernameInput);

    let onSuccessCallback = null;
    let selectedColabId = null;
    let availableColabs = [];

    function showError(message) {
        errorBox.textContent = message;
        errorBox.classList.add('active');
    }
    function clearError() {
        errorBox.textContent = '';
        errorBox.classList.remove('active');
    }

    function switchTab(tab) {
        clearError();
        const isLogin = tab === 'login';
        tabLoginBtn.classList.toggle('active', isLogin);
        tabRegisterBtn.classList.toggle('active', !isLogin);
        loginPanel.style.display = isLogin ? 'block' : 'none';
        registerPanel.style.display = isLogin ? 'none' : 'block';
        if (!isLogin) loadAvailableNames();
    }

    async function loadAvailableNames() {
        try {
            availableColabs = await fetchAvailableColaboradores();
        } catch (error) {
            availableColabs = [];
        }
    }

    function renderNamePopover(term) {
        const query = normalizeName(term);
        const matches = query
            ? availableColabs.filter(c => normalizeName(c.fullName).includes(query))
            : availableColabs;
        registerNamePopover.innerHTML = '';
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'student-name-popover-empty';
            empty.textContent = query
                ? 'Nenhum nome encontrado. Fale com o administrador se seu nome não aparece.'
                : 'Nenhum nome disponível para cadastro.';
            registerNamePopover.appendChild(empty);
        } else {
            matches.slice(0, 30).forEach(colab => {
                const item = document.createElement('div');
                item.className = 'student-name-popover-item';
                item.textContent = colab.fullName;
                item.onclick = () => {
                    registerNameInput.value = colab.fullName;
                    selectedColabId = colab.id;
                    registerNamePopover.classList.remove('active');
                };
                registerNamePopover.appendChild(item);
            });
        }
        registerNamePopover.classList.add('active');
    }

    registerNameInput?.addEventListener('input', () => {
        selectedColabId = null; // qualquer edição invalida a seleção anterior
        renderNamePopover(registerNameInput.value);
    });
    registerNameInput?.addEventListener('focus', () => renderNamePopover(registerNameInput.value));
    document.addEventListener('click', (event) => {
        if (registerNamePopover && !registerNamePopover.contains(event.target) && event.target !== registerNameInput) {
            registerNamePopover.classList.remove('active');
        }
    });

    async function handleLogin() {
        clearError();
        loginSubmitBtn.disabled = true;
        try {
            const result = await loginStudent({
                username: loginUsernameInput.value.trim(),
                password: loginPasswordInput.value
            });
            closeModal();
            if (onSuccessCallback) onSuccessCallback(result);
        } catch (error) {
            showError(error.message || 'Erro ao entrar.');
        } finally {
            loginSubmitBtn.disabled = false;
        }
    }

    async function handleRegister() {
        clearError();
        if (!selectedColabId) {
            showError('Selecione seu nome completo na lista sugerida.');
            return;
        }
        registerSubmitBtn.disabled = true;
        try {
            const result = await registerStudent({
                colabId: selectedColabId,
                fullName: registerNameInput.value.trim(),
                username: registerUsernameInput.value.trim(),
                password: registerPasswordInput.value,
                confirmation: registerConfirmInput.value
            });
            closeModal();
            if (onSuccessCallback) onSuccessCallback(result);
        } catch (error) {
            showError(error.message || 'Erro ao cadastrar.');
        } finally {
            registerSubmitBtn.disabled = false;
        }
    }

    function closeModal() {
        modal.classList.remove('active');
        loginPasswordInput.value = '';
        registerPasswordInput.value = '';
        registerConfirmInput.value = '';
        clearError();
    }

    function openModal({ intent, onSuccess, tab } = {}) {
        onSuccessCallback = onSuccess || null;
        selectedColabId = null;
        clearError();
        modal.classList.add('active');
        switchTab(tab || 'login');
    }
    U.StudentAuth.openModal = openModal;

    closeBtn?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('active')) closeModal();
    });
    tabLoginBtn?.addEventListener('click', () => switchTab('login'));
    tabRegisterBtn?.addEventListener('click', () => switchTab('register'));
    loginSubmitBtn?.addEventListener('click', handleLogin);
    registerSubmitBtn?.addEventListener('click', handleRegister);

    for (const input of [loginUsernameInput, loginPasswordInput]) {
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); handleLogin(); }
        });
    }
    for (const input of [registerUsernameInput, registerPasswordInput, registerConfirmInput]) {
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); handleRegister(); }
        });
    }

    // Revalida setor/função da sessão a cada carregamento: se o cargo mudou na
    // planilha, a galeria de cursos por função reflete isso sem novo login.
    refreshSession();

    window.UniAdmin = U;
})();
