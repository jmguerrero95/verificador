const { TronWeb } = require('tronweb');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const axiosRetry = require('axios-retry').default;
const pLimit = require('p-limit').default;
const { HttpsAgent } = require('agentkeepalive');
const PDFDocument = require('pdfkit');
const fs = require('fs');

// Configuración general
const USDT_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MAX_LEVEL = 2; // Define la profundidad del análisis
const TRONSCAN_API_KEY = '07b6f4f5-dbb7-47f2-8ec1-d7186792e609'; // Considera moverla a .env
const CHAINALYSIS_API_KEY = 'b6aa80bb3ed60ecc1164d4e91f03991a55b772366a0ae3669db76892fe323f35'; // API Key de Chainalysis
const CHAINALYSIS_API_URL = 'https://public.chainalysis.com/api/v1/address/';

const BLACKLIST_FILE = 'blacklist.txt';
let BLACKLIST = new Set();

try {
    if (fs.existsSync(BLACKLIST_FILE)) {
        BLACKLIST = new Set(
            fs.readFileSync(BLACKLIST_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim().toLowerCase())
            .filter(l => l)
        );
        console.log(`[CONFIG] Lista negra cargada desde ${BLACKLIST_FILE} con ${BLACKLIST.size} direcciones.`);
    } else {
        console.warn(`[CONFIG WARN] El archivo ${BLACKLIST_FILE} no existe. La lista negra local estará vacía.`);
    }
} catch (error) {
    console.error(`[CONFIG ERROR] No se pudo cargar la lista negra desde ${BLACKLIST_FILE}: ${error.message}`);
}


// Optimización de requests
// Limitador para TronScan API (ej. 3 RPS)
const tronscanLimiter = new Bottleneck({
    reservoir: 3,
    reservoirRefreshAmount: 3,
    reservoirRefreshInterval: 1000, // 3 requests por segundo
    maxConcurrent: 2
});

// Limitador para Chainalysis API (15 RPS)
const chainalysisLimiter = new Bottleneck({
    reservoir: 15,
    reservoirRefreshAmount: 15,
    reservoirRefreshInterval: 1000, // 15 requests por segundo
    maxConcurrent: 10 // Permitir hasta 10 solicitudes concurrentes a Chainalysis
});

// Limita la concurrencia de promesas internas (ej. procesamiento de datos post-fetch)
const limitInternalConcurrency = pLimit(5);

axios.defaults = {
    httpAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 }),
    httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 }),
    timeout: 45000 // 45 segundos de timeout
};

axiosRetry(axios, {
    retries: 3,
    retryDelay: (retryCount, error) => {
        console.warn(`[AXIOS RETRY] Intento ${retryCount} fallido para ${error.config.url}. Reintentando en ${axiosRetry.exponentialDelay(retryCount, error, 1000)} ms...`);
        return axiosRetry.exponentialDelay(retryCount, error, 1000);
    },
    retryCondition: e =>
        e.response?.status === 429 || // Too Many Requests
        e.response?.status === 500 || // Internal Server Error
        e.response?.status === 502 || // Bad Gateway
        e.response?.status === 503 || // Service Unavailable
        e.response?.status === 504    // Gateway Timeout
});

const txCache = new Map(); // Caché para las transacciones obtenidas

function tronWeb() {
    return new TronWeb({
        fullHost: 'https://api.tronscan.org',
    });
}

// Verifica si una dirección está en la lista negra local.
async function isBlacklisted(addr) {
    return BLACKLIST.has(addr?.toLowerCase());
}

