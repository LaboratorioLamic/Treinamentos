// Liga o ícone de configurações do portal ao painel admin.
// Pede a senha (ou o primeiro cadastro) antes de revelar o painel.
(function () {

const U = window.UniAdmin;
const hasPassword = U.hasPassword, verifyPassword = U.verifyPassword;
const createFirstPassword = U.createFirstPassword, isUnlocked = U.isUnlocked;
const MIN_PASSWORD_LENGTH = U.MIN_PASSWORD_LENGTH;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10000;

const modal = document.getElementById('auth-modal');
const card = document.getElementById('auth-card');
const closeBtn = document.getElementById('auth-close');
const submitBtn = document.getElementById('auth-submit');
const submitText = document.getElementById('auth-submit-text');
const titleText = document.getElementById('auth-title-text');
const intro = document.getElementById('auth-intro');
const errorBox = document.getElementById('auth-error');
const lockoutBox = document.getElementById('auth-lockout');
const progressWrap = document.getElementById('auth-progress-container');
const progressBar = document.getElementById('auth-progress');
const passwordInput = document.getElementById('auth-password');
const passwordLabel = document.getElementById('auth-password-label');
const confirmWrapper = document.getElementById('auth-confirm-wrapper');
const confirmInput = document.getElementById('auth-confirm');
const settingsBtn = document.getElementById('settings-btn');

let isFirstSetup = false;
let attempts = 0;
let isLocked = false;

function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('active');
    card.classList.add('error');
    setTimeout(() => card.classList.remove('error'), 400);
}

function clearError() {
    errorBox.textContent = '';
    errorBox.classList.remove('active');
}

function startLockout() {
    isLocked = true;
    attempts = 0;
    submitBtn.disabled = true;
    lockoutBox.classList.add('active');
    progressWrap.classList.add('active');
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
    requestAnimationFrame(() => {
        progressBar.style.transition = `width ${LOCKOUT_MS}ms linear`;
        progressBar.style.width = '100%';
    });
    setTimeout(() => {
        isLocked = false;
        submitBtn.disabled = false;
        lockoutBox.classList.remove('active');
        progressWrap.classList.remove('active');
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
    }, LOCKOUT_MS);
}

function applyMode(firstSetup) {
    isFirstSetup = firstSetup;
    if (firstSetup) {
        titleText.textContent = 'Criar Senha de Acesso';
        intro.textContent = 'Nenhuma senha foi cadastrada ainda. Defina a senha que protegerá o painel de configurações.';
        passwordLabel.textContent = 'Nova senha';
        passwordInput.placeholder = `Mínimo de ${MIN_PASSWORD_LENGTH} caracteres`;
        passwordInput.autocomplete = 'new-password';
        confirmWrapper.style.display = 'block';
        submitText.textContent = 'Criar senha';
    } else {
        titleText.textContent = 'Acessar Configurações';
        intro.textContent = 'Digite a senha para abrir o painel de configurações.';
        passwordLabel.textContent = 'Senha';
        passwordInput.placeholder = 'Digite a senha';
        passwordInput.autocomplete = 'current-password';
        confirmWrapper.style.display = 'none';
        submitText.textContent = 'Entrar';
    }
}

function openPanel() {
    closeModal();
    window.__openAdmin?.();
}

function closeModal() {
    modal.classList.remove('active');
    passwordInput.value = '';
    confirmInput.value = '';
    clearError();
}

async function openAuthModal() {
    // Já autenticado nesta sessão: abre direto.
    if (isUnlocked()) { openPanel(); return; }

    // Gestores (isManager na conta) acessam as configurações sem senha.
    const session = U.StudentAuth?.getSession?.();
    if (session?.isManager) { U.unlock(); openPanel(); return; }

    clearError();
    passwordInput.value = '';
    confirmInput.value = '';
    submitBtn.disabled = true;
    modal.classList.add('active');
    intro.textContent = 'Verificando...';

    try {
        const exists = await hasPassword();
        applyMode(!exists);
    } catch (error) {
        console.error('Erro ao consultar a senha:', error);
        applyMode(false);
        showError('Não foi possível consultar o banco de dados. Tente novamente.');
    } finally {
        submitBtn.disabled = isLocked;
        passwordInput.focus();
    }
}

async function handleSubmit() {
    if (isLocked) return;
    clearError();
    const password = passwordInput.value;

    if (!password) { showError('Digite a senha.'); return; }

    submitBtn.disabled = true;
    try {
        if (isFirstSetup) {
            await createFirstPassword(password, confirmInput.value);
            openPanel();
            return;
        }

        const valid = await verifyPassword(password);
        if (valid) { openPanel(); return; }

        attempts++;
        passwordInput.value = '';
        if (attempts >= MAX_ATTEMPTS) { startLockout(); showError('Muitas tentativas incorretas.'); }
        else { showError('Senha incorreta.'); }
    } catch (error) {
        showError(error.message || 'Erro ao validar a senha.');
    } finally {
        submitBtn.disabled = isLocked;
    }
}

settingsBtn?.addEventListener('click', openAuthModal);
closeBtn?.addEventListener('click', closeModal);
submitBtn?.addEventListener('click', handleSubmit);

modal?.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.classList.contains('active')) closeModal();
});

for (const input of [passwordInput, confirmInput]) {
    input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); handleSubmit(); }
    });
}

// Compatibilidade com links antigos que apontavam para /config/
if (location.hash === '#config') {
    window.addEventListener('load', openAuthModal);
}

})();
