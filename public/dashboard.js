/**
 * @file dashboard.js
 * @description Panel de control del servidor AutoQuiz
 */

// ===== CONFIGURACIÓN =====
const API_BASE = window.location.origin;
let ws = null; // WebSocket para logs en tiempo real
let currentUserId = null;
let activityChart = null;
let tokensChart = null;
let adminToken = null;

// ===== AUTENTICACIÓN =====
function checkAuth() {
    adminToken = sessionStorage.getItem('adminToken');
    
    if (!adminToken) {
        window.location.href = '/dashboard';
        return false;
    }
    
    // Verificar que el token es válido
    fetch(`${API_BASE}/api/admin/verify`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
    })
    .then(res => {
        if (!res.ok) {
            sessionStorage.removeItem('adminToken');
            window.location.href = '/dashboard';
        }
    })
    .catch(() => {
        sessionStorage.removeItem('adminToken');
        window.location.href = '/dashboard';
    });
    
    return true;
}

function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
    };
}

function logout() {
    fetch(`${API_BASE}/api/admin/logout`, {
        method: 'POST',
        headers: getAuthHeaders()
    })
    .then(() => {
        sessionStorage.removeItem('adminToken');
        window.location.href = '/dashboard';
    })
    .catch(() => {
        sessionStorage.removeItem('adminToken');
        window.location.href = '/dashboard';
    });
}

// ===== INICIALIZACIÓN =====
document.addEventListener('DOMContentLoaded', () => {
    // Verificar autenticación
    if (!checkAuth()) return;
    
    initNavigation();
    initModals();
    initWebSocket();
    loadDashboard();
    
    // Refresh automático cada 30 segundos
    setInterval(loadDashboard, 30000);
    
    // Botón de refresh manual
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadDashboard();
        animateRefreshButton();
    });
    
    // Botón de logout
    document.getElementById('logout-btn').addEventListener('click', logout);
});

// ===== NAVEGACIÓN =====
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
            
            // Actualizar navegación activa
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

function switchView(viewName) {
    // Ocultar todas las vistas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    // Mostrar vista seleccionada
    const view = document.getElementById(`${viewName}-view`);
    view.classList.add('active');
    
    // Actualizar título
    const titles = {
        dashboard: { title: 'Dashboard', subtitle: 'Estadísticas generales del sistema' },
        users: { title: 'Gestión de Usuarios', subtitle: 'Administrar usuarios de la extensión' },
        errors: { title: 'Registro de Errores', subtitle: 'Monitoreo de errores del sistema' },
        sessions: { title: 'Sesiones Activas', subtitle: 'Cuestionarios en progreso' }
    };
    
    document.getElementById('page-title').textContent = titles[viewName].title;
    document.getElementById('page-subtitle').textContent = titles[viewName].subtitle;
    
    // Animar entrada
    gsap.from(view, { opacity: 0, y: 20, duration: 0.5, ease: 'power2.out' });
    
    // Cargar datos específicos de la vista
    switch(viewName) {
        case 'users':
            loadUsers();
            break;
        case 'errors':
            loadErrors();
            break;
        case 'sessions':
            loadSessions();
            break;
    }
}

// ===== DASHBOARD =====
async function loadDashboard() {
    try {
        const [stats, users] = await Promise.all([
            fetch(`${API_BASE}/api/stats`, { headers: getAuthHeaders() }).then(r => r.json()),
            fetch(`${API_BASE}/api/users`, { headers: getAuthHeaders() }).then(r => r.json())
        ]);
        
        // Actualizar stats cards
        updateStatsCards(stats);
        
        // Actualizar gráficos
        updateCharts(users);
        
    } catch (error) {
        console.error('Error al cargar dashboard:', error);
        showNotification('Error al cargar datos', 'error');
    }
}

function updateStatsCards(stats) {
    const elements = {
        users: document.getElementById('stat-users'),
        quizzes: document.getElementById('stat-quizzes'),
        questions: document.getElementById('stat-questions'),
        tokens: document.getElementById('stat-tokens')
    };
    
    // Animar números
    animateValue(elements.users, parseInt(elements.users.textContent) || 0, stats.total_users || 0, 1000);
    animateValue(elements.quizzes, parseInt(elements.quizzes.textContent) || 0, stats.total_quizzes_completed || 0, 1000);
    animateValue(elements.questions, parseInt(elements.questions.textContent) || 0, stats.total_questions_processed || 0, 1000);
    animateValue(elements.tokens, parseInt(elements.tokens.textContent) || 0, stats.total_tokens_used || 0, 1000);
}