// Obtiene información de sanción de Chainalysis para una dirección.
async function getChainalysisSanctionInfo(address) {
    if (!address) return null;
    const url = `${CHAINALYSIS_API_URL}${address}`;
    console.log(`[CHAINALYSIS API] Verificando dirección: ${address}`);
    try {
        const response = await chainalysisLimiter.schedule(() =>
            axios.get(url, {
                headers: {
                    'X-API-Key': CHAINALYSIS_API_KEY,
                    'Accept': 'application/json'
                }
            })
        );
        if (response.data && response.data.identifications && response.data.identifications.length > 0) {
            console.log(`[CHAINALYSIS HIT] Dirección ${address} SANCIONADA. Detalles: ${JSON.stringify(response.data.identifications)}`);
            return response.data.identifications;
        }
        console.log(`[CHAINALYSIS OK] Dirección ${address} no encontrada en listas de sanciones de Chainalysis.`);
        return null;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log(`[CHAINALYSIS INFO] Dirección ${address} no encontrada en la base de datos de Chainalysis (404).`);
            return null;
        }
        console.error(`[CHAINALYSIS ERROR] Error consultando Chainalysis para ${address}: ${error.message}`, error.response ? error.response.data : '');
        return { error: `Error API Chainalysis: ${error.message.substring(0,100)}`};
    }
}


async function getAllTransfers(address) {
    console.log(`\n[TRANSFER] Iniciando para: ${address}`);
    if (txCache.has(address)) {
        console.log(`[CACHE] Usando transacciones almacenadas para ${address} (${txCache.get(address).length})`);
        return txCache.get(address);
    }

    let transfers = [];
    let start = 0;
    const limit = 50;
    let emptyPages = 0;
    const MAX_EMPTY_PAGES = 2; // Detener si se encuentran 2 páginas vacías seguidas
    const SAFETY_PAGE_LIMIT = 100; // Límite de seguridad para evitar bucles infinitos (100 * 50 = 5000 tx)

    try {
        let currentPage = 0;
        do {
            currentPage++;
            console.log(`[TRONSCAN API] Buscando transferencias para ${address}, Página ${currentPage}, Start: ${start}`);

            const response = await tronscanLimiter.schedule(() =>
                axios.get('https://api.tronscan.org/api/token_trc20/transfers', {
                    params: {
                        contract_address: USDT_ADDR,
                        relatedAddress: address,
                        start,
                        limit,
                        sort: '-timestamp', // Opcional: ordenar por más reciente
                    },
                    headers: {
                        'TRON-PRO-API-KEY': TRONSCAN_API_KEY,
                        'Accept': 'application/json'
                    }
                })
            );

            if (!response.data || typeof response.data.token_transfers === 'undefined') {
                throw new Error('Estructura de respuesta inválida de TronScan API. Falta "token_transfers".');
            }

            const foundTransfers = response.data.token_transfers;

            if (foundTransfers.length === 0) {
                emptyPages++;
                console.log(`[TRONSCAN API] Página ${currentPage} vacía para ${address} (${emptyPages} consecutivas)`);
                if (emptyPages >= MAX_EMPTY_PAGES) {
                    console.log(`[TRONSCAN API] Deteniendo paginación para ${address} debido a ${emptyPages} páginas vacías consecutivas.`);
                    break;
                }
            } else {
                emptyPages = 0;
                transfers = transfers.concat(foundTransfers);
                console.log(`[TRONSCAN API] Transacciones obtenidas en página ${currentPage} para ${address}: ${foundTransfers.length}. Total acumulado: ${transfers.length}`);
            }
            
            // Condición de salida mejorada: si la API devuelve menos del límite, es probable que sea la última página.
            if (foundTransfers.length < limit) {
                 console.log(`[TRONSCAN API] Página ${currentPage} para ${address} tiene ${foundTransfers.length} registros (menos que el límite de ${limit}), asumiendo fin de datos.`);
                 break;
            }
            start += limit;

        } while (currentPage < SAFETY_PAGE_LIMIT);

        if (currentPage >= SAFETY_PAGE_LIMIT) {
            console.warn(`[TRONSCAN API WARN] Se alcanzó el límite de ${SAFETY_PAGE_LIMIT} páginas para ${address}. Pueden faltar transacciones.`);
        }

        console.log(`[TRANSFER] Finalizado para ${address} | Total: ${transfers.length} transacciones encontradas.`);
        txCache.set(address, transfers);
        return transfers;
    } catch (err) {
        console.error(`[ERROR en getAllTransfers para ${address}]: ${err.message}`, err.response ? err.response.data : '');
        throw err;
    }
}

