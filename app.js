// Controle de Caixa - Logic & Core Operations

// State variable
let appState = {
    initialSetup: null, // { balance: 0, date: 'YYYY-MM-DD', cdiPercentage: 100 }
    manualTransactions: [] // Array of { id, date, type: 'DEPOSIT'|'WITHDRAW', amount, description }
};

// Global CDI rate (cached from Central Bank)
let annualCdiRate = parseFloat(localStorage.getItem('controle_caixa_cached_cdi')) || 10.40;

// Computed Timeline & Totals
let computedTimeline = [];
let currentBalance = 0;
let totalYields = 0;
let totalDeposited = 0;
let totalWithdrawn = 0;

// Chart references
let balanceChart = null;
let simulationChart = null;
let currentChartPeriod = 30; // 30, 90, 365, 'all'

// --- 1. EASTER & HOLIDAYS ENGINE (Brazilian Business Days) ---

function getEaster(year) {
    const f = Math.floor,
        G = year % 19,
        C = f(year / 100),
        H = (C - f(C / 4) - f((8 * C + 13) / 25) + 19 * G + 15) % 30,
        I = H - f(H / 28) * (1 - f(29 / (H + 1)) * f((21 - G) / 11)),
        J = (year + f(year / 4) + I + 2 - C + f(C / 4)) % 7,
        L = I - J,
        month = 3 + f((L + 40) / 44),
        day = L + 28 - 31 * f(month / 4);
    return new Date(year, month - 1, day);
}

const holidaysCache = {};

function getHolidays(year) {
    const holidays = new Set();
    // Static national holidays (MM-DD)
    holidays.add('01-01'); // Confraternização Universal
    holidays.add('04-21'); // Tiradentes
    holidays.add('05-01'); // Dia do Trabalho
    holidays.add('09-07'); // Independência
    holidays.add('10-12'); // Nossa Senhora Aparecida
    holidays.add('11-02'); // Finados
    holidays.add('11-15'); // Proclamação da República
    holidays.add('11-20'); // Consciência Negra (Oficial Nacional)
    holidays.add('12-25'); // Natal

    // Easter-based moving holidays
    const easter = getEaster(year);
    
    // Good Friday (Sexta-feira da Paixão) - 2 days before Easter
    const goodFriday = new Date(easter);
    goodFriday.setDate(easter.getDate() - 2);
    holidays.add(`${String(goodFriday.getMonth() + 1).padStart(2, '0')}-${String(goodFriday.getDate()).padStart(2, '0')}`);
    
    // Corpus Christi - 60 days after Easter
    const corpusChristi = new Date(easter);
    corpusChristi.setDate(easter.getDate() + 60);
    holidays.add(`${String(corpusChristi.getMonth() + 1).padStart(2, '0')}-${String(corpusChristi.getDate()).padStart(2, '0')}`);
    
    // Carnival Monday - 48 days before Easter
    const carnivalMon = new Date(easter);
    carnivalMon.setDate(easter.getDate() - 48);
    holidays.add(`${String(carnivalMon.getMonth() + 1).padStart(2, '0')}-${String(carnivalMon.getDate()).padStart(2, '0')}`);

    // Carnival Tuesday - 47 days before Easter
    const carnivalTue = new Date(easter);
    carnivalTue.setDate(easter.getDate() - 47);
    holidays.add(`${String(carnivalTue.getMonth() + 1).padStart(2, '0')}-${String(carnivalTue.getDate()).padStart(2, '0')}`);
    
    return holidays;
}

function isBusinessDay(date) {
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false; // Weekend
    }
    
    const year = date.getFullYear();
    if (!holidaysCache[year]) {
        holidaysCache[year] = getHolidays(year);
    }
    
    const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return !holidaysCache[year].has(mmdd);
}

// Helper to parse date strings without timezone shifts
function parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

// Helper to format Date to YYYY-MM-DD
function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Helper to format Date YYYY-MM-DD to DD/MM/YYYY
function formatDateDisplay(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
}

// --- 2. LOCAL STORAGE INTEGRATION ---

function loadState() {
    let data = localStorage.getItem('controle_caixa_state');
    // Migration fallback for old data
    if (!data) {
        data = localStorage.getItem('girocdi_state');
        if (data) {
            localStorage.setItem('controle_caixa_state', data);
            localStorage.removeItem('girocdi_state');
        }
    }
    let loaded = false;
    if (data) {
        try {
            appState = JSON.parse(data);
            if (!appState.manualTransactions) appState.manualTransactions = [];
            // Migrate cdiRate setup to cdiPercentage
            if (appState.initialSetup && !appState.initialSetup.hasOwnProperty('cdiPercentage')) {
                appState.initialSetup.cdiPercentage = 100;
            }
            loaded = true;
        } catch (e) {
            console.error("Erro ao carregar dados do LocalStorage", e);
        }
    }
    
    // Forçar a configuração do Firebase por padrão
    appState.cloudConfig = {
        enabled: true,
        dbUrl: "https://fluxo-de-caixa-b25d5-default-rtdb.firebaseio.com/",
        dbKey: "caixa_principal"
    };
    
    return loaded;
}

function saveState() {
    localStorage.setItem('controle_caixa_state', JSON.stringify(appState));
    if (appState.cloudConfig && appState.cloudConfig.enabled) {
        syncToCloud();
    }
}