function updateCharts(users) {
    // Gráfico de actividad
    const activityData = {
        labels: users.map(u => u.username),
        datasets: [{
            label: 'Cuestionarios Completados',
            data: users.map(u => u.quizzes_completed),
            backgroundColor: 'rgba(79, 70, 229, 0.8)',
            borderColor: 'rgba(79, 70, 229, 1)',
            borderWidth: 2
        }]
    };
    
    if (activityChart) {
        activityChart.data = activityData;
        activityChart.update();
    } else {
        const ctx = document.getElementById('activity-chart').getContext('2d');
        activityChart = new Chart(ctx, {
            type: 'bar',
            data: activityData,
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#334155' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
    
    // Gráfico de tokens
    const tokensData = {
        labels: users.map(u => u.username),
        datasets: [{
            label: 'Tokens Utilizados',
            data: users.map(u => u.total_tokens_used),
            backgroundColor: 'rgba(16, 185, 129, 0.8)',
            borderColor: 'rgba(16, 185, 129, 1)',
            borderWidth: 2
        }]
    };
    
    if (tokensChart) {
        tokensChart.data = tokensData;
        tokensChart.update();
    } else {
        const ctx = document.getElementById('tokens-chart').getContext('2d');
        tokensChart = new Chart(ctx, {
            type: 'line',
            data: tokensData,
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#334155' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// ===== USUARIOS =====
async function loadUsers() {
    try {
        const users = await fetch(`${API_BASE}/api/users`, { headers: getAuthHeaders() }).then(r => r.json());
        
        const container = document.getElementById('users-list');
        container.innerHTML = '';
        
        users.forEach(user => {
            const card = createUserCard(user);
            container.appendChild(card);
            
            // Animar entrada
            gsap.from(card, { opacity: 0, x: -20, duration: 0.4, delay: 0.1 });
        });
        
    } catch (error) {
        console.error('Error al cargar usuarios:', error);
    }
}

function createUserCard(user) {
    const card = document.createElement('div');
    card.className = 'user-card';
    card.onclick = () => showUserDetail(user.id);
    
    const statusBadge = user.enabled 
        ? '<span class="badge badge-success">Activo</span>'
        : '<span class="badge badge-danger">Inhabilitado</span>';
    
    card.innerHTML = `
        <div class="user-avatar">${user.username.charAt(0).toUpperCase()}</div>
        <div class="user-info">
            <h3>${user.username} ${statusBadge}</h3>
            <div class="user-meta">
                <span>🆔 ${user.identifier}</span>
                <span>✅ ${user.quizzes_completed} quizzes</span>
                <span>🪙 ${formatNumber(user.total_tokens_used)} tokens</span>
            </div>
        </div>
        <div class="user-actions" onclick="event.stopPropagation()">
            <button class="btn btn-secondary" onclick="toggleUserStatus(${user.id}, ${!user.enabled})">
                ${user.enabled ? '⏸️' : '▶️'}
            </button>
        </div>
    `;
    
    return card;
}

async function showUserDetail(userId) {
    try {
        const user = await fetch(`${API_BASE}/api/users/${userId}`, { headers: getAuthHeaders() }).then(r => r.json());
        const errors = await fetch(`${API_BASE}/api/users/${userId}/errors`, { headers: getAuthHeaders() }).then(r => r.json());
        
        currentUserId = userId;
        
        // Llenar modal
        document.getElementById('detail-username').textContent = user.username;
        document.getElementById('detail-identifier').textContent = user.identifier;
        document.getElementById('detail-status').innerHTML = user.enabled 
            ? '<span class="badge badge-success">Activo</span>'
            : '<span class="badge badge-danger">Inhabilitado</span>';
        document.getElementById('detail-created').textContent = formatDate(user.created_at);
        document.getElementById('detail-activity').textContent = formatDate(user.last_activity);
        document.getElementById('detail-quizzes').textContent = user.quizzes_completed || 0;
        document.getElementById('detail-questions').textContent = user.total_questions_processed || 0;
        document.getElementById('detail-tokens').textContent = formatNumber(user.total_tokens_used || 0);
        document.getElementById('detail-errors').textContent = user.total_errors || 0;
        
        // Mostrar logs de errores
        const logsContainer = document.getElementById('user-logs');
        if (errors.length > 0) {
            logsContainer.innerHTML = errors.map(err => `
                <div class="log-entry">
                    <span class="log-timestamp">${formatTime(err.created_at)}</span>
                    <span class="log-message">[${err.error_type}] ${err.error_message}</span>
                </div>
            `).join('');
        } else {
            logsContainer.innerHTML = '<p class="logs-empty">No hay errores registrados</p>';
        }
        
        // Actualizar botón toggle
        const toggleBtn = document.getElementById('toggle-user-btn');
        toggleBtn.textContent = user.enabled ? '⏸️ Inhabilitar' : '▶️ Habilitar';
        toggleBtn.onclick = () => toggleUserStatus(userId, !user.enabled);
        
        // Mostrar modal
        showModal('user-detail-modal');
        
    } catch (error) {
        console.error('Error al cargar detalles del usuario:', error);
    }
}

async function toggleUserStatus(userId, enabled) {
    try {
        await fetch(`${API_BASE}/api/users/${userId}/toggle`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ enabled })
        });
        
        showNotification(`Usuario ${enabled ? 'habilitado' : 'inhabilitado'}`, 'success');
        loadUsers();
        
        // Si el modal está abierto, cerrarlo y reabrir con datos actualizados
        if (currentUserId === userId) {
            closeModal('user-detail-modal');
            setTimeout(() => showUserDetail(userId), 300);
        }
        
    } catch (error) {
        console.error('Error al cambiar estado:', error);
        showNotification('Error al cambiar estado', 'error');
    }
}

async function deleteUserConfirm() {
    if (!currentUserId) return;
    
    if (!confirm('¿Estás seguro de eliminar este usuario? Esta acción no se puede deshacer.')) {
        return;
    }
    
    try {
        await fetch(`${API_BASE}/api/users/${currentUserId}`, { 
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        showNotification('Usuario eliminado', 'success');
        closeModal('user-detail-modal');
        loadUsers();
        loadDashboard();
        
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        showNotification('Error al eliminar usuario', 'error');
    }
}

// ===== ERRORES =====
async function loadErrors() {
    try {
        const errors = await fetch(`${API_BASE}/api/errors`, { headers: getAuthHeaders() }).then(r => r.json());
        
        const container = document.getElementById('errors-list');
        container.innerHTML = '';
        
        errors.forEach(error => {
            const card = createErrorCard(error);
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error al cargar errores:', error);
    }
}

function createErrorCard(error) {
    const card = document.createElement('div');
    card.className = 'error-card';
    
    card.innerHTML = `
        <div class="error-header">
            <span class="error-type">${error.error_type}</span>
            <span class="error-time">${formatDate(error.created_at)}</span>
        </div>
        <p class="error-message">${error.error_message}</p>
        <p class="error-user">Usuario: ${error.username} (${error.identifier})</p>
    `;
    
    return card;
}

// ===== SESIONES =====
async function loadSessions() {
    try {
        const sessions = await fetch(`${API_BASE}/api/sessions`, { headers: getAuthHeaders() }).then(r => r.json());
        
        const container = document.getElementById('sessions-list');
        container.innerHTML = '';
        
        if (sessions.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay sesiones activas</p>';
            return;
        }
        
        sessions.forEach(session => {
            const card = createSessionCard(session);
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error al cargar sesiones:', error);
    }
}

function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'user-card';
    
    const progress = (session.questions_processed / session.questions_total * 100).toFixed(0);
    
    card.innerHTML = `
        <div class="user-avatar">📝</div>
        <div class="user-info">
            <h3>Sesión ${session.session_id.substring(0, 8)}...</h3>
            <div class="user-meta">
                <span>Usuario ID: ${session.user_id}</span>
                <span>Modelo: ${session.model_used}</span>
                <span>Progreso: ${session.questions_processed}/${session.questions_total} (${progress}%)</span>
            </div>
        </div>
    `;
    
    return card;
}

// ===== CREAR USUARIO =====
function initModals() {
    // Botón nuevo usuario
    document.getElementById('new-user-btn').addEventListener('click', () => {
        showModal('new-user-modal');
        document.getElementById('new-username').value = '';
    });
    
    // Botón crear
    document.getElementById('create-user-btn').addEventListener('click', createUser);
    
    // Botón cancelar
    document.getElementById('cancel-user-btn').addEventListener('click', () => {
        closeModal('new-user-modal');
    });
    
    // Botón copiar token
    document.getElementById('copy-token-btn').addEventListener('click', copyToken);
    
    // Botón cerrar token modal
    document.getElementById('close-token-btn').addEventListener('click', () => {
        closeModal('token-modal');
    });
    
    // Botón eliminar usuario
    document.getElementById('delete-user-btn').addEventListener('click', deleteUserConfirm);
    
    // Cerrar modales con X o clic fuera
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal.id);
            }
        });
        
        modal.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => closeModal(modal.id));
        });
    });
}