async function getCounterparties(root) {
    console.log(`\n=== ANÁLISIS DE CONTRAPARTES PARA ${root} (hasta ${MAX_LEVEL} niveles) ===`);
    const visitedLowerCase = new Set([root.toLowerCase()]); // Almacena todas las direcciones visitadas en minúscula para evitar ciclos y duplicados
    let currentLevelAddressesOriginalCase = [root]; // Direcciones a procesar en el nivel actual, con casing original
    let allStats = []; // Estadísticas por nivel
    let level = 1;

    while (level <= MAX_LEVEL && currentLevelAddressesOriginalCase.length > 0) {
        console.log(`\n[PROCESANDO NIVEL ${level}] Direcciones a analizar: ${currentLevelAddressesOriginalCase.length}`);
        let transactionsCountInLevel = 0;
        let nextLevelCounterpartiesOriginalCase = new Set(); // Contrapartes (casing original) encontradas en este nivel

        // Procesar todas las direcciones del nivel actual
        const promises = currentLevelAddressesOriginalCase.map(addr =>
            limitInternalConcurrency(async () => { // Limita la concurrencia de estas operaciones internas
                try {
                    console.log(`  [NIVEL ${level}] Procesando dirección: ${addr}`);
                    const transfers = await getAllTransfers(addr); // Usa tronscanLimiter
                    transactionsCountInLevel += transfers.length;

                    transfers.forEach(tx => {
                        const fromAddrOriginal = tx.from_address;
                        const toAddrOriginal = tx.to_address;
                        const fromLower = fromAddrOriginal?.toLowerCase();
                        const toLower = toAddrOriginal?.toLowerCase();

                        // Analizar la dirección 'from'
                        if (fromLower && fromLower !== addr.toLowerCase() && !visitedLowerCase.has(fromLower)) {
                            nextLevelCounterpartiesOriginalCase.add(fromAddrOriginal);
                            visitedLowerCase.add(fromLower);
                        }
                        // Analizar la dirección 'to'
                        if (toLower && toLower !== addr.toLowerCase() && !visitedLowerCase.has(toLower)) {
                            nextLevelCounterpartiesOriginalCase.add(toAddrOriginal);
                            visitedLowerCase.add(toLower);
                        }
                    });
                } catch (err) {
                    console.error(`  [ERROR NIVEL ${level}] Error procesando ${addr}: ${err.message}`);
                }
            })
        );
        await Promise.all(promises);

        console.log(`\n  [RESUMEN NIVEL ${level}]`);
        console.log(`  - Direcciones de este nivel procesadas: ${currentLevelAddressesOriginalCase.length}`);
        console.log(`  - Transacciones totales analizadas en este nivel: ${transactionsCountInLevel}`);
        console.log(`  - Nuevas contrapartes únicas encontradas para el siguiente nivel: ${nextLevelCounterpartiesOriginalCase.size}`);

        allStats.push({
            level: level,
            processedAddresses: currentLevelAddressesOriginalCase.length,
            analyzedTransactions: transactionsCountInLevel,
            newCounterpartiesFound: nextLevelCounterpartiesOriginalCase.size
        });

        if (nextLevelCounterpartiesOriginalCase.size === 0) {
            console.log(`[FIN ANÁLISIS PROFUNDO] No se encontraron nuevas contrapartes en el nivel ${level}. Deteniendo.`);
            break;
        }

        currentLevelAddressesOriginalCase = [...nextLevelCounterpartiesOriginalCase];
        level++;
    }

    // Excluir la dirección raíz de la lista final de contrapartes
    visitedLowerCase.delete(root.toLowerCase());

    const totalTransactionsProcessed = allStats.reduce((acc, s) => acc + s.analyzedTransactions, 0);
    console.log(`\n=== RESUMEN FINAL DEL ANÁLISIS DE CONTRAPARTES ===`);
    console.log(`  Contrapartes únicas totales encontradas (excluyendo raíz, en minúscula): ${visitedLowerCase.size}`);
    console.log(`  Transacciones totales procesadas en todos los niveles: ${totalTransactionsProcessed}`);

    return {
        addresses: [...visitedLowerCase], // Direcciones de contrapartes en minúscula
        stats: allStats
    };
}