// --- 3. BUSINESS LOGIC: CDI RECALCULATION TIMELINE ---

function recalculateHistory() {
    if (!appState.initialSetup) return;
    
    const startStr = appState.initialSetup.date;
    const initialBalance = parseFloat(appState.initialSetup.balance);
    const cdiPercentage = parseFloat(appState.initialSetup.cdiPercentage) || 100;
    
    // Group manual transactions by date
    const transactionsByDate = {};
    appState.manualTransactions.forEach(tx => {
        if (!transactionsByDate[tx.date]) {
            transactionsByDate[tx.date] = [];
        }
        transactionsByDate[tx.date].push(tx);
    });
    
    computedTimeline = [];
    
    const startDate = parseLocalDate(startStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Clamp endDate to today
    let endDate = new Date(today);
    if (endDate < startDate) {
        endDate = new Date(startDate);
    }
    
    let runningBalance = initialBalance;
    totalYields = 0;
    totalDeposited = initialBalance;
    totalWithdrawn = 0;
    let businessDaysCount = 0;
    
    // Add setup date to timeline
    computedTimeline.push({
        date: startStr,
        type: 'DEPOSIT',
        description: 'Saldo Inicial',
        responsible: '-',
        amount: initialBalance,
        yieldEarned: 0,
        balance: initialBalance
    });
    
    // Formula CDI: daily = (1 + anual)^(1/252) - 1
    // The cdiPercentage is applied directly to the daily DI factor
    const baseDailyCdiRate = Math.pow(1 + annualCdiRate / 100, 1 / 252) - 1;
    const dailyCdiRate = baseDailyCdiRate * (cdiPercentage / 100);
    
    let currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
        const dateStr = formatDate(currentDate);
        const isBiz = isBusinessDay(currentDate);
        
        if (isBiz && dateStr !== startStr) {
            businessDaysCount++;
        }
        
        // 1. Process deposits/withdrawals for this date
        const txsToday = transactionsByDate[dateStr] || [];
        // Sort deposits before withdrawals
        txsToday.sort((a, b) => (a.type === 'DEPOSIT' ? -1 : 1));
        
        txsToday.forEach(tx => {
            if (tx.type === 'DEPOSIT') {
                runningBalance += tx.amount;
                totalDeposited += tx.amount;
                computedTimeline.push({
                    date: dateStr,
                    type: 'DEPOSIT',
                    description: tx.description || 'Depósito',
                    responsible: '-',
                    amount: tx.amount,
                    yieldEarned: 0,
                    balance: runningBalance
                });
            } else if (tx.type === 'WITHDRAW') {
                runningBalance -= tx.amount;
                totalWithdrawn += tx.amount;
                computedTimeline.push({
                    date: dateStr,
                    type: 'WITHDRAW',
                    description: tx.description || 'Retirada',
                    responsible: tx.responsible || 'Não informado',
                    amount: tx.amount,
                    yieldEarned: 0,
                    balance: runningBalance
                });
            }
        });
        
        // 2. Process daily CDI yield on business days (only from day 1 onwards, not on setup date)
        if (isBiz && dateStr !== startStr) {
            // Apply yield only on positive balance
            if (runningBalance > 0) {
                const dailyYield = runningBalance * dailyCdiRate;
                runningBalance += dailyYield;
                totalYields += dailyYield;
                computedTimeline.push({
                    date: dateStr,
                    type: 'YIELD',
                    description: `Rendimento Diário (${cdiPercentage}% CDI)`,
                    responsible: 'Sistema',
                    amount: dailyYield,
                    yieldEarned: dailyYield,
                    balance: runningBalance
                });
            }
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    currentBalance = runningBalance;
    
    // Update Stats panel values
    document.getElementById('stat-yearly-est').innerText = annualCdiRate.toFixed(2).replace('.', ',') + '%';
    document.getElementById('stat-applied-pct').innerText = cdiPercentage + '% do CDI';
    document.getElementById('stat-daily-cdi').innerText = (dailyCdiRate * 100).toFixed(4) + '%';
    
    // Estimate monthly yield as (1 + (annualSelic * cdiPercentage/100))^(1/12) - 1
    const appliedAnnualRate = annualCdiRate * (cdiPercentage / 100);
    const monthlyEst = (Math.pow(1 + appliedAnnualRate / 100, 1 / 12) - 1) * 100;
    document.getElementById('stat-monthly-est').innerText = monthlyEst.toFixed(2) + '%';
    document.getElementById('stat-total-business-days').innerText = `${businessDaysCount} dias`;
    document.getElementById('stat-start-date').innerText = formatDateDisplay(startStr);
}

// --- 4. UI RENDER ENGINE ---

function updateDashboardUI() {
    // 1. Format Currency metrics
    document.getElementById('kpi-total-balance').innerText = currentBalance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('kpi-total-yields').innerText = totalYields.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    const principalNet = totalDeposited - totalYields;
    document.getElementById('kpi-total-principal').innerText = principalNet.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('kpi-withdraws-summary').innerText = `Retiradas: R$ ${totalWithdrawn.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    // Percentage display
    const yieldPercent = principalNet > 0 ? (totalYields / principalNet) * 100 : 0;
    document.getElementById('kpi-yields-percentage').innerText = `+${yieldPercent.toFixed(2)}% do principal`;
    
    // 2. Set current date in header
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('current-simulated-date').innerText = new Date().toLocaleDateString('pt-BR', options);
    
    // 3. Sidebar updates
    document.getElementById('sidebar-cdi-rate').innerText = annualCdiRate.toFixed(2).replace('.', ',') + '%';
    document.getElementById('sidebar-cdi-percentage').innerText = (appState.initialSetup.cdiPercentage || 100) + '%';
    
    // 4. Update Tables (Recent & Full history)
    renderTables();
    
    // 5. Update Charts
    updateHistoricalChart();
    
    // 6. Refresh quick simulator results
    updateQuickSimulations();
}

function renderTables() {
    const recentTbody = document.getElementById('recent-transactions-tbody');
    const historyTbody = document.getElementById('history-transactions-tbody');
    
    recentTbody.innerHTML = '';
    historyTbody.innerHTML = '';
    
    // Reverse chronological order for logs
    const chronologicalLogs = [...computedTimeline].reverse();
    
    // Fill full history list
    const filterType = document.getElementById('extrato-filter-type').value;
    
    let renderedCount = 0;
    
    chronologicalLogs.forEach(item => {
        // Apply filter on Full History
        let matchesFilter = true;
        if (filterType !== 'all') {
            matchesFilter = item.type === filterType;
        }
        
        const rowHtml = `
            <tr>
                <td>${formatDateDisplay(item.date)}</td>
                <td>
                    <span class="type-badge ${item.type.toLowerCase()}">
                        ${item.type === 'DEPOSIT' ? '<i class="fa-solid fa-arrow-down"></i> Depósito' : 
                          item.type === 'WITHDRAW' ? '<i class="fa-solid fa-arrow-up"></i> Retirada' : 
                          '<i class="fa-solid fa-arrow-trend-up"></i> Rendimento'}
                    </span>
                </td>
                <td>${item.description}</td>
                <td class="neutral-text" style="font-weight: 500;">${item.responsible || '-'}</td>
                <td class="${item.type === 'DEPOSIT' ? 'text-success' : item.type === 'WITHDRAW' ? 'neutral-text' : 'text-success'}">
                    ${item.type === 'WITHDRAW' ? '-' : '+'} R$ ${item.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td class="font-semibold">
                    R$ ${item.balance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
            </tr>
        `;
        
        if (matchesFilter) {
            historyTbody.insertAdjacentHTML('beforeend', rowHtml);
        }
        
        // Fill recent transactions (max 4 items, skip standard daily yields if we want less noise, 
        // but showing deposits/withdrawals and latest yield is good. Let's show all latest actions up to 4)
        if (renderedCount < 4) {
            recentTbody.insertAdjacentHTML('beforeend', rowHtml);
            renderedCount++;
        }
    });
    
    if (historyTbody.children.length === 0) {
        historyTbody.innerHTML = `<tr><td colspan="6" class="text-center neutral-text" style="text-align: center; padding: 30px;">Nenhum registro encontrado.</td></tr>`;
    }
    
    if (recentTbody.children.length === 0) {
        recentTbody.innerHTML = `<tr><td colspan="6" class="text-center neutral-text" style="text-align: center; padding: 30px;">Nenhum registro encontrado.</td></tr>`;
    }
}

function filterExtrato() {
    renderTables();
}

// --- 5. CHART ENGINE ---

function updateHistoricalChart() {
    const period = currentChartPeriod;
    
    // Group timeline balances by date to avoid plotting multiple actions at once
    const balanceByDate = {};
    computedTimeline.forEach(item => {
        balanceByDate[item.date] = item.balance;
    });
    
    const sortedDates = Object.keys(balanceByDate).sort();
    
    let datesToPlot = sortedDates;
    if (period !== 'all') {
        const limitDate = new Date();
        limitDate.setDate(limitDate.getDate() - parseInt(period));
        const limitStr = formatDate(limitDate);
        datesToPlot = sortedDates.filter(d => d >= limitStr);
        
        // If we have no dates in range (e.g. initial date is today), make sure we plot something
        if (datesToPlot.length === 0 && sortedDates.length > 0) {
            datesToPlot = [sortedDates[sortedDates.length - 1]];
        }
    }
    
    const labels = datesToPlot.map(formatDateDisplay);
    const dataPoints = datesToPlot.map(d => parseFloat(balanceByDate[d].toFixed(2)));
    
    const ctx = document.getElementById('balanceChart').getContext('2d');
    
    // Destroy previous chart if it exists
    if (balanceChart) {
        balanceChart.destroy();
    }
    
    // Theme options
    const isLight = document.body.classList.contains('light-mode');
    
    // Indigo neon theme gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    if (isLight) {
        gradient.addColorStop(0, 'rgba(79, 70, 229, 0.2)');
        gradient.addColorStop(1, 'rgba(79, 70, 229, 0)');
    } else {
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.25)');
        gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
    }
    
    balanceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Saldo Disponível',
                data: dataPoints,
                borderColor: isLight ? '#4f46e5' : '#6366f1',
                borderWidth: 3,
                backgroundColor: gradient,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: isLight ? '#4f46e5' : '#6366f1',
                pointBorderColor: isLight ? '#ffffff' : '#0a0e1a',
                pointBorderWidth: 2,
                pointRadius: datesToPlot.length > 30 ? 0 : 4,
                pointHoverRadius: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isLight ? '#ffffff' : '#111827',
                    titleColor: isLight ? '#0f172a' : '#f8fafc',
                    bodyColor: isLight ? '#0f172a' : '#f8fafc',
                    titleFont: { family: 'Plus Jakarta Sans', size: 12 },
                    bodyFont: { family: 'Plus Jakarta Sans', size: 14, weight: 'bold' },
                    borderColor: isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.08)',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function(context) {
                            return ' Saldo: R$ ' + context.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: isLight ? '#475569' : '#94a3b8',
                        font: { family: 'Plus Jakarta Sans', size: 10 },
                        maxTicksLimit: 8
                    }
                },
                y: {
                    grid: { color: isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.04)' },
                    ticks: {
                        color: isLight ? '#475569' : '#94a3b8',
                        font: { family: 'Plus Jakarta Sans', size: 10 },
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
                        }
                    }
                }
            }
        }
    });
}

function changeChartPeriod(period) {
    currentChartPeriod = period;
    
    // Update active button state
    document.querySelectorAll('.chart-filters .btn-filter').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const event = window.event;
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    updateHistoricalChart();
}

// --- 6. SIMULATIONS ENGINE ---

function updateQuickSimulations() {
    const balance = currentBalance;
    const cdiPercentage = appState.initialSetup ? (appState.initialSetup.cdiPercentage || 100) : 100;
    const baseDailyCdiRate = Math.pow(1 + annualCdiRate / 100, 1 / 252) - 1;
    const dailyCdiRate = baseDailyCdiRate * (cdiPercentage / 100);
    
    // Estimates based on 21 business days per month (standard average)
    const simulatePeriod = (days) => {
        let simBalance = balance;
        for (let i = 0; i < days; i++) {
            simBalance += simBalance * dailyCdiRate;
        }
        return simBalance - balance;
    };
    
    const sim1m = document.getElementById('quick-sim-1m');
    const sim6m = document.getElementById('quick-sim-6m');
    const sim1y = document.getElementById('quick-sim-1y');
    
    if (sim1m) sim1m.innerText = '+' + simulatePeriod(21).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    if (sim6m) sim6m.innerText = '+' + simulatePeriod(126).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    if (sim1y) sim1y.innerText = '+' + simulatePeriod(252).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function quickSimulate(days) {
    showTab('simulation');
    
    // Fill the detailed simulator with current values
    document.getElementById('sim-initial-amount').value = Math.round(currentBalance);
    document.getElementById('sim-period-value').value = days;
    document.getElementById('sim-period-unit').value = 'business-days';
    // Calculate the applied CDI rate: Selic * percentage / 100
    const cdiPercentage = appState.initialSetup ? (appState.initialSetup.cdiPercentage || 100) : 100;
    const appliedCdiRate = annualCdiRate * (cdiPercentage / 100);
    document.getElementById('sim-cdi-rate').value = appliedCdiRate.toFixed(2);
    document.getElementById('sim-include-monthly-deposit').checked = false;
    document.getElementById('monthly-deposit-container').classList.add('hidden');
    
    runDetailedSimulation();
    showToast('Valores carregados no simulador!', 'success');
}

function runDetailedSimulation() {
    const initialAmount = parseFloat(document.getElementById('sim-initial-amount').value) || 0;
    const periodValue = parseInt(document.getElementById('sim-period-value').value) || 365;
    const periodUnit = document.getElementById('sim-period-unit').value;
    const cdiRate = parseFloat(document.getElementById('sim-cdi-rate').value) || 10.50;
    const includeMonthly = document.getElementById('sim-include-monthly-deposit').checked;
    const monthlyAmount = parseFloat(document.getElementById('sim-monthly-amount').value) || 0;
    
    let totalDays = 0;
    if (periodUnit === 'days') {
        totalDays = periodValue;
    } else if (periodUnit === 'business-days') {
        // Average business days converter: 252 business days / 365 calendar days
        totalDays = Math.ceil(periodValue * (365 / 252));
    } else if (periodUnit === 'months') {
        totalDays = periodValue * 30;
    } else if (periodUnit === 'years') {
        totalDays = periodValue * 365;
    }
    
    const dailyCdiRate = Math.pow(1 + cdiRate / 100, 1 / 252) - 1;
    
    let balance = initialAmount;
    let totalAportes = initialAmount;
    let simDate = new Date();
    
    const labels = [];
    const balanceData = [];
    const depositsData = [];
    
    labels.push(formatDateDisplay(formatDate(simDate)));
    balanceData.push(balance);
    depositsData.push(totalAportes);
    
    let businessDaysCount = 0;
    let stopSim = false;
    
    for (let d = 1; d <= totalDays; d++) {
        simDate.setDate(simDate.getDate() + 1);
        
        const isBiz = isBusinessDay(simDate);
        if (periodUnit === 'business-days' && isBiz) {
            businessDaysCount++;
            if (businessDaysCount > periodValue) {
                stopSim = true;
            }
        }
        
        if (stopSim) break;
        
        // Aporte recorrente a cada 30 dias corridos
        if (includeMonthly && d % 30 === 0) {
            balance += monthlyAmount;
            totalAportes += monthlyAmount;
        }
        
        // Aplica rendimento do dia útil
        if (isBiz && balance > 0) {
            const dailyYield = balance * dailyCdiRate;
            balance += dailyYield;
        }
        
        // Sample points to prevent chart overflow
        let shouldPlot = false;
        if (totalDays <= 90) {
            shouldPlot = true;
        } else if (totalDays <= 365) {
            shouldPlot = d % 7 === 0;
        } else {
            shouldPlot = d % 30 === 0;
        }
        
        if (shouldPlot || d === totalDays) {
            labels.push(formatDateDisplay(formatDate(simDate)));
            balanceData.push(parseFloat(balance.toFixed(2)));
            depositsData.push(totalAportes);
        }
    }
    
    // Final values displays
    document.getElementById('sim-res-final-value').innerText = balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('sim-res-total-deposits').innerText = totalAportes.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('sim-res-total-yield').innerText = (balance - totalAportes).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    
    renderSimulationChart(labels, balanceData, depositsData);
}

function renderSimulationChart(labels, balanceData, depositsData) {
    const ctx = document.getElementById('simulationChart').getContext('2d');
    
    if (simulationChart) {
        simulationChart.destroy();
    }
    
    const isLight = document.body.classList.contains('light-mode');
    
    const gradBal = ctx.createLinearGradient(0, 0, 0, 300);
    if (isLight) {
        gradBal.addColorStop(0, 'rgba(5, 150, 105, 0.2)');
        gradBal.addColorStop(1, 'rgba(5, 150, 105, 0)');
    } else {
        gradBal.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
        gradBal.addColorStop(1, 'rgba(16, 185, 129, 0)');
    }
    
    simulationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Patrimônio Estimado',
                    data: balanceData,
                    borderColor: isLight ? '#059669' : '#10b981',
                    borderWidth: 2,
                    backgroundColor: gradBal,
                    fill: true,
                    tension: 0.2,
                    pointRadius: 0
                },
                {
                    label: 'Total de Aportes',
                    data: depositsData,
                    borderColor: '#94a3b8',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { 
                    display: true, 
                    labels: { color: isLight ? '#0f172a' : '#f8fafc', font: { family: 'Plus Jakarta Sans' } }
                },
                tooltip: {
                    backgroundColor: isLight ? '#ffffff' : '#111827',
                    titleColor: isLight ? '#0f172a' : '#f8fafc',
                    bodyColor: isLight ? '#0f172a' : '#f8fafc',
                    titleFont: { family: 'Plus Jakarta Sans' },
                    bodyFont: { family: 'Plus Jakarta Sans' },
                    borderColor: isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.08)',
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return ` ${context.dataset.label}: R$ ` + context.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: isLight ? '#475569' : '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 9 }, maxTicksLimit: 8 }
                },
                y: {
                    grid: { color: isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.04)' },
                    ticks: {
                        color: isLight ? '#475569' : '#94a3b8',
                        font: { family: 'Plus Jakarta Sans', size: 9 },
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
                        }
                    }
                }
            }
        }
    });
}

// --- 7. TOAST NOTIFICATIONS ---

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    
    // Automatically delete after 4s (matching keyframes)
    setTimeout(() => {
        toast.remove();
    }, 4000);
}

// --- 8. MODAL WINDOWS CONTROLLER ---

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('active');
        
        // Auto fill date field with today
        const dateInput = modal.querySelector('input[type="date"]');
        if (dateInput && !dateInput.value) {
            dateInput.value = formatDate(new Date());
        }
        
        // Pre-fill percentage input when opening cdiModal
        if (id === 'cdiModal') {
            const pctInput = document.getElementById('config-cdi-percentage');
            if (pctInput && appState.initialSetup) {
                pctInput.value = appState.initialSetup.cdiPercentage || 100;
            }
        }
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('active');
        
        // Clear transaction forms (except dates)
        const amountInput = modal.querySelector('input[type="number"]');
        if (amountInput) amountInput.value = '';
        
        const respInput = document.getElementById('withdraw-responsible');
        if (respInput) respInput.value = '';
    }
}

// Close modals when clicking outside
window.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-overlay')) {
        event.target.classList.remove('active');
    }
});

// --- 9. SETUP & FORMS SUBMISSIONS ---

function saveInitialSetup() {
    const balInput = document.getElementById('setup-initial-balance');
    const dateInput = document.getElementById('setup-start-date');
    const pctInput = document.getElementById('setup-cdi-percentage');
    
    const balance = parseFloat(balInput.value);
    const dateStr = dateInput.value;
    const percentage = parseInt(pctInput.value);
    
    if (isNaN(balance) || !dateStr || isNaN(percentage)) {
        showToast('Por favor, preencha todos os campos corretamente.', 'error');
        return;
    }
    
    if (balance < 0) {
        showToast('O saldo inicial não pode ser negativo.', 'error');
        return;
    }
    
    if (percentage <= 0) {
        showToast('A rentabilidade deve ser maior que 0%.', 'error');
        return;
    }
    
    appState.initialSetup = {
        balance: balance,
        date: dateStr,
        cdiPercentage: percentage
    };
    appState.manualTransactions = [];
    
    saveState();
    recalculateHistory();
    updateDashboardUI();
    closeModal('setupModal');
    showToast('Configuração inicial salva com sucesso!', 'success');
}

function submitDeposit() {
    if (!appState.initialSetup) {
        showToast('Erro: Faça a configuração inicial primeiro.', 'error');
        openModal('setupModal');
        return;
    }
    const amountVal = parseFloat(document.getElementById('deposit-amount').value);
    const dateVal = document.getElementById('deposit-date').value;
    const descVal = document.getElementById('deposit-description').value.trim() || 'Depósito';
    
    if (isNaN(amountVal) || amountVal <= 0 || !dateVal) {
        showToast('Preencha um valor válido maior que zero e selecione a data.', 'error');
        return;
    }
    
    // Deposit date cannot be before initial setup date
    if (dateVal < appState.initialSetup.date) {
        showToast(`A data não pode ser anterior à data inicial (${formatDateDisplay(appState.initialSetup.date)}).`, 'error');
        return;
    }
    
    const newTx = {
        id: 'dep_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        date: dateVal,
        type: 'DEPOSIT',
        amount: amountVal,
        description: descVal
    };
    
    appState.manualTransactions.push(newTx);
    saveState();
    recalculateHistory();
    updateDashboardUI();
    closeModal('depositModal');
    showToast('Depósito inserido com sucesso!', 'success');
}

function submitWithdraw() {
    if (!appState.initialSetup) {
        showToast('Erro: Faça a configuração inicial primeiro.', 'error');
        openModal('setupModal');
        return;
    }
    const amountVal = parseFloat(document.getElementById('withdraw-amount').value);
    const dateVal = document.getElementById('withdraw-date').value;
    const descVal = document.getElementById('withdraw-description').value.trim() || 'Retirada';
    const responsibleVal = document.getElementById('withdraw-responsible').value.trim();
    
    if (isNaN(amountVal) || amountVal <= 0 || !dateVal || !responsibleVal) {
        showToast('Preencha o valor, data e o responsável pela retirada.', 'error');
        return;
    }
    
    // Date cannot be before setup date
    if (dateVal < appState.initialSetup.date) {
        showToast(`A data não pode ser anterior à data inicial (${formatDateDisplay(appState.initialSetup.date)}).`, 'error');
        return;
    }
    
    // Quick recalculation check to prevent negative balance if desired, but we warn instead of blocking
    const tempBalance = currentBalance - amountVal;
    if (tempBalance < 0) {
        if (!confirm('Atenção: Essa retirada deixará seu saldo negativo. Deseja continuar?')) {
            return;
        }
    }
    
    const newTx = {
        id: 'wit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        date: dateVal,
        type: 'WITHDRAW',
        amount: amountVal,
        description: descVal,
        responsible: responsibleVal
    };
    
    appState.manualTransactions.push(newTx);
    saveState();
    recalculateHistory();
    updateDashboardUI();
    closeModal('withdrawModal');
    showToast('Retirada registrada!', 'success');
}

function submitCdiChange() {
    const pctVal = parseInt(document.getElementById('config-cdi-percentage').value);
    
    if (isNaN(pctVal) || pctVal <= 0) {
        showToast('Porcentagem inválida. Digite um número inteiro positivo.', 'error');
        return;
    }
    
    appState.initialSetup.cdiPercentage = pctVal;
    saveState();
    recalculateHistory();
    updateDashboardUI();
    closeModal('cdiModal');
    showToast(`Rentabilidade alterada para ${pctVal}% do CDI!`, 'success');
}

// --- 10. BACKUP SYSTEMS ---

function exportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `Controle_Caixa_Backup_${formatDate(new Date())}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('Backup exportado com sucesso!', 'success');
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedState = JSON.parse(e.target.result);
            if (importedState.initialSetup && Array.isArray(importedState.manualTransactions)) {
                appState = importedState;
                saveState();
                recalculateHistory();
                updateDashboardUI();
                showToast('Backup importado com sucesso!', 'success');
                event.target.value = ''; // Reset file input
            } else {
                showToast('Arquivo de backup inválido.', 'error');
            }
        } catch (err) {
            showToast('Erro ao ler arquivo JSON de backup.', 'error');
        }
    };
    reader.readAsText(file);
}

async function confirmResetAll() {
    if (confirm('Tem certeza absoluta que deseja apagar TODOS os seus dados? Esta ação é irreversível.')) {
        // Se a sincronização em nuvem estiver ativa, apaga os dados na nuvem também
        if (appState.cloudConfig && appState.cloudConfig.enabled) {
            const { dbUrl, dbKey } = appState.cloudConfig;
            if (dbUrl && dbKey) {
                let cleanUrl = dbUrl.trim();
                if (cleanUrl.endsWith('/')) {
                    cleanUrl = cleanUrl.slice(0, -1);
                }
                const endpoint = `${cleanUrl}/caixas/${dbKey}.json`;
                try {
                    await fetch(endpoint, {
                        method: 'DELETE'
                    });
                } catch (e) {
                    console.error("Erro ao apagar dados da nuvem:", e);
                    showToast('Aviso: Falha ao apagar dados na nuvem. Verifique a conexão.', 'error');
                }
            }
        }

        localStorage.removeItem('controle_caixa_state');
        localStorage.removeItem('girocdi_state');
        appState = { initialSetup: null, manualTransactions: [] };
        showToast('Todos os dados foram resetados.', 'success');
        
        // Reload page to prompt setup modal again
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    }
}

// --- 11. TAB CONTROLLER ---

function showTab(tabName) {
    // Update active tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    // Update sidebar navigation active links
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('data-tab') === tabName) {
            item.classList.add('active');
        }
    });
    
    // Recalculate layout or redraw charts if needed (Chart.js needs visible canvas on initialization)
    if (tabName === 'dashboard') {
        setTimeout(updateHistoricalChart, 50);
    } else if (tabName === 'simulation') {
        // Preset simulation using current totals
        document.getElementById('sim-initial-amount').value = Math.round(currentBalance);
        setTimeout(runDetailedSimulation, 50);
    }
}

