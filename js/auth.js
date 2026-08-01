// Autenticação do painel de configurações.
// A senha vive no banco (/uniadmin/auth), nunca no código.
// Guardada como SHA-256 + salt; senhas antigas em texto puro migram no primeiro login válido.
(function () {
    const U = window.UniAdmin;
    const AUTH_PATH = `/${U.dbRoot}/auth`;
    const LEGACY_PATH = `/${U.dbRoot}/password`;
    // Destravamento só em memória, de propósito: recarregar a página exige a senha
    // de novo. Não use sessionStorage/localStorage aqui — eles sobrevivem ao F5.
    let unlocked = false;

    U.MIN_PASSWORD_LENGTH = 6;

    function toHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    async function sha256(text) {
        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return toHex(digest);
    }

    function randomSalt() {
        return toHex(crypto.getRandomValues(new Uint8Array(16)));
    }

    async function hashWithSalt(password, salt) {
        return sha256(`${salt}:${password}`);
    }

    async function readAuth() {
        const snapshot = await U.get(U.ref(AUTH_PATH));
        return snapshot.exists() ? snapshot.val() : null;
    }

    async function readLegacyPassword() {
        const snapshot = await U.get(U.ref(LEGACY_PATH));
        return snapshot.exists() ? snapshot.val() : null;
    }

    async function storePassword(password) {
        const salt = randomSalt();
        const hash = await hashWithSalt(password, salt);
        await U.set(U.ref(AUTH_PATH), { hash, salt, algo: 'SHA-256', createdAt: Date.now() });
    }

    /** Já existe alguma senha definida (nova ou legada)? */
    U.hasPassword = async function () {
        if (await readAuth()) return true;
        return (await readLegacyPassword()) !== null;
    };

    /** Primeiro cadastro. Lança Error com mensagem pronta para exibição. */
    U.createFirstPassword = async function (password, confirmation) {
        if (!password || password.length < U.MIN_PASSWORD_LENGTH) {
            throw new Error(`A senha deve ter ao menos ${U.MIN_PASSWORD_LENGTH} caracteres.`);
        }
        if (password !== confirmation) {
            throw new Error('As senhas não conferem.');
        }
        if (await U.hasPassword()) {
            throw new Error('Já existe uma senha cadastrada.');
        }
        await storePassword(password);
        U.unlock();
    };

    /** Valida a senha. Migra do formato antigo (texto puro) quando necessário. */
    U.verifyPassword = async function (password) {
        if (!password) return false;

        const auth = await readAuth();
        if (auth && auth.hash && auth.salt) {
            const candidate = await hashWithSalt(password, auth.salt);
            if (candidate !== auth.hash) return false;
            U.unlock();
            return true;
        }

        // Migração: senha antiga em texto puro.
        const legacy = await readLegacyPassword();
        if (legacy !== null && legacy === password) {
            await storePassword(password);
            await U.remove(U.ref(LEGACY_PATH));
            U.unlock();
            return true;
        }

        return false;
    };

    U.isUnlocked = function () { return unlocked; };
    U.unlock = function () { unlocked = true; };
    U.lock = function () { unlocked = false; };
})();