function definePDFStyles(doc) {
    doc.registerFont('Bold', 'Helvetica-Bold');
    doc.registerFont('Regular', 'Helvetica');
    doc.registerFont('Light', 'Helvetica-Oblique');
}

function addHeader(doc, title) {
    doc.fontSize(20).font('Bold').text(title, { align: 'center' });
    doc.moveDown(1.5);
}

function addSectionTitle(doc, title) {
    doc.fontSize(16).font('Bold').text(title, { underline: false });
    doc.moveDown(0.7);
}

function addSubTitle(doc, title) {
    doc.fontSize(13).font('Bold').text(title);
    doc.moveDown(0.5);
}

function addParagraph(doc, text, options = {}) {
    doc.font('Regular').fontSize(10).text(text, options);
    doc.moveDown(options.moveDown || 0.5);
}

function addListItem(doc, text, color = 'black', indent = 0) {
    doc.fillColor(color).font('Regular').fontSize(10).text(`• ${text}`, { indent });
    doc.moveDown(0.3);
    doc.fillColor('black');
}

// generatePDF ahora toma un objeto analysisData más estructurado
async function generatePDF(path, rootAddress, analysisData) {
    console.log(`\n[REPORTE PDF] Generando PDF en: ${path}`);
    const {
        verdict,
        verdictExplanation,
        rootIsLocallyBlacklisted,
        rootChainalysisSanctions, // Puede ser array de sanciones o { error: string }
        stats, // Estadísticas de getCounterparties
        locallyBlacklistedCounterparties, // Array de direcciones string
        chainalysisSanctionedCounterparties, // Array de { address: string, levelFound: number, sanctions: array }
        errorInfo
    } = analysisData;

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        const stream = fs.createWriteStream(path);

        definePDFStyles(doc);
        doc.pipe(stream);

        addHeader(doc, 'Reporte de Análisis de Riesgo de Billetera TRON');

        addSectionTitle(doc, '1. Resumen Ejecutivo');
        addSubTitle(doc, 'Billetera Analizada:');
        addParagraph(doc, rootAddress);

        addSubTitle(doc, 'Fecha del Análisis:');
        addParagraph(doc, new Date().toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'medium'}));

        addSubTitle(doc, 'Veredicto General:');
        let verdictColor = 'black';
        if (verdict.includes('SANCIONADA') || verdict.includes('CRÍTICO')) verdictColor = 'red';
        else if (verdict.includes('ALTO RIESGO')) verdictColor = '#FF8C00';
        else if (verdict.includes('RIESGO MODERADO') || verdict.includes('BLOQUEADA')) verdictColor = '#FFA500';
        else if (verdict.includes('SEGURA')) verdictColor = 'green';
        else if (verdict.includes('ERROR')) verdictColor = 'darkred';

        doc.font('Bold').fontSize(12).fillColor(verdictColor).text(verdict);
        doc.fillColor('black').moveDown(0.3);
        if (verdictExplanation) {
            addParagraph(doc, verdictExplanation, {fontSize: 10});
        }
        if (errorInfo) {
             addParagraph(doc, `Detalles del Error: ${errorInfo}`, {fillColor: 'red'});
        }
        doc.moveDown();

        addSectionTitle(doc, `2. Detalles de la Billetera Principal: ${rootAddress}`);
        addSubTitle(doc, 'Resultado en Lista Negra Local:');
        addParagraph(doc, rootIsLocallyBlacklisted ? 'EN LISTA NEGRA LOCAL' : 'No encontrada en lista negra local.', { color: rootIsLocallyBlacklisted ? 'red' : 'green' });

        addSubTitle(doc, 'Verificación con Chainalysis:');
        if (rootChainalysisSanctions && rootChainalysisSanctions.error) {
            addParagraph(doc, `Error al consultar Chainalysis: ${rootChainalysisSanctions.error}`, { color: 'orange' });
        } else if (rootChainalysisSanctions && rootChainalysisSanctions.length > 0) {
            addParagraph(doc, 'SANCIONADA POR CHAINALYSIS', { color: 'red' });
            rootChainalysisSanctions.forEach(sanction => {
                addListItem(doc, `Identificación: ${sanction.name} (Categoría: ${sanction.category || 'N/A'})`, 'red');
            });
        } else {
            addParagraph(doc, 'No se encontraron sanciones por Chainalysis para la billetera principal.', { color: 'green' });
        }
        doc.moveDown();

        if (stats && stats.length > 0) {
            addSectionTitle(doc, `3. Análisis de Contrapartes (Hasta ${MAX_LEVEL} Niveles)`);
            addSubTitle(doc, 'Estadísticas del Rastreo:');
            stats.forEach(s => {
                addParagraph(doc, `Nivel ${s.level}: ${s.processedAddresses} direcciones procesadas, ${s.analyzedTransactions} transacciones analizadas, ${s.newCounterpartiesFound} nuevas contrapartes.`);
            });
            const totalCounterpartiesFromStats = stats.reduce((sum, s) => sum + s.newCounterpartiesFound, 0);
            const totalTransactions = stats.reduce((sum, s) => sum + s.analyzedTransactions, 0);
            addParagraph(doc, `Total Contrapartes Únicas Descubiertas: ${totalCounterpartiesFromStats}`);
            addParagraph(doc, `Total Transacciones Consideradas en el Rastreo: ${totalTransactions}`);
        } else if (!errorInfo && !(rootChainalysisSanctions && rootChainalysisSanctions.length > 0 && !rootChainalysisSanctions.error) ) { // No mostrar si la raíz ya era crítica y se detuvo
             addParagraph(doc, "No se realizó un análisis profundo de contrapartes o no se encontraron.");
        }
        doc.moveDown();

        const hasRiskyCounterparties = (locallyBlacklistedCounterparties && locallyBlacklistedCounterparties.length > 0) || (chainalysisSanctionedCounterparties && chainalysisSanctionedCounterparties.length > 0);

        if (hasRiskyCounterparties) {
            addSectionTitle(doc, '4. Hallazgos de Riesgo en Contrapartes');
            if (locallyBlacklistedCounterparties && locallyBlacklistedCounterparties.length > 0) {
                addSubTitle(doc, 'Contrapartes en Lista Negra Local:');
                locallyBlacklistedCounterparties.forEach(cpAddr => { // cpAddr es un string de dirección
                    addListItem(doc, `${cpAddr}`, 'orange');
                });
            } else {
                addParagraph(doc, 'No se encontraron contrapartes en la lista negra local.');
            }
            doc.moveDown(0.5);

            if (chainalysisSanctionedCounterparties && chainalysisSanctionedCounterparties.length > 0) {
                addSubTitle(doc, 'Contrapartes Sancionadas por Chainalysis:');
                chainalysisSanctionedCounterparties.forEach(cp => { // cp es { address, levelFound, sanctions }
                    addListItem(doc, `${cp.address} (detectada en Nivel ${cp.levelFound || 'N/A'})`, 'red');
                    doc.font('Light').fontSize(9).fillColor('darkred');
                    cp.sanctions.forEach(sanction => {
                        doc.text(`     ↳ Identificación: ${sanction.name} (Categoría: ${sanction.category || 'N/A'})`, { indent: 20 });
                    });
                    doc.fillColor('black').moveDown(0.2);
                });
            } else {
                addParagraph(doc, 'No se encontraron contrapartes sancionadas por Chainalysis.');
            }
        } else if (!errorInfo && stats && stats.length > 0) { // Si hubo análisis de contrapartes pero no se encontraron riesgosas
            addSectionTitle(doc, '4. Hallazgos de Riesgo en Contrapartes');
            addParagraph(doc, 'No se identificaron contrapartes riesgosas (ni en lista negra local ni sancionadas por Chainalysis) en los niveles analizados.', { color: 'green' });
        }
        doc.moveDown();

        addSectionTitle(doc, '5. Conclusión y Descargo de Responsabilidad');
        if (verdictExplanation) {
            addParagraph(doc, `Basado en el análisis, ${verdictExplanation.toLowerCase()}`);
        }
        addParagraph(doc, 'Este reporte es generado automáticamente y se basa en la información disponible al momento del análisis, incluyendo listas negras locales y datos de la API de Chainalysis. No constituye asesoramiento financiero ni legal. Siempre realice su propia diligencia debida (DYOR) antes de tomar cualquier decisión.');
        doc.moveDown();

        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc.fontSize(8).font('Light').text(`Página ${i + 1} de ${pageCount} | Reporte para ${rootAddress}`, 50, doc.page.height - 30, {
                align: 'center',
                lineBreak: false
            });
        }

        doc.end();

        stream.on('finish', () => {
            console.log(`[REPORTE PDF] PDF generado y stream finalizado: ${path}`);
            resolve();
        });
        stream.on('error', (err) => {
            console.error(`[REPORTE PDF ERROR] Error escribiendo PDF a stream para ${path}:`, err);
            reject(err);
        });
    });
}