// Bind Navigation Clicks
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = item.getAttribute('data-tab');
        showTab(tab);
    });
});

// Bind Monthly Deposit input toggle in Simulator
document.getElementById('sim-include-monthly-deposit').addEventListener('change', (e) => {
    const container = document.getElementById('monthly-deposit-container');
    if (e.target.checked) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
});

// --- 12. CENTRAL BANK OF BRAZIL CDI API FETCH ---

async function fetchLatestCDI() {
    // Tenta primeiro via BrasilAPI (que possui CORS totalmente liberado e é ideal para frontend puro)
    try {
        const response = await fetch('https://brasilapi.com.br/api/taxas/v1');
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) {
                const cdiItem = data.find(item => item.nome === 'CDI');
                if (cdiItem && typeof cdiItem.valor === 'number') {
                    return cdiItem.valor;
                }
            }
        }
    } catch (e) {
        console.warn("Falha ao buscar taxa CDI via BrasilAPI, tentando Banco Central...", e);
    }

    // Fallback: API direta do Banco Central do Brasil (SGS)
    try {
        const response = await fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json');
        if (!response.ok) throw new Error('Erro ao obter taxa CDI da API do Banco Central');
        const data = await response.json();
        if (data && data.length > 0) {
            const val = parseFloat(data[0].valor);
            if (!isNaN(val) && val > 0) {
                return val;
            }
        }
    } catch (e) {
        console.error("Erro na busca de taxa de CDI:", e);
    }
    return null;
}

