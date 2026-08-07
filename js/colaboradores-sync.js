// Sincroniza /uniadmin/colaboradores com a planilha do Google Sheets (fonte
// oficial e permanente da lista de nomes, mantida pela empresa via Apps
// Script). Roda automaticamente sempre que o admin abre Configurações >
// Colaboradores e sempre que o modal de cadastro de aluno é aberto —
// não depende de import manual, mas o import por texto continua disponível
// em Configurações como via alternativa.
(function () {
    const U = window.UniAdmin;
    const ref = U.ref, get = U.get, db = U.db, dbRoot = U.dbRoot;
    const normalizeName = U.normalizeName;

    const COLABS_PATH = `/${dbRoot}/colaboradores`;
    const USERS_PATH = `/${dbRoot}/users`;
    // Fonte oficial e permanente da lista de nomes. Usada aqui para alimentar
    // /uniadmin/colaboradores e também por js/main.js (fetchNames) para o
    // combobox de nome livre de Estágios — URL única, exposta em
    // U.ColaboradoresSync.SHEETS_NAMES_URL para não duplicar em dois arquivos.
    const SHEETS_NAMES_URL = 'https://script.google.com/macros/s/AKfycbypmrnlH1VvsfZPGzVwvcX9ljBvmExX9UhvsCRtgwO_d9HojB_TwLbLKetS5acoF0qS7A/exec';

    async function fetchColaboradores() {
        const snapshot = await get(ref(db, COLABS_PATH));
        return snapshot.exists() ? snapshot.val() : {};
    }

    // Normaliza uma entrada da planilha em { name, unit, role }. Aceita:
    //   • string simples (formato antigo, só nome);
    //   • objeto com nomes de campo semânticos ("nome"/"unidade"/"cargo",
    //     em qualquer caixa, ou os equivalentes em inglês);
    //   • objeto com as colunas cruas do Apps Script atual — colunaB = nome,
    //     colunaE = unidade/setor, colunaF = cargo/função.
    function normalizeEntry(entry) {
        if (entry == null) return null;
        if (typeof entry === 'string') return { name: entry.trim(), unit: null, role: null };
        if (typeof entry === 'object') {
            const name = (entry.nome || entry.name || entry.Nome || entry.Name
                || entry.colunaB || entry.ColunaB || '').toString().trim();
            const unit = (entry.unidade || entry.unit || entry.Unidade || entry.Unit
                || entry.setor || entry.Setor || entry.colunaE || entry.ColunaE || '').toString().trim() || null;
            const role = (entry.cargo || entry.role || entry.Cargo || entry.Role
                || entry.funcao || entry['função'] || entry.colunaF || entry.ColunaF || '').toString().trim() || null;
            return { name, unit, role };
        }
        return null;
    }

    async function fetchUsers() {
        const snapshot = await get(ref(db, USERS_PATH));
        return snapshot.exists() ? snapshot.val() : {};
    }

    // Funde uma lista de entradas (strings ou objetos {nome, unidade, cargo})
    // no node de colaboradores. Nunca sobrescreve accountUserId de quem já
    // tem conta; atualiza unidade/cargo mesmo em colaboradores existentes
    // (a planilha é a fonte viva desses dados) e propaga esses mesmos valores
    // para a conta vinculada, de modo que setor/função na conta acompanhem a
    // sincronização dos Colaboradores sem passo manual.
    // Retorna { added, updated, skipped, usersUpdated }.
    async function mergeNames(entries) {
        const seen = new Map();
        (entries || []).forEach(raw => {
            const entry = normalizeEntry(raw);
            if (!entry || !entry.name) return;
            const key = normalizeName(entry.name);
            if (key && !seen.has(key)) seen.set(key, entry);
        });
        if (seen.size === 0) return { added: 0, updated: 0, skipped: 0, usersUpdated: 0 };

        const [existing, users] = await Promise.all([fetchColaboradores(), fetchUsers()]);
        // Índice de busca do colaborador correspondente a cada linha da
        // planilha. Duas chaves: o nome atual (fullNameKey) e a chave de
        // origem (sourceKey, o nome como veio da planilha na primeira vez).
        // sourceKey tem prioridade — é ela que faz uma correção manual de nome
        // sobreviver ao próximo sync: a linha da planilha continua achando o
        // mesmo registro em vez de recriar o nome errado.
        const existingByKey = new Map();
        Object.keys(existing).forEach(id => {
            const c = existing[id];
            if (c?.fullNameKey) existingByKey.set(c.fullNameKey, { id, ...c });
        });
        Object.keys(existing).forEach(id => {
            const c = existing[id];
            if (c?.sourceKey) existingByKey.set(c.sourceKey, { id, ...c });
        });

        const updates = {};
        let added = 0, updated = 0, usersUpdated = 0;

        // Espelha unidade/cargo na conta vinculada. A conta pode estar
        // defasada mesmo quando o colaborador já está correto (contas criadas
        // antes de a planilha trazer esses campos), por isso a comparação é
        // sempre contra o valor da planilha, não contra o do colaborador.
        function syncAccount(accountUserId, unit, role) {
            if (!accountUserId) return;
            const user = users[accountUserId];
            if (!user) return; // conta excluída — o vínculo é limpo na exclusão
            if ((user.unit || null) === unit && (user.role || null) === role) return;
            updates[`${USERS_PATH}/${accountUserId}/unit`] = unit;
            updates[`${USERS_PATH}/${accountUserId}/role`] = role;
            usersUpdated++;
        }

        // inSheet marca se o nome apareceu nesta leitura da planilha — vira o
        // balão "Sincronizado"/"Desvinculado" na aba Colaboradores. Todo mundo
        // que já existia começa presumido fora da planilha; o loop abaixo
        // liga de volta quem realmente veio nesta leitura.
        Object.keys(existing).forEach(id => {
            if (existing[id]?.inSheet !== false) updates[`${COLABS_PATH}/${id}/inSheet`] = false;
        });

        seen.forEach((entry, key) => {
            const current = existingByKey.get(key);
            if (current) {
                // Campo corrigido à mão em Configurações > Colaboradores vence
                // a planilha: o sync não desfaz a correção (é justamente para
                // consertar linha inválida na origem).
                const locked = current.editedFields || {};
                const unit = locked.unit ? (current.unit || null) : (entry.unit || null);
                const role = locked.role ? (current.role || null) : (entry.role || null);
                syncAccount(current.accountUserId, unit, role);
            }
            if (!current) {
                const id = ref(db, COLABS_PATH).push().key;
                updates[`${COLABS_PATH}/${id}`] = {
                    fullName: entry.name,
                    fullNameKey: key,
                    sourceKey: key,
                    unit: entry.unit || null,
                    role: entry.role || null,
                    accountUserId: null,
                    active: true,
                    inSheet: true,
                    importedAt: Date.now()
                };
                added++;
            } else {
                // Registros antigos (anteriores ao sourceKey) passam a ter a
                // âncora, para que uma edição manual futura não seja desfeita.
                if (!current.sourceKey) updates[`${COLABS_PATH}/${current.id}/sourceKey`] = key;
                updates[`${COLABS_PATH}/${current.id}/inSheet`] = true;
                const locked = current.editedFields || {};
                let changed = false;
                if (!locked.unit && (current.unit || null) !== (entry.unit || null)) {
                    updates[`${COLABS_PATH}/${current.id}/unit`] = entry.unit || null;
                    changed = true;
                }
                if (!locked.role && (current.role || null) !== (entry.role || null)) {
                    updates[`${COLABS_PATH}/${current.id}/role`] = entry.role || null;
                    changed = true;
                }
                if (changed) updated++;
            }
        });

        if (Object.keys(updates).length > 0) await db.ref().update(updates);
        return { added, updated, skipped: seen.size - added - updated, usersUpdated };
    }

    // Busca a planilha do Google e funde os nomes (com unidade/cargo, quando
    // disponíveis) no Firebase. Silenciosa por padrão (roda em segundo
    // plano); erros de rede não travam o cadastro — quem já foi importado
    // antes continua disponível.
    let syncPromise = null;
    async function syncFromSheets({ silent = true } = {}) {
        // Evita disparos concorrentes (ex.: cadastro abre o modal enquanto
        // Configurações também está sincronizando).
        if (syncPromise) return syncPromise;
        syncPromise = (async () => {
            try {
                const response = await fetch(SHEETS_NAMES_URL);
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                const entries = await response.json();
                return await mergeNames(Array.isArray(entries) ? entries : []);
            } catch (error) {
                if (!silent) throw error;
                console.error('Erro ao sincronizar colaboradores da planilha:', error);
                return { added: 0, updated: 0, skipped: 0, usersUpdated: 0, error };
            } finally {
                syncPromise = null;
            }
        })();
        return syncPromise;
    }

    U.ColaboradoresSync = { fetchColaboradores, mergeNames, syncFromSheets, normalizeEntry, SHEETS_NAMES_URL };
})();