async function evaluateAndReport(addr) {
    const startTime = Date.now();
    console.log(`\n=== INICIO DE ANÁLISIS === ${new Date().toLocaleString()} PARA ${addr}`);
    const reportFileName = `./report_${addr}_${Date.now()}.pdf`;

    // Objeto para acumular datos para el PDF
    let pdfAnalysisData = {
        verdict: 'Análisis en progreso...',
        verdictExplanation: '',
        rootIsLocallyBlacklisted: false,
        rootChainalysisSanctions: null,
        stats: [],
        locallyBlacklistedCounterparties: [],
        chainalysisSanctionedCounterparties: [], // Array de { address, levelFound, sanctions }
        errorInfo: null
    };

    // Variables para el objeto de retorno simplificado
    let finalVerdict = 'Error Desconocido';
    let scannedCounterpartiesCount = 0;
    let badNeighborAddresses = new Set();


    try {
        console.log(`[VERIFICACIÓN RAÍZ] Dirección: ${addr}`);
        pdfAnalysisData.rootIsLocallyBlacklisted = await isBlacklisted(addr);
        pdfAnalysisData.rootChainalysisSanctions = await getChainalysisSanctionInfo(addr); // Retorna array de sanciones o {error}

        if (pdfAnalysisData.rootIsLocallyBlacklisted) {
            badNeighborAddresses.add(addr);
        }
        if (pdfAnalysisData.rootChainalysisSanctions && pdfAnalysisData.rootChainalysisSanctions.length > 0 && !pdfAnalysisData.rootChainalysisSanctions.error) {
            badNeighborAddresses.add(addr);
            pdfAnalysisData.verdict = 'DIRECCIÓN RAÍZ SANCIONADA (Chainalysis)';
            pdfAnalysisData.verdictExplanation = `La dirección analizada (${addr}) está directamente sancionada según Chainalysis. Se desaconseja cualquier interacción.`;
            finalVerdict = pdfAnalysisData.verdict;
            await generatePDF(reportFileName, addr, pdfAnalysisData);
            return { verdict: finalVerdict, scanned: 0, badNeighbors: [addr], report: reportFileName };
        }
        if (pdfAnalysisData.rootChainalysisSanctions && pdfAnalysisData.rootChainalysisSanctions.error) {
            console.warn(`[WARN] Error al verificar la dirección raíz ${addr} con Chainalysis: ${pdfAnalysisData.rootChainalysisSanctions.error}`);
            // No se considera un error fatal para el análisis, pero se reportará en el PDF.
        }


        console.log(`[BÚSQUEDA PROFUNDA] Iniciando análisis de contrapartes para ${addr} en ${MAX_LEVEL} niveles...`);
        // getCounterparties ahora devuelve { addresses: string[], stats: any[] }
        // addresses son las contrapartes en minúscula
        const { addresses: counterpartyAddressesLower, stats: discoveryStats } = await getCounterparties(addr);
        pdfAnalysisData.stats = discoveryStats;
        scannedCounterpartiesCount = counterpartyAddressesLower.length;

        console.log(`[VERIFICACIÓN CONTRAPARTES] Comprobando ${scannedCounterpartiesCount} contrapartes...`);

        const cpChecksPromises = counterpartyAddressesLower.map(cpAddrLower =>
            limitInternalConcurrency(async () => { // Limita la concurrencia de estas operaciones internas
                const isCpLocal = await isBlacklisted(cpAddrLower);
                const cpChainalysisInfo = await getChainalysisSanctionInfo(cpAddrLower); // cpAddrLower ya está en minúscula

                if (isCpLocal) {
                    pdfAnalysisData.locallyBlacklistedCounterparties.push(cpAddrLower);
                    badNeighborAddresses.add(cpAddrLower);
                }
                if (cpChainalysisInfo && cpChainalysisInfo.length > 0 && !cpChainalysisInfo.error) {
                    // Necesitamos encontrar el nivel y el casing original si es posible, pero getCounterparties ya no lo da directamente.
                    // Para simplificar y mantener la lógica antigua, solo guardamos la dirección y la sanción.
                    // El PDF mostrará la dirección (minúscula) y sus sanciones.
                    const cpDataForPdf = {
                        address: cpAddrLower, // Usamos la dirección en minúscula que tenemos
                        levelFound: 'N/A', // No tenemos el nivel aquí con la estructura de `getCounterparties` revertida
                        sanctions: cpChainalysisInfo
                    };
                    // Para ser más precisos, necesitaríamos que getCounterparties devuelva un mapa con más info.
                    // Dado el requisito de revertir getCounterparties, aceptamos esta limitación.
                    // O, podríamos modificar getCounterparties para devolver { addressOriginal: string, addressLower: string, level: number }
                    // Por ahora, nos atenemos a la estructura simple de `addresses` de `getCounterparties`.
                    pdfAnalysisData.chainalysisSanctionedCounterparties.push(cpDataForPdf);
                    badNeighborAddresses.add(cpAddrLower);
                }
                if (cpChainalysisInfo && cpChainalysisInfo.error) {
                     console.warn(`[WARN] Problema al verificar ${cpAddrLower} con Chainalysis: ${cpChainalysisInfo.error}`);
                }
            })
        );
        await Promise.all(cpChecksPromises);

        // Determinar veredicto final para el PDF y el retorno simplificado
        const hasSanctionedCounterparty = pdfAnalysisData.chainalysisSanctionedCounterparties.length > 0;
        const hasLocalBlacklistCounterparty = pdfAnalysisData.locallyBlacklistedCounterparties.length > 0;

        if (pdfAnalysisData.rootIsLocallyBlacklisted && ! (pdfAnalysisData.rootChainalysisSanctions && pdfAnalysisData.rootChainalysisSanctions.length > 0 && !pdfAnalysisData.rootChainalysisSanctions.error) ) { // Si la raíz está en lista local pero NO sancionada por Chainalysis
            if (hasSanctionedCounterparty) {
                pdfAnalysisData.verdict = 'ALTO RIESGO: Raíz en Lista Local Y Vínculo con Dirección Sancionada';
                pdfAnalysisData.verdictExplanation = `La dirección analizada (${addr}) está en la lista negra local Y tiene interacciones con direcciones sancionadas por Chainalysis.`;
            } else {
                pdfAnalysisData.verdict = 'RIESGO MODERADO: Dirección Raíz en Lista Local';
                pdfAnalysisData.verdictExplanation = `La dirección analizada (${addr}) está en la lista negra local. No se encontraron vínculos con direcciones sancionadas por Chainalysis.`;
            }
        } else if (hasSanctionedCounterparty) { // Raíz no sancionada por Chainalysis, ni en lista local (o ya manejado si lo estaba)
            pdfAnalysisData.verdict = 'ALTO RIESGO: Vínculo con Dirección Sancionada (Chainalysis)';
            pdfAnalysisData.verdictExplanation = `La billetera ${addr} tiene interacciones con una o más direcciones sancionadas por Chainalysis.`;
        } else if (hasLocalBlacklistCounterparty) {
            pdfAnalysisData.verdict = 'RIESGO MODERADO: Vínculo con Dirección en Lista Local';
            pdfAnalysisData.verdictExplanation = `La billetera ${addr} tiene interacciones con una o más direcciones de la lista negra local.`;
        } else {
            pdfAnalysisData.verdict = 'SEGURA (Según Criterios Actuales)';
            pdfAnalysisData.verdictExplanation = `La billetera ${addr} y sus contrapartes analizadas (hasta ${MAX_LEVEL} niveles) no fueron encontradas en la lista negra local ni muestran sanciones por Chainalysis.`;
        }
        finalVerdict = pdfAnalysisData.verdict;


        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n=== RESULTADO DEL ANÁLISIS PARA ${addr} ===`);
        console.log(`  Tiempo total del análisis: ${elapsedTime}s`);
        console.log(`  Veredicto final: ${finalVerdict}`);
        if(pdfAnalysisData.rootIsLocallyBlacklisted) console.log(`  RAÍZ EN LISTA NEGRA LOCAL: SÍ`);
        if(pdfAnalysisData.rootChainalysisSanctions && pdfAnalysisData.rootChainalysisSanctions.length > 0 && !pdfAnalysisData.rootChainalysisSanctions.error) console.log(`  RAÍZ SANCIONADA POR CHAINALYSIS: SÍ`);
        console.log(`  Contrapartes riesgosas encontradas (direcciones únicas): ${badNeighborAddresses.size}`);
        if (badNeighborAddresses.size > 0) {
            console.log("  Direcciones de contrapartes con hallazgos:");
            badNeighborAddresses.forEach(bAddr => {
                if (bAddr !== addr) console.log(`    - ${bAddr}`);
            });
        }

        await generatePDF(reportFileName, addr, pdfAnalysisData);
        return {
            verdict: finalVerdict,
            scanned: scannedCounterpartiesCount,
            badNeighbors: [...badNeighborAddresses].filter(b => b !== addr), // Excluir la raíz si está en badNeighbors, ya que se reporta por separado
            report: reportFileName
        };

    } catch (err) {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[ERROR CRÍTICO en evaluateAndReport para ${addr} tras ${elapsedTime}s]: ${err.message}`, err.stack);
        
        pdfAnalysisData.verdict = 'ERROR EN ANÁLISIS';
        pdfAnalysisData.verdictExplanation = `Ocurrió un error crítico durante el proceso de análisis: ${err.message.substring(0,150)}. El reporte puede estar incompleto o ser incorrecto.`;
        pdfAnalysisData.errorInfo = err.message;
        finalVerdict = pdfAnalysisData.verdict;
        
        try {
            await generatePDF(reportFileName, addr, pdfAnalysisData);
        } catch (pdfErr) {
            console.error(`[ERROR CRÍTICO] No se pudo generar PDF de error para ${addr}: ${pdfErr.message}`);
            return { verdict: 'ERROR (Sin Reporte)', scanned: 0, badNeighbors: [], report: null };
        }
        return { verdict: finalVerdict, scanned: 0, badNeighbors: [], report: reportFileName };
    }
}