function updateCdiFieldsWithFetchedRate() {
    const setupStatus = document.getElementById('setup-cdi-status');
    const configStatus = document.getElementById('config-cdi-status');
    
    fetchLatestCDI().then(rate => {
        if (rate !== null) {
            annualCdiRate = rate;
            localStorage.setItem('controle_caixa_cached_cdi', rate.toString());
            
            // Recalculate history and dashboard with the real-time rate immediately
            if (appState.initialSetup) {
                recalculateHistory();
                updateDashboardUI();
            }
            
            // Setup default inputs values if needed
            const setupInput = document.getElementById('setup-cdi-percentage');
            const configInput = document.getElementById('config-cdi-percentage');
            
            if (setupInput && !setupInput.value) setupInput.value = 100;
            if (configInput && appState.initialSetup) configInput.value = appState.initialSetup.cdiPercentage || 100;
            
            if (setupStatus) {
                setupStatus.innerHTML = `${rate.toFixed(2).replace('.', ',')}% a.a. <span style="font-size: 0.75rem; color: var(--accent-emerald);"> (Carregado hoje via Banco Central)</span>`;
            }
            if (configStatus) {
                configStatus.innerHTML = `${rate.toFixed(2).replace('.', ',')}% a.a. <span style="font-size: 0.75rem; color: var(--accent-emerald);"> (Carregado hoje via Banco Central)</span>`;
            }
        } else {
            if (setupStatus) {
                setupStatus.innerHTML = `${annualCdiRate.toFixed(2).replace('.', ',')}% a.a. <span style="font-size: 0.75rem; color: var(--text-secondary);"> (Offline - Usando taxa salva)</span>`;
            }
            if (configStatus) {
                configStatus.innerHTML = `${annualCdiRate.toFixed(2).replace('.', ',')}% a.a. <span style="font-size: 0.75rem; color: var(--text-secondary);"> (Offline - Usando taxa salva)</span>`;
            }
        }
    });
}

