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
