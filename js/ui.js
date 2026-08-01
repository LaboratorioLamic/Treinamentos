// Utilitários de UI do painel admin (toast + barra de carregamento)
// e o bloqueio de devtools, que vale para a página inteira.
(function () {

function showWarning(message) {
    const warningMessage = document.getElementById('cfg-warning-message');
    const warningText = document.getElementById('cfg-warning-text');
    if (!warningMessage || !warningText) return;
    warningText.textContent = message;
    warningMessage.style.display = 'block';
    setTimeout(() => { warningMessage.style.display = 'none'; }, 3000);
}

let loadingBarAnimationId = null;
let loadingBarStart = null;

function showLoadingBar() {
    const overlay = document.getElementById('cfg-loading-overlay');
    const bar = document.getElementById('cfg-loading-bar');
    if (!overlay || !bar) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    bar.style.width = '0%';
    loadingBarStart = null;
    if (loadingBarAnimationId) cancelAnimationFrame(loadingBarAnimationId);
    function step(timestamp) {
        if (!loadingBarStart) loadingBarStart = timestamp;
        const elapsed = timestamp - loadingBarStart;
        const duration = 15000;
        const baseProgress = Math.min(98, (elapsed / duration) * 98);
        const variation = (Math.random() - 0.5) * 2 * (1 - Math.min(elapsed, duration) / duration);
        const progress = Math.min(98, Math.max(0, baseProgress + variation));
        bar.style.width = `${progress}%`;
        if (elapsed < duration) {
            loadingBarAnimationId = requestAnimationFrame(step);
        } else {
            bar.style.width = '98%';
        }
    }
    loadingBarAnimationId = requestAnimationFrame(step);
}

function hideLoadingBar() {
    const overlay = document.getElementById('cfg-loading-overlay');
    const bar = document.getElementById('cfg-loading-bar');
    if (!overlay || !bar) return;
    if (loadingBarAnimationId) { cancelAnimationFrame(loadingBarAnimationId); loadingBarAnimationId = null; }
    bar.style.width = '100%';
    setTimeout(() => {
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
        bar.style.width = '0%';
    }, 800);
}

function cancelLoadingBar() {
    if (loadingBarAnimationId) { cancelAnimationFrame(loadingBarAnimationId); loadingBarAnimationId = null; }
    const overlay = document.getElementById('cfg-loading-overlay');
    const bar = document.getElementById('cfg-loading-bar');
    if (overlay) { overlay.classList.remove('active'); overlay.setAttribute('aria-hidden', 'true'); }
    if (bar) bar.style.width = '0%';
}

// ─── Bloqueio de devtools (página inteira, portal do aluno incluso) ───
function ctrlShiftKey(event, key) {
    return event.ctrlKey && event.shiftKey && event.keyCode === key.charCodeAt(0);
}

document.onkeydown = function (event) {
    if (
        event.keyCode === 123 ||
        ctrlShiftKey(event, 'I') ||
        ctrlShiftKey(event, 'J') ||
        ctrlShiftKey(event, 'C') ||
        (event.ctrlKey && event.keyCode === 'U'.charCodeAt(0)) ||
        (event.ctrlKey && event.keyCode === 'S'.charCodeAt(0))
    ) {
        event.preventDefault();
        return false;
    }
};

document.addEventListener('contextmenu', function (evento) { evento.preventDefault(); });

window.UniAdmin = window.UniAdmin || {};
Object.assign(window.UniAdmin, { showWarning, showLoadingBar, hideLoadingBar, cancelLoadingBar });
})();