// --- 13. URL PARAMETERS HANDLER ---

function handleUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlKey = urlParams.get('caixa') || urlParams.get('chave');
    
    if (urlKey) {
        appState.cloudConfig = {
            enabled: true,
            dbUrl: "https://fluxo-de-caixa-b25d5-default-rtdb.firebaseio.com/",
            dbKey: urlKey
        };
        saveState();
        return true;
    }
    return false;
}

// --- 14. INITIALIZATION ON LOAD ---

window.addEventListener('DOMContentLoaded', () => {
    // Verificar e aplicar preferência de tema antes de carregar dados
    const savedTheme = localStorage.getItem('theme');
    const isLight = savedTheme === 'light';
    if (isLight) {
        document.body.classList.add('light-mode');
    }
    const btn = document.getElementById('theme-toggle');
    if (btn) {
        btn.innerHTML = isLight ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    }

    const hasData = loadState();
    
    // Handle URL parameters to dynamically configure cloud sync
    handleUrlParameters();
    
    // Fetch latest CDI rate to pre-fill fields automatically
    updateCdiFieldsWithFetchedRate();
    
    if (hasData && appState.initialSetup) {
        recalculateHistory();
        updateDashboardUI();
        
        // Sincronização automática com a nuvem na inicialização
        syncFromCloud();
    } else {
        // Tenta buscar da nuvem antes de exigir configuração inicial
        syncFromCloud().then(synced => {
            if (!synced) {
                openModal('setupModal');
                document.getElementById('setup-start-date').value = formatDate(new Date());
            }
        });
    }
});

