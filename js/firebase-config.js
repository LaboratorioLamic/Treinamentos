// Inicialização única do Firebase, compartilhada entre o portal e o painel admin.
// Usa o SDK "compat" (script clássico) para que a página funcione tambem
// aberta direto do disco (file://), sem exigir um servidor local.
var UniAdmin = window.UniAdmin || {};

(function () {
    var firebaseConfig = {
        apiKey: "AIzaSyCqdv_qK7R8CRKQnVlBh_PyliokIw7DBUk",
        authDomain: "uniadmin-708f5.firebaseapp.com",
        projectId: "uniadmin-708f5",
        storageBucket: "uniadmin-708f5.firebasestorage.app",
        messagingSenderId: "592349068633",
        appId: "1:592349068633:web:0965b420544265584ca048"
    };

    firebase.initializeApp(firebaseConfig);

    UniAdmin.db = firebase.database();
    UniAdmin.dbRoot = 'uniadmin';

    UniAdmin.categoryPaths = {
        'Treinamentos': 'treinamentos',
        'Educação Continuada': 'educacao_continuada',
        'Estágios': 'estagios'
    };

    // Nota mínima de aprovação. Estágios tem corte próprio (7); as demais
    // categorias usam 8. Aceita nome da categoria ou slug do banco, porque o
    // portal trabalha com o nome e os relatórios do admin, com o slug.
    UniAdmin.DEFAULT_PASSING_SCORE = 8;
    UniAdmin.PASSING_SCORE_BY_SLUG = { estagios: 7 };

    UniAdmin.getPassingScore = function (categoryOrSlug) {
        var slug = UniAdmin.categoryPaths[categoryOrSlug] || categoryOrSlug;
        var score = UniAdmin.PASSING_SCORE_BY_SLUG[slug];
        return typeof score === 'number' ? score : UniAdmin.DEFAULT_PASSING_SCORE;
    };

    UniAdmin.isApproved = function (score, categoryOrSlug) {
        return Number(score) >= UniAdmin.getPassingScore(categoryOrSlug);
    };

    // Categorias sem conta logada não têm cargo de sessão, então a restrição
    // de visibilidade por função (`roles` do assunto) não se aplica a elas: se
    // um assunto com `roles` acabar ali (por duplicação vinda de outra
    // categoria, por exemplo), ninguém consegue vê-lo no portal. O painel não
    // grava `roles` nessas categorias e o portal ignora o campo.
    UniAdmin.ROLE_FREE_SLUGS = ['estagios'];

    UniAdmin.categoryUsesRoles = function (categoryOrSlug) {
        var slug = UniAdmin.categoryPaths[categoryOrSlug] || categoryOrSlug;
        return UniAdmin.ROLE_FREE_SLUGS.indexOf(slug) === -1;
    };

    UniAdmin.getCategoryDbPath = function (category) {
        var slug = UniAdmin.categoryPaths[category] || category.toLowerCase().replace(/[^a-z0-9]+/gi, '_');
        return '/' + UniAdmin.dbRoot + '/' + slug;
    };

    // Helpers no formato do SDK modular, para o restante do codigo nao mudar.
    // Aceita ref(path) e tambem ref(db, path), a forma do SDK modular.
    UniAdmin.ref = function (a, b) {
        var path = (typeof a === 'string') ? a : b;
        return UniAdmin.db.ref(path);
    };
    UniAdmin.get = function (reference) { return reference.once('value'); };
    UniAdmin.set = function (reference, value) { return reference.set(value); };
    UniAdmin.remove = function (reference) { return reference.remove(); };
})();

window.UniAdmin = UniAdmin;