async function createUser() {
    const username = document.getElementById('new-username').value.trim();
    
    if (!username) {
        showNotification('Ingresa un nombre de usuario', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/users`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ username })
        });
        
        const user = await response.json();
        
        // Cerrar modal de creación
        closeModal('new-user-modal');
        
        // Mostrar modal de token
        document.getElementById('created-username').textContent = user.username;
        document.getElementById('created-identifier').textContent = user.identifier;
        document.getElementById('created-token').textContent = user.token;
        
        showModal('token-modal');
        
        // Actualizar listas
        loadUsers();
        loadDashboard();
        
    } catch (error) {
        console.error('Error al crear usuario:', error);
        showNotification('Error al crear usuario', 'error');
    }
}

function copyToken() {
    const token = document.getElementById('created-token').textContent;
    navigator.clipboard.writeText(token);
    
    const btn = document.getElementById('copy-token-btn');
    btn.textContent = '✅ Copiado!';
    setTimeout(() => {
        btn.textContent = '📋 Copiar';
    }, 2000);
}

// ===== WEBSOCKET (Logs en tiempo real) =====
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
        console.log('[WS] Conectado');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };
    
    ws.onclose = () => {
        console.log('[WS] Desconectado. Reconectando en 5s...');
        setTimeout(initWebSocket, 5000);
    };
}

function handleWebSocketMessage(data) {
    // Actualizar logs en tiempo real si el modal del usuario está abierto
    if (data.type === 'log' && currentUserId === data.userId) {
        const logsContainer = document.getElementById('user-logs');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = `
            <span class="log-timestamp">${formatTime(new Date())}</span>
            <span class="log-message">${data.message}</span>
        `;
        logsContainer.insertBefore(logEntry, logsContainer.firstChild);
        
        // Limitar a 50 logs
        while (logsContainer.children.length > 50) {
            logsContainer.removeChild(logsContainer.lastChild);
        }
    }
    
    // Actualizar dashboard si hay cambios
    if (data.type === 'stats_update') {
        loadDashboard();
    }
}

// ===== UTILIDADES =====
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.add('active');
    gsap.from(modal.querySelector('.modal-content'), { scale: 0.9, opacity: 0, duration: 0.3 });
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    gsap.to(modal.querySelector('.modal-content'), {
        scale: 0.9, opacity: 0, duration: 0.2, onComplete: () => {
            modal.classList.remove('active');
        }
    });
}

function showNotification(message, type = 'info') {
    // Implementación simple - puede mejorarse
    alert(message);
}

function animateValue(element, start, end, duration) {
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.floor(current).toLocaleString();
    }, 16);
}

function animateRefreshButton() {
    const btn = document.getElementById('refresh-btn');
    gsap.to(btn, { rotation: 360, duration: 0.5, ease: 'power2.out', onComplete: () => {
        gsap.set(btn, { rotation: 0 });
    }});
}

function formatNumber(num) {
    return parseInt(num).toLocaleString();
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('es-ES', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('es-ES');
}

// ===== CONSOLA EN TIEMPO REAL =====
let consoleWs = null;
let consoleUserId = null;
let consoleLineCount = 0;
let consoleActiveFilter = 'all';
let consoleIsStreaming = false;

// Inicializar botón de consola
document.getElementById('open-console-btn').addEventListener('click', () => {
    if (currentUserId) {
        openConsole(currentUserId);
    }
});

// Botones de control de la consola
document.getElementById('console-start-btn').addEventListener('click', startConsoleStreaming);
document.getElementById('console-stop-btn').addEventListener('click', stopConsoleStreaming);
document.getElementById('console-clear-btn').addEventListener('click', clearConsole);

// Filtros de nivel
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        consoleActiveFilter = btn.dataset.level;
        filterConsoleLogs();
    });
});

// Cerrar consola
document.getElementById('console-modal').addEventListener('click', (e) => {
    if (e.target.id === 'console-modal') {
        closeConsole();
    }
});

document.getElementById('console-modal').querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', closeConsole);
});

/**
 * Abrir consola para un usuario específico
 */
async function openConsole(userId) {
    consoleUserId = userId;
    consoleLineCount = 0;
    
    // Obtener información del usuario
    try {
        const response = await fetch(`${API_BASE}/api/users/${userId}`, {
            headers: getAuthHeaders()
        });
        const user = await response.json();
        
        document.getElementById('console-username').textContent = user.username || user.identifier;
    } catch (error) {
        console.error('Error al obtener usuario:', error);
        document.getElementById('console-username').textContent = `#${userId}`;
    }
    
    // Limpiar output y mostrar modal
    clearConsole();
    showModal('console-modal');
    updateConsoleStatus('disconnected', 'Desconectado');
    
    // Inicializar WebSocket
    initConsoleWebSocket();
}

/**
 * Cerrar consola
 */
function closeConsole() {
    if (consoleIsStreaming) {
        stopConsoleStreaming();
    }
    
    if (consoleWs) {
        consoleWs.close();
        consoleWs = null;
    }
    
    closeModal('console-modal');
    consoleUserId = null;
}

/**
 * Inicializar WebSocket para la consola
 */
function initConsoleWebSocket() {
    if (consoleWs) {
        consoleWs.close();
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    consoleWs = new WebSocket(`${protocol}//${window.location.host}?role=admin&userId=${consoleUserId}`);
    
    consoleWs.onopen = () => {
        console.log('[Console WS] Conectado');
        updateConsoleStatus('connected', 'Conectado');
        addConsoleLog('INFO', 'WebSocket conectado. Presiona "Iniciar" para recibir logs.');
    };
    
    consoleWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleConsoleMessage(data);
        } catch (error) {
            console.error('[Console WS] Error parsing message:', error);
        }
    };
    
    consoleWs.onerror = (error) => {
        console.error('[Console WS] Error:', error);
        updateConsoleStatus('error', 'Error de conexión');
        addConsoleLog('ERROR', 'Error en la conexión WebSocket');
    };
    
    consoleWs.onclose = () => {
        console.log('[Console WS] Desconectado');
        updateConsoleStatus('disconnected', 'Desconectado');
        if (consoleIsStreaming) {
            addConsoleLog('WARN', 'Conexión cerrada inesperadamente');
            consoleIsStreaming = false;
            updateStreamingButtons(false);
        }
    };
    
    // Keep alive
    setInterval(() => {
        if (consoleWs && consoleWs.readyState === WebSocket.OPEN) {
            consoleWs.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

/**
 * Manejar mensajes del WebSocket
 */
function handleConsoleMessage(data) {
    switch (data.type) {
        case 'connected':
            addConsoleLog('INFO', data.message || 'Conectado al servidor');
            break;
            
        case 'log':
            // Log de la extensión
            if (data.userId == consoleUserId) {
                addConsoleLog(data.level || 'INFO', data.message, data.source);
            }
            break;
            
        case 'monitoring_started':
            addConsoleLog('INFO', `✅ ${data.message}`);
            consoleIsStreaming = true;
            updateStreamingButtons(true);
            updateConsoleStatus('streaming', 'Streaming activo');
            break;
            
        case 'monitoring_stopped':
            addConsoleLog('INFO', `⏸️ ${data.message}`);
            consoleIsStreaming = false;
            updateStreamingButtons(false);
            updateConsoleStatus('connected', 'Conectado');
            break;
            
        case 'pong':
            // Respuesta al ping (keep alive)
            break;
            
        case 'error':
            addConsoleLog('ERROR', data.message || 'Error desconocido');
            break;
            
        default:
            console.log('[Console WS] Mensaje desconocido:', data);
    }
}

/**
 * Iniciar streaming de logs
 */
function startConsoleStreaming() {
    if (!consoleWs || consoleWs.readyState !== WebSocket.OPEN) {
        addConsoleLog('ERROR', 'WebSocket no conectado');
        return;
    }
    
    if (consoleIsStreaming) {
        addConsoleLog('WARN', 'El streaming ya está activo');
        return;
    }
    
    // Enviar comando para iniciar monitoreo
    consoleWs.send(JSON.stringify({
        type: 'start_monitoring',
        userId: consoleUserId
    }));
    
    addConsoleLog('INFO', '▶️ Solicitando inicio de streaming...');
}

/**
 * Detener streaming de logs
 */
function stopConsoleStreaming() {
    if (!consoleWs || consoleWs.readyState !== WebSocket.OPEN) {
        return;
    }
    
    if (!consoleIsStreaming) {
        return;
    }
    
    // Enviar comando para detener monitoreo
    consoleWs.send(JSON.stringify({
        type: 'stop_monitoring',
        userId: consoleUserId
    }));
    
    addConsoleLog('INFO', '⏸️ Solicitando pausa de streaming...');
}

/**
 * Limpiar consola
 */
function clearConsole() {
    const output = document.getElementById('console-output');
    output.innerHTML = '<div class="console-welcome"><p>🖥️ <strong>Consola de Logs en Tiempo Real</strong></p><p>Presiona <strong>"Iniciar"</strong> para comenzar a recibir logs de la extensión del usuario.</p></div>';
    consoleLineCount = 0;
    updateConsoleLineCount();
}

/**
 * Agregar log a la consola
 */
function addConsoleLog(level, message, source = 'system') {
    const output = document.getElementById('console-output');
    
    // Remover mensaje de bienvenida si existe
    const welcome = output.querySelector('.console-welcome');
    if (welcome) {
        welcome.remove();
    }
    
    const timestamp = new Date().toLocaleTimeString('es-ES', { hour12: false });
    
    const entry = document.createElement('div');
    entry.className = `console-log-entry level-${level}`;
    entry.dataset.level = level;
    
    entry.innerHTML = `
        <span class="console-timestamp">[${timestamp}]</span>
        <span class="console-level level-${level}">${level}</span>
        <span class="console-message">${escapeHtml(message)}</span>
    `;
    
    output.appendChild(entry);
    
    // Auto-scroll al final
    output.scrollTop = output.scrollHeight;
    
    // Incrementar contador
    consoleLineCount++;
    updateConsoleLineCount();
    updateConsoleLastUpdate();
    
    // Aplicar filtro si está activo
    if (consoleActiveFilter !== 'all' && level !== consoleActiveFilter) {
        entry.style.display = 'none';
    }
}

/**
 * Filtrar logs por nivel
 */
function filterConsoleLogs() {
    const entries = document.querySelectorAll('.console-log-entry');
    
    entries.forEach(entry => {
        if (consoleActiveFilter === 'all') {
            entry.style.display = 'flex';
        } else {
            entry.style.display = entry.dataset.level === consoleActiveFilter ? 'flex' : 'none';
        }
    });
}

/**
 * Actualizar estado de la consola
 */
function updateConsoleStatus(state, text) {
    const indicator = document.getElementById('console-status-indicator');
    const statusText = document.getElementById('console-status-text');
    
    indicator.className = 'status-indicator';
    
    switch (state) {
        case 'connected':
            indicator.classList.add('status-connected');
            break;
        case 'streaming':
            indicator.classList.add('status-streaming');
            break;
        case 'error':
            indicator.classList.add('status-error');
            break;
        default:
            indicator.classList.add('status-disconnected');
    }
    
    statusText.textContent = text;
}

/**
 * Actualizar botones de streaming
 */
function updateStreamingButtons(isStreaming) {
    const startBtn = document.getElementById('console-start-btn');
    const stopBtn = document.getElementById('console-stop-btn');
    
    startBtn.disabled = isStreaming;
    stopBtn.disabled = !isStreaming;
}

/**
 * Actualizar contador de líneas
 */
function updateConsoleLineCount() {
    document.getElementById('console-line-count').textContent = consoleLineCount;
}

/**
 * Actualizar última actualización
 */
function updateConsoleLastUpdate() {
    const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
    document.getElementById('console-last-update').textContent = time;
}

/**
 * Escapar HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