// --- 14. CLOUD SYNC LOGIC (FIREBASE REST) ---

async function syncFromCloud() {
    if (!appState.cloudConfig || !appState.cloudConfig.enabled) return false;
    
    const { dbUrl, dbKey } = appState.cloudConfig;
    if (!dbUrl || !dbKey) return false;
    
    let cleanUrl = dbUrl.trim();
    if (cleanUrl.endsWith('/')) {
        cleanUrl = cleanUrl.slice(0, -1);
    }
    
    const endpoint = `${cleanUrl}/caixas/${dbKey}.json`;
    const statusDiv = document.getElementById('cloud-sync-status');
    
    try {
        if (statusDiv) statusDiv.innerHTML = `<span style="color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Sincronizando com a nuvem...</span>`;
        
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error('Erro na resposta do servidor');
        const data = await res.json();
        
        if (data && data.initialSetup) {
            appState.initialSetup = data.initialSetup;
            appState.manualTransactions = data.manualTransactions || [];
            
            // Save locally cached state
            localStorage.setItem('controle_caixa_state', JSON.stringify(appState));
            
            recalculateHistory();
            updateDashboardUI();
            
            if (statusDiv) {
                statusDiv.innerHTML = `<span style="color: var(--accent-emerald);"><i class="fa-solid fa-circle-check"></i> Sincronizado em tempo real! (Atualizado: ${new Date().toLocaleTimeString('pt-BR')})</span>`;
            }
            return true;
        } else {
            // No data on cloud or no initial setup on cloud
            if (appState.initialSetup) {
                if (statusDiv) statusDiv.innerHTML = `<span style="color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Inicializando caixa na nuvem...</span>`;
                await syncToCloud();
                return true;
            } else {
                if (statusDiv) {
                    statusDiv.innerHTML = `<span style="color: var(--accent-rose);"><i class="fa-solid fa-triangle-exclamation"></i> Aguardando configuração inicial...</span>`;
                }
                return false;
            }
        }
    } catch (e) {
        console.error("Erro ao sincronizar com a nuvem:", e);
        if (statusDiv) {
            statusDiv.innerHTML = `<span style="color: var(--accent-rose);"><i class="fa-solid fa-circle-xmark"></i> Offline. Usando dados locais do navegador.</span>`;
        }
        showToast('Não foi possível conectar à nuvem. Usando cache local.', 'error');
    }
    return false;
}