module.exports = { isBlacklisted, getCounterparties, evaluateAndReport };

// Ejemplo de uso (descomentar para probar directamente):
/*
(async () => {
    const testAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Dirección de ejemplo (USDT)
    // const testAddress = 'TJsStA5A3DzsmqSQ3s2jS5v2R32N9W25SP'; // Otra dirección para probar
    // const testAddressSanctioned = 'TKSyorMR1x3MjyinYp3X2GBr16TCb65sLp'; // Dirección OFAC sancionada real (Lazarus Group)

    console.log("Ejecutando prueba de análisis para dirección de ejemplo...");
    const result1 = await evaluateAndReport(testAddress);
    console.log("\nResultado final de la prueba 1:", result1.verdict);
    if (result1.report) {
        console.log("Reporte PDF (prueba 1) generado en:", result1.report);
        console.log("Contrapartes riesgosas (prueba 1):", result1.badNeighbors);

    }

    // console.log("\nEjecutando prueba de análisis para dirección SANCIONADA...");
    // const result2 = await evaluateAndReport(testAddressSanctioned);
    // console.log("\nResultado final de la prueba 2 (sancionada):", result2.verdict);
    // if (result2.report) {
    //     console.log("Reporte PDF (prueba 2) generado en:", result2.report);
    //     console.log("Contrapartes riesgosas (prueba 2):", result2.badNeighbors);
    // }
})();
*/