async function syncToCloud() {
    if (!appState.cloudConfig || !appState.cloudConfig.enabled) return;
    
    const { dbUrl, dbKey } = appState.cloudConfig;
    if (!dbUrl || !dbKey) return;
    
    let cleanUrl = dbUrl.trim();
    if (cleanUrl.endsWith('/')) {
        cleanUrl = cleanUrl.slice(0, -1);
    }
    
    const endpoint = `${cleanUrl}/caixas/${dbKey}.json`;
    const statusDiv = document.getElementById('cloud-sync-status');
    
    try {
        const payload = {
            initialSetup: appState.initialSetup,
            manualTransactions: appState.manualTransactions
        };
        
        const res = await fetch(endpoint, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error('Erro ao salvar dados na nuvem');
        if (statusDiv) {
            statusDiv.innerHTML = `<span style="color: var(--accent-emerald);"><i class="fa-solid fa-cloud-arrow-up"></i> Alterações salvas na nuvem! (${new Date().toLocaleTimeString('pt-BR')})</span>`;
        }
    } catch (e) {
        console.error("Erro ao enviar dados para a nuvem:", e);
        if (statusDiv) {
            statusDiv.innerHTML = `<span style="color: var(--accent-rose);"><i class="fa-solid fa-circle-xmark"></i> Falha ao atualizar dados na nuvem.</span>`;
        }
        showToast('Erro ao atualizar na nuvem. Alteração salva localmente.', 'error');
    }
}

// Removidas funções obsoletas de configuração manual de nuvem.

// Alternar Tema Claro / Escuro
function toggleTheme() {
    const body = document.body;
    const btn = document.getElementById('theme-toggle');
    body.classList.toggle('light-mode');
    
    const isLight = body.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    
    // Atualizar ícone do botão
    if (btn) {
        btn.innerHTML = isLight ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    }
    
    // Redesenhar gráficos com cores atualizadas
    if (balanceChart) {
        updateHistoricalChart();
    }
    
    // Redesenhar gráfico de simulação se estiver ativo
    const simTab = document.getElementById('tab-simulation');
    if (simTab && simTab.classList.contains('active')) {
        runDetailedSimulation();
    }
}
